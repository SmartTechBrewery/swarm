/**
 * How each SCM provider addresses a repository — the shape `ProjectConfig.repo` must
 * take on that provider (issue #1089 phase 1).
 *
 * Every provider SWARM ran on before Azure DevOps addressed a repository by two
 * segments (`owner/repo`, a Bitbucket `workspace/repo_slug`, a GitLab
 * `namespace/project`). Azure Repos addresses one by three — organization, project,
 * repository — and `repo` holds exactly that for an Azure DevOps project: the clone
 * URL's path minus Azure's `_git` decoration. So the segment count depends on the
 * provider, and widening the shared regex alone would let a GitHub project carry a
 * third segment its client silently drops, or a GitLab project a subgroup path its
 * own provider declares unsupported.
 *
 * The count is **data keyed by `ScmType`**, here, for the same reasons as
 * `SCM_OPERATOR_CREDENTIAL_COPY` (`./operator-credential-copy.ts`):
 *
 * - not on the SCM manifest, because config validation must not depend on which
 *   provider modules a process imported (the `scm` field doc in
 *   `src/config/schema.ts` states the rule) — a dashboard bundle, a focused unit test
 *   and the DB-free worker all parse configs without the registry;
 * - not as an `scm === 'azure-devops'` branch in the schema, which would be a
 *   provider branch in shared code (ai/RULES.md §2).
 *
 * Like `./types.ts` it imports nothing at runtime. A fifth provider adds one entry.
 */

import type { ScmType } from './types.js';

export interface ScmRepoCoordinates {
	/** How many `/`-separated segments a repository on this provider has. */
	segments: 2 | 3;
	/** The provider's own names for those segments, for an operator-facing message. */
	format: string;
}

export const SCM_REPO_COORDINATES: Record<ScmType, ScmRepoCoordinates> = {
	github: { segments: 2, format: 'owner/repo' },
	bitbucket: { segments: 2, format: 'workspace/repo_slug' },
	// No subgroup paths: GitLab support is two-segment by its own scope decision.
	gitlab: { segments: 2, format: 'namespace/project' },
	'azure-devops': { segments: 3, format: 'organization/project/repository' },
};

/**
 * Why `repo` does not fit the provider `scm` names, as one operator-facing sentence, or
 * `null` when it does. An absent `scm` expects two segments — the shape of every
 * project written before that field existed.
 */
export function repoCoordinatesIssue(scm: ScmType | undefined, repo: string): string | null {
	const segments = repo.split('/').length;
	const expected = scm ? SCM_REPO_COORDINATES[scm] : SCM_REPO_COORDINATES.github;
	if (segments === expected.segments) return null;
	const provider = scm ? `SCM provider '${scm}'` : 'a project that names no SCM provider';
	return (
		`Repository '${repo}' has ${segments} segments, but ${provider} expects ` +
		`${expected.segments}: "${expected.format}"`
	);
}
