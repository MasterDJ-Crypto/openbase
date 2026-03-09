/**
 * QueryEngine — Translates Supabase-style filters to Telegram fetch + in-memory filtering.
 */

import { randomUUID } from 'crypto'
import type { QueryFilter, QueryOptions, TableSchema, TelegramMessage } from '@openbase/core'
import { ConflictError, safeJsonParse } from '@openbase/core'
import type { StorageProvider } from '@openbase/telegram'
import type { IndexManager } from './IndexManager.js'

interface QueryEngineOptions {
    encodeValue?: (columnName: string, value: unknown) => unknown
    decodeValue?: (columnName: string, value: unknown) => unknown
}

type QueryRow = Record<string, unknown> & { _msgId: number }

export class QueryEngine {
    private readonly encryptedColumns: Set<string>

    constructor(
        private readonly storageProvider: StorageProvider,
        private readonly indexManager: IndexManager,
        private readonly schema: TableSchema,
        private readonly options: QueryEngineOptions = {}
    ) {
        this.encryptedColumns = new Set(
            this.schema.columns.filter(column => column.encrypted).map(column => column.name)
        )
    }

    async select(
        tableName: string,
        channel: string | { id: string; accessHash: string },
        options: QueryOptions = {}
    ): Promise<Record<string, unknown>[]> {
        const indexedFilter = options.filters?.find(
            filter => filter.operator === 'eq'
                && this.schema.indexes.includes(filter.column)
                && !this.encryptedColumns.has(filter.column)
        )

        let messages: TelegramMessage[] = []

        if (indexedFilter) {
            const messageIds = await this.indexManager.lookup(
                tableName,
                indexedFilter.column,
                String(indexedFilter.value)
            )

            if (messageIds.length === 0) {
                return []
            }

            const results = await Promise.all(
                messageIds.map(async messageId => {
                    const text = await this.storageProvider.getMessage(channel, messageId)
                    return text ? { id: messageId, text, date: 0 } : null
                })
            )

            messages = results.filter((message): message is TelegramMessage => message !== null)
        } else {
            messages = await this.fetchAllMessages(channel)
        }

        let rows: QueryRow[] = messages
            .map(message => {
                const parsed = safeJsonParse<Record<string, unknown>>(message.text)
                if (!parsed) return null
                if (parsed.__type === 'COMMIT' || parsed.__type === 'WARMUP' || parsed.__type === 'ROLLBACK') {
                    return null
                }

                return {
                    _msgId: message.id,
                    ...this.decodeRow(parsed),
                }
            })
            .filter((row): row is QueryRow => row !== null)

        if (options.filters?.length) {
            const filtersToApply = indexedFilter
                ? options.filters.filter(filter => filter !== indexedFilter)
                : options.filters

            rows = rows.filter(row => this.applyFilters(row, filtersToApply))
        }

        if (options.orderBy) {
            const { column, ascending } = options.orderBy
            rows.sort((left, right) => this.compareValues(left[column], right[column], ascending))
        }

        if (options.offset !== undefined && options.offset > 0) {
            rows = rows.slice(options.offset)
        }

        if (options.limit !== undefined) {
            rows = rows.slice(0, options.limit)
        }

        if (options.select?.length) {
            return rows.map(row =>
                Object.fromEntries(options.select!.map(column => [column, row[column]]))
            )
        }

        return rows
    }

    async insert(
        tableName: string,
        channel: string | { id: string; accessHash: string },
        data: Record<string, unknown>
    ): Promise<{ _msgId: number; [key: string]: unknown }> {
        const row = this.applyDefaults(data)
        this.validateRow(row)
        await this.ensureUniqueConstraints(tableName, channel, row)

        const encodedRow = this.encodeRow(row)
        const messageId = await this.storageProvider.sendMessage(channel, JSON.stringify(encodedRow))

        await this.updateIndexes(tableName, messageId, row)

        return { _msgId: messageId, ...row }
    }

    async upsert(
        tableName: string,
        channel: string | { id: string; accessHash: string },
        data: Record<string, unknown>,
        conflictColumns: string[] = ['id']
    ): Promise<{ operation: 'insert' | 'update'; row: Record<string, unknown> }> {
        const usableConflictColumns = conflictColumns.filter(column => data[column] !== undefined)

        if (usableConflictColumns.length === 0) {
            const inserted = await this.insert(tableName, channel, data)
            return { operation: 'insert', row: inserted }
        }

        const filters: QueryFilter[] = usableConflictColumns.map(column => ({
            column,
            operator: 'eq',
            value: data[column],
        }))

        const existingRows = await this.select(tableName, channel, { filters, limit: 1 })
        if (existingRows.length === 0) {
            const inserted = await this.insert(tableName, channel, data)
            return { operation: 'insert', row: inserted }
        }

        const updatedRows = await this.updateRows(tableName, channel, data, existingRows)
        return { operation: 'update', row: updatedRows[0] }
    }

