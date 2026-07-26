/**
 * GitHubProjectsRouterAdapter — the router-side handling of the
 * `projects_v2_item` webhook, the PM-board analogue of the SCM webhook parser
 * (`src/integrations/scm/github/webhook.ts`). This is SWARM's `pm:status-changed`
 * trigger ingress (ai/ARCHITECTURE.md "PM: GitHub Projects").
 *
 * Its job: parse the raw webhook into a normalized event, resolve which SWARM
 * project owns the *board* (by `project_node_id` — a Projects event carries no
 * repo, unlike SCM ingress which resolves by `owner/repo`), filter to the
 * transitions the pipeline reacts to (a Status-field edit, or a card added to
 * the board), and drop transitions a SWARM persona itself produced (loop
 * prevention). The authoritative "which Status option is it now?" re-read and
 * the option → pipeline-phase dispatch live downstream (the GraphQL client /
 * worker, separate Phase-2 issues) — this adapter is the doorbell, per
 * docs/github-projects-v2-api.md §5: it never trusts a Status value lifted from
 * the webhook body.
 */

import { z } from 'zod';
import { findProjectByBoard } from '../../config/provider.js';
import type { ProjectConfig } from '../../config/schema.js';
import { isSwarmBot, resolvePersonaIdentities } from '../../integrations/scm/github/personas.js';
import { logger } from '../../lib/logger.js';

/** The GitHub webhook event type carrying Projects (v2) board changes. */
export const PROJECTS_V2_ITEM_EVENT = 'projects_v2_item';

/**
 * The `projects_v2_item` actions the pipeline reacts to: a field value changed
 * (Status among them), a card was added to the board
 * (docs/github-projects-v2-api.md §5 → Actions), or a card was dragged to a
 * different column in the Board view. That last one is `reordered`, not
 * `edited`: confirmed against a real delivery that a cross-column Board-view
 * drag carries no `changes.field_value` at all (only
 * `previous_projects_v2_item_node_id`), so `edited` alone misses the exact
 * interaction a Kanban board's drag-and-drop is built around. `docs/github-
 * projects-v2-api.md`'s "cares almost entirely about edited" note predates
 * this finding.
 */
const TRIGGERING_ACTIONS = new Set(['edited', 'created', 'reordered']);

/**
 * A raw `projects_v2_item` webhook parsed into the fields the router needs. A
 * Zod schema (not a hand-written interface) because the parsed event rides
 * inside a queue job across the router→Redis→worker boundary
 * (`src/queue/jobs.ts`) — same rationale as the SCM side's `ScmEventSchema`.
 */
export const GitHubProjectsParsedEventSchema = z.object({
	eventType: z.literal(PROJECTS_V2_ITEM_EVENT),
	/** The webhook `action` (`edited`, `created`, `deleted`, …), if present. */
	action: z.string().optional(),
	/** The Projects v2 item (card) node ID — used to re-read the item downstream. */
	itemNodeId: z.string(),
	/** The board (ProjectV2) node ID — how the SWARM project is resolved. */
	projectNodeId: z.string(),
	/** The backing Issue/PR node ID the card wraps, if present. */
	contentNodeId: z.string().optional(),
	/** `Issue` | `PullRequest` | `DraftIssue`, if present. */
	contentType: z.string().optional(),
	/** On an `edited` event, the node ID of the field that changed. */
	changedFieldNodeId: z.string().optional(),
	/** On an `edited` event, the changed field's type (e.g. `single_select`). */
	changedFieldType: z.string().optional(),
	/** Login of the account that produced the event (`sender.login`). */
	actorLogin: z.string().optional(),
});

export type GitHubProjectsParsedEvent = z.infer<typeof GitHubProjectsParsedEventSchema>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

export class GitHubProjectsRouterAdapter {
	readonly type = 'github-projects' as const;

