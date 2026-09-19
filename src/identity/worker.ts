/**
 * The registered **worker** identity — the single source of truth for the shape
 * (ai/CODING_STANDARDS.md "Zod is the source of truth"). A worker is a *locally
 * operated execution environment* owned by a SWARM user (ADR-001 "User /
 * worker"): the machine on which that user runs agent CLIs. Where `SwarmUser`
 * (`./schema.ts`) models *who* a person is and `ProjectMembership`
 * (`./membership.ts`) models *what* they may do on a project, a worker models
 * *where* a user can execute — the third-layer identity of the multi-user
 * foundation.
 *
 * It is deliberately **provider-neutral**: a worker is **not** an SCM identity
 * and **not** an implementer/reviewer GitHub credential (those stay in
 * `project_credentials`, per persona per project). Its declared CLI capabilities
 * are the harness vocabulary (`AgentCliSchema`, `../harness/agent-cli.ts`), not a
 * parallel enum.
 *
 * A worker carries its own authentication material — the **worker credential**,
 * issued once at registration and distinct from any SCM PAT. That secret is
 * deliberately **absent from this read model**, exactly as `users.password_hash`
 * is dropped from `SwarmUser`: only a SHA-256 of the credential is persisted (on
 * `workers.credential_hash`), the raw credential is returned exactly once at
 * registration, and nothing here ever exposes either form (see
 * `./worker-service.ts`, mirroring `createSession`/`MintedSession` in
 * `./auth.ts`).
 *
 * Worker sessions, project enrollment, and the eligibility gate consume this
 * identity when selecting and claiming an execution host.
 */

import { z } from 'zod';
import { type AgentCli, AgentCliSchema } from '../harness/agent-cli.js';
import {
	WorkerBuildSchema,
	WorkerUpdateStatusSchema,
	WorkerUpdateTargetSchema,
} from '../lib/build-identity.js';
import { WorkerSupervisionSchema } from '../lib/worker-supervision.js';
import { RepoSlugSchema } from '../scm/repo-slug.js';
import { ALL_TRIGGER_PHASES, type TriggerPhase, TriggerPhaseSchema } from '../triggers/types.js';

/**
 * A worker's declared CLI capabilities: a de-duplicated, non-empty set of
 * `AgentCli` values. A worker that supports no CLI can execute nothing, so
 * registration requires at least one. Trusted as self-declaration for now
 * (ADR-001 "Worker capabilities and availability") — later phases verify it
 * against real execution, this slice does not. The transform de-dupes so a
 * caller passing `claude,claude` stores a single `claude`.
 */
export const WorkerCapabilitiesSchema = z
	.array(AgentCliSchema)
	.nonempty()
	.transform((clis) => [...new Set(clis)]);

/**
 * A worker's declared **phase** capabilities (issue #467): which pipeline phases
 * its daemon can actually execute. De-duplicated and non-empty on the same
 * reasoning as {@link WorkerCapabilitiesSchema} — a daemon that can run no phase
 * could never be dispatched to, so declaring an empty set is a bug, not a way to
 * pause a worker (revoking enrollment consent is).
 *
 * Also self-declared and trusted: the worker-side unsupported-phase gate
 * (`SUPPORTED_DB_FREE_PHASES`, `src/transport/assignment-execution.ts`) remains the
 * backstop if a declaration is ever wrong.
 */
export const WorkerSupportedPhasesSchema = z
	.array(TriggerPhaseSchema)
	.nonempty()
	.transform((phases) => [...new Set(phases)]);

/**
 * What a worker is taken to support when nothing has been declared — every phase,
 * which is how the dispatcher behaved before phases were declarable at all. Used
 * for a worker registered but never connected, and for a daemon whose handshake
 * omits `supportedPhases` (see `HandshakeRequestSchema`).
 */
export const DEFAULT_WORKER_SUPPORTED_PHASES: readonly TriggerPhase[] = ALL_TRIGGER_PHASES;

/**
 * A safe machine display name — human-facing, shown on rosters and owner
 * self-service. Trimmed and bounded (1–80 chars); a "safe display name" carries
 * no path/secret semantics, it is only a label.
 */
export const WorkerDisplayNameSchema = z.string().trim().min(1).max(80);

