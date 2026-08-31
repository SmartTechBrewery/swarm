import { DrizzleQueryError } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/projectsRepository.js', async () => ({
	// The conflict error is a real class the router narrows on `instanceof`, so it is
	// imported rather than stubbed.
	ProjectRepositoryConflictError: (
		await vi.importActual<typeof import('@/db/repositories/projectsRepository.js')>(
			'@/db/repositories/projectsRepository.js',
		)
	).ProjectRepositoryConflictError,
	listAllProjectRecordsFromDb: vi.fn(),
	listDiscoverableProjectsFromDb: vi.fn(),
	findProjectRecordByIdFromDb: vi.fn(),
	createProjectInDb: vi.fn(),
	createProjectWithMemberInDb: vi.fn(),
	upsertProjectToDb: vi.fn(),
	deleteProjectFromDb: vi.fn(),
	deleteIdleProjectFromDb: vi.fn(),
}));

vi.mock('@/db/repositories/projectMembersRepository.js', () => ({
	addMember: vi.fn(),
}));

// The router no longer reads the run side for `delete` (issue #854): the existence
// check, the in-flight check and the row delete are one transaction inside
// `deleteIdleProjectFromDb`, so what is asserted here is the mapping of its outcome
// onto NOT_FOUND / CONFLICT / success. The transaction's own locking is covered by
// `tests/integration/db/projectsRepository.test.ts`.

// The two halves of `create`'s instance-default seeding (issue #769 phase 2/2): the
// value is read from the instance tier and written into the new project's own row.
vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	writeProjectCredential: vi.fn(),
}));

vi.mock('@/db/repositories/instanceCredentialsRepository.js', () => ({
	resolveInstanceScmCredential: vi.fn(),
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
	listProjectsForUser: vi.fn(),
}));

