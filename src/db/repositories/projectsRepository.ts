/**
 * Project lookups from Postgres — mirrors the read side of Cascade's
 * `src/db/repositories/projectsRepository.ts`, trimmed to SWARM's single-user
 * scope (one row per project, no org hierarchy — ai/ARCHITECTURE.md
 * "Single-user scope").
 *
 * A `projects` row is the persisted form of `ProjectConfig`; the jsonb columns
 * are already typed with the config's inferred types (`src/db/schema/projects.ts`),
 * so mapping a row back to `ProjectConfig` is a re-assembly, not a re-validation.
 * The Zod schema stays the source of truth for the shape (ai/CODING_STANDARDS.md
 * "Zod is the source of truth").
 */

import { asc, eq, sql } from 'drizzle-orm';

import type { ProjectConfig, ProjectPm, ProjectVisibility } from '../../config/schema.js';
import { getDb } from '../client.js';
import { projectMembers } from '../schema/projectMembers.js';
import { projects } from '../schema/projects.js';
import type { AddMemberInput } from './projectMembersRepository.js';

type ProjectRow = typeof projects.$inferSelect;

/** Re-assemble a `ProjectConfig` from a persisted `projects` row. */
function rowToProjectConfig(row: ProjectRow): ProjectConfig {
	return {
		id: row.id,
		name: row.name,
		repo: row.repo,
		repoRoot: row.repoRoot,
		worktreeRoot: row.worktreeRoot,
		baseBranch: row.baseBranch,
		branchPrefix: row.branchPrefix,
		maxConcurrentJobs: row.maxConcurrentJobs,
		visibility: row.visibility as ProjectVisibility,
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

/** Flatten a `ProjectConfig` into the columns needed for insertion/upsertion. */
function projectConfigToRow(config: ProjectConfig) {
	// Split the `pm` union member back into its two columns — the discriminator and
	// the provider's opaque config. The counterpart of the re-join in
	// `rowToProjectConfig`.
	const { type: pmType, ...pmConfig } = config.pm;
	return {
		id: config.id,
		name: config.name,
		repo: config.repo,
		repoRoot: config.repoRoot,
		worktreeRoot: config.worktreeRoot,
		baseBranch: config.baseBranch,
		branchPrefix: config.branchPrefix,
		maxConcurrentJobs: config.maxConcurrentJobs,
		visibility: config.visibility,
		pmType,
		pmConfig,
		credentials: config.credentials,
		agents: config.agents ?? null,
		pipeline: config.pipeline ?? null,
		worktreeRetention: config.worktreeRetention ?? null,
	};
}

/**
 * Resolve a project by its GitHub repository (`owner/repo`). Returns `undefined`
 * when no project owns that repo — a webhook for an unknown repo isn't an error,
 * it just isn't ours (ai/CODING_STANDARDS.md "Error handling").
 */
export async function findProjectByRepoFromDb(repo: string): Promise<ProjectConfig | undefined> {
	const rows = await getDb().select().from(projects).where(eq(projects.repo, repo)).limit(1);
	const row = rows[0];
	return row ? rowToProjectConfig(row) : undefined;
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
 * and only its router adapter calls it. A second provider resolving a project
 * from a board event gets its own lookup (or this one grows a `pm_type` filter
 * and a per-provider key), rather than sharing this predicate.
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

/** Resolve a project by its stable internal id. Returns `undefined` if unknown. */
export async function findProjectByIdFromDb(id: string): Promise<ProjectConfig | undefined> {
	const rows = await getDb().select().from(projects).where(eq(projects.id, id)).limit(1);
	const row = rows[0];
	return row ? rowToProjectConfig(row) : undefined;
}

/**
 * Upsert a project row from its `ProjectConfig` — the write side of the
 * config-file → DB loader (`swarm config apply`). Keyed on `id`, so re-applying
 * an edited `swarm.config.json` updates the existing row in place rather than
 * inserting a duplicate; the loader is idempotent by design.
 *
 * The `credentials` block is persisted as-is — it holds only *references*
 * (env-var keys), never the secrets themselves. The secret values are written
 * separately into `project_credentials` (see `credentialsRepository`).
 */
export async function upsertProjectToDb(config: ProjectConfig): Promise<void> {
	const values = projectConfigToRow(config);
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
export async function createProjectInDb(config: ProjectConfig): Promise<void> {
	const values = projectConfigToRow(config);
	await getDb().insert(projects).values(values);
}

/**
 * Create a new project row and insert the creator's owner membership atomically in one database transaction.
 * If either insert fails, the whole transaction rolls back so a failed membership insert never leaves an unowned project row.
 */
export async function createProjectWithMemberInDb(
	config: ProjectConfig,
	member: AddMemberInput,
): Promise<void> {
	const values = projectConfigToRow(config);
	await getDb().transaction(async (tx) => {
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
 * List all projects in the DB, ordered by name.
 */
export async function listAllProjectsFromDb(): Promise<ProjectConfig[]> {
	const rows = await getDb().select().from(projects).orderBy(asc(projects.name));
	return rows.map(rowToProjectConfig);
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
