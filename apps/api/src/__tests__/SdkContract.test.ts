import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestAppContext } from './helpers/testApp.js'
import { createTestApp } from './helpers/testApp.js'

describe('SDK contract coverage', () => {
    let context: TestAppContext

    beforeEach(async () => {
        context = await createTestApp({ listen: true })
    })

    afterEach(async () => {
        await context.close()
    })

    it('matches documented auth, query, storage, and realtime flows', async () => {
        const sdkModuleUrl = new URL('../../../sdk/src/index.ts', import.meta.url)
        const sdkModule = await import(sdkModuleUrl.toString()) as {
            createClient: (projectUrl: string, anonKey: string) => any
        }

        const owner = await signUpPlatform(context, 'sdk-owner@example.com')
        const project = await createProject(context, owner.access_token, 'SDK Project')

        await createTable(context, project.id, project.serviceRoleKey, {
            tableName: 'posts',
            columns: [
                { name: 'id', type: 'uuid', required: true, unique: true },
                { name: 'title', type: 'text', required: true },
                { name: 'status', type: 'text' },
            ],
            indexes: ['id'],
        })

        const admin = sdkModule.createClient(context.baseUrl!, project.serviceRoleKey)
        const client = sdkModule.createClient(context.baseUrl!, project.anonKey)

        const signUpResult = await client.auth.signUp({
            email: 'sdk-user@example.com',
            password: 'password123',
        })
        expect(signUpResult.error).toBeNull()

        const signInResult = await client.auth.signIn({
            email: 'sdk-user@example.com',
            password: 'password123',
        })
        expect(signInResult.error).toBeNull()
        expect(signInResult.data?.user.email).toBe('sdk-user@example.com')

        const insertResult = await admin.from('posts').insert({ title: 'hello from sdk', status: 'draft' })
        expect(insertResult.error).toBeNull()

        const selectResult = await client.from('posts').select('*', { count: 'exact' })
        expect(selectResult.error).toBeNull()
        expect(selectResult.count).toBe(1)
        expect(selectResult.data?.[0]?.title).toBe('hello from sdk')

        const headCount = await client.from('posts').select('*', { count: 'exact', head: true })
        expect(headCount.error).toBeNull()
        expect(headCount.count).toBe(1)
        expect(headCount.data).toBeNull()

        const bucketResult = await admin.storage.createBucket('contracts', { public: false })
        expect(bucketResult.error).toBeNull()

        const uploadResult = await client.storage
            .from('contracts')
            .upload('reports/sdk-contract.txt', new Blob(['contract data'], { type: 'text/plain' }), {
                metadata: {
                    tags: { source: 'sdk' },
                    customMetadata: { contract: 'true' },
                },
            })
        expect(uploadResult.error).toBeNull()

        const listResult = await client.storage.from('contracts').list('reports/')
        expect(listResult.error).toBeNull()
        expect(listResult.data?.[0]?.path).toBe('reports/sdk-contract.txt')
        expect(listResult.data?.[0]?.metadata.tags?.source).toBe('sdk')

        const downloadResult = await client.storage.from('contracts').download('reports/sdk-contract.txt')
        expect(downloadResult.error).toBeNull()
        expect(await downloadResult.data?.text()).toBe('contract data')

        const infoResult = await client.storage.from('contracts').info('reports/sdk-contract.txt')
        expect(infoResult.error).toBeNull()
        expect(infoResult.data?.metadata.customMetadata?.contract).toBe('true')

        const transactionResult = await admin.transaction([
            {
                type: 'update',
                table: 'posts',
                patch: { status: 'live' },
                condition: {
                    filters: [{ column: 'title', operator: 'eq', value: 'hello from sdk' }],
                    expectedCount: 1,
                },
            },
            {
                type: 'insert',
                table: 'posts',
                values: [{ title: 'from transaction', status: 'live' }],
            },
        ])
        expect(transactionResult.error).toBeNull()
        expect(transactionResult.data?.operations).toHaveLength(2)

        const socketEvents: Array<{ table: string; title?: string }> = []
        const subscription = client
            .channel('posts-feed')
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'posts',
                filter: 'status=eq.live',
            }, (payload: { table: string; new?: { title?: unknown } }) => {
                socketEvents.push({
                    table: payload.table,
                    title: payload.new?.title as string | undefined,
                })
            })
            .subscribe()

        await new Promise(resolve => setTimeout(resolve, 100))
        await admin.from('posts').insert({ title: 'ignore me', status: 'draft' })
        await admin.from('posts').insert({ title: 'realtime from sdk', status: 'live' })
        await waitForCondition(() => socketEvents.length > 0)

        expect(socketEvents[0]).toEqual({
            table: 'posts',
            title: 'realtime from sdk',
        })

        subscription.unsubscribe()
        client.realtime.disconnect()
    })
})

async function signUpPlatform(context: TestAppContext, email: string) {
    const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/platform/auth/signup',
        payload: { email, password: 'password123' },
    })

    return readJson(response).data.session as { access_token: string; refresh_token: string }
}

async function createProject(context: TestAppContext, accessToken: string, name: string) {
    const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { Authorization: `Bearer ${accessToken}` },
        payload: { name, telegramSession: `session-${name}` },
    })

    return readJson(response).data as {
        id: string
        anonKey: string
        serviceRoleKey: string
    }
}

async function createTable(
    context: TestAppContext,
    projectId: string,
    serviceRoleKey: string,
    payload: Record<string, unknown>
) {
    await context.app.inject({
        method: 'POST',
        url: `/api/v1/${projectId}/tables`,
        headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
        },
        payload,
    })
}

function readJson(response: { body: string }) {
    return JSON.parse(response.body) as Record<string, any>
}

async function waitForCondition(check: () => boolean, timeoutMs: number = 2_000): Promise<void> {
    const started = Date.now()
    while (!check()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('Condition was not met before timeout')
        }
        await new Promise(resolve => setTimeout(resolve, 20))
    }
}
