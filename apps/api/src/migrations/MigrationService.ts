import { randomUUID } from 'crypto'
import type {
    ColumnDefinition,
    MigrationDefinition,
    MigrationHistoryEntry,
    MigrationOperation,
    Project,
    RLSPolicy,
    SchemaExport,
    TableSchema,
    TelegramChannelRef,
    TelegramMessage,
} from '@openbase/core'
import {
    ConflictError,
    NotFoundError,
    ValidationError,
    nowISO,
} from '@openbase/core'
import type { StorageProvider } from '@openbase/telegram'
import type { IndexManager } from '../database/IndexManager.js'
import { buildProjectQueryEngine } from '../database/queryEngineFactory.js'
import type { EncryptionService } from '../encryption/EncryptionService.js'
import type { ProjectService } from '../projects/ProjectService.js'

interface MigrationServiceOptions {
    getIndexManager: (projectId: string) => IndexManager
    encryptionService: EncryptionService
    masterKey: Buffer
}

interface ApplyMigrationInput extends MigrationDefinition {
    checksum: string
    source: MigrationHistoryEntry['source']
}

interface TableSnapshot {
    schema: TableSchema
    rows: Record<string, unknown>[]
}

export class MigrationService {
    constructor(
        private readonly projectService: ProjectService,
        private readonly options: MigrationServiceOptions
    ) { }

    async list(projectId: string): Promise<SchemaExport> {
        const project = await this.projectService.getProject(projectId)
        const tables = await this.projectService.getSchemas(projectId)
        const migrations = await this.listHistory(project)

        return {
            projectId: project.id,
            projectName: project.name,
            tables,
            migrations,
            appliedMigrations: this.computeAppliedMigrations(migrations),
        }
    }

    async apply(projectId: string, migration: ApplyMigrationInput): Promise<SchemaExport> {
        const project = await this.projectService.getProject(projectId)
        const state = await this.list(projectId)

        if (state.appliedMigrations.includes(migration.name)) {
            throw new ConflictError(`Migration "${migration.name}" is already applied`)
        }

        await this.projectService.withProjectStorageRecord(project, async (currentProject, provider) => {
            await this.executeMigration(currentProject, provider, migration, migration.up, 'up')
        })

        return this.list(projectId)
    }

    async rollback(projectId: string, migration: ApplyMigrationInput): Promise<SchemaExport> {
        const project = await this.projectService.getProject(projectId)
        const state = await this.list(projectId)

        if (!state.appliedMigrations.includes(migration.name)) {
            throw new NotFoundError(`Applied migration "${migration.name}"`)
        }

        await this.projectService.withProjectStorageRecord(project, async (currentProject, provider) => {
            await this.executeMigration(currentProject, provider, migration, migration.down, 'down')
        })

        return this.list(projectId)
    }

    private async executeMigration(
        project: Project,
        provider: StorageProvider,
        migration: ApplyMigrationInput,
        operations: MigrationOperation[],
        direction: MigrationHistoryEntry['direction']
    ): Promise<void> {
        const originalProject: Project = {
            ...project,
            channelMap: { ...project.channelMap },
            archivedTableChannels: { ...(project.archivedTableChannels || {}) },
        }
        const workingProject: Project = {
            ...project,
            channelMap: { ...project.channelMap },
            archivedTableChannels: { ...(project.archivedTableChannels || {}) },
        }
        const workingSchemas = await this.projectService.getSchemas(project.id)
        const tableSnapshots = new Map<string, TableSnapshot>()
        const createdChannels = new Map<string, TelegramChannelRef>()
        const touchedIndexes = new Set<string>()

        try {
            for (const operation of operations) {
                await this.applyOperation(
                    workingProject,
                    workingSchemas,
                    provider,
                    operation,
                    tableSnapshots,
                    touchedIndexes,
                    createdChannels
                )
            }

            for (const tableName of touchedIndexes) {
                const schema = workingSchemas[tableName]
                const channel = workingProject.channelMap[tableName]
                if (schema && channel) {
                    await this.rebuildIndexes(project.id, provider, tableName, schema, channel)
                }
            }

            await provider.sendMessage(
                workingProject.schemaChannel,
                JSON.stringify({
                    __type: 'MIGRATION_HISTORY',
                    entry: {
                        name: migration.name,
                        description: migration.description,
                        checksum: migration.checksum,
                        direction,
                        source: migration.source,
                        appliedAt: nowISO(),
                        operations: operations.length,
                    } satisfies MigrationHistoryEntry,
                })
            )
        } catch (error) {
            await this.restoreProjectState(originalProject, workingProject, provider, tableSnapshots, createdChannels)
            throw error
        }
    }

