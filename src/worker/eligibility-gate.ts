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
 *    handle never wedges a project.
 * 3. **Eligibility** — `evaluateWorkerEligibility` (#338 Phase 2) judges one
 *    worker against one target: active enrollment → sharing consent →
 *    connection/health → free capacity → declared/allowed CLI.
 *
 * **Selection is target-priority-first, worker-order-second.** The gate walks
 * `agents.<phase>.targets` in configured order and, for each, takes the first
 * eligible worker in the deterministic order. So a higher-priority Codex target
 * wins whenever *some* enrolled worker can run Codex, even if a Claude-only
 * worker is free for a lower-priority Claude target; and a lower-priority target
 * is chosen only when no worker can serve any higher-priority one. It never
 * silently falls back to `targets[0]` — a target no worker can run is skipped,
 * and exhausting the list yields a structured reason, not a blind dispatch.
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

/**
 * Why a *dispatch* was refused — Phase 2's per-worker vocabulary plus the one
 * verdict only a scheduler can reach: `assignee-worker-unavailable`, meaning the
 * assignee's workers as a set cannot take the work right now (none enrolled here,
 * or all of them busy/disconnected). Structural reasons stay per-worker so the
 * message names the thing an operator must fix.
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

/** Everything the gate judges for one dispatch. */
export interface DispatchGateInput {
	projectId: string;
	/** The phase's candidate targets in priority order (never empty — see `resolveTargetPolicy`). */
	targets: AgentTarget[];
	/** The phase's coded default CLI, for a target that names none. */
	phaseDefaultCli: AgentCli;
	/**
	 * The work item being dispatched, when the phase has one. PR-driven phases
	 * (review / respond-*) carry no item, so they take the unassigned path.
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
	context: { projectId: string; assignee?: string; clis: AgentCli[] },
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

	const assigned =
		input.workItem && input.pm?.supportsAssignees
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
	};
	if (permitted.length === 0) {
		return {
			status: 'ineligible',
			reason: 'assignee-worker-unavailable',
			message: ineligibilityMessage('assignee-worker-unavailable', messageContext),
		};
	}

	// Target priority first, deterministic worker order second: a configured
	// preference for a CLI outranks a free worker that can only serve a
	// lower-priority target.
	const reported = new Set<IneligibilityReason>();
	for (const [targetIndex, target] of input.targets.entries()) {
		for (const candidate of permitted) {
			const verdict = evaluateWorkerEligibility({
				worker: candidate.worker,
				enrollment: candidate.enrollment,
				availability: resolveAvailability(candidate, options.isWorkerConnected),
				target,
				phaseDefaultCli: input.phaseDefaultCli,
			});
			if (verdict.eligible) {
				return {
					status: 'selected',
					selection: {
						workerId: candidate.worker.id,
						workerName: candidate.worker.displayName,
						ownerUserId: candidate.worker.ownerUserId,
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
			reported.add(verdict.reason);
		}
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
