/**
 * Config + credential resolution facade — mirrors Cascade's `src/config/provider.ts`,
 * trimmed to SWARM's single provider pair and single-user scope.
 *
 * This is the seam the router and SCM layers call: they ask for a project by
 * repo and for a persona's token, and never touch the DB repositories or the
 * `credentials`-reference indirection directly. Keeping that indirection here
 * means the rest of the code deals in `(project, persona)` and never in raw
 * env-var keys or ciphertext.
 */

import { resolveProjectCredential } from '../db/repositories/credentialsRepository.js';
import {
	findProjectByBoardFromDb,
	findProjectByPmContainerFromDb,
	findProjectByRepoFromDb,
} from '../db/repositories/projectsRepository.js';
import { requireProjectPMCredentialRole } from '../integrations/pm/registry.js';
import { getSCMProvider } from '../integrations/scm/registry.js';
import type { ScmCredentialRole, ScmPersona, ScmType } from '../scm/types.js';
import { getOperatorGitHubTokenOrNull, OPERATOR_GH_TOKEN_ENV } from './operator-token.js';
import type { ProjectConfig } from './schema.js';
import { scmCredentialReferenceFor, sharedScmCredentialProviderFor } from './scm-credentials.js';

/**
 * Resolve the SWARM project that owns a GitHub repository (`owner/repo`).
 * Returns `undefined` when the repo isn't tracked — the router treats that as
 * "not ours", not an error.
 */
export async function findProjectByRepo(repo: string): Promise<ProjectConfig | undefined> {
	return findProjectByRepoFromDb(repo);
}

/**
 * Resolve the SWARM project that owns a GitHub Projects (v2) board, by its node
 * ID (`pm.projectId`). The PM-side counterpart of
 * {@link findProjectByRepo}: a `projects_v2_item` webhook is a board event with
 * no repo, so the board node ID is what identifies the project. Returns
 * `undefined` when the board isn't tracked — "not ours", not an error.
 */
export async function findProjectByBoard(
	projectNodeId: string,
): Promise<ProjectConfig | undefined> {
	return findProjectByBoardFromDb(projectNodeId);
}

/**
 * Resolve the SWARM project that owns a Linear **team**, by the team UUID
 * (`pm.teamId`) a Linear board webhook carries. The Linear counterpart of
 * {@link findProjectByBoard}: a team is Linear's board container, since workflow
 * states belong to teams (`src/integrations/pm/linear/config-schema.ts`).
 *
 * Its own lookup rather than a shared one, because each provider names the
 * container with its own `pm_config` key — the repository call is parameterised by
 * both the provider id and that key, so two providers' blobs cannot collide
 * (issue #529). Returns `undefined` for an untracked team — "not ours", not an
 * error.
 */
export async function findProjectByLinearTeam(teamId: string): Promise<ProjectConfig | undefined> {
	return findProjectByPmContainerFromDb('linear', 'teamId', teamId);
}

/**
 * Resolve the SWARM project that owns a Jira **project**, by the project key
 * (`pm.projectKey`, e.g. `SWARM`) a Jira issue webhook carries at
 * `issue.fields.project.key`. The Jira counterpart of
 * {@link findProjectByLinearTeam}, and the same one-line facade over the
 * parameterised container lookup — the `pm_type` filter is what stops another
 * provider's config blob matching on the same key name (issue #529).
 *
 * The key, not the numeric project id, because that is what every issue key is
 * prefixed with and what the board mapping stores
 * (`src/integrations/pm/jira/config-schema.ts`). Returns `undefined` for an
 * untracked project — "not ours", not an error.
 */
export async function findProjectByJiraProject(
	projectKey: string,
): Promise<ProjectConfig | undefined> {
	return findProjectByPmContainerFromDb('jira', 'projectKey', projectKey);
}

/**
 * Resolve the SWARM project that owns a Trello **board**, by the board id
 * (`pm.boardId`) a card action carries at `action.data.board.id`. The Trello
 * counterpart of {@link findProjectByLinearTeam}, and the same one-line facade
 * over the parameterised container lookup — the `pm_type` filter is what stops
 * another provider's config blob matching on the same key name (issue #529).
 *
 * The long 24-character object id, not the board's short link, because that is
 * what the board mapping stores and what a delivery carries
 * (`src/integrations/pm/trello/config-schema.ts`). Returns `undefined` for an
 * untracked board — "not ours", not an error.
 */
export async function findProjectByTrelloBoard(
	boardId: string,
): Promise<ProjectConfig | undefined> {
	return findProjectByPmContainerFromDb('trello', 'boardId', boardId);
}

