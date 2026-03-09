import type { FastifyRequest } from 'fastify'
import type { QueryFilter } from '@openbase/core'
import { parseFilterValue } from './filtering.js'

export interface ParsedDatabaseQuery {
    filters: QueryFilter[]
    select?: string[]
    orderBy?: { column: string; ascending: boolean }
    limit?: number
    offset?: number
    upsert?: boolean
    onConflict?: string[]
}

const RESERVED_KEYS = new Set(['select', 'order', 'limit', 'offset', 'upsert', 'on_conflict'])

export function parseDatabaseRequestQuery(request: FastifyRequest): ParsedDatabaseQuery {
    const url = request.raw.url || request.url || ''
    const search = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
    const params = new URLSearchParams(search)
    const filters: QueryFilter[] = []

    for (const [key, value] of params.entries()) {
        if (RESERVED_KEYS.has(key)) {
            continue
        }

        const dotIndex = value.indexOf('.')
        if (dotIndex === -1) {
            continue
        }

        const operator = value.slice(0, dotIndex)
        const rawValue = value.slice(dotIndex + 1)

        filters.push({
            column: key,
            operator: operator as QueryFilter['operator'],
            value: parseFilterValue(operator as QueryFilter['operator'], rawValue),
        })
    }

    const select = params.get('select')
        ?.split(',')
        .map(column => column.trim())
        .filter(Boolean)

    const order = params.get('order')
    const [orderColumn, orderDirection] = order ? order.split('.') : []

    const limitValue = params.get('limit')
    const offsetValue = params.get('offset')
    const upsertValue = params.get('upsert')
    const onConflict = params.get('on_conflict')

    return {
        filters,
        select: select && select.length > 0 ? select : undefined,
        orderBy: orderColumn
            ? {
                column: orderColumn,
                ascending: orderDirection !== 'desc',
            }
            : undefined,
        limit: limitValue !== null ? parseInt(limitValue, 10) : undefined,
        offset: offsetValue !== null ? parseInt(offsetValue, 10) : undefined,
        upsert: upsertValue === 'true',
        onConflict: onConflict
            ? onConflict.split(',').map(column => column.trim()).filter(Boolean)
            : undefined,
    }
}
