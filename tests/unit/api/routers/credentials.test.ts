import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	resolveAllProjectCredentials: vi.fn(),
	writeProjectCredential: vi.fn(),
	deleteProjectCredential: vi.fn(),
}));

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	getProjectByIdFromDb: vi.fn(),
}));

vi.mock('@/identity/membership-service.js', () => ({
	getMembership: vi.fn(),
	listAccessibleProjectIds: vi.fn(),
}));

import { credentialsRouter } from '@/api/routers/credentials.js';
import {
	deleteProjectCredential,
	resolveAllProjectCredentials,
	writeProjectCredential,
} from '@/db/repositories/credentialsRepository.js';
import { getProjectByIdFromDb } from '@/db/repositories/projectsRepository.js';
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
	});
});
