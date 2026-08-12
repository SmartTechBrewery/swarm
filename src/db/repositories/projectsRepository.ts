/**
 * Project lookups from Postgres — mirrors the read side of Cascade's
 * `src/db/repositories/projectsRepository.ts`, trimmed to SWARM's single-user
 * scope (one row per project, no org hierarchy — ai/ARCHITECTURE.md
 * "Single-user scope").
 *
 * A `projects` row is the persisted form of `ProjectRecord`; the jsonb columns
 * are already typed with the config's inferred types (`src/db/schema/projects.ts`),
 * so mapping a row back to `ProjectRecord` is a re-assembly, not a re-validation.
 * The Zod schema stays the source of truth for the shape (ai/CODING_STANDARDS.md
 * "Zod is the source of truth").
 *
 * Two read shapes come out of here since issue #684. The **record** functions
 * (`…RecordFromDb`) return the whole project including its `repositories` list, and
 * only the config-management surfaces take them. Everything else gets a
 * `ProjectConfig` already scoped to one repository, so no runtime call site can act
 * on a repository other than the one its work names.
 */

import { and, asc, eq, sql } from 'drizzle-orm';

import { scopeProjectToRepository } from '../../config/project-repository.js';
import type {
	ProjectConfig,
	ProjectPm,
	ProjectRecord,
	ProjectVisibility,
} from '../../config/schema.js';
import type { PMType } from '../../pm/types.js';
import type { ScmType } from '../../scm/types.js';
import { getDb } from '../client.js';
import { projectMembers } from '../schema/projectMembers.js';
import { projects } from '../schema/projects.js';
import type { AddMemberInput } from './projectMembersRepository.js';

type ProjectRow = typeof projects.$inferSelect;

/** Re-assemble a `ProjectRecord` from a persisted `projects` row. */
function rowToProjectRecord(row: ProjectRow): ProjectRecord {
	return {
		id: row.id,
		name: row.name,
		repositories: row.repositories,
		repoRoot: row.repoRoot,
		worktreeRoot: row.worktreeRoot,
		maxConcurrentJobs: row.maxConcurrentJobs,
		visibility: row.visibility as ProjectVisibility,
		// A `NULL` scm_type is a project that states no SCM provider, which is a
		// different thing from one that states `github` — spread it in only when the
		// column holds a value so the key stays *absent* rather than becoming an
		// explicit `undefined` (issue #478).
		...(row.scmType ? { scm: row.scmType as ScmType } : {}),
		// `pm` is persisted split — the discriminator in `pm_type`, the provider's own
		// config in the generic `pm_config` blob — so re-assembling the union member is
		// a re-join, not a re-validation (see this file's header). The cast is what
		// asserts the row's provider id and its blob belong to the same member; the
		// write side below is the only thing that ever splits them apart.
		pm: { type: row.pmType, ...row.pmConfig } as ProjectPm,
		credentials: row.credentials,
		agents: row.agents ?? undefined,
		pipeline: row.pipeline ?? undefined,
		worktreeRetention: row.worktreeRetention ?? undefined,
	};
}

/**
 * Re-assemble a row and scope it to one of its repositories — `repo` omitted scopes
 * to the project's default (first) entry.
 *
 * Board-driven and project-scoped work has no repository of its own to name, so it
 * runs against the default entry, which is exactly today's behaviour while a project
 * owns exactly one. Issue #684 phase 2 is where a caller that *does* know its
 * repository (a job carrying one) passes it.
 */
function rowToProjectConfig(row: ProjectRow, repo?: string): ProjectConfig {
	return scopeProjectToRepository(rowToProjectRecord(row), repo);
}

