/**
 * PMProviderManifest — the single declarative contract describing a PM provider
 * end-to-end, so a provider registers itself in one place and shared code looks
 * it up by `id` instead of branching on a concrete provider
 * (ai/CODING_STANDARDS.md "Module shape for a provider").
 *
 * Mirrors Cascade's `src/integrations/pm/manifest.ts`, but **scoped down to
 * SWARM's MVP** — the same trimming `src/pm/types.ts` did to Cascade's
 * `PMProvider`. Cascade's manifest carries ~15 fields because it ships three
 * providers plus a wizard/discovery/tRPC layer; SWARM has two (GitHub Projects
 * and Linear) and only the pieces below exist today. The rest are left out
 * until the phase that needs them, so the manifest doesn't advertise a contract
 * nothing implements:
 *
 * - `triggerHandlers`, `platformClientFactory`, `extractProjectIdFromJob`. The
 *   concrete `PMProvider` (`github-projects/provider.ts`) is exposed through
 *   the manifest's `createProvider` factory for provider-agnostic reads; the
 *   trigger handlers (`src/triggers/handlers/`) remain in the trigger registry.
 *   The remaining fields get added the day a second provider makes the
 *   registry lookup earn its keep, not before.
 * - wizard / lifecycle-conformance fields — SWARM has no setup wizard, and
 *   *behavioral* conformance (Cascade's `lifecycle` fixture harness) stays out of
 *   scope; the harness SWARM does run asserts this manifest's surface and that no
 *   method is a stub (ai/TESTING.md "Provider conformance"). Discovery, by
 *   contrast, is not deferred at all: the board-mapping screen (issue #201) is a
 *   real consumer, so the manifest declares each provider's `discovery`
 *   capabilities below.
 *
 * `routerAdapter` is typed to the provider-neutral `PMRouterAdapter` interface
 * (`src/pm/router-adapter.ts`), extracted from the concrete
 * `GitHubProjectsRouterAdapter` by issue #297 along with the `PmEvent` its methods
 * speak and the `src/integrations/pm/index.ts` barrel this module is re-exported
 * through. Every field below is asserted for each *registered* manifest by
 * `tests/unit/integrations/pm/pm-conformance.test.ts` (issue #499), the gate a
 * second PM provider passes by implementing the contract rather than by
 * registering early — so add a provider's fixture there, never an exemption.
 *
 * `credentialRoles` arrived with issue #497: the shared `credentials` block is a
 * fixed `{ reviewer, webhookSecret }` pair shaped for GitHub (`src/config/schema.ts`),
 * which cannot express what the providers `PMType` already names need — Jira an
 * email plus an API token, Linear an API key, Trello a key + token + secret. So each
 * provider *declares* its own roles here and a project supplies a reference per role
 * under `credentials.pm`, resolved through `resolvePmCredential`
 * (`src/config/provider.ts`).
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
import type { ProjectConfig, ScmCredentialReferences } from '../../config/schema.js';
import type { PMRouterAdapter } from '../../pm/router-adapter.js';
import type { PMDiscoveryCapability, PMProvider, PMType } from '../../pm/types.js';

/**
 * One credential a PM provider needs, declared by the provider rather than baked
 * into the central config schema (issue #497). Mirrors Cascade's
 * `CredentialRoleSpec` (`cascade/src/integrations/pm/manifest.ts`,
 * `cascade/src/config/integrationRoles.ts`).
 *
 * A project supplies a *reference* per role under `credentials.pm`
 * (`src/config/schema.ts`) — never the secret — and `resolvePmCredential`
 * (`src/config/provider.ts`) turns `(project, role)` into the secret.
 */
export interface PmCredentialRoleSpec {
	/** Stable key the project's `credentials.pm` map and every resolver call name. */
	readonly role: string;
	/** Human-readable name, for logs and the credential UI. */
	readonly label: string;
	/**
	 * One-line explanation of what this credential is and what it must be able to
	 * do — the provider's own words, rendered verbatim by the dashboard's Project
	 * Management tab (issue #537) so the screen's terminology and permission
	 * guidance come from the provider rather than being hard-coded per provider in
	 * the UI. Optional: a role whose label says everything needs no prose.
	 *
	 * **Plain prose, not markdown.** The panel renders it as text, so backticks and
	 * other markup would appear literally.
	 */
	readonly description?: string;
	/**
	 * Host-environment variable read as the last-resort fallback only when the
	 * project explicitly configures a reference for this role — and, for `swarm
	 * config apply`, the conventional key an operator exports the secret under.
	 */
	readonly envVarKey: string;
	/** When `true`, the provider still works without this credential. */
	readonly optional?: boolean;
	/**
	 * Key of the project's shared `credentials` block this role falls back to when
	 * `credentials.pm` names no reference for it — the *data* form of a deliberate
	 * cross-category reach (ai/RULES.md §2), so shared code never branches on a
	 * provider id to honor one.
	 *
	 * Exists for exactly one case today: GitHub Projects' webhook secret **is** the
	 * GitHub SCM webhook secret, because the board and the repo are literally the
	 * same webhook — one URL, one secret (docs/github-projects-v2-api.md §5). A role
	 * declaring this is also exempt from the "every non-optional role must be
	 * configured" check, since it already resolves without a `credentials.pm` entry.
	 *
	 * A provider whose board is a separate system (Jira, Linear, Trello) must not
	 * declare it: borrowing another category's secret is only honest when the two
	 * are the same account.
	 */
	readonly inheritsSharedCredential?: keyof ScmCredentialReferences;
}

/**
 * Role a provider declares when its webhook scheme authenticates deliveries with a
 * project-scoped secret — the one the receiver resolves into
 * {@link PmWebhookVerification.secret} before calling
 * {@link PMProviderManifest.verifyWebhookSignature}.
 *
 * Named here rather than in the receiver so the receiver resolves a *declared*
 * role instead of assuming every provider has one: a provider that declares no
 * such role sees `secret: null` and its verifier decides, which is exactly the
 * documented contract for a scheme that signs with something else.
 */
export const PM_WEBHOOK_SECRET_ROLE = 'webhookSecret';

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
	 * The credentials this provider needs, each as a {@link PmCredentialRoleSpec}
	 * (issue #497). This is the *declaration* a project's `credentials.pm` map is
	 * validated against (`src/config/schema.ts`): a reference for a role that isn't
	 * declared here, or a missing non-optional role, fails config validation.
	 *
	 * Declare only what the provider actually resolves — an empty list is legal for a
	 * provider that needs no project-scoped secret of its own.
	 */
	readonly credentialRoles: readonly PmCredentialRoleSpec[];

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
