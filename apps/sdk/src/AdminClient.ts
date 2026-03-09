import {
    authUserSchema,
    migrationDefinitionSchema,
    migrationHistoryEntrySchema,
    projectInvitationSchema,
    projectMemberSchema,
    projectRoleDefinitionSchema,
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

const memberWithRoleSchema = projectMemberSchema.extend({
    role: projectRoleDefinitionSchema,
    owner: z.boolean().optional(),
})

const invitationWithUrlSchema = projectInvitationSchema.extend({
    inviteUrl: z.string().url(),
    delivery: z.enum(['email', 'manual']),
})

const updateUserSchema = authUserSchema

const messageSchema = z.object({
    message: z.string(),
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
        auth: {
            listUsers: async () => this.request('GET', '/auth/users', z.array(authUserSchema)),
            createUser: async (payload: { email: string; password: string; metadata?: Record<string, unknown> }) => this.request(
                'POST',
                '/auth/users',
                authUserSchema,
                z.object({
                    email: z.string().email(),
                    password: z.string().min(8),
                    metadata: z.record(z.unknown()).optional(),
                }).parse(payload)
            ),
            confirmUser: async (userId: string) => this.request('POST', `/auth/users/${userId}/confirm`, updateUserSchema),
            toggleUserDisabled: async (userId: string, payload: { disabled: boolean; reason?: string }) => this.request(
                'PATCH',
                `/auth/users/${userId}`,
                updateUserSchema,
                z.object({
                    disabled: z.boolean(),
                    reason: z.string().optional(),
                }).parse(payload)
            ),
            revokeSessions: async (userId: string) => this.request('POST', `/auth/users/${userId}/revoke-sessions`, messageSchema),
            sendPasswordReset: async (userId: string) => this.request('POST', `/auth/users/${userId}/password-reset`, messageSchema),
            disableTotp: async (userId: string) => this.request('POST', `/auth/users/${userId}/mfa/totp/disable`, authUserSchema),
            deleteUser: async (userId: string) => this.request('DELETE', `/auth/users/${userId}`, messageSchema),
        },
        access: {
            listRoles: async () => this.requestProjectControl('GET', '/access/roles', z.array(projectRoleDefinitionSchema)),
            saveRole: async (payload: z.infer<typeof projectRoleDefinitionSchema>) => this.requestProjectControl(
                'POST',
                '/access/roles',
                projectRoleDefinitionSchema,
                projectRoleDefinitionSchema.parse(payload)
            ),
            deleteRole: async (roleKey: string) => this.requestProjectControl('DELETE', `/access/roles/${roleKey}`, messageSchema),
            listMembers: async () => this.requestProjectControl('GET', '/access/members', z.array(memberWithRoleSchema)),
            updateMemberRole: async (userId: string, roleKey: string) => this.requestProjectControl(
                'PATCH',
                `/access/members/${userId}`,
                projectMemberSchema,
                z.object({ roleKey: z.string().min(1) }).parse({ roleKey })
            ),
            removeMember: async (userId: string) => this.requestProjectControl('DELETE', `/access/members/${userId}`, messageSchema),
            listInvitations: async () => this.requestProjectControl('GET', '/access/invitations', z.array(projectInvitationSchema)),
            inviteMember: async (payload: { email: string; roleKey: string }) => this.requestProjectControl(
                'POST',
                '/access/invitations',
                invitationWithUrlSchema,
                z.object({
                    email: z.string().email(),
                    roleKey: z.string().min(1),
                }).parse(payload)
            ),
            revokeInvitation: async (invitationId: string) => this.requestProjectControl(
                'DELETE',
                `/access/invitations/${invitationId}`,
                projectInvitationSchema
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

    from<TRow = Record<string, unknown>, TInsert = Partial<TRow>, TUpdate = Partial<TRow>>(table: string): QueryBuilder<TRow, TInsert, TUpdate> {
        return new QueryBuilder<TRow, TInsert, TUpdate>(
            table,
            this.projectUrl,
            this.apiKey,
            this.projectId,
            () => this.auth.getAccessToken()
        )
    }

    channel(name: string): RealtimeChannel {
        return this.realtime.channel(name)
    }

    private async request<TSchema extends z.ZodTypeAny>(
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

    private async requestProjectControl<TSchema extends z.ZodTypeAny>(
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
        path: string,
        schema: TSchema,
        body?: unknown
    ): Promise<{ data: z.infer<TSchema> | null; error: { message: string } | null }> {
        try {
            const fetchFn = typeof globalThis.fetch !== 'undefined' ? globalThis.fetch : (await import('cross-fetch')).default
            const response = await fetchFn(`${this.projectUrl}/api/v1/projects/${this.projectId}${path}`, {
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