/** Flatten a `ProjectRecord` into the columns needed for insertion/upsertion. */
function projectRecordToRow(record: ProjectRecord) {
	// Split the `pm` union member back into its two columns — the discriminator and
	// the provider's opaque config. The counterpart of the re-join in
	// `rowToProjectRecord`.
	const { type: pmType, ...pmConfig } = record.pm;
	return {
		id: record.id,
		name: record.name,
		repositories: record.repositories,
		repoRoot: record.repoRoot,
		worktreeRoot: record.worktreeRoot,
		maxConcurrentJobs: record.maxConcurrentJobs,
		visibility: record.visibility,
		// `null`, not `'github'`, when the project states no provider — see the
		// `scm_type` column comment (`src/db/schema/projects.ts`).
		scmType: record.scm ?? null,
		pmType,
		pmConfig,
		credentials: record.credentials,
		agents: record.agents ?? null,
		pipeline: record.pipeline ?? null,
		worktreeRetention: record.worktreeRetention ?? null,
	};
}

/**
 * A write refused because one of its repositories is already owned by a different
 * project — the replacement for the `projects.repo` UNIQUE constraint the repository
 * list dissolved (issue #684).
 *
 * Its own class rather than a raw `Error` so the API layer can map it to the same
 * `CONFLICT` a unique violation produces without string-matching a message.
 */
export class ProjectRepositoryConflictError extends Error {
	constructor(
		readonly repo: string,
		readonly ownerProjectId: string,
	) {
		super(`Repository '${repo}' already belongs to project '${ownerProjectId}'.`);
		this.name = 'ProjectRepositoryConflictError';
	}
}

/**
 * Refuse a write that would give a repository to two projects.
 *
 * Unlike the index it replaces this is a check-then-write, so two *concurrent*
 * creates naming the same repository can both pass. That is an accepted trade-off:
 * creating a project is an operator action rather than a hot path, and the read side
 * stays deterministic regardless — `findProjectByRepoFromDb` orders by `id`, so it
 * never resolves arbitrarily even if a duplicate did land.
 *
 * Runs on `tx` when given, so the create-with-member transaction checks and inserts
 * under the same snapshot.
 */
async function assertRepositoriesUnclaimed(
	record: ProjectRecord,
	tx: Pick<ReturnType<typeof getDb>, 'select'> = getDb(),
): Promise<void> {
	for (const entry of record.repositories) {
		const rows = await tx
			.select({ id: projects.id })
			.from(projects)
			.where(repositoryContains(entry.repo))
			.orderBy(asc(projects.id));
		const owner = rows.find((row) => row.id !== record.id);
		if (owner) throw new ProjectRepositoryConflictError(entry.repo, owner.id);
	}
}

/**
 * `repositories` holds an entry naming `repo` — jsonb containment against the whole
 * list, so it matches *any* entry rather than only the first. Written generally now
 * even though the phase-1 cap makes it equivalent to "the only entry", so phase 2
 * changes nothing here.
 *
 * The repo is bound as a parameter and cast to `jsonb`, never interpolated into the
 * predicate.
 */
function repositoryContains(repo: string) {
	return sql`${projects.repositories} @> ${JSON.stringify([{ repo }])}::jsonb`;
}

/**
 * Resolve a project by one of its repositories (`owner/repo`), scoped to the
 * **matched** entry — so a webhook from repository B runs against repository B's
 * settings. Returns `undefined` when no project owns that repo — a webhook for an
 * unknown repo isn't an error, it just isn't ours (ai/CODING_STANDARDS.md "Error
 * handling").
 *
 * `ORDER BY id` is load-bearing: with the `repo UNIQUE` index gone
 * (`assertRepositoriesUnclaimed` is its replacement) the result must not depend on
 * heap order.
 */
export async function findProjectByRepoFromDb(repo: string): Promise<ProjectConfig | undefined> {
	const rows = await getDb()
		.select()
		.from(projects)
		.where(repositoryContains(repo))
		.orderBy(asc(projects.id))
		.limit(1);
	const row = rows[0];
	return row ? rowToProjectConfig(row, repo) : undefined;
}

