/**
 * Per-provider SCM credential references — the shape, the legacy-adoption
 * normalizer, and the pure reference lookup (issue #628).
 *
 * A project used to hold a single shared `credentials.reviewer` /
 * `credentials.webhookSecret` pair, so storing GitLab's reviewer token overwrote
 * GitHub's in place. It now holds one `{ reviewer?, webhookSecret? }` block **per
 * provider id**, validated against the registered SCM manifests exactly as
 * `credentials.pm` is validated against the PM manifest. Retained credentials for a
 * provider the project is not currently running on are *stored but never resolved*:
 * resolution reads only the provider it was asked for, so a missing credential fails
 * with its own error rather than quietly returning another provider's secret.
 *
 * A deliberate **leaf**: types plus `zod`, no registry, no DB, no provider imports.
 * `./schema.ts` composes the schemas below into `CredentialsSchema` and chains
 * {@link adoptLegacyScmCredentials} onto `ProjectConfigSchema`, so this module must
 * not import back from it.
 */

import { z } from 'zod';
import { SCM_CREDENTIAL_ROLES, type ScmCredentialRole, type ScmType } from '../scm/types.js';

/**
 * One provider's references — a key into the secret store per role, never a secret
 * (`./schema.ts`'s `CredentialsSchema` header has the full reasoning).
 *
 * Both roles are optional: a project switches provider from the dashboard's Source
 * Control tab *before* it can enter the new provider's credentials, so "selected but
 * not yet configured" is an unavoidable intermediate state rather than a misuse.
 * Presence is therefore enforced at resolution time by `requireScmCredential`
 * (`./provider.ts`), which fires exactly when the credential is needed and names what
 * to set — not at parse time, which would reject a config the dashboard just created.
 */
export const ScmProviderCredentialReferencesSchema = z
	.object({
		/** Reference to the reviewer-persona token for this provider. */
		reviewer: z.string().min(1).optional(),
		/** Reference to the secret this provider authenticates inbound deliveries with. */
		webhookSecret: z.string().min(1).optional(),
	})
	.describe("References to one SCM provider's credentials (never the secrets themselves)");

/**
 * `providerId -> { reviewer?, webhookSecret? }`.
 *
 * A plain `z.record` with a `z.string()` key rather than `z.record(ScmProviderIdSchema, …)`,
 * for the same reason `PmCredentialReferencesSchema` is one: the keys are validated
 * against the *registered* manifests by `./schema.ts`, so the shape does not depend on
 * which provider modules a given process happened to import (a dashboard bundle and a
 * focused unit test load none).
 */
export const ScmCredentialReferencesByProviderSchema = z
	.record(z.string().min(1), ScmProviderCredentialReferencesSchema)
	.describe("References to each SCM provider's credentials, keyed by provider id");

export type ScmProviderCredentialReferences = z.infer<typeof ScmProviderCredentialReferencesSchema>;
export type ScmCredentialReferencesByProvider = z.infer<
	typeof ScmCredentialReferencesByProviderSchema
>;

/**
 * The credential-block shape the helpers below read — declared structurally rather
 * than imported as `Credentials`, so this module stays a leaf of `./schema.ts`
 * instead of a cycle. `Credentials` satisfies it (its `pm` key is simply unread here).
 */
interface ScmCredentialsView {
	/** @deprecated Pre-#628 shared reviewer reference — read only by the adoption below. */
	reviewer?: string;
	/** @deprecated Pre-#628 shared webhook-secret reference — read only by the adoption below. */
	webhookSecret?: string;
	scm?: ScmCredentialReferencesByProvider;
}

/** A project shaped just enough for the lookups below — see {@link ScmCredentialsView}. */
interface ScmCredentialsProject {
	scm?: ScmType;
	credentials: ScmCredentialsView;
}

