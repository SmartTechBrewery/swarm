/**
 * Pure helpers for the project Credentials screen (issue #85). The stateful
 * query/verify logic lives in the panel component; the display projections and
 * the loop-prevention comparison are factored out here so they can be unit
 * tested without a rendered-component harness (dashboard tests run in a node env — see
 * `dashboard/vitest.config.ts`), mirroring the `board-mapping.ts`/`.test.ts` split.
 */

import type { Credentials } from '../../../src/config/schema.js';

/**
 * The credential references a project carries — derived from the Zod-owned
 * `CredentialsSchema` (`src/config/schema.ts`) per "Zod is the source of truth"
 * (`ai/CODING_STANDARDS.md`), so adding/removing a role in the schema surfaces
 * here as a type error. The actual env-var keys are project-configured and come
 * from `projects.credentials.list`; the role is the stable discriminator.
 */
export type CredentialRole = keyof Credentials;

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
	webhookSecret: 'HMAC secret GitHub signs webhook deliveries with. Not tied to a GitHub identity.',
};

/** A source-control provider the Source Control tab's provider selector can offer. */
export type ScmProviderId = 'github';

export interface ScmProviderOption {
	id: ScmProviderId;
	label: string;
	/** Whether this provider has a working integration and can be selected. */
	available: boolean;
}

/**
 * UI-only catalogue backing the Source Control tab's provider selector.
 * GitHub is the only provider with a working integration
 * (`GitHubSCMIntegration`, `scm.verifyGithubToken`) — this list exists so the
 * selector and its copy are data-driven rather than a step toward a shared
 * `SCMProvider` interface (`ai/RULES.md` §2 explicitly defers that).
 */
export const SCM_PROVIDERS: readonly ScmProviderOption[] = [
	{ id: 'github', label: 'GitHub', available: true },
];

export const DEFAULT_SCM_PROVIDER_ID: ScmProviderId = SCM_PROVIDERS[0].id;

/** Provider-facing copy for the Source Control tab, projected off the selected provider. */
export interface ScmProviderCopy {
	/** Introductory paragraph explaining what the credentials are for. */
	intro: string;
	roleDescriptions: Record<CredentialRole, string>;
	/** Shown under a verifiable field when `scm.verifyGithubToken` resolves invalid. */
	verifyFailureMessage: string;
}

const SCM_PROVIDER_COPY: Record<ScmProviderId, ScmProviderCopy> = {
	github: {
		intro:
			"The reviewer persona authenticates to GitHub with this project-scoped token. The implementer persona uses the worker operator's own token, configured on each host as the SWARM_OPERATOR_GH_TOKEN environment variable — not here — so its pull requests are attributed to the operator's account, distinct from the reviewer. Verify the PAT to confirm the account it resolves to before saving. Secrets are stored encrypted and only ever shown as a masked preview.",
		roleDescriptions: CREDENTIAL_ROLE_DESCRIPTIONS,
		verifyFailureMessage: 'Token did not resolve to a GitHub account. Check it and try again.',
	},
};

/** Project the selected provider onto the Source Control tab's display copy. */
export function getScmProviderCopy(providerId: ScmProviderId): ScmProviderCopy {
	return SCM_PROVIDER_COPY[providerId];
}

/**
 * Whether a role's token maps to a GitHub identity and can be verified via
 * `scm.verifyGithubToken`. The webhook secret is an HMAC secret, not a token, so
 * it has no login to resolve and no Verify affordance.
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
