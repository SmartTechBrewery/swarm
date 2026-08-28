/**
 * scmProviderRegistry — the process-singleton registry of SCM provider manifests.
 *
 * Providers register themselves at module-load time via `registerSCMProvider()`
 * (see each provider's `index.ts`); shared code looks them up by `id` through
 * `getSCMProvider()` / `listSCMProviders()` instead of constructing a concrete
 * integration. This is the "adding a provider never requires editing dispatch
 * code" invariant from ai/CODING_STANDARDS.md "Module shape for a provider".
 *
 * The SCM twin of `src/integrations/pm/registry.ts`, kept as a separate registry
 * (rather than one cross-category `integrationRegistry`) for the same reason the
 * PM one is: nothing needs to enumerate both categories together yet.
 *
 * Ingress and the SCM-driven triggers resolve their provider here as of issue
 * #385 (the receiver mounts every runtime-ready registered manifest's `webhookRoute`; the
 * worker resolves a dequeued job's `providerId` into the provider it injects
 * into the trigger context). The outbound, project-scoped mutations joined with
 * issue #386 via {@link requireProjectSCMProvider} — phase delivery, the
 * worker's PR-title read and failure comments, durable merge execution, and the
 * router's server-side delivery default. That project-scoped lookup selects on
 * the `ProjectConfig.scm` discriminator since issue #478, so several providers
 * can be runtime-ready at once with each project routing to its own.
 *
 * Duplicate-id registrations throw — that's how a provider module cloned from a
 * sibling but not renamed gets caught at startup rather than silently shadowing
 * the original.
 */

import type { ProjectConfig } from '../../config/schema.js';
import type { SCMProvider, ScmCredentialRole, ScmType } from '../../scm/types.js';
import {
	isRuntimeReadySCMProvider,
	type SCMProviderManifest,
	type ScmCredentialRoleSpec,
} from './manifest.js';

const registry: SCMProviderManifest[] = [];
const byId = new Map<string, SCMProviderManifest>();

export function registerSCMProvider(manifest: SCMProviderManifest): void {
	if (byId.has(manifest.id)) {
		throw new Error(
			`SCM provider '${manifest.id}' already registered — duplicate ids are not allowed`,
		);
	}
	registry.push(manifest);
	byId.set(manifest.id, manifest);
}

/** Look up a registered manifest by id, or `null` when none is registered. */
export function getSCMProvider(id: string): SCMProviderManifest | null {
	return byId.get(id) ?? null;
}

/**
 * Resolve a registered provider implementation by id, throwing when none is
 * registered. For call sites holding an id that *must* resolve — a durable queue
 * job's `providerId`, which only this process's own ingress could have written —
 * where a miss means the entrypoint failed to load, i.e. a wiring bug rather than
 * a runtime condition.
 */
export function requireSCMProvider(id: string): SCMProvider {
	const manifest = getSCMProvider(id);
	if (!manifest) {
		throw new Error(
			`SCM provider '${id}' is not registered — did src/integrations/entrypoint.ts fail to load?`,
		);
	}
	return manifest.provider;
}

/**
 * Resolve the SCM provider a project's repository lives on — the lookup every
 * project-scoped call site uses (phase delivery, the worker's PR-title read and
 * failure comments, durable merge execution, the router's server-side delivery)
 * so none of them names a concrete provider (ai/RULES.md §2).
 *
 * Real project→provider selection since issue #478, keyed on the config
 * discriminator `ProjectConfig.scm` (`src/config/schema.ts`) — the SCM twin of
 * `pm.type`, validated at the config boundary rather than pattern-matched here.
 * Two or more providers can therefore be runtime-ready at once, each project
 * routing to its own:
 *
 * - **`project.scm` set** — the named manifest, which must be registered *and*
 *   runtime-ready ({@link SCMProviderManifest.runtimeReady}). Either miss throws
 *   naming the project and what it asked for; neither ever falls back to another
 *   provider, since resolving a project's operations onto a provider it did not
 *   name is the exact failure this lookup exists to prevent.
 * - **`project.scm` absent** — the sole runtime-ready provider. It is a statement of
 *   an unambiguous situation, not a preference order: with zero or with two or more
 *   runtime-ready providers there is no "the" provider, so this throws and tells the
 *   operator to set `scm` rather than picking whichever manifest registered first.
 *
 *   **That branch stopped resolving with issue #618**, which made Bitbucket the
 *   second runtime-ready provider, and issue #619 (GitLab) took the count to three.
 *   It was the back-compat path for installations predating the discriminator; from
 *   #618 on, every project must state its provider. The throw is the migration
 *   notice — it names the project and lists the ids to choose from — and the fix is
 *   one field: set `"scm": "github"` on each existing project in `swarm.config.json`
 *   and run `swarm config apply` (docs/configuration.md). Deliberately not defaulted
 *   to `github` in the schema: a silent default would route a *new* Bitbucket or
 *   GitLab project's operations onto GitHub, which is the exact failure this lookup
 *   exists to prevent.
 *
 * The runtime-ready filter still gates a *selected* provider too: a manifest that
 * declares `runtimeReady: false` is registered so its own tests and follow-up work
 * can resolve it by id, and is deliberately unable to serve traffic until the work
 * completing that provider flips the flag. Every registered provider has now made
 * that call (GitHub, then Bitbucket with #618, then GitLab with #619), so the filter
 * is there for the fourth one while it is under construction.
 * {@link requireSCMProvider} stays exempt from the filter — its id comes from an
 * enqueued job's envelope, written by this process's own ingress, and that lookup
 * must stay event-accurate.
 */
