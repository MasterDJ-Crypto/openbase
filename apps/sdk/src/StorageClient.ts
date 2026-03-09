/**
 * StorageClient - Client-side file storage operations
 */

import { z } from 'zod'
import type {
    ResumableUploadSession,
    StorageObjectMetadataInput,
    StorageObjectPolicy,
    StorageObjectRecord,
    TransformOptions,
    UploadOptions,
} from './types.js'
import { parseApiEnvelope } from './http.js'

const bucketCreateSchema = z.object({
    name: z.string(),
})

const uploadResultSchema = z.object({
    path: z.string(),
    publicUrl: z.string().url(),
    metadata: z.object({
        contentType: z.string(),
        size: z.number(),
        createdAt: z.number(),
        updatedAt: z.number(),
        tags: z.record(z.string()).optional(),
        customMetadata: z.record(z.string()).optional(),
    }),
    policy: z.unknown().nullable().optional(),
})

const messageSchema = z.object({
    message: z.string(),
    path: z.string().optional(),
})

const storageObjectSchema = z.object({
    path: z.string(),
    size: z.number(),
    mimeType: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    uploadedBy: z.string().nullable(),
    metadata: z.object({
        contentType: z.string(),
        size: z.number(),
        createdAt: z.number(),
        updatedAt: z.number(),
        tags: z.record(z.string()).optional(),
        customMetadata: z.record(z.string()).optional(),
    }),
    policy: z.unknown().nullable().optional(),
})

const resumableUploadSessionSchema = z.object({
    id: z.string(),
    projectId: z.string(),
    bucket: z.string(),
    path: z.string(),
    uploadUrl: z.string().url(),
    statusUrl: z.string().url(),
    completeUrl: z.string().url(),
    chunkSize: z.number(),
    uploadedBytes: z.number(),
    totalSize: z.number().optional(),
    expiresAt: z.string(),
    createdAt: z.string(),
    completed: z.boolean(),
})

const signedUrlSchema = z.object({
    signedUrl: z.string().url(),
})

export class StorageClient {
    constructor(
        private projectUrl: string,
        private projectId: string,
        private apiKey: string,
        private getAccessToken: () => string | null
    ) { }

    from(bucket: string): StorageBucketClient {
        return new StorageBucketClient(
            this.projectUrl,
            this.projectId,
            bucket,
            this.apiKey,
            this.getAccessToken
        )
    }

    async createBucket(
        name: string,
        options?: {
            public?: boolean
            allowedMimeTypes?: string[]
            maxFileSize?: number
            rules?: StorageObjectPolicy['rules']
        }
    ): Promise<{ data: { name: string } | null; error: { message: string } | null }> {
        try {
            const token = this.getAccessToken() || this.apiKey
            const fetchFn = await getFetch()
            const response = await fetchFn(
                `${this.projectUrl}/api/v1/${this.projectId}/storage/buckets`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        apikey: this.apiKey,
                    },
                    body: JSON.stringify({
                        name,
                        public: options?.public || false,
                        allowedMimeTypes: options?.allowedMimeTypes,
                        maxFileSize: options?.maxFileSize,
                        rules: options?.rules,
                    }),
                }
            )

            const result = await parseApiEnvelope(response, bucketCreateSchema)
            return {
                data: result.data || null,
                error: result.error ? { message: result.error.message } : null,
            }
        } catch (error) {
            return { data: null, error: { message: (error as Error).message } }
        }
    }
}

class StorageBucketClient {
    constructor(
        private projectUrl: string,
        private projectId: string,
        private bucket: string,
        private apiKey: string,
        private getAccessToken: () => string | null
    ) { }

    async upload(
        path: string,
        file: Blob | File | Uint8Array | ArrayBuffer,
        options: UploadOptions = {}
    ): Promise<{ data: { path: string } | null; error: { message: string } | null }> {
        try {
            const blob = await toBlob(file, options.contentType)
            const requiresSession = options.resumable
                || Boolean(options.metadata)
                || Boolean(options.policy)
                || blob.size > 8 * 1024 * 1024

            if (requiresSession) {
                const result = await this.uploadResumable(path, blob, options)
                return {
                    data: result.data ? { path: result.data.path } : null,
                    error: result.error,
                }
            }

            const token = this.getAccessToken() || this.apiKey
            const formData = new FormData()
            formData.append('file', blob, path)

            const fetchFn = await getFetch()
            const response = await fetchFn(
                `${this.projectUrl}/api/v1/${this.projectId}/storage/${this.bucket}/${encodeStoragePath(path)}`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        apikey: this.apiKey,
                        ...(options.upsert ? { 'x-upsert': 'true' } : {}),
                    },
                    body: formData,
                }
            )

