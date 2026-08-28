import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/instanceCredentialsRepository.js', () => ({
	listConfiguredInstanceScmCredentials: vi.fn(),
	writeInstanceScmCredential: vi.fn(),
	deleteInstanceScmCredential: vi.fn(),
}));

// Registers the real SCM manifests, so the procedures below resolve the pairs each
// provider actually declares eligible rather than a fixture's — the same reason
// `credentials.test.ts` imports it.
import '@/integrations/entrypoint.js';
import { instanceCredentialsRouter } from '@/api/routers/instanceCredentials.js';
import {
	deleteInstanceScmCredential,
	listConfiguredInstanceScmCredentials,
	writeInstanceScmCredential,
} from '@/db/repositories/instanceCredentialsRepository.js';
import type { SwarmUser } from '@/identity/schema.js';

const ADMIN_USER: SwarmUser = {
	id: '00000000-0000-4000-8000-000000000000',
	identifier: 'admin@example.com',
	displayName: 'Admin',
	instanceAdmin: true,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

const ORDINARY_USER: SwarmUser = {
	...ADMIN_USER,
	id: '00000000-0000-4000-8000-0000000000ff',
	identifier: 'member@example.com',
	displayName: 'Member',
	instanceAdmin: false,
};

describe('instanceCredentialsRouter (issue #769)', () => {
	const caller = instanceCredentialsRouter.createCaller({ user: ADMIN_USER });
	const ordinaryCaller = instanceCredentialsRouter.createCaller({ user: ORDINARY_USER });

	beforeEach(() => {
		vi.mocked(listConfiguredInstanceScmCredentials).mockReset();
		vi.mocked(writeInstanceScmCredential).mockReset();
		vi.mocked(deleteInstanceScmCredential).mockReset();
	});

	describe('list', () => {
		it("reports each eligible slot's configured state", async () => {
			vi.mocked(listConfiguredInstanceScmCredentials).mockResolvedValue([
				{ providerId: 'github', role: 'reviewer' },
			]);

			const result = await caller.list();

			expect(result.roles).toEqual([
				{
					providerId: 'github',
					providerLabel: 'GitHub',
					role: 'reviewer',
					envVarKey: 'GITHUB_TOKEN_REVIEWER',
					isConfigured: true,
				},
			]);
		});

		it('reports an unconfigured slot rather than omitting it', async () => {
			vi.mocked(listConfiguredInstanceScmCredentials).mockResolvedValue([]);

			const result = await caller.list();
			expect(result.roles).toHaveLength(1);
			expect(result.roles[0]?.isConfigured).toBe(false);
		});

		// The assertion that pins the eligibility rule at the API boundary: the webhook
		// secret is tied to a project's own endpoint, so no installation-wide value for it
		// may ever be offered here.
		it('never offers a webhookSecret slot', async () => {
			vi.mocked(listConfiguredInstanceScmCredentials).mockResolvedValue([]);

			const result = await caller.list();
			expect(result.roles.map((entry) => entry.role)).not.toContain('webhookSecret');
		});

		it('returns no value and no masked echo for a configured slot', async () => {
			vi.mocked(listConfiguredInstanceScmCredentials).mockResolvedValue([
				{ providerId: 'github', role: 'reviewer' },
			]);

			const result = await caller.list();
			const entry = result.roles[0] as Record<string, unknown>;

			expect(Object.keys(entry).sort()).toEqual([
				'envVarKey',
				'isConfigured',
				'providerId',
				'providerLabel',
				'role',
			]);
			expect(JSON.stringify(result)).not.toContain('*');
		});
	});

	describe('set', () => {
		it('writes through with the validated pair', async () => {
			await caller.set({ providerId: 'github', role: 'reviewer', value: 'ghp_instance' });

			expect(writeInstanceScmCredential).toHaveBeenCalledWith('github', 'reviewer', 'ghp_instance');
		});

		it('refuses a role the provider declares no instance default for', async () => {
			await expect(
				caller.set({ providerId: 'github', role: 'webhookSecret', value: 'shh' }),
			).rejects.toThrow(/declares no instance-level default for credential role 'webhookSecret'/);
			expect(writeInstanceScmCredential).not.toHaveBeenCalled();
		});

		it('refuses an unregistered provider id', async () => {
			await expect(
				caller.set({ providerId: 'nope', role: 'reviewer', value: 'x' }),
			).rejects.toThrow(/No runtime-ready SCM provider is registered for 'nope'/);
			expect(writeInstanceScmCredential).not.toHaveBeenCalled();
		});

		// Bitbucket and GitLab are registered and runtime-ready, but neither opts its
		// reviewer role in — so the answer is about the role, not the provider's existence.
		it('refuses a runtime-ready provider that has not opted in', async () => {
			await expect(
				caller.set({ providerId: 'gitlab', role: 'reviewer', value: 'glpat' }),
			).rejects.toThrow(
				/SCM provider 'gitlab' declares no instance-level default for credential role 'reviewer'/,
			);
			expect(writeInstanceScmCredential).not.toHaveBeenCalled();
		});
	});

	describe('delete', () => {
		it('clears the validated pair', async () => {
			await caller.delete({ providerId: 'github', role: 'reviewer' });
			expect(deleteInstanceScmCredential).toHaveBeenCalledWith('github', 'reviewer');
		});

		it('refuses an ineligible role', async () => {
			await expect(caller.delete({ providerId: 'github', role: 'webhookSecret' })).rejects.toThrow(
				/declares no instance-level default/,
			);
			expect(deleteInstanceScmCredential).not.toHaveBeenCalled();
		});
	});

	// The point of the module: the tab's visibility is a courtesy, this is the enforcement.
	describe('authorization', () => {
		it('refuses every procedure for a non-administrator without touching the store', async () => {
			await expect(ordinaryCaller.list()).rejects.toThrow(
				/managed by instance administrators only/,
			);
			await expect(
				ordinaryCaller.set({ providerId: 'github', role: 'reviewer', value: 'ghp_x' }),
			).rejects.toThrow(/managed by instance administrators only/);
			await expect(
				ordinaryCaller.delete({ providerId: 'github', role: 'reviewer' }),
			).rejects.toThrow(/managed by instance administrators only/);

			expect(listConfiguredInstanceScmCredentials).not.toHaveBeenCalled();
			expect(writeInstanceScmCredential).not.toHaveBeenCalled();
			expect(deleteInstanceScmCredential).not.toHaveBeenCalled();
		});

		it('refuses the reads before validating the input, so nothing is disclosed', async () => {
			await expect(
				ordinaryCaller.set({ providerId: 'nope', role: 'nope', value: 'x' }),
			).rejects.toThrow(/managed by instance administrators only/);
		});
	});
});
