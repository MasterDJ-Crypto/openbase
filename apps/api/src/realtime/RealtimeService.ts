import type { Server as HttpServer } from 'http'
import type {
    JWTPayload,
    QueryFilter,
    RealtimeFilterExpression,
    RealtimePayload,
    RLSPolicy,
} from '@openbase/core'
import { Server, Socket } from 'socket.io'
import jwt from 'jsonwebtoken'
import type { ProjectAccessService } from '../access/ProjectAccessService.js'
import type { AuthService } from '../auth/AuthService.js'
import { applyQueryFilters, parseRealtimeFilterExpression } from '../database/index.js'
import { checkRLSForRow, findPolicy } from '../middleware/rls.js'
import type { ProjectService } from '../projects/ProjectService.js'

interface RealtimeOptions {
    allowedOrigins?: Set<string>
}

type TableEventType = 'INSERT' | 'UPDATE' | 'DELETE' | '*'

interface SubscribePayload {
    channel?: string
    projectId: string
    table: string
    event: TableEventType
    token?: string
    filter?: string
    filters?: RealtimeFilterExpression[]
}

interface TableSubscription {
    room: string
    channel: string
    projectId: string
    table: string
    eventType: TableEventType
    filters: QueryFilter[]
    user: JWTPayload
    selectPolicy?: RLSPolicy
    bypassRLS: boolean
}

interface PresenceMeta {
    phx_ref: string
    user_id: string
    status: string
    timestamp: number
}

type PresenceState = Record<string, { metas: PresenceMeta[] }>

export class RealtimeService {
    private readonly io: Server
    private readonly subscriptions = new Map<string, Map<string, TableSubscription>>()
    private readonly presenceRooms = new Map<string, Map<string, Map<string, PresenceMeta>>>()
    private readonly socketPresenceRooms = new Map<string, Set<string>>()

    constructor(
        httpServer: HttpServer,
        private readonly jwtSecret: string,
        private readonly projectService: ProjectService,
        private readonly projectAccessService: ProjectAccessService,
        private readonly authService: AuthService,
        options: RealtimeOptions = {}
    ) {
        this.io = new Server(httpServer, {
            path: '/realtime/v1',
            cors: {
                origin: (origin, callback) => {
                    if (!origin || !options.allowedOrigins || options.allowedOrigins.has(origin)) {
                        callback(null, true)
                        return
                    }

                    callback(null, false)
                },
                methods: ['GET', 'POST'],
                credentials: true,
            },
        })

        this.setupConnectionHandler()
    }

    registerProject(_projectId: string, _channelMap: Record<string, string>): void {
        // The realtime bridge still invokes this to mark project availability.
    }

    broadcastChange(
        projectId: string,
        tableName: string,
        eventType: 'INSERT' | 'UPDATE' | 'DELETE',
        newRow: Record<string, unknown> | null,
        oldRow: Record<string, unknown> | null
    ): void {
        const payload: RealtimePayload = {
            schema: 'public',
            table: tableName,
            commit_timestamp: new Date().toISOString(),
            eventType,
            new: newRow,
            old: oldRow,
        }

        this.emitTableEvent(this.getTableRoom(projectId, tableName, eventType), eventType, payload, newRow, oldRow)
        this.emitTableEvent(this.getTableRoom(projectId, tableName, '*'), '*', payload, newRow, oldRow)
    }

    getIO(): Server {
        return this.io
    }

