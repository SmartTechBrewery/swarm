/**
 * JiraRouterAdapter — the router-side handling of Jira's issue webhooks, the
 * third implementation of the provider-neutral `PMRouterAdapter` contract
 * (`src/pm/router-adapter.ts`) after `./github-projects.ts` and `./linear.ts`.
 *
 * Its job is the same five steps: parse the raw delivery into a provider-neutral
 * `PmEvent` (`src/pm/events.ts`), resolve which SWARM project owns the board,
 * filter to the transitions the pipeline reacts to, drop transitions SWARM itself
 * produced, and synthesize the state change the worker self-enqueues. Everything
 * Jira-specific stays here: the body's `webhookEvent` vocabulary, the payload
 * paths, and the fact that a Jira **project key** is the board container.
 *
 * Two differences from the other two adapters are worth naming, because they are
 * the ones that would otherwise get "unified" wrongly:
 *
 * - **The changed field comes from a changelog, not a diff of previous values.**
 *   Jira reports *what changed* in `changelog.items[]`, and it sends that block
 *   on every field edit — a summary, priority, or assignee change carries one
 *   too. So the gate below keys on an item whose field **is** `status`; keying on
 *   the presence of a `changelog` would fire the pipeline on every edit.
 * - **No drag-without-a-field-change case.** GitHub Projects needs a `reordered`
 *   → `moved` special case because a Board-view drag carries no changed field at
 *   all; dragging a Jira card between board columns executes a workflow
 *   transition, which is a `status` changelog entry like any other. So this
 *   adapter never produces a `moved` action either.
 *
 * Loop prevention keys on Jira's own actor — the Atlassian `accountId` of the
 * project's API token (`../../integrations/pm/jira/identity.ts`) — never a GitHub
 * persona: a Jira board paired with a GitHub repo shares no identity with the
 * source-control side (ai/RULES.md §2 "Loop prevention is a per-provider
 * obligation").
 */

import { findProjectByJiraProject } from '../../config/provider.js';
import type { ProjectConfig } from '../../config/schema.js';
import { requireJiraConfig } from '../../integrations/pm/jira/config-schema.js';
import { resolveJiraAccountId } from '../../integrations/pm/jira/identity.js';
import { logger } from '../../lib/logger.js';
import type { PmEvent, PmEventAction } from '../../pm/events.js';
import type { PMRouterAdapter } from '../../pm/router-adapter.js';

/**
 * The prefix Jira gives every issue-scoped `webhookEvent`. It is the "is this
 * mine?" test: a comment, worklog, sprint, or project delivery parses to `null`,
 * since SWARM has no trigger for any of them and the board's own state is what
 * wakes the pipeline.
 */
const ISSUE_EVENT_PREFIX = 'jira:issue_';

/**
 * Jira's issue event names → the neutral {@link PmEventAction} vocabulary. An
 * issue event absent here (a site emitting an older, finer-grained name) rides
 * through verbatim and matches no trigger, per `PmEvent`'s contract.
 */
const NEUTRAL_ACTION_BY_JIRA_EVENT: Readonly<Record<string, PmEventAction>> = {
	'jira:issue_created': 'created',
	'jira:issue_updated': 'updated',
	'jira:issue_deleted': 'deleted',
};

/**
 * The changelog field naming an issue's workflow status. This is the whole of
 * SWARM's state-change detection on Jira: an `update` whose changelog carries
 * this field moved the card, and an update that doesn't was some other field edit
 * (summary, priority, assignee, …).
 *
 * Opaque to shared code, exactly like a GitHub Projects Status field node id —
 * only this adapter compares `PmEvent.changedField` against it.
 */
const STATUS_FIELD = 'status';

/**
 * Provider-native type of {@link STATUS_FIELD}, carried for tracing only. It
 * coincides with the field name because Jira's status *is* a system field named
 * for its own type; they stay two constants so the tracing value can change
 * without moving the gate.
 */
const STATUS_FIELD_TYPE = 'status';

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

/**
 * Whether this delivery's changelog reports a workflow-status change. Jira names
 * the changed field twice per entry — `field` is the display name and `fieldId`
 * the stable id — and only the latter is present on every entry shape, so both
 * are accepted.
 */
function changelogTouchesStatus(payload: Record<string, unknown>): boolean {
	const items = asRecord(payload.changelog)?.items;
	if (!Array.isArray(items)) return false;
	return items.some((item) => {
		const entry = asRecord(item);
		return entry?.fieldId === STATUS_FIELD || entry?.field === STATUS_FIELD;
	});
}

export class JiraRouterAdapter implements PMRouterAdapter {
	readonly type = 'jira' as const;

