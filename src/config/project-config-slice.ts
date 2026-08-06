/**
 * The non-secret slice of a `ProjectConfig` — the only view of a project's
 * config a worker may ever see over the transport (`src/transport/protocol.ts`).
 * It omits credentials and the control-plane host's `repoRoot`; the remote
 * daemon resolves its own checkout path locally.
 *
 * Persona secrets are never in `ProjectConfig` to begin with: `CredentialsSchema`
 * (`./schema.ts`) stores only *references* into the secret store, and the
 * resolved token values are fetched per-persona at run time (ai/ARCHITECTURE.md
 * "SCM: GitHub"). Omitting the whole block means the worker never even learns
 * those reference keys — a strictly tighter boundary than stripping secrets that
 * were never present.
 *
 * Derived from `ProjectConfigBaseSchema.omit(...)` rather than a hand-rewritten
 * object so it can never drift from the config schema: a new *non-secret* field
 * is included automatically, and a future *secret* field would have to be added
 * to the `.omit()` list — a deliberate one-line decision at this seam. The base
 * (rather than `ProjectConfigSchema`) is the bare `z.object` `.omit()` needs; its
 * cross-field check reads `credentials`, which this slice removes outright.
 */

import type { z } from 'zod';
import { type ProjectConfig, ProjectConfigBaseSchema } from './schema.js';

/** The project config a worker may see — credential references and host-local paths excluded. */
export const NonSecretProjectConfigSchema = ProjectConfigBaseSchema.omit({
	credentials: true,
	repoRoot: true,
});
export type NonSecretProjectConfig = z.infer<typeof NonSecretProjectConfigSchema>;

/**
 * Strip the credential *references* from a project config so it is safe to hand
 * to a worker over the transport. Validates through the slice schema before
 * returning, so the result is a well-formed `NonSecretProjectConfig` and never a
 * config that still carries a `credentials` key.
 */
export function toNonSecretProjectConfig(project: ProjectConfig): NonSecretProjectConfig {
	const { credentials: _credentials, repoRoot: _repoRoot, ...rest } = project;
	return NonSecretProjectConfigSchema.parse(rest);
}
