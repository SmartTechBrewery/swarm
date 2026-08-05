/**
 * GitHub Projects status resolution — the provider-specific translation the
 * `pm:status-changed` trigger depends on (ai/ARCHITECTURE.md "PM: GitHub
 * Projects").
 *
 * The board speaks in opaque single-select *option IDs* (`47fc9ee4`), the
 * pipeline speaks in canonical status *keys* (`inProgress`). The config's
 * `statusOptions` map (`config-schema.ts`) is authored key → optionId; this
 * inverts it so the provider can populate `WorkItem.statusKey` on every board
 * read and shared code never sees an option ID at all (ai/RULES.md §2). Resolving
 * the *phase* from that key is the neutral `resolvePipelinePhaseForStatusKey`
 * (`src/pm/pipeline.ts`) — this module deliberately stops at the key, so no
 * option-id→phase shortcut exists for a caller to reach for.
 *
 * IDs are matched by option ID, never by display name — names are rename-prone
 * and display-only (docs/github-projects-v2-api.md §2).
 */

import type { SingleSelectOptionId } from '../../../pm/ids.js';
import { unwrap } from '../../../pm/ids.js';
import type { GitHubProjectsIntegrationConfig } from './config-schema.js';

/**
 * The canonical pipeline status key a board option ID maps to, or `undefined`
 * when the option isn't in the project's `statusOptions` map. Accepts a branded
 * `SingleSelectOptionId` (or a plain string) so callers can pass the value
 * straight from a re-read without unwrapping first.
 */
export function resolveStatusKeyByOptionId(
	config: GitHubProjectsIntegrationConfig,
	optionId: SingleSelectOptionId | string,
): string | undefined {
	const target = unwrap(optionId);
	for (const [statusKey, mappedOptionId] of Object.entries(config.statusOptions)) {
		if (mappedOptionId === target) return statusKey;
	}
	return undefined;
}