export function requireProjectSCMProvider(project: ProjectConfig): SCMProvider {
	return requireProjectSCMManifest(project).provider;
}

/**
 * The **id** of the manifest {@link requireProjectSCMProvider} would resolve — same
 * selection rules, same three throws.
 *
 * Its own lookup because a caller that needs the provider a project runs on as a
 * *value* — the worker operator's credential is stored per `(worker, provider)`
 * (issue #765) — must not write `project.scm ?? 'github'`. That fallback is exactly
 * the hardcoding the neutral contract exists to remove, and it would resolve a
 * Bitbucket project's dispatch against a GitHub credential.
 */
export function requireProjectSCMProviderId(project: ProjectConfig): ScmType {
	return requireProjectSCMManifest(project).id;
}

/** The shared body of the two project-scoped lookups above. */
function requireProjectSCMManifest(project: ProjectConfig): SCMProviderManifest {
	const selected = project.scm;
	if (selected) {
		const manifest = getSCMProvider(selected);
		if (!manifest) {
			throw new Error(
				`Cannot resolve the SCM provider for project '${project.id}': it selects '${selected}', ` +
					'which is not registered — is that provider implemented, and did ' +
					`src/integrations/entrypoint.ts fail to load? Registered: ${describeIds(registry)}.`,
			);
		}
		if (!isRuntimeReadySCMProvider(manifest)) {
			throw new Error(
				`Cannot resolve the SCM provider for project '${project.id}': it selects '${selected}', ` +
					'which is registered but not runtime-ready (SCMProviderManifest.runtimeReady), so it ' +
					'cannot serve traffic yet — SWARM will not fall back to another provider. ' +
					`Runtime-ready: ${describeIds(registry.filter(isRuntimeReadySCMProvider))}.`,
			);
		}
		return manifest;
	}

	const runtimeReady = registry.filter(isRuntimeReadySCMProvider);
	const only = runtimeReady[0];
	if (runtimeReady.length !== 1 || !only) {
		throw new Error(
			`Cannot resolve the SCM provider for project '${project.id}': it selects no provider and ` +
				`${runtimeReady.length} of ${registry.length} registered are runtime-ready, expected ` +
				`exactly one — set "scm" on the project config to one of: ${describeIds(runtimeReady)} ` +
				'(or did src/integrations/entrypoint.ts fail to load?).',
		);
	}
	return only;
}

/** Render manifest ids for an error message, so an empty list reads as words rather than as nothing. */
function describeIds(manifests: readonly SCMProviderManifest[]): string {
	return manifests.length ? manifests.map((manifest) => manifest.id).join(', ') : 'none';
}

export function listSCMProviders(): readonly SCMProviderManifest[] {
	// Return a shallow clone so callers can't splice the source array.
	return registry.slice();
}

/** One `(provider, role)` pair eligible for an instance-level default (issue #769). */
export interface InstanceDefaultScmRole {
	readonly providerId: ScmType;
	readonly providerLabel: string;
	readonly role: ScmCredentialRole;
	/** The provider's conventional key for the role — what the admin surface displays. */
	readonly envVarKey: string;
}

/**
 * Every `(provider, role)` pair whose spec declares
 * {@link ScmCredentialRoleSpec.instanceDefault}, across the **runtime-ready**
 * registered manifests, in registration order (issue #769).
 *
 * Runtime-readiness is part of eligibility, for `runtimeReadyScmProvider`'s reason
 * (`src/api/routers/credentials.ts`): no project may route to a provider that is
 * registered but not runtime-ready, so offering an instance default for it would only
 * invite an operator to configure something that cannot run.
 *
 * The enumeration the admin surface offers — nothing here is consulted at credential
 * resolution time.
 */
export function listInstanceDefaultScmRoles(): readonly InstanceDefaultScmRole[] {
	return registry.filter(isRuntimeReadySCMProvider).flatMap((manifest) =>
		manifest.credentialRoles
			.filter((spec) => spec.instanceDefault === true)
			.map((spec) => ({
				providerId: manifest.id,
				providerLabel: manifest.label,
				role: spec.role,
				envVarKey: spec.envVarKey,
			})),
	);
}

/**
 * Test-only helper. Production code MUST NOT call this. Clears the registry
 * between tests so registrations from one test don't leak into the next.
 */
export function _resetSCMProviderRegistryForTesting(): void {
	registry.length = 0;
	byId.clear();
}