import { DEFAULT_PM_CONFIG, projectsRouter } from '@/api/routers/projects.js';
import { writeProjectCredential } from '@/db/repositories/credentialsRepository.js';
import { resolveInstanceScmCredential } from '@/db/repositories/instanceCredentialsRepository.js';
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
	deleteIdleProjectFromDb,
	deleteProjectFromDb,
	findProjectRecordByIdFromDb,
	listAllProjectRecordsFromDb,
	listDiscoverableProjectsFromDb,
	ProjectRepositoryConflictError,
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
import {
	getMembership,
	listAccessibleProjectIds,
	listProjectsForUser,
} from '@/identity/membership-service.js';
import type { SwarmUser } from '@/identity/schema.js';
import type { PMProviderManifest } from '@/integrations/pm/manifest.js';
import {
	_resetPMProviderRegistryForTesting,
	registerPMProvider,
} from '@/integrations/pm/registry.js';
// The real manifests, for the instance-default suite below: the eligible `(provider,
// role)` set is manifest data, so seeding is asserted against the providers SWARM
// actually ships rather than against a stub that opted itself in. Importing them
// registers them, which `create`'s own `beforeEach` immediately resets — that suite
// deliberately runs on stubs (see its comment), so the two re-register per test.
import { bitbucketScmManifest } from '@/integrations/scm/bitbucket/index.js';
import { githubScmManifest } from '@/integrations/scm/github/index.js';
import { gitlabScmManifest } from '@/integrations/scm/gitlab/index.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	registerSCMProvider,
} from '@/integrations/scm/registry.js';
import { createMockProjectRecord } from '../../../helpers/factories.js';

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
		vi.mocked(listAllProjectRecordsFromDb).mockReset();
		vi.mocked(findProjectRecordByIdFromDb).mockReset();
		vi.mocked(createProjectInDb).mockReset();
		vi.mocked(createProjectWithMemberInDb).mockReset();
		vi.mocked(upsertProjectToDb).mockReset();
		vi.mocked(deleteProjectFromDb).mockReset();
		// Idle by default, so every suite but `delete`'s own reaches the row delete.
		vi.mocked(deleteIdleProjectFromDb).mockReset();
		vi.mocked(deleteIdleProjectFromDb).mockResolvedValue({ deleted: true });
		vi.mocked(addMember).mockReset();
		vi.mocked(addMember).mockResolvedValue(membershipFor('projectAdmin'));
		vi.mocked(getMembership).mockReset();
		vi.mocked(listAccessibleProjectIds).mockReset();
		vi.mocked(listProjectsForUser).mockReset();
		vi.mocked(listProjectsForUser).mockResolvedValue([]);
		vi.mocked(listDiscoverableProjectsFromDb).mockReset();
		vi.mocked(createMembershipRequest).mockReset();
		vi.mocked(getPendingRequest).mockReset();
		vi.mocked(getMembershipRequestById).mockReset();
		vi.mocked(listPendingRequestsForProject).mockReset();
		vi.mocked(approveMembershipRequestInDb).mockReset();
		vi.mocked(rejectMembershipRequestInDb).mockReset();
		vi.mocked(writeProjectCredential).mockReset();
		vi.mocked(resolveInstanceScmCredential).mockReset();
		// Nothing stored is the default, so every suite but the seeding one below behaves
		// exactly as it did before issue #769.
		vi.mocked(resolveInstanceScmCredential).mockResolvedValue(null);
	});

	describe('list', () => {
		it('returns whatever listAllProjectRecordsFromDb resolves', async () => {
			const mockProjects = [
				createMockProjectRecord({ id: 'p1' }),
				createMockProjectRecord({ id: 'p2' }),
			];
			vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue(mockProjects);

			const result = await caller.list();
			expect(result).toEqual(mockProjects);
			expect(listAllProjectRecordsFromDb).toHaveBeenCalledTimes(1);
		});

		it('returns an empty array when listAllProjectRecordsFromDb resolves empty', async () => {
			vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue([]);

			const result = await caller.list();
			expect(result).toEqual([]);
			expect(listAllProjectRecordsFromDb).toHaveBeenCalledTimes(1);
		});
	});

	// Issue #661: the profile's My Projects tab. An instanceAdmin reaches every
	// project, which is the case where "role" and "access" come apart.
	describe('listMine', () => {
		it('reports an instanceAdmin with no membership as having no role, rather than inventing one', async () => {
			vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue([
				createMockProjectRecord({ id: 'p1', name: 'Alpha' }),
				createMockProjectRecord({ id: 'p2', name: 'Beta' }),
			]);
			vi.mocked(listProjectsForUser).mockResolvedValue([]);

			// `toEqual` on the whole result, so the projection is pinned: a config,
			// credential, or board field cannot start riding along unnoticed.
			await expect(caller.listMine()).resolves.toEqual([
				{ id: 'p1', name: 'Alpha', role: null },
				{ id: 'p2', name: 'Beta', role: null },
			]);
		});

		it('reports the real role for a project an instanceAdmin is a member of', async () => {
			vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue([
				createMockProjectRecord({ id: 'p1', name: 'Alpha' }),
				createMockProjectRecord({ id: 'p2', name: 'Beta' }),
			]);
			vi.mocked(listProjectsForUser).mockResolvedValue([
				{ ...membershipFor('member', 'p2'), userId: ADMIN_USER.id },
			]);

			await expect(caller.listMine()).resolves.toEqual([
				{ id: 'p1', name: 'Alpha', role: null },
				{ id: 'p2', name: 'Beta', role: 'member' },
			]);
			expect(listProjectsForUser).toHaveBeenCalledWith(ADMIN_USER.id);
		});

		it('keeps the repository ordering rather than sorting its own', async () => {
			vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue([
				createMockProjectRecord({ id: 'p2', name: 'Alpha' }),
				createMockProjectRecord({ id: 'p1', name: 'Beta' }),
			]);

			const result = await caller.listMine();
			expect(result.map((project) => project.id)).toEqual(['p2', 'p1']);
		});
	});

	describe('getById', () => {
		it('returns the project when findProjectRecordByIdFromDb resolves one', async () => {
			const project = createMockProjectRecord({ id: 'p1', maxConcurrentJobs: 4 });
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(project);

			const result = await caller.getById({ id: 'p1' });
			expect(result).toEqual(project);
			expect(result.maxConcurrentJobs).toBe(4);
			expect(findProjectRecordByIdFromDb).toHaveBeenCalledWith('p1');
		});

		it('throws NOT_FOUND when findProjectRecordByIdFromDb resolves undefined', async () => {
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(undefined);

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
			repositories: [{ repo: 'jkwiecien/new-proj', baseBranch: 'main', branchPrefix: 'issue-' }],
			repoRoot: '/Users/dev/new-proj',
			worktreeRoot: '.swarm-workspaces',
		};

		// Issue #628: the SCM references a new project starts with are read off the
		// manifest for the provider it names, exactly as the `credentials.pm` ones are read
		// off the PM manifest. A stub with recognizable keys is what proves that — a
		// hardcoded seeding would keep producing the old `SCM_*` names.
		beforeEach(() => {
			_resetSCMProviderRegistryForTesting();
			registerSCMProvider({
				id: 'github',
				label: 'Stub',
				category: 'scm',
				webhookRoute: '/stub/webhook',
				credentialRoles: [
					{ role: 'reviewer', envVarKey: 'SCM_STUB_TOKEN_REVIEWER' },
					{ role: 'webhookSecret', envVarKey: 'SCM_STUB_WEBHOOK_SECRET' },
				],
			} as unknown as SCMProviderManifest);
		});

		// The per-provider map alone: issue #632 removed phase 1's interim legacy mirror,
		// since the Source Control tab now reads and writes `credentials.scm` itself.
		const defaultCredentials = {
			scm: {
				github: {
					reviewer: 'SCM_STUB_TOKEN_REVIEWER',
					webhookSecret: 'SCM_STUB_WEBHOOK_SECRET',
				},
			},
		};

		it('happy path: calls createProjectWithMemberInDb with the input plus credentials and creator membership, and returns the merged object', async () => {
			vi.mocked(createProjectWithMemberInDb).mockResolvedValue(undefined);

			const result = await caller.create(validProjectInput);

			const expectedConfig = {
				...validProjectInput,
				maxConcurrentJobs: 1,
				visibility: 'private',
				scm: 'github',
				pm: DEFAULT_PM_CONFIG,
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
				repositories: [{ repo: 'jkwiecien/minimal-proj' }],
				repoRoot: '/Users/dev/minimal-proj',
			};

			const result = await caller.create(minimalInput);

			const expectedConfig = {
				...minimalInput,
				// Each entry's own branch settings default per entry.
				repositories: [
					{ repo: 'jkwiecien/minimal-proj', baseBranch: 'main', branchPrefix: 'issue-' },
				],
				worktreeRoot: '.swarm-workspaces',
				maxConcurrentJobs: 1,
				visibility: 'private',
				scm: 'github',
				pm: DEFAULT_PM_CONFIG,
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
				scm: 'github',
				pm: DEFAULT_PM_CONFIG,
				credentials: defaultCredentials,
			};

			expect(result).toEqual(expectedConfig);
			expect(createProjectWithMemberInDb).toHaveBeenCalledWith(expectedConfig, {
				projectId: 'new-proj',
				userId: ADMIN_USER.id,
				role: 'projectAdmin',
			});
		});

		// Issue #537: a new project starts with one `credentials.pm` slot per credential
		// role its PM provider requires and owns — read off the manifest, so no provider
		// is named here. Nothing is stored yet; the slot is what the Project Management
		// tab (or `swarm config apply`) fills.
		it('seeds a credentials.pm reference for each required, provider-owned role', async () => {
			registerPMProvider({
				id: DEFAULT_PM_CONFIG.type,
				label: 'Stub',
				category: 'pm',
				credentialRoles: [
					{ role: 'apiToken', label: 'API Token', envVarKey: 'PM_STUB_TOKEN' },
					{ role: 'optionalThing', label: 'Optional', envVarKey: 'PM_STUB_OPT', optional: true },
					{
						role: 'webhookSecret',
						label: 'Webhook Secret',
						envVarKey: 'SCM_WEBHOOK_SECRET',
						inheritsSharedCredential: 'webhookSecret',
					},
				],
			} as unknown as PMProviderManifest);
			vi.mocked(createProjectWithMemberInDb).mockResolvedValue(undefined);

			try {
				const result = await caller.create(validProjectInput);

				expect(result.credentials).toEqual({
					...defaultCredentials,
					// Filed under the provider it was seeded from (issue #631).
					pm: { 'github-projects': { apiToken: 'PM_STUB_TOKEN' } },
				});
			} finally {
				_resetPMProviderRegistryForTesting();
			}
		});

		// Issue #628: the map is keyed by the provider the project names, and seeded from
		// *that* manifest — so creating a Bitbucket project stores Bitbucket's keys, and no
		// GitHub reference is invented for it.
		it('seeds the credentials.scm block for the provider the project names', async () => {
			registerSCMProvider({
				id: 'bitbucket',
				label: 'Stub Bitbucket',
				category: 'scm',
				webhookRoute: '/stub-bitbucket/webhook',
				credentialRoles: [
					{ role: 'reviewer', envVarKey: 'BB_STUB_TOKEN_REVIEWER' },
					{ role: 'webhookSecret', envVarKey: 'BB_STUB_WEBHOOK_SECRET' },
				],
			} as unknown as SCMProviderManifest);
			vi.mocked(createProjectWithMemberInDb).mockResolvedValue(undefined);

			const result = await caller.create({ ...validProjectInput, scm: 'bitbucket' });

			expect(result.credentials).toEqual({
				scm: {
					bitbucket: {
						reviewer: 'BB_STUB_TOKEN_REVIEWER',
						webhookSecret: 'BB_STUB_WEBHOOK_SECRET',
					},
				},
			});
		});

		it('strips a client-supplied pm block and uses the placeholder default', async () => {
			vi.mocked(createProjectWithMemberInDb).mockResolvedValue(undefined);

			// Cast to simulate a client sending its own board mapping — since issue #495
			// that arrives inside `pm`, which `create` omits from its input entirely.
			const inputWithPm = {
				...validProjectInput,
				pm: {
					type: 'github-projects',
					projectId: 'CLIENT_ID',
					statusFieldId: 'CLIENT_FIELD_ID',
					statusOptions: { backlog: 'client-backlog' },
				},
			} as unknown as Parameters<typeof caller.create>[0];

			const result = await caller.create(inputWithPm);

			const expectedConfig = {
				...validProjectInput,
				maxConcurrentJobs: 1,
				visibility: 'private',
				scm: 'github',
				pm: DEFAULT_PM_CONFIG,
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

		// Issue #769 phase 2/2, made a hard requirement for every provider by issue #778:
		// the installation's stored default for a `(provider, role)` pair the provider
		// declares `instanceDefault` for is *required* before a project may be created on
		// that provider, and is then copied into the new project's own
		// `project_credentials` row. Still a copy, not a resolution tier —
		// `src/config/provider.ts` is untouched and existing projects are never touched.
		describe('instance-default SCM credentials', () => {
			// All three real manifests, so which pairs opt in is the shipped answer rather than
			// a stub's. Re-registered here because the outer `beforeEach` resets the registry.
			beforeEach(() => {
				_resetSCMProviderRegistryForTesting();
				registerSCMProvider(githubScmManifest);
				registerSCMProvider(bitbucketScmManifest);
				registerSCMProvider(gitlabScmManifest);
				vi.mocked(createProjectWithMemberInDb).mockResolvedValue(undefined);
			});

			it('copies the stored default into the new project under the key it resolves the role through', async () => {
				vi.mocked(resolveInstanceScmCredential).mockResolvedValue('ghp_instance_default');

				await caller.create(validProjectInput);

				expect(resolveInstanceScmCredential).toHaveBeenCalledWith('github', 'reviewer');
				// The whole call list, so a `webhookSecret` — which no provider may declare
				// eligible — cannot start being seeded alongside it unnoticed.
				expect(vi.mocked(writeProjectCredential).mock.calls).toEqual([
					['new-proj', 'GITHUB_TOKEN_REVIEWER', 'ghp_instance_default', null],
				]);
			});

			// Issue #778: the value the guard resolved is threaded through to the write rather
			// than read a second time, which closes the window where the default is cleared
			// between check and seed.
			it('resolves the stored default once rather than re-reading it for the write', async () => {
				vi.mocked(resolveInstanceScmCredential).mockResolvedValue('ghp_instance_default');

				await caller.create(validProjectInput);

				expect(resolveInstanceScmCredential).toHaveBeenCalledTimes(1);
			});

			// The core of issue #778, replacing #769's silently-degraded creation: without a
			// recorded default the project could not run Review, so creation is refused
			// outright — and refused *before any row is written*.
			it("refuses creation when the installation has no default for the project's provider", async () => {
				vi.mocked(resolveInstanceScmCredential).mockResolvedValue(null);

				await expect(caller.create(validProjectInput)).rejects.toThrowError(
					expect.objectContaining({
						code: 'PRECONDITION_FAILED',
						message: expect.stringContaining('GitHub'),
					}),
				);
				await expect(caller.create(validProjectInput)).rejects.toThrowError(
					/'reviewer'.*General Settings → Credentials \(GITHUB_TOKEN_REVIEWER\)/,
				);
				expect(createProjectWithMemberInDb).not.toHaveBeenCalled();
				expect(writeProjectCredential).not.toHaveBeenCalled();
			});

			// The coverage half of issue #778: Bitbucket and GitLab now declare the same
			// requirement, so each refuses naming *itself* rather than being created with no
			// reviewer credential path at all. Also the regression guard against a future
			// manifest quietly losing the flag.
			it.each([
				{ scm: 'bitbucket' as const, label: 'Bitbucket', key: 'BITBUCKET_TOKEN_REVIEWER' },
				{ scm: 'gitlab' as const, label: 'GitLab', key: 'GITLAB_TOKEN_REVIEWER' },
			])('refuses creation for a $scm project with no stored default', async ({
				label,
				scm,
				key,
			}) => {
				vi.mocked(resolveInstanceScmCredential).mockResolvedValue(null);

				await expect(caller.create({ ...validProjectInput, scm })).rejects.toThrowError(
					expect.objectContaining({
						code: 'PRECONDITION_FAILED',
						message: expect.stringContaining(`no ${label} 'reviewer' credential`),
					}),
				);
				await expect(caller.create({ ...validProjectInput, scm })).rejects.toThrowError(
					new RegExp(`General Settings → Credentials \\(${key}\\)`),
				);
				expect(createProjectWithMemberInDb).not.toHaveBeenCalled();
			});

			it.each([
				{ scm: 'bitbucket' as const, key: 'BITBUCKET_TOKEN_REVIEWER', secret: 'bb_instance' },
				{ scm: 'gitlab' as const, key: 'GITLAB_TOKEN_REVIEWER', secret: 'glpat_instance' },
			])('seeds a $scm project from its own provider’s stored default', async ({
				scm,
				key,
				secret,
			}) => {
				vi.mocked(resolveInstanceScmCredential).mockResolvedValue(secret);

				await caller.create({ ...validProjectInput, scm });

				expect(resolveInstanceScmCredential).toHaveBeenCalledWith(scm, 'reviewer');
				// The whole call list again: no `webhookSecret` may ride along, and no other
				// provider's key may be written for this project.
				expect(vi.mocked(writeProjectCredential).mock.calls).toEqual([
					['new-proj', key, secret, null],
				]);
			});

			// The AC's hypothetical-removed-role case: the check only fires for roles that
			// actually opt in, so a provider declaring none creates exactly as it did before
			// issue #778 — no lookup, no write, and above all no refusal.
			it('creates as before for a provider whose roles do not opt in', async () => {
				_resetSCMProviderRegistryForTesting();
				registerSCMProvider({
					id: 'bitbucket',
					label: 'Stub Bitbucket',
					category: 'scm',
					webhookRoute: '/stub-bitbucket/webhook',
					credentialRoles: [
						{ role: 'reviewer', envVarKey: 'BB_STUB_TOKEN_REVIEWER' },
						{ role: 'webhookSecret', envVarKey: 'BB_STUB_WEBHOOK_SECRET' },
					],
				} as unknown as SCMProviderManifest);
				vi.mocked(resolveInstanceScmCredential).mockResolvedValue(null);

				await expect(
					caller.create({ ...validProjectInput, scm: 'bitbucket' }),
				).resolves.toMatchObject({ id: 'new-proj', scm: 'bitbucket' });

				expect(resolveInstanceScmCredential).not.toHaveBeenCalled();
				expect(writeProjectCredential).not.toHaveBeenCalled();
			});

			// Manifest-driven, not hardcoded to any of the three shipped keys: a provider that
			// declares the opt-in under its own key is seeded under *that* key, with no edit
			// to the router.
			it("uses the opting-in provider's own key rather than another provider's", async () => {
				_resetSCMProviderRegistryForTesting();
				registerSCMProvider({
					id: 'gitlab',
					label: 'Stub GitLab',
					category: 'scm',
					webhookRoute: '/stub-gitlab/webhook',
					credentialRoles: [
						{ role: 'reviewer', envVarKey: 'GL_STUB_TOKEN_REVIEWER', instanceDefault: true },
						{ role: 'webhookSecret', envVarKey: 'GL_STUB_WEBHOOK_SECRET' },
					],
				} as unknown as SCMProviderManifest);
				vi.mocked(resolveInstanceScmCredential).mockResolvedValue('glpat_instance_default');

				await caller.create({ ...validProjectInput, scm: 'gitlab' });

				expect(resolveInstanceScmCredential).toHaveBeenCalledWith('gitlab', 'reviewer');
				expect(vi.mocked(writeProjectCredential).mock.calls).toEqual([
					['new-proj', 'GL_STUB_TOKEN_REVIEWER', 'glpat_instance_default', null],
				]);
			});

			// Fails closed, deliberately inverting issue #769's behaviour: moving the resolve
			// ahead of creation means a lookup failure creates nothing rather than leaving a
			// project created-but-unseeded. We cannot claim the credential exists, and
			// re-running `create` after the DB recovers is clean because nothing was written.
			it('refuses creation when the lookup itself fails, writing nothing', async () => {
				vi.mocked(resolveInstanceScmCredential).mockRejectedValue(new Error('db down'));

				await expect(caller.create(validProjectInput)).rejects.toThrowError('db down');
				expect(createProjectWithMemberInDb).not.toHaveBeenCalled();
				expect(writeProjectCredential).not.toHaveBeenCalled();
			});

			// The one half that stays best-effort: the value demonstrably exists by now, so a
			// write failure is a transient fault, the project and its membership are already
			// committed, and re-running `create` to recover the seed would only earn a
			// CONFLICT. The recovery is the Source Control tab.
			it('still returns the created project when the write fails', async () => {
				vi.mocked(resolveInstanceScmCredential).mockResolvedValue('ghp_instance_default');
				vi.mocked(writeProjectCredential).mockRejectedValue(new Error('encryption unavailable'));

				await expect(caller.create(validProjectInput)).resolves.toMatchObject({
					id: 'new-proj',
				});
			});
		});
	});

	describe('update', () => {
		const existing = createMockProjectRecord({
			id: 'p1',
			name: 'Original Name',
			repositories: [{ repo: 'jkwiecien/original', baseBranch: 'main', branchPrefix: 'issue-' }],
		});

		it('throws NOT_FOUND when the project does not exist and does not update', async () => {
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.update({ id: 'missing', name: 'New Name' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);

			expect(upsertProjectToDb).not.toHaveBeenCalled();
		});

		it('happy path: updates project fields while leaving other fields untouched (including credentials)', async () => {
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const updates = {
				id: 'p1',
				name: 'Updated Name',
				repositories: [{ repo: 'jkwiecien/new-repo' }],
			};
			const result = await caller.update(updates);

			const expectedConfig = {
				...existing,
				name: 'Updated Name',
				repositories: [{ repo: 'jkwiecien/new-repo', baseBranch: 'main', branchPrefix: 'issue-' }],
			};

			expect(result).toEqual(expectedConfig);
			expect(upsertProjectToDb).toHaveBeenCalledWith(expectedConfig);
		});

		// Issue #769 phase 2/2 is a copy made once, at creation. Nothing re-seeds
		// afterwards — least of all an ordinary config save, which would otherwise
		// overwrite whatever the project's own Source Control tab has since stored.
		it('never consults or writes an instance default', async () => {
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			await caller.update({ id: 'p1', name: 'Updated Name' });

			expect(resolveInstanceScmCredential).not.toHaveBeenCalled();
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});

		it('saves the maximum concurrent jobs setting', async () => {
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const result = await caller.update({ id: 'p1', maxConcurrentJobs: 4 });

			expect(result.maxConcurrentJobs).toBe(4);
			expect(upsertProjectToDb).toHaveBeenCalledWith({
				...existing,
				maxConcurrentJobs: 4,
			});
		});

		it('saves the opt-in auto merge setting', async () => {
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);
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
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const result = await caller.update({
				id: 'p1',
				pipeline: { respondToReview: { skipOnMinors: false } },
			});

			expect(result.pipeline?.respondToReview?.skipOnMinors).toBe(false);
		});

		it('saves the Review check policy while leaving unrelated pipeline fields intact', async () => {
			const withPipeline = createMockProjectRecord({
				id: 'p1',
				name: 'Original Name',
				repositories: [{ repo: 'jkwiecien/original', baseBranch: 'main', branchPrefix: 'issue-' }],
				pipeline: {
					planning: { autoAdvance: true },
					review: { enabled: true },
					respondToReview: { autoMerge: true, skipOnMinors: false },
				},
			});
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(withPipeline);
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
			const withPipeline = createMockProjectRecord({
				id: 'p1',
				pipeline: {
					planning: { autoAdvance: true },
					review: { enabled: false },
					respondToReview: { enabled: false, autoMerge: true, skipOnMinors: false },
				},
			});
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(withPipeline);
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
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			const result = await caller.update({ id: 'p1', name: 'Renamed' });

			expect(result.pipeline?.review?.checks).toBeUndefined();
		});

		it.each([0, -1, 1.5, 'many'])('rejects invalid maximum concurrent jobs: %s', async (value) => {
			await expect(
				caller.update({ id: 'p1', maxConcurrentJobs: value as number }),
			).rejects.toThrow();
			expect(findProjectRecordByIdFromDb).not.toHaveBeenCalled();
			expect(upsertProjectToDb).not.toHaveBeenCalled();
		});

		it('absent keys are not updated/merged to undefined', async () => {
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

			// Pass only id and a change to name, omit other fields
			const result = await caller.update({ id: 'p1', name: 'Name Change Only' });

			const expectedConfig = {
				...existing,
				name: 'Name Change Only',
			};

			expect(result).toEqual(expectedConfig);
			expect(upsertProjectToDb).toHaveBeenCalledWith(expectedConfig);
			// Verifies other attributes like repoRoot, repositories etc are still existing values
			expect(result.repositories).toEqual(existing.repositories);
			expect(result.repoRoot).toBe(existing.repoRoot);
		});

		it('translates uniqueness conflicts (e.g. repo collision) to CONFLICT', async () => {
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);
			const error = Object.assign(new Error('Unique violation'), { code: '23505' });
			vi.mocked(upsertProjectToDb).mockRejectedValue(error);

			await expect(caller.update({ id: 'p1', name: 'Collision Name' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'CONFLICT',
					message: 'Project ID or repository already exists',
				}),
			);
		});

		// The `repo` UNIQUE constraint became a write-seam guard in issue #684, so its
		// error has to reach the client as the same CONFLICT rather than falling through
		// as an untranslated 500.
		it('translates a repository already claimed by another project to CONFLICT', async () => {
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);
			vi.mocked(upsertProjectToDb).mockRejectedValue(
				new ProjectRepositoryConflictError('jkwiecien/original', 'other-project'),
			);

			await expect(
				caller.update({ id: 'p1', repositories: [{ repo: 'jkwiecien/original' }] }),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'CONFLICT',
					message: 'Project ID or repository already exists',
				}),
			);
		});

		it('translates a drizzle-wrapped uniqueness conflict (code on .cause, not top-level) to CONFLICT', async () => {
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);
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
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);
			const error = new Error('Some DB connection error');
			vi.mocked(upsertProjectToDb).mockRejectedValue(error);

			await expect(caller.update({ id: 'p1', name: 'Error Name' })).rejects.toThrowError(
				'Some DB connection error',
			);
		});

		/**
		 * Issue #642: the server-side half of the provider-switch guarantee. `update`
		 * merges and calls `upsertProjectToDb`, which does not parse, so the config
		 * schema's `validatePmCredentialRoles` presence rule never fires on this path —
		 * this is what makes a half-switched project (a `pm.type` naming a provider with
		 * no credentials) impossible even from a hand-rolled client.
		 */
		describe('PM provider switch guard', () => {
			const linearPm = {
				type: 'linear' as const,
				teamId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
				statusOptions: { todo: 'state-todo' },
			};

			function registerLinearStub() {
				registerPMProvider({
					id: 'linear',
					label: 'Stub Linear',
					category: 'pm',
					credentialRoles: [
						{ role: 'apiKey', label: 'API Key', envVarKey: 'LINEAR_API_KEY' },
						{ role: 'webhookSecret', label: 'Webhook Secret', envVarKey: 'LINEAR_WEBHOOK_SECRET' },
						{ role: 'optionalThing', label: 'Optional', envVarKey: 'LINEAR_OPT', optional: true },
					],
				} as unknown as PMProviderManifest);
			}

			afterEach(() => {
				_resetPMProviderRegistryForTesting();
			});

			it('rejects a switch to a provider nothing is registered for', async () => {
				vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);

				await expect(caller.update({ id: 'p1', pm: linearPm })).rejects.toThrowError(
					expect.objectContaining({
						code: 'BAD_REQUEST',
						message: expect.stringContaining("No PM provider is registered for 'linear'"),
					}),
				);
				expect(upsertProjectToDb).not.toHaveBeenCalled();
			});

			it('rejects a switch whose required credential references are absent, naming them', async () => {
				registerLinearStub();
				vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);

				await expect(caller.update({ id: 'p1', pm: linearPm })).rejects.toThrowError(
					expect.objectContaining({
						code: 'BAD_REQUEST',
						message: expect.stringContaining(
							"'apiKey' (API Key), 'webhookSecret' (Webhook Secret)",
						),
					}),
				);
				expect(upsertProjectToDb).not.toHaveBeenCalled();
			});

			it('accepts the switch once the incoming provider’s own block names every required role', async () => {
				registerLinearStub();
				const withLinearCredentials = createMockProjectRecord({
					id: 'p1',
					credentials: {
						// The outgoing provider's block is retained beside the incoming one — that
						// is what makes switching back need no secrets re-entered (issue #631).
						pm: {
							'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
							linear: { apiKey: 'LINEAR_API_KEY', webhookSecret: 'LINEAR_WEBHOOK_SECRET' },
						},
					},
				});
				vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(withLinearCredentials);
				vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

				const result = await caller.update({ id: 'p1', pm: linearPm });

				// One write, carrying the whole new union member and nothing of the old one.
				expect(upsertProjectToDb).toHaveBeenCalledTimes(1);
				expect(result.pm).toEqual(linearPm);
				expect(result.credentials.pm).toEqual(withLinearCredentials.credentials.pm);
			});

			// The optional role is not required, and an inherited one already resolves
			// without an entry — the same two exemptions the config schema's rule 3 makes.
			it('does not require an optional role, nor one that inherits a shared credential', async () => {
				registerPMProvider({
					id: 'linear',
					label: 'Stub Linear',
					category: 'pm',
					credentialRoles: [
						{ role: 'optionalThing', label: 'Optional', envVarKey: 'LINEAR_OPT', optional: true },
						{
							role: 'webhookSecret',
							label: 'Webhook Secret',
							envVarKey: 'SCM_WEBHOOK_SECRET',
							inheritsSharedCredential: 'webhookSecret',
						},
					],
				} as unknown as PMProviderManifest);
				vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);
				vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

				const result = await caller.update({ id: 'p1', pm: linearPm });

				expect(result.pm).toEqual(linearPm);
			});

			// An ordinary board/status edit keeps the provider it is already on, so nothing
			// about the guard can block a project from fixing its own mapping.
			it('leaves a mapping edit that keeps the same provider unaffected', async () => {
				vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);
				vi.mocked(upsertProjectToDb).mockResolvedValue(undefined);

				const samePm = { ...existing.pm, statusOptions: { todo: 'opt_other' } };
				const result = await caller.update({ id: 'p1', pm: samePm });

				expect(result.pm).toEqual(samePm);
				expect(upsertProjectToDb).toHaveBeenCalledTimes(1);
			});
		});
	});

	describe('delete', () => {
		it('throws NOT_FOUND when the project does not exist', async () => {
			vi.mocked(deleteIdleProjectFromDb).mockResolvedValue({ deleted: false, reason: 'not-found' });

			await expect(caller.delete({ id: 'missing' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);
		});

		it('happy path: deletes through the guarded transaction', async () => {
			vi.mocked(deleteIdleProjectFromDb).mockResolvedValue({ deleted: true });

			await expect(caller.delete({ id: 'p1' })).resolves.toBeUndefined();
			expect(deleteIdleProjectFromDb).toHaveBeenCalledWith('p1');
		});

		// Issue #854: the cascade would take `runs`/`dispatches` rows out from under a
		// worker still executing them, so a busy project is refused rather than deleted —
		// the same CONFLICT `workers.remove` answers a mid-run machine deletion with.
		it('refuses with CONFLICT while the project has runs in flight', async () => {
			vi.mocked(deleteIdleProjectFromDb).mockResolvedValue({
				deleted: false,
				reason: 'in-flight',
				executingDispatches: 2,
				runningRuns: 2,
			});

			await expect(caller.delete({ id: 'p1' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'CONFLICT',
					message: expect.stringContaining('2 runs in flight'),
				}),
			);
		});

		it('says "1 run" rather than "1 runs" when exactly one is in flight', async () => {
			vi.mocked(deleteIdleProjectFromDb).mockResolvedValue({
				deleted: false,
				reason: 'in-flight',
				executingDispatches: 1,
				runningRuns: 1,
			});

			await expect(caller.delete({ id: 'p1' })).rejects.toThrowError(
				expect.objectContaining({ message: expect.stringContaining('1 run in flight') }),
			);
		});

		// The two counts are two views of the same work, so the refusal reports the
		// greater of them rather than their sum — one dispatch a worker has claimed but
		// not yet written a run row for is one run in flight, not two.
		it('refuses on an executing dispatch that has no run row yet', async () => {
			vi.mocked(deleteIdleProjectFromDb).mockResolvedValue({
				deleted: false,
				reason: 'in-flight',
				executingDispatches: 1,
				runningRuns: 0,
			});

			await expect(caller.delete({ id: 'p1' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'CONFLICT',
					message: expect.stringContaining('1 run in flight'),
				}),
			);
		});

		it('counts the two views of in-flight work once, not twice', async () => {
			vi.mocked(deleteIdleProjectFromDb).mockResolvedValue({
				deleted: false,
				reason: 'in-flight',
				executingDispatches: 2,
				runningRuns: 1,
			});

			await expect(caller.delete({ id: 'p1' })).rejects.toThrowError(
				expect.objectContaining({ message: expect.stringContaining('2 runs in flight') }),
			);
		});

		// The guard fails fast rather than waiting on a dispatch row a claim holds, so
		// this is the same refusal with a shorter horizon — it must still be a CONFLICT
		// naming what to do, not a 500.
		it('refuses with CONFLICT when a claim held the guard off', async () => {
			vi.mocked(deleteIdleProjectFromDb).mockResolvedValue({
				deleted: false,
				reason: 'contended',
			});

			await expect(caller.delete({ id: 'p1' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'CONFLICT',
					message: expect.stringContaining('being claimed'),
				}),
			);
		});

		it('does not reach the delete transaction for a caller without access', async () => {
			await expect(
				projectsRouter.createCaller({ user: ORDINARY_USER }).delete({ id: 'p1' }),
			).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));

			expect(deleteIdleProjectFromDb).not.toHaveBeenCalled();
		});
	});

	// The #281 task-4 acceptance cases: admin override, no-membership denial, and
	// project-role boundaries — exercised through an ordinary (non-admin) caller
	// with the membership service mocked.
	describe('project-scoped authorization', () => {
		const ordinary = projectsRouter.createCaller({ user: ORDINARY_USER });

		describe('list', () => {
			it('instanceAdmin sees every project (no membership filtering)', async () => {
				const all = [createMockProjectRecord({ id: 'p1' }), createMockProjectRecord({ id: 'p2' })];
				vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue(all);

				await expect(caller.list()).resolves.toEqual(all);
				expect(listAccessibleProjectIds).not.toHaveBeenCalled();
			});

			it('a member sees only the projects in their accessible set', async () => {
				const all = [
					createMockProjectRecord({ id: 'p1' }),
					createMockProjectRecord({ id: 'p2' }),
					createMockProjectRecord({ id: 'p3' }),
				];
				vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue(all);
				vi.mocked(listAccessibleProjectIds).mockResolvedValue(['p1', 'p3']);

				const result = await ordinary.list();
				expect(result.map((p) => p.id)).toEqual(['p1', 'p3']);
				expect(listAccessibleProjectIds).toHaveBeenCalledWith(ORDINARY_USER.id);
			});

			it('a member with no memberships sees nothing', async () => {
				vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue([
					createMockProjectRecord({ id: 'p1' }),
				]);
				vi.mocked(listAccessibleProjectIds).mockResolvedValue([]);

				await expect(ordinary.list()).resolves.toEqual([]);
			});
		});

		describe('listMine', () => {
			it('lists only the accessible projects, each with the role held on it', async () => {
				vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue([
					createMockProjectRecord({ id: 'p1', name: 'Alpha' }),
					createMockProjectRecord({ id: 'p2', name: 'Beta' }),
					createMockProjectRecord({ id: 'p3', name: 'Gamma' }),
				]);
				vi.mocked(listAccessibleProjectIds).mockResolvedValue(['p1', 'p3']);
				vi.mocked(listProjectsForUser).mockResolvedValue([
					membershipFor('member', 'p1'),
					membershipFor('projectAdmin', 'p3'),
				]);

				// `p2` is absent entirely — the scoping rule is `list`'s, so a project the
				// caller may not discover is not named here either.
				await expect(ordinary.listMine()).resolves.toEqual([
					{ id: 'p1', name: 'Alpha', role: 'member' },
					{ id: 'p3', name: 'Gamma', role: 'projectAdmin' },
				]);
				expect(listAccessibleProjectIds).toHaveBeenCalledWith(ORDINARY_USER.id);
			});

			it.each([
				'contributor',
				'member',
				'projectAdmin',
			] as const)('reports the %s role the caller holds', async (role) => {
				vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue([
					createMockProjectRecord({ id: 'p1', name: 'Alpha' }),
				]);
				vi.mocked(listAccessibleProjectIds).mockResolvedValue(['p1']);
				vi.mocked(listProjectsForUser).mockResolvedValue([membershipFor(role, 'p1')]);

				await expect(ordinary.listMine()).resolves.toEqual([{ id: 'p1', name: 'Alpha', role }]);
			});

			it('gives a user with no memberships an empty list, naming no project', async () => {
				vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue([
					createMockProjectRecord({ id: 'p1', name: 'Alpha' }),
				]);
				vi.mocked(listAccessibleProjectIds).mockResolvedValue([]);
				vi.mocked(listProjectsForUser).mockResolvedValue([]);

				await expect(ordinary.listMine()).resolves.toEqual([]);
			});

			it('ignores a membership for a project the caller cannot access', async () => {
				vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue([
					createMockProjectRecord({ id: 'p1', name: 'Alpha' }),
				]);
				vi.mocked(listAccessibleProjectIds).mockResolvedValue(['p1']);
				vi.mocked(listProjectsForUser).mockResolvedValue([
					membershipFor('member', 'p1'),
					// A stale membership row for a project that is gone: the accessible list
					// decides what is listed, so it contributes no entry of its own.
					membershipFor('projectAdmin', 'p9'),
				]);

				await expect(ordinary.listMine()).resolves.toEqual([
					{ id: 'p1', name: 'Alpha', role: 'member' },
				]);
			});
		});

		describe('getById', () => {
			it('denies a non-member with NOT_FOUND without reading the project', async () => {
				vi.mocked(getMembership).mockResolvedValue(undefined);

				await expect(ordinary.getById({ id: 'p1' })).rejects.toThrowError(
					expect.objectContaining({ code: 'NOT_FOUND' }),
				);
				expect(findProjectRecordByIdFromDb).not.toHaveBeenCalled();
			});

			it('lets a contributor read the project', async () => {
				vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));
				const project = createMockProjectRecord({ id: 'p1' });
				vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(project);

				await expect(ordinary.getById({ id: 'p1' })).resolves.toEqual(project);
			});
		});

		// Issue #655: the read model the project-detail screen decides which tabs to
		// offer from. It reports the `projectAdmin` boundary every configuration
		// procedure enforces for itself, and grants nothing.
		describe('viewerAccess', () => {
			it('reports a projectAdmin as able to administer the project', async () => {
				vi.mocked(getMembership).mockResolvedValue(membershipFor('projectAdmin'));

				await expect(ordinary.viewerAccess({ projectId: 'p1' })).resolves.toEqual({
					canAdminister: true,
				});
			});

			it('reports a member and a contributor as unable to administer it', async () => {
				vi.mocked(getMembership).mockResolvedValue(membershipFor('member'));
				await expect(ordinary.viewerAccess({ projectId: 'p1' })).resolves.toEqual({
					canAdminister: false,
				});

				vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));
				await expect(ordinary.viewerAccess({ projectId: 'p1' })).resolves.toEqual({
					canAdminister: false,
				});
			});

			it('denies a non-member with NOT_FOUND rather than reporting false', async () => {
				// Answering at all would confirm the project exists, so this hides it the
				// same way `getById` does.
				vi.mocked(getMembership).mockResolvedValue(undefined);

				await expect(ordinary.viewerAccess({ projectId: 'p1' })).rejects.toThrowError(
					expect.objectContaining({ code: 'NOT_FOUND' }),
				);
			});

			it('reports an instanceAdmin as an administrator of a project they are not a member of', async () => {
				vi.mocked(getMembership).mockResolvedValue(undefined);

				await expect(caller.viewerAccess({ projectId: 'p1' })).resolves.toEqual({
					canAdminister: true,
				});
				expect(getMembership).not.toHaveBeenCalled();
			});
		});

		describe('update / delete role boundary', () => {
			it('forbids a member from updating project config', async () => {
				vi.mocked(getMembership).mockResolvedValue(membershipFor('member'));

				await expect(ordinary.update({ id: 'p1', name: 'Nope' })).rejects.toThrowError(
					expect.objectContaining({ code: 'FORBIDDEN' }),
				);
				expect(findProjectRecordByIdFromDb).not.toHaveBeenCalled();
				expect(upsertProjectToDb).not.toHaveBeenCalled();
			});

			it('lets a projectAdmin update project config', async () => {
				vi.mocked(getMembership).mockResolvedValue(membershipFor('projectAdmin'));
				const existing = createMockProjectRecord({ id: 'p1', name: 'Old' });
				vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(existing);
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
				expect(deleteIdleProjectFromDb).not.toHaveBeenCalled();
			});

			it('forbids a contributor from deleting a project', async () => {
				vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));

				await expect(ordinary.delete({ id: 'p1' })).rejects.toThrowError(
					expect.objectContaining({ code: 'FORBIDDEN' }),
				);
				expect(deleteIdleProjectFromDb).not.toHaveBeenCalled();
			});
		});

		describe('create', () => {
			// These two are about authorization and transaction atomicity, so they must not
			// also be about credential state: a stub manifest declaring no `instanceDefault`
			// keeps issue #778's requirement out of their way (the outer suite's stubs are the
			// same pattern, but the registry is whatever the preceding suite left registered).
			beforeEach(() => {
				_resetSCMProviderRegistryForTesting();
				registerSCMProvider({
					id: 'github',
					label: 'Stub',
					category: 'scm',
					webhookRoute: '/stub/webhook',
					credentialRoles: [
						{ role: 'reviewer', envVarKey: 'SCM_STUB_TOKEN_REVIEWER' },
						{ role: 'webhookSecret', envVarKey: 'SCM_STUB_WEBHOOK_SECRET' },
					],
				} as unknown as SCMProviderManifest);
			});

			it('records the creator as a projectAdmin member in the atomic transaction', async () => {
				vi.mocked(createProjectWithMemberInDb).mockResolvedValue(undefined);

				await ordinary.create({
					id: 'new-proj',
					name: 'New Project',
					repositories: [{ repo: 'jkwiecien/new-proj' }],
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
						repositories: [{ repo: 'jkwiecien/failed-member' }],
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
				vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(
					createMockProjectRecord({ id: 'p1', visibility: 'discoverable' }),
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
				vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(
					createMockProjectRecord({ id: 'p1', visibility: 'private' }),
				);

				await expect(ordinary.requestMembership({ projectId: 'p1' })).rejects.toThrowError(
					expect.objectContaining({ code: 'NOT_FOUND' }),
				);
				expect(createMembershipRequest).not.toHaveBeenCalled();
			});

			it('is NOT_FOUND for an unknown project', async () => {
				vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(undefined);

				await expect(ordinary.requestMembership({ projectId: 'missing' })).rejects.toThrowError(
					expect.objectContaining({ code: 'NOT_FOUND' }),
				);
			});

			it('rejects an already-member with CONFLICT', async () => {
				vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(
					createMockProjectRecord({ id: 'p1', visibility: 'discoverable' }),
				);
				vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));

				await expect(ordinary.requestMembership({ projectId: 'p1' })).rejects.toThrowError(
					expect.objectContaining({ code: 'CONFLICT' }),
				);
				expect(createMembershipRequest).not.toHaveBeenCalled();
			});

			it('rejects a duplicate pending request with CONFLICT', async () => {
				vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(
					createMockProjectRecord({ id: 'p1', visibility: 'discoverable' }),
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
