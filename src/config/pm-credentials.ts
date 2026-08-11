/**
 * Per-provider PM credential references — the shape, the legacy-adoption
 * normalizer, and the pure reference lookup (issue #631). The PM twin of
 * `./scm-credentials.ts`.
 *
 * A project used to hold a single flat `credentials.pm` role map, validated against
 * the manifest for whichever provider it happened to run on. Role names collide
 * across the four registered providers — `apiToken` is both GitHub Projects' and
 * Jira's, `apiKey` both Linear's and Trello's, `webhookSecret` all four's — so
 * storing Jira's `apiToken` reference on a GitHub Projects project overwrote GitHub
 * Projects' in place. It now holds one `role -> reference` block **per provider id**,
 * validated against the registered PM manifests exactly as `credentials.scm` is
 * validated against the SCM ones. Retained credentials for a provider the project is
 * not currently running on are *stored but never resolved*: resolution reads only the
 * provider it was asked for, so a missing credential fails with its own error rather
 * than quietly returning another provider's secret.
 *
 * A deliberate **leaf**: types plus `zod`, no registry, no DB, no provider imports.
 * `./schema.ts` composes the schemas below into `CredentialsSchema` and chains
 * {@link adoptLegacyPmCredentials} onto `ProjectConfigSchema`, so this module must
 * not import back from it.
 */

import { z } from 'zod';
import type { PMType } from '../pm/types.js';

/**
 * One provider's references — a key into the secret store per role it declares, never
 * a secret (`./schema.ts`'s `CredentialsSchema` header has the full reasoning).
 *
 * A record keyed by role rather than a per-provider object schema: the roles are the
 * provider's to declare (Jira needs an email + API token, Linear an API key, Trello a
 * key + token + secret), so this central schema would otherwise have to be rebuilt
 * every time a provider registers. What the record *may* contain is still validated —
 * `ProjectConfigSchema` checks each block against the registered manifest for the
 * provider id it is filed under, so an undeclared role, or a non-optional one the
 * project's own provider left unconfigured, fails validation with the declared roles
 * named.
 */
export const PmProviderCredentialReferencesSchema = z
	.record(z.string().min(1), z.string().min(1))
	.describe("References to one PM provider's credentials, keyed by its declared roles");

/**
 * `providerId -> { role -> reference }`.
 *
 * A plain `z.record` with a `z.string()` key rather than `z.record(PmProviderIdSchema, …)`,
 * for the same reason `ScmCredentialReferencesByProviderSchema` is one: the keys are
 * validated against `PM_TYPES` by `./schema.ts`, so the shape does not depend on which
 * provider modules a given process happened to import (a dashboard bundle and a
 * focused unit test load none).
 */
export const PmCredentialReferencesByProviderSchema = z
	.record(z.string().min(1), PmProviderCredentialReferencesSchema)
	.describe("References to each PM provider's credentials, keyed by provider id");

export type PmProviderCredentialReferences = z.infer<typeof PmProviderCredentialReferencesSchema>;
export type PmCredentialReferencesByProvider = z.infer<
	typeof PmCredentialReferencesByProviderSchema
>;

/**
 * The credential-block shape the lookups below read — declared structurally rather
 * than imported as `Credentials`, so this module stays a leaf of `./schema.ts` instead
 * of a cycle. `Credentials` satisfies it (its `scm` key is simply unread here).
 */
interface PmCredentialsView {
	pm?: PmCredentialReferencesByProvider;
}

/**
 * A project shaped just enough for the lookups below — see {@link PmCredentialsView}.
 *
 * Narrower than the SCM twin's `ScmCredentialsProject`, which also carries `scm`: the
 * provider id is a parameter of every lookup here, and the adoption normalizer runs
 * before parsing on an `unknown`, so nothing in this module reads `project.pm`.
 */
interface PmCredentialsProject {
	credentials: PmCredentialsView;
}

