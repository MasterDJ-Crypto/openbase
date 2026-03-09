/**
 * ProjectService — Manages OpenBase projects and project-scoped Telegram access.
 */

import { randomUUID } from 'crypto'
import { existsSync, rmSync } from 'fs'
import jwt from 'jsonwebtoken'
import type Redis from 'ioredis'
import type { Project, TableSchema, TelegramChannelRef, TelegramMessage } from '@openbase/core'
import { ConflictError, ForbiddenError, NotFoundError, nowISO, sanitizeName } from '@openbase/core'
import type { StorageProvider } from '@openbase/telegram'
import { EncryptionService } from '../encryption/EncryptionService.js'
import { TelegramProviderFactory } from '../telegram/TelegramProviderFactory.js'
import { TelegramSessionPool } from '../telegram/TelegramSessionPool.js'
import { WarmupService } from '../warmup/WarmupService.js'

export class ProjectService {
    constructor(
        private readonly providerFactory: TelegramProviderFactory,
        private readonly sessionPool: TelegramSessionPool,
        private readonly redis: Redis,
        private readonly encryptionService: EncryptionService,
        private readonly warmupService: WarmupService,
        private readonly jwtSecret: string,
        private readonly masterKey: Buffer,
        private readonly sqliteBasePath: string,
        private readonly skipWarmup = false
    ) { }

    async createProject(
        ownerId: string,
        name: string,
        telegramSession: string
    ): Promise<Project> {
        const projectId = randomUUID()
        const now = nowISO()
        const encryptedSession = this.encryptionService.encryptToString(
            telegramSession,
            this.masterKey
        )

        let createdChannels: TelegramChannelRef[] = []

        try {
            const reservedChannels = await this.providerFactory.withSession(
                telegramSession,
                async provider => {
                    const projectSlug = sanitizeName(name) || 'project'
                    const schemaChannel = await provider.createChannel(`${projectSlug}__schema__`)
                    const usersChannel = await provider.createChannel(`${projectSlug}__users__`)
                    const storageIndexChannel = await provider.createChannel(`${projectSlug}__storage_index__`)
                    const commitLogChannel = await provider.createChannel(`${projectSlug}__commit_log__`)
                    createdChannels = [schemaChannel, usersChannel, storageIndexChannel, commitLogChannel]

                    await provider.sendMessage(
                        schemaChannel,
                        JSON.stringify({ __type: 'SCHEMA', tables: [], version: 1 })
                    )

                    return {
                        schemaChannel,
                        usersChannel,
                        storageIndexChannel,
                        commitLogChannel,
                    }
                }
            )

            const anonKey = this.issueProjectApiKey(projectId, 'anon')
            const serviceRoleKey = this.issueProjectApiKey(projectId, 'service_role')

            const project: Project = {
                id: projectId,
                name,
                ownerId,
                telegramSessionEncrypted: encryptedSession,
                channelMap: {},
                archivedTableChannels: {},
                buckets: {},
                bucketPolicies: {},
                storageIndexChannel: reservedChannels.storageIndexChannel,
                usersChannel: reservedChannels.usersChannel,
                schemaChannel: reservedChannels.schemaChannel,
                commitLogChannel: reservedChannels.commitLogChannel,
                status: this.skipWarmup ? 'active' : 'warming_up',
                warmupDaysRemaining: this.skipWarmup ? 0 : 7,
                anonKey,
                serviceRoleKey,
                createdAt: now,
            }

            await this.redis.set(`project:${projectId}`, JSON.stringify(project))
            await this.redis.sadd(`owner:${ownerId}:projects`, projectId)
            this.sessionPool.registerProject(project, telegramSession)

            if (!this.skipWarmup) {
                await this.warmupService.startWarmup(projectId, project.commitLogChannel)
            }

            return project
        } catch (error) {
            if (createdChannels.length > 0) {
                await this.providerFactory.withSession(telegramSession, async provider => {
                    for (const channel of createdChannels) {
                        await provider.deleteChannel(channel).catch(() => undefined)
                    }
                }).catch(() => undefined)
            }

            throw error
        }
    }

    async getProject(projectId: string): Promise<Project> {
        const data = await this.redis.get(`project:${projectId}`)
        if (!data) throw new NotFoundError('Project')
        return JSON.parse(data) as Project
    }

    async getProjectsByOwner(ownerId: string): Promise<Project[]> {
        const projectIds = await this.redis.smembers(`owner:${ownerId}:projects`)
        const projects: Project[] = []

        for (const projectId of projectIds) {
            const data = await this.redis.get(`project:${projectId}`)
            if (!data) continue
            projects.push(JSON.parse(data) as Project)
        }

        return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    }

    async getAllProjects(): Promise<Project[]> {
        const keys = (await this.redis.keys('project:*')).filter(key => /^project:[^:]+$/.test(key))
        const projects: Project[] = []
        for (const key of keys) {
            const data = await this.redis.get(key)
            if (!data) continue
            projects.push(JSON.parse(data) as Project)
        }
        return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    }

    async updateProject(projectId: string, updates: Partial<Project>): Promise<Project> {
        const project = await this.getProject(projectId)
        const updated: Project = { ...project, ...updates }
        await this.redis.set(`project:${projectId}`, JSON.stringify(updated))
        return updated
    }

    async assertOwner(projectId: string, ownerId: string): Promise<Project> {
        const project = await this.getProject(projectId)
        if (project.ownerId !== ownerId) {
            throw new ForbiddenError('You do not have access to this project')
        }
        return project
    }

