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
 * - `credentialRoles` / `webhookRoute` / `verifyWebhookSignature` — SWARM's
 *   GitHub Projects and SCM subscriptions share one `/github/webhook` route and
 *   one HMAC secret (`src/router/webhook-receiver.ts`,
 *   docs/github-projects-v2-api.md §5), so there's no per-provider route or
 *   signature scheme to declare, and credentials are a fixed
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
 */

import type { z } from 'zod';
import type { ProjectConfig } from '../../config/schema.js';
import type { PMRouterAdapter } from '../../pm/router-adapter.js';
import type { PMDiscoveryCapability, PMProvider, PMType } from '../../pm/types.js';

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
