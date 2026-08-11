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
	// Unchanged from before the registry existed: GitHub Projects' `projects_v2_item`
	// board webhook is delivered to this same path and shares its HMAC secret
	// (docs/github-projects-v2-api.md §5), so the path must stay exactly this.
	webhookRoute: '/github/webhook',
	// GitHub's own reference names for the contract's two credentials (issue #628).
	// Provider-named rather than the neutral `SCM_*` pair, so storing GitHub's
	// reviewer token cannot overwrite GitLab's — and these two strings are exactly
	// the pre-#290 legacy names, so an installation that never moved off them
	// migrates to the keys it already stores. A project created since #290 keeps its
	// `SCM_TOKEN_REVIEWER` / `SCM_WEBHOOK_SECRET` references instead; these are only
	// the conventional defaults for a project with no reference yet (see the spec).
	credentialRoles: [
		{ role: 'reviewer', envVarKey: 'GITHUB_TOKEN_REVIEWER' },
		{ role: 'webhookSecret', envVarKey: 'GITHUB_WEBHOOK_SECRET' },
	],
	// One shared instance: the integration is stateless and takes `project` per
	// call, so there is nothing to construct per project (see the manifest doc).
	provider: new GitHubSCMIntegration(),
};

registerSCMProvider(githubScmManifest);
