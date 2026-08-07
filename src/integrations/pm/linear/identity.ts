/**
 * Linear board identity — the actor id every SWARM board write is attributed to,
 * and therefore the one the board's loop-prevention gate must recognize as its
 * own (`LinearRouterAdapter.isSelfAuthored`, `src/router/adapters/linear.ts`).
 *
 * It is the identity of the provider's **own** declared API key
 * (`./credentials.ts`), never an SCM persona: a Linear board paired with a GitHub
 * repo shares no identity with the source-control side, which is exactly what
 * ai/RULES.md §2 "Loop prevention is a per-provider obligation" requires a second
 * provider to establish for itself.
 *
 * Deliberately **uncached**, unlike the GitHub Projects identity: board-event
 * volume is tiny (one round-trip per inbound delivery that carries an actor), and
 * a stale identity would silently break loop prevention in the direction that
 * hurts — SWARM reacting to its own card moves. Add a TTL cache only if a real
 * delivery rate makes the round-trip cost visible.
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { linearGraphQL } from './client.js';
import { withLinearProjectCredentials } from './credentials.js';

/**
 * The authenticated actor behind the API key. `viewer` answers for a personal API
 * key and for an OAuth access token alike, so one document covers both ways a
 * project can supply the credential.
 */
const VIEWER_QUERY = /* GraphQL */ `
	query Viewer {
		viewer { id }
	}
`;

interface ViewerResponse {
	viewer?: { id?: string | null } | null;
}

/**
 * Resolve the Linear actor id the project's API key authenticates as. Throws when
 * the credential is missing or its identity can't be read — the caller decides how
 * to treat that (the loop-prevention gate fails open and logs, so a swallowed
 * error never drops a real human state change).
 */
export async function resolveLinearActorId(project: ProjectConfig): Promise<string> {
	const data = await withLinearProjectCredentials(project, () =>
		linearGraphQL<ViewerResponse>(VIEWER_QUERY),
	);
	const actorId = data.viewer?.id;
	if (!actorId) {
		throw new Error(
			`Failed to resolve the Linear identity of the board credential for project '${project.id}'`,
		);
	}
	return actorId;
}
