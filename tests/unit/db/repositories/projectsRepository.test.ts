import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/client.js', () => ({ getDb: vi.fn() }));

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { scopeProjectToRepository } from '@/config/project-repository.js';
import { getDb } from '@/db/client.js';
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
	ProjectRepositoryConflictError,
	upsertProjectToDb,
} from '@/db/repositories/projectsRepository.js';
import { projects } from '@/db/schema/projects.js';
import { requireGitHubProjectsConfig } from '@/integrations/pm/github-projects/config-schema.js';
import { createMockProjectRecord } from '../../../helpers/factories.js';

/**
 * A select-chain stub. Thenable as well as `.limit()`-able because the two read
 * shapes end differently: a lookup finishes on `.limit()`, while the repository-claim
 * guard (`assertRepositoriesUnclaimed`) awaits the query straight off `.orderBy()`.
 */
function selectBuilder(
	rows: unknown[],
	onWhere?: (predicate: SQL) => void,
	onOrderBy?: (column: unknown) => void,
) {
	const builder = {
		select: () => builder,
		from: () => builder,
		where: (predicate: SQL) => {
			onWhere?.(predicate);
			return builder;
		},
		orderBy: (column: unknown) => {
			onOrderBy?.(column);
			return builder;
		},
		limit: () => Promise.resolve(rows),
		// biome-ignore lint/suspicious/noThenProperty: the guard awaits the builder itself
		then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
	};
	return builder;
}

function stubDb(rows: unknown[]): void {
	vi.mocked(getDb).mockReturnValue(selectBuilder(rows) as unknown as ReturnType<typeof getDb>);
}

/** Like {@link stubDb}, but also captures the `.where()` predicate for inspection. */
function stubDbCapturingWhere(rows: unknown[]): { where: () => SQL | undefined } {
	let captured: SQL | undefined;
	vi.mocked(getDb).mockReturnValue(
		selectBuilder(rows, (predicate) => {
			captured = predicate;
		}) as unknown as ReturnType<typeof getDb>,
	);
	return { where: () => captured };
}

/**
 * Capture the `.values()` / `.onConflictDoUpdate()` args of an insert-upsert chain.
 * `claimedBy` is what the repository-claim guard's select sees — empty (nobody owns
 * the repository) unless a test is exercising the conflict.
 */
function stubInsert(claimedBy: unknown[] = []): {
	values: ReturnType<typeof vi.fn>;
	onConflictDoUpdate: ReturnType<typeof vi.fn>;
} {
	const onConflictDoUpdate = vi.fn(() => Promise.resolve());
	const values = vi.fn(() => ({ onConflictDoUpdate }));
	const insert = vi.fn(() => ({ values }));
	const builder = selectBuilder(claimedBy) as unknown as Record<string, unknown>;
	vi.mocked(getDb).mockReturnValue({ ...builder, insert } as unknown as ReturnType<typeof getDb>);
	return { values, onConflictDoUpdate };
}

const row = {
	id: 'proj-1',
	name: 'swarm',
	// The three per-repository columns are one jsonb list since issue #684.
	repositories: [{ repo: 'SmartTechBrewery/swarm', baseBranch: 'main', branchPrefix: 'issue-' }],
	repoRoot: '/Users/dev/swarm',
	worktreeRoot: '.swarm-workspaces',
	maxConcurrentJobs: 4,
	pmType: 'github-projects',
	// `pm` persists split: the discriminator in `pm_type`, the provider's own config
	// in the generic `pm_config` blob (issue #495).
	pmConfig: {
		projectId: 'PVT_x',
		statusFieldId: 'PVTSSF_x',
		statusOptions: { backlog: 'a', planning: 'b', inProgress: 'c', inReview: 'd', done: 'e' },
	},
	credentials: { implementer: 'IMPL', reviewer: 'REV', webhookSecret: 'HOOK' },
	createdAt: new Date(),
	updatedAt: new Date(),
};

