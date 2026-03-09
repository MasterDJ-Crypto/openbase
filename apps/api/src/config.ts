/**
 * @openbase/api — Environment configuration
 * Validated with Zod to fail fast on missing/invalid config
 */

import { z } from 'zod'

const envBoolean = z.enum(['true', 'false']).default('false').transform(value => value === 'true')
const optionalString = z.preprocess(
    value => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().optional()
)
const optionalEmail = z.preprocess(
    value => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().email().optional()
)
const optionalUrl = z.preprocess(
    value => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().url().optional()
)
const optionalNumber = z.preprocess(
    value => value === '' ? undefined : value,
    z.coerce.number().optional()
)

const envSchema = z.object({
    PORT: z.coerce.number().default(3001),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // JWT
    JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
    STORAGE_SECRET: z.string().min(16, 'STORAGE_SECRET must be at least 16 characters'),

    // Redis
    REDIS_URL: z
        .string()
        .url()
        .default('redis://localhost:6379')
        .superRefine((value, ctx) => {
            const url = new URL(value)
            if (url.protocol === 'memory:') {
                return
            }
            const isLocal = ['localhost', '127.0.0.1'].includes(url.hostname)

            if (!isLocal && url.protocol !== 'rediss:') {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Remote Redis deployments must use rediss:// for TLS',
                })
            }
        }),

    // Email
    RESEND_API_KEY: optionalString,
    RESEND_FROM_EMAIL: optionalEmail,

    // SQLite
    SQLITE_BASE_PATH: z.string().default('./data/indexes'),
    BACKUP_ROOT_PATH: z.string().default('./data/backups'),
    BACKUP_INTERVAL_MINUTES: z.coerce.number().int().nonnegative().default(720),
    BACKUP_RETENTION_COUNT: z.coerce.number().int().positive().default(10),

    // Telegram
    TELEGRAM_API_ID: optionalNumber,
    TELEGRAM_API_HASH: optionalString.refine(value => value === undefined || value.length > 0),
    MOCK_TELEGRAM: envBoolean,
    SKIP_WARMUP: envBoolean,

    // Dashboard
    DASHBOARD_URL: z.string().url().default('http://localhost:3000'),
    API_PUBLIC_URL: optionalUrl,

    // Encryption
    MASTER_ENCRYPTION_KEY: z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/, 'MASTER_ENCRYPTION_KEY must be a 64-character hex string'),

    // OAuth
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    GITHUB_CLIENT_ID: optionalString,
    GITHUB_CLIENT_SECRET: optionalString,
}).superRefine((value, ctx) => {
    if (!value.MOCK_TELEGRAM) {
        if (value.TELEGRAM_API_ID === undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['TELEGRAM_API_ID'],
                message: 'TELEGRAM_API_ID is required when MOCK_TELEGRAM=false',
            })
        }

        if (!value.TELEGRAM_API_HASH) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['TELEGRAM_API_HASH'],
                message: 'TELEGRAM_API_HASH is required when MOCK_TELEGRAM=false',
            })
        }
    }

    if (value.SKIP_WARMUP && value.NODE_ENV !== 'development') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['SKIP_WARMUP'],
            message: 'SKIP_WARMUP may only be enabled when NODE_ENV=development',
        })
    }

    if (!value.API_PUBLIC_URL && value.NODE_ENV === 'production') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['API_PUBLIC_URL'],
            message: 'API_PUBLIC_URL is required when NODE_ENV=production',
        })
    }

    if (value.RESEND_API_KEY && !value.RESEND_FROM_EMAIL) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['RESEND_FROM_EMAIL'],
            message: 'RESEND_FROM_EMAIL is required when RESEND_API_KEY is set',
        })
    }
}).transform(value => ({
    ...value,
    API_PUBLIC_URL: value.API_PUBLIC_URL ?? 'http://localhost:3001',
}))

export type Config = z.infer<typeof envSchema>

let _config: Config | null = null

/**
 * Parse and validate environment variables. Throws on invalid config.
 */
export function loadConfig(): Config {
    if (_config) return _config

    const result = envSchema.safeParse(process.env)

    if (!result.success) {
        const formatted = result.error.issues
            .map(issue => `  - ${issue.path.join('.')}: ${issue.message}`)
            .join('\n')
        throw new Error(`Invalid environment configuration:\n${formatted}`)
    }

    _config = result.data
    return _config
}

/**
 * Get the already-loaded config. Throws if loadConfig() hasn't been called.
 */
export function getConfig(): Config {
    if (!_config) {
        throw new Error('Config not loaded. Call loadConfig() first.')
    }
    return _config
}

export function resetConfig(): void {
    _config = null
}
