/**
 * PMProviderManifest — the single declarative contract describing a PM provider
 * end-to-end, so a provider registers itself in one place and shared code looks
 * it up by `id` instead of branching on a concrete provider
 * (ai/CODING_STANDARDS.md "Module shape for a provider").
 *
 * Mirrors Cascade's `src/integrations/pm/manifest.ts`, but **scoped down to
 * SWARM's MVP** — the same trimming `src/pm/types.ts` did to Cascade's
 * `PMProvider`. Cascade's manifest carries ~15 fields because it ships three
 * providers plus a wizard/discovery/tRPC layer; SWARM has exactly one provider
 * (GitHub Projects) and only the pieces below exist today. The rest are left out
 * until the phase that needs them, so the manifest doesn't advertise a contract
 * nothing implements:
 *
 * - `credentialRoles` — credentials are still a fixed
 *   implementer/reviewer/webhookSecret triple (`src/config/schema.ts`), not a
 *   provider-specific role list.
 * - `triggerHandlers`, `platformClientFactory`, `extractProjectIdFromJob`. The
 *   concrete `PMProvider` (`github-projects/provider.ts`) is exposed through
 *   the manifest's `createProvider` factory for provider-agnostic reads; the
 *   trigger handlers (`src/triggers/handlers/`) remain in the trigger registry.
 *   The remaining fields get added the day a second provider makes the
 *   registry lookup earn its keep, not before.
 * - wizard / lifecycle-conformance fields — SWARM has no setup wizard, and the
 *   conformance harness is explicitly deferred until there's a second provider
 *   (ai/TESTING.md "Provider conformance"). Discovery, by contrast, is no longer
 *   deferred: the board-mapping screen (issue #201) is a real consumer, so the
 *   manifest declares each provider's `discovery` capabilities below.
 *
 * `routerAdapter` is typed to the provider-neutral `PMRouterAdapter` interface
 * (`src/pm/router-adapter.ts`), extracted from the concrete
 * `GitHubProjectsRouterAdapter` by issue #297 along with the `PmEvent` its methods
 * speak and the `src/integrations/pm/index.ts` barrel this module is re-exported
 * through. The conformance harness is still deferred (a later phase of #297).
 *
 * `webhookRoute` + `verifyWebhookSignature` arrived with issue #496, replacing the
 * receiver's hardcoded `getPMProvider('github-projects')` + `projects_v2_item`
 * branch: the receiver now mounts one route per registered PM manifest, exactly as
 * the SCM receiver does (`../scm/manifest.ts`). The shared-`/github/webhook`
 * reality that used to justify their absence is now expressed *as data* — GitHub
 * Projects declares that same route, and the receiver serves a PM manifest whose
 * route an SCM manifest already owns as a **co-tenant** of it rather than as a
 * second, shadowed Hono handler (see the receiver's header for the rule).
 */

import type { z } from 'zod';
import type { ProjectConfig } from '../../config/schema.js';
import type { PMRouterAdapter } from '../../pm/router-adapter.js';
import type { PMDiscoveryCapability, PMProvider, PMType } from '../../pm/types.js';

/**
 * Everything a PM provider could need to authenticate an inbound webhook —
 * defined once, deliberately wider than GitHub Projects needs, so the providers
 * `PMType` already names (Jira, Linear, Trello) never force this signature to
 * change (ai/RULES.md §2).
 *
 * Deliberately *not* the SCM contract's `(rawBody, signature, secret)` triple
 * (`src/scm/types.ts`): PM schemes in the wild sign more than the body, and two of
 * the three planned providers need something that triple cannot express — the
 * header the signature arrives in differs per provider, and Trello's HMAC covers
 * the callback URL as well as the body.
 */
export interface PmWebhookVerification {
	/** The exact request body bytes, as received — never a re-serialized copy. */
	readonly rawBody: string;
	/**
	 * Case-insensitive reader over the request's headers, so each provider names
	 * its own signature header rather than the receiver naming it for them.
	 */
	readonly headers: (name: string) => string | undefined;
	/**
	 * The project's configured webhook secret, or `null` when it has none. Passed
	 * through rather than refused up front because a provider's scheme need not use
	 * it — a verifier that *does* must fail closed on `null` (never treat an absent
	 * secret as an empty key, which anyone could sign with).
	 */
	readonly secret: string | null;
	/** SWARM's own public callback URL for this route — Trello signs HMAC(rawBody + callbackUrl). */
	readonly callbackUrl: string;
}

/** Authenticate one inbound PM webhook delivery — see {@link PmWebhookVerification}. */
export type PmWebhookVerifier = (input: PmWebhookVerification) => boolean;

export interface PMProviderManifest {
	/** Stable registry key / provider discriminator, e.g. `github-projects`. */
	readonly id: PMType;
	/** Human-readable provider name (for logs and any future provider-select UI). */
	readonly label: string;
	readonly category: 'pm';
	/** Build the provider implementation for a persisted project config. */
	readonly createProvider: (project: ProjectConfig) => PMProvider;

	/**
	 * The provider's own persisted-config Zod schema — the single source of truth
	 * for its board mapping (ai/CODING_STANDARDS.md "Zod is the source of truth").
	 * Declaring it here lets registry consumers find a provider's config contract
	 * without importing the provider folder directly. The central
	 * `src/config/schema.ts` still composes it by import today; routing that
	 * through the registry is a later cleanup, not part of this contract.
	 */
	readonly configSchema: z.ZodTypeAny;

	/**
	 * The provider's router-side webhook adapter (parse → resolve project → filter
	 * → loop-prevention → synthesize). Held as a shared instance because an adapter
	 * is stateless (see `GitHubProjectsRouterAdapter`), so the receiver reuses one
	 * rather than constructing it per request.
	 */
	readonly routerAdapter: PMRouterAdapter;

	/**
	 * Path this provider's inbound board webhooks POST to, mounted by
	 * `src/router/webhook-receiver.ts` (issue #496) — the PM twin of
	 * {@link import('../scm/manifest.js').SCMProviderManifest.webhookRoute}, so
	 * adding a PM provider adds a route with no receiver edit.
	 *
	 * A route an SCM manifest already serves is legal and expected: GitHub delivers
	 * `projects_v2_item` to the same `/github/webhook` URL as its SCM events
	 * (docs/github-projects-v2-api.md §5), so GitHub Projects declares that path and
	 * the receiver co-tenants it onto the existing route instead of registering a
	 * shadowed second handler.
	 */
	readonly webhookRoute: string;

	/**
	 * Authenticate an inbound delivery on {@link webhookRoute} before anything reads
	 * its payload — the PM twin of `SCMProvider.verifyWebhookSignature`, widened to
	 * the input shape every planned provider's scheme needs
	 * ({@link PmWebhookVerification}).
	 *
	 * On the manifest rather than on `PMRouterAdapter` because it is not
	 * project-scoped: the receiver has the manifest in hand from route mounting,
	 * before it has resolved a project or parsed an event.
	 */
	readonly verifyWebhookSignature: PmWebhookVerifier;

	/**
	 * The discovery capabilities this provider answers through
	 * {@link PMProvider.discover} — the board-mapping screen (issue #201) reads
	 * boards (`containers`) and, for one selected board, its workflow states
	 * (`states`). Declared here so the `pm` API router can dispatch a discovery
	 * request through the registry (checking the capability is declared) without
	 * importing a concrete provider, and refuse a capability a provider does not
	 * offer with a clear `NOT_IMPLEMENTED` (ai/CODING_STANDARDS.md "Module shape
	 * for a provider").
	 */
	readonly discovery: readonly PMDiscoveryCapability[];
}