    private async applyOperation(
        project: Project,
        schemas: Record<string, TableSchema>,
        provider: StorageProvider,
        operation: MigrationOperation,
        tableSnapshots: Map<string, TableSnapshot>,
        touchedIndexes: Set<string>,
        createdChannels: Map<string, TelegramChannelRef>
    ): Promise<void> {
        switch (operation.type) {
            case 'create_table': {
                const tableName = operation.table.tableName
                if (schemas[tableName]) {
                    throw new ConflictError(`Table "${tableName}" already exists`)
                }

                this.assertEncryptedIndexes(operation.table)
                const restoredChannel = project.archivedTableChannels?.[tableName]
                const channel = restoredChannel ?? await this.projectService.addTable(project.id, tableName, operation.table)
                if (restoredChannel) {
                    project.channelMap[tableName] = restoredChannel
                    delete project.archivedTableChannels?.[tableName]
                    await this.projectService.updateProject(project.id, {
                        channelMap: project.channelMap,
                        archivedTableChannels: project.archivedTableChannels,
                    })
                    await this.projectService.saveSchema(project.schemaChannel, tableName, operation.table, provider)
                }
                project.channelMap[tableName] = channel
                delete project.archivedTableChannels?.[tableName]
                if (!restoredChannel) {
                    createdChannels.set(tableName, channel)
                }
                schemas[tableName] = operation.table
                touchedIndexes.add(tableName)
                return
            }

            case 'drop_table': {
                const schema = this.requireSchema(schemas, operation.tableName)
                const channel = project.channelMap[operation.tableName]
                if (!channel) {
                    throw new NotFoundError(`Table channel "${operation.tableName}"`)
                }

                await this.snapshotTable(project.id, operation.tableName, schema, channel, provider, tableSnapshots)
                project.archivedTableChannels = project.archivedTableChannels || {}
                project.archivedTableChannels[operation.tableName] = channel
                delete project.channelMap[operation.tableName]
                await this.projectService.updateProject(project.id, {
                    channelMap: project.channelMap,
                    archivedTableChannels: project.archivedTableChannels,
                })
                delete schemas[operation.tableName]
                await this.projectService.markSchemaRemoved(project.schemaChannel, operation.tableName, provider)
                await this.options.getIndexManager(project.id).dropTable(operation.tableName)
                touchedIndexes.delete(operation.tableName)
                return
            }

            case 'add_column': {
                const schema = this.requireSchema(schemas, operation.tableName)
                if (schema.columns.some(column => column.name === operation.column.name)) {
                    throw new ConflictError(`Column "${operation.column.name}" already exists on "${operation.tableName}"`)
                }

                const nextSchema: TableSchema = {
                    ...schema,
                    columns: [...schema.columns, operation.column],
                }

                this.assertEncryptedIndexes(nextSchema)
                await this.maybeSnapshotTable(project.id, operation.tableName, schema, project.channelMap[operation.tableName], provider, tableSnapshots)

                if (operation.column.required && !operation.backfill && operation.column.default === undefined) {
                    throw new ValidationError(
                        `Required column "${operation.column.name}" needs a default or backfill to migrate existing rows`
                    )
                }

                if (operation.column.required || operation.backfill || operation.column.default !== undefined) {
                    const rows = await this.selectRows(project.id, provider, operation.tableName, schema, project.channelMap[operation.tableName])
                    const nextRows = rows.map(row => ({
                        ...row,
                        [operation.column.name]: this.resolveBackfillValue(operation.column, operation.backfill),
                    }))
                    await this.replaceRows(project.id, provider, operation.tableName, nextSchema, project.channelMap[operation.tableName], nextRows)
                }

                schemas[operation.tableName] = nextSchema
                await this.projectService.saveSchema(project.schemaChannel, operation.tableName, nextSchema, provider)
                touchedIndexes.add(operation.tableName)
                return
            }

            case 'remove_column': {
                const schema = this.requireSchema(schemas, operation.tableName)
                this.ensureRlsDoesNotReferenceColumn(schema.rls, operation.columnName, operation.tableName)
                await this.maybeSnapshotTable(project.id, operation.tableName, schema, project.channelMap[operation.tableName], provider, tableSnapshots)

                const nextSchema: TableSchema = {
                    ...schema,
                    columns: schema.columns.filter(column => column.name !== operation.columnName),
                    indexes: schema.indexes.filter(index => index !== operation.columnName),
                }

                const rows = await this.selectRows(project.id, provider, operation.tableName, schema, project.channelMap[operation.tableName])
                const nextRows = rows.map(row => {
                    const updated = { ...row }
                    delete updated[operation.columnName]
                    return updated
                })

                await this.replaceRows(project.id, provider, operation.tableName, nextSchema, project.channelMap[operation.tableName], nextRows)
                schemas[operation.tableName] = nextSchema
                await this.projectService.saveSchema(project.schemaChannel, operation.tableName, nextSchema, provider)
                touchedIndexes.add(operation.tableName)
                return
            }

            case 'rename_column': {
                const schema = this.requireSchema(schemas, operation.tableName)
                if (schema.columns.some(column => column.name === operation.to)) {
                    throw new ConflictError(`Column "${operation.to}" already exists on "${operation.tableName}"`)
                }

                await this.maybeSnapshotTable(project.id, operation.tableName, schema, project.channelMap[operation.tableName], provider, tableSnapshots)
                const nextSchema: TableSchema = {
                    ...schema,
                    columns: schema.columns.map(column => column.name === operation.from ? { ...column, name: operation.to } : column),
                    indexes: schema.indexes.map(index => index === operation.from ? operation.to : index),
                    rls: this.renameRlsColumn(schema.rls, operation.from, operation.to),
                }

                const rows = await this.selectRows(project.id, provider, operation.tableName, schema, project.channelMap[operation.tableName])
                const nextRows = rows.map(row => {
                    const updated = { ...row }
                    if (operation.from in updated) {
                        updated[operation.to] = updated[operation.from]
                        delete updated[operation.from]
                    }
                    return updated
                })

                await this.replaceRows(project.id, provider, operation.tableName, nextSchema, project.channelMap[operation.tableName], nextRows)
                schemas[operation.tableName] = nextSchema
                await this.projectService.saveSchema(project.schemaChannel, operation.tableName, nextSchema, provider)
                touchedIndexes.add(operation.tableName)
                return
            }

            case 'change_column_type': {
                const schema = this.requireSchema(schemas, operation.tableName)
                await this.maybeSnapshotTable(project.id, operation.tableName, schema, project.channelMap[operation.tableName], provider, tableSnapshots)
                const nextSchema: TableSchema = {
                    ...schema,
                    columns: schema.columns.map(column => column.name === operation.columnName ? { ...column, type: operation.nextType } : column),
                }

                const rows = await this.selectRows(project.id, provider, operation.tableName, schema, project.channelMap[operation.tableName])
                const nextRows = rows.map(row => ({
                    ...row,
                    [operation.columnName]: this.coerceColumnValue(row[operation.columnName], operation.nextType),
                }))

                await this.replaceRows(project.id, provider, operation.tableName, nextSchema, project.channelMap[operation.tableName], nextRows)
                schemas[operation.tableName] = nextSchema
                await this.projectService.saveSchema(project.schemaChannel, operation.tableName, nextSchema, provider)
                touchedIndexes.add(operation.tableName)
                return
            }

            case 'add_index': {
                const schema = this.requireSchema(schemas, operation.tableName)
                const column = schema.columns.find(candidate => candidate.name === operation.columnName)
                if (!column) {
                    throw new NotFoundError(`Column "${operation.columnName}" on "${operation.tableName}"`)
                }
                if (column.encrypted) {
                    throw new ValidationError(`Encrypted column "${operation.columnName}" cannot be indexed`)
                }

                const nextSchema: TableSchema = {
                    ...schema,
                    indexes: Array.from(new Set([...schema.indexes, operation.columnName])),
                }
                schemas[operation.tableName] = nextSchema
                await this.projectService.saveSchema(project.schemaChannel, operation.tableName, nextSchema, provider)
                touchedIndexes.add(operation.tableName)
                return
            }

            case 'remove_index': {
                const schema = this.requireSchema(schemas, operation.tableName)
                const nextSchema: TableSchema = {
                    ...schema,
                    indexes: schema.indexes.filter(index => index !== operation.columnName),
                }
                schemas[operation.tableName] = nextSchema
                await this.projectService.saveSchema(project.schemaChannel, operation.tableName, nextSchema, provider)
                touchedIndexes.add(operation.tableName)
                return
            }

            case 'replace_rls': {
                const schema = this.requireSchema(schemas, operation.tableName)
                const nextSchema: TableSchema = {
                    ...schema,
                    rls: operation.rls,
                }
                schemas[operation.tableName] = nextSchema
                await this.projectService.saveSchema(project.schemaChannel, operation.tableName, nextSchema, provider)
                return
            }
        }
    }

