/**
 * Narrowing a project record to one of its repositories (issue #684 phase 1).
 *
 * `ProjectRecord` is the authored and persisted project: the settings genuinely
 * shared across its repositories stated once, plus a `repositories` list carrying
 * what is genuinely per-repository. `ProjectConfig` is that record **scoped to one
 * entry** — the shape every runtime call site already takes, with `repo`,
 * `baseBranch`, `branchPrefix`, `branchPattern`, `autoMerge`, `reviewChecks` and
 * `reviewChecksWaitMinutes` flattened back to the top level beside the project's own
 * `scm`.
 *
 * Keeping the scoped shape identical to the pre-#684 project config is what makes
 * this a modelling change rather than a rewrite: no pipeline phase, trigger, SCM
 * provider method, worker projection, or transport slice changes. It also makes the
 * boundary honest in one direction — a scoped config carries no list at all, so
 * nothing downstream of `scopeProjectToRepository` can act on a repository other
 * than the one it was scoped to.
 *
 * Lives beside `worker-config.ts` / `project-config-slice.ts` rather than inside
 * `schema.ts`, which stays Zod-only.
 */

import {
	PROJECT_DEFAULTS,
	type ProjectConfig,
	type ProjectRecord,
	type ProjectRepository,
} from './schema.js';

/**
 * The project's default repository — its **first** entry.
 *
 * Work that names no repository of its own runs against it: a board card carries no
 * repository, so board-driven Planning and Implementation resolve here, which is
 * exactly today's behaviour for the single-repository projects phase 1 allows.
 *
 * Throws on an empty list rather than returning `undefined`: `ProjectRecordSchema`
 * requires at least one entry, so an empty list is a corrupt record (a hand-edited
 * row, a fixture built without parsing) and every caller would only rethrow.
 */
export function defaultProjectRepository(record: ProjectRecord): ProjectRepository {
	const [first] = record.repositories;
	if (!first) {
		throw new Error(
			`Project '${record.id}' declares no repositories — a project must own at least one.`,
		);
	}
	return first;
}

/** The entry naming `repo`, or `undefined` when the project does not own it. */
export function findProjectRepository(
	record: ProjectRecord,
	repo: string,
): ProjectRepository | undefined {
	return record.repositories.find((entry) => entry.repo === repo);
}

/**
 * The entry naming `repo`, or a loud error naming the project and the repositories it
 * does own — the shape `requireProjectSCMProvider` (`src/integrations/scm/registry.ts`)
 * uses, for the same reason: running a phase against a repository the project does not
 * declare is a misconfiguration, never something to fall back from.
 */
export function requireProjectRepository(record: ProjectRecord, repo: string): ProjectRepository {
	const entry = findProjectRepository(record, repo);
	if (!entry) {
		throw new Error(
			`Project '${record.id}' does not own repository '${repo}' — it owns: ` +
				`${record.repositories.map((candidate) => candidate.repo).join(', ')}.`,
		);
	}
	return entry;
}

/**
 * Narrow a record to one of its repositories. `repo` omitted scopes to the default
 * (first) entry; naming one the project does not own throws
 * ({@link requireProjectRepository}).
 *
 * `scm` comes from the **project**, and only from there (issue #727): a repository
 * declares no provider of its own, because the credentials one would need are
 * project-wide and single-provider (`ProjectRepositorySchema`, `./schema.ts`). So the
 * scoped `scm` is the record's verbatim, which is what `requireProjectSCMProvider`
 * reads. When the project states none it stays **absent** rather than becoming an
 * explicit `undefined` — the same care `rowToProjectConfig` takes for a `NULL`
 * `scm_type` (`src/db/repositories/projectsRepository.ts`), since "states no provider"
 * is a distinct case the registry lookup reports on. The entry's `autoMerge` (issue
 * #1066), its `reviewChecks` / `reviewChecksWaitMinutes` (issue #1109), its
 * `wipLimit` (issue #1185) and its `branchPattern` (issue #1241) are kept absent the
 * same way when the entry states none.
 */
export function scopeProjectToRepository(record: ProjectRecord, repo?: string): ProjectConfig {
	const { repositories: _repositories, scm, ...shared } = record;
	const entry =
		repo === undefined ? defaultProjectRepository(record) : requireProjectRepository(record, repo);
	return {
		...shared,
		repo: entry.repo,
		baseBranch: entry.baseBranch,
		branchPrefix: entry.branchPrefix,
		...(entry.branchPattern !== undefined ? { branchPattern: entry.branchPattern } : {}),
		...(entry.autoMerge !== undefined ? { autoMerge: entry.autoMerge } : {}),
		...(entry.reviewChecks !== undefined ? { reviewChecks: entry.reviewChecks } : {}),
		...(entry.reviewChecksWaitMinutes !== undefined
			? { reviewChecksWaitMinutes: entry.reviewChecksWaitMinutes }
			: {}),
		...(entry.wipLimit !== undefined ? { wipLimit: entry.wipLimit } : {}),
		...(scm ? { scm } : {}),
	};
}

/**
 * The repository's WIP limit (issue #1185) — its own `wipLimit`, or
 * `PROJECT_DEFAULTS.wipLimit` when it states none. Takes the entry or the scoped
 * config alike, since both carry the key at the top level.
 */
export function resolveWipLimit(entry: { wipLimit?: number }): number {
	return entry.wipLimit ?? PROJECT_DEFAULTS.wipLimit;
}
