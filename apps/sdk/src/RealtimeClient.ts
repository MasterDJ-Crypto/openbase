import { io, type Socket } from 'socket.io-client'
import type {
    PresenceEventPayload,
    PresenceMeta,
    PresenceState,
    QueryFilter,
    RealtimePayload,
    RealtimePostgresChangesFilter,
    RealtimeSubscription,
} from './types.js'

type TableEventType = 'INSERT' | 'UPDATE' | 'DELETE' | '*'
type RealtimeHandlerMode = 'legacy' | 'postgres_changes'

interface SubscriptionDescriptor {
    id: string
    channel: string
    schema: string
    table: string
    eventType: TableEventType
    filters: QueryFilter[]
    callback: (payload: RealtimePayload) => void
    mode: RealtimeHandlerMode
}

interface BroadcastPayload {
    channel?: string
    event: string
    payload: unknown
}

interface PresenceRoomState {
    handlers: Set<(payload: PresenceEventPayload) => void>
    state: PresenceState
    joined: boolean
}

export class RealtimeClient {
    private socket: Socket | null = null
    private descriptors = new Map<string, SubscriptionDescriptor>()
    private broadcastHandlers = new Map<string, Set<(payload: BroadcastPayload) => void>>()
    private presenceRooms = new Map<string, PresenceRoomState>()

    constructor(
        private readonly projectUrl: string,
        private readonly projectId: string,
        private readonly getAccessToken: () => string | null,
        private readonly getApiKey: () => string
    ) { }

    channel(name: string): RealtimeChannel {
        return new RealtimeChannel(name, this)
    }

    connect(): void {
        if (this.socket) return

        this.socket = io(this.projectUrl, {
            path: '/realtime/v1',
            transports: ['websocket', 'polling'],
            autoConnect: true,
        })

        this.socket.on('connect', () => {
            const subscribed = new Set<string>()
            for (const descriptor of this.descriptors.values()) {
                const key = this.getDescriptorKey(descriptor)
                if (subscribed.has(key)) {
                    continue
                }

                subscribed.add(key)
                this.emitSubscribe(descriptor)
            }

            for (const channel of this.broadcastHandlers.keys()) {
                this.socket?.emit('join_broadcast', {
                    projectId: this.projectId,
                    channel,
                    token: this.getAuthToken(),
                })
            }

            for (const channel of this.presenceRooms.keys()) {
                this.emitJoinPresence(channel)
            }
        })

        this.socket.onAny((eventName, payload: RealtimePayload) => {
            if (!this.isRealtimeEvent(eventName)) return

            for (const descriptor of this.descriptors.values()) {
                if (descriptor.schema !== payload.schema) continue
                if (descriptor.table !== payload.table) continue
                if (descriptor.eventType !== '*' && descriptor.eventType !== eventName) continue
                if (payload.channel && payload.channel !== descriptor.channel) continue
                descriptor.callback(payload)
            }
        })

        this.socket.on('broadcast', (payload: BroadcastPayload) => {
            for (const [channel, handlers] of this.broadcastHandlers.entries()) {
                if (payload.channel && payload.channel !== channel) {
                    continue
                }

                for (const handler of handlers) {
                    handler(payload)
                }
            }
        })

        this.socket.on('presence_state', (payload: { channel: string; state: PresenceState }) => {
            const room = this.getPresenceRoom(payload.channel)
            if (!room) {
                return
            }

            room.state = clonePresenceState(payload.state)
            this.emitPresenceSync(payload.channel)
        })

        this.socket.on('presence_diff', (payload: {
            channel: string
            joins: PresenceState
            leaves: PresenceState
        }) => {
            const room = this.getPresenceRoom(payload.channel)
            if (!room) {
                return
            }

            const nextState = applyPresenceDiff(room.state, payload.joins, payload.leaves)
            room.state = nextState
            this.emitPresenceDiff(payload.channel, 'leave', payload.leaves, nextState)
            this.emitPresenceDiff(payload.channel, 'join', payload.joins, nextState)
        })
    }

    disconnect(): void {
        this.socket?.disconnect()
        this.socket = null
    }

