/**
 * The **agent access token** (issue #1362) — the installation's second
 * credential, standing *beside* the session rather than changing it: a
 * signed-in user issues one to themselves, by name, so an MCP client
 * (Claude Code and the like) can reach `/operator/mcp` without the `swarm` CLI's
 * login session. It is ported from Under Control's „Dostęp agenta”, whose
 * behaviour it deliberately matches.
 *
 * This module is the **browser-safe half**: the wire shapes (Zod is the source of
 * truth, `ai/CODING_STANDARDS.md`), the lifetime constants and the per-role
 * decision. It imports nothing but Zod and `./schema.js`, so the dashboard reads
 * the very same input schema and role map the API enforces. Minting, hashing and
 * the store live in `./agent-access-token-service.ts`.
 *
 * What it shares with a session: an opaque 256-bit token, only its SHA-256 in the
 * database, the raw value handed over exactly once. What it does **not** share:
 * its expiry is **absolute and never slid**, and it is accepted as an
 * `Authorization: Bearer` header by the MCP endpoint alone.
 */

import { z } from 'zod';

import { type InstallationRole, installationRoleFor, type SwarmUser } from './schema.js';

/**
 * How long an issued token lives, counted from the issuing and **never slid by
 * use**. A constant, not a configuration option — there is one lifetime of an
 * agent's token, as Under Control has one.
 */
export const AGENT_ACCESS_TOKEN_VALIDITY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How often at most one token's last use is written. One agent's piece of work
 * is a burst of MCP tool calls and the list shows the use to the minute at best,
 * so a write per call would buy nothing. A constant, like the validity.
 */
export const AGENT_ACCESS_TOKEN_USE_RECORD_INTERVAL_MS = 60 * 1000;

/**
 * Who may hold agent access tokens — **every signed-in user** since issue #1457
 * (installation administrators only before it, issue #1362). A token acts with
 * exactly its holder's project roles, as their `swarm login` session does on
 * `/operator/mcp`, so it reaches nothing that session could not. Total over
 * {@link InstallationRole}, so a role added to `InstallationRoleSchema` fails to
 * compile here until it takes this decision rather than inheriting a default
 * branch.
 *
 * **One map for all three verbs** — issuing, listing one's own, revoking one —
 * because they are one lifecycle of one credential; splitting it would invite
 * three sentences about one owner to drift apart.
 */
export const MAY_USE_AGENT_ACCESS_TOKENS: Record<InstallationRole, boolean> = {
	instanceAdmin: true,
	user: true,
};

/** Whether `user` may issue, list and revoke agent access tokens. */
export function mayUseAgentAccessTokens(user: Pick<SwarmUser, 'instanceAdmin'>): boolean {
	return MAY_USE_AGENT_ACCESS_TOKENS[installationRoleFor(user)];
}

/** The expiry of a token issued at `now` — absolute, counted from the issuing alone. */
export function agentAccessTokenExpiry(now: Date): Date {
	return new Date(now.getTime() + AGENT_ACCESS_TOKEN_VALIDITY_DAYS * DAY_MS);
}

/** The most projects one scoped agent credential may be limited to. */
export const SCOPED_AGENT_TOKEN_MAX_PROJECTS = 50;

/**
 * The issuing input: the **name**, and — for a **scoped agent credential** (issue
 * #1385) — the `projectIds` it is limited to. The account comes from the session
 * and the expiry from {@link agentAccessTokenExpiry}, so there is no field through
 * which either could be pointed elsewhere. `.strict()` refuses one that tries.
 * Omitting `projectIds` issues an ordinary token acting with the holder's full
 * access; an empty list is refused rather than read as either. Repeated ids are
 * collapsed. The dashboard parses with this same schema before sending, so a
 * blank name is refused with this message without a request.
 */
export const IssueAgentAccessTokenInputSchema = z
	.object({
		name: z.string().trim().min(1, 'A token name is required.').max(80),
		projectIds: z
			.array(z.string().min(1))
			.min(1, 'A scoped agent credential needs at least one project.')
			.max(SCOPED_AGENT_TOKEN_MAX_PROJECTS)
			.transform((ids) => [...new Set(ids)])
			.optional(),
	})
	.strict();