/**
 * The provider a project's *legacy* shared pair belongs to.
 *
 * The pair was configured for whichever provider the project runs on, and that is
 * `project.scm`. A project naming none cannot resolve a provider at all since issue
 * #618, and before #618 GitHub was the only runtime-ready one — so an unstated
 * project's legacy pair is GitHub's, which is the single safe attribution. Used by
 * both the adoption below and the one PM role that inherits a shared SCM credential
 * (`resolvePmCredential`, `./provider.ts`), so the two cannot disagree about where an
 * unmigrated project's webhook secret lives.
 */
export const LEGACY_SCM_CREDENTIAL_PROVIDER: ScmType = 'github';

/** @see LEGACY_SCM_CREDENTIAL_PROVIDER */
export function sharedScmCredentialProviderFor(project: { scm?: ScmType }): ScmType {
	return project.scm ?? LEGACY_SCM_CREDENTIAL_PROVIDER;
}

/**
 * Copy a legacy shared `{ reviewer, webhookSecret }` pair into
 * `credentials.scm[<the provider it belongs to>]`, so a config written before issue
 * #628 keeps working with nothing re-entered by hand. Mutates and returns `project`
 * — it runs as a Zod `.transform`, on output Zod itself just allocated.
 *
 * Three rules, each load-bearing:
 *
 * 1. **A project that already has `credentials.scm` is left untouched**, which also
 *    makes this idempotent: the new shape is authoritative once present, and the
 *    legacy keys are left in place beside it (harmless, and phase 1's Source Control
 *    tab still edits them — see `src/api/routers/credentials.ts`).
 * 2. **Only the adopting provider gets an entry.** Never a copy for every registered
 *    provider: that would be the fallback chain this issue exists to remove.
 * 3. **The reference name is preserved verbatim**, never rewritten to the manifest's
 *    conventional `envVarKey`. The secret is stored in `project_credentials` under the
 *    old key, so renaming the reference without moving the row would break resolution
 *    outright — and for every project created since issue #290 the names genuinely
 *    differ (`SCM_TOKEN_REVIEWER` vs GitHub's `GITHUB_TOKEN_REVIEWER`), so divergence
 *    is the common case rather than an edge one.
 *
 * The persisted-row twin is a one-time SQL backfill
 * (`src/db/migrations/0045_scm_credentials_per_provider.sql`), because
 * `rowToProjectConfig` is deliberately a dumb re-join. There is **no** runtime
 * fallback from a per-provider reference to the legacy pair: that would hand a newly
 * selected GitLab the GitHub secret the moment an operator switched provider.
 */
export function adoptLegacyScmCredentials<T extends ScmCredentialsProject>(project: T): T {
	const { credentials } = project;
	if (credentials.scm) return project;
	if (!credentials.reviewer && !credentials.webhookSecret) return project;

	const adopted: ScmProviderCredentialReferences = {};
	if (credentials.reviewer) adopted.reviewer = credentials.reviewer;
	if (credentials.webhookSecret) adopted.webhookSecret = credentials.webhookSecret;
	credentials.scm = { [sharedScmCredentialProviderFor(project)]: adopted };
	return project;
}

/**
 * The secret-store reference one `(provider, role)` resolves through, or `undefined`
 * when the project configured none. The pure lookup both `resolveScmCredentialOrNull`
 * (`./provider.ts`) and the API layer share, so a screen can display the key a role
 * *actually* resolves through rather than the manifest's conventional one.
 */
export function scmCredentialReferenceFor(
	project: ScmCredentialsProject,
	providerId: ScmType,
	role: ScmCredentialRole,
): string | undefined {
	return project.credentials.scm?.[providerId]?.[role];
}

/**
 * Every reference a project names across all providers — what `swarm config apply`
 * reads out of the environment and stores. Deduping is the caller's (references for
 * two roles or two providers may legitimately name the same key).
 */
export function listScmCredentialReferences(project: ScmCredentialsProject): string[] {
	const references: string[] = [];
	for (const perProvider of Object.values(project.credentials.scm ?? {})) {
		for (const role of SCM_CREDENTIAL_ROLES) {
			const reference = perProvider[role];
			if (reference) references.push(reference);
		}
	}
	return references;
}
