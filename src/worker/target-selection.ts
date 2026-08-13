/**
 * The ordered walk over a phase's model targets (issue #346).
 *
 * `agents.<phase>.targets` (`src/config/schema.ts`) is a priority list — index 0
 * is the phase's preferred CLI/model/reasoning combination. {@link selectTarget}
 * picks the highest-priority target whose CLI the *executing host* can actually
 * run, so a phase configured for a CLI that machine lacks still runs — on the
 * next target it can serve — instead of failing on spawn.
 *
 * Scope: the walk itself, and never the availability set it walks against. This
 * module resolves no CLI set of its own: since issue #553 its caller
 * (`processJob`, `src/worker/consumer.ts`) runs in the control plane, which
 * executes nothing, and the `cli_quotas` rows describe whichever host ran
 * discovery rather than the host that will execute (issue #703) — so there is
 * nothing correct to look up here. Resolving a target against a real host's
 * declared capabilities is the federated eligibility gate's job
 * (`evaluateWorkerEligibility`, `src/identity/worker-eligibility.ts`), which
 * picks worker and target together; `targetSelectionFor`
 * (`src/worker/consumer.ts`) adapts that decision into the same {@link
 * TargetSelection} shape. Don't re-introduce a control-plane-side availability
 * lookup.
 */

import type { AgentTarget } from '../config/schema.js';
import type { AgentCli } from '../harness/agent-cli.js';

/**
 * The CLIs the executing host can run — supplied by a caller that actually knows
 * that host's set — or `undefined` when that is unknown: an unknown answer
 * routes to the preferred target rather than to "nothing is available".
 */
export type WorkerCliAvailability = ReadonlySet<AgentCli> | undefined;

/** Which of a phase's targets routing landed on, and what it had to skip. */
export type TargetSelection = {
	/** The chosen target — its `cli`/`model`/`reasoning` drive the run. */
	target: AgentTarget;
	/** Its index in the phase's priority list (0 = the preferred target). */
	index: number;
	/** CLIs of the higher-priority targets skipped as unrunnable on that host. */
	skipped: AgentCli[];
	/**
	 * No target's CLI is available on that host, so the preferred one was used
	 * anyway — preserving the pre-routing behaviour of failing visibly on spawn. A
	 * phase is never silently skipped for want of a CLI.
	 */
	fallback: boolean;
};

/**
 * Pick the highest-priority target the executing host can run. Pure: the
 * availability set is passed in by whoever knows it.
 *
 * Returns `undefined` when the phase configured no targets at all (it stays on
 * its coded defaults, and the caller keeps reading the single-selection mirror).
 */
export function selectTarget(
	targets: AgentTarget[] | undefined,
	availableClis: WorkerCliAvailability,
): TargetSelection | undefined {
	if (!targets || targets.length === 0) return undefined;
	const preferred = targets[0];
	// Capabilities unknown — keep the pre-routing behaviour and run the preferred target.
	if (!availableClis) return { target: preferred, index: 0, skipped: [], fallback: false };
	const skipped: AgentCli[] = [];
	for (const [index, target] of targets.entries()) {
		// A target with no `cli` runs on the phase's own coded default CLI, which
		// this list can't name and so has no availability signal — always eligible.
		if (!target.cli || availableClis.has(target.cli)) {
			return { target, index, skipped, fallback: false };
		}
		skipped.push(target.cli);
	}
	return { target: preferred, index: 0, skipped: [], fallback: true };
}
