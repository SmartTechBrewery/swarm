/**
 * LinearRouterAdapter — the router-side handling of Linear's board webhooks, the
 * second implementation of the provider-neutral `PMRouterAdapter` contract
 * (`src/pm/router-adapter.ts`) after `./github-projects.ts`.
 *
 * Its job is the same five steps: parse the raw delivery into a provider-neutral
 * `PmEvent` (`src/pm/events.ts`), resolve which SWARM project owns the board,
 * filter to the transitions the pipeline reacts to, drop transitions SWARM itself
 * produced, and synthesize the state change the worker self-enqueues. Everything
 * Linear-specific stays here: the body's `type`/`action` vocabulary, the payload
 * paths, and the fact that a **team** is Linear's board container.
 *
 * Two differences from the GitHub Projects adapter are worth naming, because they
 * are the ones that would otherwise get "unified" wrongly:
 *
 * - **The event name comes from the body, not a header.** Linear names the entity
 *   in `type` and the verb in `action`, so the receiver's `eventName` argument is
 *   unused — it hands `''` to a provider serving its own route
 *   (`OWN_ROUTE_EVENT_NAME`, `src/router/webhook-receiver.ts`). Returning `null`
 *   for a non-`Issue` body is therefore both "not actionable" and the "not my
 *   event" answer if this adapter ever shares a route.
 * - **A column drag *is* a field edit.** GitHub Projects needs a `reordered` →
 *   `moved` special case because a Board-view drag carries no changed field at
 *   all; Linear has no such analogue — moving a card between columns updates the
 *   issue's workflow state and the delivery carries `updatedFrom.stateId` like any
 *   other state edit. So this gate needs no drag case, and by the same token no
 *   `moved` action is ever produced.
 *
 * Loop prevention keys on Linear's own actor id, resolved from the project's API
 * key (`../../integrations/pm/linear/identity.ts`) — never a GitHub persona: a
 * Linear board paired with a GitHub repo shares no identity with the source-control
 * side (ai/RULES.md §2 "Loop prevention is a per-provider obligation").
 */

import { findProjectByLinearTeam } from '../../config/provider.js';
import type { ProjectConfig } from '../../config/schema.js';
import { requireLinearConfig } from '../../integrations/pm/linear/config-schema.js';
import { resolveLinearActorId } from '../../integrations/pm/linear/identity.js';
import { logger } from '../../lib/logger.js';
import type { PmEvent, PmEventAction } from '../../pm/events.js';
import type { PMRouterAdapter } from '../../pm/router-adapter.js';

/**
 * The one Linear entity SWARM acts on. `Comment` and `IssueLabel` deliveries parse
 * to `null`: SWARM has no trigger for either, and the board's own state is what
 * wakes the pipeline.
 */
const ISSUE_ENTITY_TYPE = 'Issue';

/**
 * Linear's data-change action names → the neutral {@link PmEventAction}
 * vocabulary. An action absent here rides through verbatim and matches no
 * trigger, per `PmEvent`'s contract.
 */
const NEUTRAL_ACTION_BY_LINEAR_ACTION: Readonly<Record<string, PmEventAction>> = {
	create: 'created',
	update: 'updated',
	remove: 'deleted',
};

/**
 * The issue field naming Linear's workflow state, and the key `updatedFrom`
 * carries when that state changed. This is the whole of SWARM's state-change
 * detection on Linear: an `update` whose `updatedFrom` names it moved columns, and
 * an `update` that doesn't was some other field edit (priority, estimate,
 * assignee, …).
 *
 * Opaque to shared code, exactly like a GitHub Projects Status field node id —
 * only this adapter compares `PmEvent.changedField` against it.
 */
const WORKFLOW_STATE_FIELD = 'stateId';

/** Provider-native type of {@link WORKFLOW_STATE_FIELD}, carried for tracing only. */
const WORKFLOW_STATE_FIELD_TYPE = 'workflowState';

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

export class LinearRouterAdapter implements PMRouterAdapter {
	readonly type = 'linear' as const;

