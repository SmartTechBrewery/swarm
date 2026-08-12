import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import { writeProjectCredential } from '../../../src/db/repositories/credentialsRepository.js';
import { getMembership } from '../../../src/db/repositories/projectMembersRepository.js';
import {
	createProjectInDb,
	createProjectWithMemberInDb,
	deleteProjectFromDb,
	findProjectByBoardFromDb,
	findProjectByIdFromDb,
	findProjectByPmContainerFromDb,
	findProjectByRepoFromDb,
	findProjectRecordByIdFromDb,
	getProjectByIdFromDb,
	listAllProjectsFromDb,
	listDiscoverableProjectsFromDb,
	ProjectRepositoryConflictError,
	upsertProjectToDb,
} from '../../../src/db/repositories/projectsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { projectCredentials } from '../../../src/db/schema/projectCredentials.js';
import {
	createMockLinearConfig,
	createMockLinearProjectConfig,
	createMockProjectConfig,
	createMockProjectRecord,
	toProjectRecord,
} from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('projectsRepository (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
	});

	describe('createProjectInDb', () => {
		it('inserts a brand new project and can resolve it by ID', async () => {
			const config = createMockProjectConfig({
				id: 'proj-new',
				name: 'New Project',
				repo: 'jkwiecien/new-repo',
				maxConcurrentJobs: 4,
			});
			await createProjectInDb(toProjectRecord(config));

			const resolved = await findProjectByIdFromDb('proj-new');
			expect(resolved).toBeDefined();
			expect(resolved?.name).toBe('New Project');
			expect(resolved?.maxConcurrentJobs).toBe(4);
		});

		it('round-trips the Review check policy alongside another pipeline value through JSONB', async () => {
			const config = createMockProjectConfig({
				id: 'proj-review-checks',
				name: 'Review Checks Project',
				repo: 'jkwiecien/review-checks',
				pipeline: {
					planning: { autoAdvance: true },
					review: { checks: 'if-present' },
				},
			});
			await createProjectInDb(toProjectRecord(config));

			const resolved = await findProjectByIdFromDb('proj-review-checks');
			expect(resolved?.pipeline?.review?.checks).toBe('if-present');
			expect(resolved?.pipeline?.planning?.autoAdvance).toBe(true);
		});

		// The `scm_type` column added by issue #478. What a stubbed-DB unit test cannot
		// prove is that the migration actually added a *nullable* column: a NOT NULL one
		// would reject the second insert here, and a defaulted one would hand back
		// `'github'` for a project that states nothing — turning the loud "set scm" error
		// into a silent pick the moment a second provider goes runtime-ready.
		it('round-trips the scm discriminator, and keeps an unstated one unstated', async () => {
			await createProjectInDb(
				toProjectRecord(
					createMockProjectConfig({
						id: 'proj-scm-stated',
						name: 'Stated SCM Project',
						repo: 'jkwiecien/stated-scm',
						scm: 'bitbucket',
					}),
				),
			);
			await createProjectInDb(
				toProjectRecord(
					createMockProjectConfig({
						id: 'proj-scm-unstated',
						name: 'Unstated SCM Project',
						repo: 'jkwiecien/unstated-scm',
					}),
				),
			);

			expect((await findProjectByIdFromDb('proj-scm-stated'))?.scm).toBe('bitbucket');
			expect((await findProjectByIdFromDb('proj-scm-unstated'))?.scm).toBeUndefined();
		});

		// The board mapping now lives under `pm`, persisted as `pm_type` + the renamed
		// `pm_config` jsonb column (issue #495). Assert the union member survives a real
		// Postgres round-trip, and that the board lookup still matches inside the blob —
		// that jsonb predicate is how every board webhook finds its project.
		it('round-trips the pm union member and resolves the project by its board node id', async () => {
			const config = createMockProjectConfig({
				id: 'proj-pm-config',
				name: 'PM Config Project',
				repo: 'jkwiecien/pm-config',
				pm: {
					type: 'github-projects',
					projectId: 'PVT_kwDOpersisted',
					statusFieldId: 'PVTSSF_persisted',
					statusOptions: { backlog: 'opt-backlog', todo: 'opt-ready' },
					phaseLabels: { 'phase-6': 'phase-6' },
				},
			});
			await createProjectInDb(toProjectRecord(config));

			expect((await findProjectByIdFromDb('proj-pm-config'))?.pm).toEqual(config.pm);

			const byBoard = await findProjectByBoardFromDb('PVT_kwDOpersisted');
			expect(byBoard?.id).toBe('proj-pm-config');
			expect(await findProjectByBoardFromDb('PVT_untracked')).toBeUndefined();
		});

		// The provider-parameterised container lookup (issue #529). Its predicate is
		// the one piece of new SQL a stubbed-DB unit test can only assert *structurally*
		// — a bound parameter used as the jsonb key, with an explicit `::text` cast to
		// pick the `jsonb ->> text` operator over the integer overload. Whether Postgres
		// actually resolves and executes that is exactly what a real round-trip proves,
		// and it is how every Linear webhook will find its project.
		it('resolves a project by the container key its own provider names', async () => {
			const linearConfig = createMockLinearConfig();
			const linear = createMockLinearProjectConfig({
				id: 'proj-linear-container',
				name: 'Linear Container Project',
				repo: 'jkwiecien/linear-container',
				pm: { type: 'linear', ...linearConfig },
			});
			await createProjectInDb(toProjectRecord(linear));

			const byTeam = await findProjectByPmContainerFromDb('linear', 'teamId', linearConfig.teamId);
			expect(byTeam?.id).toBe('proj-linear-container');
			expect(byTeam?.pm).toEqual(linear.pm);
			expect(
				await findProjectByPmContainerFromDb('linear', 'teamId', 'team-untracked'),
			).toBeUndefined();
		});

		// The collision-safety claim, on a real DB: the same key *and* the same value,
		// asked for under the wrong `pm_type`, must miss. Without the discriminator two
		// providers whose blobs happen to share a key name would resolve each other's
		// projects.
		it('scopes the container match to the asking provider, so two blobs cannot collide', async () => {
			await createProjectInDb(
				toProjectRecord(
					createMockProjectConfig({
						id: 'proj-gh-container',
						name: 'GitHub Container Project',
						repo: 'jkwiecien/gh-container',
					}),
				),
			);

			expect(
				(
					await findProjectByPmContainerFromDb(
						'github-projects',
						'projectId',
						'PVT_kwHOAC3TF84BcNwD',
					)
				)?.id,
			).toBe('proj-gh-container');
			expect(
				await findProjectByPmContainerFromDb('linear', 'projectId', 'PVT_kwHOAC3TF84BcNwD'),
			).toBeUndefined();
		});

		// The PM provider's credential-role references ride the existing `credentials`
		// jsonb column (issue #497) — no column, no migration — so a real round-trip is
		// what proves the nested map survives Postgres.
		it("round-trips the credentials block's PM role references", async () => {
			const config = createMockProjectConfig({
				id: 'proj-pm-credentials',
				name: 'PM Credentials Project',
				repo: 'jkwiecien/pm-credentials',
				credentials: {
					reviewer: 'SCM_TOKEN_REVIEWER',
					webhookSecret: 'SCM_WEBHOOK_SECRET',
					pm: { 'github-projects': { webhookSecret: 'PM_WEBHOOK_SECRET' } },
				},
			});
			await createProjectInDb(toProjectRecord(config));

			expect((await findProjectByIdFromDb('proj-pm-credentials'))?.credentials).toEqual(
				config.credentials,
			);
		});

		it('rejects if the project ID already exists', async () => {
			await seedProject({ id: 'dup-id', name: 'Original Name', repo: 'jkwiecien/original' });

			const duplicateConfig = createMockProjectConfig({
				id: 'dup-id',
				name: 'Duplicate Name',
				repo: 'jkwiecien/duplicate',
			});
			await expect(createProjectInDb(toProjectRecord(duplicateConfig))).rejects.toThrow();

			// Assert original row remains untouched
			const resolved = await findProjectByIdFromDb('dup-id');
			expect(resolved?.name).toBe('Original Name');
		});
	});

	describe('createProjectWithMemberInDb', () => {
		it('inserts project and owner membership atomically in a transaction', async () => {
			const user = await createUser({ identifier: 'owner@example.com', displayName: 'Owner' });
			const config = createMockProjectConfig({
				id: 'proj-atomic',
				name: 'Atomic Project',
				repo: 'jkwiecien/atomic-repo',
			});

			await createProjectWithMemberInDb(toProjectRecord(config), {
				projectId: 'proj-atomic',
				userId: user.id,
				role: 'projectAdmin',
			});

			const project = await findProjectByIdFromDb('proj-atomic');
			expect(project).toBeDefined();
			expect(project?.name).toBe('Atomic Project');

			const membership = await getMembership(user.id, 'proj-atomic');
			expect(membership).toBeDefined();
			expect(membership?.role).toBe('projectAdmin');
		});

		it('rolls back project insertion if membership insertion fails', async () => {
			const config = createMockProjectConfig({
				id: 'proj-rollback',
				name: 'Rollback Project',
				repo: 'jkwiecien/rollback-repo',
			});

			// '00000000-0000-4000-8000-000000000000' does not exist in users table -> foreign key violation
			await expect(
				createProjectWithMemberInDb(toProjectRecord(config), {
					projectId: 'proj-rollback',
					userId: '00000000-0000-4000-8000-000000000000',
					role: 'projectAdmin',
				}),
			).rejects.toThrow();

			const project = await findProjectByIdFromDb('proj-rollback');
			expect(project).toBeUndefined();
		});
	});

	describe('deleteProjectFromDb', () => {
		it('removes the project and cascade deletes all related credentials', async () => {
			await seedProject({ id: 'proj-del', repo: 'jkwiecien/del-repo' });
			await writeProjectCredential('proj-del', 'API_KEY', 'secret-val');

			// Assert both row and credential exist initially
			const projectBefore = await findProjectByIdFromDb('proj-del');
			expect(projectBefore).toBeDefined();

			const credBefore = await getDb()
				.select()
				.from(projectCredentials)
				.where(eq(projectCredentials.projectId, 'proj-del'));
			expect(credBefore).toHaveLength(1);

			// Delete the project
			await deleteProjectFromDb('proj-del');

			// Assert both are gone
			const projectAfter = await findProjectByIdFromDb('proj-del');
			expect(projectAfter).toBeUndefined();

			const credAfter = await getDb()
				.select()
				.from(projectCredentials)
				.where(eq(projectCredentials.projectId, 'proj-del'));
			expect(credAfter).toHaveLength(0);
		});

		it('does not throw when deleting a project ID that does not exist', async () => {
			await expect(deleteProjectFromDb('non-existent')).resolves.toBeUndefined();
		});
	});

	describe('listAllProjectsFromDb', () => {
		it('returns all projects ordered by name ascending', async () => {
			await seedProject({ id: 'proj-c', name: 'Charlie Project', repo: 'jkwiecien/charlie' });
			await seedProject({ id: 'proj-a', name: 'Alpha Project', repo: 'jkwiecien/alpha' });
			await seedProject({ id: 'proj-b', name: 'Bravo Project', repo: 'jkwiecien/bravo' });

			const list = await listAllProjectsFromDb();
			expect(list).toHaveLength(3);
			expect(list[0].name).toBe('Alpha Project');
			expect(list[1].name).toBe('Bravo Project');
			expect(list[2].name).toBe('Charlie Project');
		});

		it('returns an empty array when no projects exist', async () => {
			const list = await listAllProjectsFromDb();
			expect(list).toEqual([]);
		});
	});

	describe('getProjectByIdFromDb', () => {
		it('resolves a project by ID and returns undefined if not found', async () => {
			await seedProject({ id: 'proj-get', name: 'Get Me', repo: 'jkwiecien/get-repo' });

			const project = await getProjectByIdFromDb('proj-get');
			expect(project).toBeDefined();
			expect(project?.name).toBe('Get Me');

			const missing = await getProjectByIdFromDb('non-existent');
			expect(missing).toBeUndefined();
		});
	});

	describe('visibility (#281 task 5)', () => {
		it('defaults to private and round-trips a discoverable value', async () => {
			await seedProject({ id: 'proj-private', repo: 'jkwiecien/private-repo' });
			await createProjectInDb(
				toProjectRecord(
					createMockProjectConfig({
						id: 'proj-open',
						repo: 'jkwiecien/open-repo',
						visibility: 'discoverable',
					}),
				),
			);

			expect((await findProjectByIdFromDb('proj-private'))?.visibility).toBe('private');
			expect((await findProjectByIdFromDb('proj-open'))?.visibility).toBe('discoverable');
		});
	});

	// The repository list and its jsonb containment lookup (issue #684). A stubbed-DB
	// unit test can only assert the predicate's *shape*; whether Postgres actually
	// matches an entry inside the array — and whether the migration produced the column
	// it matches against — is what a real round-trip proves. This is the path every
	// SCM webhook takes to find its project.
	describe('repositories (issue #684)', () => {
		it('round-trips the repository list and resolves the project by an entry it names', async () => {
			await createProjectInDb(
				createMockProjectRecord({
					id: 'proj-repos',
					name: 'Repos Project',
					repositories: [{ repo: 'jkwiecien/list-repo', baseBranch: 'develop' }],
				}),
			);

			expect((await findProjectRecordByIdFromDb('proj-repos'))?.repositories).toEqual([
				{ repo: 'jkwiecien/list-repo', baseBranch: 'develop', branchPrefix: 'issue-' },
			]);

			const byRepo = await findProjectByRepoFromDb('jkwiecien/list-repo');
			expect(byRepo).toMatchObject({
				id: 'proj-repos',
				repo: 'jkwiecien/list-repo',
				baseBranch: 'develop',
			});
			expect(await findProjectByRepoFromDb('jkwiecien/untracked')).toBeUndefined();
		});

		// The write-seam guard that replaced the `repo` UNIQUE constraint the column drop
		// dissolved: without it two projects could claim one repository and the lookup
		// would resolve arbitrarily.
		it('refuses a second project claiming a repository another already owns', async () => {
			await createProjectInDb(
				createMockProjectRecord({
					id: 'proj-owner',
					repositories: [{ repo: 'jkwiecien/claimed' }],
				}),
			);

			await expect(
				createProjectInDb(
					createMockProjectRecord({
						id: 'proj-claimant',
						repositories: [{ repo: 'jkwiecien/claimed' }],
					}),
				),
			).rejects.toThrow(ProjectRepositoryConflictError);

			expect(await findProjectByIdFromDb('proj-claimant')).toBeUndefined();
			// …while the owner re-writing its own repository is still fine.
			await expect(
				upsertProjectToDb(
					createMockProjectRecord({
						id: 'proj-owner',
						name: 'Renamed Owner',
						repositories: [{ repo: 'jkwiecien/claimed' }],
					}),
				),
			).resolves.toBeUndefined();
			expect((await findProjectByIdFromDb('proj-owner'))?.name).toBe('Renamed Owner');
		});

		// Migration 0047 in effect: the three per-repository columns and the UNIQUE
		// constraint on `repo` are gone, and `repositories` is the NOT NULL jsonb column
		// that replaced them.
		it('persists the migrated column shape', async () => {
			const columns = await getDb().execute(
				sql`SELECT column_name, is_nullable, data_type FROM information_schema.columns
					WHERE table_name = 'projects'`,
			);
			const byName = new Map(
				columns.rows.map((column) => [String(column.column_name), column] as const),
			);
			expect(byName.get('repositories')).toMatchObject({
				is_nullable: 'NO',
				data_type: 'jsonb',
			});
			for (const gone of ['repo', 'base_branch', 'branch_prefix']) {
				expect(byName.has(gone), `column ${gone} should be dropped`).toBe(false);
			}

			const constraints = await getDb().execute(
				sql`SELECT conname FROM pg_constraint WHERE conname = 'projects_repo_unique'`,
			);
			expect(constraints.rows).toHaveLength(0);
		});
	});

	describe('listDiscoverableProjectsFromDb', () => {
		it('returns only discoverable projects, limited to id + name, ordered by name', async () => {
			await seedProject({ id: 'proj-priv', name: 'Private One', repo: 'jkwiecien/priv' });
			await createProjectInDb(
				toProjectRecord(
					createMockProjectConfig({
						id: 'proj-b',
						name: 'Bravo Open',
						repo: 'jkwiecien/bravo',
						visibility: 'discoverable',
					}),
				),
			);
			await createProjectInDb(
				toProjectRecord(
					createMockProjectConfig({
						id: 'proj-a',
						name: 'Alpha Open',
						repo: 'jkwiecien/alpha',
						visibility: 'discoverable',
					}),
				),
			);

			const discoverable = await listDiscoverableProjectsFromDb();
			// Private project excluded; discoverable ones ordered by name.
			expect(discoverable).toEqual([
				{ id: 'proj-a', name: 'Alpha Open' },
				{ id: 'proj-b', name: 'Bravo Open' },
			]);
			// The limited view exposes exactly id + name — no credentials/config leak.
			expect(Object.keys(discoverable[0]).sort()).toEqual(['id', 'name']);
		});
	});
});
