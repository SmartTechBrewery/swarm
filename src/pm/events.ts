/**
 * PmEvent — the provider-neutral normalized inbound PM board event, and the
 * runtime (Zod) half of the PM contract whose type-only halves are
 * `src/pm/types.ts` and `src/pm/router-adapter.ts` (issue #297).
 *
 * A provider's router adapter turns its own raw board webhook — GitHub's
 * `projects_v2_item` body, a Jira issue-updated hook, a Trello card action —
 * into one of these, and every downstream consumer (the enqueue seam, the
 * durable queue envelope, the trigger registry, the queue read model) speaks
 * only this shape. That's what keeps raw provider event names, headers, and
 * payload paths inside the adapter (ai/RULES.md §2 "Project-management features
 * must stay provider-agnostic").
 *
 * The PM mirror of `src/scm/events.ts`, and a Zod schema for the same reason: a
 * normalized event *is* SWARM's durable queue payload (`src/queue/jobs.ts`) — it
 * crosses the router→Postgres/Redis→worker boundary, and shapes that cross a
 * boundary keep schema and type in one place (ai/CODING_STANDARDS.md "Zod is the
 * source of truth").
 *
 * Kept separate from `src/pm/types.ts` on purpose: that module is types-only so
 * it adds no runtime import edge (`src/config/provider.ts` depends on the config
 * schema which composes it), while this one carries Zod.
 *
 * **No `kind` discriminator, deliberately.** PM has exactly one ingress concept
 * today — "a board item changed" — where SCM ingress spans five (a PR, a review,
 * an issue, a comment, checks). A provider that brings a genuinely different
 * board-event concept adds the discriminator *then*, as a deliberate widening,
 * rather than inheriting one nothing branches on.
 */

import { z } from 'zod';
import type { PMType } from './types.js';

/**
 * The Zod mirror of the contract's {@link PMType}. Annotated with the contract
 * type so the two can't drift: adding a provider to one without the other stops
 * type-checking.
 */
export const PmProviderIdSchema: z.ZodType<PMType> = z.enum([
	'github-projects',
	'jira',
	'linear',
	'trello',
]);

/**
 * The neutral action vocabulary an adapter maps its provider's action names
 * onto. Deliberately *not* a closed enum on {@link PmEventSchema}: a provider
 * emits board actions SWARM doesn't act on (`archived`, `restored`,
 * `converted`, …), and those must still normalize, enqueue, and complete as
 * `no-trigger` rather than fail the durable envelope's validation. An action
 * outside this list rides through verbatim as an opaque tracing value that
 * matches no trigger.
 *
 * `moved` is the "card changed column" concept a board-view drag produces
 * without editing a field value; `updated` is a field edit.
 */
export type PmEventAction = 'created' | 'updated' | 'moved' | 'deleted';

const pmEventShape = z.object({
	/** Provider-native board/card id — what the authoritative re-read is keyed on. */
	itemId: z.string(),
	/** Provider-native container (board/project) id — how the SWARM project is resolved. */
	containerId: z.string(),
	/**
	 * What happened to the item, in the neutral vocabulary ({@link PmEventAction})
	 * when the provider's action maps onto one, and verbatim otherwise.
	 */
	action: z.string().optional(),
	/**
	 * Opaque provider-native identifier of the field/attribute that changed. Shared
	 * code never interprets it — only the provider's own adapter compares it against
	 * its board mapping (a GitHub Status field node id, a Jira workflow field, a
	 * Trello list). Absent when the provider's event is not a field edit.
	 */
	changedField: z.string().optional(),
	/** Opaque provider-native type of the changed field, for tracing. */
	changedFieldType: z.string().optional(),
	/** Provider-native id of the backing artifact the card wraps, when it has one. */
	contentId: z.string().optional(),
	/**
	 * Display-only descriptor of the backing artifact (`Issue`, `PullRequest`,
	 * `DraftIssue`, …) as the provider names it. It feeds the queue read model's
	 * `contentType` column and nothing branches on it — don't grow handler logic
	 * on it.
	 */
	contentType: z.string().optional(),
	/**
	 * Handle of the account that produced the event — the loop-prevention input
	 * ({@link import('./router-adapter.js').PMRouterAdapter.isSelfAuthored}).
	 */
	actorHandle: z.string().optional(),
});

// ============================================================================
// Legacy durable envelope
// ============================================================================

/**
 * Legacy action names that were GitHub's own spelling rather than the neutral
 * one. `created`/`deleted` already match the neutral vocabulary and pass through;
 * an unaliased action (`archived`, `restored`, `converted`) rides through
 * verbatim and matches no trigger, exactly as before.
 *
 * Frozen: this is the *queue's own* serialization history, not provider logic —
 * do not extend it. A second provider maps its vocabulary in its own adapter
 * ({@link import('./router-adapter.js').PMRouterAdapter.parseWebhook}).
 */
const LEGACY_ACTION_BY_NAME: Readonly<Record<string, PmEventAction>> = {
	edited: 'updated',
	reordered: 'moved',
};

/**
 * Translate one legacy value through its alias table, passing an unaliased string
 * through verbatim. `undefined` for a non-string, so the caller can tell "nothing
 * to rewrite" from "rewrote to this" and leave a malformed value for the schema to
 * reject.
 */
function remap(value: unknown, table: Readonly<Record<string, string>>): string | undefined {
	return typeof value === 'string' ? (table[value] ?? value) : undefined;
}

/**
 * Upgrade SWARM's pre-#297 wire encoding — when GitHub Projects was the only PM
 * provider and its raw webhook vocabulary *was* the wire format (`eventType:
 * 'projects_v2_item'`, `itemNodeId`, `projectNodeId`) — to the neutral shape.
 * Durable dispatch rows and historical `runs.jobPayload` snapshots still carry it
 * (a dependency recheck can wait days, and a "Retry now" re-parses a run's stored
 * payload indefinitely), so the schema reads it and upgrades in place rather than
 * failing a deploy's in-flight work.
 *
 * Recognized by the legacy `eventType` key in the absence of `itemId`; anything
 * already neutral (and any non-object) passes through untouched.
 */
export function upgradeLegacyProjectsEvent(value: unknown): unknown {
	if (typeof value !== 'object' || value === null) return value;
	const raw = value as Record<string, unknown>;
	if (raw.eventType !== 'projects_v2_item' || 'itemId' in raw) return value;

	const {
		eventType: _eventType,
		itemNodeId,
		projectNodeId,
		changedFieldNodeId,
		contentNodeId,
		actorLogin,
		action,
		...rest
	} = raw;
	const remapped = remap(action, LEGACY_ACTION_BY_NAME);
	return {
		...rest,
		itemId: itemNodeId,
		containerId: projectNodeId,
		...(remapped === undefined ? {} : { action: remapped }),
		...(changedFieldNodeId === undefined ? {} : { changedField: changedFieldNodeId }),
		...(contentNodeId === undefined ? {} : { contentId: contentNodeId }),
		...(actorLogin === undefined ? {} : { actorHandle: actorLogin }),
	};
}

/**
 * The normalized board event, accepting either the neutral encoding or the legacy
 * durable one (see {@link upgradeLegacyProjectsEvent}).
 */
export const PmEventSchema = z.preprocess(upgradeLegacyProjectsEvent, pmEventShape);

export type PmEvent = z.infer<typeof pmEventShape>;
