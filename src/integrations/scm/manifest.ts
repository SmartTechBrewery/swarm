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
 * - **A `webhookRoute`, but no `routerAdapter`.** Issue #385 resolved the open
 *   question the other way: ingress goes through {@link SCMProvider} methods
 *   (header reading, parsing, signature verification, loop prevention), so there
 *   is no adapter object to register — only the path to mount those methods on,
 *   which the receiver needs before it has a request to hand the provider.
 * - **Nothing else yet, on purpose** (ai/CODING_STANDARDS.md "don't build it
 *   speculatively"): no `configSchema` (a project's SCM config is `repo` +
 *   `credentials`, with no per-provider block — `src/config/schema.ts`), no
 *   `discovery`, no `credentialRoles`, and no signature/secret fields (one HMAC
 *   secret is shared with PM, and verification is an {@link SCMProvider} method).
 */

import type { SCMProvider, ScmType } from '../../scm/types.js';

export interface SCMProviderManifest {
	/** Stable registry key / provider discriminator, e.g. `github`. */
	readonly id: ScmType;
	/** Human-readable provider name (for logs and any future provider-select UI). */
	readonly label: string;
	readonly category: 'scm';
	/**
	 * Path this provider's inbound webhooks POST to, mounted verbatim by
	 * `src/router/webhook-receiver.ts`. Declared here so the receiver serves every
	 * registered provider's route without naming one — adding a provider adds a
	 * route, with no receiver edit.
	 */
	readonly webhookRoute: string;
	/** The provider implementation — one shared, stateless instance (see above). */
	readonly provider: SCMProvider;
}
