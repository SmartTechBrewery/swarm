import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
	PipelineBaseSchema,
	type PipelineConfig,
	PipelineConfigSchema,
	ProjectConfigSchema,
} from '../../config/schema.js';
import {
	approveMembershipRequestInDb,
	createMembershipRequest,
	getMembershipRequestById,
	getPendingRequest,
	listPendingRequestsForProject,
	rejectMembershipRequestInDb,
} from '../../db/repositories/projectMembershipRequestsRepository.js';
import {
	createProjectWithMemberInDb,
	deleteProjectFromDb,
	getProjectByIdFromDb,
	listAllProjectsFromDb,
	listDiscoverableProjectsFromDb,
	upsertProjectToDb,
} from '../../db/repositories/projectsRepository.js';
import { getMembership } from '../../identity/membership-service.js';
import type { GitHubProjectsIntegrationConfig } from '../../integrations/pm/github-projects/config-schema.js';
import { accessibleProjectScope, assertProjectAccess, filterAccessibleProjects } from '../authz.js';
import { authedProcedure, router } from '../trpc.js';
import { credentialsRouter } from './credentials.js';

export const DEFAULT_GITHUB_PROJECTS_CONFIG: GitHubProjectsIntegrationConfig = {
	projectId: '',
	statusFieldId: '',
	statusOptions: {},
};

// Project-scoped credential references a new project is created with. The
// implementer persona is intentionally absent — it resolves from the worker-local
// SWARM_OPERATOR_GH_TOKEN, not from project_credentials (issue #396).
const DEFAULT_CREDENTIAL_REFERENCES = {
	reviewer: 'SCM_TOKEN_REVIEWER',
	webhookSecret: 'SCM_WEBHOOK_SECRET',
};

const ProjectWriteInputSchema = ProjectConfigSchema.omit({ credentials: true });
const ProjectCreateInputSchema = ProjectWriteInputSchema.omit({ githubProjects: true });

function mergePipelineConfig(
	existing: PipelineConfig | undefined,
	patch: Partial<PipelineConfig> | undefined,
): PipelineConfig {
	if (!existing) return (patch || {}) as PipelineConfig;
	if (!patch) return existing;
	return {
		...existing,
		...patch,
		planning:
			existing.planning || patch.planning
				? {
						...existing.planning,
						...patch.planning,
					}
				: undefined,
		review:
			existing.review || patch.review
				? {
						...existing.review,
						...patch.review,
					}
				: undefined,
		respondToReview:
			existing.respondToReview || patch.respondToReview
				? {
						...existing.respondToReview,
						...patch.respondToReview,
					}
				: undefined,
		respondToCi:
			existing.respondToCi || patch.respondToCi
				? {
						...existing.respondToCi,
						...patch.respondToCi,
					}
				: undefined,
	};
}

function hasUniqueViolationCode(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code: unknown }).code === '23505'
	);
}

/**
 * drizzle-orm wraps every node-postgres query error in a `DrizzleQueryError`,
 * which has no top-level `code` — the original pg error (the one carrying
 * `code: '23505'` for a unique violation) is on `.cause`. Check both so this
 * still matches once drizzle's wrapping is in the way.
 */
function isUniqueViolation(error: unknown): boolean {
	return (
		hasUniqueViolationCode(error) || (error instanceof Error && hasUniqueViolationCode(error.cause))
	);
}

