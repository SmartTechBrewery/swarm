import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	resolveAllProjectCredentials: vi.fn(),
	writeProjectCredential: vi.fn(),
	deleteProjectCredential: vi.fn(),
}));

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	getProjectByIdFromDb: vi.fn(),
	// The PM procedures persist the `credentials.pm` role → reference map through the
	// project row (issue #537).
	upsertProjectToDb: vi.fn(),
}));

vi.mock('@/identity/membership-service.js', () => ({
	getMembership: vi.fn(),
	listAccessibleProjectIds: vi.fn(),
}));

// Registers the real PM manifests, so the PM procedures below resolve the roles
// GitHub Projects actually declares rather than a stub's.
import '@/integrations/entrypoint.js';
import { credentialsRouter } from '@/api/routers/credentials.js';
import {
	deleteProjectCredential,
	resolveAllProjectCredentials,
	writeProjectCredential,
} from '@/db/repositories/credentialsRepository.js';
import { getProjectByIdFromDb, upsertProjectToDb } from '@/db/repositories/projectsRepository.js';
import type { ProjectMembership, ProjectRole } from '@/identity/membership.js';
import { getMembership } from '@/identity/membership-service.js';
import type { SwarmUser } from '@/identity/schema.js';
import { createMockProjectConfig } from '../../../helpers/factories.js';

const ADMIN_USER: SwarmUser = {
	id: '00000000-0000-4000-8000-000000000000',
	identifier: 'tester@example.com',
	displayName: 'Tester',
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
		projectId: 'p1',
		userId: ORDINARY_USER.id,
		role,
		createdAt: new Date(0),
	};
}