/**
 * Resolve a project by its GitHub Projects (v2) board node ID
 * (`pm.projectId`, e.g. `PVT_kwHOAC3TF84BcNwD`). This is the PM-side analogue of
 * {@link findProjectByRepoFromDb}: a `projects_v2_item` webhook carries the board
 * node ID, not a repo, so the board mapping is how its SWARM project is found.
 * Returns `undefined` for an untracked board — not our board isn't an error
 * (ai/CODING_STANDARDS.md "Error handling").
 *
 * Matches inside the generic jsonb `pm_config` column via its `projectId` key.
 * That key is **provider-specific** — it is only meaningful for a row whose
 * `pm_type` is `github-projects`, since another provider's config names its
 * container differently — so this lookup is deliberately GitHub-Projects-shaped
 * and only its router adapter calls it. That is why a second provider resolving a
 * project from a board event does *not* share this predicate: it goes through
 * {@link findProjectByPmContainerFromDb}, which takes the `pm_type` and the
 * container key as parameters (issue #529). This one stays exactly as it is —
 * GitHub Projects keeps resolving through it.
 */
export async function findProjectByBoardFromDb(
	projectNodeId: string,
): Promise<ProjectConfig | undefined> {
	const rows = await getDb()
		.select()
		.from(projects)
		.where(sql`${projects.pmConfig}->>'projectId' = ${projectNodeId}`)
		.limit(1);
	const row = rows[0];
	return row ? rowToProjectConfig(row) : undefined;
}

/**
 * Resolve a project by the container id a PM provider's board event carries,
 * parameterised by *that provider*: its `pm_type` discriminator plus the key its
 * own `pm_config` blob names the container with (issue #529). The
 * provider-agnostic form of {@link findProjectByBoardFromDb}, and the shape that
 * function's own comment anticipated — a second provider resolving a project from
 * a board event gets its own lookup rather than sharing a GitHub-shaped predicate.
 *
 * The `pm_type` filter is what makes it safe for two providers to name their
 * container with the same key: a Linear team id looked up as
 * `(linear, 'teamId', …)` can never match a row persisted for another provider,
 * even if that provider's blob happens to carry a `teamId` too. Returns
 * `undefined` for an untracked container — not our board isn't an error
 * (ai/CODING_STANDARDS.md "Error handling").
 *
 * `pmType` is the contract's {@link PMType}, not a free string: a typo would
 * otherwise compile and simply match no row, which reads downstream as "board not
 * tracked" and silently drops every one of that provider's webhooks. `configKey`
 * *is* a free string — only the provider knows which of its own keys names the
 * container — and it is bound as a parameter (never interpolated), cast to `text`
 * so Postgres resolves `jsonb ->> text` rather than weighing it against the
 * `jsonb ->> integer` overload.
 */
export async function findProjectByPmContainerFromDb(
	pmType: PMType,
	configKey: string,
	containerId: string,
): Promise<ProjectConfig | undefined> {
	const rows = await getDb()
		.select()
		.from(projects)
		.where(
			and(
				eq(projects.pmType, pmType),
				sql`${projects.pmConfig}->>${configKey}::text = ${containerId}`,
			),
		)
		.limit(1);
	const row = rows[0];
	return row ? rowToProjectConfig(row) : undefined;
}

/**
 * Resolve a project by its stable internal id, scoped to its **default** repository.
 * Returns `undefined` if unknown. Issue #684 phase 2 is where a caller that knows
 * which repository its work belongs to passes it.
 */
export async function findProjectByIdFromDb(id: string): Promise<ProjectConfig | undefined> {
	const rows = await getDb().select().from(projects).where(eq(projects.id, id)).limit(1);
	const row = rows[0];
	return row ? rowToProjectConfig(row) : undefined;
}

/**
 * Resolve a whole project **record** — its repository list included — by id. The
 * config-management read: the projects API serves it so an operator edits the list
 * itself, where every runtime caller takes {@link findProjectByIdFromDb}'s scoped
 * view instead.
 */
export async function findProjectRecordByIdFromDb(id: string): Promise<ProjectRecord | undefined> {
	const rows = await getDb().select().from(projects).where(eq(projects.id, id)).limit(1);
	const row = rows[0];
	return row ? rowToProjectRecord(row) : undefined;
}

