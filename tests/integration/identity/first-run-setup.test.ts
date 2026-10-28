import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUser, listUsers } from '../../../src/db/repositories/usersRepository.js';
import { verifyCredentials } from '../../../src/identity/auth.js';
import {
	_resetFirstRunSetupForTesting,
	announceFirstRunSetup,
	completeFirstRunSetup,
} from '../../../src/identity/first-run-setup.js';
import { logger } from '../../../src/lib/logger.js';
import { truncateAll } from '../helpers/db.js';

/** The token from the setup link logged by `announceFirstRunSetup`, if any. */
function loggedToken(warn: ReturnType<typeof vi.spyOn>): string | undefined {
	for (const [message] of warn.mock.calls) {
		const match = /\/setup\?token=([A-Za-z0-9_-]+)/.exec(String(message));
		if (match) return match[1];
	}
	return undefined;
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('first-run setup (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
		_resetFirstRunSetupForTesting();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('creates a working installation admin from the logged link, exactly once', async () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		await announceFirstRunSetup({ singleUserMode: false });
		const token = loggedToken(warn) as string;
		expect(token).toBeDefined();

		const input = { token, identifier: 'ada@example.com', password: 'hunter2' };
		expect((await completeFirstRunSetup(input)).outcome).toBe('created');
		expect(await verifyCredentials('ada@example.com', 'hunter2')).toMatchObject({
			instanceAdmin: true,
		});

		expect(await completeFirstRunSetup(input)).toEqual({ outcome: 'invalid-link' });
		expect(await listUsers()).toHaveLength(1);
	});

	it('issues no link when a user already exists', async () => {
		await createUser({ identifier: 'cli@example.com', displayName: 'CLI', instanceAdmin: true });
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

		await announceFirstRunSetup({ singleUserMode: false });

		expect(loggedToken(warn)).toBeUndefined();
	});

	it('refuses a link redeemed after a user was created another way', async () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		await announceFirstRunSetup({ singleUserMode: false });
		const token = loggedToken(warn) as string;
		await createUser({ identifier: 'cli@example.com', displayName: 'CLI', instanceAdmin: true });

		expect(
			await completeFirstRunSetup({ token, identifier: 'ada@example.com', password: 'hunter2' }),
		).toEqual({ outcome: 'already-set-up' });
		expect(await listUsers()).toHaveLength(1);
	});
});
