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
import { MissingPmCredentialError } from '@/config/provider.js';
import type { ProjectConfig, ProjectPm } from '@/config/schema.js';
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

/**
 * A manifest stub with a controllable discovery capability list and provider.
 *
 * `overrides` covers the issue #641 surface: the provider's own id and blank `pm`
 * member, the optional blocker that refuses discovery against that member, and a
 * `createProvider` that records the project it was built for — which is how the tests
 * below observe the projection without a real provider.
 */
function stubManifest(
	discovery: string[],
	discover: PMProvider['discover'],
	overrides: {
		id?: string;
		blankPm?: ProjectPm;
		blankPmDiscoveryBlocker?: string;
		createProvider?: (project: ProjectConfig) => PMProvider;
	} = {},
) {
	const id = overrides.id ?? 'github-projects';
	return {
		id,
		label: id === 'github-projects' ? 'GitHub Projects' : id,
		category: 'pm' as const,
		discovery,
		blankPm: overrides.blankPm ?? {
			type: id,
			projectId: '',
			statusFieldId: '',
			statusOptions: {},
		},
		blankPmDiscoveryBlocker: overrides.blankPmDiscoveryBlocker,
		createProvider: overrides.createProvider ?? (() => ({ discover }) as unknown as PMProvider),
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

		// Issue #537: an unconfigured *PM* credential is the recognized precondition, and
		// it is recognized by type rather than by message text. The copy names the role
		// to configure, and never the worker-local operator SCM token — discovery no
		// longer resolves one.
		it('maps a missing PM credential to safe, actionable copy naming the role', async () => {
			const discover = vi
				.fn()
				.mockRejectedValue(
					new MissingPmCredentialError(
						'swarm',
						'github-projects',
						'apiToken',
						'GitHub Projects API Token',
						'PM_GITHUB_PROJECTS_TOKEN',
						"No PM GitHub Projects API Token (role 'apiToken') configured for project 'swarm'",
					),
				);
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig());
			// biome-ignore lint/suspicious/noExplicitAny: manifest stub is intentionally partial
			vi.mocked(getPMProvider).mockReturnValue(stubManifest(['containers'], discover) as any);

			await expect(caller.discoverContainers({ projectId: 'swarm' })).rejects.toMatchObject({
				code: 'PRECONDITION_FAILED',
				message: expect.stringContaining('GitHub Projects API Token'),
			});
			await expect(caller.discoverContainers({ projectId: 'swarm' })).rejects.toThrow(
				/credentials\.pm\.github-projects\.apiToken.*PM_GITHUB_PROJECTS_TOKEN/s,
			);
			await expect(caller.discoverContainers({ projectId: 'swarm' })).rejects.not.toThrow(
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

	// Issue #641: a request may name a provider the project is not persisted on, so the
	// dashboard's provider switch can pick the incoming board before the switch is saved.
	// An omitted `providerId` is the whole of the behaviour asserted above — these cover
	// what supplying one changes.
	describe('discoverContainers for a provider the project is not on', () => {
		const LINEAR_BLANK: ProjectPm = { type: 'linear', teamId: '', statusOptions: {} };

		it('discovers against the named provider’s blank pm member, leaving the rest of the project intact', async () => {
			const project = createMockProjectConfig();
			const discover = vi.fn().mockResolvedValue({ containers: [{ id: 'T_1', name: 'Core' }] });
			const built: ProjectConfig[] = [];
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(getPMProvider).mockReturnValue(
				// biome-ignore lint/suspicious/noExplicitAny: manifest stub is intentionally partial
				stubManifest(['containers'], discover, {
					id: 'linear',
					blankPm: LINEAR_BLANK,
					createProvider: (candidate) => {
						built.push(candidate);
						return { discover } as unknown as PMProvider;
					},
				}) as any,
			);

			const result = await caller.discoverContainers({
				projectId: 'swarm',
				providerId: 'linear',
			});

			expect(result).toEqual({ containers: [{ id: 'T_1', name: 'Core' }] });
			// The manifest asked for is the one named, never the persisted `pm.type`.
			expect(getPMProvider).toHaveBeenCalledWith('linear');
			expect(built).toHaveLength(1);
			expect(built[0].pm).toEqual(LINEAR_BLANK);
			// Only `pm` is projected: the credential block is the project's own, which is
			// what makes the incoming provider authenticate as itself (`credentials.pm.linear`)
			// with the browser still never handling a secret.
			expect(built[0].id).toBe(project.id);
			expect(built[0].credentials).toBe(project.credentials);
		});

		it('is NOT_FOUND naming the id that was asked for, never a fallback to the persisted provider', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig());
			vi.mocked(getPMProvider).mockReturnValue(null);

			const call = () => caller.discoverContainers({ projectId: 'swarm', providerId: 'trello' });

			await expect(call()).rejects.toMatchObject({
				code: 'NOT_FOUND',
				message: expect.stringContaining("'trello'"),
			});
			// Names what was asked for rather than the provider the project runs on: the
			// point of the refusal is that nothing fell back to it.
			await expect(call()).rejects.not.toThrow(/github-projects/);
			expect(getPMProvider).toHaveBeenCalledWith('trello');
		});

		it('is NOT_IMPLEMENTED when the named provider declares no such capability', async () => {
			const createProvider = vi.fn();
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig());
			vi.mocked(getPMProvider).mockReturnValue(
				// biome-ignore lint/suspicious/noExplicitAny: manifest stub is intentionally partial
				stubManifest([], vi.fn(), { id: 'linear', blankPm: LINEAR_BLANK, createProvider }) as any,
			);

			await expect(
				caller.discoverContainers({ projectId: 'swarm', providerId: 'linear' }),
			).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
			expect(createProvider).not.toHaveBeenCalled();
		});

		// Jira's shape: `baseUrl` is the site every REST call is addressed to *and* board
		// identity kept in `swarm.config.json`, so the manifest declares a blocker and the
		// API refuses before any call rather than failing on an unresolvable URL.
		it('is PRECONDITION_FAILED with the provider’s own actionable copy when its blank member cannot discover', async () => {
			const blocker =
				'Jira discovery needs the site its projects live on. Set pm.baseUrl in swarm.config.json.';
			const createProvider = vi.fn();
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig());
			vi.mocked(getPMProvider).mockReturnValue(
				// biome-ignore lint/suspicious/noExplicitAny: manifest stub is intentionally partial
				stubManifest(['containers'], vi.fn(), {
					id: 'jira',
					blankPm: { type: 'jira', baseUrl: '', projectKey: '', statusOptions: {} },
					blankPmDiscoveryBlocker: blocker,
					createProvider,
				}) as any,
			);

			await expect(
				caller.discoverContainers({ projectId: 'swarm', providerId: 'jira' }),
			).rejects.toMatchObject({
				code: 'PRECONDITION_FAILED',
				message: blocker,
			});
			expect(createProvider).not.toHaveBeenCalled();
		});

		// The blocker is about the *blank* member, not about the provider: a project already
		// persisted on it has the value, so naming its own provider explicitly must behave
		// exactly as omitting the field does.
		it('runs against the real project when the id names the provider it is persisted on', async () => {
			const project = createMockProjectConfig();
			const discover = vi.fn().mockResolvedValue({ containers: [] });
			const built: ProjectConfig[] = [];
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(getPMProvider).mockReturnValue(
				// biome-ignore lint/suspicious/noExplicitAny: manifest stub is intentionally partial
				stubManifest(['containers'], discover, {
					blankPmDiscoveryBlocker: 'never reached for the persisted provider',
					createProvider: (candidate) => {
						built.push(candidate);
						return { discover } as unknown as PMProvider;
					},
				}) as any,
			);

			await caller.discoverContainers({ projectId: 'swarm', providerId: 'github-projects' });

			expect(built[0]).toBe(project);
		});

		it('still hides existence from a non-member', async () => {
			const memberCaller = pmRouter.createCaller({ user: ORDINARY_USER });
			vi.mocked(getMembership).mockResolvedValue(undefined);

			await expect(
				memberCaller.discoverContainers({ projectId: 'swarm', providerId: 'linear' }),
			).rejects.toMatchObject({ code: 'NOT_FOUND' });
			expect(getProjectByIdFromDb).not.toHaveBeenCalled();
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

		// The states half takes the same optional `providerId` (issue #641): the switch flow
		// picks the incoming provider's board, then maps that board's own states.
		it('maps a named provider’s board against its blank pm member', async () => {
			const project = createMockProjectConfig();
			const discover = vi.fn().mockResolvedValue({ states: [{ id: 'l1', name: 'Doing' }] });
			const built: ProjectConfig[] = [];
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(getPMProvider).mockReturnValue(
				// biome-ignore lint/suspicious/noExplicitAny: manifest stub is intentionally partial
				stubManifest(['states'], discover, {
					id: 'trello',
					blankPm: { type: 'trello', boardId: '', statusOptions: {} },
					createProvider: (candidate) => {
						built.push(candidate);
						return { discover } as unknown as PMProvider;
					},
				}) as any,
			);

			const result = await caller.discoverStates({
				projectId: 'swarm',
				containerId: 'board-1',
				providerId: 'trello',
			});

			expect(discover).toHaveBeenCalledWith('states', { containerId: 'board-1' });
			expect(result.states).toEqual([{ id: 'l1', name: 'Doing' }]);
			expect(built[0].pm).toEqual({ type: 'trello', boardId: '', statusOptions: {} });
		});
	});
});
