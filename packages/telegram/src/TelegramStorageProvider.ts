/**
 * @openbase/telegram — TelegramStorageProvider
 *
 * Implements StorageProvider using GramJS (MTProto API).
 * Includes rate limiting, message chaining for >4000 chars,
 * and file chunking for >1.9GB files.
 */

import { Api, Logger, TelegramClient } from 'telegram'
import { LogLevel } from 'telegram/extensions/Logger.js'
import { returnBigInt } from 'telegram/Helpers.js'
import { NewMessage } from 'telegram/events/index.js'
import { DeletedMessage } from 'telegram/events/DeletedMessage.js'
import { EditedMessage } from 'telegram/events/EditedMessage.js'
import { CustomFile } from 'telegram/client/uploads.js'
import { StringSession } from 'telegram/sessions/index.js'
import type { FileRef, GetMessagesOptions, TelegramChannelRef, TelegramMessage } from '@openbase/core'
import { StorageProviderError, generateId, sleep } from '@openbase/core'
import type { EventedStorageProvider } from './StorageProvider.js'

/** Maximum message length in Telegram */
const MAX_MESSAGE_LENGTH = 4000

/** Maximum file size for a single upload (1.9 GB) */
const CHUNK_SIZE = 1.9 * 1024 * 1024 * 1024

/** Chain message header markers */
const CHAIN_START = '__CHAIN_START__'
const CHAIN_PART = '__CHAIN__'

/** File manifest marker */
const FILE_MANIFEST = '__MANIFEST__'

type ChannelInput = TelegramChannelRef | string

interface MessageSubscription {
    channels: ChannelInput[]
    handler: (channelId: string, messageId: number, text: string) => void
}

interface DeleteSubscription {
    channels: ChannelInput[]
    handler: (channelId: string, messageIds: number[]) => void
}

/**
 * Telegram-backed implementation of the StorageProvider interface.
 * Uses private channels as "tables" and messages as "rows".
 */
export class TelegramStorageProvider implements EventedStorageProvider {
    private client!: TelegramClient
    private session!: StringSession
    private connected = false
    private readonly apiId: number
    private readonly apiHash: string
    private readonly newMessageSubscriptions: MessageSubscription[] = []
    private readonly editedMessageSubscriptions: MessageSubscription[] = []
    private readonly deletedMessageSubscriptions: DeleteSubscription[] = []

    constructor(apiId: number, apiHash: string) {
        this.apiId = apiId
        this.apiHash = apiHash
    }

    /** Connect to Telegram using a saved session string */
    async connect(sessionString: string): Promise<void> {
        if (this.connected) {
            return
        }

        this.session = new StringSession(sessionString)
        const baseLogger = new Logger(LogLevel.NONE)
        this.client = new TelegramClient(this.session, this.apiId, this.apiHash, {
            connectionRetries: 5,
            useWSS: false,
            baseLogger,
        })
        this.client.onError = async error => {
            if (error.message === 'TIMEOUT') {
                return
            }

            console.error(error)
        }

        await this.client.connect()

        if (!this.client.connected) {
            await this.client.connect()
        }

        this.connected = true
        this.attachStoredHandlers()
    }

    /** Disconnect from Telegram */
    async disconnect(): Promise<void> {
        if (this.client && this.connected) {
            await this.client.disconnect()
            this.connected = false
        }
    }

    /** Check if connected */
    isConnected(): boolean {
        return this.connected
    }

    /** Create a private channel and return its persisted ref */
    async createChannel(name: string): Promise<TelegramChannelRef> {
        return this.rateLimitedCall(async () => {
            const result = await this.client.invoke(
                new Api.channels.CreateChannel({
                    title: name,
                    about: `OpenBase table: ${name}`,
                    megagroup: false,
                    broadcast: true,
                })
            )

            const updates = result as Api.Updates
            const channel = updates.chats[0] as Api.Channel
            return this.toChannelRef(channel)
        })
    }

    /** Delete a channel by ref */
    async deleteChannel(channel: ChannelInput): Promise<void> {
        return this.rateLimitedCall(async () => {
            const entity = await this.resolveChannel(channel)
            await this.client.invoke(
                new Api.channels.DeleteChannel({ channel: entity })
            )
        })
    }

    /**
     * Send a message to a channel. If the content exceeds the max length,
     * it is split into chained messages.
     */
    async sendMessage(channel: ChannelInput, content: string): Promise<number> {
        return this.rateLimitedCall(async () => {
            const entity = await this.resolveChannel(channel)

            if (content.length <= MAX_MESSAGE_LENGTH) {
                const result = await this.client.sendMessage(entity, { message: content })
                return result.id
            }

            return this.sendChainedMessage(entity, content)
        })
    }

