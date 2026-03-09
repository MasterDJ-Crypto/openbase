import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestAppContext } from './helpers/testApp.js'
import { createTestApp } from './helpers/testApp.js'

describe('Phase 3 data plane integrations', () => {
    let context: TestAppContext

    beforeEach(async () => {
        context = await createTestApp()
    })

    afterEach(async () => {
        await context.close()
    })

    it('supports signed resumable uploads with metadata and per-object policies', async () => {
        const owner = await signUpPlatform(context, 'storage-owner@example.com')
        const project = await createProject(context, owner.access_token, 'Storage Phase 3')
        const alice = await signInUser(context, project.id, 'alice-storage@example.com')
        const bob = await signInUser(context, project.id, 'bob-storage@example.com')

        const bucketResponse = await context.app.inject({
            method: 'POST',
            url: `/api/v1/${project.id}/storage/buckets`,
            headers: authHeaders(project.serviceRoleKey),
            payload: { name: 'assets', public: false },
        })
        expect(bucketResponse.statusCode).toBe(201)

        const sessionResponse = await context.app.inject({
            method: 'POST',
            url: `/api/v1/${project.id}/storage/uploads`,
            headers: authHeaders(alice.access_token),
            payload: {
                bucket: 'assets',
                path: 'reports/q1.txt',
                mimeType: 'text/plain',
                totalSize: 11,
                metadata: {
                    tags: { environment: 'test' },
                    customMetadata: { quarter: 'q1' },
                },
                policy: {
                    rules: [
                        {
                            effect: 'deny',
                            actions: ['read'],
                            expression: 'auth.userId != object.ownerId && auth.role != "service_role"',
                        },
                    ],
                },
            },
        })
        expect(sessionResponse.statusCode).toBe(201)

        const session = readJson(sessionResponse).data as {
            uploadUrl: string
            completeUrl: string
        }
        const uploadPath = toInjectedPath(session.uploadUrl)
        const completePath = toInjectedPath(session.completeUrl)

        const firstChunk = await context.app.inject({
            method: 'PATCH',
            url: uploadPath,
            headers: {
                'content-type': 'application/octet-stream',
                'x-openbase-upload-offset': '0',
            },
            payload: Buffer.from('hello '),
        })
        expect(firstChunk.statusCode).toBe(200)

        const secondChunk = await context.app.inject({
            method: 'PATCH',
            url: uploadPath,
            headers: {
                'content-type': 'application/octet-stream',
                'x-openbase-upload-offset': '6',
            },
            payload: Buffer.from('world'),
        })
        expect(secondChunk.statusCode).toBe(200)

        const completeResponse = await context.app.inject({
            method: 'POST',
            url: completePath,
        })
        expect(completeResponse.statusCode).toBe(201)

        const metadataResponse = await context.app.inject({
            method: 'GET',
            url: `/api/v1/${project.id}/storage/assets/metadata/reports/q1.txt`,
            headers: authHeaders(alice.access_token),
        })
        expect(metadataResponse.statusCode).toBe(200)
        const metadata = readJson(metadataResponse).data
        expect(metadata.metadata.tags.environment).toBe('test')
        expect(metadata.metadata.customMetadata.quarter).toBe('q1')

        const bobRead = await context.app.inject({
            method: 'GET',
            url: `/api/v1/${project.id}/storage/assets/reports/q1.txt`,
            headers: authHeaders(bob.access_token),
        })
        expect(bobRead.statusCode).toBe(403)

        const aliceRead = await context.app.inject({
            method: 'GET',
            url: `/api/v1/${project.id}/storage/assets/reports/q1.txt`,
            headers: authHeaders(alice.access_token),
        })
        expect(aliceRead.statusCode).toBe(200)
        expect(aliceRead.body).toBe('hello world')
    })

    it('rolls back failed transactions and enforces optimistic locks', async () => {
        const owner = await signUpPlatform(context, 'tx-owner@example.com')
        const project = await createProject(context, owner.access_token, 'Transactions Phase 3')

        await createTable(context, project.id, project.serviceRoleKey, {
            tableName: 'accounts',
            columns: [
                { name: 'id', type: 'uuid', required: true, unique: true },
                { name: 'balance', type: 'number', required: true },
            ],
            indexes: ['id'],
        })

        const seedResponse = await context.app.inject({
            method: 'POST',
            url: `/api/v1/${project.id}/tables/accounts`,
            headers: authHeaders(project.serviceRoleKey),
            payload: [
                { id: 'acct-1', balance: 100 },
                { id: 'acct-2', balance: 40 },
            ],
        })
        expect(seedResponse.statusCode).toBe(201)

        const rowsResponse = await context.app.inject({
            method: 'GET',
            url: `/api/v1/${project.id}/tables/accounts`,
            headers: authHeaders(project.serviceRoleKey),
        })
        const rows = readJson(rowsResponse).data as Array<{ id: string; _msgId: number }>
        const acct1 = rows.find(row => row.id === 'acct-1')
        expect(acct1?._msgId).toBeTruthy()

        const conflictResponse = await context.app.inject({
            method: 'POST',
            url: `/api/v1/${project.id}/transactions`,
            headers: authHeaders(project.serviceRoleKey),
            payload: {
                operations: [
                    {
                        type: 'update',
                        table: 'accounts',
                        patch: { balance: 0 },
                        condition: {
                            filters: [{ column: 'id', operator: 'eq', value: 'acct-1' }],
                            expectedCount: 1,
                            ifMatchMessageIds: [acct1!._msgId],
                        },
                    },
                    {
                        type: 'insert',
                        table: 'accounts',
                        values: [{ id: 'acct-1', balance: 200 }],
                    },
                ],
            },
        })
        expect(conflictResponse.statusCode).toBe(409)

        const rollbackCheck = await context.app.inject({
            method: 'GET',
            url: `/api/v1/${project.id}/tables/accounts?id=eq.acct-1`,
            headers: authHeaders(project.serviceRoleKey),
        })
        expect(readJson(rollbackCheck).data[0].balance).toBe(100)

        const staleLockResponse = await context.app.inject({
            method: 'POST',
            url: `/api/v1/${project.id}/transactions`,
            headers: authHeaders(project.serviceRoleKey),
            payload: {
                operations: [
                    {
                        type: 'update',
                        table: 'accounts',
                        patch: { balance: 80 },
                        condition: {
                            filters: [{ column: 'id', operator: 'eq', value: 'acct-1' }],
                            expectedCount: 1,
                            ifMatchMessageIds: [999999],
                        },
                    },
                ],
            },
        })
        expect(staleLockResponse.statusCode).toBe(409)
    })
})