    private setupConnectionHandler(): void {
        this.io.on('connection', (socket: Socket) => {
            socket.on('subscribe', async (data: SubscribePayload) => {
                const auth = await this.authorizeTableSubscription(data)
                if (!auth) {
                    socket.emit('error', { message: 'Invalid token or insufficient access' })
                    return
                }

                const room = this.getTableRoom(data.projectId, data.table, data.event)
                socket.join(room)
                this.storeSubscription(socket.id, {
                    room,
                    channel: data.channel || `${data.projectId}:${data.table}`,
                    projectId: data.projectId,
                    table: data.table,
                    eventType: data.event,
                    filters: auth.filters,
                    user: auth.user,
                    selectPolicy: auth.selectPolicy,
                    bypassRLS: auth.bypassRLS,
                })
                socket.emit('subscribed', { room, channel: data.channel || `${data.projectId}:${data.table}` })
            })

            socket.on('unsubscribe', (data: { projectId: string; table: string; event?: TableEventType }) => {
                if (data.event) {
                    const room = this.getTableRoom(data.projectId, data.table, data.event)
                    this.removeSubscription(socket.id, room)
                    socket.leave(room)
                    return
                }

                for (const eventType of ['INSERT', 'UPDATE', 'DELETE', '*'] as const) {
                    const room = this.getTableRoom(data.projectId, data.table, eventType)
                    this.removeSubscription(socket.id, room)
                    socket.leave(room)
                }
            })

            socket.on('join_presence', async (data: { projectId: string; channel: string; token?: string }) => {
                const payload = await this.verifyProjectToken(data.projectId, data.token, 'project.read')
                if (!payload) {
                    socket.emit('error', { message: 'Invalid token' })
                    return
                }

                const room = this.getPresenceRoom(data.projectId, data.channel)
                socket.join(room)
                this.recordSocketPresenceRoom(socket.id, room)
                socket.emit('presence_state', {
                    channel: data.channel,
                    state: this.serializePresenceRoom(room),
                })
                socket.data.presenceUser = payload.sub
            })

            socket.on('leave_presence', async (data: { projectId: string; channel: string; token?: string }) => {
                const payload = await this.verifyProjectToken(data.projectId, data.token, 'project.read')
                if (!payload) {
                    socket.emit('error', { message: 'Invalid token' })
                    return
                }

                const room = this.getPresenceRoom(data.projectId, data.channel)
                this.removeSocketPresenceFromRoom(socket.id, room, data.channel)
                socket.leave(room)
                this.removeSocketPresenceRoom(socket.id, room)
            })

            socket.on('presence', async (data: {
                projectId: string
                channel: string
                userId: string
                status: string
                token?: string
            }) => {
                const payload = await this.verifyProjectToken(data.projectId, data.token, 'project.read')
                if (!payload) {
                    socket.emit('error', { message: 'Invalid token' })
                    return
                }

                const room = this.getPresenceRoom(data.projectId, data.channel)
                socket.join(room)
                this.recordSocketPresenceRoom(socket.id, room)

                const nextMeta: PresenceMeta = {
                    phx_ref: `${socket.id}:${data.channel}:${Date.now()}`,
                    user_id: data.userId,
                    status: data.status,
                    timestamp: Date.now(),
                }

                const diff = this.upsertPresence(room, socket.id, data.userId, nextMeta)
                this.io.to(room).emit('presence_diff', {
                    channel: data.channel,
                    ...diff,
                })
                socket.data.presenceUser = payload.sub
            })

            socket.on('broadcast', async (data: {
                projectId: string
                channel: string
                event: string
                payload: unknown
                token?: string
            }) => {
                const payload = await this.verifyProjectToken(data.projectId, data.token, 'project.read')
                if (!payload) {
                    socket.emit('error', { message: 'Invalid token' })
                    return
                }

                socket
                    .to(`project:${data.projectId}:broadcast:${data.channel}`)
                    .emit('broadcast', {
                        channel: data.channel,
                        event: data.event,
                        payload: data.payload,
                        actor: payload.sub,
                    })
            })

            socket.on('join_broadcast', async (data: { projectId: string; channel: string; token?: string }) => {
                const payload = await this.verifyProjectToken(data.projectId, data.token, 'project.read')
                if (!payload) {
                    socket.emit('error', { message: 'Invalid token' })
                    return
                }

                socket.join(`project:${data.projectId}:broadcast:${data.channel}`)
                socket.data.broadcastUser = payload.sub
            })

            socket.on('disconnect', () => {
                this.cleanupSocketPresence(socket.id)
                this.subscriptions.delete(socket.id)
            })
        })
    }

    private emitTableEvent(
        room: string,
        eventName: 'INSERT' | 'UPDATE' | 'DELETE' | '*',
        payload: RealtimePayload,
        newRow: Record<string, unknown> | null,
        oldRow: Record<string, unknown> | null
    ): void {
        const socketIds = this.io.sockets.adapter.rooms.get(room)
        if (!socketIds) {
            return
        }

        for (const socketId of socketIds) {
            const socket = this.io.sockets.sockets.get(socketId)
            const subscription = this.subscriptions.get(socketId)?.get(room)
            if (!socket || !subscription) {
                continue
            }

            if (!this.canReceiveRowEvent(subscription, payload.eventType, newRow, oldRow)) {
                continue
            }

            socket.emit(eventName, {
                ...payload,
                channel: subscription.channel,
            })
        }
    }

    private canReceiveRowEvent(
        subscription: TableSubscription,
        eventType: TableEventType,
        newRow: Record<string, unknown> | null,
        oldRow: Record<string, unknown> | null
    ): boolean {
        const candidateRows = eventType === 'DELETE'
            ? [oldRow]
            : eventType === 'INSERT'
                ? [newRow]
                : [newRow, oldRow]
        const rows = candidateRows.filter((row): row is Record<string, unknown> => row !== null)

        if (rows.length === 0) {
            return false
        }

        if (!subscription.bypassRLS && subscription.selectPolicy && !rows.some(row => checkRLSForRow(row, subscription.selectPolicy, subscription.user))) {
            return false
        }

        if (subscription.filters.length === 0) {
            return true
        }

        return rows.some(row => applyQueryFilters(row, subscription.filters))
    }

    private async authorizeTableSubscription(
        data: SubscribePayload
    ): Promise<{ user: JWTPayload; selectPolicy?: RLSPolicy; bypassRLS: boolean; filters: QueryFilter[] } | null> {
        const user = await this.verifyProjectToken(data.projectId, data.token, 'tables.read')
        if (!user) {
            return null
        }

        const schemas = await this.projectService.getSchemas(data.projectId)
        const schema = schemas[data.table]
        if (!schema) {
            return null
        }

        const project = await this.projectService.getProject(data.projectId)
        const bypassRLS = user.role === 'service_role'
            || (user.role === 'platform_user' && user.sub === project.ownerId)

        const filters = resolveSubscriptionFilters(data.filter, data.filters)

        return {
            user,
            selectPolicy: findPolicy(schema.rls, 'SELECT'),
            bypassRLS,
            filters,
        }
    }

