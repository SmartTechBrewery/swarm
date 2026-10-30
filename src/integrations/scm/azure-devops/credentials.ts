/**
 * Persona credential resolution for Azure DevOps — a near-verbatim port of
 * `../gitlab/credentials.ts` (issue #1089, phase 2/6).
 *
 * The two personas resolve from *different* sources, exactly as the other
 * providers' do: the **reviewer** is a project-scoped credential *reference*
 * resolved from the secret store, and the **implementer** is never the control
 * plane's own (issue #1249) — it is the stored personal access token of the operator
 * a write is being made for, bound by `withOperatorCredential`
 * (`src/scm/operator-credential.ts`), and absent outside that scope. Two distinct
 * accounts are what breaks the automation feedback loop (ai/CODING_STANDARDS.md
 * "Loop prevention").
 *
 * **Why this lives in the provider folder** rather than widening `getPersonaToken`
 * (`src/config/provider.ts`): that function's `reviewer` branch resolves GitHub's own
 * per-provider reference.
 *
 * The reviewer reference is **Azure DevOps' own** (issue #628's per-provider
 * shape): it resolves through `requireScmCredential` / `resolveScmCredentialOrNull`
 * with the `azure-devops` id, reading `credentials.scm['azure-devops'].reviewer` and
 * nothing else — never a GitHub token, so a project holding only GitHub's fails here
 * with Azure DevOps' own error rather than authenticating as GitHub's reviewer.
 */

import { requireScmCredential, resolveScmCredentialOrNull } from '../../../config/provider.js';
import type { ProjectConfig } from '../../../config/schema.js';
import {
	requireScopedOperatorCredential,
	scopedOperatorCredential,
} from '../../../scm/operator-credential.js';
import type { ScmPersona } from '../../../scm/types.js';

/** Resolve `persona`'s Azure DevOps PAT for `project`, or `null` when none resolves. */
export async function getAzureDevOpsTokenOrNull(
	project: ProjectConfig,
	persona: ScmPersona,
): Promise<string | null> {
	if (persona === 'implementer') return scopedOperatorCredential();
	return resolveScmCredentialOrNull(project, 'azure-devops', persona);
}

/**
 * Resolve `persona`'s Azure DevOps PAT for `project`. Throws when none resolves — an
 * operation that needs a persona credential but has none is a deployment error, not a
 * soft "not found" (ai/CODING_STANDARDS.md "Error handling"). The message names the
 * persona's actual source: the operator credential in scope for the implementer, and —
 * through the shared `requireScmCredential` — Azure DevOps's own reference plus its
 * conventional config-apply key for the reviewer.
 */
export async function getAzureDevOpsToken(
	project: ProjectConfig,
	persona: ScmPersona,
): Promise<string> {
	if (persona === 'implementer') return requireScopedOperatorCredential('Azure DevOps');
	return requireScmCredential(project, 'azure-devops', persona);
}
