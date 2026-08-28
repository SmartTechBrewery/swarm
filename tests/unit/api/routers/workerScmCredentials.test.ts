import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/workerScmCredentialsRepository.js', () => ({
	listWorkerScmCredentialStates: vi.fn(),
	writeWorkerScmCredential: vi.fn(),
}));

vi.mock('@/identity/worker-scm-credential.js', () => ({
	listWorkerScmProviders: vi.fn(),
}));

vi.mock('@/identity/worker-service.js', () => ({
	getWorker: vi.fn(),
}));

vi.mock('@/api/scm-verification.js', () => ({
	verifyScmCredentialSecret: vi.fn(),
}));

// Registers the real SCM manifests, so the slots below carry each provider's own id
// and label rather than a fixture's — the same reason `instanceCredentials.test.ts`
// imports it.
import '@/integrations/entrypoint.js';
import { workerScmCredentialsRouter } from '@/api/routers/workerScmCredentials.js';
import { verifyScmCredentialSecret } from '@/api/scm-verification.js';
import {
	listWorkerScmCredentialStates,
	writeWorkerScmCredential,
} from '@/db/repositories/workerScmCredentialsRepository.js';
import type { SwarmUser } from '@/identity/schema.js';
import { listWorkerScmProviders } from '@/identity/worker-scm-credential.js';
import { getWorker } from '@/identity/worker-service.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '00000000-0000-4000-8000-000000000001';

