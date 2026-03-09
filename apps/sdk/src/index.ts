/**
 * OpenBase JavaScript/TypeScript Client SDK
 *
 * Drop-in replacement for @supabase/supabase-js.
 * Works in both Node.js and browser environments.
 *
 * @example
 * ```typescript
 * import { createClient } from 'openbase-js'
 *
 * const openbase = createClient('https://your-project.openbase.dev', 'your-anon-key')
 *
 * // Database
 * const { data, error } = await openbase.from('posts').select('*').eq('published', true)
 *
 * // Auth
 * const { data: auth } = await openbase.auth.signInWithPassword({ email, password })
 *
 * // Storage
 * const { data: file } = await openbase.storage.from('avatars').upload('avatar.png', fileBlob)
 *
 * // Realtime
 * openbase.channel('posts').on('INSERT', 'posts', (payload) => { ... }).subscribe()
 * ```
 */

import type { TransactionOperation } from './types.js'
import { QueryBuilder } from './QueryBuilder.js'
import { OpenBaseAdminClient } from './AdminClient.js'
import { AuthClient } from './AuthClient.js'
import { StorageClient } from './StorageClient.js'
import { RealtimeClient, RealtimeChannel } from './RealtimeClient.js'
import { TransactionClient } from './TransactionClient.js'

export class OpenBaseClient {
    /** Authentication client */
    auth: AuthClient
    /** Storage client */
    storage: StorageClient
    /** Realtime client */
    realtime: RealtimeClient
    /** Transaction client */
    transactions: TransactionClient

    protected readonly projectUrl: string
    protected readonly apiKey: string
    protected readonly projectId: string

    constructor(projectUrl: string, anonKey: string) {
        // Normalize URL
        this.projectUrl = projectUrl.replace(/\/$/, '')
        this.apiKey = anonKey

        // Extract projectId from the JWT (anon key)
        this.projectId = this.extractProjectId(anonKey)

        // Initialize sub-clients
        this.auth = new AuthClient(this.projectUrl, this.projectId, this.apiKey)

        this.storage = new StorageClient(
            this.projectUrl,
            this.projectId,
            this.apiKey,
            () => this.auth.getAccessToken()
        )

        this.realtime = new RealtimeClient(
            this.projectUrl,
            this.projectId,
            () => this.auth.getAccessToken(),
            () => this.apiKey
        )

        this.transactions = new TransactionClient(
            this.projectUrl,
            this.projectId,
            this.apiKey,
            () => this.auth.getAccessToken()
        )
    }

    /**
     * Create a query builder for a table.
     * @param table - The table name to query
     */
    from<T = Record<string, unknown>>(table: string): QueryBuilder<T> {
        return new QueryBuilder<T>(table, this.projectUrl, this.apiKey, this.projectId, () => this.auth.getAccessToken())
    }

    /**
     * Create a realtime channel.
     * @param name - The channel name
     */
    channel(name: string): RealtimeChannel {
        return this.realtime.channel(name)
    }

    async transaction(operations: TransactionOperation[]) {
        return this.transactions.execute(operations)
    }

    /**
     * Extract projectId from the JWT anon key.
     */
    private extractProjectId(token: string): string {
        try {
            const parts = token.split('.')
            if (parts.length !== 3) return ''

            const payloadPart = parts[1]
                .replace(/-/g, '+')
                .replace(/_/g, '/')
                .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')

            const payload = JSON.parse(
                typeof atob !== 'undefined'
                    ? atob(payloadPart)
                    : Buffer.from(payloadPart, 'base64').toString('utf8')
            ) as { projectId?: string }

            return payload.projectId || ''
        } catch {
            return ''
        }
    }
}

/**
 * Create an OpenBase client instance.
 *
 * @param projectUrl - Your OpenBase project URL
 * @param anonKey - Your project's anonymous key
 * @returns An OpenBaseClient instance
 *
 * @example
 * ```typescript
 * const openbase = createClient(
 *   'https://your-project.openbase.dev',
 *   'your-anon-key'
 * )
 * ```
 */
export function createClient(projectUrl: string, anonKey: string): OpenBaseClient {
    return new OpenBaseClient(projectUrl, anonKey)
}

export function createAdminClient(projectUrl: string, serviceRoleKey: string): OpenBaseAdminClient {
    return new OpenBaseAdminClient(projectUrl, serviceRoleKey)
}

// Re-export types and sub-clients
export { QueryBuilder } from './QueryBuilder.js'
export { OpenBaseAdminClient } from './AdminClient.js'
export { AuthClient } from './AuthClient.js'
export { StorageClient } from './StorageClient.js'
export { RealtimeClient, RealtimeChannel } from './RealtimeClient.js'
export { TransactionClient } from './TransactionClient.js'
export { generateTypescriptSchemaClient } from './typegen.js'
export type {
    QueryResult,
    AuthResult,
    RealtimePayload,
    RealtimePostgresChangesFilter,
    RealtimeSubscription,
    QueryFilter,
    SelectOptions,
    PresenceMeta,
    PresenceState,
    PresenceEventPayload,
    StorageObjectMetadata,
    StorageObjectMetadataInput,
    StorageObjectRecord,
    StorageRule,
    StorageObjectPolicy,
    ResumableUploadSession,
    UploadOptions,
    TransformOptions,
    TransactionOperation,
    TransactionResult,
} from './types.js'
