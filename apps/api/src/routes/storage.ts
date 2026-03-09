import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createReadStream } from 'fs'
import type { BucketPolicy, Project, StorageAction, StorageObjectPolicy } from '@openbase/core'
import { bucketPolicySchema, storageObjectPolicySchema } from '@openbase/core'
import { ConflictError, ForbiddenError } from '@openbase/core'
import { z } from 'zod'
import type { ProjectAccessService } from '../access/ProjectAccessService.js'
import type { AuthService } from '../auth/AuthService.js'
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js'
import type { ProjectService } from '../projects/ProjectService.js'
import type { StorageService } from '../storage/StorageService.js'
import type { UploadSessionService } from '../storage/UploadSessionService.js'
import { isStorageAccessAllowed } from '../storage/policyEngine.js'

const storageMetadataInputSchema = z.object({
    tags: z.record(z.string()).optional(),
    customMetadata: z.record(z.string()).optional(),
})

const createBucketSchema = z.object({
    name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
    public: z.boolean().optional().default(false),
    allowedMimeTypes: z.array(z.string()).optional(),
    maxFileSize: z.number().positive().optional(),
    rules: storageObjectPolicySchema.shape.rules.optional(),
})

const signedUrlSchema = z.object({
    bucket: z.string().min(1),
    path: z.string().min(1),
    expiresIn: z.number().min(1).max(604800).default(3600),
})

const createUploadSessionSchema = z.object({
    bucket: z.string().min(1),
    path: z.string().min(1),
    mimeType: z.string().default('application/octet-stream'),
    totalSize: z.number().nonnegative().optional(),
    expiresIn: z.number().min(60).max(86400).default(3600),
    upsert: z.boolean().optional().default(false),
    chunkSize: z.number().min(1024 * 256).max(32 * 1024 * 1024).optional(),
    metadata: storageMetadataInputSchema.optional(),
    policy: storageObjectPolicySchema.optional(),
})

const updateObjectSchema = z.object({
    metadata: storageMetadataInputSchema.optional(),
    policy: storageObjectPolicySchema.nullable().optional(),
})

type BucketAction = 'read' | 'write' | 'delete'

