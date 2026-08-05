/**
 * GitHubProjectsRouterAdapter — the router-side handling of the
 * `projects_v2_item` webhook, the PM-board analogue of the SCM webhook parser
 * (`src/integrations/scm/github/webhook.ts`). This is SWARM's `pm:status-changed`
 * trigger ingress (ai/ARCHITECTURE.md "PM: GitHub Projects"), and since issue
 * #297 it is one implementation of the provider-neutral `PMRouterAdapter`
 * contract (`src/pm/router-adapter.ts`) rather than a concrete class shared code
 * names.
 *
 * Its job: parse the raw webhook into a provider-neutral `PmEvent`
 * (`src/pm/events.ts`), resolve which SWARM project owns the *board* (by
 * `project_node_id` — a Projects event carries no repo, unlike SCM ingress which
 * resolves by `owner/repo`), filter to the transitions the pipeline reacts to (a
 * Status-field edit, or a card added to the board), and drop transitions a SWARM
 * persona itself produced (loop prevention). The authoritative "which Status
 * option is it now?" re-read and the status → pipeline-phase dispatch live
 * downstream (the provider / the trigger handler) — this adapter is the doorbell,
 * per docs/github-projects-v2-api.md §5: it never trusts a Status value lifted
 * from the webhook body.
 *
 * Everything GitHub-specific stays here: the raw event name, the payload paths,
 * GitHub's own action names, and the board's Status field node id. Shared code
 * sees only `PmEvent`'s neutral fields (ai/RULES.md §2).
 */

import { findProjectByBoard } from '../../config/provider.js';
import type { ProjectConfig } from '../../config/schema.js';
import { requireGitHubProjectsConfig } from '../../integrations/pm/github-projects/config-schema.js';
import { isSwarmBot, resolvePersonaIdentities } from '../../integrations/scm/github/personas.js';
import { logger } from '../../lib/logger.js';
import type { PmEvent, PmEventAction } from '../../pm/events.js';
import type { PMRouterAdapter } from '../../pm/router-adapter.js';

/** The GitHub webhook event type carrying Projects (v2) board changes. */
export const PROJECTS_V2_ITEM_EVENT = 'projects_v2_item';

/**
 * GitHub's own `projects_v2_item` action names → the neutral
 * {@link PmEventAction} vocabulary. An action absent here (`archived`,
 * `restored`, `converted`) rides through verbatim and matches no trigger.
 *
 * `reordered` → `moved` is the Board-view drag: confirmed against a real delivery
 * that a cross-column drag carries no `changes.field_value` at all (only
 * `previous_projects_v2_item_node_id`), so `edited` alone misses the exact
 * interaction a Kanban board's drag-and-drop is built around.
 * `docs/github-projects-v2-api.md`'s "cares almost entirely about edited" note
 * predates this finding.
 */
const NEUTRAL_ACTION_BY_GITHUB_ACTION: Readonly<Record<string, PmEventAction>> = {
	created: 'created',
	edited: 'updated',
	reordered: 'moved',
	deleted: 'deleted',
};

/**
 * The neutral actions the pipeline reacts to: a field value changed (Status among
 * them — `updated`), a card was added to the board (`created`,
 * docs/github-projects-v2-api.md §5 → Actions), or a card was dragged to a
 * different column in the Board view (`moved`). That last one can't be filtered
 * by changed field the way `updated` can — see
 * {@link NEUTRAL_ACTION_BY_GITHUB_ACTION} — so it always passes this gate.
 */
