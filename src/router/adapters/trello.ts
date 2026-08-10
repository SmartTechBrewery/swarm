/**
 * TrelloRouterAdapter — the router-side handling of Trello's board webhooks, the
 * fourth implementation of the provider-neutral `PMRouterAdapter` contract
 * (`src/pm/router-adapter.ts`) after `./github-projects.ts`, `./linear.ts`, and
 * `./jira.ts`.
 *
 * Its job is the same five steps: parse the raw delivery into a provider-neutral
 * `PmEvent` (`src/pm/events.ts`), resolve which SWARM project owns the board,
 * filter to the transitions the pipeline reacts to, drop transitions SWARM itself
 * produced, and synthesize the state change the worker self-enqueues. Everything
 * Trello-specific stays here: the body's `action.type` vocabulary, the payload
 * paths, and the fact that a **board** is Trello's container and a **list** is the
 * card's status.
 *
 * Two differences from the other three adapters are worth naming, because they are
 * the ones that would otherwise get "unified" wrongly:
 *
 * - **A card's status is which list it sits in, so a status change is a *move*,
 *   not a field edit.** Trello delivers one `updateCard` action for every edit a
 *   card receives — a rename, a description edit, a due date, an archive — and
 *   marks the one that changed column by carrying `data.listAfter` (with
 *   `listBefore` beside it). That marker, and nothing else, is what sets
 *   {@link LIST_FIELD} below; keying on `updateCard` alone would fire
 *   `pm-status-changed` on every card edit.
 * - **No drag special case, for the opposite reason to GitHub Projects'.** A
 *   Board-view drag there carries no changed field at all; on Trello a drag *is*
 *   the `listAfter` action above — dragging is the only way a card changes list —
 *   so this adapter never produces a `moved` action either.
 *
 * Loop prevention keys on Trello's own member id, resolved from the project's
 * token (`../../integrations/pm/trello/identity.ts`) — never a GitHub persona: a
 * Trello board paired with a GitHub repo shares no identity with the source-control
 * side (ai/RULES.md §2 "Loop prevention is a per-provider obligation").
 */

import { findProjectByTrelloBoard } from '../../config/provider.js';
import type { ProjectConfig } from '../../config/schema.js';
import { requireTrelloConfig } from '../../integrations/pm/trello/config-schema.js';
import { resolveTrelloMemberId } from '../../integrations/pm/trello/identity.js';
import { logger } from '../../lib/logger.js';
import type { PmEvent, PmEventAction } from '../../pm/events.js';
import type { PMRouterAdapter } from '../../pm/router-adapter.js';

/**
 * Trello's card action types → the neutral {@link PmEventAction} vocabulary. An
 * action absent here — `commentCard`, `addLabelToCard`, `updateBoard`, … — rides
 * through verbatim and matches no trigger, per `PmEvent`'s contract.
 */
const NEUTRAL_ACTION_BY_TRELLO_ACTION: Readonly<Record<string, PmEventAction>> = {
	createCard: 'created',
	updateCard: 'updated',
	deleteCard: 'deleted',
};

/**
 * The card attribute naming its list — Trello's status field, in the only form it
 * has one. `PUT /cards/{id}` takes it as `idList`
 * (`src/integrations/pm/trello/provider.ts`), which is why the neutral event
 * carries that spelling.
 *
 * Opaque to shared code, exactly like a GitHub Projects Status field node id —
 * only this adapter compares `PmEvent.changedField` against it.
 */
const LIST_FIELD = 'idList';

/** Provider-native type of {@link LIST_FIELD}, carried for tracing only. */
const LIST_FIELD_TYPE = 'list';

/**
 * Display-only descriptor of the item this adapter acts on
 * (`PmEvent.contentType`): a Trello card *is* the work item, so there is no
 * separate backing artifact to carry a `contentId` for.
 */
const CARD_CONTENT_TYPE = 'Card';

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

export class TrelloRouterAdapter implements PMRouterAdapter {
	readonly type = 'trello' as const;