    subscribeToTable(
        channel: string,
        schema: string,
        table: string,
        eventType: TableEventType,
        filters: QueryFilter[],
        callback: (payload: RealtimePayload) => void,
        mode: RealtimeHandlerMode = 'legacy'
    ): RealtimeSubscription {
        this.connect()

        const id = `${channel}:${table}:${eventType}:${Math.random().toString(36).slice(2)}`
        const descriptor: SubscriptionDescriptor = { id, channel, schema, table, eventType, filters, callback, mode }
        const shouldSubscribe = !this.hasMatchingDescriptor(descriptor)
        this.descriptors.set(id, descriptor)
        if (shouldSubscribe) {
            this.emitSubscribe(descriptor)
        }

        return {
            unsubscribe: () => {
                this.descriptors.delete(id)
                if (!this.hasMatchingDescriptor(descriptor)) {
                    this.socket?.emit('unsubscribe', {
                        projectId: this.projectId,
                        table,
                        event: eventType,
                    })
                }
            },
        }
    }

    subscribeToBroadcast(
        channel: string,
        callback: (payload: BroadcastPayload) => void
    ): RealtimeSubscription {
        this.connect()

        const handlers = this.broadcastHandlers.get(channel) || new Set()
        handlers.add(callback)
        this.broadcastHandlers.set(channel, handlers)

        if (this.socket?.connected) {
            this.socket.emit('join_broadcast', {
                projectId: this.projectId,
                channel,
                token: this.getAuthToken(),
            })
        } else {
            this.socket?.once('connect', () => {
                this.socket?.emit('join_broadcast', {
                    projectId: this.projectId,
                    channel,
                    token: this.getAuthToken(),
                })
            })
        }

        return {
            unsubscribe: () => {
                const current = this.broadcastHandlers.get(channel)
                current?.delete(callback)
                if (current && current.size === 0) {
                    this.broadcastHandlers.delete(channel)
                }
            },
        }
    }

    subscribeToPresence(
        channel: string,
        callback: (payload: PresenceEventPayload) => void
    ): RealtimeSubscription {
        this.connect()

        const room = this.getOrCreatePresenceRoom(channel)
        room.handlers.add(callback)

        if (this.socket?.connected && !room.joined) {
            this.emitJoinPresence(channel)
        } else if (!room.joined) {
            this.socket?.once('connect', () => {
                this.emitJoinPresence(channel)
            })
        }

        return {
            unsubscribe: () => {
                const current = this.presenceRooms.get(channel)
                current?.handlers.delete(callback)
                if (current && current.handlers.size === 0) {
                    current.joined = false
                    this.presenceRooms.delete(channel)
                    this.socket?.emit('leave_presence', {
                        projectId: this.projectId,
                        channel,
                        token: this.getAuthToken(),
                    })
                }
            },
        }
    }

    sendBroadcast(channel: string, event: string, payload: unknown): void {
        this.connect()
        this.socket?.emit('broadcast', {
            projectId: this.projectId,
            channel,
            event,
            payload,
            token: this.getAuthToken(),
        })
    }

    trackPresence(channel: string, userId: string, status: string): void {
        this.connect()
        this.socket?.emit('presence', {
            projectId: this.projectId,
            channel,
            userId,
            status,
            token: this.getAuthToken(),
        })
    }

    private emitSubscribe(descriptor: SubscriptionDescriptor): void {
        if (!this.socket?.connected) return

        this.socket.emit('subscribe', {
            channel: descriptor.channel,
            projectId: this.projectId,
            table: descriptor.table,
            event: descriptor.eventType,
            filter: descriptor.filters.length > 0 ? serializeRealtimeFilters(descriptor.filters) : undefined,
            token: this.getAuthToken(),
        })
    }

    private emitJoinPresence(channel: string): void {
        const room = this.getPresenceRoom(channel)
        if (!room) {
            return
        }

        room.joined = true
        this.socket?.emit('join_presence', {
            projectId: this.projectId,
            channel,
            token: this.getAuthToken(),
        })
    }

