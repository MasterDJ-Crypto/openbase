import type { FastifyInstance, FastifyRequest } from 'fastify'
import { migrationDefinitionSchema } from '@openbase/core'
import { ForbiddenError } from '@openbase/core'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import type { MigrationService } from '../migrations/MigrationService.js'
import type { ProjectService } from '../projects/ProjectService.js'

const mutationSchema = migrationDefinitionSchema.extend({
    checksum: z.string().optional(),
    source: z.enum(['cli', 'dashboard', 'sdk']).optional(),
})

export function registerMigrationRoutes(
    app: FastifyInstance,
    projectService: ProjectService,
    migrationService: MigrationService
): void {
    app.get<{ Params: { projectId: string } }>(
        '/api/v1/:projectId/migrations',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            await assertProjectAdminAccess(projectService, request)
            const exportState = await migrationService.list(request.params.projectId)
            return reply.send({
                data: {
                    migrations: exportState.migrations,
                    appliedMigrations: exportState.appliedMigrations,
                },
            })
        }
    )

    app.get<{ Params: { projectId: string } }>(
        '/api/v1/:projectId/schema/export',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            await assertProjectAdminAccess(projectService, request)
            return reply.send({
                data: await migrationService.list(request.params.projectId),
            })
        }
    )

    app.post<{ Params: { projectId: string } }>(
        '/api/v1/:projectId/migrations/apply',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            await assertProjectAdminAccess(projectService, request)
            const body = parseMutationBody(request.body)
            const state = await migrationService.apply(request.params.projectId, body)
            return reply.status(201).send({ data: state })
        }
    )

    app.post<{ Params: { projectId: string } }>(
        '/api/v1/:projectId/migrations/rollback',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            await assertProjectAdminAccess(projectService, request)
            const body = parseMutationBody(request.body)
            const state = await migrationService.rollback(request.params.projectId, body)
            return reply.send({ data: state })
        }
    )
}

function parseMutationBody(body: unknown) {
    const parsed = mutationSchema.parse(body)
    return {
        name: parsed.name,
        description: parsed.description,
        up: parsed.up,
        down: parsed.down,
        checksum: typeof parsed.checksum === 'string' && parsed.checksum.length > 0 ? parsed.checksum : parsed.name,
        source: parsed.source ?? 'cli',
    }
}

async function assertProjectAdminAccess(
    projectService: ProjectService,
    request: FastifyRequest<{ Params: { projectId: string } }>
) {
    const project = await projectService.getProject(request.params.projectId)
    const user = request.user

    if (!user) {
        throw new ForbiddenError('Authentication required')
    }

    if (user.role === 'platform_user' && user.sub === project.ownerId) {
        return project
    }

    if (user.role === 'service_role' && user.projectId === project.id) {
        return project
    }

    throw new ForbiddenError('Administrative access required')
}
