/**
 * @openbase/core — Shared types for the OpenBase platform
 */

// ─── Storage Provider Types ──────────────────────────────────

/** Options for fetching multiple messages from a channel */
export interface GetMessagesOptions {
    limit?: number
    offsetId?: number
    minId?: number
    maxId?: number
}

/** A message retrieved from the storage provider */
export interface TelegramMessage {
    id: number
    text: string
    date: number
}

/** Persisted Telegram channel reference */
export interface TelegramChannelRef {
    id: string
    accessHash: string
}

/** Reference to a file stored in the storage provider */
export interface FileRef {
    messageId: number
    channel: TelegramChannelRef
    filename: string
    mimeType: string
    size: number
    chunks?: number[]
    parts?: FileRef[]
}

// ─── Schema Types ────────────────────────────────────────────

/** Column type options for table schemas */
export type ColumnType = 'text' | 'number' | 'boolean' | 'json' | 'timestamp' | 'uuid'

/** Definition of a single column in a table */
export interface ColumnDefinition {
    name: string
    type: ColumnType
    required?: boolean
    unique?: boolean
    default?: unknown
    encrypted?: boolean
}

/** Row Level Security policy */
export interface RLSPolicy {
    operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
    check: string
}

/** Schema definition for a single table */
export interface TableSchema {
    tableName: string
    columns: ColumnDefinition[]
    indexes: string[]
    rls?: RLSPolicy[]
}

export type MigrationSource = 'cli' | 'dashboard' | 'sdk'
export type MigrationDirection = 'up' | 'down'

export interface CreateTableMigrationOperation {
    type: 'create_table'
    table: TableSchema
}

export interface DropTableMigrationOperation {
    type: 'drop_table'
    tableName: string
}

export interface AddColumnMigrationOperation {
    type: 'add_column'
    tableName: string
    column: ColumnDefinition
    backfill?: {
        mode: 'default' | 'literal'
        value?: unknown
    }
}

export interface RemoveColumnMigrationOperation {
    type: 'remove_column'
    tableName: string
    columnName: string
}

export interface RenameColumnMigrationOperation {
    type: 'rename_column'
    tableName: string
    from: string
    to: string
}

export interface ChangeColumnTypeMigrationOperation {
    type: 'change_column_type'
    tableName: string
    columnName: string
    nextType: ColumnType
}

export interface AddIndexMigrationOperation {
    type: 'add_index'
    tableName: string
    columnName: string
}

export interface RemoveIndexMigrationOperation {
    type: 'remove_index'
    tableName: string
    columnName: string
}

export interface ReplaceRlsMigrationOperation {
    type: 'replace_rls'
    tableName: string
    rls?: RLSPolicy[]
}

export type MigrationOperation =
    | CreateTableMigrationOperation
    | DropTableMigrationOperation
    | AddColumnMigrationOperation
    | RemoveColumnMigrationOperation
    | RenameColumnMigrationOperation
    | ChangeColumnTypeMigrationOperation
    | AddIndexMigrationOperation
    | RemoveIndexMigrationOperation
    | ReplaceRlsMigrationOperation

export interface MigrationDefinition {
    name: string
    description?: string
    up: MigrationOperation[]
    down: MigrationOperation[]
}

export interface MigrationHistoryEntry {
    name: string
    description?: string
    checksum: string
    direction: MigrationDirection
    source: MigrationSource
    appliedAt: string
    operations: number
}

export interface SchemaExport {
    projectId: string
    projectName: string
    tables: Record<string, TableSchema>
    migrations: MigrationHistoryEntry[]
    appliedMigrations: string[]
}

// ─── Query Types ─────────────────────────────────────────────

/** Supported filter operators */
export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'is'

/** A single filter clause */
export interface QueryFilter {
    column: string
    operator: FilterOperator
    value: unknown
}

/** Full query options */
export interface QueryOptions {
    filters?: QueryFilter[]
    orderBy?: { column: string; ascending: boolean }
    limit?: number
    offset?: number
    select?: string[]
}

/** Result from a query execution */
export interface QueryResult<T = Record<string, unknown>> {
    data: T[] | null
    error: { message: string; code?: string } | null
    count?: number
}

// ─── Auth Types ──────────────────────────────────────────────

/** JWT payload structure */
export interface JWTPayload {
    sub?: string
    email?: string
    role: string
    projectId?: string
    type?: string
    iat?: number
    exp?: number
}

/** Result of an authentication operation */
export interface AuthResult {
    user: {
        id: string
        email: string
        role?: string
        metadata?: Record<string, unknown>
        identities?: UserIdentity[]
        totp_enabled?: boolean
    }
    session: {
        access_token: string
        refresh_token?: string
        expires_at?: number
    }
}

export interface UserIdentity {
    provider: 'email' | 'google' | 'github'
    providerUserId: string
    email?: string
    linkedAt: string
}

