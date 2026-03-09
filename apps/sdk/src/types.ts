import type {
    QueryFilter,
    RealtimeFilterExpression,
    StorageObjectPolicy,
    StorageRule,
    TransactionOperation,
    TransactionResult,
} from '@openbase/core'

export type { QueryFilter, StorageObjectPolicy, StorageRule, TransactionOperation, TransactionResult }

/** Result from any SDK operation */
export interface QueryResult<T = Record<string, unknown>> {
    data: T | T[] | null
    error: { message: string; code?: string } | null
    count?: number
}

/** Auth result */
export interface AuthResult {
    user: {
        id: string
        email: string
        role?: string
        metadata?: Record<string, unknown>
        identities?: Array<{
            provider: 'email' | 'google' | 'github'
            providerUserId: string
            email?: string
            linkedAt: string
        }>
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

/** Realtime payload */
export interface RealtimePayload<T = Record<string, unknown>> {
    schema: string
    table: string
    channel?: string
    commit_timestamp: string
    eventType: 'INSERT' | 'UPDATE' | 'DELETE' | '*'
    new: T | null
    old: T | null
}

export interface RealtimePostgresChangesFilter {
    event: 'INSERT' | 'UPDATE' | 'DELETE' | '*'
    schema?: string
    table?: string
    filter?: string
    filters?: RealtimeFilterExpression[]
}

export interface PresenceMeta {
    phx_ref: string
    user_id: string
    status: string
    timestamp: number
}

export interface PresenceState {
    [key: string]: {
        metas: PresenceMeta[]
    }
}

export interface PresenceEventPayload {
    channel: string
    event: 'sync' | 'join' | 'leave'
    userId?: string
    status?: string
    timestamp?: number
    state: PresenceState
}

/** Realtime subscription */
export interface RealtimeSubscription {
    unsubscribe: () => void
}

export interface UpsertOptions {
    onConflict?: string | string[]
}

export interface SelectOptions {
    count?: 'exact' | 'planned' | 'estimated'
    head?: boolean
}

export interface StorageObjectMetadataInput {
    tags?: Record<string, string>
    customMetadata?: Record<string, string>
}

export interface StorageObjectMetadata extends StorageObjectMetadataInput {
    contentType: string
    size: number
    createdAt: number
    updatedAt: number
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

/** Upload options */
export interface UploadOptions {
    contentType?: string
    upsert?: boolean
    resumable?: boolean
    chunkSize?: number
    metadata?: StorageObjectMetadataInput
    policy?: StorageObjectPolicy
}

/** Transform options */
export interface TransformOptions {
    width?: number
    height?: number
    format?: 'webp' | 'png' | 'jpeg' | 'avif'
    quality?: number
}
