import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import { isEncryptedValue } from '../../../src/db/crypto.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import {
	resolveWorkerScmCredential,
	writeWorkerScmCredential,
} from '../../../src/db/repositories/workerScmCredentialsRepository.js';
import { createWorker, removeWorker } from '../../../src/db/repositories/workersRepository.js';
import { workerScmCredentials } from '../../../src/db/schema/workerScmCredentials.js';
import { truncateAll } from '../helpers/db.js';

const MASTER_KEY_HEX = 'a'.repeat(64); // 32-byte AES-256 key

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'workerScmCredentialsRepository (integration)',
	() => {
		let workerId: string;
		let otherWorkerId: string;

		beforeEach(async () => {
			await truncateAll();
			const ada = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });
			workerId = (
				await createWorker({
					ownerUserId: ada.id,
					displayName: 'm5_pro',
					capabilities: ['claude'],
					credentialHash: 'hash-1',
				})
			).id;
			otherWorkerId = (
				await createWorker({
					ownerUserId: ada.id,
					displayName: 'mini',
					capabilities: ['claude'],
					credentialHash: 'hash-2',
				})
			).id;
		});

		it('round-trips the plaintext it was written with', async () => {
			await writeWorkerScmCredential(workerId, 'github', 'ghp_secret');
			expect(await resolveWorkerScmCredential(workerId, 'github')).toBe('ghp_secret');
		});

		it('returns null for a (worker, provider) pair with nothing stored', async () => {
			expect(await resolveWorkerScmCredential(workerId, 'gitlab')).toBeNull();
		});

		// Rotation is an update on the unique index, not a second row — which is what
		// lets phase 2/3's form rotate a credential without a delete-then-write.
		it('updates in place when the same pair is written again', async () => {
			await writeWorkerScmCredential(workerId, 'github', 'ghp_old');
			await writeWorkerScmCredential(workerId, 'github', 'ghp_new');

			expect(await resolveWorkerScmCredential(workerId, 'github')).toBe('ghp_new');
			const rows = await getDb()
				.select()
				.from(workerScmCredentials)
				.where(eq(workerScmCredentials.workerId, workerId));
			expect(rows).toHaveLength(1);
		});

		// The acceptance criterion: one worker enrolled across projects on different
		// SCM providers holds one credential per provider.
		it('holds one credential per provider for the same worker', async () => {
			await writeWorkerScmCredential(workerId, 'github', 'ghp_secret');
			await writeWorkerScmCredential(workerId, 'bitbucket', 'user:app-password');

			expect(await resolveWorkerScmCredential(workerId, 'github')).toBe('ghp_secret');
			expect(await resolveWorkerScmCredential(workerId, 'bitbucket')).toBe('user:app-password');
		});

		it("deletes a deregistered worker's credentials with it", async () => {
			await writeWorkerScmCredential(workerId, 'github', 'ghp_secret');
			await removeWorker(workerId);

			const rows = await getDb()
				.select()
				.from(workerScmCredentials)
				.where(eq(workerScmCredentials.workerId, workerId));
			expect(rows).toHaveLength(0);
		});

		describe('encryption at rest', () => {
			it('stores only ciphertext and decrypts transparently', async () => {
				vi.stubEnv('CREDENTIAL_MASTER_KEY', MASTER_KEY_HEX);
				await writeWorkerScmCredential(workerId, 'github', 'ghp_plaintext');

				const [row] = await getDb().select().from(workerScmCredentials);
				expect(isEncryptedValue(row.value)).toBe(true);
				expect(row.value).not.toContain('ghp_plaintext');
				expect(await resolveWorkerScmCredential(workerId, 'github')).toBe('ghp_plaintext');
			});

			// Both halves of the AAD are load-bearing, so both moves are asserted: a
			// ciphertext lifted onto another worker's row, and one lifted onto the same
			// worker's row for a different provider.
			it('rejects a ciphertext replayed onto another worker', async () => {
				vi.stubEnv('CREDENTIAL_MASTER_KEY', MASTER_KEY_HEX);
				await writeWorkerScmCredential(workerId, 'github', 'bound-to-m5');
				const [row] = await getDb().select().from(workerScmCredentials);

				await getDb()
					.insert(workerScmCredentials)
					.values({ workerId: otherWorkerId, scmProviderId: 'github', value: row.value });

				await expect(resolveWorkerScmCredential(otherWorkerId, 'github')).rejects.toThrow();
			});

			it("rejects a ciphertext replayed onto the same worker's other provider", async () => {
				vi.stubEnv('CREDENTIAL_MASTER_KEY', MASTER_KEY_HEX);
				await writeWorkerScmCredential(workerId, 'github', 'bound-to-github');
				const [row] = await getDb()
					.select()
					.from(workerScmCredentials)
					.where(
						and(
							eq(workerScmCredentials.workerId, workerId),
							eq(workerScmCredentials.scmProviderId, 'github'),
						),
					);

				await getDb()
					.insert(workerScmCredentials)
					.values({ workerId, scmProviderId: 'gitlab', value: row.value });

				await expect(resolveWorkerScmCredential(workerId, 'gitlab')).rejects.toThrow();
			});
		});
	},
);
