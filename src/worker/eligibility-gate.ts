/**
 * The **federated dispatch gate** (#130 Phase 3) — the scheduler half of
 * ADR-001's routing rules, wired into `processJob` *before* any worktree is
 * provisioned or any agent CLI is invoked (`./consumer.ts`).
 *
 * It answers one question per dispatch: *which* enrolled worker, on *which*
 * configured model target, may take this phase — or, when none may, the single
 * structured reason a human can act on. It composes the three pieces the earlier
 * phases built and adds only the scheduling policy:
 *
 * 1. **Candidates** — `listProjectDispatchCandidates` (#337, `src/identity/worker-enrollment-service.ts`)
 *    returns the project's enrolled workers with their enrollment and resolved
 *    availability, in the deterministic enrollment-creation order.
 * 2. **Affinity** — `resolveAssignedUser` (#130 Phase 1, `src/identity/assignee-resolver.ts`)
 *    maps the item's first linked assignee to a SWARM user; the permitted set is
 *    then *only* that user's workers. There is **no cross-user fallback**: an
 *    assigned item waits for its assignee's worker rather than running on
 *    someone else's (assignment is execution affinity, not a grant of access).
 *    An item with no assignees — or whose assignees are not linked to any SWARM
 *    user — takes the unassigned path (ADR-001 open question 5), so an unlinked
 *    handle never wedges a project. Affinity applies **per phase**
 *    ({@link AFFINITY_GATED_PHASES}): to `implementation` but not to `planning`,
 *    which belongs to no particular machine (issue #469; see that constant for why
 *    the exemption outlived the reason it was introduced for).
 * 3. **Eligibility** — `evaluateWorkerEligibility` (#338 Phase 2) judges one
 *    worker against one target: active enrollment → sharing consent →
 *    connection/health → free capacity → declared phase support (issue #467) →
 *    the enrollment's allowed phases (issue #509) → declared/allowed CLI.
 *
 * **Selection is target-priority-first, worker-order-second.** The gate walks
 * `agents.<phase>.targets` in configured order and, for each, takes an
 * eligible worker in the deterministic order. So a higher-priority Codex target
 * wins whenever *some* enrolled worker can run Codex, even if a Claude-only
 * worker is free for a lower-priority Claude target; and a lower-priority target
 * is chosen only when no worker can serve any higher-priority one. It never
 * silently falls back to `targets[0]` — a target no worker can run is skipped,
 * and exhausting the list yields a structured reason, not a blind dispatch.
 *
 * **Which of several eligible workers it takes is a pool decision** (issue #533).
 * "First in the deterministic order" is the right answer only when this dispatch is
 * the only one in play; with the consumer processing dispatches concurrently it can
 * spend a scarce capability another runnable phase uniquely needs. So when the
 * caller supplies the project's other runnable dispatches
 * ({@link DispatchGateOptions.loadPoolDemands}), the chosen target's eligible
 * workers are matched against the whole runnable set
 * (`./pool-scheduling.ts`) and this dispatch takes its share of that matching. The
 * pool only *reorders the preference* — it never withholds work, never overrides
 * target priority, and falls back to the first eligible worker whenever the matching
 * has no slot for this dispatch, so nothing it does can defer a phase that could
 * otherwise have run.
 *
 * **Every dispatch is gated, including retries and later phases**, because the
 * gate sits on the common dispatch path: consent revoked, an enrollment
 * suspended, health lost, or a capability removed between two attempts blocks
 * the *next* dispatch. It never touches a run already in flight — the gate runs
 * only before a phase starts, so teardown of a running agent is out of scope
 * (`isRoutable`, `src/identity/worker-enrollment.ts`).
 *
 * **MVP scope.** With no enrollments for a project the gate reports
 * `unfederated` and the local worker runs the phase exactly as before — there is
 * no other user's machine involved, so there is nothing to consent to. Federated
 * routing therefore switches on the moment a project enrolls its first worker.
 * `consumer.ts` turns a selected result into an authenticated, fenced,
 * atomic-capacity claim before it may create a run or enter a phase.
 *
 * Provider-neutral by construction (ai/RULES.md §2): the gate speaks
 * `WorkItemAssignee` + `SwarmUser` + worker/enrollment domain types, and reads
 * only `PMProvider.type`/`supportsAssignees` from the provider.
 */

