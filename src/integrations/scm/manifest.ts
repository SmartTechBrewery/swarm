/**
 * SCMProviderManifest — the declarative record describing an SCM provider, so a
 * provider registers itself in one place and shared code looks it up by `id`
 * instead of naming a concrete integration (ai/CODING_STANDARDS.md "Module shape
 * for a provider", ai/RULES.md §2).
 *
 * Mirrors `src/integrations/pm/manifest.ts`, with two deliberate divergences:
 *
 * - **A shared instance, not a `createProvider(project)` factory.** The GitHub
 *   Projects `PMProvider` is constructed per project config; an SCM provider is
 *   stateless and takes `project` per call, so exactly one instance is
 *   registered — the same reasoning the PM manifest already applies to its
 *   stateless `routerAdapter`.
 * - **Nothing else yet, on purpose** (ai/CODING_STANDARDS.md "don't build it
 *   speculatively"): no `configSchema` (a project's SCM config is `repo` +
 *   `credentials`, with no per-provider block — `src/config/schema.ts`), no
 *   `discovery`, no `credentialRoles`, no `webhookRoute`/signature fields (the
 *   one `/github/webhook` route and one HMAC secret are shared with PM, and
 *   verification is an {@link SCMProvider} method), and no `routerAdapter` —
 *   issue #385 decides whether ingress resolves an adapter or provider methods,
 *   and a field nothing reads yet would be churn.
 */

import type { SCMProvider, ScmType } from '../../scm/types.js';

export interface SCMProviderManifest {
	/** Stable registry key / provider discriminator, e.g. `github`. */
	readonly id: ScmType;
	/** Human-readable provider name (for logs and any future provider-select UI). */
	readonly label: string;
	readonly category: 'scm';
	/** The provider implementation — one shared, stateless instance (see above). */
	readonly provider: SCMProvider;
}