    /** Edit an existing message */
    async editMessage(channel: ChannelInput, messageId: number, content: string): Promise<void> {
        return this.rateLimitedCall(async () => {
            const entity = await this.resolveChannel(channel)
            const existingMessage = await this.fetchMessageById(entity, messageId)
            const existingText = existingMessage?.text || ''
            await this.deleteChainParts(entity, messageId, existingText)

            if (content.length <= MAX_MESSAGE_LENGTH) {
                await this.client.editMessage(entity, {
                    message: messageId,
                    text: content,
                })
                return
            }

            const chainId = generateId()
            const parts = this.splitContent(content)
            const header = JSON.stringify({ total: parts.length, chainId })
            await this.client.editMessage(entity, {
                message: messageId,
                text: `${CHAIN_START}${header}\n${parts[0]}`,
            })

            for (let index = 1; index < parts.length; index++) {
                const partHeader = JSON.stringify({ chainId, index, parentId: messageId })
                await this.client.sendMessage(entity, {
                    message: `${CHAIN_PART}${partHeader}\n${parts[index]}`,
                })
                await sleep(200 + Math.random() * 200)
            }
        })
    }

    /** Delete a message from a channel */
    async deleteMessage(channel: ChannelInput, messageId: number): Promise<void> {
        return this.rateLimitedCall(async () => {
            const entity = await this.resolveChannel(channel)
            const existingMessage = await this.fetchMessageById(entity, messageId)
            await this.deleteChainParts(entity, messageId, existingMessage?.text || '')
            await this.client.deleteMessages(entity, [messageId], { revoke: true })
        })
    }

    /** Get a single message's text by ID */
    async getMessage(channel: ChannelInput, messageId: number): Promise<string | null> {
        return this.rateLimitedCall(async () => {
            const entity = await this.resolveChannel(channel)
            const message = await this.fetchMessageById(entity, messageId)
            if (!message) {
                return null
            }

            const text = message.text || ''

            if (text.startsWith(CHAIN_START)) {
                return this.reconstructChainedMessage(entity, message.id, text)
            }

            return text
        })
    }

    /** Get multiple messages with pagination options */
    async getMessages(channel: ChannelInput, options: GetMessagesOptions): Promise<TelegramMessage[]> {
        return this.rateLimitedCall(async () => {
            const entity = await this.resolveChannel(channel)
            const messages = await this.client.getMessages(entity, {
                limit: options.limit || 100,
                offsetId: options.offsetId,
                minId: options.minId,
                maxId: options.maxId,
            })

            const reconstructed = await Promise.all(
                messages.map(async message => {
                    if (!message || !message.text || message.text.startsWith(CHAIN_PART)) {
                        return null
                    }

                    const text = message.text.startsWith(CHAIN_START)
                        ? await this.reconstructChainedMessage(entity, message.id, message.text)
                        : message.text

                    return {
                        id: message.id,
                        text,
                        date: this.toTimestamp(message.date),
                    }
                })
            )

            return reconstructed.filter((message): message is TelegramMessage => message !== null)
        })
    }

    /** Upload a file to a channel. Large files are chunked. */
    async uploadFile(
        channel: ChannelInput,
        data: Buffer,
        filename: string,
        mimeType: string
    ): Promise<FileRef> {
        return this.rateLimitedCall(async () => {
            const entity = await this.resolveChannel(channel)
            const channelRef = await this.ensureChannelRef(channel)

            if (data.length <= CHUNK_SIZE) {
                const file = new CustomFile(filename, data.length, '', data)
                const result = await this.client.sendFile(entity, {
                    file,
                    caption: JSON.stringify({ filename, mimeType, size: data.length }),
                    forceDocument: true,
                })

                return {
                    messageId: result.id,
                    channel: channelRef,
                    filename,
                    mimeType,
                    size: data.length,
                }
            }

            const chunks = this.splitBuffer(data, CHUNK_SIZE)
            const chunkMessageIds: number[] = []

            for (const chunk of chunks) {
                const chunkFile = new CustomFile(`${filename}.part${chunkMessageIds.length}`, chunk.length, '', chunk)
                const result = await this.client.sendFile(entity, {
                    file: chunkFile,
                    caption: `__CHUNK__${chunkMessageIds.length}`,
                    forceDocument: true,
                })
                chunkMessageIds.push(result.id)
                await sleep(500)
            }

            const manifest = JSON.stringify({
                filename,
                mimeType,
                size: data.length,
                chunks: chunkMessageIds,
            })
            const manifestResult = await this.client.sendMessage(entity, {
                message: `${FILE_MANIFEST}${manifest}`,
            })

            return {
                messageId: manifestResult.id,
                channel: channelRef,
                filename,
                mimeType,
                size: data.length,
                chunks: chunkMessageIds,
            }
        })
    }

