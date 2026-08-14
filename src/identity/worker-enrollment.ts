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
 * of the worker's declared capabilities; `allowedPhases` — the pipeline phases
 * this project may route to the worker; `concurrencyAllocation`), and the
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
import { ALL_TRIGGER_PHASES, type TriggerPhase, TriggerPhaseSchema } from '../triggers/types.js';

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
 * The pipeline phases an enrollment permits on this project (issue #509): a
 * non-empty, de-duplicated set of `TriggerPhase` values. This is the **owner's
 * routing choice**, scoped to one enrollment — deliberately a different thing
 * from the worker's `supportedPhases` (`./worker.ts`), which is what the
 * machine's *daemon* declares it can execute and is re-declared on every
 * reconnect. Both are required for eligibility (`./worker-eligibility.ts`), so
 * the same worker can be offered `implementation` on one project and the whole
 * repertoire on another.
 *
 * An empty set is rejected on the same reasoning as
 * {@link EnrollmentAllowedClisSchema}: "this worker takes no work here" is a
 * `suspended` status or revoked sharing consent, not a constraint that permits
 * nothing. The transform de-dupes, mirroring the two capability schemas.
 *
 * Unlike `allowedClis`, this is **not** validated as a subset of what the machine
 * declares. A CLI capability reduction is refused while an enrollment still needs
 * it (`WorkerCapabilityReductionError`), so `allowedClis ⊆ capabilities` is a
 * maintained invariant; a daemon narrows its *phase* repertoire freely on
 * reconnect (that is the point — the owner's choice must survive it), so
 * containment cannot be an invariant here. Enforcing it on the write path would
 * only reject a save that merely preserves what is already stored. Eligibility
 * ANDs the two sets instead, so a phase the daemon no longer declares is simply
 * never dispatched.
 */
export const EnrollmentAllowedPhasesSchema = z
	.array(TriggerPhaseSchema)
	.nonempty()
	.transform((phases) => [...new Set(phases)]);

/**
 * The phases a new enrollment permits when the caller names none, and the
 * `worker_project_enrollments.allowed_phases` column default: **every** phase, so
 * an enrollment created (or migrated) without a deliberate choice constrains
 * nothing beyond what the daemon and the project already constrain — exactly the
 * behavior before phases were selectable per enrollment at all.
 *
 * Deliberately *not* the worker's own `supportedPhases`, tempting as the tighter
 * set is: that column states whichever **program** currently operates the row
 * (`updateWorkerSupportedPhases`, `src/db/repositories/workersRepository.ts`), so
 * seeding an owner's durable choice from it would let one narrow session
 * permanently narrow an enrollment nobody chose to narrow. Since issue #536 the
 * DB-free `connect` daemon declares every phase, so the narrow session is a
 * daemon on an older build rather than a different kind of program — the same
 * skew, and the same reason not to seed from it.
 */
export const DEFAULT_ENROLLMENT_ALLOWED_PHASES: readonly TriggerPhase[] = ALL_TRIGGER_PHASES;

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
 * This worker's position in the **project's** configured worker order (issue
 * #750) — a non-negative integer read ascending, so `0` comes first. It is
 * meaningful only *relative to the other enrollments of the same project*: it is
 * not an identity, not a count, and comparing it across projects says nothing.
 *
 * Duplicates are legal rather than a defect, which is why the column carries no
 * unique constraint. Every row an installation already had migrates to
 * {@link DEFAULT_ENROLLMENT_ORDER_INDEX}, and two concurrent enrollments can
 * compute the same append position; the project read
 * (`listEnrollmentsForProject`) therefore orders by `(order_index, created_at,
 * id)`, so a tie falls back to exactly the creation order it used before this
 * column existed and stays deterministic.
 */
export const EnrollmentOrderIndexSchema = z.number().int().nonnegative();

/**
 * The position every existing enrollment migrates to, and the
 * `worker_project_enrollments.order_index` column default. Zero for the whole
 * table is deliberately the entire backfill: with the `(order_index, created_at,
 * id)` read ordering, an all-zero project reads back in precisely the creation
 * order it read in before, so an installation sees no behaviour change until
 * somebody reorders a project (a reorder then normalizes that project's
 * positions to a dense `0..n-1`). A *new* enrollment does not take this value —
 * `createEnrollment` appends it after the project's current last worker, so
 * enrolling a machine never jumps it into the middle of a configured order.
 */
export const DEFAULT_ENROLLMENT_ORDER_INDEX = 0;

/**
 * Which way a reorder moves a worker within its project's order (issue #750) —
 * one step towards the front (`up`) or the back (`down`), swapping it with the
 * neighbour it passes. Deliberately a direction rather than a target position: a
 * client that sent an index would be stating an order it may have read before
 * somebody else changed it, whereas a direction is re-resolved server-side
 * against the stored order every time.
 */
export const WorkerOrderDirectionSchema = z.enum(['up', 'down']);

export type WorkerOrderDirection = z.infer<typeof WorkerOrderDirectionSchema>;

/**
 * A single worker-project enrollment. `workerId` is a `workers.id` (`uuid`);
 * `projectId` is a `projects.id` (`text`, externally supplied); `id` is the
 * enrollment row's own generated `uuid`. Unique per `(workerId, projectId)` — a
 * worker holds at most one enrollment per project (enforced by the table's
 * unique index, `src/db/schema/workerProjectEnrollments.ts`).
 *
 * `allowedClis` and `allowedPhases` are the read-model form of the two
 * constraints (plain `AgentCli[]` / `TriggerPhase[]`, like
 * `WorkerSchema.capabilities`); the non-empty/de-duped (and, for CLIs, subset)
 * validation happens on the write path. This model carries **no secret** — no
 * repo paths, PATs, local CLI tokens, or credential hashes — by construction.
 */
export const WorkerEnrollmentSchema = z.object({
	id: z.string().uuid(),
	workerId: z.string().uuid(),
	projectId: z.string().min(1),
	status: EnrollmentStatusSchema,
	allowedClis: z.array(AgentCliSchema),
	allowedPhases: z.array(TriggerPhaseSchema),
	concurrencyAllocation: ConcurrencyAllocationSchema,
	/** This worker's rank within its project's order (issue #750) — see {@link EnrollmentOrderIndexSchema}. */
	orderIndex: EnrollmentOrderIndexSchema,
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
 * Raised when an enrollment would pair a worker with a project whose repository
 * is not the repository the worker's own checkout is (issue #690) — the
 * enrollment-time twin of the daemon's pre-flight assignment refusal (issue
 * #688). A worker holds a single local checkout, so an enrollment into a project
 * for a different repository can only ever produce refused work.
 *
 * Both slugs are named so the operator can see *which* two disagree; the
 * declaration is the worker's own normalised `Worker.repository`, the project
 * side is `ProjectConfig.repo` as configured. A distinct type so the router
 * surfaces it as a `BAD_REQUEST` and the CLI as one actionable line, exactly as
 * {@link AllowedClisNotCapableError} is surfaced.
 */
export class EnrollmentRepositoryMismatchError extends Error {
	constructor(
		public readonly workerId: string,
		public readonly declaredRepository: string,
		public readonly projectRepository: string,
	) {
		super(
			`Worker ${workerId} cannot be enrolled in a project for repository '${projectRepository}': ` +
				`its checkout is '${declaredRepository}'. Enroll a worker whose checkout is that ` +
				'repository, or point this one at it.',
		);
		this.name = 'EnrollmentRepositoryMismatchError';
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

/**
 * Whether this enrollment permits a phase on its project (issue #509) — the named
 * seam the eligibility predicate reads, next to {@link isRoutable}. It answers
 * only the owner's routing choice: whether the *machine* can execute the phase at
 * all (`Worker.supportedPhases`) and whether the *project* runs it
 * (`pipeline.<phase>.enabled`) are separate, independently enforced conditions.
 * Takes only the field it reads so a caller can pass a partial enrollment.
 */
export function permitsPhase(
	enrollment: Pick<WorkerEnrollment, 'allowedPhases'>,
	phase: TriggerPhase,
): boolean {
	return enrollment.allowedPhases.includes(phase);
}
