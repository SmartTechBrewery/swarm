/**
 * Pure helpers for the project Credentials screen (issue #85). The stateful
 * query/verify logic lives in the panel component; the display projections and
 * the loop-prevention comparison are factored out here so they can be unit
 * tested without a rendered-component harness (dashboard tests run in a node env — see
 * `dashboard/vitest.config.ts`), mirroring the `board-mapping.ts`/`.test.ts` split.
 */

import type { ScmCredentialReferences } from '../../../src/config/schema.js';
import type { ScmType } from '../../../src/scm/types.js';

/**
 * The credential references this screen edits — derived from the Zod-owned
 * `ScmCredentialReferencesSchema` (`src/config/schema.ts`) per "Zod is the source of
 * truth" (`ai/CODING_STANDARDS.md`), so adding/removing a role in the schema
 * surfaces here as a type error. The actual env-var keys are project-configured and
 * come from `projects.credentials.list`; the role is the stable discriminator.
 *
 * The shared SCM references, not the whole `credentials` block: the PM provider's
 * own roles (`credentials.pm`, issue #497) are declared per provider on its manifest
 * and configured in `swarm.config.json` — this tab has no UI for them, and
 * `credentials.list` excludes them for the same reason.
 */
export type CredentialRole = keyof ScmCredentialReferences;

/** One entry from `projects.credentials.list` (see `src/api/routers/credentials.ts`). */
export interface CredentialEntry {
	role: CredentialRole;
	envVarKey: string;
	isConfigured: boolean;
	maskedValue: string;
}

export const CREDENTIAL_ROLE_LABELS: Record<CredentialRole, string> = {
	reviewer: 'Reviewer PAT',
	webhookSecret: 'Webhook Secret',
};

export const CREDENTIAL_ROLE_DESCRIPTIONS: Record<CredentialRole, string> = {
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
	roleDescriptions: Record<CredentialRole, string>;
	/** Shown under a verifiable field when the provider's verify procedure resolves invalid. */
	verifyFailureMessage: string;
}

/**
 * Bitbucket Cloud's wording for the two shared credential references. The roles
 * themselves are provider-neutral (issue #290 — a Bitbucket project reuses
 * `reviewer` / `webhookSecret` rather than getting its own), so only the copy
 * differs.
 */
const BITBUCKET_ROLE_DESCRIPTIONS: Record<CredentialRole, string> = {
	reviewer:
		'Bitbucket app password as "username:app_password", which the reviewer persona reviews with. Must resolve to a different Bitbucket account than the worker operator (the implementer identity) for loop prevention to work. Grant it the email scope so its commits are attributed rather than landing on a noreply address.',
	webhookSecret:
		'HMAC secret Bitbucket signs webhook deliveries with, sent as X-Hub-Signature. A hook configured without one is rejected: SWARM fails closed rather than trusting an unsigned delivery.',
};

/**
 * GitLab's wording for the same two shared references. The webhook line differs in
 * kind rather than in phrasing: GitLab echoes the secret verbatim in
 * `X-Gitlab-Token` instead of signing the body, so the copy says what the operator
 * is configuring — a secret token, not an HMAC key (see
 * `src/integrations/scm/gitlab/webhook.ts`).
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
			"The reviewer persona authenticates to GitHub with this project-scoped token. The implementer persona uses the worker operator's own token, configured on each host as the SWARM_OPERATOR_GH_TOKEN environment variable — not here — so its pull requests are attributed to the operator's account, distinct from the reviewer. Verify the PAT to confirm the account it resolves to before saving. Secrets are stored encrypted and only ever shown as a masked preview.",
		roleDescriptions: CREDENTIAL_ROLE_DESCRIPTIONS,
		verifyFailureMessage: 'Token did not resolve to a GitHub account. Check it and try again.',
	},
	bitbucket: {
		intro:
			"The reviewer persona authenticates to Bitbucket Cloud with this project-scoped app password. The implementer persona uses the worker operator's own credential, configured on each host as the SWARM_OPERATOR_BITBUCKET_TOKEN environment variable — not here — so its pull requests are attributed to the operator's account, distinct from the reviewer. Point the repository's webhook at /bitbucket/webhook and give it the secret below. Verify the app password to confirm the account it resolves to before saving. Secrets are stored encrypted and only ever shown as a masked preview.",
		roleDescriptions: BITBUCKET_ROLE_DESCRIPTIONS,
		verifyFailureMessage:
			'Credential did not resolve to a Bitbucket account. It must be a "username:app_password" pair — a workspace or repository access token cannot resolve an identity.',
	},
	gitlab: {
		intro:
			"The reviewer persona authenticates to gitlab.com with this project-scoped access token. The implementer persona uses the worker operator's own token, configured on each host as the SWARM_OPERATOR_GITLAB_TOKEN environment variable — not here — so its merge requests are attributed to the operator's account, distinct from the reviewer. Point the project's webhook at /gitlab/webhook, enable its merge request, comment, and pipeline events, and give it the secret token below. Verify the token to confirm the account it resolves to before saving. Secrets are stored encrypted and only ever shown as a masked preview.",
		roleDescriptions: GITLAB_ROLE_DESCRIPTIONS,
		verifyFailureMessage:
			'Token did not resolve to a GitLab account. It needs the api scope, and only gitlab.com is supported — a self-managed host cannot be verified.',
	},
};

/** Project the selected provider onto the Source Control tab's display copy. */
export function getScmProviderCopy(providerId: ScmProviderId): ScmProviderCopy {
	return SCM_PROVIDER_COPY[providerId];
}

/**
 * Whether a role's secret maps to a provider identity and can be verified through
 * that provider's `scm.verify…` procedure. The webhook secret is an HMAC secret,
 * not a token, so it has no login to resolve and no Verify affordance — true of
 * all three providers, which is why this takes no provider id.
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