/**
 * Resolve one of a project's SCM credentials — `(project, providerId, role)` →
 * secret, or `null` when the project names no reference for that pair or the
 * reference resolves to no stored credential (issue #628).
 *
 * It reads **only** the provider it was asked for
 * (`credentials.scm[providerId][role]`). Deliberately not a fallback chain: a project
 * may retain credentials for a provider it is not currently running on — switching the
 * Source Control tab's selector leaves the previous provider's secrets stored — and
 * quietly resolving those would hand a newly selected GitLab the GitHub secret. There
 * is no host-env escape hatch either: SCM references have never had one (only an
 * explicitly configured `credentials.pm` role does).
 *
 * The legacy shared `{ reviewer, webhookSecret }` pair is not consulted at runtime.
 * A config that still carries it is migrated on the way in instead —
 * `adoptLegacyScmCredentials` on parse, plus a one-time SQL backfill for persisted
 * rows (`./scm-credentials.ts`).
 */
export async function resolveScmCredentialOrNull(
	project: ProjectConfig,
	providerId: ScmType,
	role: ScmCredentialRole,
): Promise<string | null> {
	const reference = scmCredentialReferenceFor(project, providerId, role);
	if (!reference) return null;
	return resolveProjectCredential(project.id, reference);
}

/**
 * Resolve an SCM credential, throwing when it resolves to nothing — the
 * `require`-shaped twin of {@link resolveScmCredentialOrNull}, and the **single
 * enforcement point** for "this provider's credential must be configured" (issue
 * #628). The config schema validates only the *structure* of `credentials.scm`, so
 * this is what fires when a credential is actually needed.
 *
 * The message names the project, the provider, the role, and that provider's
 * conventional config-apply key, in `requirePmCredential`'s wording — never another
 * provider's secret, and never a suggestion to reuse one.
 */
export async function requireScmCredential(
	project: ProjectConfig,
	providerId: ScmType,
	role: ScmCredentialRole,
): Promise<string> {
	const secret = await resolveScmCredentialOrNull(project, providerId, role);
	if (secret) return secret;

	const manifest = getSCMProvider(providerId);
	const label = manifest?.label ?? providerId;
	const envVarKey = manifest?.credentialRoles.find((spec) => spec.role === role)?.envVarKey;
	throw new Error(
		`No ${label} ${role} credential configured for project '${project.id}' ` +
			`(set credentials.scm.${providerId}.${role} to a stored reference` +
			(envVarKey ? `; ${envVarKey} is its conventional config-apply key)` : ')'),
	);
}

/**
 * Resolve a persona's GitHub token for a project, or `null` if it resolves to no
 * token.
 *
 * **This pair is GitHub's**, not a provider-neutral seam: the `implementer` branch
 * returns the *GitHub* operator token, and the `reviewer` branch resolves GitHub's own
 * per-provider reference since issue #628. Bitbucket and GitLab have their own twins
 * in their provider folders (`src/integrations/scm/{bitbucket,gitlab}/credentials.ts`)
 * for exactly that reason.
 *
 * The two personas resolve from *different* sources (issue #396): the
 * `implementer` is the worker operator's own token, a worker-local env var
 * (`SWARM_OPERATOR_GH_TOKEN`, `./operator-token.ts`) that is never persisted and
 * never in the project config; the `reviewer` stays a project-scoped credential
 * *reference* resolved from the secret store. The implementer/reviewer split is the
 * whole point (ai/CODING_STANDARDS.md "Loop prevention"): the two personas must
 * resolve to two distinct identities so neither reacts to its own output — here the
 * author (operator) ≠ reviewer.
 */
export async function getPersonaTokenOrNull(
	project: ProjectConfig,
	persona: ScmPersona,
): Promise<string | null> {
	if (persona === 'implementer') return getOperatorGitHubTokenOrNull();
	return resolveScmCredentialOrNull(project, 'github', persona);
}

/**
 * Resolve the secret one SCM provider authenticates a project's inbound deliveries
 * with, or `null` when the reference is unset or resolves to no stored credential.
 *
 * Takes the provider id since issue #628: the receiver passes the manifest the
 * delivery actually arrived from, so a GitLab delivery is never checked against the
 * secret stored for the same project's GitHub webhook. Returning `null` (rather than
 * throwing) lets the router decide how to treat a project with no secret configured.
 */
export async function getWebhookSecretOrNull(
	project: ProjectConfig,
	providerId: ScmType,
): Promise<string | null> {
	return resolveScmCredentialOrNull(project, providerId, 'webhookSecret');
}