    /** Download a file by its reference */
    async downloadFile(fileRef: FileRef): Promise<Buffer> {
        return this.rateLimitedCall(async () => {
            const entity = await this.resolveChannel(fileRef.channel)

            if (!fileRef.chunks || fileRef.chunks.length === 0) {
                const messages = await this.client.getMessages(entity, { ids: [fileRef.messageId] })
                if (!messages[0]?.media) {
                    throw new StorageProviderError('File not found')
                }
                return await this.client.downloadMedia(messages[0].media) as Buffer
            }

            const buffers: Buffer[] = []
            for (const chunkId of fileRef.chunks) {
                const messages = await this.client.getMessages(entity, { ids: [chunkId] })
                if (!messages[0]?.media) {
                    throw new StorageProviderError(`Chunk ${chunkId} not found`)
                }
                const buffer = await this.client.downloadMedia(messages[0].media) as Buffer
                buffers.push(buffer)
                await sleep(300)
            }

            return Buffer.concat(buffers)
        })
    }

    /** Delete a file (and all its chunks) */
    async deleteFile(fileRef: FileRef): Promise<void> {
        return this.rateLimitedCall(async () => {
            const entity = await this.resolveChannel(fileRef.channel)
            const idsToDelete = [fileRef.messageId]

            if (fileRef.chunks) {
                idsToDelete.push(...fileRef.chunks)
            }

            await this.client.deleteMessages(entity, idsToDelete, { revoke: true })
        })
    }

    /**
     * Add an event handler for new messages in specified channels.
     * Used by the realtime layer to detect new rows.
     */
    addNewMessageHandler(
        channels: ChannelInput[],
        handler: (channelId: string, messageId: number, text: string) => void
    ): void {
        this.requireConnected()
        this.newMessageSubscriptions.push({ channels, handler })
        this.attachNewMessageHandler(channels, handler)
    }

    /** Add an event handler for edited messages. */
    addEditedMessageHandler(
        channels: ChannelInput[],
        handler: (channelId: string, messageId: number, text: string) => void
    ): void {
        this.requireConnected()
        this.editedMessageSubscriptions.push({ channels, handler })
        this.attachEditedMessageHandler(channels, handler)
    }

    /** Add an event handler for deleted messages. */
    addDeletedMessageHandler(
        channels: ChannelInput[],
        handler: (channelId: string, messageIds: number[]) => void
    ): void {
        this.requireConnected()
        this.deletedMessageSubscriptions.push({ channels, handler })
        this.attachDeletedMessageHandler(channels, handler)
    }

    /** Get the current session string (for saving) */
    getSessionString(): string {
        return this.session.save()
    }

    /**
     * Throw a clear error if connect() has not been called yet.
     * This prevents cryptic "Cannot read properties of undefined" crashes.
     */
    private requireConnected(): void {
        if (!this.client || !this.connected) {
            throw new StorageProviderError(
                'Telegram client not connected. Call connect(sessionString) first.'
            )
        }
    }

    /** Resolve a channel ref to an InputChannel entity */
    private async resolveChannel(channel: ChannelInput): Promise<Api.InputChannel> {
        try {
            if (typeof channel !== 'string' && channel.accessHash) {
                return new Api.InputChannel({
                    channelId: returnBigInt(channel.id),
                    accessHash: returnBigInt(channel.accessHash),
                })
            }

            const entity = await this.client.getEntity(this.getChannelId(channel))
            if (entity instanceof Api.Channel) {
                return new Api.InputChannel({
                    channelId: entity.id,
                    accessHash: entity.accessHash!,
                })
            }

            throw new StorageProviderError(`Entity ${this.getChannelId(channel)} is not a channel`)
        } catch (error) {
            if (error instanceof StorageProviderError) throw error
            throw new StorageProviderError(
                `Failed to resolve channel ${this.getChannelId(channel)}: ${(error as Error).message}`
            )
        }
    }

    private async ensureChannelRef(channel: ChannelInput): Promise<TelegramChannelRef> {
        if (typeof channel !== 'string') {
            return channel
        }

        const entity = await this.client.getEntity(channel)
        if (!(entity instanceof Api.Channel)) {
            throw new StorageProviderError(`Entity ${channel} is not a channel`)
        }

        return this.toChannelRef(entity)
    }