/**
 * Copy a legacy flat `credentials.pm` role map into
 * `credentials.pm[<the provider it was configured for>]`, so a config written before
 * issue #631 keeps working with nothing re-entered by hand.
 *
 * Unlike the SCM twin, this runs as a Zod **`z.preprocess`** on the whole project
 * object rather than a `.transform` on its output: the legacy and live shapes share
 * one key (`credentials.pm`), where #628's legacy shape was two *sibling* keys beside
 * the new one, so a flat map would fail
 * {@link PmCredentialReferencesByProviderSchema} before any output transform could
 * adopt it. Hence `unknown` in and out, and hence the copying — a preprocess receives
 * the *caller's* object, not one Zod just allocated.
 *
 * Four rules, each load-bearing:
 *
 * 1. **Anything not shaped like a project with a `credentials.pm` is returned
 *    untouched.** The schema behind this preprocess reports the real error; guessing
 *    here would mask it.
 * 2. **Legacy is detected by value type, not by a version marker**: a flat map's
 *    values are strings, a per-provider map's are objects. A map with no string value
 *    is already on the new shape and is returned untouched, which also makes this
 *    idempotent. Only the string-valued entries are moved, so a map somehow holding
 *    both shapes at once keeps just its flat ones — not a state SWARM produces, but the
 *    SQL backfill below reads it the same way, and the two paths should not disagree.
 * 3. **The flat map is attributed to `pm.type`**, the provider it was configured for
 *    — there is nothing else it could have been for. When `pm.type` is missing or not
 *    a string the input is returned untouched, so `ProjectConfigBaseSchema` reports
 *    the missing `pm` rather than this inventing a provider. Deliberately no
 *    `github-projects` default: the SCM twin's `LEGACY_SCM_CREDENTIAL_PROVIDER`
 *    exists only because `scm` is optional, and `pm` is required.
 * 4. **Reference names are copied verbatim**, never rewritten to the manifest's
 *    conventional `envVarKey`. The secret is stored in `project_credentials` under the
 *    old key, so renaming the reference without moving the row would break resolution
 *    outright.
 *
 * The persisted-row twin is a one-time SQL backfill
 * (`src/db/migrations/0046_pm_credentials_per_provider.sql`), because
 * `rowToProjectConfig` is deliberately a dumb re-join with no validation. There is
 * **no** runtime fallback from a per-provider block to a flat one: that would hand a
 * newly selected Jira the GitHub Projects token the moment an operator switched
 * provider.
 */
export function adoptLegacyPmCredentials(raw: unknown): unknown {
	if (!isRecord(raw)) return raw;
	const credentials = raw.credentials;
	if (!isRecord(credentials)) return raw;
	const references = credentials.pm;
	if (!isRecord(references)) return raw;

	const legacyRoles = Object.entries(references).filter(
		(entry): entry is [string, string] => typeof entry[1] === 'string',
	);
	if (legacyRoles.length === 0) return raw;

	const providerId = isRecord(raw.pm) ? raw.pm.type : undefined;
	if (typeof providerId !== 'string') return raw;

	// Only the adopting provider gets a block. Never a copy for every provider id:
	// that would be the fallback chain this issue exists to remove.
	return {
		...raw,
		credentials: { ...credentials, pm: { [providerId]: Object.fromEntries(legacyRoles) } },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The secret-store reference one `(provider, role)` resolves through, or `undefined`
 * when the project configured none. The pure lookup both `resolvePmCredential`
 * (`./provider.ts`) and the API layer share, so a screen can display the key a role
 * *actually* resolves through rather than the manifest's conventional one.
 */
export function pmCredentialReferenceFor(
	project: PmCredentialsProject,
	providerId: PMType,
	role: string,
): string | undefined {
	return project.credentials.pm?.[providerId]?.[role];
}

/**
 * Every reference a project names across all providers — what `swarm config apply`
 * reads out of the environment and stores. Deduping is the caller's (references for
 * two roles or two providers may legitimately name the same key).
 *
 * All providers, not just `pm.type`'s: a project retaining an outgoing provider's
 * references still has its secrets applied, which is what makes switching back to it
 * a config change rather than a re-entry of every credential.
 */
export function listPmCredentialReferences(project: PmCredentialsProject): string[] {
	return Object.values(project.credentials.pm ?? {}).flatMap((perProvider) =>
		Object.values(perProvider),
	);
}
