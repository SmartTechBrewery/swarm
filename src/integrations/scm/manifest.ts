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
 * - **`credentialRoles`, but for a closed role set** (issue #628). The PM
 *   manifest's field exists because each PM provider needs *different* credentials;
 *   an SCM provider always needs exactly the two the contract itself names
 *   ({@link SCM_CREDENTIAL_ROLES}). What differs per provider is only the
 *   conventional *reference name* for each role, which is what a spec declares — so
 *   a project can hold GitHub's and GitLab's credentials at once instead of the two
 *   overwriting one shared pair. See {@link ScmCredentialRoleSpec}.
 * - **Nothing else yet, on purpose** (ai/CODING_STANDARDS.md "don't build it
 *   speculatively"): no `configSchema` (a project's SCM config is `repo` + `scm` +
 *   `credentials.scm[<providerId>]`, with no provider-owned config block —
 *   `src/config/schema.ts`), no `discovery`, and no signature/secret fields
 *   (verification is an {@link SCMProvider} method).
 */

import type { SCMProvider, ScmCredentialRole, ScmType } from '../../scm/types.js';

/**
 * One of the two credentials an SCM provider needs, as *that provider's* reference
 * name for it (issue #628) — the SCM twin of `PmCredentialRoleSpec`
 * (`../pm/manifest.ts`), minus the fields a closed role set does not need: the
 * role is one of {@link SCM_CREDENTIAL_ROLES}, never a free string, and neither
 * role is optional or inherited.
 *
 * A project supplies a *reference* per (provider, role) under
 * `credentials.scm[<providerId>][<role>]` (`src/config/schema.ts`) — never the
 * secret — and `resolveScmCredentialOrNull` / `requireScmCredential`
 * (`src/config/provider.ts`) turn `(project, providerId, role)` into the secret.
 */
export interface ScmCredentialRoleSpec {
	/** Which of the contract's two credentials this spec names. */
	readonly role: ScmCredentialRole;
	/**
	 * Conventional secret-store key for this role — the `swarm config apply` env var
	 * a new project is seeded with, and the key `requireScmCredential`'s error names.
	 *
	 * **Not** the reference an existing project necessarily uses: a project created
	 * since issue #290 holds the provider-neutral `SCM_TOKEN_REVIEWER` /
	 * `SCM_WEBHOOK_SECRET` names, and issue #628's adoption preserves them verbatim
	 * (renaming a reference without moving the `project_credentials` row would break
	 * resolution outright). So anything that *displays* a credential key must show
	 * the reference the role resolves through, not this.
	 */
	readonly envVarKey: string;
	/**
	 * Whether one value for this role may legitimately be shared by every project on
	 * the installation, making it eligible for an **instance-level default** (issue
	 * #769) — the value an instance administrator records once in General Settings →
	 * Credentials, held in `instance_scm_credentials`.
	 *
	 * Declared as manifest data rather than branched on at the call site — the
	 * `PmCredentialRoleSpec.inheritsSharedCredential` precedent (`../pm/manifest.ts`)
	 * — so the admin surface offers exactly the roles a provider says are
	 * installation-wide, and a fourth provider opts in without an edit to shared code.
	 *
	 * `webhookSecret` must never declare it: that secret is tied to *this project's*
	 * own webhook endpoint, so one installation-wide value would be wrong rather than
	 * merely redundant. Asserted in
	 * `tests/unit/integrations/scm/scm-conformance.test.ts`.
	 *
	 * Eligibility is not resolution: nothing declaring this becomes a fallback for
	 * `resolveScmCredentialOrNull` (`src/config/provider.ts`), whose no-fallback-chain
	 * rule is untouched.
	 */
	readonly instanceDefault?: boolean;
}

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
	 * `false` marks a provider that is registered but not wired up: discoverable by
	 * id so its own tests and follow-up work can resolve it, and deliberately
	 * unreachable at runtime, so registering it changes no existing behavior. Two
	 * things read it — the project-scoped lookup (`requireProjectSCMProvider`,
	 * `./registry.ts`) and the receiver's route mounting
	 * (`src/router/webhook-receiver.ts`) — which is exactly the pair that starts
	 * answering for a provider the moment it flips. Every registered provider has now
	 * made that call — GitHub, then Bitbucket with issue #618, then GitLab with issue
	 * #619 — so no manifest sits at `false` today: the flag is what keeps a *fourth*
	 * provider's intermediate phases from carrying traffic before its contract is
	 * complete and its ingress route is served.
	 *
	 * It is **not** a selection mechanism — `ProjectConfig.scm` is, since issue #478
	 * (`src/config/schema.ts`). The two compose: a project that selects a provider
	 * declaring `runtimeReady: false` gets a loud, specific throw rather than that
	 * provider or a fallback to another, and a project that selects nothing resolves
	 * only when exactly one manifest is runtime-ready.
	 *
	 * `requireSCMProvider(id)` deliberately does not consult `runtimeReady`: an
	 * explicit ID lookup for an enqueued job identity is intentionally exempt since
	 * the envelope provider ID is explicitly specified.
	 */
	readonly runtimeReady?: boolean;
	/**
	 * This provider's reference name for each of the contract's two credentials
	 * (issue #628) — the declaration a project's `credentials.scm[<this id>]` map is
	 * validated against (`src/config/schema.ts`), and the source of the keys a new
	 * project is seeded with. Every provider declares both roles; no two providers
	 * may share an `envVarKey`, or storing one provider's secret would overwrite
	 * another's (asserted by `tests/unit/integrations/scm/scm-conformance.test.ts`).
	 */
	readonly credentialRoles: readonly ScmCredentialRoleSpec[];
	/** The provider implementation — one shared, stateless instance (see above). */
	readonly provider: SCMProvider;
}

/** Whether shared code may route real traffic to `manifest` — see {@link SCMProviderManifest.runtimeReady}. */
export function isRuntimeReadySCMProvider(manifest: SCMProviderManifest): boolean {
	return manifest.runtimeReady !== false;
}
