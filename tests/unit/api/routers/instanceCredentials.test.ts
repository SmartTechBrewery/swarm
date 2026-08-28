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

describe('instanceCredentialsRouter (issues #769, #778)', () => {
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

			// Every registered provider's reviewer slot, in registration order (issue #778):
			// the AC's "the Credentials tab offers a field for each provider", asserted at the
			// API boundary the tab renders from rather than in the dashboard.
			expect(result.roles).toEqual([
				{
					providerId: 'github',
					providerLabel: 'GitHub',
					role: 'reviewer',
					envVarKey: 'GITHUB_TOKEN_REVIEWER',
					isConfigured: true,
				},
				{
					providerId: 'bitbucket',
					providerLabel: 'Bitbucket',
					role: 'reviewer',
					envVarKey: 'BITBUCKET_TOKEN_REVIEWER',
					isConfigured: false,
				},
				{
					providerId: 'gitlab',
					providerLabel: 'GitLab',
					role: 'reviewer',
					envVarKey: 'GITLAB_TOKEN_REVIEWER',
					isConfigured: false,
				},
			]);
		});

		it('reports an unconfigured slot rather than omitting it', async () => {
			vi.mocked(listConfiguredInstanceScmCredentials).mockResolvedValue([]);

			const result = await caller.list();
			expect(result.roles).toHaveLength(3);
			expect(result.roles.every((entry) => entry.isConfigured)).toBe(false);
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

		// Issue #778: the reviewer slot is installation-wide policy for *every* registered
		// provider, so all three are writable rather than GitHub's alone — which is what
		// makes the refusal in `projects.create` fixable for a Bitbucket or GitLab project.
		it("writes through for every provider's reviewer slot, not just GitHub's", async () => {
			await caller.set({ providerId: 'bitbucket', role: 'reviewer', value: 'bb_app_password' });
			await caller.set({ providerId: 'gitlab', role: 'reviewer', value: 'glpat_instance' });

			expect(vi.mocked(writeInstanceScmCredential).mock.calls).toEqual([
				['bitbucket', 'reviewer', 'bb_app_password'],
				['gitlab', 'reviewer', 'glpat_instance'],
			]);
		});

		// The refusal is about the *role*, not the provider's existence: a registered,
		// runtime-ready provider's `webhookSecret` is still refused, since it is tied to one
		// project's own endpoint and no provider may ever opt it in.
		it("refuses another provider's webhookSecret, not only GitHub's", async () => {
			await expect(
				caller.set({ providerId: 'gitlab', role: 'webhookSecret', value: 'shh' }),
			).rejects.toThrow(
				/SCM provider 'gitlab' declares no instance-level default for credential role 'webhookSecret'/,
			);
			expect(writeInstanceScmCredential).not.toHaveBeenCalled();
		});
	});

	describe('delete', () => {
		it('clears the validated pair', async () => {
			await caller.delete({ providerId: 'github', role: 'reviewer' });
			expect(deleteInstanceScmCredential).toHaveBeenCalledWith('github', 'reviewer');
		});

		it('clears a stored slot even when its role is no longer eligible', async () => {
			await caller.delete({ providerId: 'github', role: 'webhookSecret' });

			expect(deleteInstanceScmCredential).toHaveBeenCalledWith('github', 'webhookSecret');
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