    async update(
        tableName: string,
        channel: string | { id: string; accessHash: string },
        data: Record<string, unknown>,
        filters: QueryFilter[]
    ): Promise<number> {
        const rows = await this.select(tableName, channel, { filters })
        const updatedRows = await this.updateRows(tableName, channel, data, rows)
        return updatedRows.length
    }

    async delete(
        tableName: string,
        channel: string | { id: string; accessHash: string },
        filters: QueryFilter[]
    ): Promise<number> {
        const rows = await this.select(tableName, channel, { filters })
        const deletedRows = await this.deleteRows(tableName, channel, rows)
        return deletedRows.length
    }

    async updateRows(
        tableName: string,
        channel: string | { id: string; accessHash: string },
        data: Record<string, unknown>,
        rows: Record<string, unknown>[]
    ): Promise<Record<string, unknown>[]> {
        const touchesUpdatedAt = this.schema.columns.some(
            column => column.name === 'updated_at' && column.type === 'timestamp'
        )

        return this.replaceRows(
            tableName,
            channel,
            rows.map(row => {
                const updated: Record<string, unknown> = {
                    ...row,
                    ...data,
                }

                if (touchesUpdatedAt) {
                    updated.updated_at = new Date().toISOString()
                }

                return updated
            })
        )
    }

    async deleteRows(
        tableName: string,
        channel: string | { id: string; accessHash: string },
        rows: Record<string, unknown>[]
    ): Promise<Record<string, unknown>[]> {
        const deletedRows: Record<string, unknown>[] = []

        for (const row of rows) {
            const messageId = row._msgId as number
            await this.storageProvider.deleteMessage(channel, messageId)
            await this.indexManager.removeIndex(tableName, messageId)
            deletedRows.push(row)
        }

        return deletedRows
    }

    async replaceRows(
        tableName: string,
        channel: string | { id: string; accessHash: string },
        rows: Record<string, unknown>[]
    ): Promise<Record<string, unknown>[]> {
        const updatedRows: Record<string, unknown>[] = []

        for (const row of rows) {
            const messageId = row._msgId as number
            const nextRow = { ...row }
            delete nextRow._msgId

            this.validateRow(nextRow)
            await this.ensureUniqueConstraints(tableName, channel, nextRow, messageId)

            await this.storageProvider.editMessage(
                channel,
                messageId,
                JSON.stringify(this.encodeRow(nextRow))
            )

            await this.updateIndexes(tableName, messageId, nextRow)
            updatedRows.push({ _msgId: messageId, ...nextRow })
        }

        return updatedRows
    }

    private async fetchAllMessages(channel: string | { id: string; accessHash: string }): Promise<TelegramMessage[]> {
        const allMessages: TelegramMessage[] = []
        let offsetId: number | undefined

        while (true) {
            const page = await this.storageProvider.getMessages(channel, {
                limit: 200,
                offsetId,
            })

            if (page.length === 0) {
                break
            }

            allMessages.push(...page)

            if (page.length < 200) {
                break
            }

            offsetId = page[page.length - 1]?.id
        }

        return allMessages
    }

    private async ensureUniqueConstraints(
        tableName: string,
        channel: string | { id: string; accessHash: string },
        row: Record<string, unknown>,
        currentMessageId?: number
    ): Promise<void> {
        for (const column of this.schema.columns.filter(candidate => candidate.unique)) {
            const value = row[column.name]
            if (value === undefined || value === null) {
                continue
            }

            const matches = await this.select(tableName, channel, {
                filters: [{ column: column.name, operator: 'eq', value }],
                limit: 2,
            })

            const hasConflict = matches.some(match => (match._msgId as number | undefined) !== currentMessageId)
            if (hasConflict) {
                throw new ConflictError(`Column "${column.name}" must be unique`)
            }
        }
    }

