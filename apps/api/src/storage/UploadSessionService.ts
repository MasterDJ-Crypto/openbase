import { randomUUID } from 'crypto'
import { createReadStream, existsSync, mkdirSync, rmSync } from 'fs'
import { open, stat } from 'fs/promises'
import { join } from 'path'
import type Redis from 'ioredis'
import type { ResumableUploadSession, StorageObjectPolicy } from '@openbase/core'
import { ConflictError, ForbiddenError, NotFoundError, nowISO } from '@openbase/core'
import jwt from 'jsonwebtoken'

const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024

interface StoredUploadSession {
    id: string
    projectId: string
    bucket: string
    path: string
    uploadToken: string
    chunkSize: number
    uploadedBytes: number
    totalSize?: number
    createdAt: string
    expiresAt: string
    completed: boolean
    upsert: boolean
    mimeType: string
    userId: string | null
    metadata?: {
        tags?: Record<string, string>
        customMetadata?: Record<string, string>
    }
    policy?: StorageObjectPolicy
}

interface CreateUploadSessionOptions {
    projectId: string
    bucket: string
    path: string
    totalSize?: number
    mimeType: string
    userId: string | null
    upsert?: boolean
    metadata?: {
        tags?: Record<string, string>
        customMetadata?: Record<string, string>
    }
    policy?: StorageObjectPolicy
    ttlSeconds?: number
    chunkSize?: number
}

export class UploadSessionService {
    constructor(
        private readonly redis: Redis,
        private readonly basePath: string,
        private readonly jwtSecret: string,
        private readonly apiPublicUrl: string
    ) {
        mkdirSync(this.basePath, { recursive: true })
    }

    async createSession(options: CreateUploadSessionOptions): Promise<ResumableUploadSession> {
        const id = randomUUID()
        const ttlSeconds = options.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
        const uploadToken = jwt.sign(
            {
                type: 'storage_upload',
                uploadId: id,
                projectId: options.projectId,
                bucket: options.bucket,
                path: options.path,
            },
            this.jwtSecret,
            { expiresIn: ttlSeconds }
        )

        const session: StoredUploadSession = {
            id,
            projectId: options.projectId,
            bucket: options.bucket,
            path: options.path,
            uploadToken,
            chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
            uploadedBytes: 0,
            ...(options.totalSize !== undefined ? { totalSize: options.totalSize } : {}),
            createdAt: nowISO(),
            expiresAt,
            completed: false,
            upsert: options.upsert === true,
            mimeType: options.mimeType || 'application/octet-stream',
            userId: options.userId,
            ...(options.metadata ? { metadata: options.metadata } : {}),
            ...(options.policy ? { policy: options.policy } : {}),
        }

        await this.writeSession(session, ttlSeconds)
        return this.toPublicSession(session)
    }

    async getSession(uploadId: string, token: string): Promise<ResumableUploadSession> {
        const session = await this.requireAuthorizedSession(uploadId, token)
        return this.toPublicSession(session)
    }

    async appendChunk(
        uploadId: string,
        token: string,
        offset: number,
        chunk: Buffer
    ): Promise<ResumableUploadSession> {
        const session = await this.requireAuthorizedSession(uploadId, token)
        if (session.completed) {
            throw new ConflictError('Upload session is already complete')
        }

        if (offset !== session.uploadedBytes) {
            throw new ConflictError(`Upload offset mismatch. Expected ${session.uploadedBytes}, received ${offset}`)
        }

        const file = await open(this.getSessionFilePath(uploadId), existsSync(this.getSessionFilePath(uploadId)) ? 'r+' : 'w+')
        try {
            await file.write(chunk, 0, chunk.length, offset)
        } finally {
            await file.close()
        }

        session.uploadedBytes += chunk.length
        await this.writeSession(session)
        return this.toPublicSession(session)
    }

    async completeSession<T>(
        uploadId: string,
        token: string,
        finalize: (session: StoredUploadSession, filePath: string) => Promise<T>
    ): Promise<T> {
        const session = await this.requireAuthorizedSession(uploadId, token)
        if (session.completed) {
            throw new ConflictError('Upload session is already complete')
        }

        if (session.totalSize !== undefined && session.uploadedBytes !== session.totalSize) {
            throw new ConflictError(`Upload is incomplete. Expected ${session.totalSize} bytes, received ${session.uploadedBytes}`)
        }

        const filePath = this.getSessionFilePath(uploadId)
        const result = await finalize(session, filePath)
        session.completed = true
        await this.writeSession(session, 60)
        this.cleanupFile(uploadId)
        return result
    }

    async abortSession(uploadId: string, token: string): Promise<void> {
        await this.requireAuthorizedSession(uploadId, token)
        await this.redis.del(this.getSessionKey(uploadId))
        this.cleanupFile(uploadId)
    }

    async createReadStream(uploadId: string, token: string) {
        await this.requireAuthorizedSession(uploadId, token)
        return createReadStream(this.getSessionFilePath(uploadId))
    }

    async getUploadedSize(uploadId: string): Promise<number> {
        try {
            const details = await stat(this.getSessionFilePath(uploadId))
            return details.size
        } catch {
            return 0
        }
    }

    private async requireAuthorizedSession(uploadId: string, token: string): Promise<StoredUploadSession> {
        const payload = this.verifyToken(token)
        if (payload.uploadId !== uploadId) {
            throw new ForbiddenError('Signed upload token does not match this upload session')
        }

        const raw = await this.redis.get(this.getSessionKey(uploadId))
        if (!raw) {
            throw new NotFoundError('Upload session')
        }

        const session = JSON.parse(raw) as StoredUploadSession
        if (session.uploadToken !== token) {
            throw new ForbiddenError('Signed upload token is invalid')
        }

        return session
    }

    private verifyToken(token: string): { uploadId: string } {
        try {
            return jwt.verify(token, this.jwtSecret) as { uploadId: string }
        } catch {
            throw new ForbiddenError('Invalid or expired upload token')
        }
    }

    private async writeSession(session: StoredUploadSession, ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS): Promise<void> {
        await this.redis.set(this.getSessionKey(session.id), JSON.stringify(session), 'EX', ttlSeconds)
    }

    private toPublicSession(session: StoredUploadSession): ResumableUploadSession {
        const token = encodeURIComponent(session.uploadToken)
        return {
            id: session.id,
            projectId: session.projectId,
            bucket: session.bucket,
            path: session.path,
            uploadUrl: `${this.apiPublicUrl}/api/v1/storage/uploads/${session.id}?token=${token}`,
            statusUrl: `${this.apiPublicUrl}/api/v1/storage/uploads/${session.id}?token=${token}`,
            completeUrl: `${this.apiPublicUrl}/api/v1/storage/uploads/${session.id}/complete?token=${token}`,
            chunkSize: session.chunkSize,
            uploadedBytes: session.uploadedBytes,
            ...(session.totalSize !== undefined ? { totalSize: session.totalSize } : {}),
            expiresAt: session.expiresAt,
            createdAt: session.createdAt,
            completed: session.completed,
        }
    }

    private getSessionKey(uploadId: string): string {
        return `storage:upload:${uploadId}`
    }

    private getSessionFilePath(uploadId: string): string {
        return join(this.basePath, `${uploadId}.upload`)
    }

    private cleanupFile(uploadId: string): void {
        rmSync(this.getSessionFilePath(uploadId), { force: true })
    }
}
