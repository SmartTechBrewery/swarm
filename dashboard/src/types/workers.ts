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
 * change it. Facts a daemon states at handshake stay read-only everywhere —
 * `supportedPhases`, the checkout `repository`, and the SWARM `build` (issue #925)
 * — but the CLI axis is no longer
 * one of them: since issue #787 the worker's *owner* may declare which of the CLIs
 * their machine reported it should run (`declaredCapabilities` on
 * {@link WorkerDetail}, written by `workers.setDeclaredCapabilities`), and
 * `capabilities` is the effective set that declaration resolves to.
 */

/** Whether the worker's lease is live under the heartbeat TTL right now. */
export type WorkerConnectionState = 'online' | 'offline';

/** The enrollment/approval state of a worker in one project the viewer may see. */
export type WorkerEnrollmentStatus = 'pending' | 'active' | 'suspended';

export interface WorkerEnrollmentSummary {
	projectId: string;
	status: WorkerEnrollmentStatus;
	/** Effective CLIs this project may run on the worker — a subset of its capabilities. */
	allowedClis: string[];
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
	/** The run's project, so the Active job line can name it. */
	projectId: string;
	/** The repository the run acted on (`owner/repo`) — where its PR link comes from (issue #691). */
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
 * One row of a machine's update history (`workers.getById`, issue #977, mirroring
 * the service's `WorkerUpdateRunRow`) — one `runs` row of `kind = 'worker-update'`,
 * which is what an update request has been recorded as since issue #971.
 *
 * Secret-free like everything else here: a build ref, a run status, two instants,
 * and the machine's own operator-facing prose about a failure.
 */
export interface WorkerUpdateHistoryEntry {
	/** The run this request was recorded as — the `/runs/<runId>` each entry links to. */
	runId: string;
	/** The run's project. An entry outside the viewer's scope is withheld server-side. */
	projectId: string;
	/** The build the machine was asked to move to; `null` only for a row that names none. */
	target: string | null;
	/**
	 * The run's own lifecycle status, verbatim — `running`, `completed` or `failed`
	 * for a worker-update run — so the outcome reads identically here and in `/runs`.
	 */
	status: string;
	/** ISO 8601 — when the machine was asked (a worker-update run starts at the request). */
	startedAt: string;
	/** ISO 8601 — when the run settled; `null` while it is still running. */
	completedAt: string | null;
	durationMs: number | null;
	/** The machine's own reason, for a `failed` entry; `null` for one that completed. */
	error: string | null;
}

export interface WorkerRow {
	workerId: string;
	displayName: string;
	owner: WorkerOwner | null;
	/**
	 * The agent CLIs this machine is routable on (`claude` | `antigravity` |
	 * `codex`) — the **effective** set since issue #783: the owner's declaration
	 * intersected with the daemon's own probe, or just the probe when nothing has
	 * been declared. The detail view is the one surface that also carries the two
	 * halves separately ({@link WorkerDetail}).
	 */
	capabilities: string[];
	/**
	 * Pipeline phases the machine's daemon declared it can execute (issue #467) —
	 * the capability axis independent of the CLIs above: a DB-free remote daemon
	 * has every CLI and still refuses `planning`. The Capabilities column leads
	 * with a `PLANNING` badge when this includes it.
	 */
	supportedPhases: string[];
	/**
	 * Which repository the machine's one local checkout is (issue #687), normalised
	 * `owner/repo`, or `null` when it declared none — a machine that never connected,
	 * a daemon on a build that predates the field, or a checkout with no readable
	 * `origin`. Not a path: `SWARM_WORKER_REPO_ROOT` stays on the machine.
	 *
	 * Read against an enrollment's own `projectRepos` to explain a refused or
	 * suspended enrollment (issue #690).
	 */
	repository: string | null;
	/**
	 * The SWARM build the machine's daemon declared (issue #925): the commit its
	 * install root is on, plus a flag for a checkout that is dirty or whose `dist/`
	 * build predates it. `null` when it declared none — a machine that never
	 * connected, a daemon on a build that predates the field, or an install root
	 * that is not a git checkout. Not a path and not a secret: a commit id is public
	 * coordinates.
	 *
	 * Not the same thing as `repository` above: one npm-linked SWARM checkout can
	 * serve daemons working in several different project repositories.
	 */
	build: { commit: string; dirty: boolean } | null;
	/**
	 * Server-derived: whether the `build` above is the control plane's own. `false`
	 * is what the `OUTDATED` mark renders for.
	 *
	 * **Three-valued, and `null` must render nothing.** It means the question has no
	 * answer — the machine declared no build, or the server cannot resolve its own —
	 * so treating `null` as a mismatch would mark an entire fleet outdated the moment
	 * the comparand went missing. Test `=== false`, never falsiness.
	 */
	buildIsCurrent: boolean | null;
	connection: WorkerConnectionState;
	/** ISO 8601 — when the worker was last heard from; null if it never connected. */
	lastSeenAt: string | null;
	/**
	 * ISO 8601 — when the machine's operator took it **out of the dispatch pool**
	 * (issue #919), and `null` while it is in the pool. Read *alongside*
	 * `connection`, never in place of it: draining is a deliberate operator state,
	 * not an outage, so a drained machine that is online is still online — it is
	 * merely given no new work while whatever it is already running finishes.
	 *
	 * Sticky across the machine's own restart: a reconnecting daemon does not rejoin
	 * the pool, so only an operator clears this (`workers.setDraining`).
	 */
	drainingSince: string | null;
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
	 * **Every** repository this enrollment's project declares (issue #690, widened
	 * by #946), in the **same normalised form** as the worker's own `repository`, so
	 * membership in this list by plain equality is the comparison the server makes
	 * (`repoSlugsMatch`, `src/scm/repo-slug.ts` — not imported here, since its slug
	 * reader spawns `git`). A list because a project may hold one worker per
	 * repository: a machine on the project's second repository is correctly
	 * enrolled. `[]` only when the project no longer resolves.
	 */
	projectRepos: string[];
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
	 * Whether the viewer may change the owner-controlled values (display name,
	 * sharing consent, and execution constraints). Declared by the server, which
	 * re-checks ownership on every such mutation; `true` only for the worker's
	 * actual owner — an installation administrator gets no override here, exactly
	 * as `rename`/`setConsent`/`updateConstraints` resolve it.
	 */
	viewerIsOwner: boolean;
	/**
	 * The owner's **durable CLI declaration** (issue #783), or `null` when none has
	 * been made and the machine's own probe stands alone. Distinct from
	 * `capabilities`, which stays the *effective* set (declaration ∩ probe) every
	 * other surface reads: a declared CLI the machine stopped reporting is already
	 * gone from that set, and this field is what lets the detail view say so.
	 * Written by `workers.setDeclaredCapabilities` (issue #787).
	 */
	declaredCapabilities: string[] | null;
	/**
	 * What the machine's daemon last reported finding on its own PATH — the raw
	 * probe, rewritten at every handshake. The declaration control offers exactly
	 * these as options, since the server refuses a declaration naming anything else.
	 */
	probedCapabilities: string[];
	/**
	 * The build the **control plane** is running (issue #925) — the comparand the
	 * row's `buildIsCurrent` verdict was reached against, so the detail view can say
	 * "differs from *what*". `null` when the server cannot resolve its own, which is
	 * also when every `buildIsCurrent` is `null`.
	 *
	 * On the detail view alone: it is one value for the whole installation, so
	 * repeating it per roster row would say nothing the mark does not.
	 */
	controlPlaneBuild: { commit: string; dirty: boolean } | null;
	/**
	 * This machine's most recent update runs (issue #977), newest first and bounded
	 * server-side; `[]` for a machine nobody has ever asked to update. Read from
	 * `runs`, so it is the durable record of **every** request rather than the single
	 * latest outcome `swarm workers list` reports.
	 *
	 * On the detail view alone, because it is per-machine detail: a history on every
	 * roster row would be a read per row for a fact the index does not show.
	 */
	updateHistory: WorkerUpdateHistoryEntry[];
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
