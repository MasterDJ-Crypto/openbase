/**
 * Database Routes — CRUD for tables and rows.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ColumnDefinition, JWTPayload, TableSchema } from '@openbase/core'
import { ForbiddenError, NotFoundError } from '@openbase/core'
import type { StorageProvider } from '@openbase/telegram'
import type { EncryptionService } from '../encryption/EncryptionService.js'
import { IndexManager, buildProjectQueryEngine, parseDatabaseRequestQuery } from '../database/index.js'
import { applyRLS, authMiddleware, checkRLSForRow, findPolicy } from '../middleware/index.js'
import type { ProjectService } from '../projects/ProjectService.js'
import type { RealtimeService } from '../realtime/RealtimeService.js'
import type { WebhookService } from '../webhooks/WebhookService.js'

const createTableSchema = z.object({
    tableName: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
    columns: z.array(z.object({
        name: z.string().min(1),
        type: z.enum(['text', 'number', 'boolean', 'json', 'timestamp', 'uuid']),
        required: z.boolean().optional(),
        unique: z.boolean().optional(),
        default: z.unknown().optional(),
        encrypted: z.boolean().optional(),
    })),
    indexes: z.array(z.string()).optional().default([]),
    rls: z.array(z.object({
        operation: z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
        check: z.string(),
    })).optional(),
})

export function registerDatabaseRoutes(
    app: FastifyInstance,
    projectService: ProjectService,
    getIndexManager: (projectId: string) => IndexManager,
    encryptionService: EncryptionService,
    masterKey: Buffer,
    realtimeService?: RealtimeService,
    webhookService?: WebhookService
): void {
    app.get<{ Params: { projectId: string } }>(
        '/api/v1/:projectId/tables',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const project = await assertProjectAccess(projectService, request)
            const schemas = await projectService.getSchemas(project.id)

            return reply.send({
                data: Object.entries(schemas).map(([name, schema]) => ({
                    name,
                    columns: schema.columns,
                    indexes: schema.indexes,
                    rls: schema.rls,
                })),
            })
        }
    )

    app.post<{ Params: { projectId: string } }>(
        '/api/v1/:projectId/tables',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const project = await assertProjectAdminAccess(projectService, request)
            const body = createTableSchema.parse(request.body)
            const encryptedColumns = new Set(
                body.columns.filter(column => column.encrypted).map(column => column.name)
            )
            const invalidIndexedColumns = body.indexes.filter(index => encryptedColumns.has(index))

            if (project.channelMap[body.tableName]) {
                return reply.status(409).send({
                    error: { message: `Table "${body.tableName}" already exists`, code: 'CONFLICT' },
                })
            }

            if (invalidIndexedColumns.length > 0) {
                return reply.status(400).send({
                    error: {
                        message: `Encrypted columns cannot be indexed: ${invalidIndexedColumns.join(', ')}`,
                        code: 'INVALID_INDEX_CONFIGURATION',
                    },
                })
            }

            const schema: TableSchema = {
                tableName: body.tableName,
                columns: body.columns as ColumnDefinition[],
                indexes: Array.from(new Set(['id', ...body.indexes])).filter(index => !encryptedColumns.has(index)),
                rls: body.rls,
            }

            const channel = await projectService.addTable(project.id, body.tableName, schema)
            realtimeService?.registerProject(project.id, { [body.tableName]: channel.id })

            return reply.status(201).send({
                data: { tableName: body.tableName, channel },
            })
        }
    )

    app.get<{ Params: { projectId: string; table: string } }>(
        '/api/v1/:projectId/tables/:table',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const { table } = request.params
            const project = await assertProjectAccess(projectService, request)
            const schema = await getTableSchema(projectService, project.id, table)
            const parsedQuery = parseDatabaseRequestQuery(request)

            return projectService.withProjectStorageRecord(project, async (_project, provider) => {
                const queryEngine = buildQueryEngine(provider, getIndexManager(project.id), schema, encryptionService, masterKey)
                let rows = await queryEngine.select(table, project.channelMap[table], {
                    filters: parsedQuery.filters,
                    orderBy: parsedQuery.orderBy,
                })

                if (!canBypassRLS(request.user)) {
                    rows = applyRLS(rows, findPolicy(schema.rls, 'SELECT'), request.user || null)
                }

                if (parsedQuery.offset !== undefined && parsedQuery.offset > 0) {
                    rows = rows.slice(parsedQuery.offset)
                }
                if (parsedQuery.limit !== undefined) {
                    rows = rows.slice(0, parsedQuery.limit)
                }
                if (parsedQuery.select?.length) {
                    rows = rows.map(row =>
                        Object.fromEntries(parsedQuery.select!.map(column => [column, row[column]]))
                    )
                }

                return reply.send({
                    data: rows,
                    count: rows.length,
                })
            })
        }
    )

    app.post<{ Params: { projectId: string; table: string } }>(
        '/api/v1/:projectId/tables/:table',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const { table } = request.params
            const project = await assertProjectAccess(projectService, request)
            const schema = await getTableSchema(projectService, project.id, table)
            const parsedQuery = parseDatabaseRequestQuery(request)
            const rows = Array.isArray(request.body)
                ? request.body as Record<string, unknown>[]
                : [request.body as Record<string, unknown>]

            if (!canBypassRLS(request.user)) {
                const insertPolicy = findPolicy(schema.rls, 'INSERT')
                const unauthorizedRow = rows.find(row => !checkRLSForRow(row, insertPolicy, request.user || null))
                if (unauthorizedRow) {
                    throw new ForbiddenError('Insert blocked by row-level security policy')
                }
            }

            return projectService.withProjectStorageRecord(project, async (_project, provider) => {
                const queryEngine = buildQueryEngine(provider, getIndexManager(project.id), schema, encryptionService, masterKey)
                const results: Record<string, unknown>[] = []

                for (const row of rows) {
                    const result = parsedQuery.upsert
                        ? await queryEngine.upsert(table, project.channelMap[table], row, parsedQuery.onConflict || ['id'])
                        : { operation: 'insert' as const, row: await queryEngine.insert(table, project.channelMap[table], row) }

                    results.push(result.row)

                    const eventType = result.operation === 'insert' ? 'INSERT' : 'UPDATE'
                    realtimeService?.broadcastChange(project.id, table, eventType, result.row, null)
                    await webhookService?.enqueueDatabaseChange(project.id, table, eventType, result.row, null)
                }

                return reply.status(201).send({
                    data: results.length === 1 ? results[0] : results,
                })
            })
        }
    )

    app.patch<{ Params: { projectId: string; table: string } }>(
        '/api/v1/:projectId/tables/:table',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const { table } = request.params
            const project = await assertProjectAccess(projectService, request)
            const schema = await getTableSchema(projectService, project.id, table)
            const parsedQuery = parseDatabaseRequestQuery(request)
            const patch = request.body as Record<string, unknown>

            return projectService.withProjectStorageRecord(project, async (_project, provider) => {
                const queryEngine = buildQueryEngine(provider, getIndexManager(project.id), schema, encryptionService, masterKey)
                let rows = await queryEngine.select(table, project.channelMap[table], { filters: parsedQuery.filters })

                if (!canBypassRLS(request.user)) {
                    rows = applyRLS(rows, findPolicy(schema.rls, 'UPDATE'), request.user || null)
                }

                const updatedRows = await queryEngine.updateRows(table, project.channelMap[table], patch, rows)

                for (let index = 0; index < updatedRows.length; index++) {
                    realtimeService?.broadcastChange(project.id, table, 'UPDATE', updatedRows[index], rows[index] || null)
                    await webhookService?.enqueueDatabaseChange(project.id, table, 'UPDATE', updatedRows[index], rows[index] || null)
                }

                return reply.send({
                    data: updatedRows,
                    count: updatedRows.length,
                })
            })
        }
    )

    app.delete<{ Params: { projectId: string; table: string } }>(
        '/api/v1/:projectId/tables/:table',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const { table } = request.params
            const project = await assertProjectAccess(projectService, request)
            const schema = await getTableSchema(projectService, project.id, table)
            const parsedQuery = parseDatabaseRequestQuery(request)

            return projectService.withProjectStorageRecord(project, async (_project, provider) => {
                const queryEngine = buildQueryEngine(provider, getIndexManager(project.id), schema, encryptionService, masterKey)
                let rows = await queryEngine.select(table, project.channelMap[table], { filters: parsedQuery.filters })

                if (!canBypassRLS(request.user)) {
                    rows = applyRLS(rows, findPolicy(schema.rls, 'DELETE'), request.user || null)
                }

                const deletedRows = await queryEngine.deleteRows(table, project.channelMap[table], rows)
                for (const row of deletedRows) {
                    realtimeService?.broadcastChange(project.id, table, 'DELETE', null, row)
                    await webhookService?.enqueueDatabaseChange(project.id, table, 'DELETE', null, row)
                }

                return reply.send({
                    data: null,
                    count: deletedRows.length,
                })
            })
        }
    )

    app.get<{ Params: { projectId: string; table: string } }>(
        '/api/v1/:projectId/tables/:table/count',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const { table } = request.params
            const project = await assertProjectAccess(projectService, request)
            const schema = await getTableSchema(projectService, project.id, table)
            const parsedQuery = parseDatabaseRequestQuery(request)

            return projectService.withProjectStorageRecord(project, async (_project, provider) => {
                const queryEngine = buildQueryEngine(provider, getIndexManager(project.id), schema, encryptionService, masterKey)
                let rows = await queryEngine.select(table, project.channelMap[table], { filters: parsedQuery.filters })

                if (!canBypassRLS(request.user)) {
                    rows = applyRLS(rows, findPolicy(schema.rls, 'SELECT'), request.user || null)
                }

                return reply.send({ data: { count: rows.length } })
            })
        }
    )
}

async function assertProjectAccess(
    projectService: ProjectService,
    request: FastifyRequest<{ Params: Record<string, string> }>
) {
    const project = await projectService.getProject(request.params.projectId)
    const user = request.user

    if (!user) {
        throw new ForbiddenError('Authentication required')
    }

    if (user.role === 'platform_user' && user.sub === project.ownerId) {
        return project
    }

    if (user.projectId === project.id) {
        return project
    }

    throw new ForbiddenError('You do not have access to this project')
}

async function assertProjectAdminAccess(
    projectService: ProjectService,
    request: FastifyRequest<{ Params: Record<string, string> }>
) {
    const project = await assertProjectAccess(projectService, request)

    if (request.user?.role === 'platform_user' || request.user?.role === 'service_role') {
        return project
    }

    throw new ForbiddenError('Administrative access required')
}

async function getTableSchema(
    projectService: ProjectService,
    projectId: string,
    table: string
) {
    const schemas = await projectService.getSchemas(projectId)
    const schema = schemas[table]

    if (!schema) {
        throw new NotFoundError(`Schema for "${table}"`)
    }

    return schema
}

function canBypassRLS(user?: JWTPayload): boolean {
    return user?.role === 'service_role' || user?.role === 'platform_user'
}

function buildQueryEngine(
    provider: StorageProvider,
    indexManager: IndexManager,
    schema: TableSchema,
    encryptionService: EncryptionService,
    masterKey: Buffer
){
    return buildProjectQueryEngine(provider, indexManager, schema, encryptionService, masterKey)
}
