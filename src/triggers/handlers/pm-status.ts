/**
 * PM board status-change trigger — SWARM's `pm:status-changed` equivalent
 * (ai/ARCHITECTURE.md "PM: GitHub Projects"), the analogue of Cascade's
 * per-list Trello/Linear status triggers. It's what starts the two PM-driven
 * pipeline phases: a card entering **Planning** starts Planning, a card
 * entering **In progress** starts Implementation (`src/pm/pipeline.ts`).
 *
 * Cascade ships a separate handler per board list because its webhook payload
 * carries the destination list, so each handler matches its own list directly.
 * SWARM can't: `docs/github-projects-v2-api.md` §5 warns the `projects_v2_item`
 * body doesn't carry a reliable new Status value, so the authoritative status
 * comes from a board re-read. Rather than register two handlers that each
 * re-read the same card (two GraphQL round-trips per event, one of them always
 * a wasted "not my phase" miss), this is **one** handler that re-reads once,
 * resolves which phase — if any — the card's Status starts, and dispatches it.
 *
 * Provider-agnostic throughout (issue #297): the board read goes through the
 * `PMProvider` the worker injected on the context (`ctx.pm`), the "is this worth
 * waking the pipeline for?" question goes to the project's `PMRouterAdapter`, and
 * the phase is resolved from the item's canonical `statusKey` — never from a board
 * option id (ai/RULES.md §2).
 *
 * Loop prevention (a persona's own board moves must not re-fire the trigger)
 * already happened router-side (`PMRouterAdapter.isSelfAuthored`), so it isn't
 * repeated here.
 */

import { requireProjectPMAdapter } from '../../integrations/pm/registry.js';
import { logger } from '../../lib/logger.js';
import { evaluatePreplan, isPreplanSkip, SPLIT_CHILD_LABEL } from '../../pipeline/preplan.js';
import { type PipelinePhase, resolvePipelinePhaseForStatusKey } from '../../pm/pipeline.js';
import type { WorkItem } from '../../pm/types.js';
import { recordStatusAndDetectChange } from '../pm-status-dedup.js';
import type { TriggerContext, TriggerHandler, TriggerResult } from '../types.js';
import { issueNumberFromUrl } from './shared.js';

/**
 * Check whether a split child entering Planning has already been planned outside of
 * dispatch. A marker alone is insufficient: removing the split-child label is an
 * operator signal to fall back to a normal Planning run.
 */
function shouldSkipPreplanned(
	phase: string | null,
	workItem: WorkItem,
	resumePmPhase?: string,
): boolean {
	if (phase !== 'planning' || resumePmPhase) return false;
	const preplan = evaluatePreplan(workItem);
	const isSplitChild = workItem.labels.some((label) => label.name === SPLIT_CHILD_LABEL);
	if (isSplitChild && isPreplanSkip(preplan)) {
		logger.info(
			'pm-status: item already preplanned outside of dispatch — skipping planning dispatch',
			{ itemId: workItem.id, splitId: preplan.contract.splitId },
		);
		return true;
	}
	return false;
}

/**
 * The pipeline phase a re-read item's status starts, or `undefined` for a status
 * that starts none. The provider already translated its opaque native status into
 * the canonical pipeline key on the way out of the board read, so this stays a
 * key→phase lookup and never touches a board option id (ai/RULES.md §2). An item
 * whose status maps to no canonical key carries none, which is the same
 * "not applicable" answer.
 */
function resolvePhaseForItem(workItem: WorkItem): PipelinePhase | undefined {
	return workItem.statusKey ? resolvePipelinePhaseForStatusKey(workItem.statusKey) : undefined;
}

/**
 * Build the PM status-change trigger handler.
 *
 * `matches` is a cheap synchronous shape gate (is this a state change on this
 * project's board?), delegated to the provider's own `isStatusChange` — the one
 * place that answers it, shared with the router's ingress filter. The
 * authoritative "which phase?" decision happens in `handle`, which re-reads the
 * item and returns `null` — the registry's "looked closer, not for me" — when the
 * card's status doesn't start a PM-driven phase.
 */
export function createPmStatusTrigger(): TriggerHandler {
	return {
		name: 'pm-status-changed',
		description: 'Starts Planning / Implementation when a board card enters that status',

		matches(ctx: TriggerContext): boolean {
			if (ctx.source !== 'pm') return false;
			// Deferred PM phases resume from the original event after the phase's
			// status report moved the card to In progress, so the normal status gate
			// must not discard the retry.
			if (ctx.resumePmPhase) return true;
			return requireProjectPMAdapter(ctx.project).isStatusChange(ctx.event, ctx.project);
		},

		async handle(ctx: TriggerContext): Promise<TriggerResult | null> {
			if (ctx.source !== 'pm') return null;
			const { event, pm } = ctx;

			// Authoritative re-read — never trust a status lifted from the webhook body
			// (docs/github-projects-v2-api.md §5 step 4).
			const workItem = await pm.getWorkItem(event.itemId);

			if (!workItem.statusId) {
				logger.debug('pm-status: item has no resolvable status — skipping', {
					itemId: event.itemId,
				});
				return null;
			}

			// Record the freshly re-read status as this item's latest observed status
			// and learn whether it *changed*. Done for every status — including ones
			// that start no phase (backlog, inProgress, …), before the phase gate below
			// — so that a departure to such a status is remembered: leaving "ToDo" and
			// dragging back later then reads as a genuine change rather than a
			// same-status no-op that gets silently skipped (`pm-status-dedup.ts`).
			const statusChanged = await recordStatusAndDetectChange(event.itemId, workItem.statusId);

			const phase = ctx.resumePmPhase ?? resolvePhaseForItem(workItem);
			if (!phase) {
				// A valid board status that simply doesn't start a phase (backlog, todo,
				// inReview, done) — a "not for me" miss, not an error.
				logger.debug('pm-status: status does not start a PM-driven phase — skipping', {
					itemId: event.itemId,
					statusId: workItem.statusId,
					statusKey: workItem.statusKey,
				});
				return null;
			}

			if (shouldSkipPreplanned(phase, workItem, ctx.resumePmPhase)) {
				return null;
			}

			// Second line of defense against the `moved` action's blind spot (see
			// `PMRouterAdapter.isStatusChange`): a pure within-column reorder re-reads
			// the same status every time, so this is the check that actually stops it
			// from re-dispatching the same phase over and over.
			if (!ctx.resumePmPhase && !statusChanged) {
				return null;
			}

			const taskId = issueNumberFromUrl(workItem.url);
			if (!taskId) {
				// No backing Issue number to key the worktree on — a draft item, or a
				// URL shape we don't recognize. Can't run a phase without it; drop
				// rather than throw (a draft card isn't a failed job).
				logger.warn('pm-status: could not resolve issue number from work item URL — skipping', {
					itemId: event.itemId,
					url: workItem.url,
					phase,
				});
				return null;
			}

			logger.debug('pm-status: dispatching pipeline phase', {
				itemId: event.itemId,
				taskId,
				phase,
				resumed: Boolean(ctx.resumePmPhase),
			});
			return { phase, taskId, workItem };
		},
	};
}