export function registerStorageRoutes(
    app: FastifyInstance,
    storageService: StorageService,
    uploadSessionService: UploadSessionService,
    projectService: ProjectService,
    projectAccessService: ProjectAccessService,
    authService: AuthService
): void {
    app.post<{ Params: { projectId: string } }>(
        '/api/v1/:projectId/storage/buckets',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const project = await assertProjectAdminAccess(projectService, projectAccessService, request)
            const body = createBucketSchema.parse(request.body)

            if (project.buckets[body.name]) {
                throw new ConflictError(`Bucket "${body.name}" already exists`)
            }

            return projectService.withProjectStorageRecord(project, async (_project, provider) => {
                const channel = await storageService.createBucket(provider, body.name, { public: body.public })
                const basePolicy = storageService.createBucketPolicy({ public: body.public })
                const policy: BucketPolicy = {
                    ...basePolicy,
                    ...(body.allowedMimeTypes ? { allowedMimeTypes: body.allowedMimeTypes } : {}),
                    ...(body.maxFileSize !== undefined ? { maxFileSize: body.maxFileSize } : {}),
                    ...(body.rules ? { rules: body.rules } : {}),
                }

                project.buckets[body.name] = channel
                project.bucketPolicies[body.name] = policy
                await projectService.updateProject(project.id, {
                    buckets: project.buckets,
                    bucketPolicies: project.bucketPolicies,
                })

                return reply.status(201).send({
                    data: { name: body.name, channel, policy },
                })
            })
        }
    )

    app.get<{ Params: { projectId: string; bucket: string } }>(
        '/api/v1/:projectId/storage/buckets/:bucket/policy',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const project = await getProjectForStorageAction(projectService, projectAccessService, authService, request, request.params.bucket, 'read')
            return reply.send({
                data: getBucketPolicy(project, request.params.bucket),
            })
        }
    )

    app.patch<{ Params: { projectId: string; bucket: string } }>(
        '/api/v1/:projectId/storage/buckets/:bucket/policy',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const project = await assertProjectAdminAccess(projectService, projectAccessService, request)
            if (!project.buckets[request.params.bucket]) {
                return reply.status(404).send({ error: { message: `Bucket "${request.params.bucket}" not found` } })
            }

            const policy = bucketPolicySchema.parse(request.body)
            project.bucketPolicies[request.params.bucket] = policy
            await projectService.updateProject(project.id, { bucketPolicies: project.bucketPolicies })
            return reply.send({ data: policy })
        }
    )

    app.post<{ Params: { projectId: string } }>(
        '/api/v1/:projectId/storage/uploads',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const body = createUploadSessionSchema.parse(request.body)
            const project = await getProjectForStorageAction(projectService, projectAccessService, authService, request, body.bucket, 'write')
            const bucketChannel = project.buckets[body.bucket]
            if (!bucketChannel) {
                return reply.status(404).send({ error: { message: `Bucket "${body.bucket}" not found` } })
            }

            const policy = getBucketPolicy(project, body.bucket)
            ensureBucketAccess(project, body.bucket, 'write', request.user)
            assertUploadConstraints(policy, body.mimeType, body.totalSize)

            const session = await uploadSessionService.createSession({
                projectId: project.id,
                bucket: body.bucket,
                path: body.path,
                totalSize: body.totalSize,
                mimeType: body.mimeType,
                userId: request.user?.sub || null,
                upsert: body.upsert,
                metadata: body.metadata,
                policy: body.policy,
                ttlSeconds: body.expiresIn,
                chunkSize: body.chunkSize,
            })

            return reply.status(201).send({ data: session })
        }
    )

    app.get<{ Params: { uploadId: string }; Querystring: { token?: string } }>(
        '/api/v1/storage/uploads/:uploadId',
        async (request, reply) => {
            const token = getUploadToken(request)
            const session = await uploadSessionService.getSession(request.params.uploadId, token)
            return reply.send({ data: session })
        }
    )

    app.patch<{ Params: { uploadId: string }; Querystring: { token?: string } }>(
        '/api/v1/storage/uploads/:uploadId',
        async (request, reply) => {
            const token = getUploadToken(request)
            const offset = parseUploadOffset(request)
            const chunk = coerceBodyToBuffer(request.body)
            const session = await uploadSessionService.appendChunk(request.params.uploadId, token, offset, chunk)
            return reply.send({
                data: session,
                meta: {
                    range: `${offset}-${session.uploadedBytes - 1}`,
                },
            })
        }
    )

    app.post<{ Params: { uploadId: string }; Querystring: { token?: string } }>(
        '/api/v1/storage/uploads/:uploadId/complete',
        async (request, reply) => {
            const token = getUploadToken(request)
            const result = await uploadSessionService.completeSession(request.params.uploadId, token, async (session, filePath) => {
                const project = await projectService.getProject(session.projectId)
                const bucketChannel = project.buckets[session.bucket]
                if (!bucketChannel) {
                    throw new ForbiddenError(`Bucket "${session.bucket}" not found`)
                }

                const policy = getBucketPolicy(project, session.bucket)
                assertUploadConstraints(policy, session.mimeType, session.totalSize)

                return projectService.withProjectStorageRecord(project, async (_project, provider) => {
                    const upload = await storageService.uploadStream(
                        provider,
                        project.id,
                        session.bucket,
                        bucketChannel,
                        project.storageIndexChannel,
                        session.path,
                        createFileStream(filePath),
                        {
                            mimeType: session.mimeType,
                            userId: session.userId || undefined,
                            upsert: session.upsert,
                            metadata: session.metadata,
                            policy: session.policy,
                        }
                    )

                    return upload
                })
            })

            return reply.status(201).send({ data: result })
        }
    )

    app.delete<{ Params: { uploadId: string }; Querystring: { token?: string } }>(
        '/api/v1/storage/uploads/:uploadId',
        async (request, reply) => {
            const token = getUploadToken(request)
            await uploadSessionService.abortSession(request.params.uploadId, token)
            return reply.send({ data: { message: 'Upload session aborted' } })
        }
    )

    app.post<{ Params: { projectId: string; bucket: string; '*': string } }>(
        '/api/v1/:projectId/storage/:bucket/*',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const project = await getProjectForStorageAction(projectService, projectAccessService, authService, request, request.params.bucket, 'write')
            const { bucket } = request.params
            const filePath = request.params['*']
            const bucketChannel = project.buckets[bucket]

            if (!bucketChannel) {
                return reply.status(404).send({ error: { message: `Bucket "${bucket}" not found` } })
            }

            const file = await request.file()
            if (!file) {
                return reply.status(400).send({ error: { message: 'No file provided' } })
            }

            ensureBucketAccess(project, bucket, 'write', request.user)
            assertUploadConstraints(getBucketPolicy(project, bucket), file.mimetype, undefined)

            return projectService.withProjectStorageRecord(project, async (_project, provider) => {
                const result = await storageService.uploadStream(
                    provider,
                    project.id,
                    bucket,
                    bucketChannel,
                    project.storageIndexChannel,
                    filePath,
                    file.file,
                    {
                        mimeType: file.mimetype,
                        userId: request.user?.sub,
                        upsert: String(request.headers['x-upsert'] || '').toLowerCase() === 'true',
                    }
                )

                return reply.status(201).send({ data: result })
            })
        }
    )

    app.get<{ Params: { projectId: string; bucket: string; '*': string }; Querystring: { width?: string; height?: string; format?: string } }>(
        '/api/v1/:projectId/storage/:bucket/*',
        { preHandler: [optionalAuthMiddleware] },
        async (request, reply) => {
            const project = await getProjectForStorageAction(projectService, projectAccessService, authService, request, request.params.bucket, 'read')
            const { bucket } = request.params
            const filePath = request.params['*']
            const bucketChannel = project.buckets[bucket]

            if (!bucketChannel) {
                return reply.status(404).send({ error: { message: `Bucket "${bucket}" not found` } })
            }

            return projectService.withProjectStorageRecord(project, async (_project, provider) => {
                const fileManifest = await storageService.findFile(
                    provider,
                    project.storageIndexChannel,
                    bucket,
                    bucketChannel,
                    filePath
                )

                if (!fileManifest) {
                    return reply.status(404).send({ error: { message: 'File not found' } })
                }

                ensureObjectAccess(project, bucket, 'read', request.user, fileManifest)

                const transformOptions = getTransformOptions(request.query as {
                    width?: string
                    height?: string
                    format?: string
                })

                const { data: fileData, mimeType } = await storageService.download(
                    provider,
                    fileManifest.fileRef,
                    transformOptions
                )

                return reply
                    .header('Content-Type', mimeType)
                    .header('Content-Length', fileData.length)
                    .header('Cache-Control', getBucketPolicy(project, bucket).public ? 'public, max-age=3600' : 'private, max-age=0')
                    .send(fileData)
            })
        }
    )

    app.get<{ Params: { projectId: string; bucket: string; '*': string } }>(
        '/api/v1/:projectId/storage/:bucket/metadata/*',
        { preHandler: [optionalAuthMiddleware] },
        async (request, reply) => {
            const project = await getProjectForStorageAction(projectService, projectAccessService, authService, request, request.params.bucket, 'read')
            const bucketChannel = project.buckets[request.params.bucket]
            if (!bucketChannel) {
                return reply.status(404).send({ error: { message: `Bucket "${request.params.bucket}" not found` } })
            }

            return projectService.withProjectStorageRecord(project, async (_project, provider) => {
                const fileManifest = await storageService.findFile(
                    provider,
                    project.storageIndexChannel,
                    request.params.bucket,
                    bucketChannel,
                    request.params['*']
                )

                if (!fileManifest) {
                    return reply.status(404).send({ error: { message: 'File not found' } })
                }

                ensureObjectAccess(project, request.params.bucket, 'read', request.user, fileManifest)
                return reply.send({
                    data: {
                        path: fileManifest.path,
                        size: fileManifest.size,
                        mimeType: fileManifest.mimeType,
                        createdAt: fileManifest.createdAt,
                        updatedAt: fileManifest.updatedAt,
                        uploadedBy: fileManifest.uploadedBy,
                        metadata: fileManifest.metadata,
                        policy: fileManifest.policy ?? null,
                    },
                })
            })
        }
    )

    app.patch<{ Params: { projectId: string; bucket: string; '*': string } }>(
        '/api/v1/:projectId/storage/:bucket/metadata/*',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const project = await getProjectForStorageAction(projectService, projectAccessService, authService, request, request.params.bucket, 'write')
            const bucketChannel = project.buckets[request.params.bucket]
            if (!bucketChannel) {
                return reply.status(404).send({ error: { message: `Bucket "${request.params.bucket}" not found` } })
            }

            const body = updateObjectSchema.parse(request.body)
            return projectService.withProjectStorageRecord(project, async (_project, provider) => {
                const fileManifest = await storageService.findFile(
                    provider,
                    project.storageIndexChannel,
                    request.params.bucket,
                    bucketChannel,
                    request.params['*']
                )

                if (!fileManifest) {
                    return reply.status(404).send({ error: { message: 'File not found' } })
                }

                ensureObjectAccess(project, request.params.bucket, 'write', request.user, fileManifest)
                const updated = await storageService.updateObject(
                    provider,
                    project.storageIndexChannel,
                    fileManifest.manifestMessageId,
                    body
                )
                return reply.send({ data: updated })
            })
        }
    )

    app.get<{ Params: { projectId: string; bucket: string }; Querystring: { prefix?: string } }>(
        '/api/v1/:projectId/storage/:bucket',
        { preHandler: [optionalAuthMiddleware] },
        async (request, reply) => {
            const project = await getProjectForStorageAction(projectService, projectAccessService, authService, request, request.params.bucket, 'read')
            const { bucket } = request.params
            const { prefix } = request.query as { prefix?: string }
            const bucketChannel = project.buckets[bucket]

            if (!bucketChannel) {
                return reply.status(404).send({ error: { message: `Bucket "${bucket}" not found` } })
            }

            return projectService.withProjectStorageRecord(project, async (_project, provider) => {
                const files = await storageService.listFiles(
                    provider,
                    project.storageIndexChannel,
                    bucket,
                    bucketChannel,
                    prefix
                )

                return reply.send({
                    data: files.filter(file => isStorageAccessAllowed(bucket, 'read', getBucketPolicy(project, bucket), request.user, file)),
                })
            })
        }
    )

    app.delete<{ Params: { projectId: string; bucket: string; '*': string } }>(
        '/api/v1/:projectId/storage/:bucket/*',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const project = await getProjectForStorageAction(projectService, projectAccessService, authService, request, request.params.bucket, 'delete')
            const { bucket } = request.params
            const filePath = request.params['*']
            const bucketChannel = project.buckets[bucket]

            if (!bucketChannel) {
                return reply.status(404).send({ error: { message: `Bucket "${bucket}" not found` } })
            }

            return projectService.withProjectStorageRecord(project, async (_project, provider) => {
                const fileManifest = await storageService.findFile(
                    provider,
                    project.storageIndexChannel,
                    bucket,
                    bucketChannel,
                    filePath
                )

                if (!fileManifest) {
                    return reply.status(404).send({ error: { message: 'File not found' } })
                }

                ensureObjectAccess(project, bucket, 'delete', request.user, fileManifest)

                await storageService.deleteFile(
                    provider,
                    project.storageIndexChannel,
                    fileManifest.manifestMessageId,
                    fileManifest.fileRef
                )

                return reply.send({ data: { message: 'File deleted', path: filePath } })
            })
        }
    )

    app.post<{ Params: { projectId: string } }>(
        '/api/v1/:projectId/storage/signed',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const body = signedUrlSchema.parse(request.body)
            const project = await getProjectForStorageAction(projectService, projectAccessService, authService, request, body.bucket, 'read')

            if (!project.buckets[body.bucket]) {
                return reply.status(404).send({ error: { message: `Bucket "${body.bucket}" not found` } })
            }

            const signedUrl = storageService.createSignedUrl(
                project.id,
                body.bucket,
                body.path,
                body.expiresIn
            )

            return reply.send({ data: { signedUrl } })
        }
    )

    app.get(
        '/api/v1/storage/signed',
        async (request, reply) => {
            const { token } = request.query as { token?: string }
            if (!token) {
                return reply.status(400).send({ error: { message: 'Missing token' } })
            }

            try {
                const payload = storageService.verifySignedUrl(token)
                const project = await projectService.getProject(payload.projectId)
                const bucketChannel = project.buckets[payload.bucket]

                if (!bucketChannel) {
                    return reply.status(404).send({ error: { message: 'Bucket not found' } })
                }

                return projectService.withProjectStorageRecord(project, async (_project, provider) => {
                    const fileManifest = await storageService.findFile(
                        provider,
                        project.storageIndexChannel,
                        payload.bucket,
                        bucketChannel,
                        payload.path
                    )

                    if (!fileManifest) {
                        return reply.status(404).send({ error: { message: 'File not found' } })
                    }

                    const { data: fileData, mimeType } = await storageService.download(
                        provider,
                        fileManifest.fileRef
                    )

                    return reply
                        .header('Content-Type', mimeType)
                        .header('Content-Length', fileData.length)
                        .header('Cache-Control', 'private, max-age=0')
                        .send(fileData)
                })
            } catch {
                return reply.status(403).send({ error: { message: 'Invalid or expired signed URL' } })
            }
        }
    )
}

