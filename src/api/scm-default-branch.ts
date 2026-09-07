/**
 * Read a repository's default branch from the provider it lives on — the one
 * mapping from a provider id to that provider's repository read, used by the
 * dashboard's `scm.defaultBranch` procedure (`./routers/scm.ts`) to pre-fill the New
 * Project dialog's Base Branch input at creation time (issue #884).
 *
 * A sibling of `./scm-verification.ts` rather than a second function inside it: that
 * module is about verifying a **pasted secret**, this one about reading a
 * **repository** with a secret already established. Both are pre-project reads, which
 * is what they share, and neither is a resolution path.
 *
 * **One branch per provider, not one lookup generalised over the registry**
 * (ai/RULES.md §2 names this as the deliberate exception): every `SCMProvider` method
 * takes a `ProjectConfig`, and a caller pre-filling a dialog holds a secret and a
 * provider *name* but no project — the project is what it is about to create.
 *
 * Each read already flattens a failed call to `null`, so an unreachable provider, a
 * repository the credential cannot see, and a provider that names no default branch
 * are one answer: "cannot be determined". That is the outcome the caller degrades to
 * (keep the branch already in the field, and say the read failed), so it fails **open**
 * — project creation never waits on or fails because of this read. A fourth provider
 * registering without adding its branch below must read the same way, never as a wrong
 * answer.
 */

import { getBitbucketRepositoryDefaultBranch } from '../integrations/scm/bitbucket/client.js';
import { getGitHubRepositoryDefaultBranch } from '../integrations/scm/github/client.js';
import { getGitLabRepositoryDefaultBranch } from '../integrations/scm/gitlab/client.js';
import type { ScmType } from '../scm/types.js';

/**
 * The branch `providerId` reports as `repo`'s default when read with `secret`, or
 * `null` when it cannot be determined. `repo` is the `owner/repo` slug each provider
 * interprets in its own vocabulary (Bitbucket's `workspace/repo_slug`, GitLab's
 * `namespace/project`), exactly as `ProjectConfig.repo` is.
 */
export async function resolveScmDefaultBranch(
	providerId: ScmType,
	repo: string,
	secret: string,
): Promise<string | null> {
	switch (providerId) {
		case 'github':
			return await getGitHubRepositoryDefaultBranch(repo, secret);
		case 'bitbucket':
			return await getBitbucketRepositoryDefaultBranch(repo, secret);
		case 'gitlab':
			return await getGitLabRepositoryDefaultBranch(repo, secret);
		default:
			// A provider id from the closed `ScmType` list that no branch above serves —
			// unreachable today, and a fourth provider registering without adding its read
			// here must read as "cannot be determined" rather than as another provider's
			// answer.
			return null;
	}
}