    private emitPresenceSync(channel: string): void {
        const room = this.getPresenceRoom(channel)
        if (!room) {
            return
        }

        const snapshot = clonePresenceState(room.state)
        const handlers = [...room.handlers]

        const payload: PresenceEventPayload = {
            channel,
            event: 'sync',
            state: snapshot,
        }
        for (const handler of handlers) {
            handler(payload)
        }
    }

    private emitPresenceDiff(
        channel: string,
        event: 'join' | 'leave',
        diff: PresenceState,
        nextState: PresenceState
    ): void {
        const room = this.getPresenceRoom(channel)
        if (!room || Object.keys(diff).length === 0) {
            return
        }

        const handlers = [...room.handlers]
        const snapshot = clonePresenceState(nextState)

        for (const meta of flattenPresenceState(diff)) {
            const payload: PresenceEventPayload = {
                channel,
                event,
                userId: meta.user_id,
                status: meta.status,
                timestamp: meta.timestamp,
                state: snapshot,
            }

            for (const handler of handlers) {
                handler(payload)
            }
        }
    }

    private getOrCreatePresenceRoom(channel: string): PresenceRoomState {
        const existing = this.presenceRooms.get(channel)
        if (existing) {
            return existing
        }

        const created: PresenceRoomState = {
            handlers: new Set(),
            state: {},
            joined: false,
        }
        this.presenceRooms.set(channel, created)
        return created
    }

    private getPresenceRoom(channel: string): PresenceRoomState | undefined {
        return this.presenceRooms.get(channel)
    }

    private getAuthToken(): string {
        return this.getAccessToken() || this.getApiKey()
    }

    private hasMatchingDescriptor(descriptor: Pick<SubscriptionDescriptor, 'channel' | 'schema' | 'table' | 'eventType' | 'filters' | 'id'>): boolean {
        for (const current of this.descriptors.values()) {
            if (current.id === descriptor.id) {
                continue
            }

            if (this.getDescriptorKey(current) === this.getDescriptorKey(descriptor)) {
                return true
            }
        }

        return false
    }

    private getDescriptorKey(descriptor: Pick<SubscriptionDescriptor, 'channel' | 'schema' | 'table' | 'eventType' | 'filters'>): string {
        return [
            descriptor.channel,
            descriptor.schema,
            descriptor.table,
            descriptor.eventType,
            serializeRealtimeFilters(descriptor.filters),
        ].join(':')
    }

    private isRealtimeEvent(eventName: string): eventName is TableEventType {
        return eventName === 'INSERT'
            || eventName === 'UPDATE'
            || eventName === 'DELETE'
            || eventName === '*'
    }
}

export class RealtimeChannel {
    private handlers: Array<{
        schema: string
        table: string
        eventType: TableEventType
        filters: QueryFilter[]
        callback: (payload: RealtimePayload) => void
        mode: RealtimeHandlerMode
    }> = []
    private broadcastCallbacks: Array<(payload: BroadcastPayload) => void> = []
    private presenceCallbacks: Array<(payload: PresenceEventPayload) => void> = []

    constructor(
        private readonly name: string,
        private readonly client: RealtimeClient
    ) { }

    on(
        eventType: TableEventType,
        filter: { event: string; schema?: string; table?: string; filter?: string; filters?: QueryFilter[] } | string,
        callback: (payload: RealtimePayload) => void
    ): this
    on(
        eventType: 'postgres_changes',
        filter: RealtimePostgresChangesFilter,
        callback: (payload: RealtimePayload) => void
    ): this
    on(
        eventType: TableEventType | 'postgres_changes',
        filter: { event: string; schema?: string; table?: string; filter?: string; filters?: QueryFilter[] } | RealtimePostgresChangesFilter | string,
        callback: (payload: RealtimePayload) => void
    ): this {
        if (eventType === 'postgres_changes') {
            const postgresFilter = filter as RealtimePostgresChangesFilter
            const table = postgresFilter.table || this.name
            const postgresEvent = postgresFilter.event || '*'
            this.handlers.push({
                schema: postgresFilter.schema || 'public',
                table,
                eventType: postgresEvent,
                filters: postgresFilter.filters || parseFilterString(postgresFilter.filter),
                callback,
                mode: 'postgres_changes',
            })
            return this
        }

        const parsedFilter = typeof filter === 'string'
            ? { table: filter, schema: 'public', filters: [] as QueryFilter[] }
            : {
                table: filter.table || this.name,
                schema: filter.schema || 'public',
                filters: filter.filters || parseFilterString(filter.filter),
            }
        this.handlers.push({
            schema: parsedFilter.schema,
            table: parsedFilter.table,
            eventType,
            filters: parsedFilter.filters,
            callback,
            mode: 'legacy',
        })
        return this
    }