async function getProjectForStorageAction(
    projectService: ProjectService,
    projectAccessService: ProjectAccessService,
    authService: AuthService,
    request: FastifyRequest<{ Params: Record<string, string> }>,
    bucketName: string,
    action: BucketAction
): Promise<Project> {
    const project = await projectService.getProject(request.params.projectId)
    const user = request.user

    if (user?.role === 'platform_user') {
        await projectAccessService.assertPlatformPermission(project.id, user, mapBucketActionToPermission(action))
        return project
    }

    if (!project.buckets[bucketName]) {
        return project
    }

    if (!user) {
        return project
    }

    if (user.projectId !== project.id) {
        throw new ForbiddenError(`You do not have ${action} access to bucket "${bucketName}"`)
    }

    const active = await authService.isSessionActive(user)
    if (!active) {
        throw new ForbiddenError('Your session is no longer active')
    }

    return project
}

function getBucketPolicy(project: Project, bucketName: string): BucketPolicy {
    return project.bucketPolicies[bucketName] ?? { public: false }
}

function ensureObjectAccess(
    project: Project,
    bucketName: string,
    action: StorageAction,
    user: FastifyRequest['user'],
    file: {
        path: string
        size: number
        mimeType: string
        createdAt: number
        updatedAt: number
        uploadedBy: string | null
        metadata: { contentType: string; size: number; createdAt: number; updatedAt: number; tags?: Record<string, string>; customMetadata?: Record<string, string> }
        policy?: StorageObjectPolicy | null
    }
): void {
    const allowed = isStorageAccessAllowed(bucketName, action, getBucketPolicy(project, bucketName), user, {
        path: file.path,
        size: file.size,
        mimeType: file.mimeType,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        uploadedBy: file.uploadedBy,
        metadata: file.metadata,
        policy: file.policy ?? null,
    })

    if (!allowed) {
        throw new ForbiddenError(`You do not have ${action} access to "${file.path}"`)
    }
}

