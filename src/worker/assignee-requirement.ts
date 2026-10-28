/**
 * The per-project **assignee requirement** (`pipeline.requireAssignee`, issue
 * #1165): with it on, SWARM starts no phase for a work item unless the item has
 * an assignee that maps to a SWARM user — so on a team where every developer
 * owns their own workers, nobody's ticket lands on somebody else's machine by
 * way of ADR-001's unassigned path.
 *
 * The policy lives here, beside the eligibility gate, rather than in
 * `src/identity/assignee-resolver.ts`: that seam deliberately "decides nothing
 * about routing", and refusing an item for having no linked assignee is a
 * routing decision. Provider-agnostic (ai/RULES.md §2): it reads only
 * `WorkItem.assignees` and the provider's `type` / `supportsAssignees`, and
 * never branches on which provider it is.
 */

import type { PipelineConfig } from '../config/schema.js';
import { resolveAssignedUser } from '../identity/assignee-resolver.js';
import type { PMProvider, WorkItem } from '../pm/types.js';

/**
 * Whether the project requires a linked assignee. Unset defaults to `false` here
 * rather than with `z.default()` because `pipeline` itself is optional — the
 * same reason `resolveAutomationLabel` applies its own default.
 */
export function resolveRequireAssignee(pipeline: PipelineConfig | undefined): boolean {
	return pipeline?.requireAssignee === true;
}

/** Why an item fails the requirement — each names a different thing to fix. */
export type AssigneeRequirementCause = 'assignees-unsupported' | 'unassigned' | 'unlinked';

export type AssigneeRequirementVerdict =
	| { satisfied: true }
	| { satisfied: false; cause: AssigneeRequirementCause; message: string };

const SETTING = '`pipeline.requireAssignee`';
const RETRIGGER = 'then move the card again to re-trigger it.';

/**
 * Judges `workItem` against the requirement. Only the identity-link read can
 * throw; the caller decides what a failed read means.
 *
 * A provider that does not model assignees can never satisfy the setting, so
 * that is reported first and names the provider — the setting, not the item, is
 * what the operator has to change.
 */
export async function checkAssigneeRequirement(
	workItem: Pick<WorkItem, 'assignees'>,
	pm: Pick<PMProvider, 'type' | 'supportsAssignees'>,
): Promise<AssigneeRequirementVerdict> {
	if (!pm.supportsAssignees) {
		return {
			satisfied: false,
			cause: 'assignees-unsupported',
			message: `Skipped: this project requires an assignee (${SETTING}), but its PM provider '${pm.type}' does not model assignees, so no item can satisfy it. Turn ${SETTING} off for this project.`,
		};
	}
	if (workItem.assignees.length === 0) {
		return {
			satisfied: false,
			cause: 'unassigned',
			message: `Skipped: this project requires every work item to have an assignee linked to a SWARM user (${SETTING}), and this item has no assignee. Assign it, ${RETRIGGER}`,
		};
	}
	if (await resolveAssignedUser(workItem, pm.type)) return { satisfied: true };
	const handles = workItem.assignees.map((a) => `'${a.handle}'`);
	const subject =
		handles.length === 1
			? `the item's assignee ${handles[0]} is`
			: `the item's assignees ${handles.join(', ')} are`;
	return {
		satisfied: false,
		cause: 'unlinked',
		message: `Skipped: this project requires every work item to have an assignee linked to a SWARM user (${SETTING}), and ${subject} not linked to a SWARM user. Link it with \`swarm identities link --user <identifier> --provider ${pm.type} --handle ${workItem.assignees[0]?.handle}\`, ${RETRIGGER}`,
	};
}
