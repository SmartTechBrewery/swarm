import { describe, expect, it } from 'vitest';
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
	// Bitbucket joined with issue #618; GitLab joins with #619.
	it('lists exactly the providers a project can be routed to', () => {
		expect(SCM_PROVIDERS).toEqual([
			{ id: 'github', label: 'GitHub', available: true },
			{ id: 'bitbucket', label: 'Bitbucket Cloud', available: true },
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

	// A project predating issue #478's discriminator names nothing; one naming a
	// provider the selector does not offer must not crash the tab on an unknown key.
	it('leaves an unset or unoffered provider unselected', () => {
		expect(toSelectableScmProvider(undefined)).toBeUndefined();
		expect(toSelectableScmProvider('gitlab')).toBeUndefined();
	});
});

describe('getScmProviderCopy', () => {
	const copy = getScmProviderCopy('github');

	it('projects GitHub-specific role descriptions', () => {
		expect(copy.roleDescriptions.reviewer).toMatch(/GitHub personal access token/);
		expect(copy.roleDescriptions.webhookSecret).toMatch(/HMAC secret/);
	});

	it('projects the verify-failure copy', () => {
		expect(copy.verifyFailureMessage).toMatch(/GitHub account/);
	});

	it('explains the implementer token is the operator env var, not a project credential', () => {
		expect(copy.intro).toMatch(/SWARM_OPERATOR_GH_TOKEN/);
	});
});

describe('getScmProviderCopy — Bitbucket', () => {
	const copy = getScmProviderCopy('bitbucket');

	it('names Bitbucket’s own credential form rather than GitHub’s', () => {
		expect(copy.roleDescriptions.reviewer).toMatch(/username:app_password/);
		expect(copy.verifyFailureMessage).toMatch(/Bitbucket account/);
	});

	it('points at Bitbucket’s own operator env var and ingress route', () => {
		expect(copy.intro).toMatch(/SWARM_OPERATOR_BITBUCKET_TOKEN/);
		expect(copy.intro).toMatch(/\/bitbucket\/webhook/);
	});
});
