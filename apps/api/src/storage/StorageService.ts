import jwt from 'jsonwebtoken'
import type {
    BucketPolicy,
    FileRef,
    StorageObjectMetadata,
    StorageObjectPolicy,
    StorageObjectRecord,
    TelegramChannelRef,
    TransformOptions,
    UploadOptions,
} from '@openbase/core'
import { ConflictError, ForbiddenError } from '@openbase/core'
import type { StorageProvider } from '@openbase/telegram'

const STORAGE_STREAM_PART_SIZE = 64 * 1024 * 1024

interface StorageManifest {
    __type: 'STORAGE_MANIFEST'
    path: string
    bucket: string
    bucketChannel: TelegramChannelRef
    fileRef: FileRef
    uploadedBy: string | null
    createdAt: number
    updatedAt: number
    size: number
    mimeType: string
    metadata: StorageObjectMetadata
    policy?: StorageObjectPolicy | null
}

interface StorageManifestRecord extends StorageObjectRecord {
    fileRef: FileRef
    manifestMessageId: number
}

export class StorageService {
    constructor(
        private readonly storageSecret: string,
        private readonly apiPublicUrl: string
    ) { }

    async upload(
        provider: StorageProvider,
        projectId: string,
        bucketName: string,
        bucketChannel: TelegramChannelRef,
        storageIndexChannel: TelegramChannelRef,
        path: string,
        data: Buffer,
        options: UploadOptions = {}
    ): Promise<{ path: string; publicUrl: string; fileRef: FileRef; metadata: StorageObjectMetadata; policy?: StorageObjectPolicy | null }> {
        return this.storeUpload(
            provider,
            projectId,
            bucketName,
            bucketChannel,
            storageIndexChannel,
            path,
            options,
            async mimeType => ({
                fileRef: await provider.uploadFile(bucketChannel, data, path, mimeType),
                size: data.length,
                mimeType,
            })
        )
    }