const TRIGGERING_ACTIONS: ReadonlySet<string> = new Set<PmEventAction>([
	'updated',
	'created',
	'moved',
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

export class GitHubProjectsRouterAdapter implements PMRouterAdapter {
	readonly type = 'github-projects' as const;

	/**
	 * Normalize a raw webhook body into a `PmEvent`. `eventName` comes from the
	 * `X-GitHub-Event` header, not the body. Returns `null` for any other event
	 * type, and for a `projects_v2_item` payload missing the item or board node ID
	 * (nothing actionable without both), so the caller can drop it without
	 * branching.
	 */
	parseWebhook(eventName: string, payload: unknown): PmEvent | null {
		if (eventName !== PROJECTS_V2_ITEM_EVENT) return null;

		const p = asRecord(payload) ?? {};
		const item = asRecord(p.projects_v2_item);
		const itemId = item?.node_id as string | undefined;
		const containerId = item?.project_node_id as string | undefined;
		if (!itemId || !containerId) return null;

		const fieldValue = asRecord(asRecord(p.changes)?.field_value);
		const githubAction = p.action as string | undefined;

		return {
			itemId,
			containerId,
			action: githubAction
				? (NEUTRAL_ACTION_BY_GITHUB_ACTION[githubAction] ?? githubAction)
				: undefined,
			contentId: (item?.content_node_id as string) ?? undefined,
			contentType: (item?.content_type as string) ?? undefined,
			changedField: (fieldValue?.field_node_id as string) ?? undefined,
			changedFieldType: (fieldValue?.field_type as string) ?? undefined,
			actorHandle: (asRecord(p.sender)?.login as string) ?? undefined,
		};
	}

	/** Resolve the SWARM project that owns the event's board, or `null` if untracked. */
	async resolveProject(event: PmEvent): Promise<ProjectConfig | null> {
		return (await findProjectByBoard(event.containerId)) ?? null;
	}

	/**
	 * Whether this event is a transition the pipeline reacts to: a card added to
	 * the board (`created`), a card dragged to a different Board-view column
	 * (`moved` — see {@link NEUTRAL_ACTION_BY_GITHUB_ACTION} for why this can't be
	 * filtered by field like `updated` can), or an edit to the project's **Status**
	 * field specifically (`updated` + the changed field is `statusFieldId`). Any
	 * other field edit (Priority, Size, assignees, …) is dropped here — matching
	 * the `pm:status-changed` filter in docs/github-projects-v2-api.md §5 step 2.
	 *
	 * It deliberately does **not** assert *which* Status option the card moved to:
	 * the webhook body doesn't carry a reliable new value, so that comes from the
	 * authoritative re-read downstream. This gate answers "is this worth waking
	 * the pipeline for?", not "which phase?". Because `moved` also fires on a
	 * pure within-column reorder with no Status change at all, this gate alone
	 * can't rule that case out — `pm-status-dedup.ts` is the second line of
	 * defense that stops a harmless reorder from re-dispatching a phase.
	 */
	isStatusChange(event: PmEvent, project: ProjectConfig): boolean {
		if (!event.action || !TRIGGERING_ACTIONS.has(event.action)) return false;
		if (event.action === 'created' || event.action === 'moved') return true;
		return event.changedField === requireGitHubProjectsConfig(project).statusFieldId;
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
	 *
	 * Reaching into the *SCM* provider's persona helpers is legitimate **only for
	 * this provider**, because a GitHub Projects board and the GitHub repo are the
	 * same account (ai/RULES.md §2 names it as one of two deliberate reaches). The
	 * contract on {@link PMRouterAdapter.isSelfAuthored} spells out that a provider
	 * whose board is a different account than its repo must establish its own
	 * identity instead.
	 */
	async isSelfAuthored(event: PmEvent, project: ProjectConfig): Promise<boolean> {
		if (!event.actorHandle) return false;
		try {
			const identities = await resolvePersonaIdentities(project);
			return isSwarmBot(event.actorHandle, identities);
		} catch (err) {
			logger.error('Failed to resolve persona identities; skipping loop-prevention check', {
				projectId: project.id,
				containerId: event.containerId,
				error: String(err),
			});
			return false;
		}
	}

	/**
	 * The synthetic Status-field edit the worker self-enqueues after a phase's
	 * `autoAdvance` moves a card (`selfEnqueueNextPhase`, `src/worker/consumer.ts`):
	 * GitHub's own webhook for that move is authored by the implementer persona and
	 * therefore always dropped by {@link isSelfAuthored}, so the next phase would
	 * otherwise never start.
	 *
	 * Deliberately shaped to satisfy {@link isStatusChange} for this project — the
	 * board's Status field node id is exactly the provider knowledge that used to
	 * leak into the worker.
	 */
	synthesizeStateChange(project: ProjectConfig, itemId: string): PmEvent {
		const config = requireGitHubProjectsConfig(project);
		return {
			itemId,
			containerId: config.projectId,
			action: 'updated',
			changedField: config.statusFieldId,
			changedFieldType: 'single_select',
		};
	}
}