const OWNER: SwarmUser = {
	id: OWNER_ID,
	identifier: 'ada@example.com',
	displayName: 'Ada',
	instanceAdmin: false,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

/** An installation administrator who does **not** own the worker. */
const ADMIN_STRANGER: SwarmUser = {
	...OWNER,
	id: '00000000-0000-4000-8000-0000000000ff',
	identifier: 'admin@example.com',
	displayName: 'Admin',
	instanceAdmin: true,
};

const WORKER = {
	id: WORKER_ID,
	ownerUserId: OWNER_ID,
	displayName: 'ada-laptop',
};

const UPDATED_AT = new Date('2026-08-01T09:30:00.000Z');

describe('workerScmCredentialsRouter (issue #766)', () => {
	const caller = workerScmCredentialsRouter.createCaller({ user: OWNER });
	const adminCaller = workerScmCredentialsRouter.createCaller({ user: ADMIN_STRANGER });

	beforeEach(() => {
		vi.mocked(getWorker).mockReset();
		vi.mocked(listWorkerScmCredentialStates).mockReset();
		vi.mocked(listWorkerScmProviders).mockReset();
		vi.mocked(writeWorkerScmCredential).mockReset();
		vi.mocked(verifyScmCredentialSecret).mockReset();

		// biome-ignore lint/suspicious/noExplicitAny: the router reads only id/ownerUserId.
		vi.mocked(getWorker).mockResolvedValue(WORKER as any);
		vi.mocked(listWorkerScmCredentialStates).mockResolvedValue([]);
		vi.mocked(listWorkerScmProviders).mockResolvedValue([]);
	});

	/**
	 * The rule that pins "no `instanceAdmin` override" — and that it covers the *read*
	 * too: configured/not-configured state is itself protected, so an administrator
	 * cannot learn whether someone else's machine holds a credential either.
	 */
	describe('strict ownership', () => {
		it('hides the worker from an instance admin who does not own it, on list', async () => {
			await expect(adminCaller.list({ workerId: WORKER_ID })).rejects.toThrow(
				`Worker with ID "${WORKER_ID}" not found`,
			);
			expect(listWorkerScmCredentialStates).not.toHaveBeenCalled();
		});

		it('hides the worker from an instance admin who does not own it, on set', async () => {
			await expect(
				adminCaller.set({ workerId: WORKER_ID, providerId: 'github', value: 'ghp_x' }),
			).rejects.toThrow(`Worker with ID "${WORKER_ID}" not found`);
			expect(writeWorkerScmCredential).not.toHaveBeenCalled();
		});

		it('answers an unknown worker with the same NOT_FOUND', async () => {
			vi.mocked(getWorker).mockResolvedValue(undefined);
			await expect(caller.list({ workerId: WORKER_ID })).rejects.toThrow(
				`Worker with ID "${WORKER_ID}" not found`,
			);
		});
	});

	describe('list', () => {
		it('offers one slot per provider the worker’s enrollments resolve to', async () => {
			vi.mocked(listWorkerScmProviders).mockResolvedValue(['bitbucket', 'github']);

			const result = await caller.list({ workerId: WORKER_ID });

			expect(result.providers).toEqual([
				{
					providerId: 'bitbucket',
					providerLabel: 'Bitbucket',
					isConfigured: false,
					updatedAt: null,
				},
				{ providerId: 'github', providerLabel: 'GitHub', isConfigured: false, updatedAt: null },
			]);
		});

		it('reports a configured slot with an ISO last-updated timestamp', async () => {
			vi.mocked(listWorkerScmProviders).mockResolvedValue(['github']);
			vi.mocked(listWorkerScmCredentialStates).mockResolvedValue([
				{ scmProviderId: 'github', updatedAt: UPDATED_AT },
			]);

			const result = await caller.list({ workerId: WORKER_ID });

			expect(result.providers[0]?.isConfigured).toBe(true);
			expect(result.providers[0]?.updatedAt).toBe(UPDATED_AT.toISOString());
		});

		/**
		 * Otherwise dropping the last enrollment for a provider would leave a stored
		 * credential with no surface to rotate or replace it on.
		 */
		it('still offers a provider that holds a value but matches no enrollment', async () => {
			vi.mocked(listWorkerScmProviders).mockResolvedValue(['github']);
			vi.mocked(listWorkerScmCredentialStates).mockResolvedValue([
				{ scmProviderId: 'gitlab', updatedAt: UPDATED_AT },
			]);

			const result = await caller.list({ workerId: WORKER_ID });

			// Needed providers first, then the stored-only one.
			expect(result.providers.map((slot) => slot.providerId)).toEqual(['github', 'gitlab']);
			expect(result.providers[1]?.isConfigured).toBe(true);
		});

		it('drops a stored provider nothing runtime-ready is registered for', async () => {
			vi.mocked(listWorkerScmCredentialStates).mockResolvedValue([
				{ scmProviderId: 'nonesuch', updatedAt: UPDATED_AT },
			]);

			const result = await caller.list({ workerId: WORKER_ID });
			expect(result.providers).toEqual([]);
		});

		// The secret-hygiene assertion: no value, and no masked echo of one either.
		it('carries no value or masked field at all', async () => {
			vi.mocked(listWorkerScmProviders).mockResolvedValue(['github']);
			vi.mocked(listWorkerScmCredentialStates).mockResolvedValue([
				{ scmProviderId: 'github', updatedAt: UPDATED_AT },
			]);

			const result = await caller.list({ workerId: WORKER_ID });

			expect(Object.keys(result.providers[0] ?? {}).sort()).toEqual([
				'isConfigured',
				'providerId',
				'providerLabel',
				'updatedAt',
			]);
		});
	});

	describe('set', () => {
		it('verifies against the provider and writes once on success', async () => {
			vi.mocked(verifyScmCredentialSecret).mockResolvedValue({ valid: true, login: 'ada-ops' });

			const result = await caller.set({
				workerId: WORKER_ID,
				providerId: 'gitlab',
				value: 'glpat-real',
			});

			expect(verifyScmCredentialSecret).toHaveBeenCalledWith('gitlab', 'glpat-real');
			expect(writeWorkerScmCredential).toHaveBeenCalledTimes(1);
			expect(writeWorkerScmCredential).toHaveBeenCalledWith(WORKER_ID, 'gitlab', 'glpat-real');
			expect(result).toEqual({ login: 'ada-ops' });
		});

		// The store-nothing-on-reject assertion — the whole point of verifying first.
		it('rejects an invalid credential and stores nothing', async () => {
			vi.mocked(verifyScmCredentialSecret).mockResolvedValue({ valid: false });

			await expect(
				caller.set({ workerId: WORKER_ID, providerId: 'github', value: 'ghp_wrong' }),
			).rejects.toThrow(/did not resolve to a GitHub account, so nothing was stored/);
			expect(writeWorkerScmCredential).not.toHaveBeenCalled();
		});

		it('refuses a provider nothing runtime-ready is registered for, before verifying', async () => {
			await expect(
				caller.set({ workerId: WORKER_ID, providerId: 'nonesuch', value: 'secret' }),
			).rejects.toThrow("No runtime-ready SCM provider is registered for 'nonesuch'");
			expect(verifyScmCredentialSecret).not.toHaveBeenCalled();
			expect(writeWorkerScmCredential).not.toHaveBeenCalled();
		});

		// A write is validated against the registry rather than against the slot list, so
		// an enrollment created between a client's `list` and its `set` cannot lose it.
		it('accepts a provider no current enrollment resolves to', async () => {
			vi.mocked(listWorkerScmProviders).mockResolvedValue([]);
			vi.mocked(verifyScmCredentialSecret).mockResolvedValue({ valid: true, login: 'ada-ops' });

			await caller.set({ workerId: WORKER_ID, providerId: 'bitbucket', value: 'ada:app-pw' });

			expect(writeWorkerScmCredential).toHaveBeenCalledWith(WORKER_ID, 'bitbucket', 'ada:app-pw');
		});
	});
});
