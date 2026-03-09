import type { FastifyInstance } from 'fastify'
import type { TransactionOperation } from '@openbase/core'
import { transactionOperationSchema } from '@openbase/core'
import { z } from 'zod'
import type { ProjectAccessService } from '../access/ProjectAccessService.js'
import { assertRouteProjectPermission } from '../access/routePermissions.js'
import type { AuthService } from '../auth/AuthService.js'
import type { ProjectService } from '../projects/ProjectService.js'
import type { TransactionService } from '../transactions/TransactionService.js'
import { authMiddleware } from '../middleware/auth.js'

const executeTransactionSchema = z.object({
    operations: z.array(transactionOperationSchema).min(1),
})

export function registerTransactionRoutes(
    app: FastifyInstance,
    projectService: ProjectService,
    projectAccessService: ProjectAccessService,
    authService: AuthService,
    transactionService: TransactionService
): void {
    app.post<{ Params: { projectId: string } }>(
        '/api/v1/:projectId/transactions',
        { preHandler: [authMiddleware] },
        async (request, reply) => {
            const project = await assertRouteProjectPermission(projectService, projectAccessService, authService, request, {
                permission: 'tables.write',
            })
            const body = executeTransactionSchema.parse(request.body)
            const result = await transactionService.execute(project.id, request.user, body.operations as TransactionOperation[])
            return reply.status(201).send({ data: result })
        }
    )
}