    private async restoreProjectState(
        originalProject: Project,
        workingProject: Project,
        provider: StorageProvider,
        tableSnapshots: Map<string, TableSnapshot>,
        createdChannels: Map<string, TelegramChannelRef>
    ): Promise<void> {
        await this.projectService.updateProject(workingProject.id, {
            channelMap: originalProject.channelMap,
            archivedTableChannels: originalProject.archivedTableChannels,
        })

        for (const [tableName, snapshot] of tableSnapshots) {
            const channel = originalProject.channelMap[tableName] || originalProject.archivedTableChannels?.[tableName]
            if (!channel) {
                continue
            }

            await this.replaceRows(workingProject.id, provider, tableName, snapshot.schema, channel, snapshot.rows).catch(() => undefined)
            await this.projectService.saveSchema(originalProject.schemaChannel, tableName, snapshot.schema, provider).catch(() => undefined)
        }

        for (const [tableName, channel] of createdChannels) {
            if (originalProject.channelMap[tableName] || originalProject.archivedTableChannels?.[tableName]) {
                continue
            }

            await provider.deleteChannel(channel).catch(() => undefined)
            await this.options.getIndexManager(workingProject.id).dropTable(tableName).catch(() => undefined)
            await this.projectService.markSchemaRemoved(originalProject.schemaChannel, tableName, provider).catch(() => undefined)
        }
    }

