/**
 * Platform auth and Telegram OTP routes.
 */

import { randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import type Redis from 'ioredis'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { platformAuthMiddleware } from '../middleware/auth.js'
import { PlatformAuthService, PlatformUserRepository } from '../platform/index.js'

const BCRYPT_ROUNDS = 10

const authBodySchema = z.object({
    email: z.string().email(),
    password: z.string().min(8, 'Password must be at least 8 characters'),
})

const refreshBodySchema = z.object({
    refresh_token: z.string().min(1),
})

const telegramAuthSchema = z.object({
    phoneNumber: z.string().min(1),
})

const telegramVerifySchema = z.object({
    requestId: z.string().min(1),
    code: z.string().min(1),
    password: z.string().optional(),
})

export function registerPlatformRoutes(
    app: FastifyInstance,
    redis: Redis,
    jwtSecret: string,
    telegramApiId?: number,
    telegramApiHash?: string,
    options: { mockTelegram?: boolean; repository?: PlatformUserRepository } = {}
): void {
    const repository = options.repository ?? new PlatformUserRepository()
    const platformAuthService = new PlatformAuthService(redis, jwtSecret)
    const mockTelegram = options.mockTelegram === true

    app.post('/api/v1/platform/auth/signup', async (request, reply) => {
        const body = authBodySchema.safeParse(request.body)
        if (!body.success) {
            return reply.status(400).send({ error: { message: body.error.issues[0]?.message || 'Invalid input' } })
        }

        const existing = await repository.findByEmail(body.data.email)
        if (existing) {
            return reply.status(409).send({ error: { message: 'An account with this email already exists' } })
        }

        const user = {
            id: randomUUID(),
            email: body.data.email,
            passwordHash: await bcrypt.hash(body.data.password, BCRYPT_ROUNDS),
            createdAt: new Date().toISOString(),
        }

        await repository.createUser(user)
        const session = platformAuthService.issueSession({ id: user.id, email: user.email })

        return reply.status(201).send({
            data: {
                user: { id: user.id, email: user.email, created_at: user.createdAt },
                session,
            },
        })
    })

    app.post('/api/v1/platform/auth/signin', async (request, reply) => {
        const body = authBodySchema.safeParse(request.body)
        if (!body.success) {
            return reply.status(400).send({ error: { message: body.error.issues[0]?.message || 'Invalid input' } })
        }

        const user = await repository.findByEmail(body.data.email)
        if (!user) {
            return reply.status(401).send({ error: { message: 'Invalid email or password' } })
        }

        const valid = await bcrypt.compare(body.data.password, user.passwordHash)
        if (!valid) {
            return reply.status(401).send({ error: { message: 'Invalid email or password' } })
        }

        const session = platformAuthService.issueSession({ id: user.id, email: user.email })

        return reply.send({
            data: {
                user: { id: user.id, email: user.email, created_at: user.createdAt },
                session,
            },
        })
    })

    app.post('/api/v1/platform/auth/refresh', async (request, reply) => {
        const body = refreshBodySchema.safeParse(request.body)
        if (!body.success) {
            return reply.status(400).send({ error: { message: body.error.issues[0]?.message || 'Invalid input' } })
        }

        try {
            const session = await platformAuthService.refreshSession(body.data.refresh_token)
            return reply.send({ data: { session } })
        } catch (error) {
            return reply.status(401).send({ error: { message: (error as Error).message || 'Invalid refresh token' } })
        }
    })

    app.post('/api/v1/platform/auth/signout', async (request, reply) => {
        const body = refreshBodySchema.safeParse(request.body)
        if (!body.success) {
            return reply.status(400).send({ error: { message: body.error.issues[0]?.message || 'Invalid input' } })
        }

        await platformAuthService.signOut(body.data.refresh_token)
        return reply.send({ data: { message: 'Signed out' } })
    })

    app.post(
        '/api/v1/platform/telegram/auth',
        { preHandler: [platformAuthMiddleware] },
        async (request, reply) => {
            const body = telegramAuthSchema.safeParse(request.body)
            if (!body.success) {
                return reply.status(400).send({ error: { message: body.error.issues[0]?.message || 'Invalid input' } })
            }

            if (mockTelegram) {
                return reply.send({
                    data: {
                        requestId: randomUUID(),
                        timeout: 0,
                        sessionString: body.data.phoneNumber,
                        mock: true,
                    },
                })
            }

            if (!telegramApiId || !telegramApiHash) {
                return reply.status(500).send({ error: { message: 'Telegram API credentials not configured' } })
            }

            try {
                const client = new TelegramClient(
                    new StringSession(''),
                    telegramApiId,
                    telegramApiHash,
                    { connectionRetries: 5, useWSS: false }
                )

                await client.connect()
                const { Api } = await import('telegram/tl/index.js')
                const result = await client.invoke(
                    new Api.auth.SendCode({
                        phoneNumber: body.data.phoneNumber,
                        apiId: telegramApiId,
                        apiHash: telegramApiHash,
                        settings: new Api.CodeSettings({}),
                    })
                )

                const requestId = randomUUID()
                await redis.setex(
                    `platform:telegram:request:${requestId}`,
                    5 * 60,
                    JSON.stringify({
                        ownerId: request.user!.sub!,
                        phoneNumber: body.data.phoneNumber,
                        phoneCodeHash: (result as { phoneCodeHash: string }).phoneCodeHash,
                    })
                )

                await client.disconnect()

                return reply.send({
                    data: {
                        requestId,
                        timeout: (result as { timeout?: number }).timeout || 60,
                    },
                })
            } catch (error) {
                return reply.status(400).send({
                    error: { message: (error as Error).message || 'Failed to send OTP' },
                })
            }
        }
    )

    app.post(
        '/api/v1/platform/telegram/verify',
        { preHandler: [platformAuthMiddleware] },
        async (request, reply) => {
            const body = telegramVerifySchema.safeParse(request.body)
            if (!body.success) {
                return reply.status(400).send({ error: { message: body.error.issues[0]?.message || 'Invalid input' } })
            }

            if (mockTelegram) {
                return reply.send({
                    data: { sessionString: body.data.code },
                })
            }

            if (!telegramApiId || !telegramApiHash) {
                return reply.status(500).send({ error: { message: 'Telegram API credentials not configured' } })
            }

            const pending = await redis.get(`platform:telegram:request:${body.data.requestId}`)
            if (!pending) {
                return reply.status(400).send({
                    error: { message: 'No pending auth session for this request. Start the OTP flow again.' },
                })
            }

            const otpRequest = JSON.parse(pending) as {
                ownerId: string
                phoneNumber: string
                phoneCodeHash: string
            }

            if (otpRequest.ownerId !== request.user!.sub) {
                return reply.status(403).send({ error: { message: 'OTP request does not belong to this user' } })
            }

            const client = new TelegramClient(
                new StringSession(''),
                telegramApiId,
                telegramApiHash,
                { connectionRetries: 5, useWSS: false }
            )

            try {
                await client.connect()
                const Api = (await import('telegram/tl/index.js')).Api

                try {
                    await client.invoke(
                        new Api.auth.SignIn({
                            phoneNumber: otpRequest.phoneNumber,
                            phoneCodeHash: otpRequest.phoneCodeHash,
                            phoneCode: body.data.code,
                        })
                    )
                } catch (signInError: unknown) {
                    const error = signInError as { errorMessage?: string }
                    if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                        if (!body.data.password) {
                            return reply.status(400).send({
                                error: {
                                    message: 'Two-factor authentication required. Provide the password field.',
                                    code: '2FA_REQUIRED',
                                },
                            })
                        }

                        const passwordResult = await client.invoke(new Api.account.GetPassword())
                        const { computeCheck } = await import('telegram/Password.js')
                        const passwordCheck = await computeCheck(passwordResult, body.data.password)
                        await client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }))
                    } else {
                        throw signInError
                    }
                }

                const sessionString = (client.session as StringSession).save()
                await redis.del(`platform:telegram:request:${body.data.requestId}`)
                await client.disconnect()

                return reply.send({
                    data: { sessionString },
                })
            } catch (error) {
                await client.disconnect().catch(() => undefined)
                return reply.status(400).send({
                    error: { message: (error as Error).message || 'Failed to verify code' },
                })
            }
        }
    )
}