/**
 * Upsert a project row from its `ProjectRecord` — the write side of the
 * config-file → DB loader (`swarm config apply`). Keyed on `id`, so re-applying
 * an edited `swarm.config.json` updates the existing row in place rather than
 * inserting a duplicate; the loader is idempotent by design.
 *
 * Refuses a record claiming a repository another project already owns
 * ({@link assertRepositoriesUnclaimed}) — the guard standing in for the `repo`
 * UNIQUE constraint the repository list dissolved.
 *
 * The `credentials` block is persisted as-is — it holds only *references*
 * (env-var keys), never the secrets themselves. The secret values are written
 * separately into `project_credentials` (see `credentialsRepository`).
 */
export async function upsertProjectToDb(record: ProjectRecord): Promise<void> {
	await assertRepositoriesUnclaimed(record);
	const values = projectRecordToRow(record);
	const { id: _id, ...updateValues } = values;
	await getDb()
		.insert(projects)
		.values(values)
		.onConflictDoUpdate({
			target: projects.id,
			set: { ...updateValues, updatedAt: new Date() },
		});
}

/**
 * Create a new project row in the DB.
 * Unlike `upsertProjectToDb`, this rejects with a unique constraint violation if the ID already exists.
 */
export async function createProjectInDb(record: ProjectRecord): Promise<void> {
	await assertRepositoriesUnclaimed(record);
	const values = projectRecordToRow(record);
	await getDb().insert(projects).values(values);
}

/**
 * Create a new project row and insert the creator's owner membership atomically in one database transaction.
 * If either insert fails, the whole transaction rolls back so a failed membership insert never leaves an unowned project row.
 */
export async function createProjectWithMemberInDb(
	record: ProjectRecord,
	member: AddMemberInput,
): Promise<void> {
	const values = projectRecordToRow(record);
	await getDb().transaction(async (tx) => {
		// Inside the transaction, so the check and the insert see one snapshot.
		await assertRepositoriesUnclaimed(record, tx);
		await tx.insert(projects).values(values);
		await tx.insert(projectMembers).values({
			projectId: member.projectId,
			userId: member.userId,
			role: member.role,
		});
	});
}

/**
 * Delete a project from the DB by its ID.
 * Because of the `ON DELETE CASCADE` foreign key on `project_credentials.project_id`,
 * this will also automatically delete all related credentials.
 */
export async function deleteProjectFromDb(id: string): Promise<void> {
	await getDb().delete(projects).where(eq(projects.id, id));
}

/**
 * List all projects in the DB, ordered by name, each scoped to its **default**
 * repository. Issue #684 phase 2 is where a caller that knows its repository passes
 * one.
 */
export async function listAllProjectsFromDb(): Promise<ProjectConfig[]> {
	const rows = await getDb().select().from(projects).orderBy(asc(projects.name));
	return rows.map((row) => rowToProjectConfig(row));
}

/**
 * List every project as a whole **record**, repository list included, ordered by
 * name — the config-management twin of {@link listAllProjectsFromDb}, served by the
 * projects API.
 */
export async function listAllProjectRecordsFromDb(): Promise<ProjectRecord[]> {
	const rows = await getDb().select().from(projects).orderBy(asc(projects.name));
	return rows.map(rowToProjectRecord);
}

/**
 * The limited public-discovery view of a project (#281 task 5): the *only*
 * fields exposed to a non-member of a `discoverable` project. Deliberately just
 * `id` and `name` — never credentials, config, repo, board mapping, or run
 * internals — so discovery reveals that a project exists and what it is called
 * without leaking anything a full member sees.
 */
export interface DiscoverableProject {
	id: string;
	name: string;
}

/**
 * List the limited-view (`id` + `name` only) of every `discoverable` project,
 * ordered by name. The projection is applied in the query itself, so a
 * project's credentials/config never even leave the DB — the caller can't
 * accidentally forward a field the discovery view must not expose. Filtering
 * out the caller's already-accessible projects is the router's job (#281 task 5).
 */
export async function listDiscoverableProjectsFromDb(): Promise<DiscoverableProject[]> {
	return getDb()
		.select({ id: projects.id, name: projects.name })
		.from(projects)
		.where(eq(projects.visibility, 'discoverable'))
		.orderBy(asc(projects.name));
}

export { findProjectByIdFromDb as getProjectByIdFromDb };
