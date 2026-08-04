/**
 * Single canonical registration entrypoint for every SWARM integration.
 *
 * Every runtime surface that needs providers registered (the router today; the
 * worker once SWARM-17 builds it) imports this file as a side-effect module. The
 * imports below trigger each provider's module-load registration into
 * `pmProviderRegistry` / `scmProviderRegistry`.
 *
 * Why one file: Cascade collapsed per-surface barrel lists to a single
 * entrypoint after four production bugs from a provider registered on one
 * surface but not another (see Cascade's `src/integrations/entrypoint.ts`).
 * SWARM adopts the same shape up front so adding a provider is one import here
 * plus its own folder — never an edit to dispatch/orchestration code
 * (ai/CODING_STANDARDS.md "Module shape for a provider").
 *
 * This imports each provider index directly. A `src/integrations/<kind>/index.ts`
 * barrel (mirroring Cascade's) is still deferred: with three imports the list is
 * shorter than the barrel that would front it, and one of them is a provider
 * being built out phase by phase whose registration reads better named here than
 * hidden behind an aggregate.
 *
 * Registering SCM here adds no module-load weight to any surface: the GitHub
 * Projects provider already imports `GitHubSCMIntegration` for its own credential
 * scoping, so this module graph loaded the GitHub SCM module either way.
 */

// PM: GitHub Projects. Registers its manifest into pmProviderRegistry.
import './pm/github-projects/index.js';
// SCM: GitHub. Registers its manifest into scmProviderRegistry.
import './scm/github/index.js';
// SCM: Bitbucket (issue #296, contract complete). Registers with
// `runtimeReady: false` — discoverable by id, but not selectable and not served a
// webhook route until project→provider selection exists (a follow-up).
import './scm/bitbucket/index.js';

/**
 * Explicit no-op for call sites that want registration to be visible rather than
 * relying on the bare import side effect. In production, importing this module is
 * already enough — the `import` above has done the work by the time this is
 * callable.
 */
export function registerAllIntegrations(): void {
	// Intentionally empty — see the module doc comment.
}