    private async maybeSnapshotTable(
        projectId: string,
        tableName: string,
        schema: TableSchema,
        channel: TelegramChannelRef | undefined,
        provider: StorageProvider,
        tableSnapshots: Map<string, TableSnapshot>
    ): Promise<void> {
        if (!channel) {
            throw new NotFoundError(`Table channel "${tableName}"`)
        }

        await this.snapshotTable(projectId, tableName, schema, channel, provider, tableSnapshots)
    }

    private async snapshotTable(
        projectId: string,
        tableName: string,
        schema: TableSchema,
        channel: TelegramChannelRef,
        provider: StorageProvider,
        tableSnapshots: Map<string, TableSnapshot>
    ): Promise<void> {
        if (tableSnapshots.has(tableName)) {
            return
        }

        tableSnapshots.set(tableName, {
            schema,
            rows: await this.selectRows(projectId, provider, tableName, schema, channel),
        })
    }

    private async selectRows(
        projectId: string,
        provider: StorageProvider,
        tableName: string,
        schema: TableSchema,
        channel: TelegramChannelRef
    ): Promise<Record<string, unknown>[]> {
        const queryEngine = buildProjectQueryEngine(
            provider,
            this.options.getIndexManager(projectId),
            schema,
            this.options.encryptionService,
            this.options.masterKey
        )

        return queryEngine.select(tableName, channel)
    }

    private async replaceRows(
        projectId: string,
        provider: StorageProvider,
        tableName: string,
        schema: TableSchema,
        channel: TelegramChannelRef,
        rows: Record<string, unknown>[]
    ): Promise<void> {
        const queryEngine = buildProjectQueryEngine(
            provider,
            this.options.getIndexManager(projectId),
            schema,
            this.options.encryptionService,
            this.options.masterKey
        )

        await queryEngine.replaceRows(tableName, channel, rows)
    }

    private async rebuildIndexes(
        projectId: string,
        provider: StorageProvider,
        tableName: string,
        schema: TableSchema,
        channel: TelegramChannelRef
    ): Promise<void> {
        const indexManager = this.options.getIndexManager(projectId)
        await indexManager.dropTable(tableName)

        const rows = await this.selectRows(projectId, provider, tableName, schema, channel)
        const entries = rows.flatMap(row => {
            const messageId = row._msgId as number
            const indexedColumns = schema.indexes
                .map(index => schema.columns.find(column => column.name === index))
                .filter((column): column is ColumnDefinition => column !== undefined)
                .filter(column => !column.encrypted)

            return schema.indexes
                .map(index => indexedColumns.find(column => column.name === index))
                .filter((column): column is ColumnDefinition => column !== undefined)
                .map(column => ({
                    tableName,
                    columnName: column.name,
                    value: row[column.name],
                    messageId,
                }))
                .filter(entry => entry.value !== undefined && entry.value !== null)
                .map(entry => ({
                    tableName: entry.tableName,
                    columnName: entry.columnName,
                    value: String(entry.value),
                    messageId: entry.messageId,
                }))
        })

        if (entries.length > 0) {
            await indexManager.addIndexBatch(entries)
        }
    }