import type { AgentTarget } from '../config/schema.js';
import type { AgentCli } from '../harness/agent-cli.js';
import { resolveAssignedUser } from '../identity/assignee-resolver.js';
import {
	evaluateWorkerEligibility,
	type IneligibilityReason,
	resolveTargetCli,
	type WorkerAvailability,
} from '../identity/worker-eligibility.js';
import {
	listProjectDispatchCandidates,
	type WorkerDispatchCandidate,
} from '../identity/worker-enrollment-service.js';
import type { PMProvider, WorkItem } from '../pm/types.js';
import type { TriggerPhase } from '../triggers/types.js';
import { type PoolDemand, selectPooledWorker } from './pool-scheduling.js';

/**
 * Why a *dispatch* was refused — Phase 2's per-worker vocabulary plus the one
 * verdict only a scheduler can reach: `assignee-worker-unavailable`, meaning the
 * assignee's workers as a set cannot take the work right now (none enrolled here,
 * or all of them busy/disconnected). Structural reasons stay per-worker so the
 * message names the thing an operator must fix.
 *
 * Only an affinity-gated phase can reach `assignee-worker-unavailable`
 * ({@link AFFINITY_GATED_PHASES}, issue #469): `planning` never narrows to one
 * user's machines, so it can never be refused for their unavailability.
 */
export type DispatchIneligibilityReason = IneligibilityReason | 'assignee-worker-unavailable';

/** The worker + target a gated dispatch resolved to. */
export interface DispatchSelection {
	workerId: string;
	/** The worker's human-facing label, for logs and messages (never a path or secret). */
	workerName: string;
	/** The SWARM user who operates the worker — the assignee, when affinity applied. */
	ownerUserId: string;
	/** The SWARM user the item is assigned to, when an assignee resolved to one. */
	assignedUserId?: string;
	/** The selected target — its CLI/model/reasoning drive the run. */
	target: AgentTarget;
	/** The target's index in the phase's priority list (0 = the preferred target). */
	targetIndex: number;
	/** The CLI the selected target actually runs on (its own, or the phase's coded default). */
	cli: AgentCli;
	/** CLIs of the higher-priority targets no eligible worker could serve. */
	skippedClis: AgentCli[];
}

/**
 * The gate's verdict: the project isn't federated (run locally, as before), a
 * worker+target was selected, or nothing may run and here is why.
 */
export type GateDecision =
	| { status: 'unfederated' }
	| { status: 'selected'; selection: DispatchSelection }
	| { status: 'ineligible'; reason: DispatchIneligibilityReason; message: string };

/**
 * Thrown by the worker when the gate refuses a dispatch. Handled like
 * `DependencyBlockedError` (`src/pipeline/dependency-guard.ts`): a
 * **token-free** bounded deferral that re-checks on a slow cadence — no
 * worktree, no agent, no model spend — and only settles `failed` (posting this
 * message on the item) once the wait budget is exhausted, so work is never
 * silently dropped. Its `message` is the human-readable, actionable reason.
 */
export class WorkerIneligibleError extends Error {
	readonly reason: DispatchIneligibilityReason;

	constructor(reason: DispatchIneligibilityReason, message: string) {
		super(message);
		this.name = 'WorkerIneligibleError';
		this.reason = reason;
	}
}

/**
 * One runnable dispatch as the pool scheduler sees it (issue #533) — the durable
 * dispatch plus what it would need to run. The gate turns each into the set of
 * workers that could serve it, so it can tell a phase only one worker can run from
 * one that has alternatives.
 *
 * A contender's demand is deliberately computed **without** assignee affinity: the
 * board item an affinity-gated dispatch would narrow by is not on its dispatch row,
 * and reconstructing it would mean a board read per waiting dispatch. Skipping it
 * yields a *superset* of the workers that contender can really use, which can only
 * make it look less constrained than it is — so the gate errs towards keeping its
 * own first-eligible pick rather than towards diverting for contention that isn't
 * real.
 */
export interface RunnableDispatchDemand {
	dispatchId: string;
	phase: TriggerPhase;
	/** The dispatch's candidate targets in priority order (`resolveTargetPolicy`). */
	targets: AgentTarget[];
	/** Its phase's coded default CLI, for a target that names none. */
	phaseDefaultCli: AgentCli;
}

