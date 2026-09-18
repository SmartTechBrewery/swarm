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
 * The self-update an operator asked this machine for, and what came of it —
 * mirroring the server `WorkerUpdateState` (`src/identity/worker.ts`, issue #933)
 * as the wire serializes it (`serializeWorkerUpdate`): ISO instants, everything
 * else verbatim. `null` for a machine nobody has ever asked.
 *
 * **`requestId` is the pending marker** — non-null means the machine still owes an
 * answer — and it is the only field the build marks read (issue #978). `target`
 * goes on naming the build the *latest* request concerned long after that request
 * was answered, so presence of a value here says nothing about whether one is in
 * flight; the durable per-request record is the `runs` row, read on the runs
 * surfaces.
 */
export interface WorkerUpdate {
	requestId: string | null;
	target: string;
	requestedAt: string;
	requestedByUserId: string | null;
	status: string | null;
	message: string | null;
	reportedAt: string | null;
}

/**
 * One live CLI cool-down on a machine (issue #988, mirroring the server
 * `WorkerCliRateLimit` as `workers.getById`/`list` serialize it): the machine's own
 * CLI reported its usage allowance spent on a real run, and the record releases
 * itself at `expiresAt`.
 *
 * **Observed, not declared** — the opposite end of `drainingSince`, which an
 * operator sets and only an operator clears. Nothing here is an action item: there
 * is no way to clear a cool-down and nothing to fix, which is what the copy
 * rendering it must convey. Secret-free: a CLI name, two instants, and the CLI's
 * own words.
 */
export interface WorkerRateLimit {
	/** The agent CLI whose allowance is spent — `claude` | `antigravity` | `codex`. */
	cli: string;
	/** ISO 8601 — when the allowance is expected back; the record lapses by itself here. */
	expiresAt: string;
	/** ISO 8601 — when the deferral that recorded this was observed. */
	observedAt: string;
	/**
	 * The CLI's verbatim reset text, when it gave one — shown as the machine's own
	 * words beside the derived expiry, never parsed back into one.
	 */
	resetHint: string | null;
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
	 * The version that machine's SWARM install root declares (`package.json`), or
	 * `null` while it has declared none.
	 *
	 * A **label beside** `build`, not a replacement for it: `buildIsCurrent` below is
	 * still decided on the commit, because a version only moves when an operator bumps
	 * it and every machine reports the same one between releases. Read as a plain
	 * string and never parsed — this bundle compares no versions.
	 */
	version: string | null;
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
	/**
	 * How the machine's daemon declared it is supervised (issue #997): whether
	 * launchd or systemd starts it again after it exits, or nobody does.
	 *
	 * **Three-valued, and `'unknown'` must render as *unknown*, never as either
	 * answer.** It is what a machine that never connected says, what a daemon on a
	 * build that predates the field says, and what a daemon on a platform these reads
	 * cannot answer for says — so collapsing it onto `'supervised'` would tell an
	 * operator a machine comes back when nothing established that, and onto
	 * `'unsupervised'` would mark a whole fleet as not coming back.
	 *
	 * Not a path and not a secret: one enum member naming a kind of process
	 * supervision, with no supervisor job label beside it.
	 */
	supervision: 'supervised' | 'unsupervised' | 'unknown';
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
	/**
	 * The machine's live CLI cool-downs (issue #988) — one entry per CLI waiting on a
	 * usage limit, `[]` when none is. Read *alongside* `drainingSince`: together they
	 * are the two answers to "why is this machine not taking work?", one the
	 * operator's own state and one the machine's own observation. A machine cooling on
	 * one CLI keeps taking work on the others, so the per-entry list is the only
	 * honest shape — never collapse it to a boolean.
	 *
	 * The detail view renders these ({@link WorkerRateLimit}); the roster carries them
	 * because the read is shared with `swarm workers list` and does not render them.
	 */
	rateLimits: WorkerRateLimit[];
	/**
	 * The update this machine was last asked for, and what came of it (issue #933),
	 * or `null` if nobody ever has. Read *alongside* `buildIsCurrent`, never in place
	 * of it: an outstanding request says somebody has acted, a differing build says
	 * nobody has yet, and while a machine waits both are true at once — which is why
	 * the Workers screen marks them separately (issue #978).
	 *
	 * The dashboard reads only the pending marker off it; what a machine *reported*
	 * is `swarm workers list`'s to tell, and the runs surfaces'.
	 */
	update: WorkerUpdate | null;
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

/**
 * One machine's line in an update report (`workers.requestUpdateForInstallation`,
 * issue #922; the project-scoped form reuses it) — what the control plane did about
 * that machine, and enough to say which machine and whose.
 *
 * **`disposition` is a plain `string`, deliberately.** The server's own vocabulary is
 * the seven words `WORKER_UPDATE_FANOUT_DISPOSITIONS` names (`requested`,
 * `queued-offline`, `in-pool`, `no-project`, `unsupervised`, `already-asked`,
 * `answered`), but a newer control plane may report an eighth, and a browser bundle
 * this one was built before that happened must still list the machine rather than
 * drop it. `src/cli/commands/workers.ts` reads it with exactly the same tolerance and
 * for the same reason; `@/lib/worker-update-dispositions.js` is where the words this
 * build does know are turned into copy.
 */
export interface WorkerUpdateReportEntry {
	workerId: string;
	displayName: string;
	disposition: string;
	/** `null` for an owner the server's users read could not resolve — print "unknown", never nobody. */
	owner: WorkerOwner | null;
	/** The machine's update state *after* the request; `null` for one nobody has ever asked. */
	update: WorkerUpdate | null;
}

/**
 * The answer to one update request over a set of machines — the build asked for, who
 * asked, and one entry per machine. It is the answer to a single request rather than
 * a live view, so nothing polls it.
 */
export interface WorkerUpdateReport {
	target: string;
	requestedBy: string;
	workers: WorkerUpdateReportEntry[];
}

/**
 * One machine's line in a staged fleet update (`workers.fleetUpdateStatusForInstallation`
 * / `workers.startFleetUpdateForInstallation`, issues #940 and #1024) as the wire
 * serializes it (`serializeRolloutMember`): the member row, the machine's label, its
 * owner, and the two instants as ISO strings.
 *
 * **`state` and `outcome` are plain `string`s, for {@link WorkerUpdateReportEntry}'s
 * reason.** The server's own vocabularies are the seven member states
 * `WORKER_UPDATE_ROLLOUT_MEMBER_STATES` names and the update statuses beside them,
 * but a newer control plane may report a word this bundle was built before, and a
 * machine dropped from the readout reads as a machine the rollout never named — the
 * one wrong answer here. `@/lib/worker-rollout-states.js` turns the words this build
 * does know into copy and describes the rest.
 */
export interface WorkerRolloutMember {
	workerId: string;
	displayName: string;
	/** `null` for an owner the server's users read could not resolve — say so, never nobody. */
	owner: WorkerOwner | null;
	/**
	 * The order the rollout reaches the machines in, which is what the readout sorts
	 * on — explicitly, rather than trusting the order the array happened to arrive in.
	 */
	position: number;
	state: string;
	/** What the machine reported, in the server's own word; `null` until it has. */
	outcome: string | null;
	/** The machine's own words, verbatim; `null` when it gave none. */
	message: string | null;
	/** ISO 8601 — when the machine was asked to move; `null` until its wave came up. */
	signalledAt: string | null;
	/** ISO 8601 — when the rollout finished with it; `null` while it is still unsettled. */
	settledAt: string | null;
}

/**
 * A staged fleet update as the rollout procedures answer it (`serializeRollout`).
 * `null` from those procedures when none has ever run, which is an honest empty
 * answer rather than an error.
 *
 * `status` is a plain `string` for the same reason a member's `state` is.
 * `haltReason` is the operator-facing sentence recorded when the rollout stopped
 * itself on a bad build, and is `null` at every other status.
 */
export interface WorkerRollout {
	id: string;
	target: string;
	/** How many machines one wave may take out of the dispatch pool at once. */
	waveSize: number;
	status: string;
	haltReason: string | null;
	createdAt: string;
	updatedAt: string;
	members: WorkerRolloutMember[];
}
