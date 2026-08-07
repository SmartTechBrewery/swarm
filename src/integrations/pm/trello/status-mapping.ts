/**
 * Trello list id ↔ canonical SWARM status-key translation. A Trello board has no
 * status field — a card's status is the list it sits in — so a "state" here is a
 * list id (`./config-schema.ts`).
 */

import type { TrelloIntegrationConfig } from './config-schema.js';

/** Return the canonical status key for a Trello list id, if configured. */
export function resolveStatusKeyByListId(
	config: TrelloIntegrationConfig,
	listId: string,
): string | undefined {
	for (const [statusKey, mappedListId] of Object.entries(config.statusOptions)) {
		if (mappedListId === listId) return statusKey;
	}
	return undefined;
}

/** Return a configured Trello list id or fail loudly on a bad mapping. */
export function requireListIdForStatusKey(
	config: TrelloIntegrationConfig,
	statusKey: string,
): string {
	const listId = config.statusOptions[statusKey];
	if (!listId) {
		throw new Error(
			`Trello statusOptions has no list ID mapped for canonical status '${statusKey}'`,
		);
	}
	return listId;
}
