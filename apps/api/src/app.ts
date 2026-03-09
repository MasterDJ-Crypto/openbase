import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import Redis from 'ioredis'
import { AuthService } from './auth/index.js'
import type { Config } from './config.js'
import { loadConfig } from './config.js'
import { IndexManager } from './database/index.js'
import { EncryptionService } from './encryption/index.js'
import { buildErrorEnvelope, validateOutputEnvelope } from './http/response.js'
import { RequestLogService } from './logs/index.js'
import { createRateLimiter } from './middleware/index.js'
import { MigrationService } from './migrations/index.js'
import { OperationsLogService } from './ops/index.js'
import { PlatformUserRepository } from './platform/index.js'
import { ProjectService } from './projects/index.js'
import { RealtimeService } from './realtime/RealtimeService.js'
import { TelegramRealtimeBridge } from './realtime/index.js'
import {
    registerAuthRoutes,
    registerDatabaseRoutes,
    registerMigrationRoutes,
    registerPlatformRoutes,
    registerProjectRoutes,
    registerStorageRoutes,
} from './routes/index.js'
import { StorageService } from './storage/index.js'
import { TelegramProviderFactory, TelegramSessionPool } from './telegram/index.js'
import { WarmupService } from './warmup/index.js'
import { WebhookService } from './webhooks/index.js'

declare module 'fastify' {
    interface FastifyRequest {
        startedAt?: number
    }
}

export interface AppBuildOptions {
    config?: Config
    redis?: Redis
    webhookInlineProcessing?: boolean
    warmupQueuesEnabled?: boolean
}

export interface AppContext {
    app: ReturnType<typeof Fastify>
    config: Config
    redis: Redis
    projectService: ProjectService
    requestLogService: RequestLogService
    operationsLogService: OperationsLogService
    webhookService: WebhookService
    sessionPool: TelegramSessionPool
    realtimeBridge: TelegramRealtimeBridge
    warmupService: WarmupService
    close: () => Promise<void>
}

