/**
 * Persona credential resolution for Azure DevOps — a near-verbatim port of
 * `../gitlab/credentials.ts` (issue #1089, phase 2/6).
 *
 * The two personas resolve from *different* sources, exactly as the other
 * providers' do (issue #396): the **implementer** is the worker operator's own
 * personal access token, read here from a `SWARM_OPERATOR_AZURE_DEVOPS_TOKEN` env
 * var on the **control plane** and never in `ProjectConfig` (so never in the
 * transport's non-secret project slice); the **reviewer** stays a project-scoped
 * credential *reference* resolved from the secret store. Two distinct accounts are
 * what breaks the automation feedback loop (ai/CODING_STANDARDS.md "Loop
 * prevention").
 *
 * **Why this lives in the provider folder** rather than widening `getPersonaToken`
 * (`src/config/provider.ts`): that function's `implementer` branch returns the
 * *GitHub* operator token, and its `reviewer` branch resolves GitHub's own
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
import { optionalEnv } from '../../../lib/env.js';
import type { ScmPersona } from '../../../scm/types.js';

/** Env var name holding the worker-local operator Azure DevOps personal access token. */
export const OPERATOR_AZURE_DEVOPS_TOKEN_ENV = 'SWARM_OPERATOR_AZURE_DEVOPS_TOKEN';

/** The operator's Azure DevOps PAT, or `null` when the env var is unset or empty. */
export function getOperatorAzureDevOpsTokenOrNull(): string | null {
	return optionalEnv(OPERATOR_AZURE_DEVOPS_TOKEN_ENV, '').trim() || null;
}

/** Resolve `persona`'s Azure DevOps PAT for `project`, or `null` when none resolves. */
export async function getAzureDevOpsTokenOrNull(
	project: ProjectConfig,
	persona: ScmPersona,
): Promise<string | null> {
	if (persona === 'implementer') return getOperatorAzureDevOpsTokenOrNull();
	return resolveScmCredentialOrNull(project, 'azure-devops', persona);
}

/**
 * Resolve `persona`'s Azure DevOps PAT for `project`. Throws when none resolves — an
 * operation that needs a persona credential but has none configured is a deployment
 * error, not a soft "not found" (ai/CODING_STANDARDS.md "Error handling"). The
 * message names the persona's actual source: the operator env var for the
 * implementer, and — through the shared `requireScmCredential` — Azure DevOps' own
 * reference for the reviewer.
 */
export async function getAzureDevOpsToken(
	project: ProjectConfig,
	persona: ScmPersona,
): Promise<string> {
	if (persona === 'implementer') {
		const token = getOperatorAzureDevOpsTokenOrNull();
		if (token) return token;
		throw new Error(
			`No Azure DevOps implementer token configured: set ${OPERATOR_AZURE_DEVOPS_TOKEN_ENV} on this host ` +
				"(the worker operator's own personal access token; never stored in project_credentials)",
		);
	}
	return requireScmCredential(project, 'azure-devops', persona);
}