    async addTable(projectId: string, tableName: string, schema: TableSchema): Promise<TelegramChannelRef> {
        return this.withProjectStorage(projectId, async (project, provider) => {
            if (project.channelMap[tableName]) {
                throw new ConflictError(`Table "${tableName}" already exists`)
            }

            const projectSlug = sanitizeName(project.name) || 'project'
            const tableSlug = sanitizeName(tableName) || 'table'
            const channel = await provider.createChannel(`${projectSlug}_${tableSlug}`)
            project.channelMap[tableName] = channel
            await this.redis.set(`project:${projectId}`, JSON.stringify(project))
            await this.saveSchema(project.schemaChannel, tableName, schema, provider)
            return channel
        })
    }

    async saveSchema(
        schemaChannel: TelegramChannelRef,
        tableName: string,
        schema: TableSchema,
        provider: StorageProvider
    ): Promise<void> {
        await provider.sendMessage(
            schemaChannel,
            JSON.stringify({ __type: 'TABLE_SCHEMA', tableName, schema })
        )
    }

    async markSchemaRemoved(
        schemaChannel: TelegramChannelRef,
        tableName: string,
        provider: StorageProvider
    ): Promise<void> {
        await provider.sendMessage(
            schemaChannel,
            JSON.stringify({ __type: 'TABLE_SCHEMA_REMOVED', tableName })
        )
    }

    async getSchemas(projectId: string): Promise<Record<string, TableSchema>> {
        return this.withProjectStorage(projectId, async (project, provider) => {
            const messages = await this.getAllMessages(provider, project.schemaChannel)
            const schemas: Record<string, TableSchema> = {}

            for (const message of [...messages].reverse()) {
                try {
                    const data = JSON.parse(message.text) as {
                        __type?: string
                        tableName?: string
                        schema?: TableSchema
                    }

                    if (data.__type === 'TABLE_SCHEMA' && data.tableName && data.schema) {
                        schemas[data.tableName] = data.schema
                    }

                    if (data.__type === 'TABLE_SCHEMA_REMOVED' && data.tableName) {
                        delete schemas[data.tableName]
                    }
                } catch {
                    // Ignore non-schema messages.
                }
            }

            return schemas
        })
    }

    async deleteProject(projectId: string): Promise<void> {
        const project = await this.getProject(projectId)
        const sessionString = this.decryptSession(project)

        await this.providerFactory.withSession(sessionString, async provider => {
            for (const channel of Object.values(project.channelMap)) {
                await provider.deleteChannel(channel).catch(() => undefined)
            }

            for (const channel of Object.values(project.archivedTableChannels || {})) {
                await provider.deleteChannel(channel).catch(() => undefined)
            }

            for (const channel of Object.values(project.buckets)) {
                await provider.deleteChannel(channel).catch(() => undefined)
            }

            for (const channel of [
                project.schemaChannel,
                project.usersChannel,
                project.storageIndexChannel,
                project.commitLogChannel,
            ]) {
                await provider.deleteChannel(channel).catch(() => undefined)
            }
        })

        await this.warmupService.cancelWarmup(projectId)

        const indexPath = `${this.sqliteBasePath}/${projectId}.sqlite`
        if (existsSync(indexPath)) {
            rmSync(indexPath, { force: true })
        }

        await Promise.all([
            this.redis.del(`project:${projectId}`),
            this.redis.srem(`owner:${project.ownerId}:projects`, projectId),
            this.redis.del(`logs:${projectId}`),
            this.redis.del(`project:${projectId}:webhooks`),
        ])
        await this.sessionPool.closeProject(projectId)

        await this.redis.del(
            `ratelimit:token:${project.anonKey.slice(0, 32)}`,
            `ratelimit:token:${project.serviceRoleKey.slice(0, 32)}`
        ).catch(() => undefined)
    }

    decryptSession(project: Project): string {
        return this.encryptionService.decryptFromString(
            project.telegramSessionEncrypted,
            this.masterKey
        )
    }

    async withProjectStorage<T>(
        projectId: string,
        fn: (project: Project, provider: StorageProvider) => Promise<T>
    ): Promise<T> {
        const project = await this.getProject(projectId)
        return this.withProjectStorageRecord(project, fn)
    }

    async withProjectStorageRecord<T>(
        project: Project,
        fn: (project: Project, provider: StorageProvider) => Promise<T>
    ): Promise<T> {
        const sessionString = this.decryptSession(project)
        this.sessionPool.registerProject(project, sessionString)
        return this.sessionPool.withProject(project, sessionString, provider => fn(project, provider))
    }

    private issueProjectApiKey(projectId: string, role: 'anon' | 'service_role'): string {
        return jwt.sign(
            { projectId, role, type: 'api_key' },
            this.jwtSecret,
            { expiresIn: '100y' }
        )
    }

    private async getAllMessages(
        provider: StorageProvider,
        channel: TelegramChannelRef
    ): Promise<TelegramMessage[]> {
        const messages: TelegramMessage[] = []
        let offsetId: number | undefined

        while (true) {
            const page = await provider.getMessages(channel, { limit: 200, offsetId })
            if (page.length === 0) {
                break
            }

            messages.push(...page)

            if (page.length < 200) {
                break
            }

            offsetId = page[page.length - 1]?.id
        }

        return messages
    }
}