    private async updateIndexes(
        tableName: string,
        messageId: number,
        row: Record<string, unknown>
    ): Promise<void> {
        const indexEntries = this.schema.indexes
            .filter(column => !this.encryptedColumns.has(column))
            .filter(column => row[column] !== undefined && row[column] !== null)
            .map(column => ({
                columnName: column,
                value: String(row[column]),
            }))

        if (indexEntries.length > 0) {
            await this.indexManager.updateIndex(tableName, messageId, indexEntries)
        }
    }

    private applyFilters(row: Record<string, unknown>, filters: QueryFilter[]): boolean {
        return filters.every(filter => {
            const value = row[filter.column]
            switch (filter.operator) {
                case 'eq':
                    return value === filter.value
                case 'neq':
                    return value !== filter.value
                case 'gt':
                    return this.toComparable(value) > this.toComparable(filter.value)
                case 'gte':
                    return this.toComparable(value) >= this.toComparable(filter.value)
                case 'lt':
                    return this.toComparable(value) < this.toComparable(filter.value)
                case 'lte':
                    return this.toComparable(value) <= this.toComparable(filter.value)
                case 'like':
                    return String(value ?? '').includes(String(filter.value).replace(/%/g, ''))
                case 'ilike':
                    return String(value ?? '').toLowerCase().includes(
                        String(filter.value).replace(/%/g, '').toLowerCase()
                    )
                case 'in':
                    return Array.isArray(filter.value) && filter.value.includes(value)
                case 'is':
                    return filter.value === null ? value === null || value === undefined : value === filter.value
                default:
                    return false
            }
        })
    }

    private validateRow(data: Record<string, unknown>): void {
        for (const column of this.schema.columns) {
            const value = data[column.name]

            if (column.required && (value === undefined || value === null) && column.default === undefined) {
                throw new Error(`Column "${column.name}" is required`)
            }

            if (value === undefined || value === null) {
                continue
            }

            switch (column.type) {
                case 'text':
                case 'uuid':
                case 'timestamp':
                    if (typeof value !== 'string') {
                        throw new Error(`Column "${column.name}" must be a string`)
                    }
                    break
                case 'number':
                    if (typeof value !== 'number') {
                        throw new Error(`Column "${column.name}" must be a number`)
                    }
                    break
                case 'boolean':
                    if (typeof value !== 'boolean') {
                        throw new Error(`Column "${column.name}" must be a boolean`)
                    }
                    break
                case 'json':
                    if (typeof value !== 'object') {
                        throw new Error(`Column "${column.name}" must be an object`)
                    }
                    break
            }
        }
    }

    private applyDefaults(data: Record<string, unknown>): Record<string, unknown> {
        const row = { ...data }

        for (const column of this.schema.columns) {
            if (row[column.name] === undefined) {
                if (column.default !== undefined) {
                    row[column.name] = typeof column.default === 'function'
                        ? (column.default as () => unknown)()
                        : column.default
                } else if (column.type === 'uuid' && column.name === 'id') {
                    row[column.name] = randomUUID()
                } else if (
                    column.type === 'timestamp'
                    && (column.name === 'created_at' || column.name === 'updated_at')
                ) {
                    row[column.name] = new Date().toISOString()
                }
            }
        }

        return row
    }

    private encodeRow(row: Record<string, unknown>): Record<string, unknown> {
        return Object.fromEntries(
            Object.entries(row).map(([columnName, value]) => [columnName, this.options.encodeValue?.(columnName, value) ?? value])
        )
    }

    private decodeRow(row: Record<string, unknown>): Record<string, unknown> {
        return Object.fromEntries(
            Object.entries(row).map(([columnName, value]) => [columnName, this.options.decodeValue?.(columnName, value) ?? value])
        )
    }

    private compareValues(left: unknown, right: unknown, ascending: boolean): number {
        if (left === right) return 0
        if (left === null || left === undefined) return ascending ? 1 : -1
        if (right === null || right === undefined) return ascending ? -1 : 1

        const normalizedLeft = this.toComparable(left)
        const normalizedRight = this.toComparable(right)

        if (normalizedLeft === normalizedRight) return 0
        return ascending
            ? normalizedLeft > normalizedRight ? 1 : -1
            : normalizedLeft < normalizedRight ? 1 : -1
    }

    private toComparable(value: unknown): string | number | boolean {
        if (typeof value === 'number' || typeof value === 'boolean') {
            return value
        }
        if (typeof value === 'string') {
            const dateValue = Date.parse(value)
            if (!Number.isNaN(dateValue) && value.includes('T')) {
                return dateValue
            }
            return value
        }
        return JSON.stringify(value)
    }
}
