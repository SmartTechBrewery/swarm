import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	getOperatorGitHubToken,
	getOperatorGitHubTokenOrNull,
	OPERATOR_GH_TOKEN_ENV,
} from '@/config/operator-token.js';

describe('operator GitHub token (SWARM_OPERATOR_GH_TOKEN)', () => {
	beforeEach(() => {
		delete process.env[OPERATOR_GH_TOKEN_ENV];
	});

	afterEach(() => {
		delete process.env[OPERATOR_GH_TOKEN_ENV];
	});

	describe('getOperatorGitHubTokenOrNull', () => {
		it('returns the trimmed token when set', () => {
			process.env[OPERATOR_GH_TOKEN_ENV] = '  ghp_operator  ';
			expect(getOperatorGitHubTokenOrNull()).toBe('ghp_operator');
		});

		it('returns null when unset', () => {
			expect(getOperatorGitHubTokenOrNull()).toBeNull();
		});

		it('returns null when empty or whitespace-only', () => {
			process.env[OPERATOR_GH_TOKEN_ENV] = '   ';
			expect(getOperatorGitHubTokenOrNull()).toBeNull();
		});
	});

	describe('getOperatorGitHubToken', () => {
		it('returns the token when set', () => {
			process.env[OPERATOR_GH_TOKEN_ENV] = 'ghp_operator';
			expect(getOperatorGitHubToken()).toBe('ghp_operator');
		});

		it('throws an actionable error naming the env var when unset', () => {
			expect(() => getOperatorGitHubToken()).toThrow(/SWARM_OPERATOR_GH_TOKEN/);
		});
	});
});
