/** Linear workflow-state UUID ↔ canonical SWARM status-key translation. */

import type { LinearIntegrationConfig } from './config-schema.js';

/** Return the canonical status key for a Linear workflow-state UUID, if configured. */
export function resolveStatusKeyByStateId(
	config: LinearIntegrationConfig,
	stateId: string,
): string | undefined {
	for (const [statusKey, mappedStateId] of Object.entries(config.statusOptions)) {
		if (mappedStateId === stateId) return statusKey;
	}
	return undefined;
}

/** Return a configured Linear workflow-state UUID or fail loudly on a bad mapping. */
export function requireStateIdForStatusKey(
	config: LinearIntegrationConfig,
	statusKey: string,
): string {
	const stateId = config.statusOptions[statusKey];
	if (!stateId) {
		throw new Error(
			`Linear statusOptions has no workflow state ID mapped for canonical status '${statusKey}'`,
		);
	}
	return stateId;
}
