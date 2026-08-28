import { describe, expect, it } from 'vitest';
import { SCM_OPERATOR_CREDENTIAL_COPY } from '../../../src/scm/operator-credential-copy.js';
import {
	DEFAULT_SCM_PROVIDER_ID,
	getScmProviderCopy,
	isVerifiableRole,
	maskedPreview,
	SCM_PROVIDERS,
	toSelectableScmProvider,
} from './credentials.js';

describe('isVerifiableRole', () => {
	it('marks the reviewer PAT role verifiable', () => {
		expect(isVerifiableRole('reviewer')).toBe(true);
	});

	it('does not mark the webhook secret verifiable', () => {
		expect(isVerifiableRole('webhookSecret')).toBe(false);
	});
});

describe('maskedPreview', () => {
	it('renders the fixed dot marker for a configured value', () => {
		expect(maskedPreview('****')).toBe('••••');
	});

	it('ignores a legacy mask carrying a last-4 suffix and never discloses it', () => {
		const result = maskedPreview('****abcd');
		expect(result).toBe('••••');
		expect(result).not.toContain('abcd');
	});
});

describe('SCM_PROVIDERS', () => {
	// The list mirrors the server's runtime-ready manifests: offering a provider a
	// project cannot resolve would only earn the operator a loud lookup error.
	// Bitbucket joined with issue #618 and GitLab with #619, so all three registered
	// providers are offered.
	it('lists exactly the providers a project can be routed to', () => {
		expect(SCM_PROVIDERS).toEqual([
			{ id: 'github', label: 'GitHub', available: true },
			{ id: 'bitbucket', label: 'Bitbucket Cloud', available: true },
			{ id: 'gitlab', label: 'GitLab', available: true },
		]);
	});

	it('defaults the selected provider to GitHub', () => {
		expect(DEFAULT_SCM_PROVIDER_ID).toBe('github');
	});
});

describe('toSelectableScmProvider', () => {
	it('keeps a stored provider this screen can render', () => {
		expect(toSelectableScmProvider('bitbucket')).toBe('bitbucket');
	});

	it('keeps GitLab now that the selector offers it', () => {
		expect(toSelectableScmProvider('gitlab')).toBe('gitlab');
	});

	// A project predating issue #478's discriminator names nothing; one naming a
	// provider the selector does not offer must not crash the tab on an unknown key.
	it('leaves an unset or unoffered provider unselected', () => {
		expect(toSelectableScmProvider(undefined)).toBeUndefined();
		expect(toSelectableScmProvider('gerrit')).toBeUndefined();
	});
});