/** Everything the gate judges for one dispatch. */
export interface DispatchGateInput {
	projectId: string;
	/**
	 * The durable dispatch being gated, when there is one. Required for pool
	 * scheduling — it is how this dispatch recognizes its own share of the matching
	 * (issue #533) — and absent only for callers with no dispatch row, which keep the
	 * plain first-eligible pick.
	 */
	dispatchId?: string;
	/** The phase's candidate targets in priority order (never empty — see `resolveTargetPolicy`). */
	targets: AgentTarget[];
	/** The phase's coded default CLI, for a target that names none. */
	phaseDefaultCli: AgentCli;
	/**
	 * The phase being dispatched. Read three times: matched against each candidate's
	 * declared `supportedPhases` (issue #467) so a worker whose daemon cannot run this
	 * phase is never selected for it, against each enrollment's `allowedPhases` (issue
	 * #509) so an owner's per-project selection is honored, and against
	 * {@link AFFINITY_GATED_PHASES} (issue #469) to decide whether assignee affinity
	 * applies at all.
	 */
	phase: TriggerPhase;
	/**
	 * The work item being dispatched, when the phase has one. PR-driven phases
	 * (review / respond-*) carry no item, so they take the unassigned path — as does
	 * `planning`, which carries one but is not affinity-gated
	 * ({@link AFFINITY_GATED_PHASES}).
	 */
	workItem?: Pick<WorkItem, 'assignees'>;
	/** The project's PM provider — only its `type`/`supportsAssignees` are read. */
	pm?: Pick<PMProvider, 'type' | 'supportsAssignees'>;
}

/** Per-call tuning for {@link evaluateDispatchEligibility}. */
export interface DispatchGateOptions {
	/**
	 * The **transport-connectivity** predicate (issue #407, phase 4). When the
	 * control plane dispatches over the worker transport, a worker is reachable
	 * only if it holds a live `/worker/stream` socket on *this* router process
	 * (`src/router/worker-connections.ts` `isWorkerConnected`) — a distinct fact
	 * from the DB `worker_sessions` lease liveness the availability snapshot
	 * already carries (a lease can read live while the socket is on another router
	 * or already gone). When supplied, a candidate counts as `connected` only if it
	 * is *both* DB-live and socket-connected here, so a DB-live-but-not-connected
	 * worker is never selected — it reports `worker-unavailable` and the durable
	 * dispatch stays pending, exactly as an offline worker does. Omitted for the
	 * in-process path, which reads connectivity from the lease alone (unchanged).
	 */
	isWorkerConnected?: (workerId: string) => boolean;
	/**
	 * The project's runnable dispatches — this one included — in scheduling order
	 * (issue #533). Supplied as a **lazy loader** rather than a value because it costs
	 * a query: the gate calls it only once it has found more than one eligible worker
	 * for the chosen target, which is the only situation in which the answer can
	 * change anything. Omitted (or resolving to `undefined`, which is how a caller
	 * reports a failed read) keeps the plain first-eligible pick — a pool read that
	 * fails must never block a dispatch that is otherwise ready to run.
	 */
	loadPoolDemands?: () => Promise<RunnableDispatchDemand[] | undefined>;
}

/**
 * The phases assignee affinity applies to (issue #469).
 *
 * Affinity has always covered only the phases that carry a `WorkItem` — the two
 * board-driven ones — since the PR-driven phases have no assignee to read
 * (`src/triggers/types.ts`). This narrows that set by one more: **`planning` is a
 * central phase and is not affinity-gated.**
 *
 * The original reason was that affinity and phase capability composed badly for
 * `planning` specifically. Affinity is a hard rule with no cross-user fallback,
 * while the ability to run `planning` was deliberately *not* distributed — a DB-free
 * remote worker refused it. An item assigned to a user whose only machine was such a
 * worker was therefore never plannable at all: the permitted set held one worker
 * that refuses the phase, and the dispatch deferred to a terminal failure while a
 * capable worker sat idle. Two individually correct rules produced work that could
 * never run.
 *
 * **That premise is gone (issue #536): every worker can now run `planning`, and the
 * exemption is deliberately kept anyway** — on the reason that outlived it, stated
 * in the paragraph below rather than inherited from the bug. Planning produces no
 * branch, no worktree-bound artifact and no PR: nothing about it belongs on a
 * particular person's machine, so gating it on affinity would only make a plan wait
 * for one worker while any other could produce the same comment and board writes.
 * Revisiting that is a routing decision of its own. (A pre-#536 daemon still
 * declares a narrower repertoire, so the composition the bug describes remains
 * reachable through version skew — which is why the exemption's *effect* is still
 * load-bearing and not merely historical.)
 *
 * `implementation` keeps affinity, and the rationale still holds there: it writes
 * source in a worktree on the operator's own machine under their own token, so
 * *whose* machine runs it is the point.
 */
