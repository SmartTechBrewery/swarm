import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import { writeProjectCredential } from '../../../src/db/repositories/credentialsRepository.js';
import {
	cancelWaitingDispatch,
	claimDispatch,
	completeDispatch,
	createDispatch,
	getDispatchById,
	markDispatchRunning,
} from '../../../src/db/repositories/dispatchesRepository.js';
import { getMembership } from '../../../src/db/repositories/projectMembersRepository.js';
import {
	createProjectInDb,
	createProjectWithMemberInDb,
	deleteIdleProjectFromDb,
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
import { completeRun, createRun } from '../../../src/db/repositories/runsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { dispatches as dispatchesTable } from '../../../src/db/schema/dispatches.js';
import { projectCredentials } from '../../../src/db/schema/projectCredentials.js';
import type { SwarmJob } from '../../../src/queue/jobs.js';
import {
	createMockLinearConfig,
	createMockLinearProjectConfig,
	createMockProjectConfig,
	createMockProjectRecord,
	createMockScmWebhookJob,
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

	// The guard `projects.delete` goes through (issue #854). What matters here is not
	// only *that* it refuses, but that the refusal cannot be raced: the review of that
	// PR found the window where a worker has claimed a dispatch and read the project but
	// has not written its run row yet, so a `running`-runs count alone saw nothing and
	// the cascade removed a dispatch out from under an executing agent.
	describe('deleteIdleProjectFromDb (issue #854)', () => {
		const GUARD_PROJECT = 'proj-guard';
		const GUARD_REPO = 'jkwiecien/guard-repo';
		const OWNER = 'test-worker:1';

		function guardJob(): SwarmJob {
			return { ...createMockScmWebhookJob(), projectId: GUARD_PROJECT } as SwarmJob;
		}

		async function seedGuardProject() {
			await seedProject({ id: GUARD_PROJECT, repo: GUARD_REPO });
		}

		async function seedDispatch(taskId: string) {
			const { dispatch } = await createDispatch({
				projectId: GUARD_PROJECT,
				jobPayload: guardJob(),
				source: 'manual',
				taskId,
				phase: 'review',
				state: 'pending',
			});
			return dispatch;
		}

		it('deletes an idle project', async () => {
			await seedGuardProject();

			await expect(deleteIdleProjectFromDb(GUARD_PROJECT)).resolves.toEqual({ deleted: true });
			await expect(findProjectByIdFromDb(GUARD_PROJECT)).resolves.toBeUndefined();
		});

		it('reports not-found rather than deleting nothing silently', async () => {
			await expect(deleteIdleProjectFromDb('never-existed')).resolves.toEqual({
				deleted: false,
				reason: 'not-found',
			});
		});

		// The exact window the review named: claimed, executing, no run row yet.
		it('refuses while a claimed dispatch has not written its run row yet', async () => {
			await seedGuardProject();
			const dispatch = await seedDispatch('854-claimed');
			await claimDispatch(dispatch.id, OWNER, 60_000);

			await expect(deleteIdleProjectFromDb(GUARD_PROJECT)).resolves.toEqual({
				deleted: false,
				reason: 'in-flight',
				executingDispatches: 1,
				runningRuns: 0,
			});
			await expect(findProjectByIdFromDb(GUARD_PROJECT)).resolves.toBeDefined();
			await expect(getDispatchById(dispatch.id)).resolves.toBeDefined();
		});

		it('refuses while a dispatch is running against its run row', async () => {
			await seedGuardProject();
			const dispatch = await seedDispatch('854-running');
			await claimDispatch(dispatch.id, OWNER, 60_000);
			const runId = await createRun({
				projectId: GUARD_PROJECT,
				repository: GUARD_REPO,
				taskId: '854-running',
				phase: 'review',
			});
			await markDispatchRunning(dispatch.id, runId, new Date(Date.now() + 60_000), {
				taskId: '854-running',
				phase: 'review',
			});

			await expect(deleteIdleProjectFromDb(GUARD_PROJECT)).resolves.toEqual({
				deleted: false,
				reason: 'in-flight',
				executingDispatches: 1,
				runningRuns: 1,
			});
		});

		// The other edge: the worker died, the sweep settled its dispatch, and the run
		// row is still `running` until the orphan reaper gets to it.
		it('refuses on a still-running run row whose dispatch already settled', async () => {
			await seedGuardProject();
			const dispatch = await seedDispatch('854-zombie');
			await claimDispatch(dispatch.id, OWNER, 60_000);
			const runId = await createRun({
				projectId: GUARD_PROJECT,
				repository: GUARD_REPO,
				taskId: '854-zombie',
				phase: 'review',
			});
			await markDispatchRunning(dispatch.id, runId, new Date(Date.now() + 60_000), {
				taskId: '854-zombie',
				phase: 'review',
			});
			await completeDispatch(dispatch.id, 'phase-succeeded');

			await expect(deleteIdleProjectFromDb(GUARD_PROJECT)).resolves.toEqual({
				deleted: false,
				reason: 'in-flight',
				executingDispatches: 0,
				runningRuns: 1,
			});

			// …and stops refusing once that row settles.
			await completeRun(runId, { status: 'failed', error: 'reaped' });
			await expect(deleteIdleProjectFromDb(GUARD_PROJECT)).resolves.toEqual({ deleted: true });
		});

		// A queued dispatch is not executing anything, so it is not a refusal — the
		// delete drops it, and the lock it was taken under is what stops a claim from
		// turning it into an executing one inside the window.
		it('deletes past queued and settled dispatches, cascading them away', async () => {
			await seedGuardProject();
			const queued = await seedDispatch('854-queued');
			const cancelled = await seedDispatch('854-cancelled');
			await cancelWaitingDispatch(cancelled.id, 'cleared the queue');

			await expect(deleteIdleProjectFromDb(GUARD_PROJECT)).resolves.toEqual({ deleted: true });
			await expect(getDispatchById(queued.id)).resolves.toBeUndefined();
			await expect(getDispatchById(cancelled.id)).resolves.toBeUndefined();
		});

		// The race itself, run against the real database on two connections: a claim of a
		// queued dispatch against the delete of its project. Whichever order the two land
		// in, they must not *both* succeed — that is the outcome in which an agent starts
		// executing a dispatch the cascade has already removed.
		it('never lets a dispatch claim and the delete both win', async () => {
			await seedGuardProject();
			const dispatch = await seedDispatch('854-race');

			const [deletion, claim] = await Promise.all([
				deleteIdleProjectFromDb(GUARD_PROJECT),
				claimDispatch(dispatch.id, OWNER, 60_000),
			]);

			expect(deletion.deleted && claim !== null).toBe(false);
			if (deletion.deleted) {
				// The delete won: the dispatch row is gone, so nothing can execute it.
				await expect(getDispatchById(dispatch.id)).resolves.toBeUndefined();
			} else {
				// The claim won, either by getting there first (`in-flight`) or by holding
				// the row as the delete looked (`contended`). Either way the project is
				// still here to record whatever now executes.
				expect(deletion.deleted).toBe(false);
				expect(['in-flight', 'contended']).toContain((deletion as { reason: string }).reason);
				await expect(findProjectByIdFromDb(GUARD_PROJECT)).resolves.toBeDefined();
			}
		});

		// Deliberately *not* a wait: `claimWorkerForDispatch` locks the dispatch row
		// before the project row, the delete does it the other way round, so a delete
		// that waited could sit in an ABBA cycle with a claim. It fails fast instead —
		// which is a refusal, never a deletion.
		it('refuses as contended rather than waiting on a dispatch row a claim holds', async () => {
			await seedGuardProject();
			const dispatch = await seedDispatch('854-contended');

			const outcome = await getDb().transaction(async (tx) => {
				// Hold the dispatch row exactly as a claim in progress would.
				await tx
					.select({ id: dispatchesTable.id })
					.from(dispatchesTable)
					.where(eq(dispatchesTable.id, dispatch.id))
					.for('update');
				return await deleteIdleProjectFromDb(GUARD_PROJECT);
			});

			expect(outcome).toEqual({ deleted: false, reason: 'contended' });
			await expect(findProjectByIdFromDb(GUARD_PROJECT)).resolves.toBeDefined();
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

		// issue #684 phase 2 lifted phase 1's one-entry cap, so a project genuinely
		// holding three repositories is now writable — and this is the real-Postgres proof
		// that the jsonb containment predicate matches *any* entry, not just the first,
		// and that each webhook resolves the project scoped to the entry it named.
		it('resolves the same project from each of three entries, scoped to the matched one', async () => {
			await createProjectInDb(
				createMockProjectRecord({
					id: 'proj-multi',
					name: 'Multi Repo Project',
					repositories: [
						{ repo: 'jkwiecien/first' },
						{ repo: 'jkwiecien/second', baseBranch: 'develop', branchPrefix: 'task-' },
						{ repo: 'jkwiecien/third', branchPrefix: 'work-' },
					],
				}),
			);

			expect(await findProjectByRepoFromDb('jkwiecien/first')).toMatchObject({
				id: 'proj-multi',
				repo: 'jkwiecien/first',
				baseBranch: 'main',
				branchPrefix: 'issue-',
			});
			expect(await findProjectByRepoFromDb('jkwiecien/second')).toMatchObject({
				id: 'proj-multi',
				repo: 'jkwiecien/second',
				baseBranch: 'develop',
				branchPrefix: 'task-',
			});
			// Every entry resolves the project's own provider — there is no per-repository
			// override (issue #727).
			expect(await findProjectByRepoFromDb('jkwiecien/third')).toMatchObject({
				id: 'proj-multi',
				repo: 'jkwiecien/third',
				branchPrefix: 'work-',
			});
		});

		// What a job or a run row does: it knows its repository by name, so it reads the
		// project scoped straight to that entry (issue #684 phase 2).
		it('scopes a by-id read to a named entry, and throws for one the project does not own', async () => {
			await createProjectInDb(
				createMockProjectRecord({
					id: 'proj-by-id',
					name: 'By Id Project',
					repositories: [
						{ repo: 'jkwiecien/default-entry' },
						{ repo: 'jkwiecien/other-entry', baseBranch: 'develop' },
					],
				}),
			);

			// No repository named → the default (first) entry, which is what board-driven
			// Planning and Implementation keep resolving to.
			expect(await findProjectByIdFromDb('proj-by-id')).toMatchObject({
				repo: 'jkwiecien/default-entry',
			});
			expect(await findProjectByIdFromDb('proj-by-id', 'jkwiecien/other-entry')).toMatchObject({
				repo: 'jkwiecien/other-entry',
				baseBranch: 'develop',
			});
			await expect(findProjectByIdFromDb('proj-by-id', 'jkwiecien/never-owned')).rejects.toThrow(
				/does not own repository 'jkwiecien\/never-owned'/,
			);
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