	/**
	 * Normalize a Trello action delivery into a `PmEvent`. `eventName` is unused —
	 * Trello serves its own route, so the receiver hands this adapter
	 * `OWN_ROUTE_EVENT_NAME` (`''`, `src/router/webhook-receiver.ts`) and the action
	 * name comes from the body's `action.type`. Returns `null` for a delivery
	 * carrying no card id or no board id (nothing is actionable without both), which
	 * is also the "not my event" answer if this adapter ever shares a route.
	 */
	parseWebhook(_eventName: string, payload: unknown): PmEvent | null {
		const p = asRecord(payload) ?? {};
		const action = asRecord(p.action);
		const data = asRecord(action?.data);

		const itemId = asString(asRecord(data?.card)?.id);
		// Trello names the board on the action for a card event and, for a
		// board-scoped one, only on the webhook's own `model` — read both, as
		// Cascade's `extractTrelloBoardId` does.
		const containerId = asString(asRecord(data?.board)?.id) ?? asString(asRecord(p.model)?.id);
		if (!itemId || !containerId) return null;

		const trelloAction = asString(action?.type);
		// `listAfter` is Trello's own "this card changed column" marker — see this
		// module's header for why nothing else may stand in for it.
		const listChanged = asRecord(data?.listAfter) !== undefined;

		return {
			itemId,
			containerId,
			action: trelloAction
				? (NEUTRAL_ACTION_BY_TRELLO_ACTION[trelloAction] ?? trelloAction)
				: undefined,
			changedField: listChanged ? LIST_FIELD : undefined,
			changedFieldType: listChanged ? LIST_FIELD_TYPE : undefined,
			contentType: CARD_CONTENT_TYPE,
			// Trello's stable member id, not a username: the neutral field is named for
			// a handle but is opaque to shared code, and an id is what loop prevention
			// below compares (a username is rename-prone).
			actorHandle: asString(action?.idMemberCreator),
		};
	}

	/** Resolve the SWARM project that owns the event's board, or `null` if untracked. */
	async resolveProject(event: PmEvent): Promise<ProjectConfig | null> {
		return (await findProjectByTrelloBoard(event.containerId)) ?? null;
	}

	/**
	 * Whether this event is a transition the pipeline reacts to: a card added to the
	 * board (`created`), or a card moved between lists (`updated` + the delivery
	 * carried `listAfter`). Every other card edit is dropped here.
	 *
	 * It deliberately does not assert *which* list the card moved to: that comes
	 * from the authoritative re-read downstream
	 * (`src/triggers/handlers/pm-status.ts`).
	 *
	 * Takes no board mapping, so `project` is unused: `listAfter` names the move
	 * structurally, where GitHub Projects has to compare against the project's
	 * configured Status field id.
	 */
	isStatusChange(event: PmEvent, _project: ProjectConfig): boolean {
		if (event.action === 'created') return true;
		return event.action === 'updated' && event.changedField === LIST_FIELD;
	}

	/**
	 * Loop prevention: whether SWARM itself produced this board change — the worker
	 * moving a card to the "In progress" list as it starts implementation would
	 * otherwise re-fire the very trigger that started it (ai/CODING_STANDARDS.md
	 * "Loop prevention").
	 *
	 * Keyed on the member id of the provider's **own** token
	 * (`resolveTrelloMemberId`), which is the member every SWARM board write is
	 * attributed to — never a GitHub persona, which a Trello board has no
	 * relationship to at all.
	 *
	 * Fails **open** on any identity-resolution failure: log and return `false`, so
	 * a missing credential or a Trello outage can never silently drop a real human
	 * card move as "ours". The authoritative downstream re-read plus
	 * `pm-status-dedup.ts` bound the cost of the opposite mistake; if this proves
	 * too loose, the fix is a bounded retry here, not flipping to fail-closed.
	 */
	async isSelfAuthored(event: PmEvent, project: ProjectConfig): Promise<boolean> {
		if (!event.actorHandle) return false;
		try {
			return event.actorHandle === (await resolveTrelloMemberId(project));
		} catch (err) {
			logger.error('Failed to resolve Trello board identity; skipping loop-prevention check', {
				projectId: project.id,
				containerId: event.containerId,
				error: String(err),
			});
			return false;
		}
	}

	/**
	 * The synthetic list change the worker self-enqueues after a phase's
	 * `autoAdvance` moves a card (`selfEnqueueNextPhase`, `src/worker/consumer.ts`):
	 * Trello's own delivery for that move is authored by this project's token and
	 * therefore always dropped by {@link isSelfAuthored}, so the next phase would
	 * otherwise never start.
	 *
	 * Shaped to satisfy {@link isStatusChange} for this project — the board id is
	 * exactly the provider knowledge the worker must not hold.
	 */
	synthesizeStateChange(project: ProjectConfig, itemId: string): PmEvent {
		return {
			itemId,
			containerId: requireTrelloConfig(project).boardId,
			action: 'updated',
			changedField: LIST_FIELD,
			changedFieldType: LIST_FIELD_TYPE,
		};
	}
}
