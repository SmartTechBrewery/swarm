/**
 * The **worker eligibility predicate** — the pure half of #130's dispatch gate.
 * Given one worker, its enrollment for a project, a snapshot of its current
 * availability, and **one** candidate model target, it decides whether that
 * worker may take the work, or which single signal is missing. Phase 2 of #130,
 * on top of the worker identity / session / enrollment model (#132, #336, #337).
 *
 * It combines ADR-001's routing prerequisites — "an eligible, connected worker
 * with active owner sharing consent, project enrollment, required CLI
 * capability, and available capacity" — in that order: active enrollment →
 * active sharing consent → connection/health → free capacity → declared phase
 * support (issue #467) → declared CLI capability. The first missing signal wins, so a caller always gets *the* reason
 * to show rather than a set to prioritize itself. The first two checks together
 * are exactly `isRoutable` (`./worker-enrollment.ts`, #337's named seam); they are
 * evaluated separately only so a revoked consent is reported as `missing-consent`
 * rather than as a suspended enrollment.
 *
 * **Target-scoped, never target-choosing.** A phase configures an *ordered* list
 * of model targets (`agents.<phase>.targets`, `src/config/schema.ts`); this
 * evaluates exactly one of them, against its effective CLI — the target's own
 * `cli`, or the phase's coded default (`DEFAULT_*_CLI`, `src/pipeline/*.ts`,
 * supplied as `phaseDefaultCli`) when it omits one. It never reorders, selects
 * between, or falls back across targets: the scheduler (Phase 3) calls it once
 * per candidate target and keeps the target behind every eligible verdict, so
 * configured target priority survives across workers instead of collapsing back
 * into a single-model selection.
 *
 * Dependency-light and side-effect-free (like `src/pm/dependencies.ts`): every
 * DB-backed signal — whether the session is live, how many runs the worker is
 * executing — is resolved by the caller and passed in as {@link WorkerAvailability},
 * so the predicate holds no I/O and is trivially unit-testable. Nothing dispatches
 * through it yet; wiring it into the dispatch path, scheduler ordering, and
 * assignee affinity is Phase 3.
 */

import { z } from 'zod';
import type { AgentTarget } from '../config/schema.js';
import type { AgentCli } from '../harness/agent-cli.js';
import type { TriggerPhase } from '../triggers/types.js';
import type { Worker } from './worker.js';
import type { WorkerEnrollment } from './worker-enrollment.js';

/**
 * Why a worker may not take a piece of work — the structured vocabulary Phase 3's
 * skip/defer messages and dispatch wait-reason mapping reuse instead of matching
 * on prose. One value per missing signal:
 *
 * - `missing-enrollment` — no enrollment for this project, or one that is not
 *   `active` (still `pending` approval, or `suspended`).
 * - `missing-consent` — enrolled and active, but the worker's owner has not
 *   granted (or has revoked) sharing consent for this project.
 * - `worker-unavailable` — the worker is disconnected/unhealthy (no live
 *   session) or already at its enrolled concurrency allocation (only when that
 *   allocation is set; a `null` allocation imposes no per-worker slot cap). One
 *   value, since both resolve the same way: wait for the worker to come back or
 *   free a slot.
 * - `missing-phase-capability` — the worker's daemon did not declare this pipeline
 *   phase as one it can execute (issue #467). Distinct from a missing CLI: the
 *   machine may have every CLI and still refuse the phase, as the DB-free remote
 *   daemon refuses `planning` (`SUPPORTED_DB_FREE_PHASES`,
 *   `../transport/assignment-execution.ts`). It is a property of the whole worker,
 *   not of one target, so it is judged before the per-target CLI check.
 * - `missing-cli-capability` — the candidate target's effective CLI is not among
 *   the worker's declared capabilities, or the enrollment does not allow it on
 *   this project.
 *
 * The scheduler-only `assignee-worker-unavailable` value is deliberately **not**
 * here: it is a verdict about *the assignee's whole set of workers* (ADR-001's
 * execution-affinity rule), not about the one worker this predicate judges, so
 * Phase 3 adds it at the scheduler layer.
 */
export const IneligibilityReasonSchema = z.enum([
	'missing-enrollment',
	'missing-consent',
	'worker-unavailable',
	'missing-phase-capability',
	'missing-cli-capability',
]);

export type IneligibilityReason = z.infer<typeof IneligibilityReasonSchema>;

/** Every ineligibility reason — for exhaustive mapping and CLI/dashboard copy. */
export const INELIGIBILITY_REASONS = IneligibilityReasonSchema.options;