    async uploadStream(
        provider: StorageProvider,
        projectId: string,
        bucketName: string,
        bucketChannel: TelegramChannelRef,
        storageIndexChannel: TelegramChannelRef,
        path: string,
        stream: AsyncIterable<Buffer | Uint8Array>,
        options: UploadOptions = {}
    ): Promise<{ path: string; publicUrl: string; fileRef: FileRef; metadata: StorageObjectMetadata; policy?: StorageObjectPolicy | null }> {
        return this.storeUpload(
            provider,
            projectId,
            bucketName,
            bucketChannel,
            storageIndexChannel,
            path,
            options,
            async mimeType => {
                const partRefs: FileRef[] = []
                let pending: Buffer = Buffer.alloc(0)
                let totalSize = 0

                const flushPart = async (buffer: Buffer, index: number): Promise<void> => {
                    partRefs.push(
                        await provider.uploadFile(
                            bucketChannel,
                            buffer,
                            this.buildPartFilename(path, index),
                            mimeType
                        )
                    )
                }

                for await (const rawChunk of stream) {
                    const chunk: Buffer = Buffer.isBuffer(rawChunk)
                        ? Buffer.from(rawChunk)
                        : Buffer.from(rawChunk)
                    if (chunk.length === 0) {
                        continue
                    }

                    totalSize += chunk.length
                    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])

                    while (pending.length >= STORAGE_STREAM_PART_SIZE) {
                        const part = pending.subarray(0, STORAGE_STREAM_PART_SIZE)
                        await flushPart(Buffer.from(part), partRefs.length)
                        pending = pending.subarray(STORAGE_STREAM_PART_SIZE)
                    }
                }

                if (pending.length > 0 || partRefs.length === 0) {
                    await flushPart(Buffer.from(pending), partRefs.length)
                }

                const fileRef = partRefs.length === 1
                    ? partRefs[0]
                    : {
                        messageId: partRefs[0].messageId,
                        channel: bucketChannel,
                        filename: path,
                        mimeType,
                        size: totalSize,
                        parts: partRefs,
                    }

                return {
                    fileRef,
                    size: totalSize,
                    mimeType,
                }
            }
        )
    }

    async download(
        provider: StorageProvider,
        fileRef: FileRef,
        transformOptions?: TransformOptions
    ): Promise<{ data: Buffer; mimeType: string }> {
        let data = fileRef.parts?.length
            ? await this.downloadMultipartFile(provider, fileRef)
            : await provider.downloadFile(fileRef)
        let mimeType = fileRef.mimeType

        if (transformOptions && this.isImage(mimeType)) {
            const transformed = await this.applyTransforms(data, transformOptions)
            data = transformed.data
            mimeType = transformed.mimeType
        }

        return { data, mimeType }
    }

    async deleteFile(
        provider: StorageProvider,
        storageIndexChannel: TelegramChannelRef,
        manifestMessageId: number,
        fileRef: FileRef
    ): Promise<void> {
        if (fileRef.parts?.length) {
            for (const part of fileRef.parts) {
                await provider.deleteFile(part)
            }
        } else {
            await provider.deleteFile(fileRef)
        }

        await provider.deleteMessage(storageIndexChannel, manifestMessageId)
    }

    createSignedUrl(
        projectId: string,
        bucket: string,
        path: string,
        expiresIn: number
    ): string {
        const token = jwt.sign({ projectId, bucket, path }, this.storageSecret, { expiresIn })
        return `${this.apiPublicUrl}/api/v1/storage/signed?token=${token}`
    }

    verifySignedUrl(token: string): { projectId: string; bucket: string; path: string } {
        try {
            return jwt.verify(token, this.storageSecret) as {
                projectId: string
                bucket: string
                path: string
            }
        } catch {
            throw new ForbiddenError('Invalid or expired signed URL')
        }
    }

    async listFiles(
        provider: StorageProvider,
        storageIndexChannel: TelegramChannelRef,
        bucketName: string,
        bucketChannel: TelegramChannelRef,
        prefix?: string
    ): Promise<StorageObjectRecord[]> {
        const manifests = await this.getManifests(provider, storageIndexChannel, bucketName, bucketChannel, prefix)
        return manifests.map(manifest => this.toObjectRecord(manifest))
    }

    async findFile(
        provider: StorageProvider,
        storageIndexChannel: TelegramChannelRef,
        bucketName: string,
        bucketChannel: TelegramChannelRef,
        path: string
    ): Promise<{
        path: string
        size: number
        mimeType: string
        createdAt: number
        updatedAt: number
        uploadedBy: string | null
        metadata: StorageObjectMetadata
        policy?: StorageObjectPolicy | null
        fileRef: FileRef
        manifestMessageId: number
    } | null> {
        const manifests = await this.getManifests(provider, storageIndexChannel, bucketName, bucketChannel, path)
        return manifests.find(manifest => manifest.path === path) || null
    }

    async createBucket(
        provider: StorageProvider,
        name: string,
        _policy: BucketPolicy = { public: false }
    ): Promise<TelegramChannelRef> {
        return provider.createChannel(`__storage_${name}__`)
    }

    createBucketPolicy(options: { public: boolean }): BucketPolicy {
        return {
            public: options.public,
            read: options.public
                ? { public: true, roles: ['anon', 'authenticated', 'service_role', 'platform_user'] }
                : { roles: ['authenticated', 'service_role', 'platform_user'] },
            write: { roles: ['authenticated', 'service_role', 'platform_user'] },
            delete: { roles: ['authenticated', 'service_role', 'platform_user'] },
        }
    }

    async updateObject(
        provider: StorageProvider,
        storageIndexChannel: TelegramChannelRef,
        manifestMessageId: number,
        updates: {
            metadata?: Partial<StorageObjectMetadata> & {
                tags?: Record<string, string>
                customMetadata?: Record<string, string>
            }
            policy?: StorageObjectPolicy | null
        }
    ): Promise<StorageObjectRecord | null> {
        const raw = await provider.getMessage(storageIndexChannel, manifestMessageId)
        if (!raw) {
            return null
        }

        const manifest = JSON.parse(raw) as StorageManifest
        if (manifest.__type !== 'STORAGE_MANIFEST') {
            return null
        }

        const nextMetadata: StorageObjectMetadata = {
            ...manifest.metadata,
            ...(updates.metadata || {}),
            tags: updates.metadata?.tags ?? manifest.metadata.tags,
            customMetadata: updates.metadata?.customMetadata ?? manifest.metadata.customMetadata,
            updatedAt: Date.now(),
        }

        const nextManifest: StorageManifest = {
            ...manifest,
            updatedAt: nextMetadata.updatedAt,
            metadata: nextMetadata,
            ...(updates.policy !== undefined ? { policy: updates.policy } : {}),
        }

        await provider.editMessage(storageIndexChannel, manifestMessageId, JSON.stringify(nextManifest))
        return this.toObjectRecord(nextManifest)
    }

    private async storeUpload(
        provider: StorageProvider,
        projectId: string,
        bucketName: string,
        bucketChannel: TelegramChannelRef,
        storageIndexChannel: TelegramChannelRef,
        path: string,
        options: UploadOptions,
        uploadFile: (mimeType: string) => Promise<{ fileRef: FileRef; size: number; mimeType: string }>
    ): Promise<{ path: string; publicUrl: string; fileRef: FileRef; metadata: StorageObjectMetadata; policy?: StorageObjectPolicy | null }> {
        const mimeType = options.mimeType || 'application/octet-stream'

        const existing = await this.findFile(
            provider,
            storageIndexChannel,
            bucketName,
            bucketChannel,
            path
        )

        if (existing && !options.upsert) {
            throw new ConflictError(`File "${path}" already exists in bucket "${bucketName}"`)
        }

        if (existing && options.upsert) {
            await this.deleteFile(
                provider,
                storageIndexChannel,
                existing.manifestMessageId,
                existing.fileRef
            )
        }

        const uploaded = await uploadFile(mimeType)
        const now = Date.now()
        const metadata: StorageObjectMetadata = {
            contentType: uploaded.mimeType,
            size: uploaded.size,
            createdAt: now,
            updatedAt: now,
            ...(options.metadata?.tags ? { tags: options.metadata.tags } : {}),
            ...(options.metadata?.customMetadata ? { customMetadata: options.metadata.customMetadata } : {}),
        }
        const manifest: StorageManifest = {
            __type: 'STORAGE_MANIFEST',
            path,
            bucket: bucketName,
            bucketChannel,
            fileRef: uploaded.fileRef,
            uploadedBy: options.userId || null,
            createdAt: now,
            updatedAt: now,
            size: uploaded.size,
            mimeType: uploaded.mimeType,
            metadata,
            policy: options.policy ?? null,
        }

        await provider.sendMessage(storageIndexChannel, JSON.stringify(manifest))

        return {
            path,
            publicUrl: `${this.apiPublicUrl}/api/v1/${projectId}/storage/${bucketName}/${path.split('/').map(encodeURIComponent).join('/')}`,
            fileRef: uploaded.fileRef,
            metadata,
            ...(options.policy ? { policy: options.policy } : {}),
        }
    }

    private async getManifests(
        provider: StorageProvider,
        storageIndexChannel: TelegramChannelRef,
        bucketName: string,
        bucketChannel: TelegramChannelRef,
        prefix?: string
    ): Promise<StorageManifestRecord[]> {
        const messages = await this.getAllMessages(provider, storageIndexChannel)

        return messages
            .map<StorageManifestRecord | null>(message => {
                try {
                    const manifest = JSON.parse(message.text) as StorageManifest
                    if (manifest.__type !== 'STORAGE_MANIFEST') return null
                    if (manifest.bucket !== bucketName) return null
                    if (manifest.bucketChannel.id !== bucketChannel.id) return null
                    if (prefix && !manifest.path.startsWith(prefix)) return null

                    return {
                        path: manifest.path,
                        size: manifest.size,
                        mimeType: manifest.mimeType,
                        createdAt: manifest.createdAt,
                        updatedAt: manifest.updatedAt ?? manifest.createdAt,
                        uploadedBy: manifest.uploadedBy,
                        policy: manifest.policy ?? null,
                        metadata: manifest.metadata ?? {
                            contentType: manifest.mimeType,
                            size: manifest.size,
                            createdAt: manifest.createdAt,
                            updatedAt: manifest.updatedAt ?? manifest.createdAt,
                        },
                        fileRef: manifest.fileRef,
                        manifestMessageId: message.id,
                    }
                } catch {
                    return null
                }
            })
            .filter((manifest): manifest is StorageManifestRecord => manifest !== null)
    }

    private async getAllMessages(
        provider: StorageProvider,
        channel: TelegramChannelRef
    ): Promise<Array<{ id: number; text: string; date: number }>> {
        const messages: Array<{ id: number; text: string; date: number }> = []
        let offsetId: number | undefined

        while (true) {
            const page = await provider.getMessages(channel, { limit: 200, offsetId })
            if (page.length === 0) {
                break
            }

            messages.push(...page)

            if (page.length < 200) {
                break
            }

            offsetId = page[page.length - 1]?.id
        }

        return messages
    }

    private async downloadMultipartFile(
        provider: StorageProvider,
        fileRef: FileRef
    ): Promise<Buffer> {
        const buffers: Buffer[] = []

        for (const part of fileRef.parts || []) {
            buffers.push(await provider.downloadFile(part))
        }

        return Buffer.concat(buffers, fileRef.size)
    }

    private buildPartFilename(path: string, index: number): string {
        return `${path}.part${String(index + 1).padStart(6, '0')}`
    }

    private toObjectRecord(manifest: {
        path: string
        size: number
        mimeType: string
        createdAt: number
        updatedAt: number
        uploadedBy: string | null
        metadata: StorageObjectMetadata
        policy?: StorageObjectPolicy | null
    }): StorageObjectRecord {
        return {
            path: manifest.path,
            size: manifest.size,
            mimeType: manifest.mimeType,
            createdAt: manifest.createdAt,
            updatedAt: manifest.updatedAt,
            uploadedBy: manifest.uploadedBy,
            metadata: manifest.metadata,
            policy: manifest.policy ?? null,
        }
    }

    private isImage(mimeType: string): boolean {
        return mimeType.startsWith('image/')
    }

    private async applyTransforms(
        data: Buffer,
        options: TransformOptions
    ): Promise<{ data: Buffer; mimeType: string }> {
        const { default: sharp } = await import('sharp')
        let transform = sharp(data)

        const width = options.width && options.width > 0 ? options.width : undefined
        const height = options.height && options.height > 0 ? options.height : undefined

        if (width || height) {
            transform = transform.resize(width, height, { fit: 'cover' })
        }

        let mimeType = 'image/png'
        if (options.format) {
            transform = transform.toFormat(options.format, { quality: options.quality || 80 })
            mimeType = `image/${options.format}`
        }

        return {
            data: await transform.toBuffer(),
            mimeType,
        }
    }
}