    private toChannelRef(channel: Api.Channel): TelegramChannelRef {
        if (!channel.accessHash) {
            throw new StorageProviderError(`Channel ${channel.id.toString()} is missing access hash`)
        }

        return {
            id: channel.id.toString(),
            accessHash: channel.accessHash.toString(),
        }
    }

    private getChannelId(channel: ChannelInput): string {
        return typeof channel === 'string' ? channel : channel.id
    }

    private attachStoredHandlers(): void {
        for (const subscription of this.newMessageSubscriptions) {
            this.attachNewMessageHandler(subscription.channels, subscription.handler)
        }

        for (const subscription of this.editedMessageSubscriptions) {
            this.attachEditedMessageHandler(subscription.channels, subscription.handler)
        }

        for (const subscription of this.deletedMessageSubscriptions) {
            this.attachDeletedMessageHandler(subscription.channels, subscription.handler)
        }
    }

    private attachNewMessageHandler(
        channels: ChannelInput[],
        handler: (channelId: string, messageId: number, text: string) => void
    ): void {
        const channelIds = channels.map(channel => this.getChannelId(channel))
        this.client.addEventHandler(
            (event: { message?: Api.Message }) => {
                const message = event.message
                if (!message || !message.peerId) return

                const peerId = message.peerId as Api.PeerChannel
                const channelId = String(peerId.channelId)
                if (channelIds.includes(channelId)) {
                    handler(channelId, message.id, message.text || '')
                }
            },
            new NewMessage({})
        )
    }

    private attachEditedMessageHandler(
        channels: ChannelInput[],
        handler: (channelId: string, messageId: number, text: string) => void
    ): void {
        const channelIds = channels.map(channel => this.getChannelId(channel))
        this.client.addEventHandler(
            (event: { message?: Api.Message }) => {
                const message = event.message
                if (!message || !message.peerId) return

                const peerId = message.peerId as Api.PeerChannel
                const channelId = String(peerId.channelId)
                if (channelIds.includes(channelId)) {
                    handler(channelId, message.id, message.text || '')
                }
            },
            new EditedMessage({})
        )
    }

    private attachDeletedMessageHandler(
        channels: ChannelInput[],
        handler: (channelId: string, messageIds: number[]) => void
    ): void {
        const channelIds = channels.map(channel => this.getChannelId(channel))
        this.client.addEventHandler(
            (event: { deletedIds?: number[]; peer?: Api.TypePeer }) => {
                const peer = event.peer as Api.PeerChannel | undefined
                if (!peer || !event.deletedIds?.length) return

                const channelId = String(peer.channelId)
                if (channelIds.includes(channelId)) {
                    handler(channelId, event.deletedIds)
                }
            },
            new DeletedMessage({})
        )
    }

    private toTimestamp(value: Date | number | undefined): number {
        if (typeof value === 'number') {
            return value
        }

        if (value instanceof Date) {
            return value.getTime()
        }

        return 0
    }

    /**
     * Send a chained message for content > MAX_MESSAGE_LENGTH.
     * The first message contains a CHAIN_START header, and subsequent
     * messages contain CHAIN_PART headers with sequential indexes.
     */
    private async sendChainedMessage(entity: Api.InputChannel, content: string): Promise<number> {
        const chainId = generateId()
        const parts = this.splitContent(content)
        const total = parts.length

        const header = JSON.stringify({ total, chainId })
        const firstResult = await this.client.sendMessage(entity, {
            message: `${CHAIN_START}${header}\n${parts[0]}`,
        })

        for (let index = 1; index < parts.length; index++) {
            const partHeader = JSON.stringify({ chainId, index, parentId: firstResult.id })
            await this.client.sendMessage(entity, {
                message: `${CHAIN_PART}${partHeader}\n${parts[index]}`,
            })
            await sleep(200 + Math.random() * 200)
        }

        return firstResult.id
    }

