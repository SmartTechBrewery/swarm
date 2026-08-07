import { eq } from 'drizzle-orm';
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
	getProjectByIdFromDb,
	listAllProjectsFromDb,
	listDiscoverableProjectsFromDb,
} from '../../../src/db/repositories/projectsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { projectCredentials } from '../../../src/db/schema/projectCredentials.js';
import {
	createMockLinearConfig,
	createMockLinearProjectConfig,
	createMockProjectConfig,
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
			await createProjectInDb(config);

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
			await createProjectInDb(config);

			const resolved = await findProjectByIdFromDb('proj-review-checks');
			expect(resolved?.pipeline?.review?.checks).toBe('if-present');
			expect(resolved?.pipeline?.planning?.autoAdvance).toBe(true);
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
			await createProjectInDb(config);

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
			await createProjectInDb(linear);

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
				createMockProjectConfig({
					id: 'proj-gh-container',
					name: 'GitHub Container Project',
					repo: 'jkwiecien/gh-container',
				}),
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
					pm: { webhookSecret: 'PM_WEBHOOK_SECRET' },
				},
			});
			await createProjectInDb(config);

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
			await expect(createProjectInDb(duplicateConfig)).rejects.toThrow();

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

			await createProjectWithMemberInDb(config, {
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
				createProjectWithMemberInDb(config, {
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
				createMockProjectConfig({
					id: 'proj-open',
					repo: 'jkwiecien/open-repo',
					visibility: 'discoverable',
				}),
			);

			expect((await findProjectByIdFromDb('proj-private'))?.visibility).toBe('private');
			expect((await findProjectByIdFromDb('proj-open'))?.visibility).toBe('discoverable');
		});
	});

	describe('listDiscoverableProjectsFromDb', () => {
		it('returns only discoverable projects, limited to id + name, ordered by name', async () => {
			await seedProject({ id: 'proj-priv', name: 'Private One', repo: 'jkwiecien/priv' });
			await createProjectInDb(
				createMockProjectConfig({
					id: 'proj-b',
					name: 'Bravo Open',
					repo: 'jkwiecien/bravo',
					visibility: 'discoverable',
				}),
			);
			await createProjectInDb(
				createMockProjectConfig({
					id: 'proj-a',
					name: 'Alpha Open',
					repo: 'jkwiecien/alpha',
					visibility: 'discoverable',
				}),
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
