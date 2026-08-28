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
