/**
 * How a pull request description closes the work item it delivers, per SCM
 * provider (issue #1277) — or `undefined` where the provider has no closing keyword
 * SWARM can rely on.
 *
 * Only GitHub closes an issue from a pull request description SWARM writes: an issue
 * in the same repository, referenced as `Closes: #<n>`, closes when the pull request
 * merges into the default branch. Everything else gets a plain link to the work item
 * instead (`src/pipeline/pull-request-description.ts`).
 *
 * Data keyed by `ScmType` rather than an `scm === 'github'` branch in shared code
 * (ai/RULES.md §2), exactly as `SCM_REPO_COORDINATES` (`./repo-coordinates.ts`). Like
 * `./types.ts` it imports nothing at runtime. A fifth provider adds one entry.
 */

import type { ScmType } from './types.js';

export const SCM_CLOSING_REFERENCE: Record<ScmType, ((number: string) => string) | undefined> = {
	github: (number) => `Closes: #${number}`,
	bitbucket: undefined,
	gitlab: undefined,
	'azure-devops': undefined,
};