describe('credentialsRouter', () => {
	const AUTHED_USER = ADMIN_USER;
	const caller = credentialsRouter.createCaller({ user: AUTHED_USER });

	beforeEach(() => {
		vi.mocked(getProjectByIdFromDb).mockReset();
		vi.mocked(resolveAllProjectCredentials).mockReset();
		vi.mocked(writeProjectCredential).mockReset();
		vi.mocked(deleteProjectCredential).mockReset();
		vi.mocked(getMembership).mockReset();
	});

	describe('list', () => {
		const project = createMockProjectConfig({ id: 'p1' });

		it('masks a long configured value to the same fixed marker, with no secret characters in the response', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({
				SCM_TOKEN_REVIEWER: 'test-token-reviewer',
			});

			const result = await caller.list({ projectId: 'p1' });
			const raw = JSON.stringify(result);

			expect(raw).not.toContain('test-token-reviewer');
			expect(raw).not.toContain('1234');

			const entry = result.find((r) => r.role === 'reviewer');
			expect(entry).toEqual({
				role: 'reviewer',
				envVarKey: 'SCM_TOKEN_REVIEWER',
				isConfigured: true,
				maskedValue: '****',
			});
		});

		it('masks a short configured value to the identical fixed marker as a long one', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({
				SCM_TOKEN_REVIEWER: 'short',
			});

			const result = await caller.list({ projectId: 'p1' });
			const entry = result.find((r) => r.role === 'reviewer');
			expect(entry?.maskedValue).toBe('****');
		});

		it('resolves a project still storing a legacy GitHub-named reference, unmigrated', async () => {
			const legacyProject = createMockProjectConfig({
				id: 'p1',
				credentials: {
					reviewer: 'GITHUB_TOKEN_REVIEWER',
					webhookSecret: 'GITHUB_WEBHOOK_SECRET',
					pm: { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
				},
			});
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(legacyProject);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({
				GITHUB_TOKEN_REVIEWER: 'test-token-reviewer',
			});

			const result = await caller.list({ projectId: 'p1' });
			const entry = result.find((r) => r.role === 'reviewer');
			expect(entry).toEqual({
				role: 'reviewer',
				envVarKey: 'GITHUB_TOKEN_REVIEWER',
				isConfigured: true,
				maskedValue: '****',
			});
		});

		it('reports an unconfigured slot as isConfigured: false, maskedValue: "not set"', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({});

			const result = await caller.list({ projectId: 'p1' });
			const entry = result.find((r) => r.role === 'reviewer');
			expect(entry).toEqual({
				role: 'reviewer',
				envVarKey: 'SCM_TOKEN_REVIEWER',
				isConfigured: false,
				maskedValue: 'not set',
			});
		});

		it('returns one entry per declared reference, in stable role order (implementer is not project-scoped)', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({});

			const result = await caller.list({ projectId: 'p1' });
			expect(result.map((r) => r.role)).toEqual(['reviewer', 'webhookSecret']);
		});

		it('throws NOT_FOUND for an unknown project without resolving credentials', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.list({ projectId: 'missing' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);
			expect(resolveAllProjectCredentials).not.toHaveBeenCalled();
		});
	});

	describe('set', () => {
		const project = createMockProjectConfig({ id: 'p1' });

		it('calls writeProjectCredential with the given args', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(writeProjectCredential).mockResolvedValue(undefined);

			await caller.set({ projectId: 'p1', envVarKey: 'SCM_TOKEN_REVIEWER', value: 'secret' });

			expect(writeProjectCredential).toHaveBeenCalledWith(
				'p1',
				'SCM_TOKEN_REVIEWER',
				'secret',
				null,
			);
		});

		it('passes name through when provided', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(writeProjectCredential).mockResolvedValue(undefined);

			await caller.set({
				projectId: 'p1',
				envVarKey: 'SCM_TOKEN_REVIEWER',
				value: 'secret',
				name: 'Implementer token',
			});

			expect(writeProjectCredential).toHaveBeenCalledWith(
				'p1',
				'SCM_TOKEN_REVIEWER',
				'secret',
				'Implementer token',
			);
		});

		it('rejects an invalid envVarKey before touching the repository', async () => {
			await expect(
				caller.set({ projectId: 'p1', envVarKey: 'not-upper-snake', value: 'secret' }),
			).rejects.toThrow();
			expect(writeProjectCredential).not.toHaveBeenCalled();
			expect(getProjectByIdFromDb).not.toHaveBeenCalled();
		});

		it('rejects an empty value before touching the repository', async () => {
			await expect(
				caller.set({ projectId: 'p1', envVarKey: 'SCM_TOKEN_REVIEWER', value: '' }),
			).rejects.toThrow();
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});

		it('throws NOT_FOUND for an unknown project without writing', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(
				caller.set({
					projectId: 'missing',
					envVarKey: 'SCM_TOKEN_REVIEWER',
					value: 'secret',
				}),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});
	});

	describe('delete', () => {
		const project = createMockProjectConfig({ id: 'p1' });

		it('calls deleteProjectCredential with the given args', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(deleteProjectCredential).mockResolvedValue(undefined);

			await caller.delete({ projectId: 'p1', envVarKey: 'SCM_TOKEN_REVIEWER' });

			expect(deleteProjectCredential).toHaveBeenCalledWith('p1', 'SCM_TOKEN_REVIEWER');
		});

		it('throws NOT_FOUND for an unknown project without deleting', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(
				caller.delete({ projectId: 'missing', envVarKey: 'SCM_TOKEN_REVIEWER' }),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);
			expect(deleteProjectCredential).not.toHaveBeenCalled();
		});
	});

	// The PM half (issue #537): the roles come from the project's PM provider manifest,
	// the client names a role rather than a store key, and no secret is ever returned.
	describe('listPm', () => {
		const project = createMockProjectConfig({ id: 'p1' });

		it("returns the provider's declared roles with their configured state", async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({
				PM_GITHUB_PROJECTS_TOKEN: 'ghp_board_token',
			});

			const result = await caller.listPm({ projectId: 'p1' });

			expect(result.providerId).toBe('github-projects');
			expect(result.providerLabel).toBe('GitHub Projects');
			expect(result.providerRegistered).toBe(true);
			expect(JSON.stringify(result)).not.toContain('ghp_board_token');
			expect(result.roles).toContainEqual(
				expect.objectContaining({
					role: 'apiToken',
					label: 'GitHub Projects API Token',
					envVarKey: 'PM_GITHUB_PROJECTS_TOKEN',
					referenceKey: 'PM_GITHUB_PROJECTS_TOKEN',
					optional: false,
					isConfigured: true,
					maskedValue: '****',
				}),
			);
		});

		it('reports an inherited role against the shared reference it resolves through', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({ SCM_WEBHOOK_SECRET: 'whsec' });

			const result = await caller.listPm({ projectId: 'p1' });
			const webhook = result.roles.find((role) => role.role === 'webhookSecret');

			expect(webhook).toMatchObject({
				inheritsSharedCredential: 'webhookSecret',
				referenceKey: 'SCM_WEBHOOK_SECRET',
				isConfigured: true,
			});
		});

		it('reports an unconfigured role as not set', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({});

			const result = await caller.listPm({ projectId: 'p1' });
			const apiToken = result.roles.find((role) => role.role === 'apiToken');

			expect(apiToken).toMatchObject({ isConfigured: false, maskedValue: 'not set' });
		});

		// An empty stored row is what `resolvePmCredential` treats as absent, so
		// reporting it as configured would have the panel claim the board is set up
		// while every board call answers "no credential configured".
		it('reports an empty stored value as not configured', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({ PM_GITHUB_PROJECTS_TOKEN: '' });

			const result = await caller.listPm({ projectId: 'p1' });
			const apiToken = result.roles.find((role) => role.role === 'apiToken');

			expect(apiToken).toMatchObject({ isConfigured: false, maskedValue: 'not set' });
		});

		it('throws NOT_FOUND for an unknown project', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.listPm({ projectId: 'missing' })).rejects.toThrowError(
				expect.objectContaining({ code: 'NOT_FOUND' }),
			);
		});
	});

	describe('setPm', () => {
		it("stores the secret under the role's declared key and records the reference", async () => {
			// A project row with no `credentials.pm` at all: the dashboard-only setup path,
			// and every project persisted before #537 (DB reads don't re-validate, so this
			// state is reachable and must be fixable from the UI). Assembled rather than
			// parsed, because `ProjectConfigSchema` now rejects it.
			const project = {
				...createMockProjectConfig({ id: 'p1' }),
				credentials: { reviewer: 'SCM_TOKEN_REVIEWER', webhookSecret: 'SCM_WEBHOOK_SECRET' },
			};
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			await caller.setPm({ projectId: 'p1', role: 'apiToken', value: 'ghp_board_token' });

			expect(writeProjectCredential).toHaveBeenCalledWith(
				'p1',
				'PM_GITHUB_PROJECTS_TOKEN',
				'ghp_board_token',
				'GitHub Projects API Token',
			);
			expect(upsertProjectToDb).toHaveBeenCalledWith(
				expect.objectContaining({
					credentials: expect.objectContaining({
						pm: { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
					}),
				}),
			);
		});

		it("replaces the value at the project's existing reference without rewriting the row", async () => {
			const project = createMockProjectConfig({
				id: 'p1',
				credentials: {
					reviewer: 'SCM_TOKEN_REVIEWER',
					webhookSecret: 'SCM_WEBHOOK_SECRET',
					pm: { apiToken: 'CUSTOM_BOARD_TOKEN' },
				},
			});
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			await caller.setPm({ projectId: 'p1', role: 'apiToken', value: 'ghp_new' });

			expect(writeProjectCredential).toHaveBeenCalledWith(
				'p1',
				'CUSTOM_BOARD_TOKEN',
				'ghp_new',
				'GitHub Projects API Token',
			);
			expect(upsertProjectToDb).not.toHaveBeenCalled();
		});

		// The role *is* the shared SCM webhook secret (declared as data on the manifest),
		// so writing it here would fork one secret into two places.
		it('refuses a role that inherits a shared SCM credential, saying where it lives', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));

			await expect(
				caller.setPm({ projectId: 'p1', role: 'webhookSecret', value: 'whsec' }),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'BAD_REQUEST',
					message: expect.stringContaining('Source Control tab'),
				}),
			);
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});

		it('refuses a role the provider does not declare', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));

			await expect(
				caller.setPm({ projectId: 'p1', role: 'apiKey', value: 'lin_api' }),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'BAD_REQUEST',
					message: expect.stringContaining("declares no credential role 'apiKey'"),
				}),
			);
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});

		it('throws NOT_FOUND for an unknown project without writing', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(
				caller.setPm({ projectId: 'missing', role: 'apiToken', value: 'ghp' }),
			).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});
	});

	describe('deletePm', () => {
		it('clears the stored secret and drops the reference so nothing ambient resolves', async () => {
			const project = createMockProjectConfig({ id: 'p1' });
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			await caller.deletePm({ projectId: 'p1', role: 'apiToken' });

			expect(deleteProjectCredential).toHaveBeenCalledWith('p1', 'PM_GITHUB_PROJECTS_TOKEN');
			expect(upsertProjectToDb).toHaveBeenCalledWith(
				expect.objectContaining({ credentials: expect.objectContaining({ pm: {} }) }),
			);
		});

		it('refuses to clear an inherited role', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));

			await expect(
				caller.deletePm({ projectId: 'p1', role: 'webhookSecret' }),
			).rejects.toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
			expect(deleteProjectCredential).not.toHaveBeenCalled();
		});
	});

	// Reading the masked list needs `contributor`; writing or clearing a
	// credential is `projectAdmin`-only (#281 task 4).
	describe('project-scoped authorization', () => {
		const ordinary = credentialsRouter.createCaller({ user: ORDINARY_USER });

		it('denies a non-member list with NOT_FOUND without resolving credentials', async () => {
			vi.mocked(getMembership).mockResolvedValue(undefined);

			await expect(ordinary.list({ projectId: 'p1' })).rejects.toThrowError(
				expect.objectContaining({ code: 'NOT_FOUND' }),
			);
			expect(getProjectByIdFromDb).not.toHaveBeenCalled();
			expect(resolveAllProjectCredentials).not.toHaveBeenCalled();
		});

		it('lets a contributor read the masked list', async () => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({});

			await expect(ordinary.list({ projectId: 'p1' })).resolves.toHaveLength(2);
		});

		it('forbids a member from setting a credential', async () => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('member'));

			await expect(
				ordinary.set({ projectId: 'p1', envVarKey: 'SCM_TOKEN_REVIEWER', value: 'secret' }),
			).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});

		it('lets a projectAdmin set a credential', async () => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('projectAdmin'));
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));
			vi.mocked(writeProjectCredential).mockResolvedValue(undefined);

			await ordinary.set({ projectId: 'p1', envVarKey: 'SCM_TOKEN_REVIEWER', value: 'secret' });
			expect(writeProjectCredential).toHaveBeenCalledWith(
				'p1',
				'SCM_TOKEN_REVIEWER',
				'secret',
				null,
			);
		});

		it('forbids a contributor from deleting a credential', async () => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));

			await expect(
				ordinary.delete({ projectId: 'p1', envVarKey: 'SCM_TOKEN_REVIEWER' }),
			).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
			expect(deleteProjectCredential).not.toHaveBeenCalled();
		});

		// The PM procedures sit on the same boundary: a contributor may read the masked
		// role list, only a projectAdmin may write or clear one.
		it('lets a contributor read the PM role list', async () => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({});

			await expect(ordinary.listPm({ projectId: 'p1' })).resolves.toMatchObject({
				providerId: 'github-projects',
			});
		});

		it('forbids a contributor from setting or clearing a PM credential', async () => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));

			await expect(
				ordinary.setPm({ projectId: 'p1', role: 'apiToken', value: 'ghp' }),
			).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
			await expect(ordinary.deletePm({ projectId: 'p1', role: 'apiToken' })).rejects.toThrowError(
				expect.objectContaining({ code: 'FORBIDDEN' }),
			);
			expect(writeProjectCredential).not.toHaveBeenCalled();
			expect(deleteProjectCredential).not.toHaveBeenCalled();
		});
	});
});