/** User record stored in the __users__ channel */
export interface UserRecord {
    id: string
    email: string
    password_hash: string
    created_at: string
    updated_at: string
    confirmed_at: string | null
    role: string
    metadata: Record<string, unknown>
    identities: UserIdentity[]
    refresh_token_version: number
    totp_secret_encrypted: string | null
    totp_enabled: boolean
    mfa_enrolled_at: string | null
}

// ─── Project Types ───────────────────────────────────────────

/** Project status */
export type ProjectStatus = 'warming_up' | 'active' | 'suspended' | 'warmup_failed'

export interface WebhookConfig {
    id: string
    url: string
    secret: string
    events: Array<'INSERT' | 'UPDATE' | 'DELETE'>
    enabled: boolean
    createdAt: string
    updatedAt: string
    lastDeliveryAt?: string | null
    lastSuccessAt?: string | null
    lastFailureAt?: string | null
    lastFailureReason?: string | null
    lastStatusCode?: number | null
    totalDeliveries?: number
    totalSuccesses?: number
    totalFailures?: number
    consecutiveFailures?: number
    lastReplayAt?: string | null
}

/** A project with all its configuration */
export interface Project {
    id: string
    name: string
    ownerId: string
    telegramSessionEncrypted: string
    channelMap: Record<string, TelegramChannelRef>
    archivedTableChannels?: Record<string, TelegramChannelRef>
    buckets: Record<string, TelegramChannelRef>
    bucketPolicies: Record<string, BucketPolicy>
    storageIndexChannel: TelegramChannelRef
    usersChannel: TelegramChannelRef
    schemaChannel: TelegramChannelRef
    commitLogChannel: TelegramChannelRef
    status: ProjectStatus
    warmupDaysRemaining?: number
    anonKey: string
    serviceRoleKey: string
    createdAt: string
}

// ─── Storage Types ───────────────────────────────────────────

/** Upload options for file storage */
export interface UploadOptions {
    mimeType?: string
    userId?: string
    upsert?: boolean
}

/** Image transform options */
export interface TransformOptions {
    width?: number
    height?: number
    format?: 'webp' | 'png' | 'jpeg' | 'avif'
    quality?: number
}

/** Bucket policy */
export interface BucketPermission {
    public?: boolean
    roles?: string[]
    userIds?: string[]
}

export interface BucketPolicy {
    public: boolean
    allowedMimeTypes?: string[]
    maxFileSize?: number
    read?: BucketPermission
    write?: BucketPermission
    delete?: BucketPermission
}

// ─── Realtime Types ──────────────────────────────────────────

/** Realtime event types */
export type RealtimeEventType = 'INSERT' | 'UPDATE' | 'DELETE' | '*'

/** Realtime payload sent to subscribers */
export interface RealtimePayload<T = Record<string, unknown>> {
    schema: string
    table: string
    commit_timestamp: string
    eventType: RealtimeEventType
    new: T | null
    old: T | null
}

/** Realtime subscription */
export interface RealtimeSubscription {
    unsubscribe: () => void
}

export interface ApiErrorPayload {
    message: string
    code: string
    details?: unknown
}

export interface ApiSuccessEnvelope<T> {
    data: T
    error: null
    meta?: Record<string, unknown>
}

export interface ApiErrorEnvelope {
    data: null
    error: ApiErrorPayload
    meta?: Record<string, unknown>
}

export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope

export interface RequestLogEntry {
    id: string
    method: string
    path: string
    projectId: string
    statusCode: number
    durationMs: number
    timestamp: string
}

export interface OperationLogEntry {
    id: string
    projectId: string | null
    scope: 'request' | 'webhook' | 'telegram' | 'system' | 'security'
    level: 'info' | 'success' | 'warning' | 'error'
    message: string
    code?: string
    metadata?: Record<string, unknown>
    timestamp: string
}

export interface WebhookDeadLetter {
    id: string
    projectId: string
    webhookId: string
    url: string
    eventType: 'INSERT' | 'UPDATE' | 'DELETE'
    failedAt: string
    errorMessage: string
    attempts: number
    statusCode?: number | null
    payload: Record<string, unknown>
}

export interface TelegramSessionHealth {
    projectId: string
    status: 'idle' | 'connecting' | 'healthy' | 'degraded' | 'reconnecting' | 'disconnected'
    connected: boolean
    lastConnectedAt: string | null
    lastCheckedAt: string | null
    lastError: string | null
    reconnectCount: number
    probeChannelId: string | null
}

// ─── Pending Operation (WAL) ─────────────────────────────────

/** Pending operation for the Write-Ahead Cache */
// ─── Encryption Types ────────────────────────────────────────

/** Result of an encryption operation */
export interface EncryptedData {
    ciphertext: string
    iv: string
    tag: string
}
