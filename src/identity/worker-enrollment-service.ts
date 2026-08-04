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
 * `setEnrollmentStatus`) and the two provider-neutral read models:
 *
 * - `listProjectRoster(projectId)` — every worker enrolled in a project, with
 *   display name, owner, capabilities, status, allowed CLIs, concurrency,
 *   sharing consent, the derived {@link isRoutable} verdict, and derived
 *   busy/current-run state.
 * - `listOwnerWorkers(ownerUserId)` — an owner's self-service view of their own
 *   workers and each worker's enrollments across projects.
 * - `listDashboardWorkers(projectScope)` — the cross-project connectivity roster
 *   the dashboard's Workers screen renders (#133), scoped to what the viewer may
 *   see.
 * - `getDashboardWorkerDetail(workerId, projectScope)` — that same row for **one**
 *   worker (#477), widened with the full enrollment detail per visible project,
 *   for the Workers screen's per-worker detail view.
 * - `listProjectDispatchCandidates(projectId)` — the same project scope in the
 *   shape the #130 dispatch gate judges (`src/worker/eligibility-gate.ts`):
 *   worker + enrollment + resolved availability, in the deterministic
 *   enrollment-creation order the scheduler selects by.
 *
 * **No secrets** leave this surface. The assembled views are built by explicitly
 * naming the safe fields (never spreading a row), so a repo path, PAT, local
 * CLI token, or credential hash can never ride along — the `Worker` read model
 * already omits the credential hash, and this layer never reaches for project
 * config, credentials, or worktree paths.
 *
 * **Busy/current-run is derived from run lifecycle, never client-supplied**:
 * `deriveWorkerRunState` reads the worker's *live* Phase-2 session
 * (`getLiveSessionForWorker`) and, only when that session points at a run that
 * is actually `running` in the `runs` table, reports the worker busy. A stale
 * `current_run_id` left over from a completed/failed run reads as idle.
 */

import {
	getActiveWorkerClaims,
	getWorkerDispatchClaimState,
} from '../db/repositories/dispatchesRepository.js';
import { getRunByIdFromDb } from '../db/repositories/runsRepository.js';
import { getUserById } from '../db/repositories/usersRepository.js';
import {
	createEnrollment,
	getEnrollmentById,
	listEnrollmentsForProject,
	listEnrollmentsForWorker,
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
import type { TriggerPhase } from '../triggers/types.js';
import type { Worker } from './worker.js';
import type { WorkerAvailability } from './worker-eligibility.js';
import {
	AllowedClisNotCapableError,
	ConcurrencyAllocationSchema,
	DEFAULT_CONCURRENCY_ALLOCATION,
	EnrollmentAllowedClisSchema,
	type EnrollmentStatus,
	isRoutable,
	type WorkerEnrollment,
} from './worker-enrollment.js';
import { getLiveSessionForWorker, getRetainedSessionForWorker } from './worker-session-service.js';

export {
	AllowedClisNotCapableError,
	ConcurrencyAllocationSchema,
	DEFAULT_CONCURRENCY_ALLOCATION,
	ENROLLMENT_STATUSES,
	EnrollmentAllowedClisSchema,
	type EnrollmentStatus,
	EnrollmentStatusSchema,
	isRoutable,
	type WorkerEnrollment,
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
 * Read a worker's live-session state once: whether it holds a live lease
 * (connection/health) and, when that session points at a run, whether that run
 * is *actually* `running` in `runs`. Both derived read models below need the
 * same two facts, so they share one pass rather than each re-reading the
 * session.
 */
async function readWorkerExecutionState(
	workerId: string,
	projectId?: string,
): Promise<{ connected: boolean; activeRuns: number; runningRunId: string | null }> {
	const session = await getLiveSessionForWorker(workerId);
	if (!session) return { connected: false, activeRuns: 0, runningRunId: null };
	const claims = await getWorkerDispatchClaimState(workerId, projectId);
	if (claims.activeRuns > 0) {
		return {
			connected: true,
			activeRuns: claims.activeRuns,
			runningRunId: claims.currentRunId,
		};
	}
	if (!session.currentRunId) return { connected: true, activeRuns: 0, runningRunId: null };
	const run = await getRunByIdFromDb(session.currentRunId);
	const runningRunId = run?.status === 'running' ? run.id : null;
	return { connected: true, activeRuns: runningRunId ? 1 : 0, runningRunId };
}

/**
 * Derive a worker's busy/current-run state from the run lifecycle. Reads the
 * worker's *live* Phase-2 session; a worker with no live session (never
 * acquired, expired, or released) is idle. When the live session points at a
 * `current_run_id`, the run is looked up in `runs` and the worker is `busy`
 * **only if** that run's status is `running` — a stale pointer to a
 * completed/failed run reads as idle. The status is read from `runs`, never
 * trusted from a caller.
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
 * order**: enrollment creation time, then enrollment id as the tie-break
 * (`listEnrollmentsForProject`). That order is the documented "first free
 * eligible worker" sequence — stable across dispatches, so two re-checks of the
 * same roster select the same worker.
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

/** One enrollment as the dashboard roster shows it — project + approval state, nothing operable. */
export interface DashboardEnrollmentView {
	projectId: string;
	status: EnrollmentStatus;
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
	/** The run's project — the Workers screen resolves its repo for the PR link from this. */
	projectId: string;
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
	 * #467) — the second capability axis, independent of the CLIs above: a DB-free
	 * remote daemon has every CLI and still refuses `planning`
	 * (`SUPPORTED_DB_FREE_PHASES`, `../transport/assignment-execution.ts`). The
	 * Workers screen reads it to say so, rather than leaving an operator to infer
	 * it from work that never starts.
	 */
	supportedPhases: TriggerPhase[];
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
 * approval `status`, the effective `allowedClis`, the `concurrencyAllocation`,
 * the owner's `sharingConsent`, and the derived {@link isRoutable} verdict.
 */
export interface DashboardWorkerEnrollmentDetail {
	enrollmentId: string;
	projectId: string;
	status: EnrollmentStatus;
	allowedClis: AgentCli[];
	/** This worker's share of the project — a positive integer (see `ConcurrencyAllocationSchema`). */
	concurrencyAllocation: number;
	sharingConsent: boolean;
	isRoutable: boolean;
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
 * it — the same visibility rule {@link listDashboardWorkers} applies, so this
 * adds no second answer to "which machines may I see": an administrator
 * (`projectScope === null`) sees any registered worker including an un-enrolled
 * one, and any other viewer only a worker enrolled in a project they may access,
 * with the inaccessible enrollments stripped from the view. `null` is
 * indistinguishable from "no such worker" on purpose — the caller turns both into
 * one `NOT_FOUND` so worker existence never leaks.
 *
 * Where the roster row carries only `(projectId, status)` per enrollment, this
 * carries the full per-project enrollment detail, so the detail screen can
 * explain routability without a roster query per project.
 */
export async function getDashboardWorkerDetail(
	workerId: string,
	projectScope: DashboardProjectScope,
): Promise<DashboardWorkerDetailView | null> {
	if (projectScope !== null && projectScope.length === 0) return null;
	const worker = await getWorkerById(workerId);
	if (!worker) return null;
	const accessible = projectScope === null ? null : new Set(projectScope);
	const enrollments = await listEnrollmentsForWorker(worker.id);
	const visible = accessible
		? enrollments.filter((enrollment) => accessible.has(enrollment.projectId))
		: enrollments;
	if (accessible && visible.length === 0) return null;
	// Spreading the *assembled view* (not a row) keeps the one place that names
	// the safe worker fields — `assembleDashboardWorker` — as the only assembler.
	const row = await assembleDashboardWorker(worker, visible, accessible);
	return {
		...row,
		ownerUserId: worker.ownerUserId,
		enrollments: visible.map(assembleEnrollmentDetail),
	};
}

/** Assemble one detail-view enrollment by naming each safe field explicitly. */
function assembleEnrollmentDetail(enrollment: WorkerEnrollment): DashboardWorkerEnrollmentDetail {
	return {
		enrollmentId: enrollment.id,
		projectId: enrollment.projectId,
		status: enrollment.status,
		allowedClis: enrollment.allowedClis,
		concurrencyAllocation: enrollment.concurrencyAllocation,
		sharingConsent: enrollment.sharingConsent,
		isRoutable: isRoutable(enrollment),
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
		connection: liveSession ? 'online' : 'offline',
		lastSeenAt: lastSeenSession?.lastHeartbeatAt ?? null,
		currentRun: await resolveVisibleRun(worker.id, liveSession?.currentRunId ?? null, accessible),
		enrollments: enrollments.map((enrollment) => ({
			projectId: enrollment.projectId,
			status: enrollment.status,
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
 * capabilities** — throwing {@link AllowedClisNotCapableError} otherwise — then
 * persists a `pending` enrollment (unless a status is given) with sharing
 * consent off by default and, unless the caller names one, a concurrency
 * allocation of {@link DEFAULT_CONCURRENCY_ALLOCATION}. A duplicate
 * `(worker, project)` surfaces the repository's pg `23505` for the caller to
 * translate.
 */
export async function enrollWorker(input: EnrollWorkerInput): Promise<WorkerEnrollment> {
	const allowedClis = EnrollmentAllowedClisSchema.parse(input.allowedClis);
	assertClisWithinCapabilities(input.worker, allowedClis);
	const concurrencyAllocation = ConcurrencyAllocationSchema.parse(
		input.concurrencyAllocation ?? DEFAULT_CONCURRENCY_ALLOCATION,
	);
	return createEnrollment({
		workerId: input.worker.id,
		projectId: input.projectId,
		status: input.status ?? 'pending',
		allowedClis,
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
	/** A positive integer sets the allocation; omit to leave the stored value alone. */
	concurrencyAllocation?: number;
}

/**
 * Update an enrollment's execution constraints. When `allowedClis` is given it
 * is re-validated (non-empty, de-duplicated) and re-checked against the worker's
 * capabilities; `concurrencyAllocation`, when given, must be a positive integer.
 * There is no "clear it" value — an enrollment always states its share of the
 * project (issue #480), so omitting the field leaves the stored one alone.
 * Returns the updated enrollment, or `undefined` if no enrollment has that id.
 */
export async function updateEnrollmentConstraints(
	input: UpdateEnrollmentConstraintsInput,
): Promise<WorkerEnrollment | undefined> {
	const patch: { allowedClis?: AgentCli[]; concurrencyAllocation?: number } = {};
	if (input.allowedClis !== undefined) {
		const allowedClis = EnrollmentAllowedClisSchema.parse(input.allowedClis);
		assertClisWithinCapabilities(input.worker, allowedClis);
		patch.allowedClis = allowedClis;
	}
	if (input.concurrencyAllocation !== undefined) {
		patch.concurrencyAllocation = ConcurrencyAllocationSchema.parse(input.concurrencyAllocation);
	}
	return updateEnrollmentConstraintsRow(input.enrollmentId, patch);
}