    private async verifyProjectToken(
        projectId: string,
        token: string | undefined,
        requiredPermission: 'project.read' | 'tables.read'
    ): Promise<JWTPayload | null> {
        if (!token) {
            return null
        }

        let payload: JWTPayload
        try {
            payload = jwt.verify(token, this.jwtSecret) as JWTPayload
        } catch {
            return null
        }

        if (payload.type === 'refresh') {
            return null
        }

        if (payload.role === 'platform_user') {
            try {
                await this.projectAccessService.assertPlatformPermission(projectId, payload, requiredPermission)
                return payload
            } catch {
                return null
            }
        }

        if (payload.projectId !== projectId) {
            return null
        }

        const active = await this.authService.isSessionActive(payload)
        return active ? payload : null
    }

    private upsertPresence(
        room: string,
        socketId: string,
        key: string,
        nextMeta: PresenceMeta
    ): { joins: PresenceState; leaves: PresenceState } {
        const roomState = this.presenceRooms.get(room) ?? new Map<string, Map<string, PresenceMeta>>()
        const userState = roomState.get(key) ?? new Map<string, PresenceMeta>()
        const previous = userState.get(socketId)

        userState.set(socketId, nextMeta)
        roomState.set(key, userState)
        this.presenceRooms.set(room, roomState)

        return {
            joins: { [key]: { metas: [nextMeta] } },
            leaves: previous ? { [key]: { metas: [previous] } } : {},
        }
    }

    private removeSocketPresenceFromRoom(socketId: string, room: string, channel: string): void {
        const roomState = this.presenceRooms.get(room)
        if (!roomState) {
            return
        }

        const leaves: PresenceState = {}

        for (const [key, metas] of roomState.entries()) {
            const previous = metas.get(socketId)
            if (!previous) {
                continue
            }

            metas.delete(socketId)
            leaves[key] = { metas: [previous] }

            if (metas.size === 0) {
                roomState.delete(key)
            }
        }

        if (roomState.size === 0) {
            this.presenceRooms.delete(room)
        }

        if (Object.keys(leaves).length > 0) {
            this.io.to(room).emit('presence_diff', {
                channel,
                joins: {},
                leaves,
            })
        }
    }

    private cleanupSocketPresence(socketId: string): void {
        const rooms = this.socketPresenceRooms.get(socketId)
        if (!rooms) {
            return
        }

        for (const room of rooms) {
            const channel = room.split(':').slice(3).join(':')
            this.removeSocketPresenceFromRoom(socketId, room, channel)
        }

        this.socketPresenceRooms.delete(socketId)
    }

    private serializePresenceRoom(room: string): PresenceState {
        const roomState = this.presenceRooms.get(room)
        if (!roomState) {
            return {}
        }

        return Object.fromEntries(
            [...roomState.entries()].map(([key, metas]) => [key, { metas: [...metas.values()] }])
        )
    }

    private getPresenceRoom(projectId: string, channel: string): string {
        return `project:${projectId}:presence:${channel}`
    }

    private getTableRoom(projectId: string, table: string, eventType: TableEventType): string {
        return eventType === '*'
            ? `project:${projectId}:table:${table}:*`
            : `project:${projectId}:table:${table}:${eventType}`
    }

    private recordSocketPresenceRoom(socketId: string, room: string): void {
        const rooms = this.socketPresenceRooms.get(socketId) ?? new Set<string>()
        rooms.add(room)
        this.socketPresenceRooms.set(socketId, rooms)
    }

    private removeSocketPresenceRoom(socketId: string, room: string): void {
        const rooms = this.socketPresenceRooms.get(socketId)
        if (!rooms) {
            return
        }

        rooms.delete(room)
        if (rooms.size === 0) {
            this.socketPresenceRooms.delete(socketId)
        }
    }

    private storeSubscription(socketId: string, subscription: TableSubscription): void {
        const existing = this.subscriptions.get(socketId) ?? new Map<string, TableSubscription>()
        existing.set(subscription.room, subscription)
        this.subscriptions.set(socketId, existing)
    }

    private removeSubscription(socketId: string, room: string): void {
        const existing = this.subscriptions.get(socketId)
        if (!existing) {
            return
        }

        existing.delete(room)
        if (existing.size === 0) {
            this.subscriptions.delete(socketId)
        }
    }
}

function resolveSubscriptionFilters(
    filter: string | undefined,
    filters: RealtimeFilterExpression[] | undefined
): QueryFilter[] {
    if (filters && filters.length > 0) {
        return filters.map(entry => ({
            column: entry.column,
            operator: entry.operator,
            value: entry.value,
        }))
    }

    if (!filter) {
        return []
    }

    return parseRealtimeFilterExpression(filter)
}
