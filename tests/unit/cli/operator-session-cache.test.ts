import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	clearOperatorSessionCache,
	normalizeControlPlaneUrl,
	operatorSessionCachePath,
	readOperatorSessionCache,
	writeOperatorSessionCache,
} from '@/cli/_shared/operator-session-cache.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const CONTROL_PLANE = 'https://swarm.example.com';
const OTHER_CONTROL_PLANE = 'http://localhost:3100';

describe('operator session cache (per control plane)', () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'swarm-operator-session-'));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	function write(
		controlPlaneUrl = CONTROL_PLANE,
		overrides: { token?: string; userId?: string; identifier?: string } = {},
	) {
		return writeOperatorSessionCache({
			controlPlaneUrl,
			token: overrides.token ?? 'opaque-session-token',
			userId: overrides.userId ?? USER_A,
			identifier: overrides.identifier ?? 'ada@example.com',
			expiresAt: '2026-09-04T00:00:00.000Z',
			homeDir: home,
		});
	}

	function mode(path: string): number {
		return statSync(path).mode & 0o777;
	}

	it('writes the entry under ~/.swarm/operator-sessions/<sha256 of the normalised URL>/', () => {
		const path = write();

		const hash = createHash('sha256').update(CONTROL_PLANE).digest('hex');
		expect(path).toBe(resolve(home, '.swarm', 'operator-sessions', hash, 'session.json'));
		expect(path).toBe(operatorSessionCachePath(CONTROL_PLANE, home));
	});

	it('round-trips the token, user, identifier, expiry and creation time', () => {
		write();

		expect(readOperatorSessionCache(CONTROL_PLANE, home)).toMatchObject({
			controlPlaneUrl: CONTROL_PLANE,
			token: 'opaque-session-token',
			userId: USER_A,
			identifier: 'ada@example.com',
			expiresAt: '2026-09-04T00:00:00.000Z',
		});
		const createdAt = readOperatorSessionCache(CONTROL_PLANE, home)?.createdAt ?? '';
		expect(Number.isNaN(Date.parse(createdAt))).toBe(false);
	});

	it('keeps the directory and file owner-only', () => {
		const path = write();

		expect(mode(path)).toBe(0o600);
		expect(mode(dirname(path))).toBe(0o700);
		expect(mode(dirname(dirname(path)))).toBe(0o700);
	});

	it('keys on the normalised URL, so a trailing slash or a cased host finds the same entry', () => {
		write('  HTTPS://SWARM.example.com/  ');

		expect(readOperatorSessionCache(CONTROL_PLANE, home)?.token).toBe('opaque-session-token');
		expect(readOperatorSessionCache(`${CONTROL_PLANE}/`, home)?.token).toBe('opaque-session-token');
		expect(normalizeControlPlaneUrl('  HTTPS://SWARM.example.com/  ')).toBe(CONTROL_PLANE);
	});

	it('holds one session per installation, so two control planes do not collide', () => {
		write(CONTROL_PLANE, { identifier: 'ada@example.com' });
		write(OTHER_CONTROL_PLANE, { identifier: 'localhost-admin', userId: USER_B });

		expect(readOperatorSessionCache(CONTROL_PLANE, home)?.identifier).toBe('ada@example.com');
		expect(readOperatorSessionCache(OTHER_CONTROL_PLANE, home)?.identifier).toBe('localhost-admin');
	});

	it('replaces the entry on a second login, keeping it owner-only and leaving no temp file', () => {
		write(CONTROL_PLANE, { token: 'first-token' });
		const path = write(CONTROL_PLANE, { token: 'second-token', userId: USER_B });

		expect(readOperatorSessionCache(CONTROL_PLANE, home)).toMatchObject({
			token: 'second-token',
			userId: USER_B,
		});
		expect(mode(path)).toBe(0o600);
		expect(readdirSync(dirname(path))).toEqual(['session.json']);
	});

	it('distinguishes "no session" from "unreadable session"', () => {
		expect(readOperatorSessionCache(CONTROL_PLANE, home)).toBeNull();

		const path = write();
		writeFileSync(path, '{ not json', 'utf8');
		expect(readOperatorSessionCache(CONTROL_PLANE, home)).toBeUndefined();

		// A well-formed file of the wrong shape is unreadable too, not absent.
		writeFileSync(path, JSON.stringify({ token: 'only-a-token' }), 'utf8');
		expect(readOperatorSessionCache(CONTROL_PLANE, home)).toBeUndefined();
	});

	it('clears only the named installation, and reports whether anything was there', () => {
		write(CONTROL_PLANE);
		write(OTHER_CONTROL_PLANE);

		expect(clearOperatorSessionCache(CONTROL_PLANE, home)).toBe(true);
		expect(existsSync(operatorSessionCachePath(CONTROL_PLANE, home))).toBe(false);
		expect(readOperatorSessionCache(CONTROL_PLANE, home)).toBeNull();
		// The other installation's session is untouched.
		expect(readOperatorSessionCache(OTHER_CONTROL_PLANE, home)).not.toBeNull();

		// Idempotent: clearing again is not an error, it just reports nothing was there.
		expect(clearOperatorSessionCache(CONTROL_PLANE, home)).toBe(false);
	});
});