describe('getScmProviderCopy', () => {
	const copy = getScmProviderCopy('github');

	it('projects GitHub-specific role descriptions', () => {
		expect(copy.roleDescriptions.reviewer).toMatch(/GitHub personal access token/);
		expect(copy.roleDescriptions.webhookSecret).toMatch(/HMAC secret/);
	});

	it('labels the roles in GitHub’s own vocabulary', () => {
		expect(copy.roleLabels).toEqual({ reviewer: 'Reviewer PAT', webhookSecret: 'Webhook Secret' });
	});

	it('projects the verify-failure copy', () => {
		expect(copy.verifyFailureMessage).toMatch(/GitHub account/);
	});

	// Issue #766 retired the env var this used to name: the operator credential is now
	// per worker, set on that worker's own page, so the intro must point there.
	it('points the implementer identity at the worker’s own page, not an env var', () => {
		expect(copy.intro).toMatch(/set per worker on that worker's own page/);
		expect(copy.intro).not.toMatch(/SWARM_OPERATOR/);
	});

	it('names the operator credential in GitHub’s own vocabulary', () => {
		expect(copy.operatorLabel).toBe('Operator PAT');
		expect(copy.operatorDescription).toMatch(/personal access token this machine acts as/);
	});
});

describe('getScmProviderCopy — Bitbucket', () => {
	const copy = getScmProviderCopy('bitbucket');

	it('names Bitbucket’s own credential form rather than GitHub’s', () => {
		expect(copy.roleDescriptions.reviewer).toMatch(/username:app_password/);
		expect(copy.verifyFailureMessage).toMatch(/Bitbucket account/);
	});

	// "Reviewer PAT" is GitHub's word for what Bitbucket calls an app password (issue
	// #632): the role is neutral, the credential is not.
	it('labels the reviewer role an app password, not a PAT', () => {
		expect(copy.roleLabels).toEqual({
			reviewer: 'Reviewer App Password',
			webhookSecret: 'Webhook Secret',
		});
	});

	it('points at the worker’s own page and Bitbucket’s ingress route', () => {
		expect(copy.intro).toMatch(/set per worker on that worker's own page/);
		expect(copy.intro).not.toMatch(/SWARM_OPERATOR/);
		expect(copy.intro).toMatch(/\/bitbucket\/webhook/);
	});

	// The operator credential is an app password here too — and the pair form is what
	// resolves an account, so the copy has to say so (issue #766).
	it('names the operator credential an app password in pair form', () => {
		expect(copy.operatorLabel).toBe('Operator App Password');
		expect(copy.operatorDescription).toMatch(/username:app_password/);
	});
});

describe('getScmProviderCopy — GitLab', () => {
	const copy = getScmProviderCopy('gitlab');

	// The webhook secret differs in kind here, not just in wording: GitLab echoes the
	// token rather than signing the body, so the copy must not promise an HMAC.
	it('describes a secret token rather than an HMAC signature', () => {
		expect(copy.roleDescriptions.webhookSecret).toMatch(/X-Gitlab-Token/);
		expect(copy.roleDescriptions.webhookSecret).not.toMatch(/HMAC/);
	});

	it('names the api scope the reviewer token needs', () => {
		expect(copy.roleDescriptions.reviewer).toMatch(/api scope/);
		expect(copy.verifyFailureMessage).toMatch(/GitLab account/);
	});

	it('points at the worker’s own page and GitLab’s ingress route', () => {
		expect(copy.intro).toMatch(/set per worker on that worker's own page/);
		expect(copy.intro).not.toMatch(/SWARM_OPERATOR/);
		expect(copy.intro).toMatch(/\/gitlab\/webhook/);
	});

	it('names the operator credential an access token needing the api scope', () => {
		expect(copy.operatorLabel).toBe('Operator Access Token');
		expect(copy.operatorDescription).toMatch(/api scope/);
	});

	// GitLab has neither a PAT nor a signing secret: an access token, and a secret token
	// it echoes back in a header.
	it('labels the roles an access token and a secret token', () => {
		expect(copy.roleLabels).toEqual({
			reviewer: 'Reviewer Access Token',
			webhookSecret: 'Secret Token',
		});
	});
});

// The cheap guard that keeps one provider's vocabulary from creeping into another's
// copy — "Reviewer PAT" for a Bitbucket app password is the symptom issue #632 reports.
describe('per-provider credential copy', () => {
	const ROLES = ['reviewer', 'webhookSecret'] as const;

	it('gives every provider a non-empty label for every role', () => {
		for (const provider of SCM_PROVIDERS) {
			const { roleLabels } = getScmProviderCopy(provider.id);
			for (const role of ROLES) {
				expect(roleLabels[role]?.length, `${provider.id}.${role}`).toBeGreaterThan(0);
			}
		}
	});

	it('names no other provider in any label or role description', () => {
		const BRANDS = ['github', 'bitbucket', 'gitlab'] as const;
		for (const provider of SCM_PROVIDERS) {
			const copy = getScmProviderCopy(provider.id);
			const text = ROLES.flatMap((role) => [copy.roleLabels[role], copy.roleDescriptions[role]])
				.join(' ')
				.toLowerCase();
			for (const brand of BRANDS.filter((brand) => brand !== provider.id)) {
				expect(text, `${provider.id} copy mentions ${brand}`).not.toContain(brand);
			}
		}
	});

	it('keeps each provider’s own credential noun out of the others’ labels', () => {
		const FOREIGN_NOUNS: Record<string, readonly string[]> = {
			github: ['app password', 'secret token'],
			bitbucket: ['pat', 'access token'],
			gitlab: ['pat', 'app password'],
		};
		for (const provider of SCM_PROVIDERS) {
			const labels = ROLES.map((role) => getScmProviderCopy(provider.id).roleLabels[role])
				.join(' ')
				.toLowerCase();
			for (const noun of FOREIGN_NOUNS[provider.id] ?? []) {
				expect(labels, `${provider.id} labels use ${noun}`).not.toContain(noun);
			}
		}
	});
});

/**
 * The operator credential is the one label here that is *not* hand-kept per screen:
 * `swarm workers set-scm-credential` names the same secret in its prompt, so both
 * project off `SCM_OPERATOR_CREDENTIAL_COPY` (issue #807). This is the assertion that
 * stops a future edit from re-inlining a string here and letting the two drift.
 */
describe('getScmProviderCopy — the operator credential label', () => {
	it('is projected off the shared per-provider catalogue for every provider', () => {
		for (const provider of SCM_PROVIDERS) {
			expect(getScmProviderCopy(provider.id).operatorLabel).toBe(
				SCM_OPERATOR_CREDENTIAL_COPY[provider.id].label,
			);
		}
	});
});
