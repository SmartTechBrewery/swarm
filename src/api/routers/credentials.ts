import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
	deleteProjectCredential,
	resolveAllProjectCredentials,
	writeProjectCredential,
} from '../../db/repositories/credentialsRepository.js';
import { getProjectByIdFromDb } from '../../db/repositories/projectsRepository.js';
import { assertProjectAccess } from '../authz.js';
import { authedProcedure, router } from '../trpc.js';

/**
 * Project-scoped credentials API — mirrors Cascade's `projectsRouter.credentials`
 * (`cascade/src/api/routers/projects.ts`). `list` never returns plaintext, only a
 * masked preview. Project-scoped authorization (#281 task 4) gates every
 * procedure via `assertProjectAccess` — SWARM's analogue of Cascade's
 * `verifyProjectOwnership`: reading the masked list needs `contributor`, while
 * writing or clearing a credential is a `projectAdmin`-only action. A non-member
 * gets NOT_FOUND (existence hidden), so the assertion also subsumes the old
 * existence check.
 */

/**
 * Never returns plaintext or any substring of it — a configured credential
 * always collapses to the same fixed opaque marker regardless of its length,
 * so the response discloses only configured/not-configured state.
 */
function maskCredential(value: string | undefined): string {
	return value === undefined ? 'not set' : '****';
}

export const credentialsRouter = router({
	list: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			const project = await getProjectByIdFromDb(input.projectId);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.projectId}" not found`,
				});
			}

			const resolved = await resolveAllProjectCredentials(input.projectId);

			return Object.entries(project.credentials).map(([role, envVarKey]) => ({
				role: role as 'reviewer' | 'webhookSecret',
				envVarKey,
				isConfigured: envVarKey in resolved,
				maskedValue: maskCredential(resolved[envVarKey]),
			}));
		}),

	set: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				envVarKey: z
					.string()
					.regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an UPPER_SNAKE_CASE env var key'),
				value: z.string().min(1),
				name: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			const project = await getProjectByIdFromDb(input.projectId);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.projectId}" not found`,
				});
			}

			await writeProjectCredential(
				input.projectId,
				input.envVarKey,
				input.value,
				input.name ?? null,
			);
		}),

	delete: authedProcedure
		.input(z.object({ projectId: z.string().min(1), envVarKey: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			const project = await getProjectByIdFromDb(input.projectId);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.projectId}" not found`,
				});
			}

			await deleteProjectCredential(input.projectId, input.envVarKey);
		}),
});
