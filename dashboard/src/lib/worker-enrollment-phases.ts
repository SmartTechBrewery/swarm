import type { PipelineConfig } from '../../../src/config/schema.js';
import { ALL_TRIGGER_PHASES, type TriggerPhase } from '../../../src/triggers/types.js';
import { type PipelineTogglePhase, toPipelineEnabledForm } from './pipeline-enabled.js';

/**
 * How the worker detail view offers an enrollment's **Allowed pipeline phases**
 * (issue #509). Three independent conditions decide whether a phase can actually
 * run on a machine for a project, and only one of them is the owner's to change:
 *
 * 1. the machine's daemon must declare the phase (`Worker.supportedPhases`, read-only
 *    — re-declared on every reconnect);
 * 2. the project must have the phase enabled (`pipeline.<phase>.enabled`, a project
 *    administrator's setting on the Agents tab);
 * 3. **this enrollment** must permit it (`allowedPhases`, what the control edits).
 *
 * The dispatch gate ANDs the first and third (`evaluateWorkerEligibility`,
 * `src/identity/worker-eligibility.ts`) and the trigger handlers enforce the
 * second, so the control's job is to say which of the three is in the way rather
 * than to offer a selection that could never take work. These helpers derive that
 * per-phase state as plain data, so the component renders it and the reasoning is
 * unit-testable on its own.
 */

/**
 * Which project-level toggle governs each pipeline phase. Planning,
 * Implementation, and Resolve-conflicts carry no `enabled` flag
 * ({@link PIPELINE_TOGGLE_PHASES}, `./pipeline-enabled.ts`) and so are never
 * project-disabled.
 */
const PHASE_TOGGLE_KEYS: Partial<Record<TriggerPhase, PipelineTogglePhase>> = {
	review: 'review',
	'respond-to-review': 'respondToReview',
	'respond-to-ci': 'respondToCi',
};

/**
 * The phases this project has turned off for **every** worker
 * (`pipeline.<phase>.enabled === false`). Derived from the same
 * {@link toPipelineEnabledForm} projection the Agents tab edits, so the two screens
 * cannot disagree about what "disabled" means; an unknown/absent pipeline config
 * disables nothing (an unset flag means the phase runs).
 */
export function projectDisabledPhases(pipeline: PipelineConfig | undefined): TriggerPhase[] {
	const enabled = toPipelineEnabledForm(pipeline);
	return ALL_TRIGGER_PHASES.filter((phase) => {
		const toggle = PHASE_TOGGLE_KEYS[phase];
		return toggle !== undefined && !enabled[toggle];
	});
}

/** One phase's checkbox state: whether the enrollment permits it, and what blocks it. */
export interface EnrollmentPhaseOption {
	phase: TriggerPhase;
	/** Whether this enrollment currently permits the phase. */
	allowed: boolean;
	/**
	 * `null` when the phase is freely selectable; otherwise why selecting it would
	 * not make work run — the daemon doesn't declare it, the project has it off, or
	 * both. A phase that is *already* permitted still reports its reason, since that
	 * is precisely the "why is nothing happening?" answer an operator needs.
	 */
	unavailable: string | null;
}

const UNDECLARED_REASON =
	"This machine's daemon does not declare this phase, so it never runs here.";
const PROJECT_DISABLED_REASON = 'The project has this phase turned off for every worker.';
const PLANNING_REQUIRES_INSTANCE_ADMIN_REASON =
	"Planning writes directly to the project board, so it can only be allowed on an instance admin's own worker.";

/**
 * One option per pipeline phase, in the pipeline's own order — never only the
 * selectable ones: a phase missing from the list would leave an operator unable to
 * tell "not offered here" from "does not exist", which is the distinction the
 * `unavailable` reason exists to draw.
 *
 * Takes the three phase sets as `readonly string[]` because the read models mirror
 * the phase vocabulary as plain strings (`types/workers.ts`); anything outside the
 * vocabulary simply never matches a phase. `ownerIsInstanceAdmin` is the fourth,
 * `planning`-only condition (server-enforced in `updateEnrollmentConstraints`,
 * independent of the daemon's self-declared `supportedPhases`): only an instance
 * admin's own worker may ever be allowed it.
 */
export function enrollmentPhaseOptions(input: {
	allowedPhases: readonly string[];
	supportedPhases: readonly string[];
	projectDisabledPhases: readonly string[];
	ownerIsInstanceAdmin: boolean;
}): EnrollmentPhaseOption[] {
	return ALL_TRIGGER_PHASES.map((phase) => {
		const reasons: string[] = [];
		if (!input.supportedPhases.includes(phase)) reasons.push(UNDECLARED_REASON);
		if (input.projectDisabledPhases.includes(phase)) reasons.push(PROJECT_DISABLED_REASON);
		if (phase === 'planning' && !input.ownerIsInstanceAdmin) {
			reasons.push(PLANNING_REQUIRES_INSTANCE_ADMIN_REASON);
		}
		return {
			phase,
			allowed: input.allowedPhases.includes(phase),
			unavailable: reasons.length > 0 ? reasons.join(' ') : null,
		};
	});
}
