/**
 * Persona credential resolution for Bitbucket — the Bitbucket counterpart of
 * `getPersonaToken`/`getPersonaTokenOrNull` (`src/config/provider.ts`).
 *
 * The two personas resolve from *different* sources, exactly as GitHub's do: the
 * **reviewer** is a project-scoped credential *reference* resolved from the secret
 * store, and the **implementer** is never the control plane's own (issue #1249) — it
 * is the stored credential of the operator a write is being made for, bound by
 * `withOperatorCredential` (`src/scm/operator-credential.ts`), and absent outside that
 * scope. Either an access token or a `username:app_password` pair — the client picks
 * the auth scheme from the form (`./client.ts`). Two distinct accounts are what
 * breaks the automation feedback loop (ai/CODING_STANDARDS.md "Loop prevention").
 *
 * **Why this lives in the provider folder** rather than widening
 * `getPersonaToken` (`src/config/provider.ts`): that function's `reviewer` branch
 * resolves GitHub's own per-provider reference, so widening it would either hand a
 * Bitbucket call a GitHub credential or force a GitHub-path change this file has no
 * reason to make.
 *
 * The reviewer reference itself is **Bitbucket's own** since issue #628: it resolves
 * through the provider-parameterised `requireScmCredential` /
 * `resolveScmCredentialOrNull` seam, reading `credentials.scm.bitbucket.reviewer` and
 * nothing else — so a project holding both Bitbucket's and GitHub's tokens keeps them
 * apart, and a project with only GitHub's fails here with Bitbucket's own error rather
 * than silently authenticating as GitHub's reviewer. `project.repo` (`owner/repo`)
 * doubles as Bitbucket's `workspace/repo_slug`.
 */

import { requireScmCredential, resolveScmCredentialOrNull } from '../../../config/provider.js';
import type { ProjectConfig } from '../../../config/schema.js';
import {
	requireScopedOperatorCredential,
	scopedOperatorCredential,
} from '../../../scm/operator-credential.js';
import type { ScmPersona } from '../../../scm/types.js';

/** Resolve `persona`'s Bitbucket credential for `project`, or `null` when none resolves. */
export async function getBitbucketCredentialOrNull(
	project: ProjectConfig,
	persona: ScmPersona,
): Promise<string | null> {
	if (persona === 'implementer') return scopedOperatorCredential();
	return resolveScmCredentialOrNull(project, 'bitbucket', persona);
}

/**
 * Resolve `persona`'s Bitbucket credential for `project`. Throws when none resolves — an
 * operation that needs a persona credential but has none is a deployment error, not a
 * soft "not found" (ai/CODING_STANDARDS.md "Error handling"). The message names the
 * persona's actual source: the operator credential in scope for the implementer, and —
 * through the shared `requireScmCredential` — Bitbucket's own reference plus its
 * conventional config-apply key for the reviewer.
 */
export async function getBitbucketCredential(
	project: ProjectConfig,
	persona: ScmPersona,
): Promise<string> {
	if (persona === 'implementer') return requireScopedOperatorCredential('Bitbucket');
	return requireScmCredential(project, 'bitbucket', persona);
}
