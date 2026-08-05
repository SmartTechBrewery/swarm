/**
 * Re-enter Planning when a preplanned split child is invalidated while its card
 * already sits in Planning. Issue body/label changes do not produce a Projects
 * status event, so the normal PM status trigger cannot observe these changes.
 */

import type { ProjectConfig } from '../../config/schema.js';
import { requireProjectPMProvider } from '../../integrations/pm/registry.js';
import { logger } from '../../lib/logger.js';
import {
	evaluatePreplan,
	isPreplanSkip,
	REPLAN_LABEL,
	SPLIT_CHILD_LABEL,
} from '../../pipeline/preplan.js';
import type { PMProvider, WorkItem } from '../../pm/types.js';
import type { ScmEvent } from '../../scm/events.js';
import type { TriggerContext, TriggerHandler, TriggerResult } from '../types.js';

function isInvalidationEvent(event: ScmEvent): boolean {
	if (event.kind !== 'work-item') return false;
	if (event.action === 'edited') return event.workItemBodyChanged === true;
	if (event.action === 'labeled') return event.labelName === REPLAN_LABEL;
	return event.action === 'unlabeled' && event.labelName === SPLIT_CHILD_LABEL;
}

function shouldReplan(workItem: WorkItem, event: ScmEvent): boolean {
	const isSplitChild = workItem.labels.some((label) => label.name === SPLIT_CHILD_LABEL);
	const preplan = evaluatePreplan(workItem);
	if (isSplitChild && isPreplanSkip(preplan)) return false;

	// An authoritative split-child label proves body/replan invalidation. For
	// label removal, the webhook itself is the proof because the current item no
	// longer carries the label by definition.
	return isSplitChild || (event.action === 'unlabeled' && event.labelName === SPLIT_CHILD_LABEL);
}

export interface PreplanInvalidatedTriggerDeps {
	/**
	 * Injectable PM-provider factory; overridden by unit tests. This handler is
	 * SCM-sourced (`ctx.source === 'scm'`) yet needs a *PM* provider, so it can't
	 * take one off the trigger context the way `pm-status` does — it resolves the
	 * project's provider through the registry instead (ai/RULES.md §2).
	 */
	createProvider?: (project: ProjectConfig) => PMProvider;
}

export function createPreplanInvalidatedTrigger(
	deps: PreplanInvalidatedTriggerDeps = {},
): TriggerHandler {
	const createProvider = deps.createProvider ?? requireProjectPMProvider;

	return {
		name: 'preplan-invalidated',
		description: 'Restarts Planning when a preplanned child is explicitly invalidated',

		matches(ctx: TriggerContext): boolean {
			return ctx.source === 'scm' && isInvalidationEvent(ctx.event);
		},

		async handle(ctx: TriggerContext): Promise<TriggerResult | null> {
			if (ctx.source !== 'scm' || !isInvalidationEvent(ctx.event)) return null;
			const { event, project } = ctx;
			if (!event.workItemId || !event.workItemUrl) return null;

			const pm = createProvider(project);
			const planningItems = await pm.listWorkItems({ status: 'planning' });
			const workItem = planningItems.find((item) => item.url === event.workItemUrl);
			if (!workItem || !shouldReplan(workItem, event)) return null;

			logger.info('preplan-invalidated: dispatching fallback Planning', {
				itemId: workItem.id,
				taskId: event.workItemId,
				action: event.action,
				labelName: event.labelName,
			});
			return { phase: 'planning', taskId: event.workItemId, workItem };
		},
	};
}
