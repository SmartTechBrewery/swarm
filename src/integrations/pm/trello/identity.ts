/**
 * Trello board identity — the member id every SWARM board write is attributed to,
 * and therefore the one the board's loop-prevention gate must recognize as its own
 * (`TrelloRouterAdapter.isSelfAuthored`, `src/router/adapters/trello.ts`).
 *
 * It is the identity of the provider's **own** declared key/token pair
 * (`./credentials.ts`) — specifically of the *token*, which names the member who
 * authorized the integration — never an SCM persona: a Trello board paired with a
 * GitHub repo shares no identity with the source-control side, which is exactly
 * what ai/RULES.md §2 "Loop prevention is a per-provider obligation" requires a
 * provider to establish for itself.
 *
 * Deliberately **uncached**, like the Linear and Jira identities and unlike GitHub
 * Projects': board-event volume is tiny (one round-trip per inbound delivery that
 * carries an actor), and a stale identity would silently break loop prevention in
 * the direction that hurts — SWARM reacting to its own card moves. Add a TTL cache
 * only if a real delivery rate makes the round-trip cost visible.
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { trelloRequest } from './client.js';
import { withTrelloProjectCredentials } from './credentials.js';

/** `GET /members/me` — the member the scoped key/token pair authenticates as. */
const MEMBER_ME_PATH = 'members/me';

interface TrelloMember {
	id?: string | null;
}

/**
 * Resolve the Trello member id the project's token authenticates as. Throws when
 * the credential is missing or its identity can't be read — the caller decides how
 * to treat that (the loop-prevention gate fails open and logs, so a swallowed
 * error never drops a real human card move).
 *
 * The member **id** rather than the username: it is the stable value Trello puts
 * on an action's `idMemberCreator`, which is what the gate compares, where a
 * username is rename-prone.
 */
export async function resolveTrelloMemberId(project: ProjectConfig): Promise<string> {
	const member = await withTrelloProjectCredentials(project, () =>
		trelloRequest<TrelloMember | undefined>(MEMBER_ME_PATH, { query: { fields: 'id' } }),
	);
	const memberId = member?.id;
	if (!memberId) {
		throw new Error(
			`Failed to resolve the Trello identity of the board credential for project '${project.id}'`,
		);
	}
	return memberId;
}
