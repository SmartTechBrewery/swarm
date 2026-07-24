import { DrizzleQueryError } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	listAllProjectsFromDb: vi.fn(),
	listDiscoverableProjectsFromDb: vi.fn(),
	getProjectByIdFromDb: vi.fn(),
	createProjectInDb: vi.fn(),
	createProjectWithMemberInDb: vi.fn(),
	upsertProjectToDb: vi.fn(),
	deleteProjectFromDb: vi.fn(),
}));

vi.mock('@/db/repositories/projectMembersRepository.js', () => ({
	addMember: vi.fn(),
}));

vi.mock('@/db/repositories/projectMembershipRequestsRepository.js', () => ({
	createMembershipRequest: vi.fn(),
	getPendingRequest: vi.fn(),
	getMembershipRequestById: vi.fn(),
	listPendingRequestsForProject: vi.fn(),
	approveMembershipRequestInDb: vi.fn(),
	rejectMembershipRequestInDb: vi.fn(),
}));

vi.mock('@/identity/membership-service.js', () => ({
	getMembership: vi.fn(),
	listAccessibleProjectIds: vi.fn(),
}));

import { DEFAULT_GITHUB_PROJECTS_CONFIG, projectsRouter } from '@/api/routers/projects.js';
import {
	approveMembershipRequestInDb,
	createMembershipRequest,
	getMembershipRequestById,
	getPendingRequest,
	listPendingRequestsForProject,
	rejectMembershipRequestInDb,
} from '@/db/repositories/projectMembershipRequestsRepository.js';
import { addMember } from '@/db/repositories/projectMembersRepository.js';
import {
	createProjectInDb,
	createProjectWithMemberInDb,
	deleteProjectFromDb,
	getProjectByIdFromDb,
	listAllProjectsFromDb,
	listDiscoverableProjectsFromDb,
	upsertProjectToDb,
} from '@/db/repositories/projectsRepository.js';
import {
	canAdministerProject,
	canReadProject,
	canWriteProject,
	type ProjectMembership,
	type ProjectRole,
} from '@/identity/membership.js';
import type { MembershipRequest } from '@/identity/membership-request.js';
import { getMembership, listAccessibleProjectIds } from '@/identity/membership-service.js';
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

function membershipFor(role: ProjectRole, projectId = 'p1'): ProjectMembership {
	return {
		id: '99999999-9999-4999-8999-999999999999',
		projectId,
		userId: ORDINARY_USER.id,
		role,
		createdAt: new Date(0),
	};
}

const REQUEST_ID = '77777777-7777-4777-8777-777777777777';