function ensureBucketAccess(
    project: Project,
    bucketName: string,
    action: StorageAction,
    user: FastifyRequest['user']
): void {
    if (!isStorageAccessAllowed(bucketName, action, getBucketPolicy(project, bucketName), user)) {
        throw new ForbiddenError(`You do not have ${action} access to bucket "${bucketName}"`)
    }
}

async function assertProjectAdminAccess(
    projectService: ProjectService,
    projectAccessService: ProjectAccessService,
    request: FastifyRequest<{ Params: Record<string, string> }>
) {
    const project = await projectService.getProject(request.params.projectId)
    const user = request.user

    if (!user) {
        throw new ForbiddenError('Authentication required')
    }

    if (user.role === 'platform_user') {
        await projectAccessService.assertPlatformPermission(project.id, user, 'storage.manage')
        return project
    }

    if (user.projectId === project.id && user.role === 'service_role') {
        return project
    }

    throw new ForbiddenError('Administrative access required')
}

function mapBucketActionToPermission(action: BucketAction) {
    switch (action) {
        case 'read':
            return 'storage.read' as const
        case 'write':
            return 'storage.write' as const
        case 'delete':
            return 'storage.manage' as const
    }
}

function getTransformOptions(query: { width?: string; height?: string; format?: string }) {
    if (!query.width && !query.height && !query.format) {
        return undefined
    }

    return {
        width: query.width ? parseInt(query.width, 10) : undefined,
        height: query.height ? parseInt(query.height, 10) : undefined,
        format: query.format as 'jpeg' | 'png' | 'webp' | 'avif' | undefined,
    }
}