/**
 * The self-update an operator asked a machine for, and what came of it (issue
 * #933) — one value rather than six loose fields, so a consumer cannot read an
 * outcome without the target it concerns, the same reason `build` travels as a
 * pair.
 *
 * `requestId` is the pending marker: non-null means a push is still owed an answer,
 * `null` that the machine has reported (or that the request was superseded by a
 * later one). `target` is always the build the request named and the outcome
 * concerns; `status`/`message`/`reportedAt` are `null` until one is reported.
 *
 * `requestedByUserId` is the **audit** half (issue #922): the SWARM user whose word
 * this machine's code was replaced on. It used to be inferable — every request came
 * from the machine's own owner — and stopped being so when an installation
 * administrator gained a command that asks machines they do not own
 * (`workers.requestUpdateForInstallation`). It belongs to the request, so it is
 * rewritten by the next request and left alone by a report, exactly as `target` is.
 * `null` for a request made before the column existed, or one whose requester has
 * since been deleted.
 *
 * The whole value is `null` on `Worker.update` when nobody has ever asked this
 * machine to update — which, like `drainingSince`, is what every row says until an
 * operator acts.
 */
export const WorkerUpdateStateSchema = z.object({
	requestId: z.string().uuid().nullable(),
	target: WorkerUpdateTargetSchema,
	requestedAt: z.date(),
	requestedByUserId: z.string().uuid().nullable(),
	status: WorkerUpdateStatusSchema.nullable(),
	message: z.string().nullable(),
	reportedAt: z.date().nullable(),
});
export type WorkerUpdateState = z.infer<typeof WorkerUpdateStateSchema>;

/**
 * How many removals one report carries at most (issue #955). The true total
 * travels beside the list as `removedCount`, so the cap costs detail and never
 * the count — the wire refusing to be a log sink, exactly as the update report's
 * `message` bound does.
 */
export const WORKTREE_SWEEP_REMOVAL_CAP = 200;

/**
 * What became of a worktree sweep a machine was asked for (issue #955): `swept`
 * when every named project was swept, `failed` when at least one threw. A
 * project-level failure is *counted* rather than fatal — the rest are still swept
 * — so `failed` means "this report is incomplete", never "nothing happened".
 */
export const WorktreeSweepStatusSchema = z.enum(['swept', 'failed']);
export type WorktreeSweepStatus = z.infer<typeof WorktreeSweepStatusSchema>;

/**
 * One checkout a machine removed, and the work that removal destroyed — phase
 * 1's `AbandonedWorktreeRemoval` (`../worktree/abandoned.ts`) plus the
 * `projectId` it was swept under, since one report covers several projects.
 *
 * `hadUncommittedChanges` / `hadUnpushedCommits` are the whole reason the record
 * is durable rather than a log line on the machine: an age-based sweep removes a
 * checkout holding real work *by design*, and the operator has to be able to read
 * afterwards that it did.
 */
export const WorktreeSweepRemovalSchema = z.object({
	projectId: z.string().min(1),
	taskId: z.string().min(1),
	path: z.string().min(1),
	/** ISO-8601 — the newest "touched" signal the sweep found for this checkout. */
	lastTouchedAt: z.string().min(1),
	ageDays: z.number().nonnegative(),
	hadUncommittedChanges: z.boolean(),
	hadUnpushedCommits: z.boolean(),
});
export type WorktreeSweepRemoval = z.infer<typeof WorktreeSweepRemovalSchema>;

/**
 * The outcome of one sweep across every project a machine was asked about —
 * stored verbatim on the row (`workers.worktree_sweep_result`) and carried
 * verbatim on the wire ({@link ReportWorktreeSweepDeliveryRequestSchema},
 * `../transport/protocol.ts`), so the record an operator reads is the machine's
 * own answer rather than a re-derivation of it.
 *
 * `removedCount` is the true total and `removed` the capped detail, so a machine
 * that removed more than {@link WORKTREE_SWEEP_REMOVAL_CAP} checkouts still
 * reports how many. `keptLiveCount` is the count that age alone did not remove
 * because something still holds them, which is the number that says the liveness
 * gate is working rather than that nothing was old enough.
 */
export const WorktreeSweepResultSchema = z.object({
	removed: z.array(WorktreeSweepRemovalSchema).max(WORKTREE_SWEEP_REMOVAL_CAP),
	removedCount: z.number().int().nonnegative(),
	keptLiveCount: z.number().int().nonnegative(),
	failedCount: z.number().int().nonnegative(),
	message: z.string().min(1).max(4000),
});
export type WorktreeSweepResult = z.infer<typeof WorktreeSweepResultSchema>;

