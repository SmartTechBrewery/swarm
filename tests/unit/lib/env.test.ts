import { describe, expect, it, vi } from 'vitest';
import {
	assertTransportDispatchMode,
	isSingleUserMode,
	optionalEnv,
	requireEnv,
	resolveOperatorGitHubToken,
	resolveWebhookCallbackBaseUrl,
	resolveWorkerRepoRoot,
} from '@/lib/env.js';

describe('requireEnv', () => {
	it('returns the value when the variable is set', () => {
		vi.stubEnv('SWARM_TEST_VAR', 'hello');
		expect(requireEnv('SWARM_TEST_VAR')).toBe('hello');
	});

	it('throws when the variable is unset', () => {
		vi.stubEnv('SWARM_TEST_VAR', '');
		expect(() => requireEnv('SWARM_TEST_VAR')).toThrow(/Missing required environment variable/);
	});
});

describe('optionalEnv', () => {
	it('returns the value when set', () => {
		vi.stubEnv('SWARM_TEST_VAR', 'set');
		expect(optionalEnv('SWARM_TEST_VAR', 'fallback')).toBe('set');
	});

	it('returns the fallback when unset', () => {
		vi.stubEnv('SWARM_TEST_VAR', '');
		expect(optionalEnv('SWARM_TEST_VAR', 'fallback')).toBe('fallback');
	});
});

describe('isSingleUserMode', () => {
	it('is enabled only for the literal "true"', () => {
		vi.stubEnv('SWARM_SINGLE_USER_MODE', 'true');
		expect(isSingleUserMode()).toBe(true);
	});

	it('is disabled when unset (the coded default keeps multi-user auth)', () => {
		vi.stubEnv('SWARM_SINGLE_USER_MODE', '');
		expect(isSingleUserMode()).toBe(false);
	});

	it('is disabled for any other value', () => {
		for (const value of ['false', '1', 'yes', 'TRUE', 'on']) {
			vi.stubEnv('SWARM_SINGLE_USER_MODE', value);
			expect(isSingleUserMode()).toBe(false);
		}
	});
});

describe('resolveWebhookCallbackBaseUrl', () => {
	it('reads WEBHOOK_CALLBACK_BASE_URL', () => {
		vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', 'https://swarm.example.com');
		expect(resolveWebhookCallbackBaseUrl()).toBe('https://swarm.example.com');
	});

	it('is undefined when unset or whitespace-only', () => {
		vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', '');
		expect(resolveWebhookCallbackBaseUrl()).toBeUndefined();
		expect(resolveWebhookCallbackBaseUrl('   ')).toBeUndefined();
	});

	// A route path is concatenated onto it, and the signed string must match the
	// provider's byte for byte.
	it('trims trailing slashes so a route path concatenates cleanly', () => {
		expect(resolveWebhookCallbackBaseUrl('https://swarm.example.com//')).toBe(
			'https://swarm.example.com',
		);
	});
});

describe('resolveOperatorGitHubToken', () => {
	it('returns the value when passed directly', () => {
		expect(resolveOperatorGitHubToken('ghp_x')).toBe('ghp_x');
	});

	it('reads SWARM_OPERATOR_GH_TOKEN when no argument is given', () => {
		vi.stubEnv('SWARM_OPERATOR_GH_TOKEN', 'ghp_env');
		expect(resolveOperatorGitHubToken()).toBe('ghp_env');
	});

	it('trims surrounding whitespace', () => {
		expect(resolveOperatorGitHubToken('  ghp_x  ')).toBe('ghp_x');
	});

	it('throws when unset (empty string)', () => {
		expect(() => resolveOperatorGitHubToken('')).toThrow(
			/Missing required environment variable: SWARM_OPERATOR_GH_TOKEN/,
		);
	});

	it('throws for a whitespace-only value', () => {
		expect(() => resolveOperatorGitHubToken('   ')).toThrow(
			/Missing required environment variable: SWARM_OPERATOR_GH_TOKEN/,
		);
	});
});

describe('resolveWorkerRepoRoot', () => {
	it('uses the worker-local override when configured', () => {
		expect(resolveWorkerRepoRoot('  /remote/checkout  ', '/fallback')).toBe('/remote/checkout');
	});

	it('defaults to the daemon working directory', () => {
		expect(resolveWorkerRepoRoot('', '/worker/swarm')).toBe('/worker/swarm');
	});
});

describe('assertTransportDispatchMode', () => {
	it('returns normally for transport', () => {
		expect(() => assertTransportDispatchMode('transport')).not.toThrow();
	});

	it('throws (naming dev:worker:legacy) when unset', () => {
		expect(() => assertTransportDispatchMode('')).toThrow(/dev:worker:legacy/);
	});

	it('throws (naming dev:worker:legacy) for an explicit in-process value', () => {
		expect(() => assertTransportDispatchMode('in-process')).toThrow(/dev:worker:legacy/);
	});
});