function requestFor(
	status: MembershipRequest['status'] = 'pending',
	projectId = 'p1',
): MembershipRequest {
	return {
		id: REQUEST_ID,
		projectId,
		userId: ORDINARY_USER.id,
		status,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
}

describe('projectsRouter', () => {
	// The base suite runs as an instanceAdmin, so authorization is bypassed and
	// these assertions cover the pre-authz behaviour unchanged; the project-scoped
	// authorization suite below exercises the ordinary-user paths.
	const AUTHED_USER = ADMIN_USER;
	const caller = projectsRouter.createCaller({ user: AUTHED_USER });

	beforeEach(() => {
		vi.mocked(listAllProjectsFromDb).mockReset();
		vi.mocked(getProjectByIdFromDb).mockReset();
		vi.mocked(createProjectInDb).mockReset();
		vi.mocked(createProjectWithMemberInDb).mockReset();
		vi.mocked(upsertProjectToDb).mockReset();
		vi.mocked(deleteProjectFromDb).mockReset();
		vi.mocked(addMember).mockReset();
		vi.mocked(addMember).mockResolvedValue(membershipFor('projectAdmin'));
		vi.mocked(getMembership).mockReset();
		vi.mocked(listAccessibleProjectIds).mockReset();
		vi.mocked(listDiscoverableProjectsFromDb).mockReset();
		vi.mocked(createMembershipRequest).mockReset();
		vi.mocked(getPendingRequest).mockReset();
		vi.mocked(getMembershipRequestById).mockReset();
		vi.mocked(listPendingRequestsForProject).mockReset();
		vi.mocked(approveMembershipRequestInDb).mockReset();
		vi.mocked(rejectMembershipRequestInDb).mockReset();
	});

	describe('list', () => {
		it('returns whatever listAllProjectsFromDb resolves', async () => {
			const mockProjects = [
				createMockProjectConfig({ id: 'p1' }),
				createMockProjectConfig({ id: 'p2' }),
			];
			vi.mocked(listAllProjectsFromDb).mockResolvedValue(mockProjects);

			const result = await caller.list();
			expect(result).toEqual(mockProjects);
			expect(listAllProjectsFromDb).toHaveBeenCalledTimes(1);
		});

		it('returns an empty array when listAllProjectsFromDb resolves empty', async () => {
			vi.mocked(listAllProjectsFromDb).mockResolvedValue([]);

			const result = await caller.list();
			expect(result).toEqual([]);
			expect(listAllProjectsFromDb).toHaveBeenCalledTimes(1);
		});
	});

	describe('getById', () => {
		it('returns the project when getProjectByIdFromDb resolves one', async () => {
			const project = createMockProjectConfig({ id: 'p1', maxConcurrentJobs: 4 });
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			const result = await caller.getById({ id: 'p1' });
			expect(result).toEqual(project);
			expect(result.maxConcurrentJobs).toBe(4);
			expect(getProjectByIdFromDb).toHaveBeenCalledWith('p1');
		});

		it('throws NOT_FOUND when getProjectByIdFromDb resolves undefined', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.getById({ id: 'missing' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);
		});
	});

	describe('create', () => {
		const validProjectInput = {
			id: 'new-proj',
			name: 'New Project',
			repo: 'jkwiecien/new-proj',
			repoRoot: '/Users/dev/new-proj',
			worktreeRoot: '.swarm-workspaces',
			baseBranch: 'main',
			branchPrefix: 'issue-',
			pm: { type: 'github-projects' as const },
		};

		const defaultCredentials = {
			reviewer: 'SCM_TOKEN_REVIEWER',
			webhookSecret: 'SCM_WEBHOOK_SECRET',
		};

		it('happy path: calls createProjectWithMemberInDb with the input plus credentials and creator membership, and returns the merged object', async () => {
			vi.mocked(createProjectWithMemberInDb).mockResolvedValue(undefined);

			const result = await caller.create(validProjectInput);

			const expectedConfig = {
				...validProjectInput,
				maxConcurrentJobs: 1,
				visibility: 'private',
				githubProjects: DEFAULT_GITHUB_PROJECTS_CONFIG,
				credentials: defaultCredentials,
			};

			expect(result).toEqual(expectedConfig);
			expect(createProjectWithMemberInDb).toHaveBeenCalledWith(expectedConfig, {
				projectId: 'new-proj',
				userId: ADMIN_USER.id,
				role: 'projectAdmin',
			});
		});

		it('create succeeds with only id/name/repo/repoRoot', async () => {
			vi.mocked(createProjectWithMemberInDb).mockResolvedValue(undefined);

			const minimalInput = {
				id: 'minimal-proj',
				name: 'Minimal Project',
				repo: 'jkwiecien/minimal-proj',
				repoRoot: '/Users/dev/minimal-proj',
			};

			const result = await caller.create(minimalInput);

			const expectedConfig = {
				...minimalInput,
				worktreeRoot: '.swarm-workspaces',
				baseBranch: 'main',
				branchPrefix: 'issue-',
				maxConcurrentJobs: 1,
				visibility: 'private',
				pm: { type: 'github-projects' as const },
				githubProjects: DEFAULT_GITHUB_PROJECTS_CONFIG,
				credentials: defaultCredentials,
			};

			expect(result).toEqual(expectedConfig);
			expect(createProjectWithMemberInDb).toHaveBeenCalledWith(expectedConfig, {
				projectId: 'minimal-proj',
				userId: ADMIN_USER.id,
				role: 'projectAdmin',
			});
		});

		it('strips client-supplied credentials and uses defaults instead', async () => {
			vi.mocked(createProjectWithMemberInDb).mockResolvedValue(undefined);

			// Cast as any to simulate malicious/careless client sending credentials key
			const inputWithCreds = {
				...validProjectInput,
				credentials: {
					implementer: 'MALICIOUS_IMPL',
					reviewer: 'MALICIOUS_REV',
					webhookSecret: 'MALICIOUS_SECRET',
				},
			} as unknown as Parameters<typeof caller.create>[0];

			const result = await caller.create(inputWithCreds);

			const expectedConfig = {
				...validProjectInput,
				maxConcurrentJobs: 1,
				visibility: 'private',
				githubProjects: DEFAULT_GITHUB_PROJECTS_CONFIG,
				credentials: defaultCredentials,
			};

			expect(result).toEqual(expectedConfig);
			expect(createProjectWithMemberInDb).toHaveBeenCalledWith(expectedConfig, {
				projectId: 'new-proj',
				userId: ADMIN_USER.id,
				role: 'projectAdmin',
			});
		});

		it('strips client-supplied githubProjects and uses the placeholder default', async () => {
			vi.mocked(createProjectWithMemberInDb).mockResolvedValue(undefined);

			// Cast as any to simulate client sending custom githubProjects
			const inputWithGithubProjects = {
				...validProjectInput,
				githubProjects: {
					projectId: 'CLIENT_ID',
					statusFieldId: 'CLIENT_FIELD_ID',
					statusOptions: { backlog: 'client-backlog' },
				},
			} as unknown as Parameters<typeof caller.create>[0];

			const result = await caller.create(inputWithGithubProjects);

			const expectedConfig = {
				...validProjectInput,
				maxConcurrentJobs: 1,
				visibility: 'private',
				githubProjects: DEFAULT_GITHUB_PROJECTS_CONFIG,
				credentials: defaultCredentials,
			};

			expect(result).toEqual(expectedConfig);
			expect(createProjectWithMemberInDb).toHaveBeenCalledWith(expectedConfig, {
				projectId: 'new-proj',
				userId: ADMIN_USER.id,
				role: 'projectAdmin',
			});
		});

		it('translates duplicate constraint violation (code 23505) to CONFLICT', async () => {
			const error = Object.assign(new Error('Unique violation'), { code: '23505' });
			vi.mocked(createProjectWithMemberInDb).mockRejectedValue(error);

			await expect(caller.create(validProjectInput)).rejects.toThrowError(
				expect.objectContaining({
					code: 'CONFLICT',
					message: 'Project ID or repository already exists',
				}),
			);
		});

		it('translates a drizzle-wrapped unique violation (code on .cause, not top-level) to CONFLICT', async () => {
			// This is the shape drizzle-orm actually throws in production: every
			// node-postgres query error is wrapped in a `DrizzleQueryError`, which
			// has no top-level `code` — the real pg error (carrying `code: '23505'`)
			// is on `.cause`.
			const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
				code: '23505',
			});
			const wrapped = new DrizzleQueryError('insert into "projects" ...', [], pgError);
			vi.mocked(createProjectWithMemberInDb).mockRejectedValue(wrapped);

			await expect(caller.create(validProjectInput)).rejects.toThrowError(
				expect.objectContaining({
					code: 'CONFLICT',
					message: 'Project ID or repository already exists',
				}),
			);
		});

		it('propagates unrelated rejections (such as a transaction membership error) without translating them', async () => {
			const error = new Error('Some DB transaction failure');
			vi.mocked(createProjectWithMemberInDb).mockRejectedValue(error);

			await expect(caller.create(validProjectInput)).rejects.toThrowError(
				'Some DB transaction failure',
			);
		});
	});

	describe('update', () => {
		const existing = createMockProjectConfig({
			id: 'p1',
			name: 'Original Name',
			repo: 'jkwiecien/original',
		});

		it('throws NOT_FOUND when the project does not exist and does not update', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.update({ id: 'missing', name: 'New Name' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);

			expect(upsertProjectToDb).not.toHaveBeenCalled();
		});

		it('happy path: updates project fields while leaving other fields untouched (including credentials)', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const updates = { id: 'p1', name: 'Updated Name', repo: 'jkwiecien/new-repo' };
			const result = await caller.update(updates);

			const expectedConfig = {
				...existing,
				name: 'Updated Name',
				repo: 'jkwiecien/new-repo',
			};

			expect(result).toEqual(expectedConfig);
			expect(upsertProjectToDb).toHaveBeenCalledWith(expectedConfig);
		});

		it('saves the maximum concurrent jobs setting', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const result = await caller.update({ id: 'p1', maxConcurrentJobs: 4 });

			expect(result.maxConcurrentJobs).toBe(4);
			expect(upsertProjectToDb).toHaveBeenCalledWith({
				...existing,
				maxConcurrentJobs: 4,
			});
		});

		it('saves the opt-in auto merge setting', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const result = await caller.update({
				id: 'p1',
				pipeline: { respondToReview: { autoMerge: true } },
			});

			expect(result.pipeline?.respondToReview?.autoMerge).toBe(true);
			expect(upsertProjectToDb).toHaveBeenCalledWith({
				...existing,
				pipeline: { respondToReview: { autoMerge: true } },
			});
		});

		it('saves the default-on skip-minors review-response setting', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const result = await caller.update({
				id: 'p1',
				pipeline: { respondToReview: { skipOnMinors: false } },
			});

			expect(result.pipeline?.respondToReview?.skipOnMinors).toBe(false);
		});

		it('saves the Review check policy while leaving unrelated pipeline fields intact', async () => {
			const withPipeline = createMockProjectConfig({
				id: 'p1',
				name: 'Original Name',
				repo: 'jkwiecien/original',
				pipeline: {
					planning: { autoAdvance: true },
					review: { enabled: true },
					respondToReview: { autoMerge: true, skipOnMinors: false },
				},
			});
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(withPipeline);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const result = await caller.update({
				id: 'p1',
				pipeline: {
					...withPipeline.pipeline,
					review: { ...withPipeline.pipeline?.review, checks: 'if-present' },
				},
			});

			expect(result.pipeline?.review?.checks).toBe('if-present');
			// Unrelated pipeline fields, including the rest of `review`, survive the update.
			expect(result.pipeline?.review?.enabled).toBe(true);
			expect(result.pipeline?.planning?.autoAdvance).toBe(true);
			expect(result.pipeline?.respondToReview).toEqual({ autoMerge: true, skipOnMinors: false });
		});

		it('merges a nested pipeline patch with the existing pipeline configuration', async () => {
			const withPipeline = createMockProjectConfig({
				id: 'p1',
				pipeline: {
					planning: { autoAdvance: true },
					review: { enabled: false },
					respondToReview: { enabled: false, autoMerge: true, skipOnMinors: false },
				},
			});
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(withPipeline);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			// Client sends ONLY the pipeline tab fields patch
			const result = await caller.update({
				id: 'p1',
				pipeline: {
					review: { checks: 'if-present' },
					respondToReview: {
						autoMerge: false,
						skipOnMinors: true,
					},
				},
			});

			expect(result.pipeline?.review?.checks).toBe('if-present');
			// Unrelated/omitted pipeline fields are preserved
			expect(result.pipeline?.review?.enabled).toBe(false);
			expect(result.pipeline?.planning?.autoAdvance).toBe(true);
			expect(result.pipeline?.respondToReview?.enabled).toBe(false);
			expect(result.pipeline?.respondToReview?.autoMerge).toBe(false);
			expect(result.pipeline?.respondToReview?.skipOnMinors).toBe(true);
		});

		it('does not invent a Review check policy for an unrelated update on a project with none stored', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const result = await caller.update({ id: 'p1', name: 'Renamed' });

			expect(result.pipeline?.review?.checks).toBeUndefined();
		});

		it.each([0, -1, 1.5, 'many'])('rejects invalid maximum concurrent jobs: %s', async (value) => {
			await expect(
				caller.update({ id: 'p1', maxConcurrentJobs: value as number }),
			).rejects.toThrow();
			expect(getProjectByIdFromDb).not.toHaveBeenCalled();
			expect(upsertProjectToDb).not.toHaveBeenCalled();
		});

		it('absent keys are not updated/merged to undefined', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			// Pass only id and a change to name, omit other fields
			const result = await caller.update({ id: 'p1', name: 'Name Change Only' });

			const expectedConfig = {
				...existing,
				name: 'Name Change Only',
			};

			expect(result).toEqual(expectedConfig);
			expect(upsertProjectToDb).toHaveBeenCalledWith(expectedConfig);
			// Verifies other attributes like repoRoot, baseBranch etc are still existing values
			expect(result.repo).toBe(existing.repo);
			expect(result.repoRoot).toBe(existing.repoRoot);
		});

		it('translates uniqueness conflicts (e.g. repo collision) to CONFLICT', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			const error = Object.assign(new Error('Unique violation'), { code: '23505' });
			vi.mocked(upsertProjectToDb).mockRejectedValue(error);

			await expect(caller.update({ id: 'p1', name: 'Collision Name' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'CONFLICT',
					message: 'Project ID or repository already exists',
				}),
			);
		});

		it('translates a drizzle-wrapped uniqueness conflict (code on .cause, not top-level) to CONFLICT', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
				code: '23505',
			});
			const wrapped = new DrizzleQueryError('insert into "projects" ...', [], pgError);
			vi.mocked(upsertProjectToDb).mockRejectedValue(wrapped);

			await expect(caller.update({ id: 'p1', name: 'Collision Name' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'CONFLICT',
					message: 'Project ID or repository already exists',
				}),
			);
		});

		it('propagates unrelated rejections without translating them', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			const error = new Error('Some DB connection error');
			vi.mocked(upsertProjectToDb).mockRejectedValue(error);

			await expect(caller.update({ id: 'p1', name: 'Error Name' })).rejects.toThrowError(
				'Some DB connection error',
			);
		});
	});

	describe('delete', () => {
		const existing = createMockProjectConfig({ id: 'p1' });

		it('throws NOT_FOUND when the project does not exist and does not delete', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.delete({ id: 'missing' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);

			expect(deleteProjectFromDb).not.toHaveBeenCalled();
		});

		it('happy path: calls deleteProjectFromDb(id) when project existence check passes', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
			vi.mocked(deleteProjectFromDb).mockResolvedValue(undefined);

			await expect(caller.delete({ id: 'p1' })).resolves.toBeUndefined();
			expect(deleteProjectFromDb).toHaveBeenCalledWith('p1');
		});
	});

	// The #281 task-4 acceptance cases: admin override, no-membership denial, and
	// project-role boundaries — exercised through an ordinary (non-admin) caller
	// with the membership service mocked.
	describe('project-scoped authorization', () => {
		const ordinary = projectsRouter.createCaller({ user: ORDINARY_USER });

		describe('list', () => {
			it('instanceAdmin sees every project (no membership filtering)', async () => {
				const all = [createMockProjectConfig({ id: 'p1' }), createMockProjectConfig({ id: 'p2' })];
				vi.mocked(listAllProjectsFromDb).mockResolvedValue(all);

				await expect(caller.list()).resolves.toEqual(all);
				expect(listAccessibleProjectIds).not.toHaveBeenCalled();
			});

			it('a member sees only the projects in their accessible set', async () => {
				const all = [
					createMockProjectConfig({ id: 'p1' }),
					createMockProjectConfig({ id: 'p2' }),
					createMockProjectConfig({ id: 'p3' }),
				];
				vi.mocked(listAllProjectsFromDb).mockResolvedValue(all);
				vi.mocked(listAccessibleProjectIds).mockResolvedValue(['p1', 'p3']);

				const result = await ordinary.list();
				expect(result.map((p) => p.id)).toEqual(['p1', 'p3']);
				expect(listAccessibleProjectIds).toHaveBeenCalledWith(ORDINARY_USER.id);
			});

			it('a member with no memberships sees nothing', async () => {
				vi.mocked(listAllProjectsFromDb).mockResolvedValue([createMockProjectConfig({ id: 'p1' })]);
				vi.mocked(listAccessibleProjectIds).mockResolvedValue([]);

				await expect(ordinary.list()).resolves.toEqual([]);
			});
		});

		describe('getById', () => {
			it('denies a non-member with NOT_FOUND without reading the project', async () => {
				vi.mocked(getMembership).mockResolvedValue(undefined);

				await expect(ordinary.getById({ id: 'p1' })).rejects.toThrowError(
					expect.objectContaining({ code: 'NOT_FOUND' }),
				);
				expect(getProjectByIdFromDb).not.toHaveBeenCalled();
			});

			it('lets a contributor read the project', async () => {
				vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));
				const project = createMockProjectConfig({ id: 'p1' });
				vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

				await expect(ordinary.getById({ id: 'p1' })).resolves.toEqual(project);
			});
		});

		describe('update / delete role boundary', () => {
			it('forbids a member from updating project config', async () => {
				vi.mocked(getMembership).mockResolvedValue(membershipFor('member'));

				await expect(ordinary.update({ id: 'p1', name: 'Nope' })).rejects.toThrowError(
					expect.objectContaining({ code: 'FORBIDDEN' }),
				);
				expect(getProjectByIdFromDb).not.toHaveBeenCalled();
				expect(upsertProjectToDb).not.toHaveBeenCalled();
			});

			it('lets a projectAdmin update project config', async () => {
				vi.mocked(getMembership).mockResolvedValue(membershipFor('projectAdmin'));
				const existing = createMockProjectConfig({ id: 'p1', name: 'Old' });
				vi.mocked(getProjectByIdFromDb).mockResolvedValue(existing);
				vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

				const result = await ordinary.update({ id: 'p1', name: 'New' });
				expect(result.name).toBe('New');
				expect(upsertProjectToDb).toHaveBeenCalled();
			});

			it('denies a non-member delete with NOT_FOUND', async () => {
				vi.mocked(getMembership).mockResolvedValue(undefined);

				await expect(ordinary.delete({ id: 'p1' })).rejects.toThrowError(
					expect.objectContaining({ code: 'NOT_FOUND' }),
				);
				expect(deleteProjectFromDb).not.toHaveBeenCalled();
			});

			it('forbids a contributor from deleting a project', async () => {
				vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));

				await expect(ordinary.delete({ id: 'p1' })).rejects.toThrowError(
					expect.objectContaining({ code: 'FORBIDDEN' }),
				);
				expect(deleteProjectFromDb).not.toHaveBeenCalled();
			});
		});

		describe('create', () => {
			it('records the creator as a projectAdmin member in the atomic transaction', async () => {
				vi.mocked(createProjectWithMemberInDb).mockResolvedValue(undefined);

				await ordinary.create({
					id: 'new-proj',
					name: 'New Project',
					repo: 'jkwiecien/new-proj',
					repoRoot: '/Users/dev/new-proj',
				});

				expect(createProjectWithMemberInDb).toHaveBeenCalledWith(
					expect.objectContaining({ id: 'new-proj' }),
					{
						projectId: 'new-proj',
						userId: ORDINARY_USER.id,
						role: 'projectAdmin',
					},
				);
			});

			it('fails project creation and propagates error if membership insertion inside transaction fails', async () => {
				vi.mocked(createProjectWithMemberInDb).mockRejectedValue(
					new Error('Membership insert failed'),
				);

				await expect(
					ordinary.create({
						id: 'failed-member',
						name: 'Failed Member',
						repo: 'jkwiecien/failed-member',
						repoRoot: '/Users/dev/failed-member',
					}),
				).rejects.toThrowError('Membership insert failed');
			});
		});
	});

	// #281 task 5: the open-project policy — a limited public-discovery read and
	// a request/approve join flow, kept strictly separate from execution/routing.
	describe('open-project discovery & join flow', () => {
		const ordinary = projectsRouter.createCaller({ user: ORDINARY_USER });

		describe('listDiscoverable', () => {
			it('returns discoverable projects the caller is not already a member of', async () => {
				vi.mocked(listAccessibleProjectIds).mockResolvedValue(['p1']);
				vi.mocked(listDiscoverableProjectsFromDb).mockResolvedValue([
					{ id: 'p1', name: 'Already Mine' },
					{ id: 'p2', name: 'Open Two' },
					{ id: 'p3', name: 'Open Three' },
				]);

				const result = await ordinary.listDiscoverable();
				expect(result.map((p) => p.id)).toEqual(['p2', 'p3']);
			});

			it('exposes only id + name — never credentials, config, repo, or run internals', async () => {
				vi.mocked(listAccessibleProjectIds).mockResolvedValue([]);
				vi.mocked(listDiscoverableProjectsFromDb).mockResolvedValue([
					{ id: 'p2', name: 'Open Two' },
				]);

				const result = await ordinary.listDiscoverable();
				// The limited view carries exactly the discovery fields and nothing else,
				// so a secret can never ride along on the discovery surface.
				expect(Object.keys(result[0]).sort()).toEqual(['id', 'name']);
			});

			it('returns nothing for an instanceAdmin (they already access every project)', async () => {
				const result = await caller.listDiscoverable();
				expect(result).toEqual([]);
				// Short-circuits before even querying discoverable projects.
				expect(listDiscoverableProjectsFromDb).not.toHaveBeenCalled();
				expect(listAccessibleProjectIds).not.toHaveBeenCalled();
			});
		});

		describe('requestMembership', () => {
			it('files a pending request for a discoverable project the caller may not access', async () => {
				vi.mocked(getProjectByIdFromDb).mockResolvedValue(
					createMockProjectConfig({ id: 'p1', visibility: 'discoverable' }),
				);
				vi.mocked(getMembership).mockResolvedValue(undefined);
				vi.mocked(getPendingRequest).mockResolvedValue(undefined);
				vi.mocked(createMembershipRequest).mockResolvedValue(requestFor('pending'));

				const result = await ordinary.requestMembership({ projectId: 'p1' });
				expect(result.status).toBe('pending');
				expect(createMembershipRequest).toHaveBeenCalledWith({
					projectId: 'p1',
					userId: ORDINARY_USER.id,
				});
			});

			it('hides a private project: NOT_FOUND, and files no request', async () => {
				vi.mocked(getProjectByIdFromDb).mockResolvedValue(
					createMockProjectConfig({ id: 'p1', visibility: 'private' }),
				);

				await expect(ordinary.requestMembership({ projectId: 'p1' })).rejects.toThrowError(
					expect.objectContaining({ code: 'NOT_FOUND' }),
				);
				expect(createMembershipRequest).not.toHaveBeenCalled();
			});

			it('is NOT_FOUND for an unknown project', async () => {
				vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

				await expect(ordinary.requestMembership({ projectId: 'missing' })).rejects.toThrowError(
					expect.objectContaining({ code: 'NOT_FOUND' }),
				);
			});

			it('rejects an already-member with CONFLICT', async () => {
				vi.mocked(getProjectByIdFromDb).mockResolvedValue(
					createMockProjectConfig({ id: 'p1', visibility: 'discoverable' }),
				);
				vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));

				await expect(ordinary.requestMembership({ projectId: 'p1' })).rejects.toThrowError(
					expect.objectContaining({ code: 'CONFLICT' }),
				);
				expect(createMembershipRequest).not.toHaveBeenCalled();
			});

			it('rejects a duplicate pending request with CONFLICT', async () => {
				vi.mocked(getProjectByIdFromDb).mockResolvedValue(
					createMockProjectConfig({ id: 'p1', visibility: 'discoverable' }),
				);
				vi.mocked(getMembership).mockResolvedValue(undefined);
				vi.mocked(getPendingRequest).mockResolvedValue(requestFor('pending'));

				await expect(ordinary.requestMembership({ projectId: 'p1' })).rejects.toThrowError(
					expect.objectContaining({ code: 'CONFLICT' }),
				);
				expect(createMembershipRequest).not.toHaveBeenCalled();
			});
		});

		describe('listMembershipRequests', () => {
			it('denies a non-member with NOT_FOUND (existence hidden)', async () => {
				vi.mocked(getMembership).mockResolvedValue(undefined);

				await expect(ordinary.listMembershipRequests({ projectId: 'p1' })).rejects.toThrowError(
					expect.objectContaining({ code: 'NOT_FOUND' }),
				);
				expect(listPendingRequestsForProject).not.toHaveBeenCalled();
			});

			it('forbids a contributor (join grants read, not administration)', async () => {
				vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));

				await expect(ordinary.listMembershipRequests({ projectId: 'p1' })).rejects.toThrowError(
					expect.objectContaining({ code: 'FORBIDDEN' }),
				);
			});

			it('lets a projectAdmin list the pending requests', async () => {
				vi.mocked(getMembership).mockResolvedValue(membershipFor('projectAdmin'));
				vi.mocked(listPendingRequestsForProject).mockResolvedValue([requestFor('pending')]);

				const result = await ordinary.listMembershipRequests({ projectId: 'p1' });
				expect(result).toHaveLength(1);
				expect(listPendingRequestsForProject).toHaveBeenCalledWith('p1');
			});
		});

		describe('approveMembershipRequest', () => {
			it('is NOT_FOUND for an unknown request', async () => {
				vi.mocked(getMembershipRequestById).mockResolvedValue(undefined);

				await expect(
					ordinary.approveMembershipRequest({ requestId: REQUEST_ID }),
				).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
				expect(approveMembershipRequestInDb).not.toHaveBeenCalled();
			});

			it('hides the request from a non-member of its project (NOT_FOUND)', async () => {
				vi.mocked(getMembershipRequestById).mockResolvedValue(requestFor('pending'));
				vi.mocked(getMembership).mockResolvedValue(undefined);

				await expect(
					ordinary.approveMembershipRequest({ requestId: REQUEST_ID }),
				).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
				expect(approveMembershipRequestInDb).not.toHaveBeenCalled();
			});

			it('forbids a non-admin member from approving', async () => {
				vi.mocked(getMembershipRequestById).mockResolvedValue(requestFor('pending'));
				vi.mocked(getMembership).mockResolvedValue(membershipFor('member'));

				await expect(
					ordinary.approveMembershipRequest({ requestId: REQUEST_ID }),
				).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
				expect(approveMembershipRequestInDb).not.toHaveBeenCalled();
			});

			it('lets a projectAdmin approve a pending request → contributor', async () => {
				vi.mocked(getMembershipRequestById).mockResolvedValue(requestFor('pending'));
				vi.mocked(getMembership).mockResolvedValue(membershipFor('projectAdmin'));
				vi.mocked(approveMembershipRequestInDb).mockResolvedValue(true);

				const result = await ordinary.approveMembershipRequest({ requestId: REQUEST_ID });
				expect(result.status).toBe('approved');
				expect(approveMembershipRequestInDb).toHaveBeenCalledWith(requestFor('pending'));
			});

			it('is CONFLICT when the request is already resolved', async () => {
				vi.mocked(getMembershipRequestById).mockResolvedValue(requestFor('approved'));
				vi.mocked(getMembership).mockResolvedValue(membershipFor('projectAdmin'));

				await expect(
					ordinary.approveMembershipRequest({ requestId: REQUEST_ID }),
				).rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
				expect(approveMembershipRequestInDb).not.toHaveBeenCalled();
			});

			it('surfaces CONFLICT when conditional transition fails in DB repository (lost race)', async () => {
				vi.mocked(getMembershipRequestById).mockResolvedValue(requestFor('pending'));
				vi.mocked(getMembership).mockResolvedValue(membershipFor('projectAdmin'));
				vi.mocked(approveMembershipRequestInDb).mockResolvedValue(false);

				await expect(
					ordinary.approveMembershipRequest({ requestId: REQUEST_ID }),
				).rejects.toThrowError(
					expect.objectContaining({
						code: 'CONFLICT',
						message: 'This membership request has already been resolved.',
					}),
				);
			});
		});

		describe('rejectMembershipRequest', () => {
			it('lets a projectAdmin reject a pending request without granting membership', async () => {
				vi.mocked(getMembershipRequestById).mockResolvedValue(requestFor('pending'));
				vi.mocked(getMembership).mockResolvedValue(membershipFor('projectAdmin'));
				vi.mocked(rejectMembershipRequestInDb).mockResolvedValue(true);

				const result = await ordinary.rejectMembershipRequest({ requestId: REQUEST_ID });
				expect(result.status).toBe('rejected');
				expect(rejectMembershipRequestInDb).toHaveBeenCalledWith(REQUEST_ID);
			});

			it('forbids a contributor from rejecting', async () => {
				vi.mocked(getMembershipRequestById).mockResolvedValue(requestFor('pending'));
				vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));

				await expect(
					ordinary.rejectMembershipRequest({ requestId: REQUEST_ID }),
				).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
			});

			it('surfaces CONFLICT when conditional transition fails in DB repository (lost race)', async () => {
				vi.mocked(getMembershipRequestById).mockResolvedValue(requestFor('pending'));
				vi.mocked(getMembership).mockResolvedValue(membershipFor('projectAdmin'));
				vi.mocked(rejectMembershipRequestInDb).mockResolvedValue(false);

				await expect(
					ordinary.rejectMembershipRequest({ requestId: REQUEST_ID }),
				).rejects.toThrowError(
					expect.objectContaining({
						code: 'CONFLICT',
						message: 'This membership request has already been resolved.',
					}),
				);
			});
		});

		// The separation guardrail: a `contributor` gained by joining is read-only.
		// It confers no write/administration capability — and nothing in this task
		// wires any role to worker registration or task routing (out of scope, #130/#132).
		it('a contributor gained via join has read access only, never write/admin', () => {
			expect(canReadProject('contributor')).toBe(true);
			expect(canWriteProject('contributor')).toBe(false);
			expect(canAdministerProject('contributor')).toBe(false);
		});
	});
});
