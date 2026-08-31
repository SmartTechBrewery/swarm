/**
 * The default agent wall-clock timeout — the coded default and the env-var
 * override that answer "how long may a phase's agent run when the project sets
 * no per-phase `timeoutMs`?".
 *
 * These lived in `src/worker/consumer.ts` (which still re-exports them, so every
 * existing importer is unchanged) until a *trigger* needed the same answer: the
 * `pr-review` handler sizes the PR+SHA dispatch lease it hands a Respond-to-CI
 * dispatch from the timeout that dispatch will actually run under, and importing
 * the worker's composition root into a trigger module to get it would drag the
 * whole worker graph onto the handler's. A constant and a parse have no business
 * being that expensive, so they sit here instead.
 */

/**
 * Coded default wall-clock timeout applied to *every* phase/agent invocation
 * when a project sets no per-phase `agents.<phase>.timeoutMs` (issue #165).
 * Without it an agent that hangs — a model that never responds, a wedged CLI —
 * runs forever, holding a worker slot and leaving its run row stuck `running`
 * (confirmed live on run `dd0ad860-…`). Chosen as a 30-minute default: long
 * enough for a focused phase, while bounding a runaway run's quota use and
 * occupied worker slot. Override the
 * default globally with the `SWARM_AGENT_TIMEOUT_MS` env var
 * (README § Configuration); a per-phase `timeoutMs` in `swarm.config.json`
 * still wins over both.
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Resolve the effective default agent timeout: `SWARM_AGENT_TIMEOUT_MS` when it
 * is set to a positive integer, else {@link DEFAULT_AGENT_TIMEOUT_MS}. Exported
 * so the control-plane host's maintenance loop reuses the exact same value for
 * its stale-run reconciliation cutoff (`src/api/maintenance.ts`). Throws on a
 * non-integer / <1
 * value so a typo surfaces at startup rather than silently disabling the safety
 * net.
 */
export function resolveAgentTimeoutMs(raw = process.env.SWARM_AGENT_TIMEOUT_MS): number {
	if (raw === undefined || raw === '') return DEFAULT_AGENT_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`SWARM_AGENT_TIMEOUT_MS must be a positive integer, got '${raw}'`);
	}
	return parsed;
}
