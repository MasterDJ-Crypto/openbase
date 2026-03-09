import type { QueryFilter, QueryResult, SelectOptions, UpsertOptions } from './types.js'
import { parseApiEnvelope } from './http.js'
import { z } from 'zod'

type OperationType = 'select' | 'insert' | 'update' | 'delete' | 'upsert'

const rowSchema = z.record(z.unknown())
const rowsResponseSchema = z.union([z.array(rowSchema), rowSchema, z.null()])
const countResponseSchema = z.object({ count: z.number() })

export class QueryBuilder<T = Record<string, unknown>> {
    private filters: QueryFilter[] = []
    private _select: string[] = []
    private _selectOptions: SelectOptions = {}
    private _order?: { column: string; ascending: boolean }
    private _limit?: number
    private _offset?: number
    private _operation: OperationType = 'select'
    private _body: unknown = null
    private readonly _projectId: string
    private _upsertOptions?: UpsertOptions

    constructor(
        private readonly table: string,
        private readonly projectUrl: string,
        private readonly apiKey: string,
        projectId: string,
        private readonly getAccessToken: () => string | null
    ) {
        this._projectId = projectId
    }

    select(columns: string = '*', options: SelectOptions = {}): this {
        this._operation = 'select'
        this._select = columns === '*' ? [] : columns.split(',').map(column => column.trim())
        this._selectOptions = options
        return this
    }

    eq(column: string, value: unknown): this { return this.addFilter(column, 'eq', value) }
    neq(column: string, value: unknown): this { return this.addFilter(column, 'neq', value) }
    gt(column: string, value: unknown): this { return this.addFilter(column, 'gt', value) }
    gte(column: string, value: unknown): this { return this.addFilter(column, 'gte', value) }
    lt(column: string, value: unknown): this { return this.addFilter(column, 'lt', value) }
    lte(column: string, value: unknown): this { return this.addFilter(column, 'lte', value) }
    like(column: string, pattern: string): this { return this.addFilter(column, 'like', pattern) }
    ilike(column: string, pattern: string): this { return this.addFilter(column, 'ilike', pattern) }
    in(column: string, values: unknown[]): this { return this.addFilter(column, 'in', values) }
    is(column: string, value: null | boolean): this { return this.addFilter(column, 'is', value) }

    order(column: string, options?: { ascending?: boolean }): this {
        this._order = { column, ascending: options?.ascending ?? true }
        return this
    }

    limit(count: number): this {
        this._limit = count
        return this
    }

    range(from: number, to: number): this {
        this._offset = from
        this._limit = to - from + 1
        return this
    }

    single(): Promise<QueryResult<T>> {
        this._limit = 1
        return this.execute().then(result => {
            const singleData = (result.data && Array.isArray(result.data))
                ? (result.data[0] as unknown as T) || null
                : null
            return { ...result, data: singleData } as unknown as QueryResult<T>
        })
    }

    insert(data: Partial<T> | Partial<T>[]): this {
        this._operation = 'insert'
        this._body = data
        return this
    }

    update(data: Partial<T>): this {
        this._operation = 'update'
        this._body = data
        return this
    }

    delete(): this {
        this._operation = 'delete'
        return this
    }

    upsert(data: Partial<T> | Partial<T>[], options?: UpsertOptions): this {
        this._operation = 'upsert'
        this._body = data
        this._upsertOptions = options
        return this
    }

