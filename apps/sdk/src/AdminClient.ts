import {
    migrationDefinitionSchema,
    migrationHistoryEntrySchema,
    schemaExportSchema,
} from '@openbase/core'
import { z } from 'zod'
import { AuthClient } from './AuthClient.js'
import { parseApiEnvelope } from './http.js'
import { QueryBuilder } from './QueryBuilder.js'
import { RealtimeClient, RealtimeChannel } from './RealtimeClient.js'
import { StorageClient } from './StorageClient.js'

const migrationListSchema = z.object({
    migrations: z.array(migrationHistoryEntrySchema),
    appliedMigrations: z.array(z.string()),
})

const migrationMutationSchema = migrationDefinitionSchema.extend({
    checksum: z.string().optional(),
    source: z.enum(['cli', 'dashboard', 'sdk']).optional(),
})

export class OpenBaseAdminClient {
    readonly auth: AuthClient
    readonly storage: StorageClient
    readonly realtime: RealtimeClient
    protected readonly projectUrl: string
    protected readonly apiKey: string
    protected readonly projectId: string

    readonly admin = {
        schema: {
            export: async () => this.request('GET', '/schema/export', schemaExportSchema),
        },
        migrations: {
            list: async () => this.request('GET', '/migrations', migrationListSchema),
            apply: async (migration: z.infer<typeof migrationMutationSchema>) => this.request(
                'POST',
                '/migrations/apply',
                schemaExportSchema,
                migrationMutationSchema.parse({
                    ...migration,
                    source: migration.source ?? 'sdk',
                    checksum: migration.checksum ?? migration.name,
                })
            ),
            rollback: async (migration: z.infer<typeof migrationMutationSchema>) => this.request(
                'POST',
                '/migrations/rollback',
                schemaExportSchema,
                migrationMutationSchema.parse({
                    ...migration,
                    source: migration.source ?? 'sdk',
                    checksum: migration.checksum ?? migration.name,
                })
            ),
        },
    }

    constructor(projectUrl: string, serviceRoleKey: string) {
        this.projectUrl = projectUrl.replace(/\/$/, '')
        this.apiKey = serviceRoleKey
        this.projectId = this.extractProjectId(serviceRoleKey)
        this.auth = new AuthClient(this.projectUrl, this.projectId, this.apiKey)
        this.storage = new StorageClient(
            this.projectUrl,
            this.projectId,
            this.apiKey,
            () => this.auth.getAccessToken()
        )
        this.realtime = new RealtimeClient(
            this.projectUrl,
            this.projectId,
            () => this.auth.getAccessToken(),
            () => this.apiKey
        )
    }

    from<T = Record<string, unknown>>(table: string): QueryBuilder<T> {
        return new QueryBuilder<T>(table, this.projectUrl, this.apiKey, this.projectId, () => this.auth.getAccessToken())
    }

    channel(name: string): RealtimeChannel {
        return this.realtime.channel(name)
    }

    private async request<TSchema extends z.ZodTypeAny>(
        method: 'GET' | 'POST',
        path: string,
        schema: TSchema,
        body?: unknown
    ): Promise<{ data: z.infer<TSchema> | null; error: { message: string } | null }> {
        try {
            const fetchFn = typeof globalThis.fetch !== 'undefined' ? globalThis.fetch : (await import('cross-fetch')).default
            const response = await fetchFn(`${this.projectUrl}/api/v1/${this.projectId}${path}`, {
                method,
                headers: {
                    apikey: this.apiKey,
                    Authorization: `Bearer ${this.apiKey}`,
                    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
            })

            const result = await parseApiEnvelope(response, schema)
            return {
                data: result.data,
                error: result.error ? { message: result.error.message } : null,
            }
        } catch (error) {
            return {
                data: null,
                error: { message: (error as Error).message },
            }
        }
    }

    private extractProjectId(token: string): string {
        try {
            const parts = token.split('.')
            if (parts.length !== 3) return ''

            const payloadPart = parts[1]
                .replace(/-/g, '+')
                .replace(/_/g, '/')
                .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')

            const payload = JSON.parse(
                typeof atob !== 'undefined'
                    ? atob(payloadPart)
                    : Buffer.from(payloadPart, 'base64').toString('utf8')
            ) as { projectId?: string }

            return payload.projectId || ''
        } catch {
            return ''
        }
    }
}
