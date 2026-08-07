/** Jira status id ↔ canonical SWARM status-key translation. */

import type { JiraIntegrationConfig } from './config-schema.js';

/** Return the canonical status key for a Jira status id, if configured. */
export function resolveStatusKeyByStatusId(
	config: JiraIntegrationConfig,
	statusId: string,
): string | undefined {
	for (const [statusKey, mappedStatusId] of Object.entries(config.statusOptions)) {
		if (mappedStatusId === statusId) return statusKey;
	}
	return undefined;
}

/** Return a configured Jira status id or fail loudly on a bad mapping. */
export function requireStatusIdForStatusKey(
	config: JiraIntegrationConfig,
	statusKey: string,
): string {
	const statusId = config.statusOptions[statusKey];
	if (!statusId) {
		throw new Error(
			`Jira statusOptions has no status ID mapped for canonical status '${statusKey}'`,
		);
	}
	return statusId;
}
