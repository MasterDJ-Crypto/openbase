import { z } from 'zod'

export const telegramChannelRefSchema = z.object({
    id: z.string(),
    accessHash: z.string(),
})

export const userIdentitySchema = z.object({
    provider: z.enum(['email', 'google', 'github']),
    providerUserId: z.string(),
    email: z.string().optional(),
    linkedAt: z.string(),
})

export const authUserSchema = z.object({
    id: z.string(),
    email: z.string().email(),
    role: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    identities: z.array(userIdentitySchema).optional(),
    totp_enabled: z.boolean().optional(),
})

export const authSessionSchema = z.object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    expires_at: z.number().optional(),
})

export const authResultSchema = z.object({
    user: authUserSchema,
    session: authSessionSchema,
})

export const bucketPermissionSchema = z.object({
    public: z.boolean().optional(),
    roles: z.array(z.string()).optional(),
    userIds: z.array(z.string()).optional(),
})

export const bucketPolicySchema = z.object({
    public: z.boolean(),
    allowedMimeTypes: z.array(z.string()).optional(),
    maxFileSize: z.number().optional(),
    read: bucketPermissionSchema.optional(),
    write: bucketPermissionSchema.optional(),
    delete: bucketPermissionSchema.optional(),
})

export const webhookConfigSchema = z.object({
    id: z.string(),
    url: z.string().url(),
    secret: z.string(),
    events: z.array(z.enum(['INSERT', 'UPDATE', 'DELETE'])),
    enabled: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastDeliveryAt: z.string().nullable().optional(),
    lastSuccessAt: z.string().nullable().optional(),
    lastFailureAt: z.string().nullable().optional(),
    lastFailureReason: z.string().nullable().optional(),
    lastStatusCode: z.number().nullable().optional(),
    totalDeliveries: z.number().optional(),
    totalSuccesses: z.number().optional(),
    totalFailures: z.number().optional(),
    consecutiveFailures: z.number().optional(),
    lastReplayAt: z.string().nullable().optional(),
})

export const requestLogEntrySchema = z.object({
    id: z.string(),
    method: z.string(),
    path: z.string(),
    projectId: z.string(),
    statusCode: z.number(),
    durationMs: z.number(),
    timestamp: z.string(),
})

export const operationLogEntrySchema = z.object({
    id: z.string(),
    projectId: z.string().nullable(),
    scope: z.enum(['request', 'webhook', 'telegram', 'system', 'security']),
    level: z.enum(['info', 'success', 'warning', 'error']),
    message: z.string(),
    code: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    timestamp: z.string(),
})

export const webhookDeadLetterSchema = z.object({
    id: z.string(),
    projectId: z.string(),
    webhookId: z.string(),
    url: z.string().url(),
    eventType: z.enum(['INSERT', 'UPDATE', 'DELETE']),
    failedAt: z.string(),
    errorMessage: z.string(),
    attempts: z.number(),
    statusCode: z.number().nullable().optional(),
    payload: z.record(z.unknown()),
})

export const telegramSessionHealthSchema = z.object({
    projectId: z.string(),
    status: z.enum(['idle', 'connecting', 'healthy', 'degraded', 'reconnecting', 'disconnected']),
    connected: z.boolean(),
    lastConnectedAt: z.string().nullable(),
    lastCheckedAt: z.string().nullable(),
    lastError: z.string().nullable(),
    reconnectCount: z.number(),
    probeChannelId: z.string().nullable(),
})

export const columnDefinitionSchema = z.object({
    name: z.string(),
    type: z.enum(['text', 'number', 'boolean', 'json', 'timestamp', 'uuid']),
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
    default: z.unknown().optional(),
    encrypted: z.boolean().optional(),
})

export const rlsPolicySchema = z.object({
    operation: z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
    check: z.string(),
})

export const tableSchemaSchema = z.object({
    tableName: z.string(),
    columns: z.array(columnDefinitionSchema),
    indexes: z.array(z.string()),
    rls: z.array(rlsPolicySchema).optional(),
})

export const migrationOperationSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('create_table'),
        table: tableSchemaSchema,
    }),
    z.object({
        type: z.literal('drop_table'),
        tableName: z.string(),
    }),
    z.object({
        type: z.literal('add_column'),
        tableName: z.string(),
        column: columnDefinitionSchema,
        backfill: z.object({
            mode: z.enum(['default', 'literal']),
            value: z.unknown().optional(),
        }).optional(),
    }),
    z.object({
        type: z.literal('remove_column'),
        tableName: z.string(),
        columnName: z.string(),
    }),
    z.object({
        type: z.literal('rename_column'),
        tableName: z.string(),
        from: z.string(),
        to: z.string(),
    }),
    z.object({
        type: z.literal('change_column_type'),
        tableName: z.string(),
        columnName: z.string(),
        nextType: z.enum(['text', 'number', 'boolean', 'json', 'timestamp', 'uuid']),
    }),
    z.object({
        type: z.literal('add_index'),
        tableName: z.string(),
        columnName: z.string(),
    }),
    z.object({
        type: z.literal('remove_index'),
        tableName: z.string(),
        columnName: z.string(),
    }),
    z.object({
        type: z.literal('replace_rls'),
        tableName: z.string(),
        rls: z.array(rlsPolicySchema).optional(),
    }),
])

export const migrationDefinitionSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    up: z.array(migrationOperationSchema),
    down: z.array(migrationOperationSchema),
})

export const migrationHistoryEntrySchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    checksum: z.string(),
    direction: z.enum(['up', 'down']),
    source: z.enum(['cli', 'dashboard', 'sdk']),
    appliedAt: z.string(),
    operations: z.number(),
})

export const schemaExportSchema = z.object({
    projectId: z.string(),
    projectName: z.string(),
    tables: z.record(tableSchemaSchema),
    migrations: z.array(migrationHistoryEntrySchema),
    appliedMigrations: z.array(z.string()),
})

export const apiErrorPayloadSchema = z.object({
    message: z.string(),
    code: z.string(),
    details: z.unknown().optional(),
})

export function apiSuccessEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
    return z.object({
        data: dataSchema,
        error: z.null(),
        meta: z.record(z.unknown()).optional(),
    })
}

export function apiErrorEnvelopeSchema() {
    return z.object({
        data: z.null(),
        error: apiErrorPayloadSchema,
        meta: z.record(z.unknown()).optional(),
    })
}

export function apiEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
    return z.union([
        apiSuccessEnvelopeSchema(dataSchema),
        apiErrorEnvelopeSchema(),
    ])
}