    /** Reconstruct a chained message from its parts */
    private async reconstructChainedMessage(entity: Api.InputChannel, parentMessageId: number, firstText: string): Promise<string> {
        const header = this.parseChainStart(firstText)
        if (!header) {
            return firstText
        }

        const parts: string[] = new Array(header.total)
        parts[0] = header.content

        if (header.total === 1) {
            return header.content
        }

        let collected = 1
        let offsetId: number | undefined

        while (collected < header.total) {
            const page = await this.client.getMessages(entity, {
                limit: 200,
                offsetId,
                minId: parentMessageId,
            })

            if (!page.length) {
                break
            }

            for (const message of page) {
                const part = this.parseChainPart(message.text || '')
                if (!part) {
                    continue
                }

                const parentMatches = part.parentId === undefined || part.parentId === parentMessageId
                if (part.chainId !== header.chainId || !parentMatches) {
                    continue
                }

                if (parts[part.index] === undefined) {
                    parts[part.index] = part.content
                    collected += 1
                }
            }

            if (page.length < 200) {
                break
            }

            offsetId = page[page.length - 1]?.id
        }

        return parts.filter(part => part !== undefined).join('')
    }

    /** Delete chain parts associated with a parent message */
    private async deleteChainParts(entity: Api.InputChannel, parentMessageId: number, firstText = ''): Promise<void> {
        const chainStart = this.parseChainStart(firstText)
        const idsToDelete: number[] = []
        let offsetId: number | undefined

        while (true) {
            const page = await this.client.getMessages(entity, {
                limit: 200,
                offsetId,
                minId: parentMessageId,
            })

            if (!page.length) {
                break
            }

            for (const message of page) {
                const part = this.parseChainPart(message.text || '')
                if (!part) {
                    continue
                }

                const parentMatches = part.parentId === parentMessageId
                const chainMatches = chainStart?.chainId && part.chainId === chainStart.chainId
                if (parentMatches || chainMatches) {
                    idsToDelete.push(message.id)
                }
            }

            if (page.length < 200) {
                break
            }

            offsetId = page[page.length - 1]?.id
        }

        if (idsToDelete.length > 0) {
            await this.client.deleteMessages(entity, idsToDelete, { revoke: true })
        }
    }

    private async fetchMessageById(entity: Api.InputChannel, messageId: number): Promise<Api.Message | null> {
        const messages = await this.client.getMessages(entity, { ids: [messageId] })
        if (!messages || messages.length === 0 || !messages[0]) {
            return null
        }

        return messages[0]
    }

    private parseChainStart(text: string): { total: number; chainId: string; content: string } | null {
        if (!text.startsWith(CHAIN_START)) {
            return null
        }

        try {
            const headerEnd = text.indexOf('\n')
            const headerJson = text.slice(CHAIN_START.length, headerEnd)
            const header = JSON.parse(headerJson) as { total: number; chainId: string }
            return {
                total: header.total,
                chainId: header.chainId,
                content: text.slice(headerEnd + 1),
            }
        } catch {
            return null
        }
    }

    private parseChainPart(text: string): { chainId: string; index: number; parentId?: number; content: string } | null {
        if (!text.startsWith(CHAIN_PART)) {
            return null
        }

        try {
            const headerEnd = text.indexOf('\n')
            const headerJson = text.slice(CHAIN_PART.length, headerEnd)
            const header = JSON.parse(headerJson) as { chainId: string; index: number; parentId?: number }
            return {
                chainId: header.chainId,
                index: header.index,
                parentId: header.parentId,
                content: text.slice(headerEnd + 1),
            }
        } catch {
            return null
        }
    }

    /** Split content into chunks of MAX_MESSAGE_LENGTH */
    private splitContent(content: string): string[] {
        const parts: string[] = []
        const effectiveMax = MAX_MESSAGE_LENGTH - 200

        for (let index = 0; index < content.length; index += effectiveMax) {
            parts.push(content.slice(index, index + effectiveMax))
        }

        return parts
    }

    /** Split a buffer into chunks of the specified size */
    private splitBuffer(data: Buffer, chunkSize: number): Buffer[] {
        const chunks: Buffer[] = []
        for (let index = 0; index < data.length; index += chunkSize) {
            chunks.push(data.subarray(index, index + chunkSize))
        }
        return chunks
    }

    /**
     * Behavioural mimicry — add human-like delays between API calls
     * to reduce the chance of Telegram flagging the account.
     */
    private async rateLimitedCall<T>(fn: () => Promise<T>): Promise<T> {
        this.requireConnected()
        const delay = 200 + Math.random() * 300
        await sleep(delay)

        try {
            return await fn()
        } catch (error: unknown) {
            const err = error as Error
            const floodMatch = err.message?.match(/FLOOD_WAIT_(\d+)/)
            if (floodMatch) {
                const waitSeconds = parseInt(floodMatch[1], 10)
                await sleep(waitSeconds * 1000)
                return fn()
            }
            throw new StorageProviderError(`Telegram API error: ${err.message}`)
        }
    }
}
