import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import { isEncryptedValue } from '../../../src/db/crypto.js';
import {
	deleteInstanceScmCredential,
	listConfiguredInstanceScmCredentials,
	resolveInstanceScmCredential,
	writeInstanceScmCredential,
} from '../../../src/db/repositories/instanceCredentialsRepository.js';
import { instanceScmCredentials } from '../../../src/db/schema/instanceScmCredentials.js';
import { truncateAll } from '../helpers/db.js';

const MASTER_KEY_HEX = 'b'.repeat(64); // 32-byte AES-256 key

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'instanceCredentialsRepository (integration)',
	() => {
		beforeEach(async () => {
			await truncateAll();
		});

		it('round-trips the plaintext it was written with', async () => {
			await writeInstanceScmCredential('github', 'reviewer', 'ghp_instance_default');
			expect(await resolveInstanceScmCredential('github', 'reviewer')).toBe('ghp_instance_default');
		});

		it('returns null for a slot with nothing stored', async () => {
			expect(await resolveInstanceScmCredential('github', 'reviewer')).toBeNull();
		});

		// Rotation is an update on the unique index, not a second row — which is what makes
		// re-setting a default a plain re-save rather than a delete-then-write.
		it('updates in place when the same slot is written again', async () => {
			await writeInstanceScmCredential('github', 'reviewer', 'ghp_old');
			await writeInstanceScmCredential('github', 'reviewer', 'ghp_new');

			expect(await resolveInstanceScmCredential('github', 'reviewer')).toBe('ghp_new');
			const rows = await getDb().select().from(instanceScmCredentials);
			expect(rows).toHaveLength(1);
		});

		it('keeps two roles and two providers independent', async () => {
			await writeInstanceScmCredential('github', 'reviewer', 'gh-reviewer');
			await writeInstanceScmCredential('github', 'webhookSecret', 'gh-webhook');
			await writeInstanceScmCredential('gitlab', 'reviewer', 'gl-reviewer');

			expect(await resolveInstanceScmCredential('github', 'reviewer')).toBe('gh-reviewer');
			expect(await resolveInstanceScmCredential('github', 'webhookSecret')).toBe('gh-webhook');
			expect(await resolveInstanceScmCredential('gitlab', 'reviewer')).toBe('gl-reviewer');
		});

		it('clears a stored slot and leaves the others alone', async () => {
			await writeInstanceScmCredential('github', 'reviewer', 'gh-reviewer');
			await writeInstanceScmCredential('gitlab', 'reviewer', 'gl-reviewer');

			await deleteInstanceScmCredential('github', 'reviewer');

			expect(await resolveInstanceScmCredential('github', 'reviewer')).toBeNull();
			expect(await resolveInstanceScmCredential('gitlab', 'reviewer')).toBe('gl-reviewer');
		});

		it('treats deleting a slot that was never set as a no-op', async () => {
			await expect(deleteInstanceScmCredential('github', 'reviewer')).resolves.toBeUndefined();
		});

		describe('listConfiguredInstanceScmCredentials', () => {
			it('reports the key pairs and no value', async () => {
				await writeInstanceScmCredential('github', 'reviewer', 'gh-reviewer');
				await writeInstanceScmCredential('gitlab', 'reviewer', 'gl-reviewer');

				const configured = await listConfiguredInstanceScmCredentials();

				expect(configured).toEqual(
					expect.arrayContaining([
						{ providerId: 'github', role: 'reviewer' },
						{ providerId: 'gitlab', role: 'reviewer' },
					]),
				);
				expect(configured).toHaveLength(2);
				expect(JSON.stringify(configured)).not.toContain('gh-reviewer');
			});

			it('is empty when nothing is stored', async () => {
				expect(await listConfiguredInstanceScmCredentials()).toEqual([]);
			});

			// The read and the resolve must agree on what "configured" means, so a row that
			// resolves as absent must not be reported as set either.
			it('excludes a row whose stored value is empty', async () => {
				await getDb()
					.insert(instanceScmCredentials)
					.values({ providerId: 'github', role: 'reviewer', value: '' });

				expect(await listConfiguredInstanceScmCredentials()).toEqual([]);
				expect(await resolveInstanceScmCredential('github', 'reviewer')).toBeNull();
			});
		});

		describe('encryption at rest', () => {
			it('stores only ciphertext and decrypts transparently', async () => {
				vi.stubEnv('CREDENTIAL_MASTER_KEY', MASTER_KEY_HEX);
				await writeInstanceScmCredential('github', 'reviewer', 'ghp_plaintext');

				const [row] = await getDb().select().from(instanceScmCredentials);
				expect(isEncryptedValue(row.value)).toBe(true);
				expect(row.value).not.toContain('ghp_plaintext');
				expect(await resolveInstanceScmCredential('github', 'reviewer')).toBe('ghp_plaintext');
			});

			// The AAD assertion, mirroring the cross-project test the project-credential
			// suite already has: the slot is this tier's only identity, so a ciphertext moved
			// into another slot's row must fail authentication rather than resolve as that
			// provider's secret.
			it('rejects a ciphertext replayed into another slot', async () => {
				vi.stubEnv('CREDENTIAL_MASTER_KEY', MASTER_KEY_HEX);
				await writeInstanceScmCredential('github', 'reviewer', 'bound-to-github-reviewer');
				const [row] = await getDb()
					.select()
					.from(instanceScmCredentials)
					.where(
						and(
							eq(instanceScmCredentials.providerId, 'github'),
							eq(instanceScmCredentials.role, 'reviewer'),
						),
					);

				await getDb()
					.insert(instanceScmCredentials)
					.values({ providerId: 'gitlab', role: 'reviewer', value: row.value });

				await expect(resolveInstanceScmCredential('gitlab', 'reviewer')).rejects.toThrow();
			});
		});
	},
);
