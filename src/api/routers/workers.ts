import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { AgentCliSchema } from '../../harness/agent-cli.js';
import { isInstanceAdmin, type SwarmUser } from '../../identity/schema.js';
import { WorkerDisplayNameSchema } from '../../identity/worker.js';
import {
	AllowedClisNotCapableError,
	approveEnrollment,
	type DashboardProjectScope,
	type DashboardWorkerView,
	EnrollmentRepositoryMismatchError,
	enrollWorker,
	getDashboardWorkerDetail,
	getEnrollment,
	listDashboardWorkers,
	listOwnerWorkers,
	listProjectRoster,
	listProjectWorkerIdsInOrder,
	moveProjectWorkerOrder,
	setEnrollmentStatus,
	setSharingConsent,
	updateEnrollmentConstraints,
	WorkerOrderDirectionSchema,
} from '../../identity/worker-enrollment-service.js';
import { getWorker, renameWorker, type Worker } from '../../identity/worker-service.js';
import { TriggerPhaseSchema } from '../../triggers/types.js';
import {
	accessibleProjectScope,
	assertInstanceAdmin,
	assertProjectAccess,
	mayAccessProject,
} from '../authz.js';
import { authedProcedure, router } from '../trpc.js';
import { resolveStrictlyOwnedWorker, workerNotFound } from '../worker-access.js';
import { workerScmCredentialsRouter } from './workerScmCredentials.js';

/**
 * The tRPC **workers** router (#337 Phase 3) — the enrollment-side companion to
 * `routers/projects.ts`. It exposes three clearly separated surfaces, all gated
 * by the identity/authorization layers ADR-001 establishes:
 *
 * - **Installation roster** (`list`, #133): the read-only cross-project
 *   connectivity view the dashboard's global Workers screen renders — every
 *   registered worker, including un-enrolled machines — which is an operator's
 *   view of the installation and so is reserved to an `instanceAdmin`
 *   (`assertInstanceAdmin`, issue #647). Given a `projectId` (#574) the same query
 *   serves **one project's** roster instead — the project detail page's Workers
 *   tab, the view an enrolled worker owner keeps — under the project roster's own
 *   access rule. The two order differently since issue #750, which is ordering
 *   alone and no change to what is visible: the project-scoped list follows the
 *   project's configured worker order, the unscoped one still lists the caller's
 *   own machines first (#657). `getById` (#477)
 *   returns that same row for one worker, widened with per-project enrollment
 *   detail and with what the *viewer* may change, so the detail screen offers only
 *   controls that would succeed. It stays bounded by `accessibleProjectScope` for
 *   non-owners, while a strict owner may also open their own un-enrolled worker to
 *   create its first enrollment.
 * - **Owner self-service**, scoped to `ctx.user`: an owner lists *their own*
 *   workers and enrollments (`listMine`), offers a worker to a project
 *   (`enroll`), renames a machine (`rename`), and controls the revocable
 *   sharing consent (`setConsent`) and execution constraints
 *   (`updateConstraints`). Ownership is checked per call. `enroll` alone lets
 *   an `instanceAdmin` act on any worker (layer-1 override, `resolveOwnedWorker`)
 *   — offering a worker to a project reads as administering the project side
 *   of that offer; `rename`, `setConsent`, and `updateConstraints` are the
 *   machine owner's own call about their own machine and admit no such
 *   override (`resolveStrictlyOwnedWorker`/`resolveOwnedEnrollment`). Either
 *   way, a caller who does not own the worker gets `NOT_FOUND`, so
 *   worker/enrollment existence never leaks across owners. The nested
 *   `scmCredentials` router (issue #766) is owner self-service too — the
 *   machine's own operator SCM credential per provider — and applies the same
 *   strict rule to *every* procedure, its read included (`./workerScmCredentials.ts`).
 * - **Project roster**, gated by `assertProjectAccess` exactly like
 *   `routers/projects.ts`: a `contributor` reads the roster (`roster`); only a
 *   `projectAdmin` approves an enrollment (`approveEnrollment`), revokes/
 *   reactivates one (`setStatus`), or moves a worker through the project's
 *   configured order (`reorderProjectWorker`, issue #750). A non-member gets
 *   `NOT_FOUND` (existence hidden), a member below the required role `FORBIDDEN`.
 *
 * Read models here expose **no secrets** (the service assembles secret-free
 * views) and derive busy/current-run from run lifecycle, never from the client.
 * None of this dispatches work: revoking consent/enrollment only flips the
 * `isRoutable` predicate the #130 gate consumes — it never terminates a running
 * agent (out of scope).
 */

