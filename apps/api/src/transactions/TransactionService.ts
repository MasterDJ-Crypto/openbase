import { randomUUID } from 'crypto'
import type {
    JWTPayload,
    QueryFilter,
    TransactionOperation,
    TransactionOperationCondition,
    TransactionOperationResult,
    TransactionResult,
} from '@openbase/core'
import { ConflictError, ForbiddenError, NotFoundError, nowISO, sleep } from '@openbase/core'
import type Redis from 'ioredis'
import { applyRLS, checkRLSForRow, findPolicy } from '../middleware/index.js'
import type { ProjectService } from '../projects/ProjectService.js'
import type { RealtimeService } from '../realtime/RealtimeService.js'
import type { WebhookService } from '../webhooks/WebhookService.js'
import { buildProjectQueryEngine } from '../database/queryEngineFactory.js'
import type { IndexManager } from '../database/IndexManager.js'
import type { EncryptionService } from '../encryption/EncryptionService.js'

interface TransactionServiceOptions {
    getIndexManager: (projectId: string) => IndexManager
    encryptionService: EncryptionService
    masterKey: Buffer
    realtimeService?: RealtimeService
    webhookService?: WebhookService
}

interface PendingChange {
    table: string
    eventType: 'INSERT' | 'UPDATE' | 'DELETE'
    newRow: Record<string, unknown> | null
    oldRow: Record<string, unknown> | null
}

export class TransactionService {
    constructor(
        private readonly redis: Redis,
        private readonly projectService: ProjectService,
        private readonly options: TransactionServiceOptions
    ) { }

    async execute(
        projectId: string,
        user: JWTPayload | undefined,
        operations: TransactionOperation[]
    ): Promise<TransactionResult> {
        return this.withProjectLock(projectId, async () => {
            const project = await this.projectService.getProject(projectId)
            const schemas = await this.projectService.getSchemas(projectId)

            return this.projectService.withProjectStorageRecord(project, async (_project, provider) => {
                const rollbackActions: Array<() => Promise<void>> = []
                const pendingChanges: PendingChange[] = []
                const results: TransactionOperationResult[] = []

                try {
                    for (const operation of operations) {
                        const schema = schemas[operation.table]
                        if (!schema) {
                            throw new NotFoundError(`Schema for "${operation.table}"`)
                        }

                        const queryEngine = buildProjectQueryEngine(
                            provider,
                            this.options.getIndexManager(projectId),
                            schema,
                            this.options.encryptionService,
                            this.options.masterKey
                        )

                        if (operation.type === 'insert' || operation.type === 'upsert') {
                            const values = operation.values
                            const insertPolicy = findPolicy(schema.rls, 'INSERT')
                            if (!canBypassRLS(user, project.ownerId)) {
                                const blocked = values.find(row => !checkRLSForRow(row, insertPolicy, user || null))
                                if (blocked) {
                                    throw new ForbiddenError('Insert blocked by row-level security policy')
                                }
                            }

                            const rows: Record<string, unknown>[] = []
                            for (const value of values) {
                                if (operation.type === 'insert') {
                                    const inserted = await queryEngine.insert(operation.table, project.channelMap[operation.table], value)
                                    rollbackActions.push(async () => {
                                        await queryEngine.deleteRows(operation.table, project.channelMap[operation.table], [inserted])
                                    })
                                    rows.push(inserted)
                                    pendingChanges.push({
                                        table: operation.table,
                                        eventType: 'INSERT',
                                        newRow: inserted,
                                        oldRow: null,
                                    })
                                    continue
                                }

                                const conflictColumns = operation.onConflict && operation.onConflict.length > 0
                                    ? operation.onConflict
                                    : ['id']
                                const existingRows = await queryEngine.select(operation.table, project.channelMap[operation.table], {
                                    filters: buildConflictFilters(conflictColumns, value),
                                    limit: 1,
                                })

                                if (existingRows.length === 0) {
                                    const inserted = await queryEngine.insert(operation.table, project.channelMap[operation.table], value)
                                    rollbackActions.push(async () => {
                                        await queryEngine.deleteRows(operation.table, project.channelMap[operation.table], [inserted])
                                    })
                                    rows.push(inserted)
                                    pendingChanges.push({
                                        table: operation.table,
                                        eventType: 'INSERT',
                                        newRow: inserted,
                                        oldRow: null,
                                    })
                                    continue
                                }

                                let allowedRows = existingRows
                                if (!canBypassRLS(user, project.ownerId)) {
                                    allowedRows = applyRLS(existingRows, findPolicy(schema.rls, 'UPDATE'), user || null)
                                }
                                assertCondition(operation.condition, allowedRows)

                                const originals = allowedRows.map(row => ({ ...row }))
                                const updated = await queryEngine.updateRows(operation.table, project.channelMap[operation.table], value, allowedRows)
                                rollbackActions.push(async () => {
                                    await queryEngine.replaceRows(operation.table, project.channelMap[operation.table], originals)
                                })
                                rows.push(...updated)
                                for (let index = 0; index < updated.length; index++) {
                                    pendingChanges.push({
                                        table: operation.table,
                                        eventType: 'UPDATE',
                                        newRow: updated[index],
                                        oldRow: originals[index] || null,
                                    })
                                }
                            }

                            results.push({
                                type: operation.type,
                                table: operation.table,
                                count: rows.length,
                                data: rows,
                            })
                            continue
                        }

                        const selectedRows = await queryEngine.select(operation.table, project.channelMap[operation.table], {
                            filters: operation.condition?.filters,
                        })

                        let targetRows = selectedRows
                        if (!canBypassRLS(user, project.ownerId)) {
                            const policy = findPolicy(schema.rls, operation.type === 'update' ? 'UPDATE' : 'DELETE')
                            targetRows = applyRLS(selectedRows, policy, user || null)
                        }

                        assertCondition(operation.condition, targetRows)

                        if (operation.type === 'update') {
                            const originals = targetRows.map(row => ({ ...row }))
                            const updated = await queryEngine.updateRows(operation.table, project.channelMap[operation.table], operation.patch, targetRows)
                            rollbackActions.push(async () => {
                                await queryEngine.replaceRows(operation.table, project.channelMap[operation.table], originals)
                            })

                            results.push({
                                type: 'update',
                                table: operation.table,
                                count: updated.length,
                                data: updated,
                            })

                            for (let index = 0; index < updated.length; index++) {
                                pendingChanges.push({
                                    table: operation.table,
                                    eventType: 'UPDATE',
                                    newRow: updated[index],
                                    oldRow: originals[index] || null,
                                })
                            }
                            continue
                        }

                        const originals = targetRows.map(row => ({ ...row }))
                        const deleted = await queryEngine.deleteRows(operation.table, project.channelMap[operation.table], targetRows)
                        rollbackActions.push(async () => {
                            const restoredRows = originals.map(row => {
                                const nextRow = { ...row }
                                delete nextRow._msgId
                                return nextRow
                            })

                            for (const restoredRow of restoredRows) {
                                await queryEngine.insert(operation.table, project.channelMap[operation.table], restoredRow)
                            }
                        })

                        results.push({
                            type: 'delete',
                            table: operation.table,
                            count: deleted.length,
                            data: deleted,
                        })

                        for (const row of deleted) {
                            pendingChanges.push({
                                table: operation.table,
                                eventType: 'DELETE',
                                newRow: null,
                                oldRow: row,
                            })
                        }
                    }
                } catch (error) {
                    for (const rollbackAction of rollbackActions.reverse()) {
                        await rollbackAction().catch(() => undefined)
                    }
                    throw error
                }

                for (const change of pendingChanges) {
                    this.options.realtimeService?.broadcastChange(projectId, change.table, change.eventType, change.newRow, change.oldRow)
                    await this.options.webhookService?.enqueueDatabaseChange(projectId, change.table, change.eventType, change.newRow, change.oldRow)
                }

                return {
                    id: randomUUID(),
                    projectId,
                    committedAt: nowISO(),
                    operations: results,
                }
            })
        })
    }

