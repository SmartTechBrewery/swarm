import { z } from 'zod';

import { resolveInstanceScmCredential } from '../../db/repositories/instanceCredentialsRepository.js';
import { listInstanceDefaultScmRoles } from '../../integrations/scm/registry.js';
import { ScmProviderIdSchema } from '../../scm/events.js';
import { resolveScmDefaultBranch } from '../scm-default-branch.js';
import { verifyScmCredentialSecret } from '../scm-verification.js';
import { authedProcedure, router } from '../trpc.js';

/**
 * The **pre-project** SCM API — the reads the dashboard makes before a project
 * exists to resolve an `SCMProvider` from, each dispatching over a provider *id*
 * with one branch per provider instead (ai/RULES.md §2 names this as the deliberate
 * exception). Two of them since issue #884: credential verification
 * (`../scm-verification.ts`) and the repository default-branch read
 * (`../scm-default-branch.ts`).
 *
 * SCM verification lets the dashboard confirm a pasted credential resolves
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
 * `ProjectConfig`. Bitbucket joined GitHub with issue #618 and GitLab with issue
 * #619, each when it became runtime-selectable.
 *
 * The provider-id → identity-lookup mapping itself moved to
 * `../scm-verification.ts` with issue #766, so the worker operator credential's own
 * write path verifies through the same one branch per provider rather than a second
 * copy of it. The three procedures below are unchanged in input, output, and
 * behaviour — the per-provider surface is still what a client addresses.
 */
export const scmRouter = router({
	verifyGithubToken: authedProcedure
		.input(z.object({ token: z.string().min(1) }))
		.mutation(async ({ input }) => await verifyScmCredentialSecret('github', input.token)),

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
		.mutation(async ({ input }) => await verifyScmCredentialSecret('bitbucket', input.credential)),

	/**
	 * GitLab's twin (issue #619). A single input rather than Bitbucket's pair, because
	 * `client.ts` makes no credential-form branch: a personal, group, or project
	 * access token all authenticate through `PRIVATE-TOKEN` and all resolve
	 * `GET /user`. The login reported back is the GitLab `username`, the same field
	 * persona identities and loop prevention compare in
	 * (`src/integrations/scm/gitlab/personas.ts`).
	 */
	verifyGitLabToken: authedProcedure
		.input(z.object({ token: z.string().min(1) }))
		.mutation(async ({ input }) => await verifyScmCredentialSecret('gitlab', input.token)),

	/**
	 * The branch a repository reports as its default, so the New Project dialog can
	 * pre-fill its Base Branch input with the repository's *real* one instead of a
	 * plain `main` (issue #884). A **query**: it reads and stores nothing.
	 *
	 * Authenticated with the **installation's default SCM credential** for the
	 * selected provider — the same secret `projects.create` already requires and then
	 * seeds into the new project's own row (`requireInstanceScmDefaults`,
	 * `./projects.ts`, issue #778). At creation time there is no project credential
	 * yet, and this is the one credential that is guaranteed to exist for a provider a
	 * project can be created on, so no new configuration, env var or role is
	 * introduced. Which role is resolved comes off the manifests rather than a
	 * hardcoded `'reviewer'`, so a fourth provider needs no edit here.
	 *
	 * `{ branch: null }` covers every way the read can fail to answer — no instance
	 * credential recorded, an unreachable provider, a repository the credential cannot
	 * see, a provider naming no default branch — because the dialog's response to all
	 * of them is identical: keep the value already in the field and say the read
	 * failed. Nothing here throws for a repository it cannot read, since creation must
	 * never fail on a pre-fill.
	 *
	 * **Accepted trade-off:** any authenticated user may create a project, so any
	 * authenticated user may ask this for an arbitrary `owner/repo`'s default branch as
	 * read by the installation credential. That is the same capability creating a
	 * project already grants — it seeds that credential into a project the caller
	 * administers — and the answer is a branch name, not repository content, so
	 * `authedProcedure` matches the `verify…` gating above rather than adding an
	 * `instanceAdmin` check the create path itself does not have.
	 */
	defaultBranch: authedProcedure
		.input(
			z.object({
				scm: ScmProviderIdSchema,
				repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be in format "owner/repo"'),
			}),
		)
		.query(async ({ input }): Promise<{ branch: string | null }> => {
			// The first role the selected provider declares eligible for an instance
			// default — every provider declares at most one (`reviewer`), so "first" is
			// "the one" today without this having to assume it.
			const eligible = listInstanceDefaultScmRoles().find((role) => role.providerId === input.scm);
			if (!eligible) return { branch: null };

			const secret = await resolveInstanceScmCredential(input.scm, eligible.role);
			if (secret === null) return { branch: null };

			return { branch: await resolveScmDefaultBranch(input.scm, input.repo, secret) };
		}),
});
