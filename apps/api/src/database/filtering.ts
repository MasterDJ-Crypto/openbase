import type { FilterOperator, QueryFilter } from '@openbase/core'

export function applyQueryFilters(row: Record<string, unknown>, filters: QueryFilter[]): boolean {
    return filters.every(filter => {
        const value = row[filter.column]
        switch (filter.operator) {
            case 'eq':
                return value === filter.value
            case 'neq':
                return value !== filter.value
            case 'gt':
                return toComparable(value) > toComparable(filter.value)
            case 'gte':
                return toComparable(value) >= toComparable(filter.value)
            case 'lt':
                return toComparable(value) < toComparable(filter.value)
            case 'lte':
                return toComparable(value) <= toComparable(filter.value)
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

export function parseFilterValue(operator: FilterOperator, rawValue: string): unknown {
    if (operator === 'in') {
        return rawValue
            .replace(/^\(/, '')
            .replace(/\)$/, '')
            .split(',')
            .filter(Boolean)
            .map(item => parseScalarValue(item))
    }

    if (operator === 'is') {
        if (rawValue === 'null') return null
        if (rawValue === 'true') return true
        if (rawValue === 'false') return false
    }

    return parseScalarValue(rawValue)
}

export function parseRealtimeFilterExpression(expression: string): QueryFilter[] {
    const normalized = expression.startsWith('?') ? expression.slice(1) : expression
    const params = new URLSearchParams(normalized)
    const filters: QueryFilter[] = []

    for (const [column, encoded] of params.entries()) {
        const dotIndex = encoded.indexOf('.')
        if (dotIndex === -1) {
            continue
        }

        const operator = encoded.slice(0, dotIndex) as FilterOperator
        const rawValue = encoded.slice(dotIndex + 1)
        filters.push({
            column,
            operator,
            value: parseFilterValue(operator, rawValue),
        })
    }

    return filters
}

function parseScalarValue(rawValue: string): unknown {
    if (rawValue === 'null') return null
    if (rawValue === 'true') return true
    if (rawValue === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
        return Number(rawValue)
    }
    return rawValue
}

function toComparable(value: unknown): string | number | boolean {
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
