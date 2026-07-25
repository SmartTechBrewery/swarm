/**
 * GitHub SCM provider — registration entry.
 *
 * Side-effect module: importing it builds the provider's `SCMProviderManifest`
 * and registers it into `scmProviderRegistry` at module load. It's pulled in by
 * the single canonical entrypoint (`src/integrations/entrypoint.ts`), so no
 * runtime surface imports this file directly — that's the "one import line in the
 * barrel" half of the registration pattern (ai/CODING_STANDARDS.md "Module shape
 * for a provider").
 *
 * The manifest is also exported for tests and for callers that want the
 * provider's pieces without going through the registry.
 */

import type { SCMProviderManifest } from '../manifest.js';
import { registerSCMProvider } from '../registry.js';
import { GitHubSCMIntegration } from './scm-integration.js';

export const githubScmManifest: SCMProviderManifest = {
	id: 'github',
	label: 'GitHub',
	category: 'scm',
	// One shared instance: the integration is stateless and takes `project` per
	// call, so there is nothing to construct per project (see the manifest doc).
	provider: new GitHubSCMIntegration(),
};

registerSCMProvider(githubScmManifest);
