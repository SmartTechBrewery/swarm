/**
 * Reconstruct a runnable `ProjectConfig` from the non-secret slice a
 * `TaskAssignment` carries (`./protocol.ts`, `../config/project-config-slice.ts`).
 *
 * A DB-free remote worker (`./connect-entry.ts`) never sees credential
 * *references*: the assignment carries `NonSecretProjectConfigSchema`, the full
 * config with the `credentials` block omitted. But the pipeline phases are typed
 * against the full `ProjectConfig`, so they need a `credentials` block present to
 * type-check and parse. This fills it with an inert **empty** placeholder that
 * satisfies `CredentialsSchema` and is **never resolved**: the DB-free execution path
 * injects the operator token and delivery provider directly
 * (`../worker/consumer.ts` `AssignedPhaseInputs.agentToken`/`delivery`), so
 * `getPersonaToken` / `requireScmCredential` — the only readers of these references —
 * are never called on this worker. No secret is present or resolvable here, so the
 * placeholder leaks nothing.
 */

import type { NonSecretProjectConfig } from '../config/project-config-slice.js';
import { type ProjectConfig, ProjectConfigBaseSchema } from '../config/schema.js';

/**
 * An **empty** credentials block — the honest representation of "this worker holds no
 * credential references at all", and legal since issue #628 made every key of
 * `CredentialsSchema` optional (before that the schema required a non-empty string per
 * role, so the placeholder had to invent two). Never resolved against any secret store,
 * so it names nothing a host could accidentally supply — see the module header.
 */
const PLACEHOLDER_CREDENTIALS = {} as const;

/**
 * Rebuild a full `ProjectConfig` from the assignment's transport slice, adding
 * the worker's own checkout path and inert placeholder `credentials`.
 *
 * Parses the **base** schema deliberately: `ProjectConfigSchema`'s cross-field check
 * validates that `credentials.pm` names a reference for every credential role the
 * project's PM provider declares (issue #537), and this worker has no credentials by
 * design — the placeholder above is the *absence* of a credential block, not a
 * configuration of one. Running that check here would force a fake `credentials.pm`
 * reference into the payload (a reference whose declared host env var this machine
 * could then resolve), which is the opposite of the boundary this module exists to
 * hold. Every other field keeps its own validation.
 */
export function reconstructProjectConfig(
	slice: NonSecretProjectConfig,
	workerRepoRoot: string,
): ProjectConfig {
	return ProjectConfigBaseSchema.parse({
		...slice,
		// `repoRoot` is host-local execution state and never travels from the control plane.
		repoRoot: workerRepoRoot,
		credentials: PLACEHOLDER_CREDENTIALS,
	});
}
