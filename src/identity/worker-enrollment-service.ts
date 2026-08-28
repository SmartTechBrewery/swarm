/**
 * Provider-neutral **worker-enrollment** surface — the seam the tRPC `workers`
 * router, the `swarm workers` CLI, and (later) the #130 dispatch gate program
 * against so they never touch the `worker_project_enrollments` table directly.
 * Phase 3 of the worker slice, on top of Phase 1's identity
 * (`./worker-service.ts`) and Phase 2's sessions (`./worker-session-service.ts`),
 * and the enrollment-side companion to the membership read model
 * (`./membership-service.ts`).
 *
 * It owns both the enrollment write operations (`enrollWorker` /
 * `approveEnrollment` / `setSharingConsent` / `updateEnrollmentConstraints` /
 * `setEnrollmentStatus` / `moveProjectWorkerOrder` /
 * `suspendEnrollmentsForMismatchedRepository`) and the two
 * provider-neutral read models:
 *
 * - `listProjectRoster(projectId)` — every worker enrolled in a project, with
 *   display name, owner, capabilities, status, allowed CLIs, allowed phases,
 *   concurrency, sharing consent, the derived {@link isRoutable} verdict, and
 *   derived busy/current-run state.
 * - `listOwnerWorkers(ownerUserId)` — an owner's self-service view of their own
 *   workers and each worker's enrollments across projects.
 * - `listDashboardWorkers(projectScope)` — the cross-project connectivity roster
 *   the dashboard's Workers screen renders (#133), scoped to what the viewer may
 *   see.
 * - `getDashboardWorkerDetail(workerId, projectScope)` — that same row for **one**
 *   worker (#477), widened with the full enrollment detail per visible project and
 *   with the two raw halves of the CLI axis (issue #783: the owner's
 *   `declaredCapabilities` and the daemon's `probedCapabilities`), for the Workers
 *   screen's per-worker detail view.
 * - `listProjectDispatchCandidates(projectId)` — the same project scope in the
 *   shape the #130 dispatch gate judges (`src/worker/eligibility-gate.ts`):
 *   worker + enrollment + resolved availability, in the project's configured
 *   worker order (issue #750) — the deterministic sequence the scheduler selects
 *   by, which on a project nobody has reordered is still enrollment-creation
 *   order.
 * - `listProjectWorkerIdsInOrder(projectId)` — that same order as bare worker
 *   ids, for a caller that already holds the rows and only needs to sort them.
 *
 * **A worker is only ever enrolled in a project for the repository its own
 * checkout is** (issue #690). Both moments the pairing becomes knowable are
 * policed here: `enrollWorker` refuses a mismatched write
 * (`EnrollmentRepositoryMismatchError`), and
 * `suspendEnrollmentsForMismatchedRepository` suspends an existing enrollment when
 * a reconnecting daemon declares a repository that contradicts it. Neither ever
 * *creates* or *activates* an enrollment from a declaration — approval and sharing
 * consent stay the human decisions ADR-001 makes them — and a worker that declared
 * no repository is left alone by both.
 *
 * **No secrets** leave this surface. The assembled views are built by explicitly
 * naming the safe fields (never spreading a row), so a repo path, PAT, local
 * CLI token, or credential hash can never ride along — the `Worker` read model
 * already omits the credential hash, and this layer reaches for project config
 * only to read a project's own `repo` slug (a non-secret `owner/repo`), never its
 * credentials or worktree paths.
 *
 * **Busy/current-run is derived from run lifecycle, never client-supplied**:
 * `deriveWorkerRunState` reads the worker's unexpired durable dispatch claims
 * independently of its live Phase-2 session (`getLiveSessionForWorker`), then
 * falls back to the session pointer when no claim exists. A stale
 * `current_run_id` left over from a completed/failed run reads as idle.
 */

