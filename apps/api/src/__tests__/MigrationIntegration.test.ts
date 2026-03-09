import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestAppContext } from './helpers/testApp.js'
import { createTestApp } from './helpers/testApp.js'

describe('Migration foundation', () => {
    let context: TestAppContext

    beforeEach(async () => {
        context = await createTestApp({ listen: true })
    })

    afterEach(async () => {
        await context.close()
    })

    it('applies and rolls back migrations through the admin SDK and emits typed schema output', async () => {
        const sdkModuleUrl = new URL('../../../sdk/src/index.ts', import.meta.url)
        const sdkModule = await import(sdkModuleUrl.toString()) as {
            createAdminClient: (projectUrl: string, serviceRoleKey: string) => any
            generateTypescriptSchemaClient: (schemaExport: Record<string, unknown>) => string
        }

        const owner = await signUpPlatform(context, 'migrations@example.com')
        const project = await createProject(context, owner.access_token, 'Migration Project')

        await createTable(context, project.id, project.serviceRoleKey, {
            tableName: 'profiles',
            columns: [
                { name: 'id', type: 'uuid', required: true, unique: true },
                { name: 'name', type: 'text', required: true },
            ],
            indexes: ['id'],
        })

        await context.app.inject({
            method: 'POST',
            url: `/api/v1/${project.id}/tables/profiles`,
            headers: authHeaders(project.serviceRoleKey),
            payload: { name: 'Ada' },
        })

        const admin = sdkModule.createAdminClient(context.baseUrl!, project.serviceRoleKey)
        const migration = {
            name: '20260309170000_profiles_refine',
            description: 'Add age and rename name to full_name',
            checksum: 'profiles-refine',
            source: 'sdk' as const,
            up: [
                {
                    type: 'add_column',
                    tableName: 'profiles',
                    column: {
                        name: 'age',
                        type: 'number',
                    },
                    backfill: {
                        mode: 'literal',
                        value: 32,
                    },
                },
                {
                    type: 'rename_column',
                    tableName: 'profiles',
                    from: 'name',
                    to: 'full_name',
                },
                {
                    type: 'add_index',
                    tableName: 'profiles',
                    columnName: 'age',
                },
            ],
            down: [
                {
                    type: 'remove_index',
                    tableName: 'profiles',
                    columnName: 'age',
                },
                {
                    type: 'rename_column',
                    tableName: 'profiles',
                    from: 'full_name',
                    to: 'name',
                },
                {
                    type: 'remove_column',
                    tableName: 'profiles',
                    columnName: 'age',
                },
            ],
        }

        const applied = await admin.admin.migrations.apply(migration)
        expect(applied.error).toBeNull()
        expect(applied.data?.appliedMigrations).toContain(migration.name)
        expect(applied.data?.tables.profiles.columns.some((column: { name: string }) => column.name === 'full_name')).toBe(true)

        const rowsAfterApply = await context.app.inject({
            method: 'GET',
            url: `/api/v1/${project.id}/tables/profiles`,
            headers: authHeaders(project.serviceRoleKey),
        })
        const appliedRows = readJson(rowsAfterApply).data as Array<Record<string, unknown>>
        expect(appliedRows[0]?.full_name).toBe('Ada')
        expect(appliedRows[0]?.age).toBe(32)

        const exported = await admin.admin.schema.export()
        expect(exported.error).toBeNull()
        const generated = sdkModule.generateTypescriptSchemaClient(exported.data)
        expect(generated).toContain('profiles')
        expect(generated).toContain('full_name')
        expect(generated).toContain('createTypedClient')

        const rolledBack = await admin.admin.migrations.rollback(migration)
        expect(rolledBack.error).toBeNull()
        expect(rolledBack.data?.appliedMigrations).not.toContain(migration.name)

        const rowsAfterRollback = await context.app.inject({
            method: 'GET',
            url: `/api/v1/${project.id}/tables/profiles`,
            headers: authHeaders(project.serviceRoleKey),
        })
        const rollbackRows = readJson(rowsAfterRollback).data as Array<Record<string, unknown>>
        expect(rollbackRows[0]?.name).toBe('Ada')
        expect(rollbackRows[0]?.age).toBeUndefined()
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

function authHeaders(token: string) {
    return {
        Authorization: `Bearer ${token}`,
        apikey: token,
    }
}

function readJson(response: { body: string }) {
    return JSON.parse(response.body) as Record<string, any>
}
