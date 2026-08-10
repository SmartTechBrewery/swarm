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
 * barrel (mirroring Cascade's) is still deferred: with six imports the list is
 * shorter than the barrel that would front it, and each line's comment is where
 * a reader learns which providers actually carry traffic — a distinction an
 * aggregate would hide.
 *
 * Registering SCM here adds no module-load weight to any surface: the GitHub
 * Projects provider already imports `GitHubSCMIntegration` for its own credential
 * scoping, so this module graph loaded the GitHub SCM module either way.
 */

// PM: GitHub Projects. Registers its manifest into pmProviderRegistry.
import './pm/github-projects/index.js';
// PM: Linear (issue #491, contract complete as of its phase 5/6). Registers its
// manifest into pmProviderRegistry — selectable from `pm.type` at once, since a PM
// manifest carries no `runtimeReady` flag.
import './pm/linear/index.js';
// PM: Jira (issue #490, contract complete as of its phase 4/6). Registers its
// manifest into pmProviderRegistry — selectable from `pm.type` at once, since a PM
// manifest carries no `runtimeReady` flag.
import './pm/jira/index.js';
// SCM: GitHub. Registers its manifest into scmProviderRegistry.
import './scm/github/index.js';
// SCM: Bitbucket (issue #296, contract complete). Runtime-ready since issue #618:
// routable from `project.scm` and served at `/bitbucket/webhook`, alongside GitHub.
import './scm/bitbucket/index.js';
// SCM: GitLab (issue #295, contract complete as of its phase 4/4). Registers with
// `runtimeReady: false` — discoverable by id, but neither routable from
// `project.scm` nor served a webhook route until issue #619 flips the flag and
// mounts its ingress, the way #618 did for Bitbucket.
import './scm/gitlab/index.js';

/**
 * Explicit no-op for call sites that want registration to be visible rather than
 * relying on the bare import side effect. In production, importing this module is
 * already enough — the `import` above has done the work by the time this is
 * callable.
 */
export function registerAllIntegrations(): void {
	// Intentionally empty — see the module doc comment.
}
