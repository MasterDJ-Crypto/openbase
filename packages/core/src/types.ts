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

export interface TransactionOperationCondition {
    filters?: QueryFilter[]
    ifMatchMessageIds?: number[]
    expectedCount?: number
}

export interface TransactionInsertOperation {
    type: 'insert'
    table: string
    values: Record<string, unknown>[]
}

export interface TransactionUpsertOperation {
    type: 'upsert'
    table: string
    values: Record<string, unknown>[]
    onConflict?: string[]
    condition?: TransactionOperationCondition
}

export interface TransactionUpdateOperation {
    type: 'update'
    table: string
    patch: Record<string, unknown>
    condition?: TransactionOperationCondition
}

export interface TransactionDeleteOperation {
    type: 'delete'
    table: string
    condition?: TransactionOperationCondition
}

export type TransactionOperation =
    | TransactionInsertOperation
    | TransactionUpsertOperation
    | TransactionUpdateOperation
    | TransactionDeleteOperation

export interface TransactionOperationResult {
    type: TransactionOperation['type']
    table: string
    count: number
    data: Record<string, unknown>[] | null
}

export interface TransactionResult {
    id: string
    projectId: string
    committedAt: string
    operations: TransactionOperationResult[]
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
        confirmed_at?: string | null
        disabled_at?: string | null
        disabled_reason?: string | null
        last_sign_in_at?: string | null
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
    email_confirmation_sent_at?: string | null
    role: string
    metadata: Record<string, unknown>
    identities: UserIdentity[]
    refresh_token_version: number
    totp_secret_encrypted: string | null
    totp_enabled: boolean
    mfa_enrolled_at: string | null
    disabled_at?: string | null
    disabled_reason?: string | null
    last_sign_in_at?: string | null
    last_password_reset_at?: string | null
    last_session_revoked_at?: string | null
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
export type ProjectPermission =
    | 'project.read'
    | 'project.delete'
    | 'tables.read'
    | 'tables.write'
    | 'tables.manage'
    | 'storage.read'
    | 'storage.write'
    | 'storage.manage'
    | 'auth.read'
    | 'auth.manage'
    | 'webhooks.read'
    | 'webhooks.manage'
    | 'migrations.read'
    | 'migrations.manage'
    | 'logs.read'
    | 'audit.read'
    | 'settings.read'
    | 'settings.manage'
    | 'members.read'
    | 'members.manage'
    | 'roles.read'
    | 'roles.manage'

export interface ProjectRoleDefinition {
    key: string
    name: string
    description?: string
    permissions: ProjectPermission[]
    system?: boolean
}

export interface ProjectMember {
    userId: string
    email: string
    roleKey: string
    addedAt: string
    addedBy: string
}

export interface ProjectInvitation {
    id: string
    token: string
    projectId: string
    email: string
    roleKey: string
    invitedBy: string
    createdAt: string
    expiresAt: string
    acceptedAt?: string | null
    revokedAt?: string | null
}

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
    roles?: Record<string, ProjectRoleDefinition>
    members?: Record<string, ProjectMember>
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
    metadata?: {
        tags?: Record<string, string>
        customMetadata?: Record<string, string>
    }
    policy?: StorageObjectPolicy
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

export type StorageAction = 'read' | 'write' | 'delete'

export interface StorageRule {
    effect: 'allow' | 'deny'
    actions: StorageAction[]
    expression: string
}

export interface StorageObjectPolicy {
    public?: boolean
    read?: BucketPermission
    write?: BucketPermission
    delete?: BucketPermission
    rules?: StorageRule[]
}

export interface StorageObjectMetadata {
    contentType: string
    size: number
    createdAt: number
    updatedAt: number
    tags?: Record<string, string>
    customMetadata?: Record<string, string>
}

export interface StorageObjectRecord {
    path: string
    size: number
    mimeType: string
    createdAt: number
    updatedAt: number
    uploadedBy: string | null
    metadata: StorageObjectMetadata
    policy?: StorageObjectPolicy | null
}

export interface ResumableUploadSession {
    id: string
    projectId: string
    bucket: string
    path: string
    uploadUrl: string
    statusUrl: string
    completeUrl: string
    chunkSize: number
    uploadedBytes: number
    totalSize?: number
    expiresAt: string
    createdAt: string
    completed: boolean
}

export interface BucketPolicy {
    public: boolean
    allowedMimeTypes?: string[]
    maxFileSize?: number
    read?: BucketPermission
    write?: BucketPermission
    delete?: BucketPermission
    rules?: StorageRule[]
}

// ─── Realtime Types ──────────────────────────────────────────

/** Realtime event types */
export type RealtimeEventType = 'INSERT' | 'UPDATE' | 'DELETE' | '*'

export interface RealtimeFilterExpression {
    column: string
    operator: FilterOperator
    value: unknown
}

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

export interface RealtimePostgresChangesFilter {
    event: RealtimeEventType
    schema?: string
    table?: string
    filter?: string
    filters?: RealtimeFilterExpression[]
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
