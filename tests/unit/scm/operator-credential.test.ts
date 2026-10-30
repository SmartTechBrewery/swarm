import { describe, expect, it } from 'vitest';

import {
	requireScopedOperatorCredential,
	scopedOperatorCredential,
	withOperatorCredential,
} from '@/scm/operator-credential.js';

describe('operator credential scope (issue #1249)', () => {
	it('has no implementer credential outside a scope', () => {
		expect(scopedOperatorCredential()).toBeNull();
		expect(() => requireScopedOperatorCredential('GitLab')).toThrow(
			'No GitLab implementer credential is in scope',
		);
	});

	it('binds the credential for the scope and nothing past it', async () => {
		await expect(
			withOperatorCredential('alice-token', async () => requireScopedOperatorCredential('GitHub')),
		).resolves.toBe('alice-token');
		expect(scopedOperatorCredential()).toBeNull();
	});

	it('keeps concurrent scopes apart', async () => {
		const read = (credential: string) =>
			withOperatorCredential(credential, async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
				return scopedOperatorCredential();
			});

		await expect(Promise.all([read('alice-token'), read('bob-token')])).resolves.toEqual([
			'alice-token',
			'bob-token',
		]);
	});

	it('never suggests an environment variable', () => {
		expect(() => requireScopedOperatorCredential('Azure DevOps')).not.toThrow(/SWARM_OPERATOR_/);
	});
});
