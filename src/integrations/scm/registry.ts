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
 * #385 (the receiver mounts every registered manifest's `webhookRoute`; the
 * worker resolves a dequeued job's `providerId` into the provider it injects
 * into the trigger context). Pipeline and worker-side mutations follow in #386.
 *
 * Duplicate-id registrations throw — that's how a provider module cloned from a
 * sibling but not renamed gets caught at startup rather than silently shadowing
 * the original.
 */

import type { SCMProvider } from '../../scm/types.js';
import type { SCMProviderManifest } from './manifest.js';

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