    then<TResult1 = QueryResult<T[]>, TResult2 = never>(
        onfulfilled?: ((value: QueryResult<T[]>) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> {
        return this.execute().then(onfulfilled, onrejected)
    }

    private async execute(): Promise<QueryResult<T[]>> {
        const token = this.getAccessToken() || this.apiKey
        const headers: Record<string, string> = {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            apikey: this.apiKey,
        }

        try {
            const fetchFn = typeof globalThis.fetch !== 'undefined' ? globalThis.fetch : (await import('cross-fetch')).default
            const countPromise = this._operation === 'select' && this._selectOptions.count
                ? this.fetchCount(fetchFn, headers)
                : Promise.resolve(undefined)

            if (this._operation === 'select' && this._selectOptions.head) {
                const count = await countPromise
                return {
                    data: null,
                    error: null,
                    count,
                }
            }

            const response = await fetchFn(this.buildUrl(), {
                method: this.getMethod(),
                headers,
                body: this._body ? JSON.stringify(this._body) : undefined,
            })

            const result = await parseApiEnvelope(response, rowsResponseSchema)
            if (result.error) {
                return {
                    data: null,
                    error: { message: result.error.message, code: result.error.code },
                    count: 0,
                }
            }

            const count = await countPromise
            const data = Array.isArray(result.data)
                ? result.data
                : result.data === null || result.data === undefined
                    ? null
                    : [result.data]

            return {
                data: data as T[] | null,
                error: null,
                count,
            }
        } catch (error) {
            return {
                data: null,
                error: { message: (error as Error).message, code: 'NETWORK_ERROR' },
            }
        }
    }

    private async fetchCount(
        fetchFn: typeof fetch,
        headers: Record<string, string>
    ): Promise<number | undefined> {
        const response = await fetchFn(this.buildCountUrl(), {
            method: 'GET',
            headers,
        })

        const result = await parseApiEnvelope(response, countResponseSchema)
        if (result.error || !result.data) {
            throw new Error(result.error?.message || `HTTP ${response.status}`)
        }

        return result.data.count
    }

    private addFilter(column: string, operator: QueryFilter['operator'], value: unknown): this {
        this.filters.push({ column, operator, value })
        return this
    }

    private buildUrl(): string {
        return `${this.projectUrl}/api/v1/${this._projectId}/tables/${this.table}${this.buildQueryString({
            includeSelect: true,
            includePagination: true,
            includeOrder: true,
            includeUpsert: this._operation === 'upsert',
        })}`
    }

    private buildCountUrl(): string {
        return `${this.projectUrl}/api/v1/${this._projectId}/tables/${this.table}/count${this.buildQueryString({
            includeSelect: false,
            includePagination: false,
            includeOrder: false,
            includeUpsert: false,
        })}`
    }

    private buildQueryString(options: {
        includeSelect: boolean
        includePagination: boolean
        includeOrder: boolean
        includeUpsert: boolean
    }): string {
        const params = new URLSearchParams()

        if (options.includeSelect && this._select.length > 0) {
            params.set('select', this._select.join(','))
        }

        for (const filter of this.filters) {
            const value = Array.isArray(filter.value)
                ? `(${(filter.value as unknown[]).join(',')})`
                : filter.value === null ? 'null' : String(filter.value)

            params.append(filter.column, `${filter.operator}.${value}`)
        }

        if (options.includeOrder && this._order) {
            params.set('order', `${this._order.column}.${this._order.ascending ? 'asc' : 'desc'}`)
        }

        if (options.includePagination && this._limit !== undefined) {
            params.set('limit', String(this._limit))
        }

        if (options.includePagination && this._offset !== undefined) {
            params.set('offset', String(this._offset))
        }

        if (options.includeUpsert) {
            params.set('upsert', 'true')

            if (this._upsertOptions?.onConflict) {
                const columns = Array.isArray(this._upsertOptions.onConflict)
                    ? this._upsertOptions.onConflict
                    : [this._upsertOptions.onConflict]
                params.set('on_conflict', columns.join(','))
            }
        }

        const query = params.toString()
        return query ? `?${query}` : ''
    }

    private getMethod(): string {
        switch (this._operation) {
            case 'insert':
            case 'upsert':
                return 'POST'
            case 'update':
                return 'PATCH'
            case 'delete':
                return 'DELETE'
            default:
                return 'GET'
        }
    }
}
