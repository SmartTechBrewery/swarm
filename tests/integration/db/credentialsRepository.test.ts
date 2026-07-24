import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getPersonaTokenOrNull, getWebhookSecretOrNull } from '../../../src/config/provider.js';
import { getDb } from '../../../src/db/client.js';
import { isEncryptedValue } from '../../../src/db/crypto.js';
import {
	deleteProjectCredential,
	resolveAllProjectCredentials,
	resolveProjectCredential,
	writeProjectCredential,
} from '../../../src/db/repositories/credentialsRepository.js';
import { projectCredentials } from '../../../src/db/schema/projectCredentials.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const MASTER_KEY_HEX = 'a'.repeat(64); // 32-byte AES-256 key

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('credentialsRepository (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
		await seedProject();
	});

	describe('writeProjectCredential', () => {
		it('inserts a credential that resolves back to its plaintext', async () => {
			await writeProjectCredential('swarm', 'MY_API_KEY', 'secret-123', 'My Key');

			expect(await resolveProjectCredential('swarm', 'MY_API_KEY')).toBe('secret-123');
		});

		it('upserts when the (project, key) pair already exists', async () => {
			await writeProjectCredential('swarm', 'KEY', 'old-value');
			await writeProjectCredential('swarm', 'KEY', 'new-value');

			expect(await resolveProjectCredential('swarm', 'KEY')).toBe('new-value');
			const rows = await getDb().select().from(projectCredentials);
			expect(rows).toHaveLength(1);
		});
	});

	describe('deleteProjectCredential', () => {
		it('removes the credential', async () => {
			await writeProjectCredential('swarm', 'TEMP', 'tmp');
			await deleteProjectCredential('swarm', 'TEMP');

			expect(await resolveProjectCredential('swarm', 'TEMP')).toBeNull();
		});

		it('is a no-op for a key that was never written', async () => {
			await expect(deleteProjectCredential('swarm', 'NEVER_WRITTEN')).resolves.toBeUndefined();
		});
	});

	describe('resolveProjectCredential', () => {
		it('returns null when the credential does not exist', async () => {
			expect(await resolveProjectCredential('swarm', 'MISSING_KEY')).toBeNull();
		});
	});

	describe('resolveAllProjectCredentials', () => {
		it('returns all credentials as an env-var-key → value map', async () => {
			await writeProjectCredential('swarm', 'KEY_1', 'v1');
			await writeProjectCredential('swarm', 'KEY_2', 'v2');

			expect(await resolveAllProjectCredentials('swarm')).toEqual({ KEY_1: 'v1', KEY_2: 'v2' });
		});

		it('returns an empty map for a project with no credentials', async () => {
			expect(await resolveAllProjectCredentials('swarm')).toEqual({});
		});

		it('throws for an unknown project', async () => {
			await expect(resolveAllProjectCredentials('no-such-project')).rejects.toThrow(
				'Project not found: no-such-project',
			);
		});
	});

	describe('encryption at rest', () => {
		it('round-trips transparently and stores only ciphertext', async () => {
			vi.stubEnv('CREDENTIAL_MASTER_KEY', MASTER_KEY_HEX);

			await writeProjectCredential('swarm', 'ENC_KEY', 'plaintext-secret');

			const [row] = await getDb().select().from(projectCredentials);
			expect(isEncryptedValue(row.value)).toBe(true);
			expect(row.value).not.toContain('plaintext-secret');
			expect(await resolveProjectCredential('swarm', 'ENC_KEY')).toBe('plaintext-secret');
			expect(await resolveAllProjectCredentials('swarm')).toEqual({ ENC_KEY: 'plaintext-secret' });
		});

		it('rejects a ciphertext replayed under another project (projectId is the AAD)', async () => {
			vi.stubEnv('CREDENTIAL_MASTER_KEY', MASTER_KEY_HEX);
			await seedProject({ id: 'other-project', repo: 'jkwiecien/other' });

			await writeProjectCredential('swarm', 'TOKEN', 'bound-to-swarm');
			const [row] = await getDb().select().from(projectCredentials);
			await getDb()
				.insert(projectCredentials)
				.values({ projectId: 'other-project', envVarKey: 'TOKEN', value: row.value });

			await expect(resolveProjectCredential('other-project', 'TOKEN')).rejects.toThrow();
		});
	});

	// The config's `credentials` block stores references (env-var keys); the
	// provider resolves them through this repository to the secrets at rest —
	// the resolution seam feeding withGitHubToken's AsyncLocalStorage scope
	// (ai/CODING_STANDARDS.md "Scope credentials with AsyncLocalStorage").
	describe('resolution through the config provider', () => {
		it('resolves the reviewer token and the webhook secret via their references', async () => {
			vi.stubEnv('CREDENTIAL_MASTER_KEY', MASTER_KEY_HEX);
			const project = await seedProject({ id: 'swarm-2', repo: 'jkwiecien/swarm-2' });

			await writeProjectCredential('swarm-2', project.credentials.reviewer, 'test-token-reviewer');
			await writeProjectCredential('swarm-2', project.credentials.webhookSecret, 'hmac-secret');

			expect(await getPersonaTokenOrNull(project, 'reviewer')).toBe('test-token-reviewer');
			expect(await getWebhookSecretOrNull(project)).toBe('hmac-secret');
		});

		it('resolves the implementer token from the operator env var, not project credentials', async () => {
			vi.stubEnv('SWARM_OPERATOR_GH_TOKEN', 'operator-token');
			const project = await seedProject({ id: 'swarm-op', repo: 'jkwiecien/swarm-op' });

			expect(await getPersonaTokenOrNull(project, 'implementer')).toBe('operator-token');
		});

		it('resolves the reviewer token to null when the referenced credential is not stored', async () => {
			const project = await seedProject({ id: 'swarm-3', repo: 'jkwiecien/swarm-3' });

			expect(await getPersonaTokenOrNull(project, 'reviewer')).toBeNull();
		});
	});
});
