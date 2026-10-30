/**
 * Verify a pasted SCM secret against the provider it claims to authenticate to —
 * the one mapping from a provider id to that provider's identity lookup, shared by
 * the dashboard's `scm.verify…` procedures (`./routers/scm.ts`, which validate a
 * secret *before* it is stored) and by `workers.scmCredentials.set`
 * (`./routers/workerScmCredentials.ts`, which validates one *as* it is stored,
 * issue #766).
 *
 * Extracted so the mapping exists once: a second copy is exactly the drift a fifth
 * provider would hit, since only one of the two call sites would be updated.
 *
 * **One branch per provider, not one lookup generalised over the registry**
 * (ai/RULES.md §2 names this as the deliberate exception): every `SCMProvider`
 * identity method takes a `ProjectConfig`, and a caller holding a pasted secret has
 * no project to resolve one from.
 *
 * **Azure DevOps needs a repository as well as the secret** (issue #1089 phase 6/6):
 * its identity endpoint is organization-scoped (`getAzureDevOpsUserForToken`), and a
 * PAT is scoped to one organization by default, so a bare secret identifies no
 * account. The caller passes a repository the secret is meant to reach and the
 * organization is read off it; the other providers ignore it. Without one, an Azure
 * DevOps secret is reported as `unscoped` (issue #1220) — never as verified, and
 * never as invalid either, since it was never sent anywhere to be checked.
 *
 * Each lookup already swallows a failed call to `null`, so an unreachable provider
 * is reported as an invalid credential rather than as an inconclusive check. That is
 * the behaviour the `scm.verify…` procedures have always had, and it fails closed,
 * which is the right side to err on for a write.
 */

import { getAzureDevOpsUserForToken } from '../integrations/scm/azure-devops/client.js';
import { getBitbucketUserForCredential } from '../integrations/scm/bitbucket/client.js';
import { getGitHubUserForToken } from '../integrations/scm/github/client.js';
import { getGitLabUserForToken } from '../integrations/scm/gitlab/client.js';
import { repoCoordinatesIssue } from '../scm/repo-coordinates.js';
import type { ScmType } from '../scm/types.js';

/**
 * The account a secret resolved to, or the bare fact that it resolved to none. The
 * login is the same namespace each provider's persona identities and loop prevention
 * compare in, so a verified value is one an operator can check against the account
 * they intended.
 *
 * `reason: 'unscoped'` is the third outcome (issue #1220): the secret was never
 * checked, because the provider verifies it within a scope (Azure DevOps: an
 * organization) the caller named no repository for. A caller must not report that
 * as an invalid credential.
 */
export type ScmCredentialVerification =
	| { valid: true; login: string }
	| { valid: false }
	| { valid: false; reason: 'unscoped' };

/**
 * Resolve `secret` to an account on `providerId`, or report it as invalid. `repo` is a
 * repository on that provider the secret is meant to reach (`ProjectConfig.repo`'s
 * shape); only a provider whose identity is scoped below the account reads it.
 */
export async function verifyScmCredentialSecret(
	providerId: ScmType,
	secret: string,
	repo?: string,
): Promise<ScmCredentialVerification> {
	switch (providerId) {
		case 'github':
			return fromLogin(await getGitHubUserForToken(secret));
		case 'bitbucket':
			return fromLogin(await getBitbucketUserForCredential(secret));
		case 'gitlab':
			return fromLogin(await getGitLabUserForToken(secret));
		case 'azure-devops': {
			// No repository, or one not in Azure's three-segment shape, names no
			// organization to resolve the PAT in — so it is not sent anywhere.
			if (!repo || repoCoordinatesIssue('azure-devops', repo) !== null) {
				return { valid: false, reason: 'unscoped' };
			}
			return fromLogin(await getAzureDevOpsUserForToken(secret, repo.split('/')[0] as string));
		}
		default:
			// A provider id from the closed `ScmType` list that no branch above serves —
			// unreachable today, and a fifth provider registering without adding its
			// lookup here must read as "cannot be verified" rather than as verified.
			return { valid: false };
	}
}

function fromLogin(login: string | null): ScmCredentialVerification {
	return login ? { valid: true, login } : { valid: false };
}