const AFFINITY_GATED_PHASES: ReadonlySet<TriggerPhase> = new Set<TriggerPhase>(['implementation']);

/** Whether a phase routes to its assignee's own workers (see {@link AFFINITY_GATED_PHASES}). */
export function isAffinityGatedPhase(phase: TriggerPhase): boolean {
	return AFFINITY_GATED_PHASES.has(phase);
}

/**
 * How informative each ineligibility reason is when several candidates failed
 * for different reasons — highest first. `worker-unavailable` wins because it is
 * the *best* news available: some worker cleared every structural check and is
 * merely busy or offline, so waiting is genuinely all that's needed. Below it,
 * the closer a worker came to eligible, the more actionable its reason.
 */
const REASON_PRIORITY: readonly IneligibilityReason[] = [
	'worker-unavailable',
	'missing-cli-capability',
	// The two phase reasons sit below `missing-cli-capability` by the same "closer to
	// eligible wins" rule: the predicate checks both phase conditions *before* the
	// CLI, so a candidate that reported a missing CLI cleared them and came nearer to
	// eligible (issues #467, #509). Between the two, the enrollment's own choice is the
	// nearer miss — the machine can run the phase, its owner just hasn't offered it here.
	'phase-not-permitted',
	'missing-phase-capability',
	'missing-consent',
	'missing-enrollment',
];

/** The most informative reason among those the candidates reported. */
function aggregateReason(reported: Set<IneligibilityReason>): IneligibilityReason {
	for (const reason of REASON_PRIORITY) {
		if (reported.has(reason)) return reason;
	}
	// Unreachable: a non-empty candidate set always reports at least one reason.
	return 'worker-unavailable';
}

/** Where the refusal message should point a human, per reason. */
function ineligibilityMessage(
	reason: DispatchIneligibilityReason,
	context: { projectId: string; assignee?: string; clis: AgentCli[]; phase: TriggerPhase },
): string {
	const owner = context.assignee
		? `assignee '${context.assignee}'`
		: `project '${context.projectId}'`;
	switch (reason) {
		case 'assignee-worker-unavailable':
			return `No eligible worker is free for ${owner} — an assigned item waits for its assignee's own worker and is never routed to another user's. Waiting for one to become available.`;
		case 'worker-unavailable':
			return `No enrolled worker for ${owner} is currently connected with free capacity. Waiting for one to become available.`;
		case 'missing-consent':
			return `No enrolled worker for ${owner} has its owner's sharing consent for this project. A worker owner must grant sharing consent before SWARM may route work to it.`;
		case 'missing-enrollment':
			return `No worker for ${owner} has an active enrollment in this project. A project admin must approve the worker's enrollment before it can take work.`;
		case 'missing-cli-capability':
			return `No enrolled worker for ${owner} can run any configured model target for this phase (${context.clis.join(', ')}). Enroll a worker that declares and is allowed one of those CLIs, or configure a target this project's workers can run.`;
		// Phase-generic on purpose: this text is posted on the board item once the
		// recheck budget is spent, and a daemon may declare any subset — naming
		// `planning`/DB-free specifically would hand the operator a wrong diagnosis for
		// every other narrowed phase.
		case 'missing-phase-capability':
			return `No enrolled worker for ${owner} declared that it can run the '${context.phase}' phase. A worker declares which phases it can execute when it connects, and a remote worker running without a database declares a smaller set than a host worker does. Connect a worker that can run this phase — this work waits until one is available.`;
		// Deliberately points at the owner rather than the machine: unlike the reason
		// above, a capable worker *is* connected — it just isn't allowed this phase here
		// (issue #509), and only its owner can widen that.
		case 'phase-not-permitted':
			return `No enrolled worker for ${owner} is allowed the '${context.phase}' phase in this project. A worker owner chooses which pipeline phases their worker may be given per project enrollment; widen that selection on the worker's detail screen — this work waits until one permits the phase.`;
	}
}

/**
 * The availability the predicate judges, with transport connectivity folded in
 * (issue #407): when a connectivity predicate is supplied a candidate is
 * `connected` only if its DB lease is live *and* it holds a socket on this router,
 * so the deterministic first-free/affinity walk skips a live-lease-only worker as
 * `worker-unavailable` rather than choosing an unreachable one. Without a
 * predicate the availability snapshot is returned untouched (the in-process path).
 */