function getUploadToken(request: FastifyRequest<{ Querystring?: { token?: string } }>): string {
    const token = typeof request.query === 'object' ? (request.query as { token?: string }).token : undefined
    if (!token) {
        throw new ForbiddenError('Missing signed upload token')
    }
    return token
}

function parseUploadOffset(request: FastifyRequest): number {
    const raw = request.headers['x-openbase-upload-offset']
    const value = Array.isArray(raw) ? raw[0] : raw
    const parsed = value ? Number(value) : 0
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function coerceBodyToBuffer(body: unknown): Buffer {
    if (Buffer.isBuffer(body)) {
        return body
    }

    if (typeof body === 'string') {
        return Buffer.from(body)
    }

    throw new ForbiddenError('Upload chunk body must be a binary payload')
}

function assertUploadConstraints(policy: BucketPolicy, mimeType: string, totalSize?: number): void {
    if (policy.allowedMimeTypes?.length && !policy.allowedMimeTypes.includes(mimeType)) {
        throw new ForbiddenError(`Bucket policy does not allow uploads with MIME type "${mimeType}"`)
    }

    if (policy.maxFileSize !== undefined && totalSize !== undefined && totalSize > policy.maxFileSize) {
        throw new ForbiddenError(`Bucket policy limits uploads to ${policy.maxFileSize} bytes`)
    }
}

function createFileStream(filePath: string): AsyncIterable<Buffer> {
    return createReadStream(filePath) as unknown as AsyncIterable<Buffer>
}