/**
 * Resolve one of a project's PM-provider credentials by the *role* its provider
 * declares (`PMProviderManifest.credentialRoles`, issue #497), or `null` when the
 * role resolves to nothing. The PM twin of {@link getPersonaTokenOrNull}: shared
 * code asks for `(project, role)` and never learns which reference, env var, or
 * store row it came from.
 *
 * Resolution order, most specific first:
 *
 * 1. the reference the project configured for the role (`credentials.pm[role]`),
 *    through the secret store;
 * 2. the SCM-side credential the role declares it inherits
 *    (`inheritsSharedCredential`) — also a store reference, so it belongs above the
 *    host env; this is what keeps GitHub Projects' webhook secret *exactly* the
 *    project's existing SCM webhook secret. Since issue #628 that resolves the repo
 *    side's **per-provider** secret for the SCM provider the project runs on
 *    (`sharedScmCredentialProviderFor`), rather than a single shared reference;
 * 3. the role's `envVarKey` in this host's environment — only when the project
 *    explicitly configured `credentials.pm[role]`, as the escape hatch for a host
 *    that exports that opted-in secret directly rather than storing it;
 * 4. `null`.
 *
 * A configured reference that resolves to nothing falls through rather than
 * short-circuiting: `swarm config apply` warns-and-skips a reference whose env var
 * was unset, so "reference configured, store row absent, env var present on the
 * worker" is a legitimate state and resolving it is what an operator expects. A
 * role with no configured PM reference never reads a host environment variable,
 * preserving the fail-closed behavior of inherited webhook credentials.
 *
 * Throws when the role isn't one the project's provider declares — asking for a
 * credential a provider has no notion of is a wiring bug, not a lookup miss
 * (ai/CODING_STANDARDS.md "Error handling").
 */
export async function resolvePmCredential(
	project: ProjectConfig,
	role: string,
): Promise<string | null> {
	const spec = requireProjectPMCredentialRole(project, role);

	const configured = project.credentials.pm?.[role];
	if (configured) {
		const stored = await resolveProjectCredential(project.id, configured);
		if (stored) return stored;
	}

	if (spec.inheritsSharedCredential) {
		// The repo side's secret for the SCM provider this project runs on. An unstated
		// `scm` attributes to GitHub — the same rule the legacy adoption uses, so an
		// unmigrated GitHub Projects board keeps authenticating its deliveries.
		const inherited = await resolveScmCredentialOrNull(
			project,
			sharedScmCredentialProviderFor(project),
			spec.inheritsSharedCredential,
		);
		if (inherited) return inherited;
	}

	return configured ? process.env[spec.envVarKey] || null : null;
}

/**
 * Thrown by {@link requirePmCredential} when a declared PM role resolves to
 * nothing. A distinct type rather than a bare `Error` because two surfaces have to
 * *recognize* this case and not merely report it: the discovery API turns it into
 * an actionable `PRECONDITION_FAILED` naming the role to configure
 * (`src/api/routers/pm.ts`), and the dashboard renders the "configure this
 * credential" affordance off that code. Matching on message text would break the
 * moment the wording changed (issue #537).
 *
 * It carries the role's declared metadata — never the credential — so a caller can
 * name what is missing without re-resolving the manifest.
 */
export class MissingPmCredentialError extends Error {
	readonly name = 'MissingPmCredentialError';

	constructor(
		readonly projectId: string,
		readonly role: string,
		readonly label: string,
		readonly envVarKey: string,
		message: string,
	) {
		super(message);
	}
}

/**
 * Resolve a PM-provider credential, throwing when it resolves to nothing — the
 * `require`-shaped twin of {@link resolvePmCredential} for the provider operations
 * that cannot run without it, worded like {@link getPersonaToken} so the message
 * names both the role and the ways it can be supplied.
 *
 * It never falls back to an SCM credential — in particular not to the worker-local
 * operator token (`SWARM_OPERATOR_GH_TOKEN`), which is a source-control identity
 * (issue #537). A project whose board credential is unconfigured fails here,
 * loudly, rather than silently borrowing whichever token the host happens to hold.
 */
export async function requirePmCredential(project: ProjectConfig, role: string): Promise<string> {
	const secret = await resolvePmCredential(project, role);
	if (!secret) {
		const spec = requireProjectPMCredentialRole(project, role);
		throw new MissingPmCredentialError(
			project.id,
			role,
			spec.label,
			spec.envVarKey,
			`No PM ${spec.label} (role '${role}') configured for project '${project.id}' ` +
				`(set credentials.pm.${role} to a stored reference; ${spec.envVarKey} is its conventional config-apply key)`,
		);
	}
	return secret;
}

/**
 * Resolve a persona's GitHub token for a project. Throws if it resolves to no
 * token — an operation that needs a persona token but has none configured is a
 * deployment error, not a soft "not found" (ai/CODING_STANDARDS.md "Error
 * handling"). The message points at the persona's actual source: the operator
 * env var for the implementer, and — via {@link requireScmCredential} — GitHub's own
 * per-provider credential reference for the reviewer.
 */
export async function getPersonaToken(
	project: ProjectConfig,
	persona: ScmPersona,
): Promise<string> {
	if (persona === 'implementer') {
		const token = await getOperatorGitHubTokenOrNull();
		if (token) return token;
		throw new Error(
			`No GitHub implementer token configured: set ${OPERATOR_GH_TOKEN_ENV} on this host ` +
				"(the worker operator's own token; never stored in project_credentials)",
		);
	}
	return requireScmCredential(project, 'github', persona);
}
