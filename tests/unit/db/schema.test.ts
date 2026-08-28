import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
	projectCredentials,
	projects,
	reviewVerdicts,
	runLogs,
	runs,
	users,
	workerScmCredentials,
	workers,
} from '@/db/schema/index.js';

// These tests pin the persisted shape to SWARM's config model (src/config/schema.ts)
// and single-user scope (ai/ARCHITECTURE.md) without needing a live Postgres.
describe('db schema', () => {
	describe('projects', () => {
		const table = getTableConfig(projects);
		const columns = new Map(table.columns.map((c) => [c.name, c]));

		it('is named "projects"', () => {
			expect(table.name).toBe('projects');
		});

		it('persists every ProjectRecord field', () => {
			for (const name of [
				'id',
				'name',
				'repositories',
				'repo_root',
				'worktree_root',
				'scm_type',
				'pm_type',
				'pm_config',
				'credentials',
			]) {
				expect(columns.has(name), `missing column ${name}`).toBe(true);
			}
		});

		// Issue #684: the three per-repository columns became entries of one jsonb list,
		// so a project can eventually own more than one repository without a column per
		// repository. NOT NULL because every project owns at least one.
		it('holds the repository list in a NOT NULL jsonb column, not three text columns', () => {
			expect(columns.get('repositories')?.getSQLType()).toBe('jsonb');
			expect(columns.get('repositories')?.notNull).toBe(true);
			for (const gone of ['repo', 'base_branch', 'branch_prefix']) {
				expect(columns.has(gone), `column ${gone} should be gone`).toBe(false);
			}
		});

		// NULL is "this project states no SCM provider", which resolves to the sole
		// runtime-ready one (issue #478). A NOT NULL default of 'github' would turn every
		// existing row into a project that *states* GitHub and hide the loud "set scm"
		// error a second runtime-ready provider is supposed to raise.
		it('leaves scm_type nullable with no default, so an unstated provider stays unstated', () => {
			expect(columns.get('scm_type')?.notNull).toBe(false);
			expect(columns.get('scm_type')?.default).toBeUndefined();
		});

		it('has no org_id — single-user scope, no organizations table', () => {
			expect(columns.has('org_id')).toBe(false);
		});

		it('stores structured config (pm_config, credentials) as jsonb', () => {
			expect(columns.get('pm_config')?.getSQLType()).toBe('jsonb');
			expect(columns.get('credentials')?.getSQLType()).toBe('jsonb');
			expect(columns.get('pm_config')?.notNull).toBe(true);
			expect(columns.get('credentials')?.notNull).toBe(true);
		});

		it('keys on id', () => {
			expect(columns.get('id')?.primary).toBe(true);
		});

		it('applies the PROJECT_DEFAULTS as column defaults', () => {
			expect(columns.get('worktree_root')?.default).toBe('.swarm-workspaces');
			expect(columns.get('max_concurrent_jobs')?.default).toBe(1);
		});
	});

	describe('project_credentials', () => {
		const table = getTableConfig(projectCredentials);
		const columns = new Map(table.columns.map((c) => [c.name, c]));

		it('is named "project_credentials"', () => {
			expect(table.name).toBe('project_credentials');
		});

		it('maps an env-var key to a required secret value', () => {
			expect(columns.get('env_var_key')?.notNull).toBe(true);
			expect(columns.get('value')?.notNull).toBe(true);
		});

		it('cascades from the owning project', () => {
			const fk = table.foreignKeys[0];
			expect(fk).toBeDefined();
			const ref = fk.reference();
			expect(ref.foreignTable).toBe(projects);
			expect(fk.onDelete).toBe('cascade');
		});

		it('enforces one value per (project, env-var key)', () => {
			const unique = table.indexes.find((i) => i.config.unique);
			expect(unique).toBeDefined();
			expect(unique?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
				'project_id',
				'env_var_key',
			]);
		});
	});

	describe('runs', () => {
		const table = getTableConfig(runs);
		const columns = new Map(table.columns.map((c) => [c.name, c]));

		it('is named "runs"', () => {
			expect(table.name).toBe('runs');
		});

		it('records every column of an agent-run lifecycle', () => {
			for (const name of [
				'id',
				'project_id',
				'repository',
				'task_id',
				'work_item_id',
				'pr_number',
				'phase',
				'engine',
				'model',
				'status',
				'exit_code',
				'timed_out',
				'error',
				'started_at',
				'completed_at',
				'duration_ms',
			]) {
				expect(columns.has(name), `missing column ${name}`).toBe(true);
			}
		});

		it('keys on id and starts a run as "running"', () => {
			expect(columns.get('id')?.primary).toBe(true);
			expect(columns.get('status')?.notNull).toBe(true);
			expect(columns.get('status')?.default).toBe('running');
		});

		it('defaults timed_out to false and requires it', () => {
			expect(columns.get('timed_out')?.notNull).toBe(true);
			expect(columns.get('timed_out')?.default).toBe(false);
		});

		it('stores pr_number as text (GitHub PR numbers stay stringly-typed)', () => {
			expect(columns.get('pr_number')?.getSQLType()).toBe('text');
		});

		it('stamps started_at automatically but leaves completed_at open', () => {
			expect(columns.get('started_at')?.notNull).toBe(true);
			expect(columns.get('completed_at')?.notNull).toBe(false);
		});

		it('cascades from the owning project', () => {
			const fk = table.foreignKeys[0];
			expect(fk).toBeDefined();
			expect(fk.reference().foreignTable).toBe(projects);
			expect(fk.onDelete).toBe('cascade');
		});

		it('indexes project_id, status, and started_at for the runs list', () => {
			const names = table.indexes.map((i) => i.config.name);
			expect(names).toContain('idx_runs_project_id');
			expect(names).toContain('idx_runs_status');
			expect(names).toContain('idx_runs_started_at');
		});

		it('requires the repository the run acted on (issue #683)', () => {
			// NOT NULL rather than nullable-for-back-compat: migration 0047 backfills
			// every existing row from its project before adding the constraint, which is
			// total because `project_id` is NOT NULL with an FK and `projects.repo` is
			// NOT NULL. Unlike `projects.scm_type`, "no repository" is not a state.
			expect(columns.get('repository')?.getSQLType()).toBe('text');
			expect(columns.get('repository')?.notNull).toBe(true);
		});

		it('carries a nullable review safety-cap slot and automation outcome (issue #235)', () => {
			expect(columns.get('review_ordinal')?.getSQLType()).toBe('integer');
			expect(columns.get('review_ordinal')?.notNull).toBe(false);
			expect(columns.get('review_automation_outcome')?.getSQLType()).toBe('text');
			expect(columns.get('review_automation_outcome')?.notNull).toBe(false);
		});

		it('carries a nullable review merge-automation outcome, message, attempt, and approved head (issue #278)', () => {
			expect(columns.get('review_merge_outcome')?.getSQLType()).toBe('text');
			expect(columns.get('review_merge_outcome')?.notNull).toBe(false);
			expect(columns.get('review_merge_message')?.getSQLType()).toBe('text');
			expect(columns.get('review_merge_message')?.notNull).toBe(false);
			expect(columns.get('review_merge_attempt')?.getSQLType()).toBe('integer');
			expect(columns.get('review_merge_attempt')?.notNull).toBe(false);
			expect(columns.get('review_merge_approved_head_sha')?.getSQLType()).toBe('text');
			expect(columns.get('review_merge_approved_head_sha')?.notNull).toBe(false);
		});

		it('carries the nullable worker→PR attribution columns (issue #398)', () => {
			expect(columns.get('worker_user_id')?.getSQLType()).toBe('uuid');
			expect(columns.get('worker_user_id')?.notNull).toBe(false);
			expect(columns.get('produced_pr_url')?.getSQLType()).toBe('text');
			expect(columns.get('produced_pr_url')?.notNull).toBe(false);
		});

		it('keeps the run row when its attribution user is removed', () => {
			const fk = table.foreignKeys.find((f) => f.reference().foreignTable === users);
			expect(fk).toBeDefined();
			expect(fk?.onDelete).toBe('set null');
		});
	});

	describe('review_verdicts', () => {
		const table = getTableConfig(reviewVerdicts);
		const columns = new Map(table.columns.map((c) => [c.name, c]));

		it('is named "review_verdicts"', () => {
			expect(table.name).toBe('review_verdicts');
		});

		it('records the natural key, slot ordinal, state, verdict, and review id', () => {
			for (const name of [
				'id',
				'project_id',
				'repository',
				'pr_number',
				'head_sha',
				'ordinal',
				'state',
				'verdict',
				'review_id',
				'reserved_at',
				'submitted_at',
			]) {
				expect(columns.has(name), `missing column ${name}`).toBe(true);
			}
		});

		it('keys on id and starts a reservation as "pending"', () => {
			expect(columns.get('id')?.primary).toBe(true);
			expect(columns.get('state')?.notNull).toBe(true);
			expect(columns.get('state')?.default).toBe('pending');
		});

		it('cascades from the owning project', () => {
			const fk = table.foreignKeys[0];
			expect(fk).toBeDefined();
			expect(fk.reference().foreignTable).toBe(projects);
			expect(fk.onDelete).toBe('cascade');
		});

		it('enforces one record per PR/head and indexes PR and review-id lookups', () => {
			const unique = table.indexes.find((i) => i.config.unique);
			expect(unique).toBeDefined();
			expect(unique?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
				'project_id',
				'repository',
				'pr_number',
				'head_sha',
			]);
			const names = table.indexes.map((i) => i.config.name);
			expect(names).toContain('idx_review_verdicts_pr');
			expect(names).toContain('idx_review_verdicts_review_id');
		});
	});

	describe('run_logs', () => {
		const table = getTableConfig(runLogs);
		const columns = new Map(table.columns.map((c) => [c.name, c]));

		it('is named "run_logs"', () => {
			expect(table.name).toBe('run_logs');
		});

		it('holds one nullable stdout/stderr blob per run', () => {
			expect(columns.get('run_id')?.notNull).toBe(true);
			expect(columns.get('run_id')?.isUnique).toBe(true);
			expect(columns.get('stdout')?.getSQLType()).toBe('text');
			expect(columns.get('stderr')?.getSQLType()).toBe('text');
			expect(columns.get('stdout')?.notNull).toBe(false);
			expect(columns.get('stderr')?.notNull).toBe(false);
		});

		it('cascades from the owning run', () => {
			const fk = table.foreignKeys[0];
			expect(fk).toBeDefined();
			expect(fk.reference().foreignTable).toBe(runs);
			expect(fk.onDelete).toBe('cascade');
		});
	});

	describe('worker_scm_credentials', () => {
		const table = getTableConfig(workerScmCredentials);
		const columns = new Map(table.columns.map((c) => [c.name, c]));

		it('is named "worker_scm_credentials"', () => {
			expect(table.name).toBe('worker_scm_credentials');
		});

		it('holds one required secret value per worker + SCM provider', () => {
			expect(columns.get('worker_id')?.notNull).toBe(true);
			expect(columns.get('scm_provider_id')?.notNull).toBe(true);
			expect(columns.get('value')?.notNull).toBe(true);
			// `text`, not a pg enum: `ScmProviderIdSchema` is the value list's source of
			// truth and a fourth provider must not need a migration.
			expect(columns.get('scm_provider_id')?.getSQLType()).toBe('text');
		});

		it('cascades from the owning worker, so a deregistered one keeps no secrets', () => {
			const fk = table.foreignKeys[0];
			expect(fk).toBeDefined();
			expect(fk.reference().foreignTable).toBe(workers);
			expect(fk.onDelete).toBe('cascade');
		});

		it('enforces one credential per (worker, SCM provider) — the rotation upsert target', () => {
			const unique = table.indexes.find((i) => i.config.unique);
			expect(unique).toBeDefined();
			expect(unique?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
				'worker_id',
				'scm_provider_id',
			]);
		});
	});
});