export type IssueAgentAccessTokenInput = z.infer<typeof IssueAgentAccessTokenInputSchema>;

/**
 * The **write tools** a scoped agent credential may call (issue #1385) — on top of
 * every read tool, and nothing else. Each one acts only inside a project the
 * credential is limited to, is audited, and changes no configuration, credential,
 * board or work item. Five recover a stuck pipeline, and two record what the agent
 * found:
 *
 *  - `run_reset` — resets a wedged run and re-dispatches its phase from scratch,
 *    as the dashboard's "Reset & restart" does; it touches that run alone.
 *  - `dispatch_redispatch_now` — re-dispatches a deferred, checkpointed or failed
 *    run immediately instead of at its scheduled retry ("Retry now").
 *  - `pr_force_re_review` — grants one extra review to a pull request the
 *    review-verdict cap stopped ("Force re-review").
 *  - `pr_recheck_mergeability` — schedules the conflict check a skipped
 *    resolve-conflicts fan-out would have scheduled.
 *  - `dependency_waits_wake` — re-checks the dependency gate now; a dependent still
 *    blocked simply waits again.
 *  - `bug_report_create` and `bug_report_add_occurrence` (issue #1383) — file a bug
 *    report about SWARM, or record that a reported one happened again. An agent
 *    diagnosing a stuck pipeline (the planned *Resolve problem* phase, #1384) files
 *    one for every diagnosis it makes; it touches nothing but the report store, and
 *    an installation-wide report stays out of a scoped credential's reach.
 *
 * Everything else that writes — project creation and configuration, credentials,
 * the board mapping, closing a work item, the phase agents, a worker's CLI rate
 * limit, triaging a bug report — stays the holder's own, through their own session.
 * A constant, like {@link AGENT_ACCESS_TOKEN_VALIDITY_DAYS}; `src/mcp/tool-access.ts`
 * marks the same seven `agentScoped`, and its test keeps the two in step.
 */
export const SCOPED_AGENT_RECOVERY_TOOLS = [
	'run_reset',
	'dispatch_redispatch_now',
	'pr_force_re_review',
	'pr_recheck_mergeability',
	'dependency_waits_wake',
	'bug_report_create',
	'bug_report_add_occurrence',
] as const;

/**
 * A token as every read sees it — **without the raw value**, which exists nowhere
 * outside the answer to the issuing (the database holds a SHA-256 alone). Times
 * travel as ISO strings. `lastUsedAt` is absent while the token has never opened
 * the MCP endpoint, and is accurate to
 * {@link AGENT_ACCESS_TOKEN_USE_RECORD_INTERVAL_MS} at best.
 */
export const AgentAccessTokenSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	createdAt: z.string().datetime(),
	expiresAt: z.string().datetime(),
	lastUsedAt: z.string().datetime().optional(),
	/**
	 * The projects a scoped agent credential is limited to (issue #1385); absent on
	 * an ordinary token, which acts with its holder's full access.
	 */
	projectIds: z.array(z.string()).optional(),
});

export type AgentAccessToken = z.infer<typeof AgentAccessTokenSchema>;

/**
 * The answer to the issuing — **the one shape that carries a raw token**. A
 * separate shape rather than an optional `token` on {@link AgentAccessTokenSchema},
 * so no list read can ever be typed as carrying one.
 */
export const IssuedAgentAccessTokenSchema = AgentAccessTokenSchema.extend({ token: z.string() });

export type IssuedAgentAccessToken = z.infer<typeof IssuedAgentAccessTokenSchema>;

/**
 * Whether a listed token is past its expiry. Expired rows are swept only lazily
 * (when some token is resolved), so the list may still carry one, and a dead
 * token must not read as a live one.
 */
export function hasAgentAccessTokenExpired(
	token: Pick<AgentAccessToken, 'expiresAt'>,
	now: number,
): boolean {
	return new Date(token.expiresAt).getTime() <= now;
}
