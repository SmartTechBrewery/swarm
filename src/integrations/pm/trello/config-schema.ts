/**
 * Trello provider integration config schema — the board mapping, and the `trello`
 * member of `ProjectPmSchema` (`src/config/schema.ts`) it is merged into. Same
 * shape as `../jira/config-schema.ts` and `../linear/config-schema.ts`: Zod schema
 * plus its inferred type, owned by the provider, composed centrally by import
 * (ai/CODING_STANDARDS.md "Zod is the source of truth").
 *
 * Two decisions worth recording, both departures from Cascade's Trello config
 * (`cascade/src/pm/config.ts`'s `TrelloConfig`):
 *
 * - **`statusOptions`, not Cascade's `lists`.** A Trello card's status *is* which
 *   list it sits in, so the values are list ids — but the *key* stays the canonical
 *   `statusOptions` every other SWARM provider uses, because the dashboard's
 *   board-mapping projection reads `pm.statusOptions` **generically**
 *   (`dashboard/src/lib/board-mapping.ts`). Naming it `lists` would force a
 *   provider branch into shared UI code and buy nothing.
 * - **No `labels` map and no `customFields`.** `PMProvider.addLabel` takes a label
 *   *name* and leaves resolving or creating it to the provider, so a configured
 *   label-id map has nothing to answer; custom fields are an explicit issue #492
 *   non-goal.
 *
 * Trello credentials (the API key + token pair, and the signing secret its webhook
 * verifier needs) are referenced from the project config's `credentials.pm` block
 * instead (`./credentials.ts`).
 */

import { z } from 'zod';

import type { ProjectConfig } from '../../../config/schema.js';

export const trelloConfigSchema = z
	.object({
		/**
		 * The Trello **board** id — the board container. Trello accepts either the
		 * 24-character object id or the board's short link in a URL path, and this is
		 * the long id: it is what `GET /boards/{id}/lists` returns alongside each
		 * list, and what a webhook delivery carries at `model.id`.
		 */
		boardId: z.string().min(1),

		/**
		 * Canonical SWARM status key → Trello **list** id. A Trello board has no status
		 * field: a card's status is the list it belongs to, so a "state" here is a list
		 * (`PM_DISCOVERY_CAPABILITIES`' neutral `states`, `src/pm/types.ts`) and moving
		 * a card is `PUT /cards/{id}` with a new `idList`.
		 *
		 * Values are list ids, never list names — names are rename-prone, and a card
		 * read reports its list as `idList`, so a status lookup compares ids rather
		 * than fuzzy-matching a name.
		 *
		 * Recognized keys are the canonical `PM_STATUS_KEYS` (`src/pm/pipeline.ts`);
		 * kept an open record for the same reason the other providers do — a board may
		 * not have a list for all six — with the one bound that an empty mapping gives
		 * the provider nowhere to move a card.
		 */
		statusOptions: z
			.record(z.string().min(1), z.string().min(1))
			.refine((record) => Object.keys(record).length > 0, {
				message: 'statusOptions must map at least one pipeline status to a Trello list ID',
			}),
	})
	.strict()
	.describe('Trello board integration config');

export type TrelloIntegrationConfig = z.infer<typeof trelloConfigSchema>;

/**
 * Narrow a project's `pm` union member to Trello's board mapping. The single place
 * a `pm.type === 'trello'` assertion lives — this provider and its router adapter
 * go through it, and shared code never branches on `pm.type` (ai/RULES.md §2).
 *
 * A mismatch is a wiring bug, not a runtime condition: the registry resolves a
 * provider *from* `pm.type`, so the only way to arrive here with another provider's
 * config is a call site that named this provider directly.
 */
export function requireTrelloConfig(project: ProjectConfig): TrelloIntegrationConfig {
	const pm = project.pm;
	// Keep the configured provider id for the wiring-error message before narrowing.
	const providerId: string = pm.type;
	if (pm.type !== 'trello') {
		throw new Error(
			`Project '${project.id}' is configured for PM provider '${providerId}', not 'trello' — ` +
				'the Trello provider was resolved for a board it does not own',
		);
	}
	const { type: _type, ...config } = pm;
	return config;
}
