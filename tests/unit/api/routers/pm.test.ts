import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	getProjectByIdFromDb: vi.fn(),
}));

vi.mock('@/identity/membership-service.js', () => ({
	getMembership: vi.fn(),
	listAccessibleProjectIds: vi.fn(),
}));

vi.mock('@/integrations/pm/registry.js', () => ({
	getPMProvider: vi.fn(),
	listPMProviders: vi.fn(),
}));

import { pmRouter } from '@/api/routers/pm.js';
import { getProjectByIdFromDb } from '@/db/repositories/projectsRepository.js';
import type { ProjectMembership, ProjectRole } from '@/identity/membership.js';
import { getMembership } from '@/identity/membership-service.js';
import type { SwarmUser } from '@/identity/schema.js';
import { getPMProvider, listPMProviders } from '@/integrations/pm/registry.js';
import type { PMProvider } from '@/pm/types.js';
import { createMockProjectConfig } from '../../../helpers/factories.js';

const ADMIN_USER: SwarmUser = {
	id: '00000000-0000-4000-8000-000000000000',
	identifier: 'admin@example.com',
	displayName: 'Admin',
	instanceAdmin: true,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

const ORDINARY_USER: SwarmUser = {
	id: '00000000-0000-4000-8000-0000000000ff',
	identifier: 'member@example.com',
	displayName: 'Member',
	instanceAdmin: false,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

function membershipFor(role: ProjectRole): ProjectMembership {
	return {
		id: '99999999-9999-4999-8999-999999999999',
		projectId: 'swarm',
		userId: ORDINARY_USER.id,
		role,
		createdAt: new Date(0),
	};
}

/** A manifest stub with a controllable discovery capability list and provider. */
function stubManifest(discovery: string[], discover: PMProvider['discover']) {
	return {
		id: 'github-projects',
		label: 'GitHub Projects',
		category: 'pm' as const,
		discovery,
		createProvider: () => ({ discover }) as unknown as PMProvider,
	};
}

describe('pmRouter', () => {
	const caller = pmRouter.createCaller({ user: ADMIN_USER });

	beforeEach(() => {
		vi.mocked(getProjectByIdFromDb).mockReset();
		vi.mocked(getMembership).mockReset();
		vi.mocked(getPMProvider).mockReset();
		vi.mocked(listPMProviders).mockReset();
	});

	describe('listProviders', () => {
		it('returns registry identity and declared capabilities to a projectAdmin member', async () => {
			// A non-instance-admin caller so `assertProjectAccess` actually consults
			// project membership rather than short-circuiting on `instanceAdmin` — this
			// proves an ordinary user with a `projectAdmin` membership reaches the metadata.
			const memberCaller = pmRouter.createCaller({ user: ORDINARY_USER });
			vi.mocked(getMembership).mockResolvedValue(membershipFor('projectAdmin'));
			vi.mocked(listPMProviders).mockReturnValue([
				// biome-ignore lint/suspicious/noExplicitAny: only the read fields matter here
				{
					id: 'github-projects',
					label: 'GitHub Projects',
					discovery: ['containers', 'states'],
				} as any,
			]);

			await expect(memberCaller.listProviders({ projectId: 'swarm' })).resolves.toEqual([
				{ id: 'github-projects', label: 'GitHub Projects', discovery: ['containers', 'states'] },
			]);
			expect(listPMProviders).toHaveBeenCalledOnce();
		});

		it('hides existence from a non-member (NOT_FOUND, not FORBIDDEN)', async () => {
			const memberCaller = pmRouter.createCaller({ user: ORDINARY_USER });
			vi.mocked(getMembership).mockResolvedValue(undefined);
			await expect(memberCaller.listProviders({ projectId: 'swarm' })).rejects.toMatchObject({
				code: 'NOT_FOUND',
			});
			expect(listPMProviders).not.toHaveBeenCalled();
		});

		it('is FORBIDDEN for a member below projectAdmin', async () => {
			const memberCaller = pmRouter.createCaller({ user: ORDINARY_USER });
			vi.mocked(getMembership).mockResolvedValue(membershipFor('member'));
			await expect(memberCaller.listProviders({ projectId: 'swarm' })).rejects.toMatchObject({
				code: 'FORBIDDEN',
			});
			expect(listPMProviders).not.toHaveBeenCalled();
		});
	});

	describe('discoverContainers', () => {
		it('dispatches through the registry and returns the discovered boards', async () => {
			const discover = vi.fn().mockResolvedValue({ containers: [{ id: 'PVT_1', name: 'Board' }] });
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig());
			// biome-ignore lint/suspicious/noExplicitAny: manifest stub is intentionally partial
			vi.mocked(getPMProvider).mockReturnValue(
				stubManifest(['containers', 'states'], discover) as any,
			);

			const result = await caller.discoverContainers({ projectId: 'swarm' });

			expect(discover).toHaveBeenCalledWith('containers', {});
			expect(result).toEqual({ containers: [{ id: 'PVT_1', name: 'Board' }] });
		});

		it('is NOT_FOUND when the project does not exist', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);
			await expect(caller.discoverContainers({ projectId: 'swarm' })).rejects.toMatchObject({
				code: 'NOT_FOUND',
			});
		});

		it('is NOT_FOUND when no provider is registered for the project', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig());
			vi.mocked(getPMProvider).mockReturnValue(null);
			await expect(caller.discoverContainers({ projectId: 'swarm' })).rejects.toMatchObject({
				code: 'NOT_FOUND',
			});
		});

		it('is NOT_IMPLEMENTED when the provider does not declare the capability', async () => {
			const discover = vi.fn();
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig());
			// biome-ignore lint/suspicious/noExplicitAny: manifest stub is intentionally partial
			vi.mocked(getPMProvider).mockReturnValue(stubManifest([], discover) as any);
			await expect(caller.discoverContainers({ projectId: 'swarm' })).rejects.toMatchObject({
				code: 'NOT_IMPLEMENTED',
			});
			expect(discover).not.toHaveBeenCalled();
		});

		it('hides existence from a non-member (NOT_FOUND, not FORBIDDEN)', async () => {
			const memberCaller = pmRouter.createCaller({ user: ORDINARY_USER });
			vi.mocked(getMembership).mockResolvedValue(undefined);
			await expect(memberCaller.discoverContainers({ projectId: 'swarm' })).rejects.toMatchObject({
				code: 'NOT_FOUND',
			});
			expect(getProjectByIdFromDb).not.toHaveBeenCalled();
		});

		it('is FORBIDDEN for a member below projectAdmin', async () => {
			const memberCaller = pmRouter.createCaller({ user: ORDINARY_USER });
			vi.mocked(getMembership).mockResolvedValue(membershipFor('member'));
			await expect(memberCaller.discoverContainers({ projectId: 'swarm' })).rejects.toMatchObject({
				code: 'FORBIDDEN',
			});
		});

		it('maps a missing implementer (operator) token to safe, actionable copy', async () => {
			const discover = vi
				.fn()
				.mockRejectedValue(
					new Error(
						"No GitHub implementer token configured: set SWARM_OPERATOR_GH_TOKEN on this host (the worker operator's own token; never stored in project_credentials)",
					),
				);
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig());
			// biome-ignore lint/suspicious/noExplicitAny: manifest stub is intentionally partial
			vi.mocked(getPMProvider).mockReturnValue(stubManifest(['containers'], discover) as any);

			await expect(caller.discoverContainers({ projectId: 'swarm' })).rejects.toMatchObject({
				code: 'PRECONDITION_FAILED',
			});
			// The actionable copy points the operator at the host env var.
			await expect(caller.discoverContainers({ projectId: 'swarm' })).rejects.toThrow(
				/SWARM_OPERATOR_GH_TOKEN/,
			);
		});

		it('surfaces an actionable provider error as BAD_REQUEST', async () => {
			const discover = vi
				.fn()
				.mockRejectedValue(new Error("GitHub Projects board 'PVT_x' did not resolve"));
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig());
			// biome-ignore lint/suspicious/noExplicitAny: manifest stub is intentionally partial
			vi.mocked(getPMProvider).mockReturnValue(stubManifest(['containers'], discover) as any);

			await expect(caller.discoverContainers({ projectId: 'swarm' })).rejects.toMatchObject({
				code: 'BAD_REQUEST',
				message: expect.stringContaining('did not resolve'),
			});
		});
	});

	describe('discoverStates', () => {
		it('dispatches with the selected container id', async () => {
			const discover = vi.fn().mockResolvedValue({
				states: [{ id: 'o1', name: 'Ready' }],
				providerContext: { statusFieldId: 'F' },
			});
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig());
			// biome-ignore lint/suspicious/noExplicitAny: manifest stub is intentionally partial
			vi.mocked(getPMProvider).mockReturnValue(
				stubManifest(['containers', 'states'], discover) as any,
			);

			const result = await caller.discoverStates({ projectId: 'swarm', containerId: 'PVT_1' });

			expect(discover).toHaveBeenCalledWith('states', { containerId: 'PVT_1' });
			expect(result.providerContext).toEqual({ statusFieldId: 'F' });
		});
	});
});