    private async withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
        const key = `transactions:lock:${projectId}`
        const token = randomUUID()
        const deadline = Date.now() + 5_000

        while (true) {
            const acquired = await this.redis.set(key, token, 'PX', 10_000, 'NX')
            if (acquired === 'OK') {
                break
            }

            if (Date.now() >= deadline) {
                throw new ConflictError('Another transaction is already in progress for this project')
            }

            await sleep(100)
        }

        try {
            return await fn()
        } finally {
            const current = await this.redis.get(key)
            if (current === token) {
                await this.redis.del(key)
            }
        }
    }
}

function assertCondition(
    condition: TransactionOperationCondition | undefined,
    rows: Record<string, unknown>[]
): void {
    if (!condition) {
        return
    }

    if (condition.expectedCount !== undefined && rows.length !== condition.expectedCount) {
        throw new ConflictError(`Optimistic lock failed. Expected ${condition.expectedCount} rows, found ${rows.length}`)
    }

    if (condition.ifMatchMessageIds?.length) {
        const actual = rows
            .map(row => Number(row._msgId))
            .filter(value => Number.isFinite(value))
            .sort((left, right) => left - right)
        const expected = [...condition.ifMatchMessageIds].sort((left, right) => left - right)

        if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
            throw new ConflictError('Optimistic lock failed because one or more rows changed before the transaction committed')
        }
    }
}

function buildConflictFilters(columns: string[], value: Record<string, unknown>): QueryFilter[] {
    return columns
        .filter(column => value[column] !== undefined)
        .map(column => ({
            column,
            operator: 'eq' as const,
            value: value[column],
        }))
}

function canBypassRLS(user: JWTPayload | undefined, ownerId: string): boolean {
    return user?.role === 'service_role' || (user?.role === 'platform_user' && user.sub === ownerId)
}
