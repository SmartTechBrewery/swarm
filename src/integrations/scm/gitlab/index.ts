/**
 * GitLab SCM provider — registration entry.
 *
 * Side-effect module: importing it builds the provider's `SCMProviderManifest`
 * and registers it into `scmProviderRegistry` at module load. It's pulled in by
 * the single canonical entrypoint (`src/integrations/entrypoint.ts`), so no
 * runtime surface imports this file directly — the "one import line in the
 * barrel" half of the registration pattern (ai/CODING_STANDARDS.md "Module shape
 * for a provider").
 *
 * **Why this arrives in the last phase rather than the first.** Bitbucket
 * registered a `runtimeReady: false` manifest from its own phase 1; GitLab
 * deliberately registered nothing until now, because the multi-provider
 * conformance suite (`tests/unit/integrations/scm/scm-conformance.test.ts`)
 * asserts that no *registered* manifest stubs a contract method. A stub-bearing
 * manifest would have forced an exemption that disabled that gate for the two
 * providers already passing it, so registration lands together with the last
 * stub's removal — and passing the gate is this phase's job (ai/TESTING.md).
 *
 * The manifest is also exported for tests and for callers that want the
 * provider's pieces without going through the registry.
 */

import type { SCMProviderManifest } from '../manifest.js';
import { registerSCMProvider } from '../registry.js';
import { GitLabSCMIntegration } from './scm-integration.js';

export const gitlabScmManifest: SCMProviderManifest = {
	id: 'gitlab',
	label: 'GitLab',
	category: 'scm',
	// Declared so the route this provider *will* answer on is decided in one place,
	// but not served: `runtimeReady: false` keeps the receiver from mounting it
	// (`src/router/webhook-receiver.ts`).
	webhookRoute: '/gitlab/webhook',
	// The contract is complete as of issue #295 phase 4/4 — no method is stubbed
	// (`tests/unit/integrations/scm/scm-conformance.test.ts`) — but this provider has
	// not been declared ready to carry traffic, so the flag stays `false` for the same
	// reason Bitbucket's does: the project-scoped lookup routes only to runtime-ready
	// manifests, and a project naming `gitlab` gets a loud error rather than a silent
	// GitHub fallback (`../registry.ts`). Project→provider selection landed with issue
	// #478 (`project.scm`); what is left is a served ingress route and the readiness
	// call, which belong to the issue completing this provider (ai/RULES.md §2).
	runtimeReady: false,
	// One shared instance: the integration is stateless and takes `project` per
	// call, so there is nothing to construct per project (see the manifest doc).
	provider: new GitLabSCMIntegration(),
};

registerSCMProvider(gitlabScmManifest);
