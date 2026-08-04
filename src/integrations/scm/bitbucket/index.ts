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
	// Declared now so the route this provider *will* answer on is decided in one
	// place, but not served: `runtimeReady: false` keeps the receiver from mounting
	// it (`src/router/webhook-receiver.ts`) while `readWebhookRequest` still throws.
	webhookRoute: '/bitbucket/webhook',
	// Registered but not reachable at runtime: half the contract still throws
	// (issue #296 phases 2–4), and nothing selects a project's SCM provider yet.
	// Keeping this `false` is what makes registering a second manifest a no-op for
	// GitHub — the project-scoped lookup keeps resolving the one runtime-ready
	// provider instead of refusing to choose (`../registry.ts`).
	runtimeReady: false,
	// One shared instance: the integration is stateless and takes `project` per
	// call, so there is nothing to construct per project (see the manifest doc).
	provider: new BitbucketSCMIntegration(),
};

registerSCMProvider(bitbucketScmManifest);
