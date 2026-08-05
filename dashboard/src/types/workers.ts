/**
 * Mirrors the server worker read models (`src/identity/worker-enrollment-service.ts`).
 * The web package doesn't import server modules, so this re-declares the shapes
 * here the same way `RunRow` (`./runs.ts`) hand-mirrors the runs row — keep them
 * in step with the service's `DashboardWorkerView`, `WorkerRosterEntry`, and
 * `OwnerWorkerView`.
 *
 * Everything here is secret-free by construction on the server: no machine path,
 * credential, token, or credential hash crosses the wire. The Workers *table*
 * exposes one operable field, the owner-controlled `sharingConsent` toggle
 * (#282); the per-worker detail view (#477) adds the enrollment's execution
 * constraints (owner) and its approval/suspension (project administrator), each
 * offered only where the server-declared capability flag says the viewer may
 * change it. Self-declared facts — `capabilities` and `supportedPhases`, which a
 * daemon states at handshake — stay read-only everywhere.
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
 * One enrollment on the worker detail view (`workers.getById`, issue #477,
 * mirroring the service `DashboardWorkerEnrollmentDetail` plus the router's
 * viewer-capability flag). These facts are what answer "why is this machine not
 * taking work here?" — approval state, the effective CLIs, the effective pipeline
 * phases, this worker's share of the project, the owner's consent, and the derived
 * routing verdict. Secret-free.
 */
export interface WorkerDetailEnrollment {
	enrollmentId: string;
	projectId: string;
	status: WorkerEnrollmentStatus;
	/** Effective CLIs this project may run on the worker — a subset of its capabilities. */
	allowedClis: string[];
	/**
	 * Pipeline phases this project may route to the worker (issue #509) — the
	 * owner's per-enrollment choice, read *with* the machine's declared
	 * `supportedPhases` rather than instead of it: a phase runs here only when both
	 * name it, and only while the project has that phase enabled.
	 */
	allowedPhases: string[];
	/** This worker's share of the project — a positive integer, never absent (issue #480). */
	concurrencyAllocation: number;
	sharingConsent: boolean;
	/** Server-derived: `active` **and** consented. The only field the dispatch gate reads. */
	isRoutable: boolean;
	/**
	 * Whether the viewer administers this enrollment's project, so approval and
	 * suspend/reactivate may be offered. Declared by the server — the same check
	 * `workers.approveEnrollment`/`setStatus` re-run — never inferred client-side.
	 */
	viewerCanAdminister: boolean;
}

/**
 * One worker in full (`workers.getById`, issue #477): the roster row's identity,
 * connectivity, declared capabilities and active job, plus one enrollment block
 * per project the viewer may see. Secret-free like every other worker read model
 * — no machine path, worker credential, credential hash, or project PAT.
 */
export interface WorkerDetail extends Omit<WorkerRow, 'enrollments'> {
	/** The owner's user id — the non-secret identity, never a credential. */
	ownerUserId: string;
	/**
	 * Whether the viewer may change the owner-controlled values (sharing consent
	 * and execution constraints). Declared by the server, which re-checks
	 * ownership on every such mutation; `true` for the owner and for an
	 * installation administrator, exactly as the mutations resolve it.
	 */
	viewerIsOwner: boolean;
	enrollments: WorkerDetailEnrollment[];
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
	/** Effective pipeline phases this project may route to the worker (issue #509). */
	allowedPhases: string[];
	/** This worker's share of the project — a positive integer, never absent (issue #480). */
	concurrencyAllocation: number;
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
	/** Effective pipeline phases this project may route to the worker (issue #509). */
	allowedPhases: string[];
	/** This worker's share of the project — a positive integer, never absent (issue #480). */
	concurrencyAllocation: number;
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