import {
	getActiveWorkerClaims,
	getWorkerDispatchClaimState,
} from '../db/repositories/dispatchesRepository.js';
import { findProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import { getRunByIdFromDb } from '../db/repositories/runsRepository.js';
import { getUserById } from '../db/repositories/usersRepository.js';
import {
	createEnrollment,
	getEnrollmentById,
	listEnrollmentsForProject,
	listEnrollmentsForWorker,
	moveEnrollmentInProjectOrder,
	setEnrollmentSharingConsent,
	updateEnrollmentConstraints as updateEnrollmentConstraintsRow,
	updateEnrollmentStatus,
} from '../db/repositories/workerEnrollmentsRepository.js';
import {
	getWorkerById,
	listAllWorkers,
	listWorkersForOwner,
} from '../db/repositories/workersRepository.js';
import type { AgentCli } from '../harness/agent-cli.js';
import { logger } from '../lib/logger.js';
import { normalizeRepoSlug, repoSlugsMatch } from '../scm/repo-slug.js';
import type { TriggerPhase } from '../triggers/types.js';
import type { Worker } from './worker.js';
import type { WorkerAvailability } from './worker-eligibility.js';
import {
	AllowedClisNotCapableError,
	ConcurrencyAllocationSchema,
	DEFAULT_CONCURRENCY_ALLOCATION,
	DEFAULT_ENROLLMENT_ALLOWED_PHASES,
	EnrollmentAllowedClisSchema,
	EnrollmentAllowedPhasesSchema,
	EnrollmentRepositoryMismatchError,
	type EnrollmentStatus,
	isRoutable,
	type WorkerEnrollment,
	type WorkerOrderDirection,
} from './worker-enrollment.js';
import { getLiveSessionForWorker, getRetainedSessionForWorker } from './worker-session-service.js';

export {
	AllowedClisNotCapableError,
	ConcurrencyAllocationSchema,
	DEFAULT_CONCURRENCY_ALLOCATION,
	DEFAULT_ENROLLMENT_ALLOWED_PHASES,
	DEFAULT_ENROLLMENT_ORDER_INDEX,
	ENROLLMENT_STATUSES,
	EnrollmentAllowedClisSchema,
	EnrollmentAllowedPhasesSchema,
	EnrollmentOrderIndexSchema,
	EnrollmentRepositoryMismatchError,
	type EnrollmentStatus,
	EnrollmentStatusSchema,
	isRoutable,
	permitsPhase,
	type WorkerEnrollment,
	type WorkerOrderDirection,
	WorkerOrderDirectionSchema,
} from './worker-enrollment.js';

/**
 * Derived run state for a worker — never client-supplied. `busy` is `true` when
 * its live session has at least one active durable dispatch claim;
 * `currentRunId` is one representative run id, or `null` when idle. The legacy
 * session pointer remains a fallback for rows created before dispatch claims.
 */
export interface WorkerRunState {
	busy: boolean;
	currentRunId: string | null;
}

/** The owner shown on a roster entry — a non-secret identity, never a credential. */
export interface RosterOwner {
	userId: string;
	identifier: string;
	displayName: string;
}

/** One row of the project roster read model — secret-free by construction. */
export interface WorkerRosterEntry {
	enrollmentId: string;
	workerId: string;
	projectId: string;
	displayName: string;
	owner: RosterOwner | null;
	capabilities: AgentCli[];
	status: EnrollmentStatus;
	allowedClis: AgentCli[];
	/** The pipeline phases this project may route to the worker (issue #509). */
	allowedPhases: TriggerPhase[];
	/** This worker's share of the project — a positive integer (see `ConcurrencyAllocationSchema`). */
	concurrencyAllocation: number;
	sharingConsent: boolean;
	isRoutable: boolean;
	runState: WorkerRunState;
}

/** One enrollment in an owner's self-service view — secret-free by construction. */
export interface OwnerEnrollmentView {
	enrollmentId: string;
	projectId: string;
	status: EnrollmentStatus;
	allowedClis: AgentCli[];
	/** The pipeline phases this project may route to the worker (issue #509). */
	allowedPhases: TriggerPhase[];
	/** This worker's share of the project — a positive integer (see `ConcurrencyAllocationSchema`). */
	concurrencyAllocation: number;
	sharingConsent: boolean;
	isRoutable: boolean;
}

/** One worker in an owner's self-service view, with its enrollments — secret-free by construction. */
export interface OwnerWorkerView {
	workerId: string;
	displayName: string;
	capabilities: AgentCli[];
	runState: WorkerRunState;
	enrollments: OwnerEnrollmentView[];
}

/**
 * Read a worker's execution state once: whether it holds a live lease
 * (connection/health), whether it has an unexpired durable dispatch claim, and,
 * when its session points at a run without a claim, whether that run is
 * *actually* `running` in `runs`. Both derived read models below need the same
 * facts, so they share one pass rather than each re-reading the session.
 */
async function readWorkerExecutionState(
	workerId: string,
	projectId?: string,
): Promise<{ connected: boolean; activeRuns: number; runningRunId: string | null }> {
	const session = await getLiveSessionForWorker(workerId);
	const claims = await getWorkerDispatchClaimState(workerId, projectId);
	if (claims.activeRuns > 0) {
		return {
			connected: Boolean(session),
			activeRuns: claims.activeRuns,
			runningRunId: claims.currentRunId,
		};
	}
	if (!session) return { connected: false, activeRuns: 0, runningRunId: null };
	if (!session.currentRunId) return { connected: true, activeRuns: 0, runningRunId: null };
	const run = await getRunByIdFromDb(session.currentRunId);
	const runningRunId = run?.status === 'running' ? run.id : null;
	return { connected: true, activeRuns: runningRunId ? 1 : 0, runningRunId };
}

/**
 * Derive a worker's busy/current-run state from the run lifecycle. Reads the
 * worker's unexpired durable dispatch claims, independently of its live
 * Phase-2 session. When there is no claim, the live session's `current_run_id`
 * remains a compatibility fallback and the worker is `busy` **only if** that
 * run's status is `running` — a stale pointer to a completed/failed run reads
 * as idle. The status is read from `runs`, never trusted from a caller.
 */
export async function deriveWorkerRunState(workerId: string): Promise<WorkerRunState> {
	const { activeRuns, runningRunId } = await readWorkerExecutionState(workerId);
	return { busy: activeRuns > 0, currentRunId: runningRunId };
}

/** Assemble one roster entry from an enrollment + its worker + owner + derived run state. */
function assembleRosterEntry(
	enrollment: WorkerEnrollment,
	worker: Worker,
	owner: RosterOwner | null,
	runState: WorkerRunState,
): WorkerRosterEntry {
	return {
		enrollmentId: enrollment.id,
		workerId: worker.id,
		projectId: enrollment.projectId,
		displayName: worker.displayName,
		owner,
		capabilities: worker.capabilities,
		status: enrollment.status,
		allowedClis: enrollment.allowedClis,
		allowedPhases: enrollment.allowedPhases,
		concurrencyAllocation: enrollment.concurrencyAllocation,
		sharingConsent: enrollment.sharingConsent,
		isRoutable: isRoutable(enrollment),
		runState,
	};
}

/** Assemble one owner-view enrollment (no worker/owner fields — the owner already knows those). */
function assembleOwnerEnrollmentView(enrollment: WorkerEnrollment): OwnerEnrollmentView {
	return {
		enrollmentId: enrollment.id,
		projectId: enrollment.projectId,
		status: enrollment.status,
		allowedClis: enrollment.allowedClis,
		allowedPhases: enrollment.allowedPhases,
		concurrencyAllocation: enrollment.concurrencyAllocation,
		sharingConsent: enrollment.sharingConsent,
		isRoutable: isRoutable(enrollment),
	};
}

/**
 * The provider-neutral project roster: every worker enrolled in `projectId`,
 * with the secret-free view and derived busy/current-run state. **Project
 * isolation** falls out of the query being keyed on `projectId` — a worker
 * enrolled only in another project never appears here. Empty if the project has
 * no enrollments. An enrollment whose worker vanished (should not happen — the
 * FK cascades) is skipped defensively.
 */
export async function listProjectRoster(projectId: string): Promise<WorkerRosterEntry[]> {
	const enrollments = await listEnrollmentsForProject(projectId);
	const entries: WorkerRosterEntry[] = [];
	for (const enrollment of enrollments) {
		const worker = await getWorkerById(enrollment.workerId);
		if (!worker) continue;
		const ownerUser = await getUserById(worker.ownerUserId);
		const owner: RosterOwner | null = ownerUser
			? {
					userId: ownerUser.id,
					identifier: ownerUser.identifier,
					displayName: ownerUser.displayName,
				}
			: null;
		const runState = await deriveWorkerRunState(worker.id);
		entries.push(assembleRosterEntry(enrollment, worker, owner, runState));
	}
	return entries;
}

/**
 * One worker the dispatch gate may consider for a project (#130 Phase 3) — the
 * exact triple `evaluateWorkerEligibility` (`./worker-eligibility.ts`) judges. Unlike
 * {@link WorkerRosterEntry} (a human-facing roster row) this keeps the domain
 * shapes intact, including the worker's `ownerUserId`, which assignee affinity
 * routes on. Still secret-free: `Worker` never carries the credential hash.
 */
export interface WorkerDispatchCandidate {
	worker: Worker;
	enrollment: WorkerEnrollment;
	availability: WorkerAvailability;
}

/**
 * Every worker enrolled in `projectId`, in the scheduler's **deterministic
 * order**: the project's configured worker order, then enrollment creation time
 * and enrollment id as the tie-breaks (`listEnrollmentsForProject`, issue #750).
 * That order is the documented "first free eligible worker" sequence — stable
 * across dispatches, so two re-checks of the same roster select the same worker,
 * and on a project nobody has reordered it is exactly the enrollment-creation
 * order it has always been.
 *
 * Ordering is a *preference between* workers, never a grant: the gate still judges
 * every candidate with `evaluateWorkerEligibility`, so an unavailable,
 * over-capacity, unapproved or otherwise ineligible worker is skipped in favour of
 * the next eligible one however early it sits in the order.
 *
 * Ineligible workers are **not** filtered here: judging them is
 * `evaluateWorkerEligibility`'s job (it needs the enrollment and
 * availability to name *why*), so this read model stays a plain project-scoped
 * listing. Project isolation falls out of the query being keyed on `projectId`.
 * An enrollment whose worker vanished is skipped defensively, exactly as
 * {@link listProjectRoster} does.
 */
export async function listProjectDispatchCandidates(
	projectId: string,
): Promise<WorkerDispatchCandidate[]> {
	const enrollments = await listEnrollmentsForProject(projectId);
	const candidates: WorkerDispatchCandidate[] = [];
	for (const enrollment of enrollments) {
		const worker = await getWorkerById(enrollment.workerId);
		if (!worker) continue;
		const { connected, activeRuns } = await readWorkerExecutionState(worker.id, projectId);
		candidates.push({
			worker,
			enrollment,
			availability: { connected, activeRuns },
		});
	}
	return candidates;
}

/**
 * The ids of the workers enrolled in `projectId`, in the project's configured
 * order (issue #750). The same order {@link listProjectDispatchCandidates} and
 * {@link listProjectRoster} come back in, reduced to what a caller that already
 * holds its rows needs to sort them — the dashboard roster read
 * ({@link listDashboardWorkers}) is keyed on the *worker*, so it carries no
 * enrollment position of its own.
 *
 * Includes every enrollment regardless of status: this states the project's order,
 * not who may take work. Empty for a project with no enrollments.
 */
export async function listProjectWorkerIdsInOrder(projectId: string): Promise<string[]> {
	const enrollments = await listEnrollmentsForProject(projectId);
	return enrollments.map((enrollment) => enrollment.workerId);
}

/**
 * The owner self-service view: every worker `ownerUserId` operates, each with
 * its enrollments across projects and its derived run state. Scoped strictly to
 * the owner's own workers, so it returns nothing for a user who operates none.
 */
export async function listOwnerWorkers(ownerUserId: string): Promise<OwnerWorkerView[]> {
	const workers = await listWorkersForOwner(ownerUserId);
	const views: OwnerWorkerView[] = [];
	for (const worker of workers) {
		const enrollments = await listEnrollmentsForWorker(worker.id);
		const runState = await deriveWorkerRunState(worker.id);
		views.push({
			workerId: worker.id,
			displayName: worker.displayName,
			capabilities: worker.capabilities,
			runState,
			enrollments: enrollments.map(assembleOwnerEnrollmentView),
		});
	}
	return views;
}

/**
 * Whether a worker's lease is live under the heartbeat TTL right now. Derived
 * only from {@link getLiveSessionForWorker}, so the dashboard and the dispatch
 * gate share one definition of "connected" and there is no second TTL.
 */
export type WorkerConnectionState = 'online' | 'offline';

/**
 * One enrollment as the dashboard roster shows it — project + approval state,
 * nothing operable, plus the enrollment's own `allowedClis` (a subset of the
 * worker's declared `capabilities`) so the roster's Capabilities column can
 * show what this project may actually run on the worker rather than everything
 * the machine merely declares.
 */
export interface DashboardEnrollmentView {
	projectId: string;
	status: EnrollmentStatus;
	allowedClis: AgentCli[];
}

/**
 * The job a worker is executing right now, as the Workers screen's **Active job**
 * column describes it (issue #473). It carries the same work-item fields the Runs
 * table's Task cell renders — the resolved Issue/PR title and its reference — so
 * both screens describe one run identically instead of the Workers screen showing
 * a run UUID that means nothing to an operator.
 *
 * The fields are named explicitly rather than passing the run row through: a run
 * carries a job payload, error text, and usage that have no business on a roster
 * read model.
 */
export interface DashboardWorkerRun {
	runId: string;
	/** The run's project, so the Active job line can name it. */
	projectId: string;
	/**
	 * The repository the run acted on (`owner/repo`) — carried on the summary so the
	 * Active job cell builds its PR link from the run itself (issue #691) rather than
	 * from the owning project's repo, which identifies one only while the project
	 * owns exactly one.
	 */
	repository: string;
	taskId: string;
	phase: string;
	workItemId: string | null;
	workItemTitle: string | null;
	workItemUrl: string | null;
	prNumber: string | null;
	prTitle: string | null;
}

/**
 * One row of the cross-project dashboard roster (#133) — secret-free by
 * construction, and read-only: it carries no machine path, credential, allowed-CLI
 * constraint, or consent/approval affordance, only what the Workers screen renders.
 */
export interface DashboardWorkerView {
	workerId: string;
	displayName: string;
	owner: RosterOwner | null;
	capabilities: AgentCli[];
	/**
	 * The pipeline phases the machine's daemon declared it can execute (issue
	 * #467) — the second capability axis, independent of the CLIs above: a machine
	 * can have every CLI and still refuse a phase. Today's DB-free daemon declares
	 * all six (`SUPPORTED_DB_FREE_PHASES`, `../transport/assignment-execution.ts`,
	 * issue #536), so what this now surfaces is mostly version skew — a machine still
	 * on an older build. The Workers screen reads it to say so, rather than leaving
	 * an operator to infer it from work that never starts.
	 */
	supportedPhases: TriggerPhase[];
	/**
	 * Which repository the machine's one local checkout is (issue #687), in the
	 * shared normalised `owner/repo` form, or `null` when it declared none. Read by
	 * the Workers screen as one half of the reason a mismatched enrollment was
	 * refused or suspended (issue #690) — the other half being each enrollment's own
	 * `projectRepo` below.
	 *
	 * Non-secret and named explicitly, like every other field here: a repository slug
	 * is not the machine's path (`SWARM_WORKER_REPO_ROOT` stays host-local and never
	 * travels) and not a credential.
	 */
	repository: string | null;
	connection: WorkerConnectionState;
	/** When the worker was last heard from, or `null` if it never connected. */
	lastSeenAt: Date | null;
	/** The job it is executing right now, or `null` when idle or the run is out of the viewer's scope. */
	currentRun: DashboardWorkerRun | null;
	enrollments: DashboardEnrollmentView[];
}

/**
 * One enrollment on the per-worker detail view (issue #477) — the same
 * secret-free enrollment facts {@link WorkerRosterEntry} carries for a project,
 * minus the worker/owner fields the surrounding view already states. These are
 * exactly the facts that answer "why is this machine not taking work here?":
 * approval `status`, the effective `allowedClis`, the effective `allowedPhases`,
 * the `concurrencyAllocation`, the owner's `sharingConsent`, and the derived
 * {@link isRoutable} verdict.
 */
export interface DashboardWorkerEnrollmentDetail {
	enrollmentId: string;
	projectId: string;
	status: EnrollmentStatus;
	allowedClis: AgentCli[];
	/**
	 * The pipeline phases this project may route to the worker (issue #509) — the
	 * owner's choice, read against the machine's declared `supportedPhases` (on the
	 * surrounding view) rather than in place of it: a phase is dispatched here only
	 * when both name it.
	 */
	allowedPhases: TriggerPhase[];
	/** This worker's share of the project — a positive integer (see `ConcurrencyAllocationSchema`). */
	concurrencyAllocation: number;
	sharingConsent: boolean;
	isRoutable: boolean;
	/**
	 * This enrollment's project repository (issue #690), in the **same normalised
	 * form** as the surrounding view's `repository`, so comparing the two on the
	 * screen is the same comparison the write path makes (`repoSlugsMatch`) — the
	 * dashboard deliberately does not import `../scm/repo-slug.ts`, whose slug reader
	 * spawns `git`. `null` only when the project no longer resolves.
	 *
	 * The reason for a mismatched enrollment is these two live facts rather than a
	 * sentence stored when it was refused or suspended: repositories change, and a
	 * stored sentence would go stale where the pair cannot.
	 */
	projectRepo: string | null;
}

/**
 * One worker as its detail view shows it (issue #477): the cross-project roster
 * row, plus the full enrollment detail per visible project. Secret-free by
 * construction for the same reason the row is — it is assembled from the row's
 * own assembler and named enrollment fields, never from a spread table row.
 */
export interface DashboardWorkerDetailView extends DashboardWorkerView {
	/**
	 * The owner's user id — the same non-secret identity `owner.userId` carries,
	 * repeated here because it stays authoritative when the owner's user row no
	 * longer resolves (`owner` is `null` then). A caller tests ownership against
	 * this rather than performing a second worker read.
	 */
	ownerUserId: string;
	/**
	 * The owner's **durable CLI declaration** (issue #783), or `null` when none has
	 * been made. Not the same fact as the row's `capabilities`, which is the
	 * *effective* set (`effectiveCapabilities`, `./worker.ts`): a declaration the
	 * machine's latest probe no longer backs has already been intersected away
	 * there, so the detail view carries the declaration itself to say the machine
	 * stopped reporting it rather than silently showing a narrower set.
	 *
	 * Here rather than on the roster row because it is the fact the detail view's
	 * owner-only CLI control writes (`workers.setDeclaredCapabilities`, issue #787);
	 * the rosters keep rendering the effective set they already render.
	 */
	declaredCapabilities: AgentCli[] | null;
	/**
	 * What the machine's daemon last reported finding on its own PATH — the raw
	 * probe, rewritten at every handshake (issue #783). The detail view offers one
	 * checkbox per entry, because a declaration naming anything else is refused
	 * server-side (`WorkerCapabilityNotProbedError`).
	 */
	probedCapabilities: AgentCli[];
	enrollments: DashboardWorkerEnrollmentDetail[];
}

/**
 * The project ids a dashboard viewer may see: `null` for an installation
 * administrator (no restriction at all), otherwise the exact set of projects
 * they are a member of. Mirrors `accessibleProjectScope` (`src/api/authz.ts`),
 * whose result callers pass straight through — this layer never re-derives
 * roles or membership.
 */
export type DashboardProjectScope = string[] | null;

/**
 * The dashboard's cross-project worker roster (#133). An administrator
 * (`projectScope === null`) sees **every registered worker**, including one with
 * no enrollment at all; anyone else sees only workers enrolled in a project they
 * may access, with the inaccessible enrollments stripped from the row. A viewer
 * with no accessible project sees nothing. Workers come back oldest-first and
 * de-duplicated regardless of how many visible projects they are enrolled in.
 *
 * Connectivity is derived, never client-supplied: `connection` comes from the
 * live-session TTL, `lastSeenAt` from the retained session row (so an expired or
 * released worker keeps its last heartbeat), and `currentRun` is exposed only
 * while that run is actually `running` **and** belongs to a project in scope —
 * an in-flight run from an inaccessible project never leaks through a worker the
 * viewer happens to share another project with.
 */
export async function listDashboardWorkers(
	projectScope: DashboardProjectScope,
): Promise<DashboardWorkerView[]> {
	if (projectScope !== null && projectScope.length === 0) return [];
	const accessible = projectScope === null ? null : new Set(projectScope);
	const views: DashboardWorkerView[] = [];
	for (const worker of await listAllWorkers()) {
		const enrollments = await listEnrollmentsForWorker(worker.id);
		const visible = accessible
			? enrollments.filter((enrollment) => accessible.has(enrollment.projectId))
			: enrollments;
		// A restricted viewer only sees a machine they share a project with; an
		// administrator also sees a registered-but-never-enrolled one.
		if (accessible && visible.length === 0) continue;
		views.push(await assembleDashboardWorker(worker, visible, accessible));
	}
	return views;
}

/**
 * One worker's detail view (issue #477), or `null` when the viewer may not see
 * it. An administrator (`projectScope === null`) sees any registered worker,
 * including an un-enrolled one. A restricted viewer sees only a worker enrolled
 * in an accessible project, with inaccessible enrollments stripped from the view;
 * the one exception is the worker's own owner, who may also read their
 * registered-but-un-enrolled machine to create its first enrollment. `null` is
 * indistinguishable from "no such worker" on purpose — the caller turns both into
 * one `NOT_FOUND` so worker existence never leaks to a non-owner.
 *
 * Where the roster row carries only `(projectId, status)` per enrollment, this
 * carries the full per-project enrollment detail, so the detail screen can
 * explain routability without a roster query per project. It also carries the two
 * raw CLI facts the row's effective set is derived from (issue #783), which is what
 * lets the detail screen offer the owner's declaration as a control instead of a
 * badge.
 */
export async function getDashboardWorkerDetail(
	workerId: string,
	projectScope: DashboardProjectScope,
	viewerUserId?: string,
): Promise<DashboardWorkerDetailView | null> {
	const worker = await getWorkerById(workerId);
	if (!worker) return null;
	const viewerIsOwner = worker.ownerUserId === viewerUserId;
	if (projectScope !== null && projectScope.length === 0 && !viewerIsOwner) return null;
	const accessible = projectScope === null ? null : new Set(projectScope);
	const enrollments = await listEnrollmentsForWorker(worker.id);
	const visible = accessible
		? enrollments.filter((enrollment) => accessible.has(enrollment.projectId))
		: enrollments;
	if (accessible && visible.length === 0 && !viewerIsOwner) return null;
	// Spreading the *assembled view* (not a row) keeps the one place that names
	// the safe worker fields — `assembleDashboardWorker` — as the only assembler.
	const row = await assembleDashboardWorker(worker, visible, accessible);
	return {
		...row,
		ownerUserId: worker.ownerUserId,
		// The two raw halves of the CLI axis (issue #783), widened onto the detail view
		// alone: the row's own `capabilities` stays the effective set every roster
		// renders, and this is the pair the owner's declaration control reads.
		declaredCapabilities: worker.declaredCapabilities,
		probedCapabilities: worker.probedCapabilities,
		enrollments: await Promise.all(visible.map(assembleEnrollmentDetail)),
	};
}

/**
 * Assemble one detail-view enrollment by naming each safe field explicitly. The
 * project is read for its repository alone (issue #690) — the enrollment's own
 * fields are never taken from it.
 */
async function assembleEnrollmentDetail(
	enrollment: WorkerEnrollment,
): Promise<DashboardWorkerEnrollmentDetail> {
	const project = await findProjectByIdFromDb(enrollment.projectId);
	return {
		enrollmentId: enrollment.id,
		projectId: enrollment.projectId,
		status: enrollment.status,
		allowedClis: enrollment.allowedClis,
		allowedPhases: enrollment.allowedPhases,
		concurrencyAllocation: enrollment.concurrencyAllocation,
		sharingConsent: enrollment.sharingConsent,
		isRoutable: isRoutable(enrollment),
		projectRepo: project ? normalizeRepoSlug(project.repo) : null,
	};
}

/** Assemble one dashboard row by naming each safe field explicitly (never spreading a row). */
async function assembleDashboardWorker(
	worker: Worker,
	enrollments: WorkerEnrollment[],
	accessible: Set<string> | null,
): Promise<DashboardWorkerView> {
	const ownerUser = await getUserById(worker.ownerUserId);
	const liveSession = await getLiveSessionForWorker(worker.id);
	// The retained row outlives expiry/release, so it is the last-seen source for
	// an offline worker; a live session already carries the freshest heartbeat.
	const lastSeenSession = liveSession ?? (await getRetainedSessionForWorker(worker.id));
	return {
		workerId: worker.id,
		displayName: worker.displayName,
		owner: ownerUser
			? {
					userId: ownerUser.id,
					identifier: ownerUser.identifier,
					displayName: ownerUser.displayName,
				}
			: null,
		capabilities: worker.capabilities,
		supportedPhases: worker.supportedPhases,
		repository: worker.repository,
		connection: liveSession ? 'online' : 'offline',
		lastSeenAt: lastSeenSession?.lastHeartbeatAt ?? null,
		currentRun: await resolveVisibleRun(worker.id, liveSession?.currentRunId ?? null, accessible),
		enrollments: enrollments.map((enrollment) => ({
			projectId: enrollment.projectId,
			status: enrollment.status,
			allowedClis: enrollment.allowedClis,
		})),
	};
}

async function getIfRunningAndAccessible(
	runId: string,
	accessible: Set<string> | null,
): Promise<DashboardWorkerRun | null> {
	const run = await getRunByIdFromDb(runId);
	if (!run || run.status !== 'running') return null;
	if (accessible && !accessible.has(run.projectId)) return null;
	return {
		runId: run.id,
		projectId: run.projectId,
		repository: run.repository,
		taskId: run.taskId,
		phase: run.phase,
		workItemId: run.workItemId,
		workItemTitle: run.workItemTitle,
		workItemUrl: run.workItemUrl,
		prNumber: run.prNumber,
		prTitle: run.prTitle,
	};
}

/**
 * The job a viewer may see for a worker's active work, or `null`.
 * Derives the candidate run from active, unexpired durable dispatch claims,
 * falling back to the legacy session pointer.
 * Validates the pointer against run lifecycle exactly as {@link deriveWorkerRunState}
 * does — a stale pointer to a completed/failed/deleted run reads as idle — and
 * additionally withholds a run whose project is outside a restricted viewer's scope.
 */
async function resolveVisibleRun(
	workerId: string,
	legacyRunId: string | null,
	accessible: Set<string> | null,
): Promise<DashboardWorkerRun | null> {
	const activeClaims = await getActiveWorkerClaims(workerId);
	for (const claim of activeClaims) {
		if (claim.runId) {
			const run = await getIfRunningAndAccessible(claim.runId, accessible);
			if (run) return run;
		}
	}

	if (legacyRunId) {
		return getIfRunningAndAccessible(legacyRunId, accessible);
	}

	return null;
}

/** The fields a caller supplies to enroll a (already-resolved) worker into a project. */
export interface EnrollWorkerInput {
	/** The resolved worker — the caller has already established ownership/existence. */
	worker: Worker;
	projectId: string;
	allowedClis: AgentCli[];
	/**
	 * The pipeline phases this project may route to the worker (issue #509). Omit
	 * for {@link DEFAULT_ENROLLMENT_ALLOWED_PHASES} (every phase) — an enrollment
	 * created without a deliberate choice constrains nothing beyond what the
	 * machine's daemon and the project already do.
	 */
	allowedPhases?: TriggerPhase[];
	/**
	 * This worker's share of the project. Omit for
	 * {@link DEFAULT_CONCURRENCY_ALLOCATION} (`1`) — the safe value an operator
	 * almost always wants when adding a machine; a larger positive integer lets
	 * this one project take several of the worker's slots at once.
	 */
	concurrencyAllocation?: number;
	/** Initial status; defaults to `pending` (awaiting a projectAdmin's approval). */
	status?: EnrollmentStatus;
	/** Initial sharing consent; defaults to `false` (owner opts in explicitly). */
	sharingConsent?: boolean;
}

/**
 * Enroll a worker into a project. Validates `allowedClis` (non-empty,
 * de-duplicated) and enforces that it is a **subset of the worker's declared
 * capabilities** — throwing {@link AllowedClisNotCapableError} otherwise —
 * validates `allowedPhases` (non-empty, de-duplicated, defaulting to
 * {@link DEFAULT_ENROLLMENT_ALLOWED_PHASES}), refuses a project whose repository
 * is not the worker's declared one ({@link EnrollmentRepositoryMismatchError},
 * issue #690), then persists a `pending` enrollment (unless a status is given)
 * with sharing consent off by default and, unless the caller names one, a
 * concurrency allocation of {@link DEFAULT_CONCURRENCY_ALLOCATION}. A duplicate
 * `(worker, project)` surfaces the repository's pg `23505` for the caller to
 * translate.
 */
export async function enrollWorker(input: EnrollWorkerInput): Promise<WorkerEnrollment> {
	const allowedClis = EnrollmentAllowedClisSchema.parse(input.allowedClis);
	assertClisWithinCapabilities(input.worker, allowedClis);
	const allowedPhases = EnrollmentAllowedPhasesSchema.parse(
		input.allowedPhases ?? [...DEFAULT_ENROLLMENT_ALLOWED_PHASES],
	);
	const concurrencyAllocation = ConcurrencyAllocationSchema.parse(
		input.concurrencyAllocation ?? DEFAULT_CONCURRENCY_ALLOCATION,
	);
	await assertProjectIsWorkersRepository(input.worker, input.projectId);
	return createEnrollment({
		workerId: input.worker.id,
		projectId: input.projectId,
		status: input.status ?? 'pending',
		allowedClis,
		allowedPhases,
		concurrencyAllocation,
		sharingConsent: input.sharingConsent ?? false,
	});
}

/** Throw {@link AllowedClisNotCapableError} unless every allowed CLI is a declared capability. */
function assertClisWithinCapabilities(worker: Worker, allowedClis: AgentCli[]): void {
	const capabilitySet = new Set(worker.capabilities);
	const offending = allowedClis.filter((cli) => !capabilitySet.has(cli));
	if (offending.length > 0) {
		throw new AllowedClisNotCapableError(worker.id, offending);
	}
}

/**
 * Throw {@link EnrollmentRepositoryMismatchError} unless the project is for the
 * repository the worker's own checkout is (issue #690) — the first of the two
 * moments the pairing becomes knowable, the other being a reconnecting daemon's
 * declaration ({@link suspendEnrollmentsForMismatchedRepository}).
 *
 * Two cases are deliberately *not* refused:
 *
 * - a worker that declared **no** repository (`repository === null`): an
 *   unidentifiable checkout — a machine that never connected, a daemon on a build
 *   that predates the field, a clone with no readable `origin` — must not lock an
 *   operator out of enrolling their machine at all;
 * - a `projectId` that resolves to no project: this is not a second not-found
 *   path, and inventing one here would answer "does this project exist?" ahead of
 *   the caller's own authorization check. The existing FK on `createEnrollment`
 *   remains what refuses it.
 *
 * The comparison runs through the shared `repoSlugsMatch` (`../scm/repo-slug.ts`),
 * which normalises the *config* side too — a stored declaration is already
 * normalised, a `ProjectConfig.repo` is whatever the operator wrote.
 */
async function assertProjectIsWorkersRepository(worker: Worker, projectId: string): Promise<void> {
	const declared = worker.repository;
	if (!declared) return;
	const project = await findProjectByIdFromDb(projectId);
	if (!project) return;
	if (repoSlugsMatch(project.repo, declared)) return;
	throw new EnrollmentRepositoryMismatchError(worker.id, declared, project.repo);
}

/** One enrollment {@link suspendEnrollmentsForMismatchedRepository} suspended. */
export interface SuspendedMismatchedEnrollment {
	enrollmentId: string;
	projectId: string;
	/** The project's repository, normalised — the half of the reason that is not the declaration. */
	projectRepository: string;
}

/**
 * Suspend every enrollment of `workerId` whose project is **not** for
 * `declaredRepository` (issue #690) — the second moment the pairing becomes
 * knowable, when a reconnecting daemon declares a repository that contradicts an
 * enrollment written before it (or written while the machine declared nothing).
 * Returns what it suspended, so a caller can report it; each suspension is also
 * logged with both repositories, since the daemon's handshake has no operator
 * watching it.
 *
 * It only ever **suspends**. Nothing here creates an enrollment, approves one, or
 * reactivates one — a declaration is the machine's own statement, and enrollment
 * remains the human decision ADR-001 makes it (a project administrator approves,
 * the owner consents). That holds in both directions: an enrollment suspended
 * here stays suspended when a later declaration matches again, because
 * re-activation is the project administrator's act and a machine must not be able
 * to restore its own routability by re-pointing a checkout.
 *
 * Suspension rather than deletion is equally deliberate: the enrollment keeps its
 * constraints (allowed CLIs, allowed phases, allocation, consent) for the operator
 * who fixes the pairing, and suspension blocks only *future* dispatch
 * ({@link isRoutable}) — never a phase already running.
 *
 * An already-`suspended` enrollment is left alone (no redundant write), a project
 * that no longer resolves is skipped rather than guessed at, and a blank
 * declaration suspends nothing — defensive, because "matches nothing" would
 * otherwise suspend every enrollment the worker has.
 */
export async function suspendEnrollmentsForMismatchedRepository(
	workerId: string,
	declaredRepository: string,
): Promise<SuspendedMismatchedEnrollment[]> {
	const declared = normalizeRepoSlug(declaredRepository);
	if (declared === '') return [];
	const suspended: SuspendedMismatchedEnrollment[] = [];
	for (const enrollment of await listEnrollmentsForWorker(workerId)) {
		if (enrollment.status === 'suspended') continue;
		const project = await findProjectByIdFromDb(enrollment.projectId);
		if (!project) continue;
		if (repoSlugsMatch(project.repo, declared)) continue;
		await setEnrollmentStatus(enrollment.id, 'suspended');
		const projectRepository = normalizeRepoSlug(project.repo);
		suspended.push({
			enrollmentId: enrollment.id,
			projectId: enrollment.projectId,
			projectRepository,
		});
		logger.warn(
			'suspended worker enrollment: the declared checkout is not this project’s repository',
			{
				workerId,
				enrollmentId: enrollment.id,
				projectId: enrollment.projectId,
				declaredRepository: declared,
				projectRepository,
			},
		);
	}
	return suspended;
}

/** Resolve an enrollment by id — the read the router uses before an ownership/authz check. */
export async function getEnrollment(id: string): Promise<WorkerEnrollment | undefined> {
	return getEnrollmentById(id);
}

/**
 * Approve a `pending` enrollment → `active` (a `projectAdmin` action). Returns
 * the updated enrollment, or `undefined` if no enrollment has that id. Approval
 * alone does not make a worker routable — the owner must also grant sharing
 * consent ({@link isRoutable}).
 */
export async function approveEnrollment(id: string): Promise<WorkerEnrollment | undefined> {
	return updateEnrollmentStatus(id, 'active');
}

/**
 * Set an enrollment's status directly — `active` (approve/reactivate) or
 * `suspended` (revoke). Suspending flips `isRoutable` false, blocking future
 * dispatch, without deleting the enrollment or touching a running process.
 * Returns the updated enrollment, or `undefined` if no enrollment has that id.
 */
export async function setEnrollmentStatus(
	id: string,
	status: EnrollmentStatus,
): Promise<WorkerEnrollment | undefined> {
	return updateEnrollmentStatus(id, status);
}

/** What a caller supplies to move one worker through a project's order (issue #750). */
export interface MoveProjectWorkerOrderInput {
	projectId: string;
	/** The worker to move — the project-scoped identity the roster renders, not an enrollment id. */
	workerId: string;
	/** One step towards the front (`up`) or the back (`down`). */
	direction: WorkerOrderDirection;
}

/**
 * Move one worker one step through its project's configured worker order (issue
 * #750) — a `projectAdmin` action, gated by the caller. Returns the project's
 * worker ids in the new order, or `undefined` when that worker holds no
 * enrollment in that project (the caller turns that into the same `NOT_FOUND` an
 * unknown project gets, so nothing leaks).
 *
 * Keyed on `(projectId, workerId)` rather than an enrollment id because the order
 * is a project-scoped fact and the roster rows that offer the move carry the worker
 * id. A move off either end is a no-op that still reports the current order, and
 * every move normalizes the project's positions to a dense `0..n-1` — see
 * `moveEnrollmentInProjectOrder` (`src/db/repositories/workerEnrollmentsRepository.ts`).
 *
 * It changes *preference only*. Nothing here approves an enrollment, grants
 * consent, or routes work: the dispatch gate still judges eligibility for every
 * candidate, and a reorder takes effect on the **next** dispatch — it never touches
 * a phase already running.
 */
export async function moveProjectWorkerOrder(
	input: MoveProjectWorkerOrderInput,
): Promise<string[] | undefined> {
	return moveEnrollmentInProjectOrder(input.projectId, input.workerId, input.direction);
}

/**
 * Set (or revoke) the owner-controlled sharing consent. Revoking (`false`)
 * flips `isRoutable` false without touching the worker, its session, or any
 * running process. Returns the updated enrollment, or `undefined` if no
 * enrollment has that id.
 */
export async function setSharingConsent(
	id: string,
	sharingConsent: boolean,
): Promise<WorkerEnrollment | undefined> {
	return setEnrollmentSharingConsent(id, sharingConsent);
}

/** The mutable execution constraints; each field is optional so a caller updates only what changed. */
export interface UpdateEnrollmentConstraintsInput {
	/** The resolved worker — needed to re-validate an `allowedClis` change against its capabilities. */
	worker: Worker;
	enrollmentId: string;
	allowedClis?: AgentCli[];
	/**
	 * The phases this project may route here (issue #509) — non-empty when given;
	 * omit to leave the stored set alone. There is no "allow nothing" value: a
	 * worker that should take no work here is a `suspended` enrollment or revoked
	 * sharing consent.
	 */
	allowedPhases?: TriggerPhase[];
	/** A positive integer sets the allocation; omit to leave the stored value alone. */
	concurrencyAllocation?: number;
}

/**
 * Update an enrollment's execution constraints. When `allowedClis` is given it
 * is re-validated (non-empty, de-duplicated) and re-checked against the worker's
 * capabilities; `allowedPhases`, when given, is re-validated (non-empty,
 * de-duplicated) but deliberately **not** checked against the worker's declared
 * `supportedPhases` (see `EnrollmentAllowedPhasesSchema` — a daemon narrows that
 * set freely, so containment is not an invariant and eligibility ANDs the two);
 * `concurrencyAllocation`, when given, must be a positive integer. There is no
 * "clear it" value for any of them — an enrollment always states its share of the
 * project (issue #480) and always permits at least one CLI and one phase, so
 * omitting a field leaves the stored one alone. Returns the updated enrollment, or
 * `undefined` if no enrollment has that id.
 *
 * A phase change takes effect on the **next** dispatch: the gate re-reads the
 * enrollment before every phase starts and never touches a run already in flight,
 * exactly as revoking sharing consent behaves.
 */
export async function updateEnrollmentConstraints(
	input: UpdateEnrollmentConstraintsInput,
): Promise<WorkerEnrollment | undefined> {
	const patch: {
		allowedClis?: AgentCli[];
		allowedPhases?: TriggerPhase[];
		concurrencyAllocation?: number;
	} = {};
	if (input.allowedClis !== undefined) {
		const allowedClis = EnrollmentAllowedClisSchema.parse(input.allowedClis);
		assertClisWithinCapabilities(input.worker, allowedClis);
		patch.allowedClis = allowedClis;
	}
	if (input.allowedPhases !== undefined) {
		patch.allowedPhases = EnrollmentAllowedPhasesSchema.parse(input.allowedPhases);
	}
	if (input.concurrencyAllocation !== undefined) {
		patch.concurrencyAllocation = ConcurrencyAllocationSchema.parse(input.concurrencyAllocation);
	}
	return updateEnrollmentConstraintsRow(input.enrollmentId, patch);
}
