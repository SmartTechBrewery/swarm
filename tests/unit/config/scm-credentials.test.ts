/**
 * The pure per-provider SCM credential helpers (issue #628) — the adoption normalizer
 * that keeps a pre-#628 config working, and the reference lookup both the resolver and
 * the API layer read.
 *
 * Deliberately registry-free: this module is a leaf, so nothing here loads
 * `src/integrations/entrypoint.js`. The manifest-facing halves are asserted in
 * `provider.test.ts` (resolution) and `scm-conformance.test.ts` (declarations).
 */

import { describe, expect, it } from 'vitest';
import type { Credentials } from '@/config/schema.js';
import {
	adoptLegacyScmCredentials,
	LEGACY_SCM_CREDENTIAL_PROVIDER,
	listScmCredentialReferences,
	scmCredentialReferenceFor,
	sharedScmCredentialProviderFor,
} from '@/config/scm-credentials.js';
import type { ScmType } from '@/scm/types.js';

/** A project shaped just enough for the helpers — no schema parse, no registry. */
function project(scm: ScmType | undefined, credentials: Credentials) {
	return { ...(scm ? { scm } : {}), credentials };
}

describe('adoptLegacyScmCredentials', () => {
	it('files the legacy pair under the provider the project runs on', () => {
		const adopted = adoptLegacyScmCredentials(
			project('gitlab', { reviewer: 'REV_KEY', webhookSecret: 'HOOK_KEY' }),
		);

		expect(adopted.credentials.scm).toEqual({
			gitlab: { reviewer: 'REV_KEY', webhookSecret: 'HOOK_KEY' },
		});
	});

	// A project naming no provider has not resolved one since issue #618, and before #618
	// GitHub was the only runtime-ready provider — so GitHub is the one safe attribution.
	it('attributes an unstated scm to github', () => {
		const adopted = adoptLegacyScmCredentials(
			project(undefined, { reviewer: 'REV_KEY', webhookSecret: 'HOOK_KEY' }),
		);

		expect(adopted.credentials.scm).toEqual({
			github: { reviewer: 'REV_KEY', webhookSecret: 'HOOK_KEY' },
		});
		expect(LEGACY_SCM_CREDENTIAL_PROVIDER).toBe('github');
	});

	// Never a copy per provider: that would be the fallback chain this issue removes.
	it('writes a reference for the adopting provider only', () => {
		const adopted = adoptLegacyScmCredentials(
			project('bitbucket', { reviewer: 'REV_KEY', webhookSecret: 'HOOK_KEY' }),
		);

		expect(Object.keys(adopted.credentials.scm ?? {})).toEqual(['bitbucket']);
	});

	it('adopts a half-configured legacy pair without inventing the missing role', () => {
		const adopted = adoptLegacyScmCredentials(project('github', { reviewer: 'REV_KEY' }));

		expect(adopted.credentials.scm).toEqual({ github: { reviewer: 'REV_KEY' } });
	});

	it('leaves a project that already has credentials.scm untouched', () => {
		const existing = { github: { reviewer: 'PER_PROVIDER_KEY' } };
		const adopted = adoptLegacyScmCredentials(
			project('github', { reviewer: 'LEGACY_KEY', webhookSecret: 'LEGACY_HOOK', scm: existing }),
		);

		expect(adopted.credentials.scm).toEqual(existing);
	});

	it('is idempotent', () => {
		const once = adoptLegacyScmCredentials(
			project('github', { reviewer: 'REV_KEY', webhookSecret: 'HOOK_KEY' }),
		);
		const twice = adoptLegacyScmCredentials(once);

		expect(twice.credentials.scm).toEqual({
			github: { reviewer: 'REV_KEY', webhookSecret: 'HOOK_KEY' },
		});
	});

	it('does nothing for a project that carries no references at all', () => {
		expect(adoptLegacyScmCredentials(project('github', {})).credentials.scm).toBeUndefined();
	});

	/**
	 * The case the whole naming decision turns on: the secret is stored in
	 * `project_credentials` under the *reference* the project already names, so rewriting
	 * it to the manifest's conventional `envVarKey` would point at a row that does not
	 * exist. Every project created since issue #290 holds the neutral `SCM_*` names, so
	 * this is the common case, not an edge one.
	 */
	it('preserves the reference name verbatim rather than renaming it to the manifest key', () => {
		const adopted = adoptLegacyScmCredentials(
			project('github', { reviewer: 'SCM_TOKEN_REVIEWER', webhookSecret: 'SCM_WEBHOOK_SECRET' }),
		);

		expect(adopted.credentials.scm?.github).toEqual({
			reviewer: 'SCM_TOKEN_REVIEWER',
			webhookSecret: 'SCM_WEBHOOK_SECRET',
		});
		expect(JSON.stringify(adopted)).not.toContain('GITHUB_TOKEN_REVIEWER');
	});
});

describe('sharedScmCredentialProviderFor', () => {
	it('is the stated provider when there is one', () => {
		expect(sharedScmCredentialProviderFor({ scm: 'bitbucket' })).toBe('bitbucket');
	});

	it('is github when the project states none', () => {
		expect(sharedScmCredentialProviderFor({})).toBe('github');
	});
});

describe('scmCredentialReferenceFor', () => {
	const multi = project('gitlab', {
		scm: {
			github: { reviewer: 'GH_REVIEWER', webhookSecret: 'GH_HOOK' },
			gitlab: { reviewer: 'GL_REVIEWER' },
		},
	});

	it('reads the reference for exactly the (provider, role) asked for', () => {
		expect(scmCredentialReferenceFor(multi, 'github', 'reviewer')).toBe('GH_REVIEWER');
		expect(scmCredentialReferenceFor(multi, 'gitlab', 'reviewer')).toBe('GL_REVIEWER');
	});

	it('is undefined for a role the named provider has no reference for', () => {
		expect(scmCredentialReferenceFor(multi, 'gitlab', 'webhookSecret')).toBeUndefined();
	});

	it('is undefined for a provider the project stores nothing for', () => {
		expect(scmCredentialReferenceFor(multi, 'bitbucket', 'reviewer')).toBeUndefined();
	});
});

describe('listScmCredentialReferences', () => {
	it('lists every reference across every provider, for `swarm config apply` to store', () => {
		const references = listScmCredentialReferences(
			project('gitlab', {
				scm: {
					github: { reviewer: 'GH_REVIEWER', webhookSecret: 'GH_HOOK' },
					gitlab: { reviewer: 'GL_REVIEWER', webhookSecret: 'GL_HOOK' },
				},
			}),
		);

		expect(references.sort()).toEqual(['GH_HOOK', 'GH_REVIEWER', 'GL_HOOK', 'GL_REVIEWER']);
	});

	it('is empty for a project with no per-provider references', () => {
		expect(listScmCredentialReferences(project('github', { reviewer: 'LEGACY' }))).toEqual([]);
	});
});