/**
 * The abandoned-worktree sweep an operator asked a machine for, and what came of
 * it (issue #955) — one value rather than five loose columns, on
 * {@link WorkerUpdateStateSchema}'s reasoning: a consumer must not be able to read
 * an outcome without the request it answers — and, since issue #956 made the
 * questions unattended and weekly, without the instant that outcome was reported
 * at, which is what says whether it answers the request now outstanding.
 *
 * `requestId` is the pending marker: non-null means a push is still owed an
 * answer, `null` that the machine has reported (or that a later request
 * superseded this one). `status`/`reportedAt`/`result` are `null` until one is
 * reported.
 *
 * **The outcome answers `requestedAt` only when `reportedAt` is at or after it**
 * (issue #956). Asking again replaces `requestId`/`requestedAt` and leaves the
 * outcome standing, so a non-null `requestId` beside an earlier `reportedAt` is a
 * machine that swept once and has not yet answered the question now outstanding —
 * the ordinary state of a laptop asleep when the weekly signal went out. Erasing
 * the outcome at ask time instead would make the fleet readout say "never swept"
 * for a machine that swept last week, which is the one thing the record exists to
 * deny.
 *
 * **Only the most recent sweep per machine is kept.** This is deliberately not a
 * history table: with the weekly cadence of issue #956 the one retained sweep is
 * precisely "last week's", which is the question the record exists to answer.
 *
 * The whole value is `null` on `Worker.worktreeSweep` until somebody asks — which,
 * like `drainingSince` and `update`, is what every row says until an operator acts.
 */
export const WorkerWorktreeSweepStateSchema = z.object({
	requestId: z.string().uuid().nullable(),
	requestedAt: z.date(),
	status: WorktreeSweepStatusSchema.nullable(),
	reportedAt: z.date().nullable(),
	result: WorktreeSweepResultSchema.nullable(),
});
export type WorkerWorktreeSweepState = z.infer<typeof WorkerWorktreeSweepStateSchema>;

