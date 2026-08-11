/**
 * Jira provider integration config schema — the board mapping, and the `jira`
 * member of `ProjectPmSchema` (`src/config/schema.ts`) it is merged into. Same
 * shape as `../linear/config-schema.ts` and `../github-projects/config-schema.ts`:
 * Zod schema plus its inferred type, owned by the provider, composed centrally by
 * import (ai/CODING_STANDARDS.md "Zod is the source of truth").
 *
 * **`baseUrl` is config, not a credential** — the open question issue #490 asked.
 * A `credentials.pm` role describes a *secret*: the project supplies a reference
 * resolved from the encrypted store and the dashboard renders it as a masked,
 * write-only field, which is the wrong treatment for a tenant URL an operator has
 * to be able to read back. Cascade makes it a synthetic credential
 * (`configToCredentials` → `base_url`) only to feed its setup wizard, which
 * discovers *before* any config row exists. SWARM still has no wizard, and this stays
 * config — but the "discovery only ever runs on a persisted `ProjectConfig`" half of
 * that argument stopped being true with issue #641: the discovery API now also serves
 * a provider a project is **not** persisted on, against the manifest's blank `pm`
 * member, so an operator can pick an incoming provider's board before saving a
 * switch. That is exactly the case a blank `baseUrl` cannot serve, so this provider
 * declares a provider-switch discovery draft (`./index.ts`): the dashboard collects
 * and the API validates the site URL before discovery, then carries it into the one
 * final persisted member. It remains board identity, not a credential.
 *
 * Jira credentials (the email + API-token pair) are referenced from the project
 * config's `credentials.pm` block instead (`./credentials.ts`).
 */

import { z } from 'zod';

import type { ProjectConfig, ProjectPm } from '../../../config/schema.js';

export const jiraConfigSchema = z
	.object({
		/**
		 * The Jira Cloud site's base URL (`https://acme.atlassian.net`), no path. Any
		 * URL is accepted on purpose: sandbox and developer tenants live outside
		 * `*.atlassian.net`, and "Jira Cloud only" is a statement about the REST
		 * surface, not about the hostname.
		 */
		baseUrl: z.string().url(),

		/**
		 * The Jira project **key** (`SWARM`) — the board container. A key, not the
		 * numeric project id, because that is what every issue's own key is prefixed
		 * with and what a webhook carries at `issue.fields.project.key`.
		 */
		projectKey: z.string().min(1),

		/**
		 * Canonical SWARM status key → Jira status **id**. Values are ids, never status
		 * names: names are rename-prone, and Cascade's Jira config storing names
		 * (`statuses: { backlog: 'Backlog' }`, matched case-insensitively) is the one
		 * part of that precedent SWARM deliberately does not copy. A status id is what
		 * `GET /rest/api/3/project/{key}/statuses` returns and what every read yields at
		 * `fields.status.id`, so a later phase's transition lookup compares ids rather
		 * than fuzzy-matching a name.
		 *
		 * Recognized keys are the canonical `PM_STATUS_KEYS` (`src/pm/pipeline.ts`);
		 * kept an open record for the same reason the other providers do — a workflow
		 * may not offer all six — with the one bound that an empty mapping gives the
		 * provider no transition targets at all.
		 */
		statusOptions: z
			.record(z.string().min(1), z.string().min(1))
			.refine((record) => Object.keys(record).length > 0, {
				message: 'statusOptions must map at least one pipeline status to a Jira status ID',
			}),
	})
	.strict()
	.describe('Jira board integration config');

export type JiraIntegrationConfig = z.infer<typeof jiraConfigSchema>;

/** The only value an incoming Jira provider needs before it can discover projects. */
export const jiraDiscoveryDraftSchema = z
	.object({ baseUrl: z.string().url() })
	.strict()
	.describe('Jira incoming-provider discovery draft');

/**
 * This provider's `pm` member with no site and no project selected — the manifest's
 * `blankPm` (`../manifest.ts`).
 *
 * Unlike the other providers' blank members this one cannot be discovered against at
 * all: `baseUrl` is the site every REST call is addressed to, so the manifest pairs it
 * with a `blankPmDiscoveryBlocker` (`./index.ts`). It is still declared, because the
 * *credential* half of the incoming-provider flow needs no board at all — entering a
 * Jira email and API token for a project that is not on Jira yet is exactly what the
 * switch flow does first.
 *
 * Deliberately not a persistable member: `baseUrl` must be a URL and `statusOptions`
 * must map at least one status.
 */
export const jiraBlankPm: ProjectPm = {
	type: 'jira',
	baseUrl: '',
	projectKey: '',
	statusOptions: {},
};

/**
 * Narrow a project's `pm` union member to Jira's board mapping. The single place a
 * `pm.type === 'jira'` assertion lives — this provider and its router adapter go
 * through it, and shared code never branches on `pm.type` (ai/RULES.md §2).
 *
 * A mismatch is a wiring bug, not a runtime condition: the registry resolves a
 * provider *from* `pm.type`, so the only way to arrive here with another provider's
 * config is a call site that named this provider directly.
 */
export function requireJiraConfig(project: ProjectConfig): JiraIntegrationConfig {
	const pm = project.pm;
	// Keep the configured provider id for the wiring-error message before narrowing.
	const providerId: string = pm.type;
	if (pm.type !== 'jira') {
		throw new Error(
			`Project '${project.id}' is configured for PM provider '${providerId}', not 'jira' — ` +
				'the Jira provider was resolved for a board it does not own',
		);
	}
	const { type: _type, ...config } = pm;
	return config;
}