    private async listHistory(project: Project): Promise<MigrationHistoryEntry[]> {
        return this.projectService.withProjectStorageRecord(project, async (_project, provider) => {
            const messages = await this.getAllMessages(provider, project.schemaChannel)
            const history: MigrationHistoryEntry[] = []

            for (const message of [...messages].reverse()) {
                const parsed = this.parseMigrationHistory(message)
                if (parsed) {
                    history.push(parsed)
                }
            }

            return history
        })
    }

    private parseMigrationHistory(message: TelegramMessage): MigrationHistoryEntry | null {
        try {
            const parsed = JSON.parse(message.text) as {
                __type?: string
                entry?: MigrationHistoryEntry
            }

            if (parsed.__type !== 'MIGRATION_HISTORY' || !parsed.entry) {
                return null
            }

            return parsed.entry
        } catch {
            return null
        }
    }

    private computeAppliedMigrations(history: MigrationHistoryEntry[]): string[] {
        const state = new Map<string, boolean>()

        for (const entry of history) {
            state.set(entry.name, entry.direction === 'up')
        }

        return [...state.entries()]
            .filter(([, applied]) => applied)
            .map(([name]) => name)
            .sort()
    }

    private requireSchema(schemas: Record<string, TableSchema>, tableName: string): TableSchema {
        const schema = schemas[tableName]
        if (!schema) {
            throw new NotFoundError(`Schema for "${tableName}"`)
        }

        return schema
    }

    private assertEncryptedIndexes(schema: TableSchema): void {
        const encryptedColumns = new Set(
            schema.columns.filter(column => column.encrypted).map(column => column.name)
        )
        const invalid = schema.indexes.filter(index => encryptedColumns.has(index))
        if (invalid.length > 0) {
            throw new ValidationError(`Encrypted columns cannot be indexed: ${invalid.join(', ')}`)
        }
    }

    private resolveBackfillValue(
        column: ColumnDefinition,
        backfill?: { mode: 'default' | 'literal'; value?: unknown }
    ): unknown {
        if (backfill?.mode === 'literal') {
            return backfill.value ?? null
        }

        if (column.default !== undefined) {
            return column.default
        }

        if (column.type === 'uuid' && column.name === 'id') {
            return randomUUID()
        }

        if (column.type === 'timestamp') {
            return new Date().toISOString()
        }

        return null
    }

    private ensureRlsDoesNotReferenceColumn(
        policies: RLSPolicy[] | undefined,
        columnName: string,
        tableName: string
    ): void {
        const references = policies?.some(policy => new RegExp(`\\b${this.escapeRegex(columnName)}\\b`).test(policy.check))
        if (references) {
            throw new ValidationError(`RLS for "${tableName}" still references "${columnName}". Replace RLS first.`)
        }
    }

    private renameRlsColumn(
        policies: RLSPolicy[] | undefined,
        from: string,
        to: string
    ): RLSPolicy[] | undefined {
        if (!policies) {
            return undefined
        }

        const pattern = new RegExp(`\\b${this.escapeRegex(from)}\\b`, 'g')
        return policies.map(policy => ({
            ...policy,
            check: policy.check.replace(pattern, to),
        }))
    }

    private coerceColumnValue(value: unknown, nextType: ColumnDefinition['type']): unknown {
        if (value === null || value === undefined) {
            return value
        }

        switch (nextType) {
            case 'text':
            case 'uuid':
            case 'timestamp':
                return typeof value === 'string' ? value : JSON.stringify(value)
            case 'number': {
                const nextValue = typeof value === 'number' ? value : Number(value)
                if (Number.isNaN(nextValue)) {
                    throw new ValidationError(`Cannot coerce value "${String(value)}" to number`)
                }
                return nextValue
            }
            case 'boolean':
                if (typeof value === 'boolean') {
                    return value
                }
                if (value === 'true' || value === '1' || value === 1) {
                    return true
                }
                if (value === 'false' || value === '0' || value === 0) {
                    return false
                }
                throw new ValidationError(`Cannot coerce value "${String(value)}" to boolean`)
            case 'json':
                if (typeof value === 'object') {
                    return value
                }
                if (typeof value === 'string') {
                    return JSON.parse(value)
                }
                return { value }
        }
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

    private escapeRegex(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
}
