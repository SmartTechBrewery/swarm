/**
 * Mirrors the server worker read models (`src/identity/worker-enrollment-service.ts`).
 * The web package doesn't import server modules, so this re-declares the shapes
 * here the same way `RunRow` (`./runs.ts`) hand-mirrors the runs row — keep them
 * in step with the service's `DashboardWorkerView`, `WorkerRosterEntry`, and
 * `OwnerWorkerView`.
 *
 * Everything here is secret-free by construction on the server: no machine path,
 * credential, token, or credential hash crosses the wire. The one operable field
 * the Workers screen exposes is the owner-controlled `sharingConsent` toggle
 * (#282) — wired to `workers.setConsent`, which enforces ownership server-side;
 * everything else (approval, routing, machine lifecycle) stays read-only.
 */

/** Whether the worker's lease is live under the heartbeat TTL right now. */
export type WorkerConnectionState = 'online' | 'offline';

/** The enrollment/approval state of a worker in one project the viewer may see. */
export type WorkerEnrollmentStatus = 'pending' | 'active' | 'suspended';

export interface WorkerEnrollmentSummary {
	projectId: string;
	status: WorkerEnrollmentStatus;
}

/** The owner shown beside a worker — a non-secret identity, never a credential. */
export interface WorkerOwner {
	userId: string;
	identifier: string;
	displayName: string;
}

/**
 * The job a worker is executing right now (mirrors the service
 * `DashboardWorkerRun`, issue #473) — the same work-item fields the Runs table's
 * Task cell renders, so the Workers screen's **Active job** column describes a run
 * the way `/runs` does instead of printing its UUID.
 */
export interface WorkerActiveRun {
	runId: string;
	/** The run's project — the row resolves its repo from this for the PR link. */
	projectId: string;
	taskId: string;
	phase: string;
	workItemId: string | null;
	workItemTitle: string | null;
	workItemUrl: string | null;
	prNumber: string | null;
	prTitle: string | null;
}

export interface WorkerRow {
	workerId: string;
	displayName: string;
	owner: WorkerOwner | null;
	/** Declared agent CLIs (`claude` | `antigravity` | `codex`). */
	capabilities: string[];
	/**
	 * Pipeline phases the machine's daemon declared it can execute (issue #467) —
	 * the capability axis independent of the CLIs above: a DB-free remote daemon
	 * has every CLI and still refuses `planning`. The Capabilities column leads
	 * with a `PLANNING` badge when this includes it.
	 */
	supportedPhases: string[];
	connection: WorkerConnectionState;
	/** ISO 8601 — when the worker was last heard from; null if it never connected. */
	lastSeenAt: string | null;
	/** The job it is executing right now; null when idle or the run is out of scope. */
	currentRun: WorkerActiveRun | null;
	/** Only enrollments in projects the viewer may access; empty for an un-enrolled machine. */
	enrollments: WorkerEnrollmentSummary[];
}

/**
 * Derived busy/current-run state for a worker (server-derived from run
 * lifecycle, never client-supplied). Mirrors the service `WorkerRunState`.
 */
export interface WorkerRunState {
	busy: boolean;
	currentRunId: string | null;
}

/**
 * One entry of a project's worker roster (`workers.roster`, mirroring the
 * service `WorkerRosterEntry`). Read by any project `contributor`, so a project
 * administrator can see why an enrolled worker is unavailable (`sharingConsent`
 * off → not `isRoutable`) without any private machine detail. Secret-free.
 */
export interface WorkerRosterEntry {
	enrollmentId: string;
	workerId: string;
	projectId: string;
	displayName: string;
	owner: WorkerOwner | null;
	capabilities: string[];
	status: WorkerEnrollmentStatus;
	/** Effective CLIs this project may run on the worker — a subset of its capabilities. */
	allowedClis: string[];
	/** Optional per-worker sub-limit for this project; `null` = none (bounded by worker + project caps). */
	concurrencyAllocation: number | null;
	sharingConsent: boolean;
	/** Server-derived: `active` **and** consented. The only field the dispatch gate reads. */
	isRoutable: boolean;
	runState: WorkerRunState;
}

/** One enrollment in the caller's own-worker view (`workers.listMine`). Secret-free. */
export interface OwnerEnrollment {
	enrollmentId: string;
	projectId: string;
	status: WorkerEnrollmentStatus;
	allowedClis: string[];
	/** Optional per-worker sub-limit for this project; `null` = none (bounded by worker + project caps). */
	concurrencyAllocation: number | null;
	sharingConsent: boolean;
	isRoutable: boolean;
}

/**
 * One worker the signed-in operator owns, with its enrollments across projects
 * (`workers.listMine`, mirroring the service `OwnerWorkerView`). Presence of an
 * enrollment here — not a client-supplied owner claim — is what authorizes the
 * dashboard to render a sharing-consent control for it. Secret-free.
 */
export interface OwnerWorker {
	workerId: string;
	displayName: string;
	capabilities: string[];
	runState: WorkerRunState;
	enrollments: OwnerEnrollment[];
}