            const result = await parseApiEnvelope(response, uploadResultSchema)
            return {
                data: result.data ? { path: result.data.path } : null,
                error: result.error ? { message: result.error.message } : null,
            }
        } catch (error) {
            return { data: null, error: { message: (error as Error).message } }
        }
    }

    async uploadResumable(
        path: string,
        file: Blob | File | Uint8Array | ArrayBuffer,
        options: UploadOptions = {}
    ): Promise<{ data: z.infer<typeof uploadResultSchema> | null; error: { message: string } | null }> {
        try {
            const blob = await toBlob(file, options.contentType)
            const session = await this.createSignedUploadUrl(path, {
                contentType: blob.type || options.contentType,
                totalSize: blob.size,
                upsert: options.upsert,
                metadata: options.metadata,
                policy: options.policy,
                chunkSize: options.chunkSize,
            })

            if (session.error || !session.data) {
                return { data: null, error: session.error }
            }

            const fetchFn = await getFetch()
            let offset = 0
            while (offset < blob.size) {
                const chunk = blob.slice(offset, offset + session.data.chunkSize)
                const response = await fetchFn(this.resolveSessionUrl(session.data.uploadUrl), {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'x-openbase-upload-offset': String(offset),
                    },
                    body: chunk,
                })

                const chunkResult = await parseApiEnvelope(response, resumableUploadSessionSchema)
                if (chunkResult.error) {
                    return { data: null, error: { message: chunkResult.error.message } }
                }

                offset += chunk.size
            }

            const completeResponse = await fetchFn(this.resolveSessionUrl(session.data.completeUrl), {
                method: 'POST',
            })
            const completeResult = await parseApiEnvelope(completeResponse, uploadResultSchema)
            return {
                data: completeResult.data || null,
                error: completeResult.error ? { message: completeResult.error.message } : null,
            }
        } catch (error) {
            return { data: null, error: { message: (error as Error).message } }
        }
    }

    async createSignedUploadUrl(
        path: string,
        options: {
            contentType?: string
            totalSize?: number
            upsert?: boolean
            chunkSize?: number
            metadata?: StorageObjectMetadataInput
            policy?: StorageObjectPolicy
        } = {}
    ): Promise<{ data: ResumableUploadSession | null; error: { message: string } | null }> {
        try {
            const token = this.getAccessToken() || this.apiKey
            const fetchFn = await getFetch()
            const response = await fetchFn(
                `${this.projectUrl}/api/v1/${this.projectId}/storage/uploads`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        apikey: this.apiKey,
                    },
                    body: JSON.stringify({
                        bucket: this.bucket,
                        path,
                        mimeType: options.contentType || 'application/octet-stream',
                        totalSize: options.totalSize,
                        upsert: options.upsert || false,
                        chunkSize: options.chunkSize,
                        metadata: options.metadata,
                        policy: options.policy,
                    }),
                }
            )

            const result = await parseApiEnvelope(response, resumableUploadSessionSchema)
            return {
                data: result.data
                    ? {
                        ...(result.data as ResumableUploadSession),
                        uploadUrl: this.resolveSessionUrl(result.data.uploadUrl),
                        statusUrl: this.resolveSessionUrl(result.data.statusUrl),
                        completeUrl: this.resolveSessionUrl(result.data.completeUrl),
                    }
                    : null,
                error: result.error ? { message: result.error.message } : null,
            }
        } catch (error) {
            return { data: null, error: { message: (error as Error).message } }
        }
    }

    async info(
        path: string
    ): Promise<{ data: StorageObjectRecord | null; error: { message: string } | null }> {
        try {
            const token = this.getAccessToken() || this.apiKey
            const fetchFn = await getFetch()
            const response = await fetchFn(
                `${this.projectUrl}/api/v1/${this.projectId}/storage/${this.bucket}/metadata/${encodeStoragePath(path)}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        apikey: this.apiKey,
                    },
                }
            )

            const result = await parseApiEnvelope(response, storageObjectSchema)
            return {
                data: (result.data as StorageObjectRecord | null) || null,
                error: result.error ? { message: result.error.message } : null,
            }
        } catch (error) {
            return { data: null, error: { message: (error as Error).message } }
        }
    }

    async updateMetadata(
        path: string,
        updates: {
            metadata?: StorageObjectMetadataInput
            policy?: StorageObjectPolicy | null
        }
    ): Promise<{ data: StorageObjectRecord | null; error: { message: string } | null }> {
        try {
            const token = this.getAccessToken() || this.apiKey
            const fetchFn = await getFetch()
            const response = await fetchFn(
                `${this.projectUrl}/api/v1/${this.projectId}/storage/${this.bucket}/metadata/${encodeStoragePath(path)}`,
                {
                    method: 'PATCH',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        apikey: this.apiKey,
                    },
                    body: JSON.stringify(updates),
                }
            )

            const result = await parseApiEnvelope(response, storageObjectSchema.nullable())
            return {
                data: (result.data as StorageObjectRecord | null) || null,
                error: result.error ? { message: result.error.message } : null,
            }
        } catch (error) {
            return { data: null, error: { message: (error as Error).message } }
        }
    }

    async download(
        path: string,
        options?: { transform?: TransformOptions }
    ): Promise<{ data: Blob | null; error: { message: string } | null }> {
        try {
            const params = new URLSearchParams()
            if (options?.transform?.width) params.set('width', String(options.transform.width))
            if (options?.transform?.height) params.set('height', String(options.transform.height))
            if (options?.transform?.format) params.set('format', options.transform.format)

            const query = params.toString()
            const url = `${this.projectUrl}/api/v1/${this.projectId}/storage/${this.bucket}/${encodeStoragePath(path)}${query ? `?${query}` : ''}`

            const fetchFn = await getFetch()
            const token = this.getAccessToken() || this.apiKey
            const response = await fetchFn(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    apikey: this.apiKey,
                },
            })

            if (!response.ok) {
                const result = await parseApiEnvelope(response, z.unknown())
                return {
                    data: null,
                    error: result.error ? { message: result.error.message } : { message: `HTTP ${response.status}` },
                }
            }

            const blob = await response.blob()
            return { data: blob, error: null }
        } catch (error) {
            return { data: null, error: { message: (error as Error).message } }
        }
    }

    async remove(
        paths: string[]
    ): Promise<{ data: null; error: { message: string } | null }> {
        try {
            const token = this.getAccessToken() || this.apiKey
            const fetchFn = await getFetch()

            for (const path of paths) {
                const response = await fetchFn(
                    `${this.projectUrl}/api/v1/${this.projectId}/storage/${this.bucket}/${encodeStoragePath(path)}`,
                    {
                        method: 'DELETE',
                        headers: {
                            Authorization: `Bearer ${token}`,
                            apikey: this.apiKey,
                        },
                    }
                )

                const result = await parseApiEnvelope(response, messageSchema)
                if (result.error) {
                    return { data: null, error: { message: result.error.message } }
                }
            }

            return { data: null, error: null }
        } catch (error) {
            return { data: null, error: { message: (error as Error).message } }
        }
    }

    async list(
        prefix?: string
    ): Promise<{ data: StorageObjectRecord[] | null; error: { message: string } | null }> {
        try {
            const token = this.getAccessToken() || this.apiKey
            const params = prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''
            const fetchFn = await getFetch()
            const response = await fetchFn(
                `${this.projectUrl}/api/v1/${this.projectId}/storage/${this.bucket}${params}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        apikey: this.apiKey,
                    },
                }
            )

            const result = await parseApiEnvelope(response, z.array(storageObjectSchema))
            return {
                data: (result.data as StorageObjectRecord[] | null) || null,
                error: result.error ? { message: result.error.message } : null,
            }
        } catch (error) {
            return { data: null, error: { message: (error as Error).message } }
        }
    }

    getPublicUrl(path: string): { data: { publicUrl: string } } {
        return {
            data: {
                publicUrl: `${this.projectUrl}/api/v1/${this.projectId}/storage/${this.bucket}/${encodeStoragePath(path)}`,
            },
        }
    }

    async createSignedUrl(
        path: string,
        expiresIn: number
    ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }> {
        try {
            const token = this.getAccessToken() || this.apiKey
            const fetchFn = await getFetch()
            const response = await fetchFn(
                `${this.projectUrl}/api/v1/${this.projectId}/storage/signed`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        apikey: this.apiKey,
                    },
                    body: JSON.stringify({ bucket: this.bucket, path, expiresIn }),
                }
            )

            const result = await parseApiEnvelope(response, signedUrlSchema)
            return {
                data: result.data || null,
                error: result.error ? { message: result.error.message } : null,
            }
        } catch (error) {
            return { data: null, error: { message: (error as Error).message } }
        }
    }

    private resolveSessionUrl(url: string): string {
        const parsed = new URL(url)
        const projectOrigin = new URL(this.projectUrl).origin
        if (parsed.origin === projectOrigin) {
            return url
        }

        return `${projectOrigin}${parsed.pathname}${parsed.search}`
    }
}

function encodeStoragePath(path: string): string {
    return path
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/')
}

async function getFetch() {
    return typeof globalThis.fetch !== 'undefined' ? globalThis.fetch : (await import('cross-fetch')).default
}

async function toBlob(
    file: Blob | File | Uint8Array | ArrayBuffer,
    contentType?: string
): Promise<Blob> {
    if (file instanceof Blob) {
        return file
    }

    const bytes = file instanceof ArrayBuffer ? new Uint8Array(file) : file
    return new Blob([bytes as BlobPart], {
        type: contentType || 'application/octet-stream',
    })
}