export const projectsRouter = router({
	// Only the caller's accessible projects: their membership set, or every
	// project for an `instanceAdmin` (`filterAccessibleProjects`, #281 task 4).
	list: authedProcedure.query(async ({ ctx }) => {
		return await filterAccessibleProjects(ctx.user, await listAllProjectsFromDb());
	}),

	getById: authedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			// A non-member gets NOT_FOUND here, so the read below never reveals that a
			// project they can't see exists.
			await assertProjectAccess(ctx.user, input.id, 'contributor');
			const project = await getProjectByIdFromDb(input.id);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.id}" not found`,
				});
			}
			return project;
		}),

	// Any authenticated user may create a project and becomes its `projectAdmin`
	// (#281 task 4): the creator gets a membership row in the same call, so they
	// can immediately administer what they just created without an operator
	// seeding membership first. An `instanceAdmin` administers it regardless, but
	// the row is still written so the creator keeps access if their installation
	// role is later removed. Creation and membership insertion are performed
	// atomically in one transaction so a partial failure never leaves an unowned project.
	create: authedProcedure.input(ProjectCreateInputSchema).mutation(async ({ ctx, input }) => {
		const config = {
			...input,
			githubProjects: DEFAULT_GITHUB_PROJECTS_CONFIG,
			credentials: DEFAULT_CREDENTIAL_REFERENCES,
		};
		try {
			await createProjectWithMemberInDb(config, {
				projectId: config.id,
				userId: ctx.user.id,
				role: 'projectAdmin',
			});
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'Project ID or repository already exists',
				});
			}
			throw error;
		}
		return config;
	}),

	update: authedProcedure
		.input(
			ProjectWriteInputSchema.partial().extend({
				id: z.string().min(1),
				pipeline: PipelineBaseSchema.optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Config changes are a `projectAdmin`-only action; a `member`/`contributor`
			// gets FORBIDDEN, a non-member NOT_FOUND.
			await assertProjectAccess(ctx.user, input.id, 'projectAdmin');
			const existing = await getProjectByIdFromDb(input.id);
			if (!existing) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.id}" not found`,
				});
			}
			const { id, ...updates } = input;
			const config = {
				...existing,
				...updates,
			};
			if (updates.pipeline) {
				config.pipeline = PipelineConfigSchema.parse(
					mergePipelineConfig(existing.pipeline, updates.pipeline),
				);
			}
			try {
				await upsertProjectToDb(config);
				return config;
			} catch (error) {
				if (isUniqueViolation(error)) {
					throw new TRPCError({
						code: 'CONFLICT',
						message: 'Project ID or repository already exists',
					});
				}
				throw error;
			}
		}),

	delete: authedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			// Deleting a project is `projectAdmin`-only (same boundary as `update`).
			await assertProjectAccess(ctx.user, input.id, 'projectAdmin');
			const existing = await getProjectByIdFromDb(input.id);
			if (!existing) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.id}" not found`,
				});
			}
			await deleteProjectFromDb(input.id);
		}),

	// --- Open-project discovery & join flow (#281 task 5) ---
	//
	// These are the only project-keyed procedures a *non-member* may touch, and
	// only for `discoverable` projects. They keep discovery, joining, and
	// membership strictly separate from execution: none of them grants worker
	// registration or task routing — those remain distinct permissions (ADR-001).

	// The limited public-discovery read: any authenticated user sees the id +
	// name of `discoverable` projects they cannot already access. Exposes no
	// credentials, config, repo, or run internals (`listDiscoverableProjectsFromDb`
	// selects only id + name), and excludes projects the caller is already a
	// member of — an `instanceAdmin` already accesses every project, so they get
	// nothing new to discover.
	listDiscoverable: authedProcedure.query(async ({ ctx }) => {
		const scope = await accessibleProjectScope(ctx.user);
		if (scope === null) return [];
		const alreadyAccessible = new Set(scope);
		const discoverable = await listDiscoverableProjectsFromDb();
		return discoverable.filter((project) => !alreadyAccessible.has(project.id));
	}),

	// Ask to join a `discoverable` project. Joining never grants access directly:
	// it files a `pending` request a `projectAdmin`/`instanceAdmin` must approve
	// (ADR-001 Q1, resolved in favour of request/approve). A private or unknown
	// project is NOT_FOUND so a private project's existence never leaks; an
	// existing membership or pending request is a CONFLICT.
	requestMembership: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const project = await getProjectByIdFromDb(input.projectId);
			if (!project || project.visibility !== 'discoverable') {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.projectId}" not found`,
				});
			}
			if (await getMembership(ctx.user.id, input.projectId)) {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'You are already a member of this project.',
				});
			}
			if (await getPendingRequest(ctx.user.id, input.projectId)) {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'You already have a pending membership request for this project.',
				});
			}
			try {
				return await createMembershipRequest({
					projectId: input.projectId,
					userId: ctx.user.id,
				});
			} catch (error) {
				// The partial unique index catches a request that raced past the check above.
				if (isUniqueViolation(error)) {
					throw new TRPCError({
						code: 'CONFLICT',
						message: 'You already have a pending membership request for this project.',
					});
				}
				throw error;
			}
		}),

	// A `projectAdmin`/`instanceAdmin` lists the pending join requests for their
	// project. A non-member gets NOT_FOUND (existence hidden), a member below
	// `projectAdmin` FORBIDDEN — the same boundary as administering the project.
	listMembershipRequests: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			return await listPendingRequestsForProject(input.projectId);
		}),

	// Approve a pending request → a `contributor` (read-only) membership. Keyed
	// on the request's own project, so a non-admin can neither approve nor learn
	// the request exists (the same NOT_FOUND message whether the request is
	// missing or the caller lacks access).
	approveMembershipRequest: authedProcedure
		.input(z.object({ requestId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			const notFound = `Membership request with ID "${input.requestId}" not found`;
			const request = await getMembershipRequestById(input.requestId);
			if (!request) {
				throw new TRPCError({ code: 'NOT_FOUND', message: notFound });
			}
			await assertProjectAccess(ctx.user, request.projectId, 'projectAdmin', notFound);
			if (request.status !== 'pending') {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'This membership request has already been resolved.',
				});
			}
			const transitioned = await approveMembershipRequestInDb(request);
			if (!transitioned) {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'This membership request has already been resolved.',
				});
			}
			return { ...request, status: 'approved' as const };
		}),

	// Reject a pending request. Grants no membership. Same access boundary and
	// existence-hiding as approval.
	rejectMembershipRequest: authedProcedure
		.input(z.object({ requestId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			const notFound = `Membership request with ID "${input.requestId}" not found`;
			const request = await getMembershipRequestById(input.requestId);
			if (!request) {
				throw new TRPCError({ code: 'NOT_FOUND', message: notFound });
			}
			await assertProjectAccess(ctx.user, request.projectId, 'projectAdmin', notFound);
			if (request.status !== 'pending') {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'This membership request has already been resolved.',
				});
			}
			const transitioned = await rejectMembershipRequestInDb(request.id);
			if (!transitioned) {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'This membership request has already been resolved.',
				});
			}
			return { ...request, status: 'rejected' as const };
		}),

	credentials: credentialsRouter,
});