/**
 * A registered worker. `ownerUserId` is a `users.id` (`uuid`, the SWARM user who
 * operates the machine); `displayName` is its human-facing label, unique per
 * owner (`src/db/schema/workers.ts`); `capabilities` is the set of agent
 * CLIs it can run and `supportedPhases` the set of pipeline phases its daemon
 * declared it can execute (issue #467). The axis exists because a daemon's
 * repertoire is its own to state, not because the two daemon kinds differ: since
 * issue #536 the DB-free remote daemon declares every phase, `planning` included,
 * so a narrower set today means an older build. `id` is generated (`uuid`), not
 * externally supplied.
 *
 * `repository` is the third self-declared fact (issue #687), and the one that is
 * not a *capability*: it states which repository the machine's single local
 * checkout is (`SWARM_WORKER_REPO_ROOT`), resolved from that checkout's `origin`
 * remote and re-declared on every reconnect, in the shared normalised
 * `owner/repo` form (`RepoSlugSchema`, `../scm/repo-slug.ts`) — so comparing it
 * against a `ProjectConfig.repo` must normalise that side too. `null` means no
 * declaration: a worker registered but never connected, a daemon too old to send
 * the field, or a checkout with no identifiable `origin`. Trusted exactly as the
 * two capability axes are — it guards against operator error (a daemon launched in
 * the wrong directory), not against an attacker.
 *
 * `drainingSince` (issue #919) is the one routability fact on the row that is
 * neither a capability nor daemon-declared: it is the operator's own statement
 * that the machine is **out of the pool** so it can be restarted, recorded as the
 * instant they made it and `null` while the machine is in the pool. The dispatch
 * gate refuses a draining worker before it even looks at connectivity, and nothing
 * the machine does — reconnecting included — clears it; only an operator does.
 *
 * `build` is the **fourth** self-declared fact (issue #918), and the second that is
 * not a capability: the commit the daemon's SWARM *install root* is on, plus a flag
 * for a dirty or unbuilt checkout (`WorkerBuildSchema`, `../lib/build-identity.ts`),
 * re-declared on every reconnect. It is what `daemonVersion` cannot answer — that
 * resolves to `package.json`'s `version`, which never moves — so this is the only
 * way to tell from the control plane whether a worker is running a given fix. Note
 * that the install root is *not* the machine's `repository` above: one npm-linked
 * SWARM checkout can serve daemons each working in a different project repository.
 * `null` means no declaration: a worker registered but never connected, a daemon too
 * old to send the field, or an install root that is not a git checkout. Trusted
 * exactly as the other declarations are — it guards against operator error (a stale
 * daemon), not against an attacker.
 *
 * `supervision` is the **fifth** self-declared fact (issue #997), and the one no
 * other declaration implies: whether a process supervisor — launchd, systemd —
 * will start this machine's daemon again after it exits, re-declared on every
 * reconnect. It answers whether the machine comes back from a restart it takes on
 * its own; the four facts above read identically on a machine that does and on one
 * that does not. `unknown` is a **real answer**, not an absent one, and is what
 * three different machines say: a worker registered but never connected, a daemon
 * too old to send the field, and a daemon on a platform these reads cannot answer
 * for — which states `unknown` rather than claiming either alternative. Trusted
 * exactly as the other declarations are: it guards against operator error (a daemon
 * started by hand and then updated), not against an attacker. Nothing routes on it
 * in this phase — refusing an update aimed at a machine that would not come back is
 * phase 2/2 of issue #997.
 *
 * `update` (issue #933) is the second field that is the *operator's* statement
 * rather than the daemon's, and it is the request half of what `build` reports: the
 * build this machine was asked to move to, whether that request is still awaiting an
 * answer, and the outcome the machine last reported. `null` until somebody asks. The
 * handshake never rewrites it, exactly as it never rewrites `drainingSince` — a
 * machine restarting into the requested build re-declares `build`, and that is how
 * the control plane learns the move actually happened.
 *
 * The CLI axis is **three** fields since issue #783, because the one field used to
 * collapse two facts that overwrite each other. `probedCapabilities` is the raw
 * `workers.capabilities` column — what the daemon currently operating the row last
 * found on its own PATH, rewritten at every handshake. `declaredCapabilities` is
 * the owner's durable statement, which no handshake touches; `null` means none has
 * been made. **`capabilities` is neither: it is the derived *effective* set**
 * ({@link effectiveCapabilities}), and it is the one every consumer routes on — the
 * eligibility gate, the dispatch candidate list, the rosters, the CLI's output.
 * Note the deliberate asymmetry with storage: the *column* `capabilities` is the
 * probe, the *domain field* `capabilities` is the effective set (see
 * `src/db/repositories/workersRepository.ts`).
 *
 * The worker credential hash is intentionally **not** a field here — it is a
 * secret that never leaves the DB layer (`rowToWorker` drops it), the same
 * treatment `users.password_hash` gets in `SwarmUser`.
 */
