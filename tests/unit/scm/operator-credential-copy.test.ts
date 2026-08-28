import { describe, expect, it } from 'vitest';
import {
	operatorCredentialCopyFor,
	SCM_OPERATOR_CREDENTIAL_COPY,
} from '@/scm/operator-credential-copy.js';
import { SCM_TYPES } from '@/scm/types.js';

/**
 * The catalogue both the dashboard's operator-credential card and
 * `swarm workers set-scm-credential` name the worker operator's own secret from
 * (issue #807). What is worth asserting here is the *lookup*: the operator CLI is
 * handed a provider id as a bare string by the control plane.
 */
describe('SCM_OPERATOR_CREDENTIAL_COPY', () => {
	it('names a credential type and a heading for every SCM provider', () => {
		for (const providerId of SCM_TYPES) {
			const copy = SCM_OPERATOR_CREDENTIAL_COPY[providerId];
			expect(copy.credentialType.length, providerId).toBeGreaterThan(0);
			expect(copy.label, providerId).toContain('Operator');
		}
	});

	// GitHub's PAT is Bitbucket's app password and GitLab's access token — the whole
	// reason the prompt states it rather than the provider id alone.
	it('gives each provider its own credential type, not a shared one', () => {
		const types = SCM_TYPES.map((id) => SCM_OPERATOR_CREDENTIAL_COPY[id].credentialType);
		expect(new Set(types).size).toBe(SCM_TYPES.length);
	});
});

describe('operatorCredentialCopyFor', () => {
	it('resolves a provider id that arrived as a bare string', () => {
		expect(operatorCredentialCopyFor('github')?.credentialType).toBe('Personal Access Token');
		expect(operatorCredentialCopyFor('bitbucket')?.credentialType).toBe('App Password');
		expect(operatorCredentialCopyFor('gitlab')?.credentialType).toBe('Access Token');
	});

	// A provider the control plane's registry resolves but this catalogue does not name
	// yet: a caller must be able to say less rather than say GitHub's words about it.
	it('answers undefined for a provider it has no wording for', () => {
		expect(operatorCredentialCopyFor('perforce')).toBeUndefined();
		expect(operatorCredentialCopyFor('')).toBeUndefined();
	});
});