export async function createApp(options: AppBuildOptions = {}): Promise<AppContext> {
    const config = options.config ?? loadConfig()
    const allowedOrigins = buildAllowedOrigins(config.DASHBOARD_URL, config.API_PUBLIC_URL)

    const app = Fastify({
        logger: {
            level: config.NODE_ENV === 'production' ? 'info' : 'debug',
            transport: config.NODE_ENV === 'development'
                ? { target: 'pino-pretty', options: { colorize: true } }
                : undefined,
        },
    })

    await app.register(cors, {
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.has(origin)) {
                callback(null, true)
                return
            }

            callback(null, false)
        },
        credentials: true,
    })

    await app.register(helmet, { crossOriginResourcePolicy: false })
    await app.register(multipart)

    const redis = options.redis ?? new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: null,
        lazyConnect: true,
        tls: config.REDIS_URL.startsWith('rediss://') ? {} : undefined,
    })

    redis.on('error', err => {
        app.log.error({ err }, 'Redis connection error')
    })

    if (redis.status === 'wait') {
        await redis.connect()
    }
    app.log.info('Redis connected')

    const rateLimiter = createRateLimiter(redis, {
        windowMs: 60_000,
        maxRequests: 100,
    })

    app.addHook('onRequest', async request => {
        request.startedAt = Date.now()
    })

    app.addHook('preHandler', rateLimiter)
    app.addHook('preSerialization', async (_request, _reply, payload) => {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Buffer.isBuffer(payload)) {
            return payload
        }

        const data = payload as Record<string, unknown>
        if (!('data' in data) && !('error' in data)) {
            return payload
        }

        return validateOutputEnvelope({
            data: 'data' in data ? data.data ?? null : null,
            error: 'error' in data ? data.error ?? null : null,
            ...('meta' in data ? { meta: data.meta } : {}),
        })
    })

    const encryptionService = new EncryptionService()
    const masterKey = encryptionService.keyFromHex(config.MASTER_ENCRYPTION_KEY)
    const providerFactory = new TelegramProviderFactory(
        config.TELEGRAM_API_ID,
        config.TELEGRAM_API_HASH,
        config.MOCK_TELEGRAM
    )

    const operationsLogService = new OperationsLogService(redis)
    const sessionPool = new TelegramSessionPool(providerFactory, {
        operationsLogService,
    })
    const warmupService = new WarmupService(
        sessionPool,
        redis,
        encryptionService,
        masterKey,
        {
            enableQueue: options.warmupQueuesEnabled ?? config.NODE_ENV !== 'test',
        }
    )

    const projectService = new ProjectService(
        providerFactory,
        sessionPool,
        redis,
        encryptionService,
        warmupService,
        config.JWT_SECRET,
        masterKey,
        config.SQLITE_BASE_PATH,
        config.SKIP_WARMUP
    )

    for (const project of await projectService.getAllProjects()) {
        sessionPool.registerProject(project, projectService.decryptSession(project))
    }

    const authService = new AuthService(redis, config.JWT_SECRET, encryptionService, masterKey)
    const storageService = new StorageService(config.STORAGE_SECRET, config.API_PUBLIC_URL)
    const requestLogService = new RequestLogService(redis)
    const platformUserRepository = new PlatformUserRepository(`${config.SQLITE_BASE_PATH}/platform.db`)
    const webhookService = new WebhookService(redis, {
        inlineProcessing: options.webhookInlineProcessing ?? config.NODE_ENV === 'test',
        operationsLogService,
    })

    const indexManagers = new Map<string, IndexManager>()
    function getIndexManager(projectId: string): IndexManager {
        let manager = indexManagers.get(projectId)
        if (!manager) {
            manager = new IndexManager(projectId, config.SQLITE_BASE_PATH)
            indexManagers.set(projectId, manager)
        }
        return manager
    }
    const migrationService = new MigrationService(projectService, {
        getIndexManager,
        encryptionService,
        masterKey,
    })

    app.setErrorHandler((error, _request, reply) => {
        const statusCode = (error as { statusCode?: number }).statusCode || 500

        if (statusCode >= 500) {
            app.log.error({ err: error }, 'Internal server error')
        }

        if (error.name === 'ZodError') {
            return reply.status(400).send(buildErrorEnvelope({
                message: 'Validation error',
                code: 'VALIDATION_ERROR',
                details: (error as { issues?: unknown }).issues,
            }))
        }

        return reply.status(statusCode).send(buildErrorEnvelope({
            message: error.message || 'Internal server error',
            code: (error as { code?: string }).code || 'INTERNAL_ERROR',
        }))
    })

    const realtimeService = new RealtimeService(app.server, config.JWT_SECRET, projectService, {
        allowedOrigins,
    })

    app.addHook('onResponse', async request => {
        const projectId = typeof (request.params as { projectId?: string } | undefined)?.projectId === 'string'
            ? (request.params as { projectId: string }).projectId
            : null

        const startedAt = request.startedAt ?? Date.now()
        const timestamp = new Date().toISOString()
        const statusCode = request.raw.statusCode ?? 0
        if (projectId) {
            await requestLogService.record({
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                method: request.method,
                path: request.url,
                projectId,
                statusCode,
                durationMs: Math.max(0, Date.now() - startedAt),
                timestamp,
            }).catch(() => undefined)
        }

        await operationsLogService.record({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            projectId,
            scope: 'request',
            level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warning' : 'info',
            message: `${request.method} ${request.url}`,
            metadata: {
                statusCode,
                durationMs: Math.max(0, Date.now() - startedAt),
            },
            timestamp,
        }).catch(() => undefined)
    })

    const sendEmail = async (to: string, subject: string, html: string): Promise<void> => {
        if (!config.RESEND_API_KEY || !config.RESEND_FROM_EMAIL) {
            throw new Error('Magic link email delivery is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL.')
        }

        const { Resend } = await import('resend')
        const resend = new Resend(config.RESEND_API_KEY)
        await resend.emails.send({
            from: config.RESEND_FROM_EMAIL,
            to,
            subject,
            html,
        })
    }

    await warmupService.reconcileWarmups()
    const realtimeBridge = new TelegramRealtimeBridge(sessionPool, projectService, realtimeService)
    await realtimeBridge.start()

    registerDatabaseRoutes(app, projectService, getIndexManager, encryptionService, masterKey, realtimeService, webhookService)
    registerMigrationRoutes(app, projectService, migrationService)
    registerAuthRoutes(
        app,
        redis,
        authService,
        projectService,
        getIndexManager,
        sendEmail,
        config.DASHBOARD_URL,
        config.API_PUBLIC_URL,
        {
            google: {
                enabled: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
                clientId: config.GOOGLE_CLIENT_ID,
                clientSecret: config.GOOGLE_CLIENT_SECRET,
            },
            github: {
                enabled: Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
                clientId: config.GITHUB_CLIENT_ID,
                clientSecret: config.GITHUB_CLIENT_SECRET,
            },
        }
    )
    registerStorageRoutes(app, storageService, projectService)
    registerProjectRoutes(app, projectService, warmupService, requestLogService, webhookService, operationsLogService, sessionPool)
    registerPlatformRoutes(
        app,
        redis,
        config.JWT_SECRET,
        config.TELEGRAM_API_ID,
        config.TELEGRAM_API_HASH,
        { mockTelegram: config.MOCK_TELEGRAM, repository: platformUserRepository }
    )

    const close = async (): Promise<void> => {
        await app.close()
        await realtimeBridge.close()
        await warmupService.close()
        await webhookService.close()
        await sessionPool.close()
        await platformUserRepository.close()
        await redis.quit()
        await Promise.all([...indexManagers.values()].map(manager => manager.close()))
    }

    return {
        app,
        config,
        redis,
        projectService,
        requestLogService,
        operationsLogService,
        webhookService,
        sessionPool,
        realtimeBridge,
        warmupService,
        close,
    }
}

export function buildAllowedOrigins(...urls: string[]): Set<string> {
    return new Set(
        urls
            .map(value => new URL(value).origin)
            .filter(Boolean)
    )
}