    onBroadcast(callback: (payload: BroadcastPayload) => void): this {
        this.broadcastCallbacks.push(callback)
        return this
    }

    onPresence(callback: (payload: PresenceEventPayload) => void): this {
        this.presenceCallbacks.push(callback)
        return this
    }

    subscribe(): RealtimeSubscription {
        const subscriptions = this.handlers.map(handler =>
            this.client.subscribeToTable(this.name, handler.schema, handler.table, handler.eventType, handler.filters, handler.callback, handler.mode)
        )
        const broadcastSubscriptions = this.broadcastCallbacks.map(callback =>
            this.client.subscribeToBroadcast(this.name, callback)
        )
        const presenceSubscriptions = this.presenceCallbacks.map(callback =>
            this.client.subscribeToPresence(this.name, callback)
        )

        return {
            unsubscribe: () => {
                subscriptions.forEach(subscription => subscription.unsubscribe())
                broadcastSubscriptions.forEach(subscription => subscription.unsubscribe())
                presenceSubscriptions.forEach(subscription => subscription.unsubscribe())
            },
        }
    }

    send(event: string, payload: unknown): this {
        this.client.sendBroadcast(this.name, event, payload)
        return this
    }

    track(userId: string, status: string): this {
        this.client.trackPresence(this.name, userId, status)
        return this
    }
}

function applyPresenceDiff(
    current: PresenceState,
    joins: PresenceState,
    leaves: PresenceState
): PresenceState {
    const next = clonePresenceState(current)

    for (const [key, entry] of Object.entries(leaves)) {
        const existing = next[key]?.metas ?? []
        const remaining = existing.filter(meta =>
            !entry.metas.some(removed => removed.phx_ref === meta.phx_ref)
        )

        if (remaining.length > 0) {
            next[key] = { metas: remaining }
        } else {
            delete next[key]
        }
    }

    for (const [key, entry] of Object.entries(joins)) {
        const existing = next[key]?.metas ?? []
        next[key] = {
            metas: [...existing, ...entry.metas],
        }
    }

    return next
}

function flattenPresenceState(state: PresenceState): PresenceMeta[] {
    return Object.values(state).flatMap(entry => entry.metas)
}

function clonePresenceState(state: PresenceState): PresenceState {
    return Object.fromEntries(
        Object.entries(state).map(([key, entry]) => [
            key,
            {
                metas: entry.metas.map(meta => ({ ...meta })),
            },
        ])
    )
}

function parseFilterString(filter: string | undefined): QueryFilter[] {
    if (!filter) {
        return []
    }

    const normalized = filter.startsWith('?') ? filter.slice(1) : filter
    const params = new URLSearchParams(normalized)
    return [...params.entries()].map(([column, encoded]) => {
        const dotIndex = encoded.indexOf('.')
        const operator = encoded.slice(0, dotIndex)
        const rawValue = encoded.slice(dotIndex + 1)
        return {
            column,
            operator,
            value: parseFilterValue(rawValue),
        } as QueryFilter
    })
}

function parseFilterValue(rawValue: string): unknown {
    if (rawValue === 'null') return null
    if (rawValue === 'true') return true
    if (rawValue === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
        return Number(rawValue)
    }
    return rawValue
}

function serializeRealtimeFilters(filters: QueryFilter[]): string {
    const params = new URLSearchParams()
    for (const filter of filters) {
        const value = Array.isArray(filter.value)
            ? `(${filter.value.join(',')})`
            : filter.value === null
                ? 'null'
                : String(filter.value)
        params.append(filter.column, `${filter.operator}.${value}`)
    }
    return params.toString()
}
