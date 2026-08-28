/**
 * Pure helpers for the project Credentials screen (issue #85). The stateful
 * query/verify logic lives in the panel component; the display projections and
 * the loop-prevention comparison are factored out here so they can be unit
 * tested without a rendered-component harness (dashboard tests run in a node env — see
 * `dashboard/vitest.config.ts`), mirroring the `board-mapping.ts`/`.test.ts` split.
 */

import type { ScmCredentialRole, ScmType } from '../../../src/scm/types.js';

/**
 * The credential roles this screen edits — the contract's own closed pair
 * (`SCM_CREDENTIAL_ROLES`, `src/scm/types.ts`) per "Zod is the source of truth"
 * (`ai/CODING_STANDARDS.md`), so adding or removing a role there surfaces here as a
 * type error. A type-only import, so the bundle gains nothing at runtime.
 *
 * The roles are provider-neutral; what is per provider is each role's *reference
 * name* (declared on `SCMProviderManifest.credentialRoles`, resolved server-side and
 * served by `projects.credentials.list`) and the copy naming it — see
 * {@link ScmProviderCopy}.
 */
export type CredentialRole = ScmCredentialRole;

/** One role from `projects.credentials.list` (see `src/api/routers/credentials.ts`). */
export interface CredentialEntry {
	role: CredentialRole;
	/** The provider's conventional `swarm config apply` key for this role. */
	envVarKey: string;
	/**
	 * The secret-store key this project resolves the role through — the key the screen
	 * names, since it is the only one an operator setting a value can act on. Never a
	 * secret, and never empty: the server falls back to `envVarKey`.
	 */
	referenceKey: string;
	isConfigured: boolean;
	maskedValue: string;
}

/** The `projects.credentials.list` response — one provider's state (issue #632). */
export interface ScmCredentialsView {
	providerId: string;
	providerLabel: string;
	/** `false` when this installation registers no runtime-ready provider for `providerId`. */
	providerRegistered: boolean;
	roles: CredentialEntry[];
}

/** GitHub's own name for each role — see {@link ScmProviderCopy.roleLabels}. */
const GITHUB_ROLE_LABELS: Record<CredentialRole, string> = {
	reviewer: 'Reviewer PAT',
	webhookSecret: 'Webhook Secret',
};

const GITHUB_ROLE_DESCRIPTIONS: Record<CredentialRole, string> = {
	reviewer:
		'GitHub personal access token the reviewer persona reviews with. Must resolve to a different GitHub account than the worker operator (the implementer identity) for loop prevention to work.',
	webhookSecret:
		'HMAC secret GitHub signs webhook deliveries with — repository events and Projects board events alike, since they arrive on one webhook. Not tied to a GitHub identity.',
};

/**
 * A source-control provider the Source Control tab's selector can offer — a
 * subset of the contract's `ScmType`, so a value picked here is exactly what
 * `project.scm` (`src/config/schema.ts`) stores.
 */
export type ScmProviderId = Extract<ScmType, 'github' | 'bitbucket' | 'gitlab'>;

export interface ScmProviderOption {
	id: ScmProviderId;
	label: string;
	/** Whether this provider has a working integration and can be selected. */
	available: boolean;
}

/**
 * Catalogue backing the Source Control tab's provider selector — the values that
 * are **runtime-ready** server-side (`SCMProviderManifest.runtimeReady`), since
 * selecting anything else would only earn the project a loud resolution error.
 * GitHub was alone here until issue #618 made Bitbucket routable and served its
 * ingress; issue #619 did the same for GitLab, so all three registered providers
 * are offered.
 *
 * Deliberately a hand-kept list rather than a registry read: the dashboard is a
 * browser bundle and does not load `src/integrations/entrypoint.js`, so there is no
 * registry in scope to enumerate.
 */
export const SCM_PROVIDERS: readonly ScmProviderOption[] = [
	{ id: 'github', label: 'GitHub', available: true },
	{ id: 'bitbucket', label: 'Bitbucket Cloud', available: true },
	{ id: 'gitlab', label: 'GitLab', available: true },
];

export const DEFAULT_SCM_PROVIDER_ID: ScmProviderId = SCM_PROVIDERS[0].id;

