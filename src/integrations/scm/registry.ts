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
 * router's server-side delivery default.
 *
 * Duplicate-id registrations throw — that's how a provider module cloned from a
 * sibling but not renamed gets caught at startup rather than silently shadowing
 * the original.
 */

import type { ProjectConfig } from '../../config/schema.js';
import type { SCMProvider } from '../../scm/types.js';
import { isRuntimeReadySCMProvider, type SCMProviderManifest } from './manifest.js';

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
 * Deliberately **no selection logic and no fallback ordering**: `ProjectConfig`
 * carries no provider discriminator (`src/config/schema.ts`) and exactly one SCM
 * provider is runtime-ready, so "this project's provider" is unambiguous today.
 * Inventing a config field or a preference order before a second provider exists
 * would be speculative (ai/CODING_STANDARDS.md); instead this asserts the
 * invariant and throws the moment it stops holding, so project→provider
 * selection gets designed *with* the second provider rather than silently
 * resolving to whichever manifest happened to register first.
 *
 * The assertion counts only *runtime-ready* manifests
 * ({@link SCMProviderManifest.runtimeReady}), so a provider being built out phase
 * by phase — Bitbucket, issue #296 — can register without answering for every
 * project while half its contract still throws. The forcing function is
 * unchanged: the second manifest to claim runtime readiness lands here as a
 * throw.
 */
export function requireProjectSCMProvider(project: ProjectConfig): SCMProvider {
	const runtimeReady = registry.filter(isRuntimeReadySCMProvider);
	const only = runtimeReady[0];
	if (runtimeReady.length !== 1 || !only) {
		throw new Error(
			`Cannot resolve the SCM provider for project '${project.id}': ` +
				`${runtimeReady.length} runtime-ready of ${registry.length} registered, expected exactly ` +
				'one — did src/integrations/entrypoint.ts fail to load, or did a second provider register ' +
				'as runtime-ready before project→provider selection existed?',
		);
	}
	return only.provider;
}

export function listSCMProviders(): readonly SCMProviderManifest[] {
	// Return a shallow clone so callers can't splice the source array.
	return registry.slice();
}

/**
 * Test-only helper. Production code MUST NOT call this. Clears the registry
 * between tests so registrations from one test don't leak into the next.
 */
export function _resetSCMProviderRegistryForTesting(): void {
	registry.length = 0;
	byId.clear();
}