	/**
	 * Normalize a raw webhook body into a `GitHubProjectsParsedEvent`. `eventType`
	 * comes from the `X-GitHub-Event` header, not the body. Returns `null` for any
	 * other event type, and for a `projects_v2_item` payload missing the item or
	 * board node ID (nothing actionable without both), so the caller can drop it
	 * without branching.
	 */
	parseWebhook(eventType: string, payload: unknown): GitHubProjectsParsedEvent | null {
		if (eventType !== PROJECTS_V2_ITEM_EVENT) return null;

		const p = asRecord(payload) ?? {};
		const item = asRecord(p.projects_v2_item);
		const itemNodeId = item?.node_id as string | undefined;
		const projectNodeId = item?.project_node_id as string | undefined;
		if (!itemNodeId || !projectNodeId) return null;

		const fieldValue = asRecord(asRecord(p.changes)?.field_value);

		return {
			eventType: PROJECTS_V2_ITEM_EVENT,
			action: (p.action as string) ?? undefined,
			itemNodeId,
			projectNodeId,
			contentNodeId: (item?.content_node_id as string) ?? undefined,
			contentType: (item?.content_type as string) ?? undefined,
			changedFieldNodeId: (fieldValue?.field_node_id as string) ?? undefined,
			changedFieldType: (fieldValue?.field_type as string) ?? undefined,
			actorLogin: (asRecord(p.sender)?.login as string) ?? undefined,
		};
	}

	/** Resolve the SWARM project that owns the event's board, or `null` if untracked. */
	async resolveProject(event: GitHubProjectsParsedEvent): Promise<ProjectConfig | null> {
		return (await findProjectByBoard(event.projectNodeId)) ?? null;
	}

	/**
	 * Whether this event is a transition the pipeline reacts to: a card added to
	 * the board (`created`), a card dragged to a different Board-view column
	 * (`reordered` — see the `TRIGGERING_ACTIONS` comment above for why this
	 * can't be filtered by field like `edited` can), or an edit to the project's
	 * **Status** field specifically (`edited` + the changed field is
	 * `statusFieldId`). Any other field edit (Priority, Size, assignees, …) is
	 * dropped here — matching the `pm:status-changed` filter in
	 * docs/github-projects-v2-api.md §5 step 2.
	 *
	 * It deliberately does **not** assert *which* Status option the card moved to:
	 * the webhook body doesn't carry a reliable new value, so that comes from the
	 * authoritative re-read downstream. This gate answers "is this worth waking
	 * the pipeline for?", not "which phase?". Because `reordered` also fires on a
	 * pure within-column reorder with no Status change at all, this gate alone
	 * can't rule that case out — `pm-status-dedup.ts` is the second line of
	 * defense that stops a harmless reorder from re-dispatching a phase.
	 */
	isStatusChange(event: GitHubProjectsParsedEvent, project: ProjectConfig): boolean {
		if (!event.action || !TRIGGERING_ACTIONS.has(event.action)) return false;
		if (event.action === 'created' || event.action === 'reordered') return true;
		return event.changedFieldNodeId === project.githubProjects.statusFieldId;
	}

	/**
	 * Loop prevention: whether a SWARM persona itself produced this board change —
	 * e.g. the worker moving a card to "In progress" as it starts implementation
	 * would otherwise re-fire the very trigger that started it. *Every* self-authored
	 * Projects status change must be dropped, since a persona moving a card is
	 * exactly the feedback loop to break (ai/CODING_STANDARDS.md "Loop prevention").
	 *
	 * This is the one gate still keyed on a persona login, deliberately (issue
	 * #443): a status change carries no body to inspect, so the SCM side's
	 * marker-based test (`isSwarmGeneratedBody`) has nothing to read here. It
	 * therefore keeps the identity resolution — and its failure mode — that the SCM
	 * comment gate shed. On any identity-resolution failure this returns `false` but
	 * logs it, failing *open* (enqueue) rather than closed (drop): a swallowed error
	 * must not silently drop a real human-driven status change as "ours".
	 *
	 * Two things bound that residual risk — identity resolution failing is the rare
	 * (credential) case, and the authoritative downstream re-read
	 * (docs/github-projects-v2-api.md §5 step 4) is the second line of defense that
	 * decides whether the re-fired transition actually starts a phase; the worker's
	 * `selfEnqueueNextPhase` + `pm-status-dedup.ts` compensate on the other side. If
	 * this proves too loose in practice, the fix is a bounded retry on resolution
	 * here, not flipping to fail-closed (which would strand real human changes).
	 */
	async isSelfAuthored(event: GitHubProjectsParsedEvent, project: ProjectConfig): Promise<boolean> {
		if (!event.actorLogin) return false;
		try {
			const identities = await resolvePersonaIdentities(project);
			return isSwarmBot(event.actorLogin, identities);
		} catch (err) {
			logger.error('Failed to resolve persona identities; skipping loop-prevention check', {
				projectId: project.id,
				projectNodeId: event.projectNodeId,
				error: String(err),
			});
			return false;
		}
	}
}