	/**
	 * Normalize a Linear data-change delivery into a `PmEvent`. `eventName` is
	 * unused — see this module's header — so the entity comes from the body's
	 * `type`. Returns `null` for any other entity, and for an `Issue` payload
	 * missing the issue id or the team id (nothing is actionable without both).
	 */
	parseWebhook(_eventName: string, payload: unknown): PmEvent | null {
		const p = asRecord(payload) ?? {};
		if (p.type !== ISSUE_ENTITY_TYPE) return null;

		const data = asRecord(p.data);
		const itemId = data?.id as string | undefined;
		// Linear serializes the team both ways depending on the entity's shape; the
		// scalar is the documented one, the nested object is the fallback.
		const containerId =
			(data?.teamId as string) || ((asRecord(data?.team)?.id as string) ?? undefined);
		if (!itemId || !containerId) return null;

		const linearAction = p.action as string | undefined;
		const stateChanged = WORKFLOW_STATE_FIELD in (asRecord(p.updatedFrom) ?? {});

		return {
			itemId,
			containerId,
			action: linearAction
				? (NEUTRAL_ACTION_BY_LINEAR_ACTION[linearAction] ?? linearAction)
				: undefined,
			changedField: stateChanged ? WORKFLOW_STATE_FIELD : undefined,
			changedFieldType: stateChanged ? WORKFLOW_STATE_FIELD_TYPE : undefined,
			// Display-only (`PmEvent.contentType`): a Linear card *is* the issue, so
			// there is no separate backing artifact to carry a `contentId` for.
			contentType: ISSUE_ENTITY_TYPE,
			// Linear's stable actor id, not a handle: the neutral field is named for a
			// handle but is opaque to shared code, and an id is what loop prevention
			// below compares (a name or email would be rename-prone).
			actorHandle: (asRecord(p.actor)?.id as string) ?? undefined,
		};
	}

	/** Resolve the SWARM project that owns the event's team, or `null` if untracked. */
	async resolveProject(event: PmEvent): Promise<ProjectConfig | null> {
		return (await findProjectByLinearTeam(event.containerId)) ?? null;
	}

	/**
	 * Whether this event is a transition the pipeline reacts to: an issue added to
	 * the team (`created`), or a workflow-state change (`updated` + `updatedFrom`
	 * carried `stateId`). Every other field edit is dropped here.
	 *
	 * No drag special case, unlike GitHub Projects — see this module's header. It
	 * deliberately does not assert *which* state the issue moved to either: that
	 * comes from the authoritative re-read downstream
	 * (`src/triggers/handlers/pm-status.ts`).
	 *
	 * Takes no board mapping, so `project` is unused: `updatedFrom.stateId` names
	 * the state field structurally, where GitHub Projects has to compare against the
	 * project's configured Status field id.
	 */
	isStatusChange(event: PmEvent, _project: ProjectConfig): boolean {
		if (event.action === 'created') return true;
		return event.action === 'updated' && event.changedField === WORKFLOW_STATE_FIELD;
	}

	/**
	 * Loop prevention: whether SWARM itself produced this board change — the worker
	 * moving a card to "In progress" as it starts implementation would otherwise
	 * re-fire the very trigger that started it (ai/CODING_STANDARDS.md "Loop
	 * prevention").
	 *
	 * Keyed on the identity of the provider's **own** API key
	 * (`resolveLinearActorId`), which is the account every SWARM board write is made
	 * by — never a GitHub persona, which a Linear board has no relationship to at
	 * all.
	 *
	 * Fails **open** on any identity-resolution failure: log and return `false`, so
	 * a missing credential or a Linear outage can never silently drop a real human
	 * state change as "ours". The authoritative downstream re-read plus
	 * `pm-status-dedup.ts` bound the cost of the opposite mistake; if this proves too
	 * loose, the fix is a bounded retry here, not flipping to fail-closed.
	 */
	async isSelfAuthored(event: PmEvent, project: ProjectConfig): Promise<boolean> {
		if (!event.actorHandle) return false;
		try {
			return event.actorHandle === (await resolveLinearActorId(project));
		} catch (err) {
			logger.error('Failed to resolve Linear board identity; skipping loop-prevention check', {
				projectId: project.id,
				containerId: event.containerId,
				error: String(err),
			});
			return false;
		}
	}

	/**
	 * The synthetic workflow-state change the worker self-enqueues after a phase's
	 * `autoAdvance` moves a card (`selfEnqueueNextPhase`, `src/worker/consumer.ts`):
	 * Linear's own delivery for that move is authored by this project's API key and
	 * therefore always dropped by {@link isSelfAuthored}, so the next phase would
	 * otherwise never start.
	 *
	 * Shaped to satisfy {@link isStatusChange} for this project — the team id is
	 * exactly the provider knowledge the worker must not hold.
	 */
	synthesizeStateChange(project: ProjectConfig, itemId: string): PmEvent {
		return {
			itemId,
			containerId: requireLinearConfig(project).teamId,
			action: 'updated',
			changedField: WORKFLOW_STATE_FIELD,
			changedFieldType: WORKFLOW_STATE_FIELD_TYPE,
		};
	}
}
