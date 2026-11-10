/**
 * The **one** reading of a phase's model-target policy (issues #345/#346/#339).
 *
 * A phase configures an ordered priority list — `agents.<phase>.targets`
 * (`src/config/schema.ts`) — and a run may pin exactly one target through a
 * per-run override (a manual "Retry now" with a CLI/model/reasoning). Three
 * places have to agree on that policy: the federated eligibility gate
 * (`./eligibility-gate.ts`, which walks the list target-by-target looking for a
 * worker that can run each), local capability routing (`./target-selection.ts`),
 * and the consumer's own `agentOverrideFor` (which resolves the run row's
 * engine/model and the phase invocation). Resolving it here keeps run creation,
 * retry reset, dispatch, and phase invocation on the same target instead of each
 * re-deriving "which target is in play" from `project.agents`.
 *
 * Pure and dependency-light: config + job in, targets out. Nothing here decides
 * *which* target wins — that is routing's job (local availability) or the gate's
 * (worker eligibility, target priority first).
 */

import type { AgentConfig, AgentTarget, ProjectConfig } from '../config/schema.js';
import type { AgentCli } from '../harness/agent-cli.js';
import { isReasoningLevel, type ReasoningLevel } from '../harness/models.js';
import { DEFAULT_IMPLEMENTATION_CLI } from '../pipeline/implementation.js';
import { DEFAULT_PLANNING_CLI } from '../pipeline/planning.js';
import { DEFAULT_RESOLVE_CONFLICTS_CLI } from '../pipeline/resolve-conflicts.js';
import { DEFAULT_RESOLVE_PROBLEM_CLI } from '../pipeline/resolve-problem.js';
import { DEFAULT_RESPOND_CI_CLI } from '../pipeline/respond-to-ci.js';
import { DEFAULT_RESPOND_CLI } from '../pipeline/respond-to-review.js';
import { DEFAULT_REVIEW_CLI } from '../pipeline/review.js';
import type { SwarmJob } from '../queue/jobs.js';
import type { TriggerPhase } from '../triggers/types.js';

/**
 * Each phase's own coded default CLI — the CLI a target that names none actually
 * runs on. Read by the eligibility gate, which must judge a worker's declared
 * capability against the *effective* CLI (`resolveTargetCli`,
 * `src/identity/worker-eligibility.ts`), not against an absent one.
 */
export const PHASE_DEFAULT_CLI: Record<TriggerPhase, AgentCli> = {
	planning: DEFAULT_PLANNING_CLI,
	implementation: DEFAULT_IMPLEMENTATION_CLI,
	review: DEFAULT_REVIEW_CLI,
	'respond-to-review': DEFAULT_RESPOND_CLI,
	'respond-to-ci': DEFAULT_RESPOND_CI_CLI,
	'resolve-conflicts': DEFAULT_RESOLVE_CONFLICTS_CLI,
	'resolve-problem': DEFAULT_RESOLVE_PROBLEM_CLI,
};

/**
 * The per-phase agent config a project set, resolving the Implementation
 * variant used when the item was never planned (`implementationUnplanned`).
 * `{}` when the phase configures nothing — it then stays on its coded defaults.
 */
export function phaseAgentConfig(
	project: ProjectConfig,
	phase: TriggerPhase,
	implementationUnplanned = false,
): AgentConfig {
	switch (phase) {
		case 'planning':
			return project.agents?.planning ?? {};
		case 'implementation':
			return implementationUnplanned
				? (project.agents?.implementationUnplanned ?? project.agents?.implementation ?? {})
				: (project.agents?.implementation ?? {});
		case 'review':
			return project.agents?.review ?? {};
		case 'respond-to-review':
			return project.agents?.respondToReview ?? {};
		case 'respond-to-ci':
			return project.agents?.respondToCi ?? {};
		case 'resolve-conflicts':
			return project.agents?.resolveConflicts ?? {};
		case 'resolve-problem':
			return project.agents?.resolveProblem ?? {};
	}
}

/** The candidate targets for one dispatch, in priority order. */
export interface TargetPolicy {
	/**
	 * Priority-ordered candidates — **never empty**. A phase that configures no
	 * targets contributes one empty target, meaning "the phase's coded default
	 * CLI on its default model", so callers never special-case an absent list.
	 */
	targets: AgentTarget[];
	/**
	 * True when a per-run override pinned exactly one target (a manual "Retry now"
	 * naming a CLI/model/reasoning). A pinned run deliberately keeps that exact
	 * selection: routing and the gate evaluate it, they never route around it.
	 */
	pinned: boolean;
}

/** The per-run reasoning override, dropped unless it is a known level. */
function resolvePinnedReasoning(job: SwarmJob | undefined): ReasoningLevel | undefined {
	return isReasoningLevel(job?.reasoningOverride) ? job?.reasoningOverride : undefined;
}

/**
 * The candidate targets for this dispatch. Without a per-run override that is
 * the phase's configured priority list (or the implicit coded-default target);
 * with one it is the single pinned target, folding the overrides over the
 * phase's own `cli`/`model`/`reasoning` mirror exactly as the consumer did
 * before targets existed.
 */
export function resolveTargetPolicy(phaseConfig: AgentConfig, job?: SwarmJob): TargetPolicy {
	const overrideReasoning = resolvePinnedReasoning(job);
	if (job?.cliOverride ?? job?.modelOverride ?? overrideReasoning) {
		return {
			pinned: true,
			targets: [
				{
					cli: job?.cliOverride ?? phaseConfig.cli,
					model: job?.modelOverride ?? phaseConfig.model,
					reasoning: overrideReasoning ?? phaseConfig.reasoning,
				},
			],
		};
	}
	const targets = phaseConfig.targets ?? [];
	return { pinned: false, targets: targets.length > 0 ? targets : [{}] };
}
