import { z } from 'zod';

import { getBitbucketUserForCredential } from '../../integrations/scm/bitbucket/client.js';
import { getGitHubUserForToken } from '../../integrations/scm/github/client.js';
import { authedProcedure, router } from '../trpc.js';

/**
 * SCM verification API — lets the dashboard confirm a pasted credential resolves
 * to a real identity before it is persisted via `credentials.set` (#79); these
 * procedures store nothing themselves. Mirrors Cascade's
 * `integrationsDiscovery.verifyGithubToken`, but returns a `{ valid }` result
 * instead of throwing on a bad token: each delegates to its provider's existing
 * identity lookup, which already swallows a failed call to `null`, so there is no
 * new provider-API code here. `authedProcedure` because the whole `/trpc` surface
 * (except `ping`) is session-guarded now (see `credentials.ts`).
 *
 * **One procedure per provider, not one generalised over the registry**
 * (ai/RULES.md §2 names this as a deliberate exception): the caller has a pasted
 * secret and a provider *name* but no project yet, so there is nothing to resolve a
 * `SCMProvider` from — `hasIntegration`/`resolvePersonaIdentities` both take a
 * `ProjectConfig`. Bitbucket joined GitHub with issue #618, when it became
 * runtime-selectable; GitLab adds its own beside them with issue #619.
 */
export const scmRouter = router({
	verifyGithubToken: authedProcedure
		.input(z.object({ token: z.string().min(1) }))
		.mutation(async ({ input }) => {
			const login = await getGitHubUserForToken(input.token);
			return login ? { valid: true as const, login } : { valid: false as const };
		}),

	/**
	 * Bitbucket Cloud's twin. The credential is the `username:app_password` pair
	 * delivery needs — the only form that resolves `GET /2.0/user` — and the login
	 * reported back is the account's `nickname`, the same namespace persona identities
	 * and loop prevention compare in (`src/integrations/scm/bitbucket/personas.ts`),
	 * so a verified value is the one an operator can check against the reviewer they
	 * intended.
	 */
	verifyBitbucketCredential: authedProcedure
		.input(z.object({ credential: z.string().min(1) }))
		.mutation(async ({ input }) => {
			const login = await getBitbucketUserForCredential(input.credential);
			return login ? { valid: true as const, login } : { valid: false as const };
		}),
});
