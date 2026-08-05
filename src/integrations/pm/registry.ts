/**
 * pmProviderRegistry — the process-singleton registry of PM provider manifests.
 *
 * Providers register themselves at module-load time via `registerPMProvider()`
 * (see each provider's `index.ts`); shared code — the router today, more
 * surfaces later — looks them up by `id` through `getPMProvider()` /
 * `listPMProviders()` instead of hardcoding a concrete provider. This is the
 * "adding a provider never requires editing dispatch code" invariant from
 * ai/CODING_STANDARDS.md "Module shape for a provider".
 *
 * Mirrors Cascade's `src/integrations/pm/registry.ts`, trimmed to SWARM's MVP
 * (no cross-category `integrationRegistry` mirror — SWARM has only PM on the
 * manifest pattern for now).
 *
 * Project-scoped call sites resolve through {@link requireProjectPMProvider} /
 * {@link requireProjectPMAdapter} as of issue #297, so no pipeline, trigger,
 * worker, or router module constructs a concrete PM provider.
 *
 * Duplicate-id registrations throw — that's how a provider module cloned from a
 * sibling but not renamed gets caught at startup rather than silently shadowing
 * the original.
 */

import type { ProjectConfig } from '../../config/schema.js';
import type { PMRouterAdapter } from '../../pm/router-adapter.js';
import type { PMProvider } from '../../pm/types.js';
import type { PMProviderManifest } from './manifest.js';

const registry: PMProviderManifest[] = [];
const byId = new Map<string, PMProviderManifest>();

export function registerPMProvider(manifest: PMProviderManifest): void {
	if (byId.has(manifest.id)) {
		throw new Error(
			`PM provider '${manifest.id}' already registered — duplicate ids are not allowed`,
		);
	}
	registry.push(manifest);
	byId.set(manifest.id, manifest);
}

/** Look up a registered manifest by id, or `null` when none is registered. */
export function getPMProvider(id: string): PMProviderManifest | null {
	return byId.get(id) ?? null;
}

/**
 * Resolve the manifest a project's board lives on, throwing when nothing is
 * registered for it.
 *
 * Unlike the SCM side's `requireProjectSCMProvider`
 * (`src/integrations/scm/registry.ts`), this needs **no** single-provider
 * assertion and no `runtimeReady` flag: `project.pm.type` already *is* the config
 * discriminator, so project→provider selection is a plain registry lookup. Do not
 * copy SCM's assertion pattern here — it exists precisely because
 * `ProjectConfig` carries no SCM discriminator.
 *
 * A miss therefore means the id names a provider that hasn't been implemented (a
 * `PMType` value widened ahead of its connector — `src/pm/types.ts`) or that the
 * entrypoint failed to load: a wiring/config bug, not a runtime condition
 * (ai/CODING_STANDARDS.md "Error handling").
 */
function requireProjectPMManifest(project: ProjectConfig): PMProviderManifest {
	const manifest = getPMProvider(project.pm.type);
	if (!manifest) {
		throw new Error(
			`PM provider '${project.pm.type}' (project '${project.id}') is not registered — ` +
				'is the provider implemented, and did src/integrations/entrypoint.ts fail to load?',
		);
	}
	return manifest;
}

/**
 * Build the PM provider for a project — the lookup every project-scoped call site
 * uses (the PM-driven triggers, the worker's board comments, the router's
 * server-side delivery) so none of them names a concrete provider
 * (ai/RULES.md §2). See {@link requireProjectPMManifest} for why this needs no
 * single-provider assertion.
 */
export function requireProjectPMProvider(project: ProjectConfig): PMProvider {
	return requireProjectPMManifest(project).createProvider(project);
}

/**
 * Resolve the ingress adapter for a project's board — the `PMRouterAdapter`
 * counterpart of {@link requireProjectPMProvider}, for the call sites that ask a
 * board question rather than perform a board write (the status-change gate, the
 * worker's synthetic state-change event).
 */
export function requireProjectPMAdapter(project: ProjectConfig): PMRouterAdapter {
	return requireProjectPMManifest(project).routerAdapter;
}

export function listPMProviders(): readonly PMProviderManifest[] {
	// Return a shallow clone so callers can't splice the source array.
	return registry.slice();
}

/**
 * Test-only helper. Production code MUST NOT call this. Clears the registry
 * between tests so registrations from one test don't leak into the next.
 */
export function _resetPMProviderRegistryForTesting(): void {
	registry.length = 0;
	byId.clear();
}