	/**
	 * Normalize a Jira issue delivery into a `PmEvent`. `eventName` is unused —
	 * Jira serves its own route, so the receiver hands this adapter
	 * `OWN_ROUTE_EVENT_NAME` (`''`, `src/router/webhook-receiver.ts`) and the event
	 * name comes from the body's `webhookEvent`. Returns `null` for any non-issue
	 * event, and for an issue payload missing the issue key or the project key
	 * (nothing is actionable without both).
	 */
	parseWebhook(_eventName: string, payload: unknown): PmEvent | null {
		const p = asRecord(payload) ?? {};
		const webhookEvent = asString(p.webhookEvent);
		if (!webhookEvent?.startsWith(ISSUE_EVENT_PREFIX)) return null;

		const issue = asRecord(p.issue);
		const fields = asRecord(issue?.fields);
		// The issue *key* (`SWARM-12`), not the numeric id: it is what every board
		// read is addressed by and what a human sees on the card.
		const itemId = asString(issue?.key);
		const containerId = asString(asRecord(fields?.project)?.key);
		if (!itemId || !containerId) return null;

		const statusChanged = changelogTouchesStatus(p);

		return {
			itemId,
			containerId,
			action: NEUTRAL_ACTION_BY_JIRA_EVENT[webhookEvent] ?? webhookEvent,
			changedField: statusChanged ? STATUS_FIELD : undefined,
			changedFieldType: statusChanged ? STATUS_FIELD_TYPE : undefined,
			// Display-only (`PmEvent.contentType`): a Jira card *is* the issue, so
			// there is no separate backing artifact to carry a `contentId` for.
			contentType: asString(asRecord(fields?.issuetype)?.name),
			// Jira's stable actor id, not a display name or email: the neutral field is
			// named for a handle but is opaque to shared code, and an `accountId` is
			// what loop prevention below compares (a name is rename-prone and an email
			// is hidden by the account's own privacy settings).
			actorHandle: asString(asRecord(p.user)?.accountId),
		};
	}

	/** Resolve the SWARM project that owns the event's Jira project, or `null` if untracked. */
	async resolveProject(event: PmEvent): Promise<ProjectConfig | null> {
		return (await findProjectByJiraProject(event.containerId)) ?? null;
	}

	/**
	 * Whether this event is a transition the pipeline reacts to: an issue created
	 * in the project (`created`), or a workflow-status change (`updated` + a
	 * `status` entry in the changelog). Every other field edit is dropped here.
	 *
	 * No drag special case, unlike GitHub Projects — see this module's header. It
	 * deliberately does not assert *which* status the issue moved to either: that
	 * comes from the authoritative re-read downstream
	 * (`src/triggers/handlers/pm-status.ts`).
	 *
	 * Takes no board mapping, so `project` is unused: a changelog entry names the
	 * status field structurally, where GitHub Projects has to compare against the
	 * project's configured Status field id.
	 */
	isStatusChange(event: PmEvent, _project: ProjectConfig): boolean {
		if (event.action === 'created') return true;
		return event.action === 'updated' && event.changedField === STATUS_FIELD;
	}

	/**
	 * Loop prevention: whether SWARM itself produced this board change — the worker
	 * transitioning an issue to "In progress" as it starts implementation would
	 * otherwise re-fire the very trigger that started it (ai/CODING_STANDARDS.md
	 * "Loop prevention").
	 *
	 * Keyed on the Atlassian `accountId` of the provider's **own** API token
	 * (`resolveJiraAccountId`), which is the account every SWARM board write is made
	 * by — never a GitHub persona, which a Jira board has no relationship to at all.
	 *
	 * Fails **open** on any identity-resolution failure: log and return `false`, so
	 * a missing credential or a Jira outage can never silently drop a real human
	 * status change as "ours". The authoritative downstream re-read plus
	 * `pm-status-dedup.ts` bound the cost of the opposite mistake; if this proves
	 * too loose, the fix is a bounded retry here, not flipping to fail-closed.
	 */
	async isSelfAuthored(event: PmEvent, project: ProjectConfig): Promise<boolean> {
		if (!event.actorHandle) return false;
		try {
			return event.actorHandle === (await resolveJiraAccountId(project));
		} catch (err) {
			logger.error('Failed to resolve Jira board identity; skipping loop-prevention check', {
				projectId: project.id,
				containerId: event.containerId,
				error: String(err),
			});
			return false;
		}
	}

	/**
	 * The synthetic status change the worker self-enqueues after a phase's
	 * `autoAdvance` moves a card (`selfEnqueueNextPhase`, `src/worker/consumer.ts`):
	 * Jira's own delivery for that transition is authored by this project's API
	 * token and therefore always dropped by {@link isSelfAuthored}, so the next
	 * phase would otherwise never start.
	 *
	 * Shaped to satisfy {@link isStatusChange} for this project — the project key is
	 * exactly the provider knowledge the worker must not hold.
	 */
	synthesizeStateChange(project: ProjectConfig, itemId: string): PmEvent {
		return {
			itemId,
			containerId: requireJiraConfig(project).projectKey,
			action: 'updated',
			changedField: STATUS_FIELD,
			changedFieldType: STATUS_FIELD_TYPE,
		};
	}
}
