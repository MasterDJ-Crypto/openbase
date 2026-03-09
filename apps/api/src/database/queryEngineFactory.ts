import type { TableSchema } from '@openbase/core'
import type { StorageProvider } from '@openbase/telegram'
import type { EncryptionService } from '../encryption/EncryptionService.js'
import { QueryEngine } from './QueryEngine.js'
import type { IndexManager } from './IndexManager.js'

export function buildProjectQueryEngine(
    provider: StorageProvider,
    indexManager: IndexManager,
    schema: TableSchema,
    encryptionService: EncryptionService,
    masterKey: Buffer
): QueryEngine {
    const encryptedColumns = new Set(
        schema.columns.filter(column => column.encrypted).map(column => column.name)
    )
    const indexableSchema: TableSchema = {
        ...schema,
        indexes: schema.indexes.filter(column => !encryptedColumns.has(column)),
    }

    return new QueryEngine(
        provider,
        indexManager,
        indexableSchema,
        {
            encodeValue: (columnName, value) => {
                if (!encryptedColumns.has(columnName) || value === null || value === undefined) {
                    return value
                }

                const isString = typeof value === 'string'
                const plaintext = isString ? value : JSON.stringify(value)
                return {
                    __encrypted: true,
                    kind: isString ? 'text' : 'json',
                    value: encryptionService.encryptToString(plaintext, masterKey),
                }
            },
            decodeValue: (columnName, value) => {
                if (!encryptedColumns.has(columnName) || !value || typeof value !== 'object') {
                    return value
                }

                const encrypted = value as { __encrypted?: boolean; kind?: 'text' | 'json'; value?: string }
                if (!encrypted.__encrypted || !encrypted.value) {
                    return value
                }

                const plaintext = encryptionService.decryptFromString(encrypted.value, masterKey)
                return encrypted.kind === 'json' ? JSON.parse(plaintext) : plaintext
            },
        }
    )
}