function resolveAvailability(
	candidate: WorkerDispatchCandidate,
	isWorkerConnected: ((workerId: string) => boolean) | undefined,
): WorkerAvailability {
	if (!isWorkerConnected) return candidate.availability;
	return {
		...candidate.availability,
		connected: candidate.availability.connected && isWorkerConnected(candidate.worker.id),
	};
}

/**
 * The workers that could serve one *other* runnable dispatch, under the same
 * target-priority-first rule this gate applies to its own (issue #533): the first
 * target any worker can run decides the demand, and the demand is that target's
 * eligible workers. Judged against every project candidate, since affinity is not
 * reconstructable here ({@link RunnableDispatchDemand}).
 */
function eligibleWorkersForDemand(
	candidates: WorkerDispatchCandidate[],
	demand: RunnableDispatchDemand,
	availabilityOf: (candidate: WorkerDispatchCandidate) => WorkerAvailability,
): string[] {
	for (const target of demand.targets) {
		const eligible = candidates
			.filter(
				(candidate) =>
					evaluateWorkerEligibility({
						worker: candidate.worker,
						enrollment: candidate.enrollment,
						availability: availabilityOf(candidate),
						target,
						phaseDefaultCli: demand.phaseDefaultCli,
						phase: demand.phase,
					}).eligible,
			)
			.map((candidate) => candidate.worker.id);
		if (eligible.length > 0) return eligible;
	}
	return [];
}

/**
 * How many runs each connected candidate could still take: its enrollment's
 * allocation less what it is already executing for this project. The pool matching
 * needs the *count* rather than the free/busy bit the eligibility predicate returns,
 * so a worker allocated two slots can serve two runnable dispatches at once.
 */
function freeSlotsByWorker(
	candidates: WorkerDispatchCandidate[],
	availabilityOf: (candidate: WorkerDispatchCandidate) => WorkerAvailability,
): Map<string, number> {
	const slots = new Map<string, number>();
	for (const candidate of candidates) {
		const availability = availabilityOf(candidate);
		if (!availability.connected) continue;
		const free = candidate.enrollment.concurrencyAllocation - availability.activeRuns;
		if (free > 0) slots.set(candidate.worker.id, free);
	}
	return slots;
}

/**
 * Which of this dispatch's eligible workers to take (issue #533). With one
 * candidate, or without a dispatch id / pool loader, that is the deterministic first
 * one — today's behaviour. Otherwise the project's runnable dispatches are matched
 * against the pool's free slots and this dispatch takes its share, falling back to
 * the first eligible worker whenever the matching left it unplaced: the pool chooses
 * *between* workers and never withholds one (see `./pool-scheduling.ts`).
 */
async function selectEligibleWorker(
	eligible: readonly [WorkerDispatchCandidate, ...WorkerDispatchCandidate[]],
	input: DispatchGateInput,
	options: DispatchGateOptions,
	candidates: WorkerDispatchCandidate[],
	availabilityOf: (candidate: WorkerDispatchCandidate) => WorkerAvailability,
): Promise<WorkerDispatchCandidate> {
	const [first] = eligible;
	const dispatchId = input.dispatchId;
	if (eligible.length === 1 || !dispatchId || !options.loadPoolDemands) return first;

	const runnable = await options.loadPoolDemands();
	if (!runnable || runnable.length === 0) return first;

	const self: PoolDemand = {
		dispatchId,
		// This dispatch's own demand is the gate's own walk — the affinity-narrowed,
		// override-pinned set it actually selects from — not the reconstruction the
		// other demands get.
		eligibleWorkerIds: eligible.map((candidate) => candidate.worker.id),
	};
	const demands = runnable.map((demand) =>
		demand.dispatchId === dispatchId
			? self
			: {
					dispatchId: demand.dispatchId,
					eligibleWorkerIds: eligibleWorkersForDemand(candidates, demand, availabilityOf),
				},
	);
	// A dispatch missing from its own project's runnable set (its row was claimed, or
	// the read raced its state transition) ranks last: every demand the caller *did*
	// report is a known-runnable one, and this dispatch loses nothing by yielding to
	// them — it still falls back to `first` when the matching has no slot for it.
	if (!demands.some((demand) => demand.dispatchId === dispatchId)) demands.push(self);

	const pooled = selectPooledWorker(
		{ demands, freeSlots: freeSlotsByWorker(candidates, availabilityOf) },
		dispatchId,
	);
	return eligible.find((candidate) => candidate.worker.id === pooled) ?? first;
}

