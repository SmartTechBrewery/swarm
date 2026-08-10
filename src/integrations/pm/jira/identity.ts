/**
 * Jira board identity — the Atlassian account id every SWARM board write is
 * attributed to, and therefore the one the board's loop-prevention gate must
 * recognize as its own (`JiraRouterAdapter.isSelfAuthored`,
 * `src/router/adapters/jira.ts`).
 *
 * It is the identity of the provider's **own** declared credential pair
 * (`./credentials.ts`), never an SCM persona: a Jira board paired with a GitHub
 * repo shares no identity with the source-control side, which is exactly what
 * ai/RULES.md §2 "Loop prevention is a per-provider obligation" requires a
 * second provider to establish for itself.
 *
 * Deliberately **uncached**, like the Linear identity and unlike GitHub
 * Projects': board-event volume is tiny (one round-trip per inbound delivery
 * that carries an actor), and a stale identity would silently break loop
 * prevention in the direction that hurts — SWARM reacting to its own card moves.
 * Add a TTL cache only if a real delivery rate makes the round-trip cost visible.
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { jiraRequest } from './client.js';
import { withJiraProjectCredentials } from './credentials.js';

/** `GET /rest/api/3/myself` — the account the scoped basic-auth pair authenticates as. */
const MYSELF_PATH = 'myself';

interface JiraMyself {
	accountId?: string | null;
}

/**
 * Resolve the Atlassian `accountId` the project's API token authenticates as.
 * Throws when the credential is missing or its identity can't be read — the
 * caller decides how to treat that (the loop-prevention gate fails open and
 * logs, so a swallowed error never drops a real human status change).
 *
 * An `accountId` rather than an email or display name: it is the stable id Jira
 * puts on a webhook's `user`, where the email is often hidden by the account's
 * own privacy settings and the display name is rename-prone.
 */
export async function resolveJiraAccountId(project: ProjectConfig): Promise<string> {
	const me = await withJiraProjectCredentials(project, () =>
		jiraRequest<JiraMyself | null>(MYSELF_PATH),
	);
	const accountId = me?.accountId;
	if (!accountId) {
		throw new Error(
			`Failed to resolve the Jira identity of the board credential for project '${project.id}'`,
		);
	}
	return accountId;
}
