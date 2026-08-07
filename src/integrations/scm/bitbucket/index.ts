/**
 * Bitbucket SCM provider — registration entry.
 *
 * Side-effect module: importing it builds the provider's `SCMProviderManifest`
 * and registers it into `scmProviderRegistry` at module load. It's pulled in by
 * the single canonical entrypoint (`src/integrations/entrypoint.ts`), so no
 * runtime surface imports this file directly — the "one import line in the
 * barrel" half of the registration pattern (ai/CODING_STANDARDS.md "Module shape
 * for a provider").
 *
 * The manifest is also exported for tests and for callers that want the
 * provider's pieces without going through the registry.
 */

import type { SCMProviderManifest } from '../manifest.js';
import { registerSCMProvider } from '../registry.js';
import { BitbucketSCMIntegration } from './scm-integration.js';

export const bitbucketScmManifest: SCMProviderManifest = {
	id: 'bitbucket',
	label: 'Bitbucket',
	category: 'scm',
	// Declared so the route this provider *will* answer on is decided in one place,
	// but not served: `runtimeReady: false` keeps the receiver from mounting it
	// (`src/router/webhook-receiver.ts`).
	webhookRoute: '/bitbucket/webhook',
	// The contract is complete as of issue #296 phase 4/4 — no method is stubbed
	// (`tests/unit/integrations/scm/scm-conformance.test.ts`) — but this provider has
	// not been declared ready to carry traffic, so the flag stays `false`: registering
	// the manifest is a no-op for GitHub, since the project-scoped lookup routes only
	// to runtime-ready manifests and a project naming `bitbucket` gets a loud error
	// rather than a silent GitHub fallback (`../registry.ts`). Project→provider
	// selection is no longer what's missing — `project.scm` is that, since issue #478.
	// Flipping this needs a served ingress route and belongs to #457, the issue that
	// completes this provider (ai/RULES.md §2).
	runtimeReady: false,
	// One shared instance: the integration is stateless and takes `project` per
	// call, so there is nothing to construct per project (see the manifest doc).
	provider: new BitbucketSCMIntegration(),
};

registerSCMProvider(bitbucketScmManifest);
