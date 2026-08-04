import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { AgentCliSchema } from '../../harness/agent-cli.js';
import { isInstanceAdmin, type SwarmUser } from '../../identity/schema.js';
import {
	AllowedClisNotCapableError,
	approveEnrollment,
	enrollWorker,
	getDashboardWorkerDetail,
	getEnrollment,
	listDashboardWorkers,
	listOwnerWorkers,
	listProjectRoster,
	setEnrollmentStatus,
	setSharingConsent,
	updateEnrollmentConstraints,
} from '../../identity/worker-enrollment-service.js';
import { getWorker, type Worker } from '../../identity/worker-service.js';
import { accessibleProjectScope, assertProjectAccess, mayAccessProject } from '../authz.js';
import { authedProcedure, router } from '../trpc.js';

/**
 * The tRPC **workers** router (#337 Phase 3) — the enrollment-side companion to
 * `routers/projects.ts`. It exposes three clearly separated surfaces, all gated
 * by the identity/authorization layers ADR-001 establishes:
 *
 * - **Installation roster** (`list`, #133): the read-only cross-project
 *   connectivity view the dashboard's Workers screen renders, bounded by
 *   `accessibleProjectScope` — an `instanceAdmin` sees every registered worker,
 *   anyone else only workers enrolled in projects they may access. `getById`
 *   (#477) returns that same row for one worker, widened with per-project
 *   enrollment detail and with what the *viewer* may change, so the detail screen
 *   offers only controls that would succeed.
 * - **Owner self-service**, scoped to `ctx.user`: an owner lists *their own*
 *   workers and enrollments (`listMine`), offers a worker to a project
 *   (`enroll`), and controls the revocable sharing consent (`setConsent`) and
 *   execution constraints (`updateConstraints`). Ownership is checked per call;
 *   a caller who does not own the worker (and is not an `instanceAdmin`) gets
 *   `NOT_FOUND`, so worker/enrollment existence never leaks across owners.
 * - **Project roster**, gated by `assertProjectAccess` exactly like
 *   `routers/projects.ts`: a `contributor` reads the roster (`roster`); only a
 *   `projectAdmin` approves an enrollment (`approveEnrollment`) or revokes/
 *   reactivates one (`setStatus`). A non-member gets `NOT_FOUND` (existence
 *   hidden), a member below the required role `FORBIDDEN`.
 *
 * Read models here expose **no secrets** (the service assembles secret-free
 * views) and derive busy/current-run from run lifecycle, never from the client.
 * None of this dispatches work: revoking consent/enrollment only flips the
 * `isRoutable` predicate the #130 gate consumes — it never terminates a running
 * agent (out of scope).
 */

/** The `NOT_FOUND` a non-owner (or anyone querying an unknown id) receives for a worker. */
function workerNotFound(workerId: string): TRPCError {
	return new TRPCError({ code: 'NOT_FOUND', message: `Worker with ID "${workerId}" not found` });
}

/** The `NOT_FOUND` a non-owner/non-member (or anyone querying an unknown id) receives for an enrollment. */
function enrollmentNotFound(enrollmentId: string): TRPCError {
	return new TRPCError({
		code: 'NOT_FOUND',
		message: `Enrollment with ID "${enrollmentId}" not found`,
	});
}

/**
 * Resolve a worker the caller may act on as its owner. An `instanceAdmin` may
 * act on any worker (layer-1 override); any other user only on their own. A
 * missing worker and a worker owned by someone else both surface the same
 * `NOT_FOUND`, so ownership never leaks which worker ids are real.
 */
async function resolveOwnedWorker(user: SwarmUser, workerId: string): Promise<Worker> {
	const worker = await getWorker(workerId);
	if (!worker || (!isInstanceAdmin(user) && worker.ownerUserId !== user.id)) {
		throw workerNotFound(workerId);
	}
	return worker;
}

/**
 * Resolve an enrollment plus its worker, hiding both behind one `NOT_FOUND`
 * unless the caller owns the worker (or is an `instanceAdmin`). Used by the
 * owner-scoped enrollment mutations so a non-owner cannot even learn an
 * enrollment id exists.
 */
