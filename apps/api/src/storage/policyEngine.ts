import type {
    BucketPermission,
    BucketPolicy,
    JWTPayload,
    StorageAction,
    StorageObjectPolicy,
    StorageObjectRecord,
    StorageRule,
} from '@openbase/core'

interface StoragePolicyContext {
    auth: {
        userId: string | null
        role: string
        projectId: string | null
        authenticated: boolean
    }
    bucket: {
        name: string
        public: boolean
    }
    object?: {
        path: string
        ownerId: string | null
        mimeType: string
        size: number
        metadata: StorageObjectRecord['metadata']
    }
}

export function isStorageAccessAllowed(
    bucketName: string,
    action: StorageAction,
    bucketPolicy: BucketPolicy,
    user: JWTPayload | undefined,
    objectRecord?: StorageObjectRecord
): boolean {
    const context: StoragePolicyContext = {
        auth: {
            userId: user?.sub || null,
            role: normalizeRole(user),
            projectId: user?.projectId || null,
            authenticated: Boolean(user?.sub || user?.role === 'service_role' || user?.role === 'platform_user'),
        },
        bucket: {
            name: bucketName,
            public: bucketPolicy.public === true,
        },
        ...(objectRecord
            ? {
                object: {
                    path: objectRecord.path,
                    ownerId: objectRecord.uploadedBy,
                    mimeType: objectRecord.mimeType,
                    size: objectRecord.size,
                    metadata: objectRecord.metadata,
                },
            }
            : {}),
    }

    const objectDecision = evaluateRules(objectRecord?.policy?.rules, action, context)
    if (objectDecision !== undefined) {
        return objectDecision
    }

    const legacyObjectDecision = evaluateLegacyPolicy(objectRecord?.policy ?? undefined, action, user)
    if (legacyObjectDecision !== undefined) {
        return legacyObjectDecision
    }

    const bucketDecision = evaluateRules(bucketPolicy.rules, action, context)
    if (bucketDecision !== undefined) {
        return bucketDecision
    }

    const legacyBucketDecision = evaluateLegacyPolicy(bucketPolicy, action, user)
    if (legacyBucketDecision !== undefined) {
        return legacyBucketDecision
    }

    return false
}

function evaluateRules(
    rules: StorageRule[] | undefined,
    action: StorageAction,
    context: StoragePolicyContext
): boolean | undefined {
    if (!rules || rules.length === 0) {
        return undefined
    }

    let allowed: boolean | undefined

    for (const rule of rules) {
        if (!rule.actions.includes(action)) {
            continue
        }

        if (!evaluateExpression(rule.expression, context)) {
            continue
        }

        if (rule.effect === 'deny') {
            return false
        }

        allowed = true
    }

    return allowed
}

function evaluateLegacyPolicy(
    policy: BucketPolicy | StorageObjectPolicy | undefined,
    action: StorageAction,
    user: JWTPayload | undefined
): boolean | undefined {
    if (!policy) {
        return undefined
    }

    const permission = getPermission(policy, action)
    if (action === 'read' && (permission.public === true || policy.public === true)) {
        return true
    }

    if (!user) {
        return false
    }

    if (user.role === 'service_role') {
        return true
    }

    if (permission.userIds?.includes(user.sub || '')) {
        return true
    }

    return permission.roles?.includes(normalizeRole(user)) === true
}

function getPermission(policy: BucketPolicy | StorageObjectPolicy, action: StorageAction): BucketPermission {
    const permission = policy[action]
    if (permission) {
        return permission
    }

    if (action === 'read' && policy.public) {
        return { public: true, roles: ['anon', 'authenticated', 'service_role', 'platform_user'] }
    }

    return { roles: ['authenticated', 'service_role', 'platform_user'] }
}

function normalizeRole(user: JWTPayload | undefined): string {
    if (!user) {
        return 'anon'
    }

    if (user.role === 'service_role' || user.role === 'platform_user') {
        return user.role
    }

    return 'authenticated'
}

function evaluateExpression(expression: string, context: StoragePolicyContext): boolean {
    const tokens = tokenize(expression)
    let index = 0

    const parseExpression = (): boolean => parseOr()

    const parseOr = (): boolean => {
        let value = parseAnd()
        while (tokens[index] === '||') {
            index += 1
            value = value || parseAnd()
        }
        return value
    }

    const parseAnd = (): boolean => {
        let value = parseComparison()
        while (tokens[index] === '&&') {
            index += 1
            value = value && parseComparison()
        }
        return value
    }

    const parseComparison = (): boolean => {
        if (tokens[index] === '(') {
            index += 1
            const value = parseExpression()
            expect(tokens[index], ')')
            index += 1
            return value
        }

        const left = readValue(tokens[index], context)
        index += 1
        const operator = tokens[index]

        if (operator !== '==' && operator !== '!=') {
            return Boolean(left)
        }

        index += 1
        const right = readValue(tokens[index], context)
        index += 1

        return operator === '==' ? left === right : left !== right
    }

    const result = parseExpression()
    return result
}

function tokenize(expression: string): string[] {
    const tokens: string[] = []
    let cursor = 0

    while (cursor < expression.length) {
        const char = expression[cursor]

        if (/\s/.test(char)) {
            cursor += 1
            continue
        }

        const pair = expression.slice(cursor, cursor + 2)
        if (pair === '&&' || pair === '||' || pair === '==' || pair === '!=') {
            tokens.push(pair)
            cursor += 2
            continue
        }

        if (char === '(' || char === ')') {
            tokens.push(char)
            cursor += 1
            continue
        }

        if (char === '"' || char === '\'') {
            const quote = char
            cursor += 1
            let value = ''
            while (cursor < expression.length && expression[cursor] !== quote) {
                value += expression[cursor]
                cursor += 1
            }
            cursor += 1
            tokens.push(`"${value}"`)
            continue
        }

        let value = ''
        while (cursor < expression.length && /[A-Za-z0-9_.-]/.test(expression[cursor])) {
            value += expression[cursor]
            cursor += 1
        }
        if (value) {
            tokens.push(value)
            continue
        }

        throw new Error(`Unsupported token "${char}" in storage rule expression`)
    }

    return tokens.filter(Boolean)
}

function readValue(token: string | undefined, context: StoragePolicyContext): unknown {
    if (!token) {
        return undefined
    }

    if (token.startsWith('"') && token.endsWith('"')) {
        return token.slice(1, -1)
    }

    if (token === 'true') return true
    if (token === 'false') return false
    if (token === 'null') return null
    if (/^-?\d+(\.\d+)?$/.test(token)) {
        return Number(token)
    }

    return token.split('.').reduce<unknown>((current, segment) => {
        if (current && typeof current === 'object' && segment in current) {
            return (current as Record<string, unknown>)[segment]
        }
        return undefined
    }, context as unknown as Record<string, unknown>)
}

function expect(actual: string | undefined, expected: string): void {
    if (actual !== expected) {
        throw new Error(`Expected "${expected}" in storage rule expression`)
    }
}