async function signUpPlatform(context: TestAppContext, email: string) {
    const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/platform/auth/signup',
        payload: { email, password: 'password123' },
    })

    return readJson(response).data.session as { access_token: string; refresh_token: string }
}

async function createProject(context: TestAppContext, accessToken: string, name: string) {
    const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { Authorization: `Bearer ${accessToken}` },
        payload: { name, telegramSession: `session-${name}` },
    })

    return readJson(response).data as {
        id: string
        anonKey: string
        serviceRoleKey: string
    }
}

async function createTable(
    context: TestAppContext,
    projectId: string,
    serviceRoleKey: string,
    payload: Record<string, unknown>
) {
    const response = await context.app.inject({
        method: 'POST',
        url: `/api/v1/${projectId}/tables`,
        headers: authHeaders(serviceRoleKey),
        payload,
    })

    expect(response.statusCode).toBe(201)
}

async function signInUser(context: TestAppContext, projectId: string, email: string) {
    await context.app.inject({
        method: 'POST',
        url: `/api/v1/${projectId}/auth/signup`,
        payload: { email, password: 'password123' },
    })

    const response = await context.app.inject({
        method: 'POST',
        url: `/api/v1/${projectId}/auth/signin`,
        payload: { email, password: 'password123' },
    })

    const payload = readJson(response).data
    return {
        access_token: payload.session.access_token as string,
        user: payload.user as { id: string },
    }
}

function authHeaders(token: string) {
    return {
        Authorization: `Bearer ${token}`,
        apikey: token,
    }
}

function readJson(response: { body: string }) {
    return JSON.parse(response.body) as Record<string, any>
}

function toInjectedPath(url: string): string {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
}
