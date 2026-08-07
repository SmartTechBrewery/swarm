import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import type {
	AgentsConfig,
	Credentials,
	PipelineConfig,
	ProjectPmConfig,
	WorktreeRetentionConfig,
} from '../../config/schema.js';
import { PROJECT_DEFAULTS } from '../../config/schema.js';

/**
 * One row per SWARM project — the persisted form of `ProjectConfig`
 * (`src/config/schema.ts`), which stays the source of truth for the shape
 * (ai/CODING_STANDARDS.md "Zod is the source of truth"). The jsonb columns are
 * typed with the config's own inferred types via `$type<>()` so the table and
 * the Zod schema can't drift.
 *
 * Single-user scope (ai/ARCHITECTURE.md "Single-user scope"): there is no
 * `organizations` table and no `org_id` FK — a deliberate simplification of
 * Cascade's org→project hierarchy. One row per project, one credential set per
 * persona per project.
 *
 * The `credentials` column holds only *references* (env-var keys into the
 * secret store), never the secrets themselves — those live encrypted at rest in
 * `project_credentials` (ai/CODING_STANDARDS.md "Scope credentials"; PROJECT.md
 * §6.1).
 */
export const projects = pgTable('projects', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	repo: text('repo').notNull().unique(),
	repoRoot: text('repo_root').notNull(),
	worktreeRoot: text('worktree_root').notNull().default(PROJECT_DEFAULTS.worktreeRoot),
	baseBranch: text('base_branch').notNull().default(PROJECT_DEFAULTS.baseBranch),
	branchPrefix: text('branch_prefix').notNull().default(PROJECT_DEFAULTS.branchPrefix),
	maxConcurrentJobs: integer('max_concurrent_jobs')
		.notNull()
		.default(PROJECT_DEFAULTS.maxConcurrentJobs),
	/**
	 * Discovery / open-join policy — one of `ProjectVisibilitySchema`
	 * (`src/config/schema.ts`, the source of truth for the values), stored as
	 * free `text` like `pm_type`. `private` (members only) by default;
	 * `discoverable` opts the project into the limited public-discovery read and
	 * join-request flow (#281 task 5). Never wired to execution or routing.
	 */
	visibility: text('visibility').notNull().default('private'),
	/**
	 * PM provider id — the `pm` union's discriminator (`PMType`, `src/pm/types.ts`),
	 * stored as free `text` like `visibility`. Together with `pm_config` below it is
	 * the persisted form of `ProjectConfig.pm`; the repository re-assembles the two
	 * into the union member (`src/db/repositories/projectsRepository.ts`).
	 */
	pmType: text('pm_type').notNull().default('github-projects'),
	/**
	 * The `pm_type` provider's own config — for GitHub Projects the board mapping
	 * (`githubProjectsConfigSchema`). One *generic* jsonb column keyed by `pm_type`,
	 * not a column per provider (issue #495): a second PM provider persists its own
	 * config here without a migration, and nothing in this table reads inside the
	 * blob. (The only queries that do are the two container lookups in
	 * `projectsRepository.ts` — `findProjectByBoardFromDb`, hard-coded to GitHub
	 * Projects' `projectId` key, and `findProjectByPmContainerFromDb`, which takes
	 * both the `pm_type` and the container key from the provider that owns them.)
	 */
	pmConfig: jsonb('pm_config').$type<ProjectPmConfig>().notNull(),
	credentials: jsonb('credentials').$type<Credentials>().notNull(),
	/** Per-phase agent CLI/model overrides (`AgentsConfig`) — nullable: most projects omit it entirely. */
	agents: jsonb('agents').$type<AgentsConfig>(),
	/** Per-phase autonomous board-move control (`PipelineConfig`) — nullable: most projects omit it entirely. */
	pipeline: jsonb('pipeline').$type<PipelineConfig>(),
	/** Per-project worktree retention policy (`WorktreeRetentionConfig`) — nullable: most projects omit it and use the coded default. */
	worktreeRetention: jsonb('worktree_retention').$type<WorktreeRetentionConfig>(),

	createdAt: timestamp('created_at').defaultNow(),
	updatedAt: timestamp('updated_at')
		.defaultNow()
		.$onUpdate(() => new Date()),
});
