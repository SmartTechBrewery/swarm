/**
 * Verify a pasted SCM secret against the provider it claims to authenticate to —
 * the one mapping from a provider id to that provider's identity lookup, shared by
 * the dashboard's `scm.verify…` procedures (`./routers/scm.ts`, which validate a
 * secret *before* it is stored) and by `workers.scmCredentials.set`
 * (`./routers/workerScmCredentials.ts`, which validates one *as* it is stored,
 * issue #766).
 *
 * Extracted so the mapping exists once: a second copy is exactly the drift a fourth
 * provider would hit, since only one of the two call sites would be updated.
 *
 * **One branch per provider, not one lookup generalised over the registry**
 * (ai/RULES.md §2 names this as the deliberate exception): every `SCMProvider`
 * identity method takes a `ProjectConfig`, and a caller holding a pasted secret has
 * no project to resolve one from.
 *
 * Each lookup already swallows a failed call to `null`, so an unreachable provider
 * is reported as an invalid credential rather than as an inconclusive check. That is
 * the behaviour the `scm.verify…` procedures have always had, and it fails closed,
 * which is the right side to err on for a write.
 */

import { getBitbucketUserForCredential } from '../integrations/scm/bitbucket/client.js';
import { getGitHubUserForToken } from '../integrations/scm/github/client.js';
import { getGitLabUserForToken } from '../integrations/scm/gitlab/client.js';
import type { ScmType } from '../scm/types.js';

/**
 * The account a secret resolved to, or the bare fact that it resolved to none. The
 * login is the same namespace each provider's persona identities and loop prevention
 * compare in, so a verified value is one an operator can check against the account
 * they intended.
 */
export type ScmCredentialVerification = { valid: true; login: string } | { valid: false };

/** Resolve `secret` to an account on `providerId`, or report it as invalid. */
export async function verifyScmCredentialSecret(
	providerId: ScmType,
	secret: string,
): Promise<ScmCredentialVerification> {
	const login = await resolveLogin(providerId, secret);
	return login ? { valid: true, login } : { valid: false };
}

async function resolveLogin(providerId: ScmType, secret: string): Promise<string | null> {
	switch (providerId) {
		case 'github':
			return await getGitHubUserForToken(secret);
		case 'bitbucket':
			return await getBitbucketUserForCredential(secret);
		case 'gitlab':
			return await getGitLabUserForToken(secret);
		default:
			// A provider id from the closed `ScmType` list that no branch above serves —
			// unreachable today, and a fourth provider registering without adding its
			// lookup here must read as "cannot be verified" rather than as verified.
			return null;
	}
}