/** The `NOT_FOUND` a non-owner/non-member (or anyone querying an unknown id) receives for an enrollment. */
function enrollmentNotFound(enrollmentId: string): TRPCError {
	return new TRPCError({
		code: 'NOT_FOUND',
		message: `Enrollment with ID "${enrollmentId}" not found`,
	});
}

/**
 * Resolve a worker the caller may act on as its owner. An `instanceAdmin` may
 * act on any worker (layer-1 override) for this one act — offering a worker to
 * a project is closer to project administration than to owning the machine.
 * A missing worker and a worker owned by someone else both surface the same
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
 * unless the caller **strictly** owns the worker — no `instanceAdmin`
 * override; sharing consent and execution constraints (allowed CLIs, allowed
 * phases, concurrency) are the machine owner's own call, not an
 * administrative one. Used by the owner-scoped enrollment mutations so a
 * non-owner cannot even learn an enrollment id exists.
 */
async function resolveOwnedEnrollment(user: SwarmUser, enrollmentId: string) {
	const enrollment = await getEnrollment(enrollmentId);
	if (!enrollment) throw enrollmentNotFound(enrollmentId);
	const worker = await getWorker(enrollment.workerId);
	if (!worker || worker.ownerUserId !== user.id) {
		throw enrollmentNotFound(enrollmentId);
	}
	return { enrollment, worker };
}

/**
 * The project scope one roster read runs under. With a `projectId` this is the
 * project's own roster (issue #574) — the Workers tab on the project detail page
 * — so it applies the access rule `roster` applies, a `contributor` may read it
 * and a non-member gets `NOT_FOUND`, and scopes the read to that project alone:
 * an enrollment elsewhere, an in-flight run outside it, and the un-enrolled
 * machines an `instanceAdmin` otherwise sees all stay out. Without one it is the
 * installation-wide roster, which only an `instanceAdmin` may read (issue #647) —
 * so the unrestricted `null` scope below is never handed to a worker owner.
 */
async function resolveRosterScope(
	user: SwarmUser,
	projectId: string | undefined,
): Promise<DashboardProjectScope> {
	if (projectId) {
		await assertProjectAccess(user, projectId, 'contributor');
		return [projectId];
	}
	assertInstanceAdmin(user, 'workers');
	return null;
}

/**
 * The viewer's own machines first (issue #657) — presentation order only, and
 * since issue #750 the **unscoped** global `/workers` list alone. It reorders the
 * rows `listDashboardWorkers` already decided are visible and changes nothing
 * about visibility, project scoping, ownership, or authorization.
 *
 * A project's Workers tab deliberately does *not* read it any more: that list has
 * a configured order of its own ({@link inProjectOrder}), which is also the order
 * the dispatch gate prefers, so sorting the viewer's own machines to the top there
 * would show every operator a different sequence from the one the project is
 * actually scheduled in. The global list has no such order — it spans projects —
 * so viewer-first stays exactly as #657 left it.
 *
 * The sort is **stable** (per spec), so the read model's own oldest-first order
 * is preserved within each group and a viewer who owns no visible worker sees it
 * unchanged. A row whose owner user row no longer resolves (`owner === null`)
 * groups with the others, which is correct: the signed-in viewer's own user row
 * resolved to produce `ctx.user`, so a missing one is never theirs.
 */
function viewerWorkersFirst(
	workers: DashboardWorkerView[],
	viewerUserId: string,
): DashboardWorkerView[] {
	const isViewers = (worker: DashboardWorkerView) => worker.owner?.userId === viewerUserId;
	return [...workers].sort((a, b) => Number(isViewers(b)) - Number(isViewers(a)));
}

/**
 * The project's configured worker order (issue #750) — presentation order for the
 * project-scoped list, exactly as {@link viewerWorkersFirst} is for the global
 * one, and the same order `workers.roster` and the dispatch gate already read.
 *
 * `workerIdsInOrder` is the project's own enrollment order; the sort is stable and
 * places a worker the order does not name **last**, which is defensive rather than
 * meaningful — a project-scoped read only returns workers enrolled there, so every
 * row is named.
 */
function inProjectOrder(
	workers: DashboardWorkerView[],
	workerIdsInOrder: string[],
): DashboardWorkerView[] {
	const position = new Map(workerIdsInOrder.map((workerId, index) => [workerId, index]));
	const rank = (worker: DashboardWorkerView) =>
		position.get(worker.workerId) ?? Number.MAX_SAFE_INTEGER;
	return [...workers].sort((a, b) => rank(a) - rank(b));
}

