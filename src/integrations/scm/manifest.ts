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
 * - **A `runtimeReady` opt-out** (issue #296), so a provider can be registered
 *   and discoverable while its contract is still being filled in phase by phase.
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
	/**
	 * Whether shared code may route real traffic to this provider. Absent means
	 * yes — a registered provider is live unless it says otherwise.
	 *
	 * `false` marks a provider that is registered but still being built out phase
	 * by phase (Bitbucket, issue #296): discoverable by id so its own tests and
	 * follow-up phases can resolve it, and deliberately unreachable at runtime, so
	 * registering it changes no existing behavior. Two things read it — the
	 * project-scoped lookup (`requireProjectSCMProvider`, `./registry.ts`) and the
	 * receiver's route mounting (`src/router/webhook-receiver.ts`) — which is
	 * exactly the pair that would otherwise start answering for a provider whose
	 * contract methods still throw.
	 *
	 * It is **not** a selection mechanism and does not soften the single-provider
	 * assertion: the second provider to claim runtime readiness still makes the
	 * project-scoped lookup throw, so project→provider selection gets designed
	 * then rather than resolving to whichever manifest registered first.
	 */
	readonly runtimeReady?: boolean;
	/** The provider implementation — one shared, stateless instance (see above). */
	readonly provider: SCMProvider;
}

/** Whether shared code may route real traffic to `manifest` — see {@link SCMProviderManifest.runtimeReady}. */
export function isRuntimeReadySCMProvider(manifest: SCMProviderManifest): boolean {
	return manifest.runtimeReady !== false;
}