/**
 * Decide whether — and where — this dispatch may run. Reads only; it never
 * mutates an enrollment, session, or run, and it is safe to call again on every
 * retry (which is exactly how revocation between attempts takes effect).
 */
export async function evaluateDispatchEligibility(
	input: DispatchGateInput,
	options: DispatchGateOptions = {},
): Promise<GateDecision> {
	const candidates = await listProjectDispatchCandidates(input.projectId);
	// No enrollments: this project is not federated, so there is no other user's
	// machine to gate. The local worker runs it, exactly as before #130.
	if (candidates.length === 0) return { status: 'unfederated' };

	// Resolving the assignee is what *applies* affinity, so a phase that is not
	// affinity-gated skips it entirely rather than resolving and then ignoring the
	// answer (issue #469). That keeps every downstream consequence consistent: no
	// narrowed `permitted` set, no `assignedUserId` on the selection, and no
	// `assignee-worker-unavailable` framing — all of which would otherwise describe a
	// wait for the assignee's own worker that this phase is not waiting for.
	const assigned =
		input.workItem && input.pm?.supportsAssignees && isAffinityGatedPhase(input.phase)
			? await resolveAssignedUser(input.workItem, input.pm.type)
			: undefined;
	const permitted = assigned
		? candidates.filter((c) => c.worker.ownerUserId === assigned.user.id)
		: candidates;
	const clis = [
		...new Set(input.targets.map((target) => resolveTargetCli(target, input.phaseDefaultCli))),
	];
	const messageContext = {
		projectId: input.projectId,
		assignee: assigned?.assignee.handle,
		clis,
		phase: input.phase,
	};
	if (permitted.length === 0) {
		return {
			status: 'ineligible',
			reason: 'assignee-worker-unavailable',
			message: ineligibilityMessage('assignee-worker-unavailable', messageContext),
		};
	}

	// Target priority first, worker choice second: a configured preference for a CLI
	// outranks a free worker that can only serve a lower-priority target. Only *which*
	// of the chosen target's eligible workers wins is a pool decision (issue #533) —
	// target priority is a hard rule the pool never trades away, so the walk still
	// stops at the first target any worker can run.
	const availabilityOf = (candidate: WorkerDispatchCandidate): WorkerAvailability =>
		resolveAvailability(candidate, options.isWorkerConnected);
	const reported = new Set<IneligibilityReason>();
	for (const [targetIndex, target] of input.targets.entries()) {
		const eligible: WorkerDispatchCandidate[] = [];
		for (const candidate of permitted) {
			const verdict = evaluateWorkerEligibility({
				worker: candidate.worker,
				enrollment: candidate.enrollment,
				availability: availabilityOf(candidate),
				target,
				phaseDefaultCli: input.phaseDefaultCli,
				phase: input.phase,
			});
			if (verdict.eligible) eligible.push(candidate);
			else reported.add(verdict.reason);
		}
		const [firstEligible, ...alternatives] = eligible;
		if (!firstEligible) continue;
		const chosen = await selectEligibleWorker(
			[firstEligible, ...alternatives],
			input,
			options,
			candidates,
			availabilityOf,
		);
		return {
			status: 'selected',
			selection: {
				workerId: chosen.worker.id,
				workerName: chosen.worker.displayName,
				ownerUserId: chosen.worker.ownerUserId,
				assignedUserId: assigned?.user.id,
				target,
				targetIndex,
				cli: resolveTargetCli(target, input.phaseDefaultCli),
				skippedClis: input.targets
					.slice(0, targetIndex)
					.map((skipped) => resolveTargetCli(skipped, input.phaseDefaultCli)),
			},
		};
	}

	// An assignee whose own workers are merely busy/offline is the scheduler-level
	// verdict, not a per-worker one: the work waits for *that user's* worker.
	const aggregated = aggregateReason(reported);
	const reason: DispatchIneligibilityReason =
		assigned && aggregated === 'worker-unavailable' ? 'assignee-worker-unavailable' : aggregated;
	return {
		status: 'ineligible',
		reason,
		message: ineligibilityMessage(reason, messageContext),
	};
}
