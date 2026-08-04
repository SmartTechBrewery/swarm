/**
 * Worker **project enrollment** — the single source of truth for the shape
 * (ai/CODING_STANDARDS.md "Zod is the source of truth") and Phase 3 of the
 * worker slice, on top of Phase 1's identity (`./worker.ts`) and Phase 2's
 * sessions (`./worker-session.ts`). Where a `Worker` models *where* a user can
 * execute and a `WorkerSession` the one *live claim* on it, an enrollment models
 * *which projects that worker is offered to*, and under what constraints
 * (ADR-001's third authorization layer: installation role → project membership →
 * worker enrollment).
 *
 * One enrollment per `(worker, project)`. It carries an approval/active
 * `status`, the project-scoped execution constraints (`allowedClis` — a subset
 * of the worker's declared capabilities; `concurrencyAllocation`), and the
 * owner-controlled, revocable `sharingConsent` flag. Together `status` and
 * `sharingConsent` define {@link isRoutable} — the named seam the #130 dispatch
 * gate consumes to decide whether a worker may receive *future* automatic
 * dispatch. Revoking either (suspend, or consent → false) flips `isRoutable`
 * so no new work is routed; it deliberately does **not** touch an
 * already-running process (that teardown is out of scope, #130).
 *
 * The `worker_project_enrollments` table (`src/db/schema/workerProjectEnrollments.ts`)
 * is its persisted form; the provider-neutral read models and write operations
 * live in `./worker-enrollment-service.ts`.
 */

import { z } from 'zod';
import { type AgentCli, AgentCliSchema } from '../harness/agent-cli.js';

/**
 * The lifecycle state of an enrollment. An enrollment starts `pending` (the
 * owner offered the worker, awaiting a `projectAdmin`'s approval); approval
 * moves it to `active`; a revocation moves it to `suspended`. Only `active`
 * (with sharing consent) is routable — see {@link isRoutable}. A suspended
 * enrollment is retained, not deleted, so re-activation keeps its constraints.
 */
export const EnrollmentStatusSchema = z.enum(['pending', 'active', 'suspended']);

export type EnrollmentStatus = z.infer<typeof EnrollmentStatusSchema>;

/** Every enrollment status — for CLI usage/validation copy. */
export const ENROLLMENT_STATUSES = EnrollmentStatusSchema.options;

/**
 * The CLIs an enrollment permits on this project: a non-empty, de-duplicated set
 * of `AgentCli` values that must be a **subset of the worker's own
 * capabilities** (`WorkerCapabilitiesSchema`, `./worker.ts`). The subset check
 * needs the worker, so it lives in `enrollWorker` (`./worker-enrollment-service.ts`);
 * this schema only enforces the shape (non-empty, valid, de-duplicated) an
 * operator/dashboard passes. The transform de-dupes so `claude,claude` stores a
 * single `claude`, mirroring `WorkerCapabilitiesSchema`.
 */
export const EnrollmentAllowedClisSchema = z
	.array(AgentCliSchema)
	.nonempty()
	.transform((clis) => [...new Set(clis)]);

/**
 * The per-worker, per-project concurrency allocation — always a positive
 * integer, never absent (issue #480). It is this worker's share of the project:
 * how many of the project's jobs it will run at once. An enrollment that can
 * take on no work is a `suspended` status, not a zero allocation, so the two
 * concepts don't overlap.
 *
 * There is deliberately **no "unbounded" value**: "no per-worker cap" used to be
 * expressible as `NULL`, which was a second way of saying a number — on a default
 * install it already resolved to an effective 1, because the two limits it
 * deferred to (`SWARM_WORKER_CONCURRENCY` and the project's `maxConcurrentJobs`)
 * both default to 1. Every enrollment now states its share outright; a worker
 * meant to take several of a project's slots says so with a larger allocation.
 */
export const ConcurrencyAllocationSchema = z.number().int().positive();

/**
 * The allocation a new enrollment gets when the operator names none — the safe
 * value, and the one every other concurrency default in SWARM already carries:
 * `DEFAULT_WORKER_CONCURRENCY` (`src/worker/runtime-options.ts`) and
 * `PROJECT_DEFAULTS.maxConcurrentJobs` (`src/config/schema.ts`) are both `1`
 * too. Kept separate from those rather than derived from them: they bound
 * different things (a process, a project, one worker's share of a project) and
 * happen to agree on the value, so re-defaulting one must not silently move the
 * others. The `worker_project_enrollments.concurrency_allocation` column default
 * mirrors this constant.
 */
export const DEFAULT_CONCURRENCY_ALLOCATION = 1;

/**
 * A single worker-project enrollment. `workerId` is a `workers.id` (`uuid`);
 * `projectId` is a `projects.id` (`text`, externally supplied); `id` is the
 * enrollment row's own generated `uuid`. Unique per `(workerId, projectId)` — a
 * worker holds at most one enrollment per project (enforced by the table's
 * unique index, `src/db/schema/workerProjectEnrollments.ts`).
 *
 * `allowedClis` is the read-model form of the constraint (a plain
 * `AgentCli[]`, like `WorkerSchema.capabilities`); the non-empty/de-duped/subset
 * validation happens on the write path. This model carries **no secret** — no
 * repo paths, PATs, local CLI tokens, or credential hashes — by construction.
 */
export const WorkerEnrollmentSchema = z.object({
	id: z.string().uuid(),
	workerId: z.string().uuid(),
	projectId: z.string().min(1),
	status: EnrollmentStatusSchema,
	allowedClis: z.array(AgentCliSchema),
	concurrencyAllocation: ConcurrencyAllocationSchema,
	sharingConsent: z.boolean(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export type WorkerEnrollment = z.infer<typeof WorkerEnrollmentSchema>;

/**
 * Raised when an enrollment's `allowedClis` are not a subset of the worker's
 * declared `capabilities` — a worker cannot be permitted to run a CLI it never
 * declared it can run. A distinct type so the router can surface it as a
 * `BAD_REQUEST` rather than an unexpected failure.
 */
export class AllowedClisNotCapableError extends Error {
	constructor(
		public readonly workerId: string,
		public readonly offending: AgentCli[],
	) {
		super(
			`Worker ${workerId} cannot be enrolled to run CLIs it does not declare: ${offending.join(', ')}`,
		);
		this.name = 'AllowedClisNotCapableError';
	}
}

/**
 * The routability predicate — the named seam the #130 dispatch gate checks
 * before it lets a worker receive *future* automatic dispatch (the enrollment
 * analogue of `canReadProject` etc. in `./membership.ts`). A worker is routable
 * for a project only while its enrollment is both `active` **and** carries the
 * owner's `sharingConsent`. Suspending the enrollment or revoking consent flips
 * this to `false` — blocking new dispatch — without terminating a running agent
 * (that is #130's concern, not this predicate's). Takes only the two fields it
 * reads so a caller can pass a partial enrollment.
 */
export function isRoutable(
	enrollment: Pick<WorkerEnrollment, 'status' | 'sharingConsent'>,
): boolean {
	return enrollment.status === 'active' && enrollment.sharingConsent;
}