describe('projectsRepository', () => {
	beforeEach(() => {
		vi.mocked(getDb).mockReset();
	});

	describe('findProjectByRepoFromDb', () => {
		it('maps a row back to a ProjectConfig', async () => {
			stubDb([row]);
			const project = await findProjectByRepoFromDb('SmartTechBrewery/swarm');
			expect(project).toMatchObject({
				id: 'proj-1',
				repo: 'SmartTechBrewery/swarm',
				maxConcurrentJobs: 4,
				pm: { type: 'github-projects' },
				credentials: { implementer: 'IMPL', reviewer: 'REV', webhookSecret: 'HOOK' },
			});
			// The persisted DB timestamps are not part of the config shape.
			expect(project).not.toHaveProperty('createdAt');
		});

		it('returns undefined when no project owns the repo', async () => {
			stubDb([]);
			expect(await findProjectByRepoFromDb('someone/else')).toBeUndefined();
		});

		// The `repo` column (and its UNIQUE index) is gone: the lookup matches *any*
		// entry of the jsonb list by containment, and orders by id so the result can
		// never depend on heap order (issue #684).
		it('matches any repositories entry by jsonb containment, ordered by id', async () => {
			const captured = stubDbCapturingWhere([row]);

			await findProjectByRepoFromDb('SmartTechBrewery/swarm');

			const predicate = captured.where();
			expect(predicate).toBeDefined();
			const query = new PgDialect().sqlToQuery(predicate as SQL);
			expect(query.sql).toContain('"repositories" @>');
			// Bound, not interpolated: the repo never appears literally in the SQL.
			expect(query.sql).not.toContain('SmartTechBrewery');
			expect(query.params).toEqual(['[{"repo":"SmartTechBrewery/swarm"}]']);
		});

		// Scoping to the *matched* entry is what keeps a delivery from repository B
		// running against repository A's branch settings once phase 2 lifts the cap.
		it('scopes the result to the matched entry, not the first one', async () => {
			stubDb([
				{
					...row,
					repositories: [
						{ repo: 'SmartTechBrewery/first', baseBranch: 'main', branchPrefix: 'issue-' },
						{ repo: 'SmartTechBrewery/second', baseBranch: 'develop', branchPrefix: 'task-' },
					],
				},
			]);

			const project = await findProjectByRepoFromDb('SmartTechBrewery/second');

			expect(project).toMatchObject({
				repo: 'SmartTechBrewery/second',
				baseBranch: 'develop',
				branchPrefix: 'task-',
			});
			// A scoped config carries no list, so nothing downstream can reach another entry.
			expect(project).not.toHaveProperty('repositories');
		});

		// A repository stating its own provider overrides the project-level default.
		it("prefers the matched entry's scm over the project-level default", async () => {
			stubDb([
				{
					...row,
					scmType: 'github',
					repositories: [
						{
							repo: 'SmartTechBrewery/swarm',
							baseBranch: 'main',
							branchPrefix: 'issue-',
							scm: 'gitlab',
						},
					],
				},
			]);
			const project = await findProjectByRepoFromDb('SmartTechBrewery/swarm');
			expect(project?.scm).toBe('gitlab');
		});

		it('maps a null agents column to undefined (the common case: no override configured)', async () => {
			stubDb([{ ...row, agents: null }]);
			const project = await findProjectByRepoFromDb('SmartTechBrewery/swarm');
			expect(project?.agents).toBeUndefined();
		});

		it('round-trips a populated agents column', async () => {
			const agents = { review: { cli: 'claude' as const, model: 'opus' } };
			stubDb([{ ...row, agents }]);
			const project = await findProjectByRepoFromDb('SmartTechBrewery/swarm');
			expect(project?.agents).toEqual(agents);
		});

		it('maps a populated scm_type column to the config discriminator', async () => {
			stubDb([{ ...row, scmType: 'bitbucket' }]);
			const project = await findProjectByRepoFromDb('SmartTechBrewery/swarm');
			expect(project?.scm).toBe('bitbucket');
		});

		// A NULL column is "this project states no provider", which the lookup resolves
		// to the sole runtime-ready one — so the key must come back *absent* rather than
		// present-and-undefined (issue #478).
		it('leaves scm absent when the column is null', async () => {
			stubDb([{ ...row, scmType: null }]);
			const project = await findProjectByRepoFromDb('SmartTechBrewery/swarm');
			expect(project?.scm).toBeUndefined();
			expect(Object.hasOwn(project as object, 'scm')).toBe(false);
		});
	});

	describe('findProjectByBoardFromDb', () => {
		it('maps a row back to a ProjectConfig', async () => {
			stubDb([row]);
			const project = await findProjectByBoardFromDb('PVT_x');
			expect(project).toMatchObject({
				id: 'proj-1',
				pm: { type: 'github-projects', projectId: 'PVT_x' },
			});
		});

		it('returns undefined when no project owns the board', async () => {
			stubDb([]);
			expect(await findProjectByBoardFromDb('PVT_unknown')).toBeUndefined();
		});

		// The board mapping moved into the renamed `pm_config` column (issue #495), and
		// this jsonb lookup is the one query that reaches inside the blob — so assert the
		// rendered predicate, not just the row mapping, or a stale column name would
		// silently resolve no project for every board webhook.
		it('matches the board node id inside the pm_config column', async () => {
			const captured = stubDbCapturingWhere([row]);

			await findProjectByBoardFromDb('PVT_x');

			const predicate = captured.where();
			expect(predicate).toBeDefined();
			const query = new PgDialect().sqlToQuery(predicate as SQL);
			expect(query.sql).toContain('"pm_config"->>\'projectId\'');
			expect(query.sql).not.toContain('github_projects');
			expect(query.params).toEqual(['PVT_x']);
		});
	});

	// The provider-parameterised container lookup (issue #529): the second PM
	// provider resolving a project from a board event names its own `pm_type` and
	// its own `pm_config` key rather than sharing the GitHub-shaped predicate above.
	describe('findProjectByPmContainerFromDb', () => {
		const linearRow = {
			...row,
			id: 'proj-linear',
			repositories: [
				{ repo: 'SmartTechBrewery/other', baseBranch: 'main', branchPrefix: 'issue-' },
			],
			pmType: 'linear',
			pmConfig: { teamId: 'team-uuid', statusOptions: { inProgress: 'state-uuid' } },
		};

		it('maps a row back to a ProjectConfig', async () => {
			stubDb([linearRow]);
			const project = await findProjectByPmContainerFromDb('linear', 'teamId', 'team-uuid');
			expect(project).toMatchObject({
				id: 'proj-linear',
				pm: { type: 'linear', teamId: 'team-uuid' },
			});
		});

		it('returns undefined when no project owns the container', async () => {
			stubDb([]);
			expect(
				await findProjectByPmContainerFromDb('linear', 'teamId', 'team-unknown'),
			).toBeUndefined();
		});

		// The `pm_type` filter is what keeps two providers' blobs from colliding on a
		// shared key name, and the container key is a bound parameter rather than an
		// interpolated string — assert both in the rendered predicate, since neither is
		// observable from the row mapping.
		it('filters on pm_type and matches the provider-named key inside pm_config', async () => {
			const captured = stubDbCapturingWhere([linearRow]);

			await findProjectByPmContainerFromDb('linear', 'teamId', 'team-uuid');

			const predicate = captured.where();
			expect(predicate).toBeDefined();
			const query = new PgDialect().sqlToQuery(predicate as SQL);
			expect(query.sql).toContain('"pm_type"');
			expect(query.sql).toContain('"pm_config"->>');
			// Bound, not interpolated: the key never appears literally in the SQL.
			expect(query.sql).not.toContain('teamId');
			expect(query.params).toEqual(['linear', 'teamId', 'team-uuid']);
		});
	});

	// The config-management read: the whole record, repository list included (issue #684).
	describe('findProjectRecordByIdFromDb', () => {
		it('returns the repository list rather than a scoped view', async () => {
			stubDb([row]);
			const record = await findProjectRecordByIdFromDb('proj-1');
			expect(record?.repositories).toEqual([
				{ repo: 'SmartTechBrewery/swarm', baseBranch: 'main', branchPrefix: 'issue-' },
			]);
			expect(record).not.toHaveProperty('repo');
		});

		it('returns undefined for an unknown id', async () => {
			stubDb([]);
			expect(await findProjectRecordByIdFromDb('nope')).toBeUndefined();
		});
	});

	describe('findProjectByIdFromDb', () => {
		// Three entries, so "the matched one" is distinguishable from both the default
		// and the last (issue #684 phase 2).
		const threeRepositories = [
			{ repo: 'SmartTechBrewery/first', baseBranch: 'main', branchPrefix: 'issue-' },
			{ repo: 'SmartTechBrewery/second', baseBranch: 'develop', branchPrefix: 'task-' },
			{ repo: 'SmartTechBrewery/third', baseBranch: 'trunk', branchPrefix: 'work-' },
		];

		it('maps a row back to a ProjectConfig', async () => {
			stubDb([row]);
			const project = await findProjectByIdFromDb('proj-1');
			expect(project).toMatchObject({ id: 'proj-1', pm: { type: 'github-projects' } });
		});

		it('returns undefined for an unknown id', async () => {
			stubDb([]);
			expect(await findProjectByIdFromDb('nope')).toBeUndefined();
		});

		// The default entry is the first, which is what board-driven work resolves to.
		it('scopes to the default (first) entry when no repository is named', async () => {
			stubDb([{ ...row, repositories: threeRepositories }]);
			expect(await findProjectByIdFromDb('proj-1')).toMatchObject({
				repo: 'SmartTechBrewery/first',
				baseBranch: 'main',
				branchPrefix: 'issue-',
			});
		});

		// A job or a run row that names its repository gets *that* entry's settings, not
		// the default one's — the whole point of the parameter.
		it('scopes to the named entry, carrying its own branch settings', async () => {
			stubDb([{ ...row, repositories: threeRepositories }]);
			const project = await findProjectByIdFromDb('proj-1', 'SmartTechBrewery/second');
			expect(project).toMatchObject({
				repo: 'SmartTechBrewery/second',
				baseBranch: 'develop',
				branchPrefix: 'task-',
			});
			// A scoped config carries no list, so nothing downstream can reach another entry.
			expect(project).not.toHaveProperty('repositories');
		});

		// The loud failure: naming a repository the project does not own is a
		// misconfiguration, never something to silently fall back from.
		it('throws naming the project and the repositories it owns for an unowned repository', async () => {
			stubDb([{ ...row, repositories: threeRepositories }]);
			await expect(findProjectByIdFromDb('proj-1', 'SmartTechBrewery/gone')).rejects.toThrow(
				/'proj-1' does not own repository 'SmartTechBrewery\/gone'.*first.*second.*third/,
			);
		});

		// An unknown *project* stays `undefined` rather than throwing: a caller reading a
		// project id off a durable row has to cope with the project having been deleted.
		it('still returns undefined for an unknown id even when a repository is named', async () => {
			stubDb([]);
			expect(await findProjectByIdFromDb('nope', 'SmartTechBrewery/second')).toBeUndefined();
		});
	});

	describe('getProjectByIdFromDb', () => {
		it('maps a row back to a ProjectConfig and functions identically to findProjectByIdFromDb', async () => {
			stubDb([row]);
			const project = await getProjectByIdFromDb('proj-1');
			expect(project).toMatchObject({ id: 'proj-1', pm: { type: 'github-projects' } });
		});
	});

	describe('upsertProjectToDb', () => {
		it('flattens pm.type into a column and upserts on the id', async () => {
			const { values, onConflictDoUpdate } = stubInsert();
			const project = createMockProjectRecord({ id: 'proj-1' });
			const pm = requireGitHubProjectsConfig(scopeProjectToRepository(project));

			await upsertProjectToDb(project);

			const inserted = values.mock.calls[0][0];
			expect(inserted).toMatchObject({ id: 'proj-1', pmType: 'github-projects' });
			// The row shape is columns, not the nested `pm` object of the config: the
			// discriminator goes to `pm_type` and the rest of the member to `pm_config`,
			// with no `type` key left inside the blob (issue #495).
			expect(inserted).not.toHaveProperty('pm');
			expect(inserted.pmConfig).toEqual({
				projectId: pm.projectId,
				statusFieldId: pm.statusFieldId,
				statusOptions: pm.statusOptions,
			});

			const [conflict] = onConflictDoUpdate.mock.calls[0];
			// Keyed on the id, which is itself excluded from the update set.
			expect(conflict.set).not.toHaveProperty('id');
			expect(conflict.set).toMatchObject({ pmType: 'github-projects' });
		});

		it('round-trips the pm union member through the two columns it persists as', async () => {
			const { values } = stubInsert();
			const project = createMockProjectRecord({
				id: 'proj-1',
				pm: {
					type: 'github-projects',
					projectId: 'PVT_round_trip',
					statusFieldId: 'PVTSSF_round_trip',
					statusOptions: { backlog: 'a', todo: 'b' },
					phaseLabels: { 'phase-0': 'phase-0' },
				},
			});

			await upsertProjectToDb(project);

			// Read the written row back the way Postgres would hand it over — through
			// JSON — and the config's `pm` must come out deep-equal, `phaseLabels` and
			// all. This is the guarantee the column rename has to preserve.
			const written = values.mock.calls[0][0] as { pmType: string; pmConfig: unknown };
			stubDb([
				{
					...row,
					pmType: written.pmType,
					pmConfig: JSON.parse(JSON.stringify(written.pmConfig)),
				},
			]);
			const reread = await findProjectByRepoFromDb('SmartTechBrewery/swarm');
			expect(reread?.pm).toEqual(project.pm);
		});

		// The `credentials` jsonb column is persisted as-is, so the PM provider's role
		// map (issue #497) must survive a write/read cycle without a column change.
		it("round-trips the credentials block's PM role references", async () => {
			const { values } = stubInsert();
			const project = createMockProjectRecord({
				id: 'proj-1',
				credentials: {
					reviewer: 'SCM_TOKEN_REVIEWER',
					webhookSecret: 'SCM_WEBHOOK_SECRET',
					pm: { 'github-projects': { webhookSecret: 'PM_WEBHOOK_SECRET' } },
				},
			});

			await upsertProjectToDb(project);

			const written = values.mock.calls[0][0] as { credentials: unknown };
			expect(written.credentials).toEqual(project.credentials);
			stubDb([{ ...row, credentials: JSON.parse(JSON.stringify(written.credentials)) }]);
			const reread = await findProjectByRepoFromDb('SmartTechBrewery/swarm');
			expect(reread?.credentials).toEqual(project.credentials);
		});

		it('writes agents as null when the config omits it', async () => {
			const { values } = stubInsert();
			await upsertProjectToDb(createMockProjectRecord({ id: 'proj-1' }));
			expect(values.mock.calls[0][0]).toMatchObject({ agents: null });
		});

		it('writes the scm discriminator, and null when the project states none', async () => {
			const { values: withScm } = stubInsert();
			await upsertProjectToDb(createMockProjectRecord({ id: 'proj-1', scm: 'gitlab' }));
			expect(withScm.mock.calls[0][0]).toMatchObject({ scmType: 'gitlab' });

			// Never 'github': a project that states no provider must stay unstated in the
			// row, or the loud "set scm" error can never fire for it (issue #478).
			const { values: withoutScm } = stubInsert();
			await upsertProjectToDb(createMockProjectRecord({ id: 'proj-1' }));
			expect(withoutScm.mock.calls[0][0]).toMatchObject({ scmType: null });
		});

		it('writes the repository list to its own jsonb column', async () => {
			const { values } = stubInsert();
			await upsertProjectToDb(createMockProjectRecord({ id: 'proj-1' }));
			const inserted = values.mock.calls[0][0];
			expect(inserted.repositories).toEqual([
				{ repo: 'SmartTechBrewery/swarm', baseBranch: 'main', branchPrefix: 'issue-' },
			]);
			// The three per-repository columns are gone, not merely unused.
			for (const key of ['repo', 'baseBranch', 'branchPrefix']) {
				expect(inserted).not.toHaveProperty(key);
			}
		});

		// The write-seam guard standing in for the `repo` UNIQUE constraint the column
		// drop dissolved (issue #684).
		it('refuses a write claiming a repository another project already owns', async () => {
			stubInsert([{ id: 'other-project' }]);
			await expect(upsertProjectToDb(createMockProjectRecord({ id: 'proj-1' }))).rejects.toThrow(
				ProjectRepositoryConflictError,
			);
		});

		it('allows a project to keep its own repository on re-write', async () => {
			const { values } = stubInsert([{ id: 'proj-1' }]);
			await upsertProjectToDb(createMockProjectRecord({ id: 'proj-1' }));
			expect(values).toHaveBeenCalledTimes(1);
		});

		it('writes the configured maximum concurrent jobs', async () => {
			const { values } = stubInsert();
			await upsertProjectToDb(createMockProjectRecord({ id: 'proj-1', maxConcurrentJobs: 3 }));
			expect(values.mock.calls[0][0]).toMatchObject({ maxConcurrentJobs: 3 });
		});

		it('writes the agents block as-is when the config sets one', async () => {
			const { values } = stubInsert();
			// A legacy combined antigravity model normalizes to logical id + reasoning
			// at the config-schema boundary (issue #180); the repo then writes that
			// normalized shape verbatim.
			const agents = {
				planning: { cli: 'antigravity' as const, model: 'Gemini 3.5 Flash (High)' },
			};
			await upsertProjectToDb(createMockProjectRecord({ id: 'proj-1', agents }));
			expect(values.mock.calls[0][0]).toMatchObject({
				agents: {
					planning: { cli: 'antigravity', model: 'gemini-3.5-flash', reasoning: 'high' },
				},
			});
		});

		it('round-trips an ordered target list through the jsonb column (issue #342)', async () => {
			const { values } = stubInsert();
			const agents = {
				planning: {
					targets: [
						{ cli: 'claude' as const, model: 'opus', reasoning: 'high' as const },
						{ cli: 'codex' as const, model: 'gpt-5.6-terra' },
					],
				},
			};
			await upsertProjectToDb(createMockProjectRecord({ id: 'proj-1', agents }));

			// `agents` is a jsonb blob typed by the Zod schema — a target list needs no
			// migration, but it must survive serialization in priority order.
			const written = values.mock.calls[0][0] as { agents: unknown };
			stubDb([{ ...row, agents: JSON.parse(JSON.stringify(written.agents)) }]);
			const project = await findProjectByRepoFromDb('SmartTechBrewery/swarm');
			expect(project?.agents?.planning?.targets).toEqual([
				{ cli: 'claude', model: 'opus', reasoning: 'high' },
				{ cli: 'codex', model: 'gpt-5.6-terra' },
			]);
			// The mirror the worker/dashboard read still resolves the top target.
			expect(project?.agents?.planning).toMatchObject({ cli: 'claude', model: 'opus' });
		});
	});

	describe('listAllProjectsFromDb', () => {
		it('returns all mapped projects ordered by name', async () => {
			let orderedBy: unknown;
			const builder = {
				select: () => builder,
				from: () => builder,
				orderBy: (col: unknown) => {
					orderedBy = col;
					return Promise.resolve([row, { ...row, id: 'proj-2', name: 'another' }]);
				},
			};
			vi.mocked(getDb).mockReturnValue(builder as unknown as ReturnType<typeof getDb>);

			const list = await listAllProjectsFromDb();
			expect(list).toHaveLength(2);
			expect(list[0]).toMatchObject({ id: 'proj-1', name: 'swarm' });
			expect(list[1]).toMatchObject({ id: 'proj-2', name: 'another' });
			expect(orderedBy).toBeDefined();
		});

		it('returns an empty array when no projects exist', async () => {
			const builder = {
				select: () => builder,
				from: () => builder,
				orderBy: () => Promise.resolve([]),
			};
			vi.mocked(getDb).mockReturnValue(builder as unknown as ReturnType<typeof getDb>);

			const list = await listAllProjectsFromDb();
			expect(list).toEqual([]);
		});
	});

	describe('createProjectInDb', () => {
		it('inserts a project without an onConflict clause', async () => {
			let insertedValues: unknown;
			let isThenCalled = false;
			const builder = {
				// The repository-claim guard runs first and finds nobody owning the repo.
				select: () => builder,
				from: () => builder,
				where: () => builder,
				orderBy: () => Promise.resolve([]),
				insert: () => builder,
				values: (v: unknown) => {
					insertedValues = v;
					return builder;
				},
				// biome-ignore lint/suspicious/noThenProperty: must be awaitable
				then: (resolve: () => unknown) => {
					isThenCalled = true;
					return Promise.resolve().then(resolve);
				},
			};
			vi.mocked(getDb).mockReturnValue(builder as unknown as ReturnType<typeof getDb>);

			const project = createMockProjectRecord({ id: 'proj-new' });
			await createProjectInDb(project);

			expect(insertedValues).toMatchObject({ id: 'proj-new', pmType: 'github-projects' });
			expect(isThenCalled).toBe(true);
			expect(builder).not.toHaveProperty('onConflictDoUpdate');
		});
	});

	describe('createProjectWithMemberInDb', () => {
		it('inserts project and member inside a transaction block', async () => {
			const mockTx = {
				// The repository-claim guard runs on the transaction, so the check and the
				// inserts share one snapshot.
				select: vi.fn(() => ({
					from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }),
				})),
				insert: vi.fn(() => ({
					values: vi.fn(() => Promise.resolve()),
				})),
			};
			let transactionCallback: ((tx: unknown) => Promise<unknown>) | undefined;
			vi.mocked(getDb).mockReturnValue({
				transaction: (cb: (tx: unknown) => Promise<unknown>) => {
					transactionCallback = cb;
					return cb(mockTx);
				},
			} as unknown as ReturnType<typeof getDb>);

			const project = createMockProjectRecord({ id: 'proj-atomic' });
			await createProjectWithMemberInDb(project, {
				projectId: 'proj-atomic',
				userId: 'user-owner',
				role: 'projectAdmin',
			});

			expect(transactionCallback).toBeDefined();
			expect(mockTx.insert).toHaveBeenCalledTimes(2);
		});
	});

	describe('deleteProjectFromDb', () => {
		it('issues a filtered delete against projects table', async () => {
			let deletedTable: unknown;
			let whereCall: unknown;
			const builder = {
				delete: (t: unknown) => {
					deletedTable = t;
					return builder;
				},
				where: (w: unknown) => {
					whereCall = w;
					return Promise.resolve();
				},
			};
			vi.mocked(getDb).mockReturnValue(builder as unknown as ReturnType<typeof getDb>);

			await deleteProjectFromDb('proj-delete');
			expect(deletedTable).toBe(projects);
			expect(whereCall).toBeDefined();
		});
	});
});
