import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	assertServeStartupSafety,
	isServeWorktreeSweepEnabled,
	resolveServeListen,
} from '@/serve/settings.js';

const VALID_KEY = 'a'.repeat(64);
const ENV_KEYS = [
	'SWARM_SINGLE_USER_MODE',
	'CREDENTIAL_MASTER_KEY',
	'SWARM_SERVE_ALLOW_INSECURE',
	'PORT',
	'SWARM_SERVE_HOST',
] as const;

describe('serve settings (issue #1148)', () => {
	const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	describe('assertServeStartupSafety', () => {
		it('passes a multi-user installation with a valid master key', () => {
			process.env.CREDENTIAL_MASTER_KEY = VALID_KEY;

			expect(assertServeStartupSafety()).toEqual({ waived: [] });
		});

		it('refuses single-user mode and names the override', () => {
			process.env.CREDENTIAL_MASTER_KEY = VALID_KEY;
			process.env.SWARM_SINGLE_USER_MODE = 'true';

			expect(() => assertServeStartupSafety()).toThrow(/SWARM_SINGLE_USER_MODE/);
			expect(() => assertServeStartupSafety()).toThrow(/SWARM_SERVE_ALLOW_INSECURE=true/);
		});

		it('refuses a missing master key', () => {
			expect(() => assertServeStartupSafety()).toThrow(/CREDENTIAL_MASTER_KEY is unset.*plaintext/);
		});

		it('refuses a wrong-length or non-hex master key with the validator’s reason', () => {
			process.env.CREDENTIAL_MASTER_KEY = 'abc';
			expect(() => assertServeStartupSafety()).toThrow(/64-char hex string/);

			process.env.CREDENTIAL_MASTER_KEY = 'z'.repeat(64);
			expect(() => assertServeStartupSafety()).toThrow(/non-hex characters/);
		});

		it('lists every problem in one error', () => {
			process.env.SWARM_SINGLE_USER_MODE = 'true';

			let message = '';
			try {
				assertServeStartupSafety();
			} catch (err) {
				message = (err as Error).message;
			}
			expect(message).toContain('SWARM_SINGLE_USER_MODE=true');
			expect(message).toContain('CREDENTIAL_MASTER_KEY is unset');
		});

		it('waives the refusals with SWARM_SERVE_ALLOW_INSECURE=true and reports them', () => {
			process.env.SWARM_SINGLE_USER_MODE = 'true';
			process.env.SWARM_SERVE_ALLOW_INSECURE = 'true';

			expect(assertServeStartupSafety().waived).toHaveLength(2);
		});

		it('accepts only the literal "true" as the override', () => {
			for (const value of ['1', 'yes', 'TRUE']) {
				process.env.SWARM_SERVE_ALLOW_INSECURE = value;
				expect(() => assertServeStartupSafety()).toThrow(/Refusing to start/);
			}
		});
	});

	describe('resolveServeListen', () => {
		it('binds every interface on port 3000 by default', () => {
			expect(resolveServeListen()).toEqual({ hostname: undefined, port: 3000 });
		});

		it('honours an explicit host and port, and treats a blank host as unset', () => {
			expect(resolveServeListen({ SWARM_SERVE_HOST: '127.0.0.1', PORT: '3200' })).toEqual({
				hostname: '127.0.0.1',
				port: 3200,
			});
			expect(resolveServeListen({ SWARM_SERVE_HOST: '  ' }).hostname).toBeUndefined();
		});

		it('rejects a malformed or out-of-range PORT', () => {
			for (const port of ['abc', '0', '70000', '3000.5']) {
				expect(() => resolveServeListen({ PORT: port })).toThrow(/PORT must be an integer/);
			}
		});
	});

	describe('isServeWorktreeSweepEnabled', () => {
		it('is on only for the literal "true"', () => {
			expect(isServeWorktreeSweepEnabled({})).toBe(false);
			expect(isServeWorktreeSweepEnabled({ SWARM_SERVE_WORKTREE_SWEEP: '1' })).toBe(false);
			expect(isServeWorktreeSweepEnabled({ SWARM_SERVE_WORKTREE_SWEEP: 'true' })).toBe(true);
		});
	});
});