/**
 * The verdict: eligible, or ineligible with the one reason that blocked it. A
 * discriminated union rather than a boolean, so a caller cannot read a verdict
 * without deciding what to do about its reason.
 */
export type EligibilityResult =
	| { eligible: true }
	| { eligible: false; reason: IneligibilityReason };

/**
 * The worker's *current* availability, resolved by the caller so this module
 * stays pure. `connected` is whether the worker holds a live session — a
 * heartbeat within the TTL (`getLiveSessionForWorker`,
 * `./worker-session-service.ts`); a missing, expired, or released lease is a
 * disconnected/unhealthy worker (ADR-001 "Worker capabilities and availability").
 * `activeRuns` is how many runs it is executing for this project right now,
 * derived from run lifecycle and never client-supplied (the same rule
 * `deriveWorkerRunState` follows); it is compared against the enrollment's
 * `concurrencyAllocation` to decide whether a slot is free — unless that
 * allocation is `null`, in which case no per-worker slot cap applies.
 */
export interface WorkerAvailability {
	connected: boolean;
	activeRuns: number;
}

/** Everything {@link evaluateWorkerEligibility} judges — one worker, one target. */
export interface WorkerEligibilityInput {
	/** The worker's declared CLI and phase capabilities (`./worker.ts`). */
	worker: Pick<Worker, 'capabilities' | 'supportedPhases'>;
	/** Its enrollment for the project, or `undefined` when it has none. */
	enrollment: WorkerEnrollment | undefined;
	availability: WorkerAvailability;
	/** The one candidate target being judged — never a list (see the module note). */
	target: AgentTarget;
	/** The phase's coded default CLI, used when `target` names none. */
	phaseDefaultCli: AgentCli;
	/**
	 * The phase being dispatched, checked against the worker's declared
	 * `supportedPhases` (issue #467). Required rather than optional: a caller that
	 * forgot to pass it would silently reopen the very hole this closes, so the
	 * type-checker makes every call site name its phase.
	 */
	phase: TriggerPhase;
}

/**
 * The CLI a candidate target actually runs on: its own `cli`, or the phase's
 * coded default when it omits one. Exported so a caller that needs to name the
 * CLI (a skip/defer message, a log line) resolves it exactly as the predicate did.
 */
export function resolveTargetCli(target: AgentTarget, phaseDefaultCli: AgentCli): AgentCli {
	return target.cli ?? phaseDefaultCli;
}

/**
 * Judge one worker against one candidate target, returning the first missing
 * signal in ADR-001's order (enrollment → consent → connection → capacity → phase
 * capability → CLI capability). Pure: it reads only what it is given.
 */
export function evaluateWorkerEligibility(input: WorkerEligibilityInput): EligibilityResult {
	const { worker, enrollment, availability, target, phaseDefaultCli, phase } = input;
	if (!enrollment || enrollment.status !== 'active') {
		return { eligible: false, reason: 'missing-enrollment' };
	}
	if (!enrollment.sharingConsent) {
		return { eligible: false, reason: 'missing-consent' };
	}
	// A `null` `concurrencyAllocation` imposes no per-worker slot cap (the worker
	// is bounded only by its process-wide `SWARM_WORKER_CONCURRENCY` and the
	// project's cap); only a set positive allocation gates on a free slot here.
	const atCapacity =
		enrollment.concurrencyAllocation !== null &&
		availability.activeRuns >= enrollment.concurrencyAllocation;
	if (!availability.connected || atCapacity) {
		return { eligible: false, reason: 'worker-unavailable' };
	}
	// Whether this machine runs this phase at all — judged before the CLI because it
	// is a property of the worker rather than of the candidate target (issue #467).
	// Without it the gate could hand `planning` to a DB-free daemon, which refuses it
	// and reports a terminal failure the dispatcher cannot re-route.
	if (!worker.supportedPhases.includes(phase)) {
		return { eligible: false, reason: 'missing-phase-capability' };
	}
	const cli = resolveTargetCli(target, phaseDefaultCli);
	// Both constraints are required: the worker must declare the CLI, and the
	// enrollment must permit it on *this* project (`allowedClis` is a subset of the
	// capabilities, so a project may narrow what an otherwise capable worker runs).
	if (!worker.capabilities.includes(cli) || !enrollment.allowedClis.includes(cli)) {
		return { eligible: false, reason: 'missing-cli-capability' };
	}
	return { eligible: true };
}