export const WorkerSchema = z.object({
	id: z.string().uuid(),
	ownerUserId: z.string().uuid(),
	displayName: WorkerDisplayNameSchema,
	/** The **effective** CLI set — see {@link effectiveCapabilities}, not a raw column. */
	capabilities: z.array(AgentCliSchema),
	/** The raw `workers.capabilities` column: the daemon's last self-probe. */
	probedCapabilities: z.array(AgentCliSchema),
	/** The owner's durable declaration, or `null` when none has been made. */
	declaredCapabilities: z.array(AgentCliSchema).nullable(),
	supportedPhases: z.array(TriggerPhaseSchema),
	repository: RepoSlugSchema.nullable(),
	/**
	 * The daemon's self-reported `os.hostname()`, or `null` when none has been
	 * reported — rewritten at every handshake, `repository`'s exact contract.
	 * Diagnostic/display only: an unauthenticated field of the handshake body, so
	 * nothing may be gated or scoped on it (`src/db/schema/workers.ts` "Diagnostic
	 * only" note).
	 */
	hostname: z.string().nullable(),
	/**
	 * When an operator took this machine out of the dispatch pool (issue #919), or
	 * `null` while it is in it — see the block above for why it is neither a
	 * capability nor daemon-declared.
	 */
	drainingSince: z.date().nullable(),
	build: WorkerBuildSchema.nullable(),
	/**
	 * The version the machine's SWARM install root declares (`package.json`), or
	 * `null` while it has declared none. A **label**, never a comparand: `build`
	 * above is what staleness is judged on, because a version only moves when an
	 * operator bumps it and every machine reports the same one between releases.
	 */
	version: z.string().nullable(),
	/**
	 * How the machine's daemon declared it is supervised (issue #997) — see the block
	 * above for why `unknown` is an answer rather than an absence, which is why this
	 * is not nullable.
	 */
	supervision: WorkerSupervisionSchema,
	/**
	 * The self-update an operator asked this machine for and what came of it (issue
	 * #933), or `null` while nobody has asked. Like `drainingSince` it is the
	 * operator's statement rather than the daemon's — the handshake never rewrites it
	 * — and the machine's answer is reported on its own route, never re-declared on
	 * connect. What a restarted machine *does* re-declare is `build` above, which is
	 * how the control plane sees the new build arrive.
	 */
	update: WorkerUpdateStateSchema.nullable(),
	/**
	 * The abandoned-worktree sweep an operator asked this machine for and what came
	 * of it (issue #955), or `null` while nobody has asked. The operator's statement
	 * and the machine's answer to it, exactly like `update` above: the handshake
	 * never rewrites it, and only the machine's own report on its own delivery route
	 * fills the outcome in. Unlike `update` it has no draining precondition — a sweep
	 * disturbs no in-flight run, because a checkout a phase still holds reads as
	 * leased and is skipped.
	 */
	worktreeSweep: WorkerWorktreeSweepStateSchema.nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export type Worker = z.infer<typeof WorkerSchema>;

/**
 * The CLI set a worker is actually routable on, resolved from the two facts a
 * `workers` row records (issue #783). Pure and dependency-free, and taking a
 * structural shape rather than the drizzle row type so both a raw row and a domain
 * `Worker` satisfy it — it is the single definition every reader goes through,
 * which is what stops one of them silently routing on the probe alone.
 *
 * - **No declaration** (`null`) → the probe, verbatim. That is the behaviour that
 *   pre-dated the column, so an installation where nobody has declared anything is
 *   indistinguishable from one before the split.
 * - **A declaration** → `declaration ∩ probe`. The declaration outranks a re-probe,
 *   which is the durability the split exists for; but a CLI the probe *proved
 *   absent* is still never dispatched. That intersection is well-founded rather
 *   than paranoid: `discoverAvailableClis` (`src/transport/cli-discovery.ts`) drops
 *   a CLI only on `ENOENT` and declares an unsettled probe anyway (issue #559), so
 *   a CLI missing from the probe is evidence of absence, not of a slow machine.
 *
 * The result may be empty, and that is correct rather than a bug: the worker is
 * simply eligible for nothing until its machine reports the declared CLI again.
 * Every consumer already handles an empty list.
 */
export function effectiveCapabilities(declaration: {
	capabilities: AgentCli[];
	declaredCapabilities: AgentCli[] | null;
}): AgentCli[] {
	const { capabilities, declaredCapabilities } = declaration;
	if (declaredCapabilities === null) return capabilities;
	const probed = new Set(capabilities);
	return declaredCapabilities.filter((cli) => probed.has(cli));
}

/**
 * Raised when updating a worker's capabilities to a set that excludes one or
 * more CLIs required by its existing project enrollments.
 */
export class WorkerCapabilityReductionError extends Error {
	constructor(
		public readonly workerId: string,
		public readonly offending: AgentCli[],
	) {
		super(
			`Cannot update capabilities for worker ${workerId}: existing enrollment(s) require CLIs not in updated capabilities: ${offending.join(', ')}`,
		);
		this.name = 'WorkerCapabilityReductionError';
	}
}

/**
 * Raised when a *declaration* (issue #783) names a CLI the machine's daemon has
 * never reported probing — the guard that keeps a declaration from widening past
 * what the machine can actually run, where {@link WorkerCapabilityReductionError}
 * keeps it from narrowing past what an enrollment needs.
 *
 * Refusing here rather than silently intersecting it away is deliberate: an
 * operator who declares `codex` on a machine without `codex` has made a mistake
 * they want told about, not a set they want quietly emptied. The message names the
 * offending CLIs, what the daemon last reported, and the supported way to widen
 * that set on the machine itself.
 */
export class WorkerCapabilityNotProbedError extends Error {
	constructor(
		public readonly workerId: string,
		public readonly offending: AgentCli[],
		public readonly probed: AgentCli[],
	) {
		super(
			`Cannot declare CLIs for worker ${workerId}: ${offending.join(', ')} ${offending.length === 1 ? 'is' : 'are'} not among the CLIs this machine's daemon last reported (${probed.length > 0 ? probed.join(', ') : 'none'}). Install it on the machine and let it reconnect, or declare it on the machine itself with SWARM_WORKER_TRANSPORT_CLIS.`,
		);
		this.name = 'WorkerCapabilityNotProbedError';
	}
}
