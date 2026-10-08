import { delimiter } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	isSingleUserMode,
	optionalEnv,
	requireEnv,
	resolveWebhookCallbackBaseUrl,
	resolveWorkerRepoRoots,
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

describe('resolveWorkerRepoRoots', () => {
	it('uses the worker-local override when configured', () => {
		expect(resolveWorkerRepoRoots('  /remote/checkout  ', '/fallback')).toEqual([
			'/remote/checkout',
		]);
	});

	it('defaults to the daemon working directory when unset or empty', () => {
		expect(resolveWorkerRepoRoots('', '/worker/swarm')).toEqual(['/worker/swarm']);
		vi.stubEnv('SWARM_WORKER_REPO_ROOT', '');
		expect(resolveWorkerRepoRoots(undefined, '/worker/swarm')).toEqual(['/worker/swarm']);
	});

	// Issue #1058. Written the way `PATH` is, and the first entry is the primary checkout.
	it('reads several checkouts from one delimiter-separated value, primary first', () => {
		expect(resolveWorkerRepoRoots(`/a${delimiter}/b`, '/fallback')).toEqual(['/a', '/b']);
	});

	// A trailing delimiter, a repeated path, or whitespace around one is not a second
	// checkout — the daemon would otherwise refuse to start on a duplicate.
	it('drops blank entries and collapses duplicates, keeping declaration order', () => {
		expect(
			resolveWorkerRepoRoots(`/a${delimiter} ${delimiter}/b${delimiter}/a/${delimiter}`),
		).toEqual(['/a', '/b']);
	});
});