/**
 * Narrow a project's stored `scm` to a provider this screen can render. A project
 * that names nothing predates issue #478's discriminator; one that names a provider
 * the selector doesn't offer — a fourth provider registered but not yet added to
 * {@link SCM_PROVIDERS} — is left unset so the tab never presents GitHub as a value
 * that has not actually been saved.
 */
export function toSelectableScmProvider(scm: string | undefined | null): ScmProviderId | undefined {
	return SCM_PROVIDERS.some((provider) => provider.id === scm) ? (scm as ScmProviderId) : undefined;
}

/** Provider-facing copy for the Source Control tab, projected off the selected provider. */
export interface ScmProviderCopy {
	/** Introductory paragraph explaining what the credentials are for. */
	intro: string;
	/**
	 * What this provider calls each role, used for every label the field renders
	 * (heading, input, remove control, remove confirmation). Per provider because the
	 * roles are neutral but the credentials are not: GitHub's "PAT" is Bitbucket's app
	 * password and GitLab's access token, and GitLab's webhook value is a secret token it
	 * echoes back rather than a key it signs with (issue #632).
	 */
	roleLabels: Record<CredentialRole, string>;
	roleDescriptions: Record<CredentialRole, string>;
	/** Shown under a verifiable field when the provider's verify procedure resolves invalid. */
	verifyFailureMessage: string;
	/**
	 * What this provider calls the **worker operator's own** credential — the identity
	 * a machine commits, pushes and comments as (issue #766). Not a `CredentialRole`:
	 * the operator credential is per `(worker, provider)` and lives in its own store,
	 * so it is deliberately outside the project-scoped role pair above. Per provider
	 * for the same reason the role labels are — GitHub's PAT is Bitbucket's app
	 * password.
	 */
	operatorLabel: string;
	operatorDescription: string;
}

/** Bitbucket Cloud's name for each role — an app password, not a PAT. */
const BITBUCKET_ROLE_LABELS: Record<CredentialRole, string> = {
	reviewer: 'Reviewer App Password',
	webhookSecret: 'Webhook Secret',
};

/**
 * Bitbucket Cloud's wording for the two credential references. The roles themselves
 * are provider-neutral (issue #290 — a Bitbucket project reuses `reviewer` /
 * `webhookSecret` rather than getting its own), and since issue #628 each provider
 * holds its own reference per role, so only the copy differs.
 */
const BITBUCKET_ROLE_DESCRIPTIONS: Record<CredentialRole, string> = {
	reviewer:
		'Bitbucket app password as "username:app_password", which the reviewer persona reviews with. Must resolve to a different Bitbucket account than the worker operator (the implementer identity) for loop prevention to work. Grant it the email scope so its commits are attributed rather than landing on a noreply address.',
	webhookSecret:
		'HMAC secret Bitbucket signs webhook deliveries with, sent as X-Hub-Signature. A hook configured without one is rejected: SWARM fails closed rather than trusting an unsigned delivery.',
};

/**
 * GitLab's name for each role. The webhook one is not a "webhook secret" in GitLab's
 * own vocabulary: it is the secret token GitLab echoes verbatim in `X-Gitlab-Token`
 * rather than an HMAC key it signs the body with.
 */
const GITLAB_ROLE_LABELS: Record<CredentialRole, string> = {
	reviewer: 'Reviewer Access Token',
	webhookSecret: 'Secret Token',
};

/**
 * GitLab's wording for the same two references. The webhook line differs in kind
 * rather than in phrasing: GitLab echoes the secret verbatim in `X-Gitlab-Token`
 * instead of signing the body, so the copy says what the operator is configuring — a
 * secret token, not an HMAC key (see `src/integrations/scm/gitlab/webhook.ts`).
 */
const GITLAB_ROLE_DESCRIPTIONS: Record<CredentialRole, string> = {
	reviewer:
		'GitLab access token (personal, group, or project) the reviewer persona reviews with, needing the api scope. Must resolve to a different GitLab account than the worker operator (the implementer identity) for loop prevention to work, and be an eligible approver on the project. A token whose scope withholds the account email still delivers, but its commits stay unlinked.',
	webhookSecret:
		'Secret token GitLab echoes verbatim in the X-Gitlab-Token header — GitLab does not sign the body, so this authenticates the sender rather than the payload. A hook configured without one is rejected: SWARM fails closed rather than trusting an unauthenticated delivery.',
};