async function resolveOwnedEnrollment(user: SwarmUser, enrollmentId: string) {
	const enrollment = await getEnrollment(enrollmentId);
	if (!enrollment) throw enrollmentNotFound(enrollmentId);
	const worker = await getWorker(enrollment.workerId);
	if (!worker || (!isInstanceAdmin(user) && worker.ownerUserId !== user.id)) {
		throw enrollmentNotFound(enrollmentId);
	}
	return { enrollment, worker };
}

const AllowedClisInput = z.array(AgentCliSchema).min(1);
const ConcurrencyInput = z.number().int().positive();

export const workersRouter = router({
	// --- Installation roster (cross-project, read-only) ---

	// Every worker the caller may see, with connectivity, last-seen, capabilities,
	// in-flight run, and enrollment states — the dashboard's Workers screen (#133).
	// Scoping is delegated wholesale to `accessibleProjectScope`: an `instanceAdmin`
	// passes `null` (every worker, including un-enrolled machines), anyone else
	// passes exactly their membership project ids. Read-only — no mutation, no
	// path/credential/token, and no routing or approval affordance.
	list: authedProcedure.query(async ({ ctx }) => {
		const scope = await accessibleProjectScope(ctx.user);
		const workers = await listDashboardWorkers(scope);
		// The service already assembled a secret-free view; the only wire-shape
		// concern here is giving the browser an explicit ISO timestamp.
		return workers.map((worker) => ({
			...worker,
			lastSeenAt: worker.lastSeenAt?.toISOString() ?? null,
		}));
	}),

	// One worker in detail (#477) — the same row `list` returns, widened with the
	// full enrollment detail per visible project and with the two capability flags
	// the detail screen needs to decide which controls to offer. Visibility is the
	// same `accessibleProjectScope` rule as `list`, and an invisible worker is
	// `NOT_FOUND` exactly like a missing one, so existence never leaks. Read-only:
	// the flags *report* the authorization each mutation re-checks for itself.
	getById: authedProcedure
		.input(z.object({ workerId: z.string().uuid() }))
		.query(async ({ ctx, input }) => {
			const scope = await accessibleProjectScope(ctx.user);
			const detail = await getDashboardWorkerDetail(input.workerId, scope);
			if (!detail) throw workerNotFound(input.workerId);
			// The owner-controlled values (sharing consent, execution constraints) are
			// gated by `resolveOwnedEnrollment` below, so the flag mirrors it exactly.
			const viewerIsOwner = isInstanceAdmin(ctx.user) || detail.ownerUserId === ctx.user.id;
			const enrollments = await Promise.all(
				detail.enrollments.map(async (enrollment) => ({
					...enrollment,
					// Approval and suspend/reactivate are the project administrator's.
					viewerCanAdminister: await mayAccessProject(
						ctx.user,
						enrollment.projectId,
						'projectAdmin',
					),
				})),
			);
			return {
				...detail,
				lastSeenAt: detail.lastSeenAt?.toISOString() ?? null,
				viewerIsOwner,
				enrollments,
			};
		}),

	// --- Owner self-service (scoped to ctx.user) ---

	// The caller's own workers and their enrollments, with derived run state. A
	// user who operates no workers gets an empty list.
	listMine: authedProcedure.query(async ({ ctx }) => {
		return await listOwnerWorkers(ctx.user.id);
	}),

	// Offer one of the caller's workers to a project (a `pending` enrollment
	// awaiting a projectAdmin's approval). The caller must own the worker
	// (NOT_FOUND otherwise) and be able to see the project (`contributor`, so an
	// unknown/inaccessible project is NOT_FOUND). Sharing consent starts off.
	enroll: authedProcedure
		.input(
			z.object({
				workerId: z.string().uuid(),
				projectId: z.string().min(1),
				allowedClis: AllowedClisInput,
				// Omit (or send `null`) for no per-worker sub-limit — the default.
				concurrencyAllocation: ConcurrencyInput.nullable().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const worker = await resolveOwnedWorker(ctx.user, input.workerId);
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			try {
				return await enrollWorker({
					worker,
					projectId: input.projectId,
					allowedClis: input.allowedClis,
					concurrencyAllocation: input.concurrencyAllocation,
				});
			} catch (error) {
				if (error instanceof AllowedClisNotCapableError) {
					throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
				}
				if (isUniqueViolation(error)) {
					throw new TRPCError({
						code: 'CONFLICT',
						message: 'This worker is already enrolled in this project.',
					});
				}
				throw error;
			}
		}),

	// Set/revoke the owner-controlled sharing consent on one of the caller's
	// enrollments. Revoking (false) flips `isRoutable` false — blocking future
	// dispatch — without terminating any running agent.
	setConsent: authedProcedure
		.input(z.object({ enrollmentId: z.string().uuid(), sharingConsent: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			await resolveOwnedEnrollment(ctx.user, input.enrollmentId);
			const updated = await setSharingConsent(input.enrollmentId, input.sharingConsent);
			if (!updated) throw enrollmentNotFound(input.enrollmentId);
			return updated;
		}),

	// Update the execution constraints (allowed CLIs / concurrency) on one of the
	// caller's enrollments. An `allowedClis` change is re-validated against the
	// worker's capabilities (BAD_REQUEST if it exceeds them). For
	// `concurrencyAllocation`, omit to leave it unchanged, send a positive integer
	// to set a per-worker sub-limit, or send `null` to clear it (bounded then only
	// by the worker's `--concurrency` and the project cap).
	updateConstraints: authedProcedure
		.input(
			z.object({
				enrollmentId: z.string().uuid(),
				allowedClis: AllowedClisInput.optional(),
				concurrencyAllocation: ConcurrencyInput.nullable().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { worker } = await resolveOwnedEnrollment(ctx.user, input.enrollmentId);
			try {
				const updated = await updateEnrollmentConstraints({
					worker,
					enrollmentId: input.enrollmentId,
					allowedClis: input.allowedClis,
					concurrencyAllocation: input.concurrencyAllocation,
				});
				if (!updated) throw enrollmentNotFound(input.enrollmentId);
				return updated;
			} catch (error) {
				if (error instanceof AllowedClisNotCapableError) {
					throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
				}
				throw error;
			}
		}),

	// --- Project roster (project-scoped authorization) ---

	// The project's worker roster — every enrolled worker with the secret-free
	// view and derived busy/current-run. A `contributor` may read it; a
	// non-member gets NOT_FOUND (existence hidden).
	roster: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			return await listProjectRoster(input.projectId);
		}),

	// Approve a pending enrollment → active (a `projectAdmin` action). Keyed on
	// the enrollment's own project, so a non-admin can neither approve nor learn
	// the enrollment exists (the same NOT_FOUND whether missing or inaccessible).
	approveEnrollment: authedProcedure
		.input(z.object({ enrollmentId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			const enrollment = await getEnrollment(input.enrollmentId);
			if (!enrollment) throw enrollmentNotFound(input.enrollmentId);
			await assertProjectAccess(
				ctx.user,
				enrollment.projectId,
				'projectAdmin',
				`Enrollment with ID "${input.enrollmentId}" not found`,
			);
			const updated = await approveEnrollment(input.enrollmentId);
			if (!updated) throw enrollmentNotFound(input.enrollmentId);
			return updated;
		}),

	// Revoke (suspend) or reactivate an enrollment (a `projectAdmin` action).
	// Suspending flips `isRoutable` false without deleting the enrollment or
	// terminating a running agent. Same access boundary/existence-hiding as approval.
	setStatus: authedProcedure
		.input(
			z.object({
				enrollmentId: z.string().uuid(),
				status: z.enum(['active', 'suspended']),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const enrollment = await getEnrollment(input.enrollmentId);
			if (!enrollment) throw enrollmentNotFound(input.enrollmentId);
			await assertProjectAccess(
				ctx.user,
				enrollment.projectId,
				'projectAdmin',
				`Enrollment with ID "${input.enrollmentId}" not found`,
			);
			const updated = await setEnrollmentStatus(input.enrollmentId, input.status);
			if (!updated) throw enrollmentNotFound(input.enrollmentId);
			return updated;
		}),
});

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
 * which has no top-level `code` — the original pg error (carrying `code: '23505'`
 * for a unique violation) is on `.cause`. Check both, exactly like
 * `routers/projects.ts`.
 */
function isUniqueViolation(error: unknown): boolean {
	return (
		hasUniqueViolationCode(error) || (error instanceof Error && hasUniqueViolationCode(error.cause))
	);
}
