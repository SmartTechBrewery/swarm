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
	// (`tests/unit/integrations/scm/scm-conformance.test.ts`) — but nothing selects a
	// project's SCM provider, so this stays `false`: that is what makes registering a
	// third manifest a no-op for GitHub, since the project-scoped lookup keeps
	// resolving the one runtime-ready provider instead of refusing to choose
	// (`../registry.ts`). Flipping it needs project→provider selection plus a served
	// ingress route — the separate follow-up Bitbucket is already waiting on, not a
	// phase of #295 (ai/RULES.md §2).
	runtimeReady: false,
	// One shared instance: the integration is stateless and takes `project` per
	// call, so there is nothing to construct per project (see the manifest doc).
	provider: new GitLabSCMIntegration(),
};

registerSCMProvider(gitlabScmManifest);