const SCM_PROVIDER_COPY: Record<ScmProviderId, ScmProviderCopy> = {
	github: {
		intro:
			"The reviewer persona authenticates to GitHub with this project-scoped token. The implementer persona uses the worker operator's own token, which is set per worker on that worker's own page — not here — so its pull requests are attributed to the operator's account, distinct from the reviewer. Verify the PAT to confirm the account it resolves to before saving. Secrets are stored encrypted and only ever shown as a masked preview.",
		roleLabels: GITHUB_ROLE_LABELS,
		roleDescriptions: GITHUB_ROLE_DESCRIPTIONS,
		verifyFailureMessage: 'Token did not resolve to a GitHub account. Check it and try again.',
		operatorLabel: 'Operator PAT',
		operatorDescription:
			'GitHub personal access token this machine acts as. Needs repo scope, and must resolve to a different GitHub account than any project\u2019s reviewer PAT for loop prevention to work.',
	},
	bitbucket: {
		intro:
			"The reviewer persona authenticates to Bitbucket Cloud with this project-scoped app password. The implementer persona uses the worker operator's own credential, which is set per worker on that worker's own page — not here — so its pull requests are attributed to the operator's account, distinct from the reviewer. Point the repository's webhook at /bitbucket/webhook and give it the secret below. Verify the app password to confirm the account it resolves to before saving. Secrets are stored encrypted and only ever shown as a masked preview.",
		roleLabels: BITBUCKET_ROLE_LABELS,
		roleDescriptions: BITBUCKET_ROLE_DESCRIPTIONS,
		verifyFailureMessage:
			'Credential did not resolve to a Bitbucket account. It must be a "username:app_password" pair — a workspace or repository access token cannot resolve an identity.',
		operatorLabel: 'Operator App Password',
		operatorDescription:
			'Bitbucket app password this machine acts as, as "username:app_password" — the only form that resolves an account. Must resolve to a different Bitbucket account than any project\u2019s reviewer credential for loop prevention to work. Grant it the email scope so its commits are attributed rather than landing on a noreply address.',
	},
	gitlab: {
		intro:
			"The reviewer persona authenticates to gitlab.com with this project-scoped access token. The implementer persona uses the worker operator's own token, which is set per worker on that worker's own page — not here — so its merge requests are attributed to the operator's account, distinct from the reviewer. Point the project's webhook at /gitlab/webhook, enable its merge request, comment, and pipeline events, and give it the secret token below. Verify the token to confirm the account it resolves to before saving. Secrets are stored encrypted and only ever shown as a masked preview.",
		roleLabels: GITLAB_ROLE_LABELS,
		roleDescriptions: GITLAB_ROLE_DESCRIPTIONS,
		verifyFailureMessage:
			'Token did not resolve to a GitLab account. It needs the api scope, and only gitlab.com is supported — a self-managed host cannot be verified.',
		operatorLabel: 'Operator Access Token',
		operatorDescription:
			'GitLab access token (personal, group, or project) this machine acts as, needing the api scope. Must resolve to a different GitLab account than any project\u2019s reviewer token for loop prevention to work. A token whose scope withholds the account email still delivers, but its commits stay unlinked.',
	},
};

/** Project the selected provider onto the Source Control tab's display copy. */
export function getScmProviderCopy(providerId: ScmProviderId): ScmProviderCopy {
	return SCM_PROVIDER_COPY[providerId];
}

/**
 * Whether a role's secret maps to a provider identity and can be verified through
 * that provider's `scm.verify…` procedure. The webhook role's secret authenticates a
 * delivery rather than an account — an HMAC key for GitHub and Bitbucket, an echoed
 * token for GitLab — so it has no login to resolve and no Verify affordance, which is
 * true of all three providers and why this takes no provider id.
 */
export function isVerifiableRole(role: CredentialRole): boolean {
	return role === 'reviewer';
}

/**
 * Render the collapsed preview for a configured credential. Every configured
 * credential collapses to this same fixed marker — the input is intentionally
 * ignored (not parsed for a trailing suffix) so a legacy or stale server
 * response carrying a last-4 fragment (e.g. `****abcd`) still can't disclose
 * any part of the secret to the DOM.
 */
export function maskedPreview(_maskedValue: string): string {
	return '••••';
}