const AllowedClisInput = z.array(AgentCliSchema).min(1);
/**
 * The phases an enrollment may be given (issue #509). Non-empty for the same
 * reason `AllowedClisInput` is: "no work here" is a suspended enrollment or
 * revoked consent, not an empty constraint. The service re-validates and
 * de-duplicates (`EnrollmentAllowedPhasesSchema`); it deliberately does not check
 * the set against the machine's declared repertoire, which the daemon rewrites on
 * every reconnect.
 */
const AllowedPhasesInput = z.array(TriggerPhaseSchema).min(1);
const ConcurrencyInput = z.number().int().positive();

export const workersRouter = router({
	// The worker owner's own operator SCM credential per provider (issue #766),
	// nested here the way `credentialsRouter` nests under `projectsRouter`: it is
	// worker-scoped state and belongs under the worker's own namespace. Every
	// procedure there is strictly-owner-only, reads included.
	scmCredentials: workerScmCredentialsRouter,

	// --- Installation roster (cross-project, read-only) ---

	// Every worker the caller may see, with connectivity, last-seen, capabilities,
	// in-flight run, and enrollment states — the dashboard's Workers screen (#133).
	// Scoping is delegated wholesale to `resolveRosterScope`: unscoped it is the
	// installation-wide roster (`null` — every worker, including un-enrolled
	// machines), which an `instanceAdmin` alone may read (issue #647); with a
	// `projectId` (#574) it is that one project, authorized like `roster`.
	// Read-only — no mutation, no path/credential/token, and no routing or
	// approval affordance. Ordering is a presentation concern applied after scoping
	// decided what is visible, and the two lists order differently (issue #750): a
	// project-scoped read comes back in that project's *configured* worker order —
	// the same order `roster` and the dispatch gate read — while the unscoped
	// installation roster keeps the caller's own machines first (#657), having no
	// project order to speak of.
	list: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }).optional())
		.query(async ({ ctx, input }) => {
			const scope = await resolveRosterScope(ctx.user, input?.projectId);
			const visible = await listDashboardWorkers(scope);
			const projectId = input?.projectId;
			const workers = projectId
				? inProjectOrder(visible, await listProjectWorkerIdsInOrder(projectId))
				: viewerWorkersFirst(visible, ctx.user.id);
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
	// caller's `accessibleProjectScope` — deliberately *not* the installation-admin
	// rule the unscoped `list` now applies (issue #647). A strict owner can also
	// open their own un-enrolled worker to create its first enrollment; every other
	// invisible worker is `NOT_FOUND` exactly like a missing one, so existence never
	// leaks. Read-only: the flags *report* the authorization each mutation re-checks
	// for itself.
	getById: authedProcedure
		.input(z.object({ workerId: z.string().uuid() }))
		.query(async ({ ctx, input }) => {
			const scope = await accessibleProjectScope(ctx.user);
			const detail = await getDashboardWorkerDetail(input.workerId, scope, ctx.user.id);
			if (!detail) throw workerNotFound(input.workerId);
			// The owner-controlled values (display name, sharing consent, execution
			// constraints) are gated by `resolveStrictlyOwnedWorker`/`resolveOwnedEnrollment`
			// below, so the flag mirrors them exactly — no `instanceAdmin` override.
			const viewerIsOwner = detail.ownerUserId === ctx.user.id;
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

	// Rename one of the caller's own workers — the machine's own label, not a
	// project-scoped fact, so it is gated by strict ownership
	// (`resolveStrictlyOwnedWorker`) rather than `resolveOwnedWorker`'s
	// `instanceAdmin` override. A name collision with another of the owner's
	// workers surfaces as `CONFLICT`, exactly like a duplicate on `enroll`.
	rename: authedProcedure
		.input(z.object({ workerId: z.string().uuid(), displayName: WorkerDisplayNameSchema }))
		.mutation(async ({ ctx, input }) => {
			await resolveStrictlyOwnedWorker(ctx.user, input.workerId);
			try {
				const updated = await renameWorker(input.workerId, input.displayName);
				if (!updated) throw workerNotFound(input.workerId);
				return updated;
			} catch (error) {
				if (isUniqueViolation(error)) {
					throw new TRPCError({
						code: 'CONFLICT',
						message: 'You already have a worker with this name.',
					});
				}
				throw error;
			}
		}),

	// Offer one of the caller's workers to a project. The caller must own the
	// worker (NOT_FOUND otherwise) and be able to see the project (`contributor`,
	// so an unknown/inaccessible project is NOT_FOUND).
	//
	// What the enrollment is created as depends on whether the caller is *both*
	// parties to the two decisions routability needs (issue #784). Offering a
	// machine you do not administer the project of stays a `pending` enrollment
	// with sharing consent off, awaiting a projectAdmin's approval and the owner's
	// own consent. When the caller owns the worker *and* holds `projectAdmin` on
	// the target, both of those approvals are already theirs and were made in the
	// act of enrolling, so it is created `active` and consenting — routable with no
	// further step.
	//
	// A project whose repository is not the worker's declared checkout is refused
	// as `BAD_REQUEST` naming both repositories (issue #690), exactly as allowed
	// CLIs exceeding the machine's capabilities are.
	enroll: authedProcedure
		.input(
			z.object({
				workerId: z.string().uuid(),
				projectId: z.string().min(1),
				allowedClis: AllowedClisInput,
				// Omit for every phase (issue #509) — a new enrollment constrains nothing
				// its machine's daemon and the project don't already constrain.
				allowedPhases: AllowedPhasesInput.optional(),
				// Omit for the default share of one project slot (issue #480); there is
				// deliberately no value meaning "no per-worker cap".
				concurrencyAllocation: ConcurrencyInput.optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const worker = await resolveOwnedWorker(ctx.user, input.workerId);
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			// The ownership conjunct is load-bearing, not redundant with the resolve
			// above: `resolveOwnedWorker` admits an `instanceAdmin` acting on someone
			// else's machine, and `mayAccessProject` says yes to an `instanceAdmin`
			// unconditionally — so the predicate has to be *joint* owner-and-admin
			// standing, never elevated privilege on its own. It short-circuits, so a
			// caller who is not the owner pays no extra membership read.
			const selfAdministered =
				worker.ownerUserId === ctx.user.id &&
				(await mayAccessProject(ctx.user, input.projectId, 'projectAdmin'));
			try {
				return await enrollWorker({
					worker,
					projectId: input.projectId,
					allowedClis: input.allowedClis,
					allowedPhases: input.allowedPhases,
					concurrencyAllocation: input.concurrencyAllocation,
					// Stated here rather than left to the service defaults: the router is
					// now the thing deciding them. The `pending`/`false` pair is identical
					// to what the defaults produce.
					status: selfAdministered ? 'active' : 'pending',
					sharingConsent: selfAdministered,
				});
			} catch (error) {
				if (
					error instanceof AllowedClisNotCapableError ||
					error instanceof EnrollmentRepositoryMismatchError
				) {
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

	// Update the execution constraints (allowed CLIs / allowed phases / concurrency)
	// on one of the caller's enrollments. An `allowedClis` change is re-validated
	// against the worker's capabilities (BAD_REQUEST if it exceeds them). An
	// `allowedPhases` change is the owner's per-project routing choice (issue #509):
	// it takes effect on the next dispatch and never interrupts a running phase. For
	// `concurrencyAllocation`, send a positive integer to set this worker's share of
	// the project, or omit it to leave the stored value alone — no value clears it
	// (issue #480).
	updateConstraints: authedProcedure
		.input(
			z.object({
				enrollmentId: z.string().uuid(),
				allowedClis: AllowedClisInput.optional(),
				allowedPhases: AllowedPhasesInput.optional(),
				concurrencyAllocation: ConcurrencyInput.optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { worker } = await resolveOwnedEnrollment(ctx.user, input.enrollmentId);
			try {
				const updated = await updateEnrollmentConstraints({
					worker,
					enrollmentId: input.enrollmentId,
					allowedClis: input.allowedClis,
					allowedPhases: input.allowedPhases,
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

	// Move one worker one step through the project's configured worker order (issue
	// #750) — a `projectAdmin` action, gated exactly like approval/suspension, so a
	// contributor is refused and a non-member cannot learn the project exists. The
	// server computes the new positions from the stored order and returns the
	// project's worker ids in it: a client states only *which* worker and *which
	// direction*, never a list of positions it may have read before someone else
	// changed them.
	//
	// The order is a scheduling preference, not an authorization: the dispatch gate
	// still judges every candidate, so reordering can never route work to a worker
	// that is not eligible for it, and the change applies from the next dispatch —
	// nothing already running is touched.
	reorderProjectWorker: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				workerId: z.string().uuid(),
				direction: WorkerOrderDirectionSchema,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			const workerIds = await moveProjectWorkerOrder({
				projectId: input.projectId,
				workerId: input.workerId,
				direction: input.direction,
			});
			// No enrollment pairs this worker with this project — the same NOT_FOUND an
			// unknown worker gets, since the caller already cleared the project.
			if (!workerIds) throw workerNotFound(input.workerId);
			return { projectId: input.projectId, workerIds };
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
