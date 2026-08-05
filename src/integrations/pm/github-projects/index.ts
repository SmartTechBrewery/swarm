/**
 * GitHub Projects PM provider — registration entry.
 *
 * Side-effect module: importing it builds the provider's `PMProviderManifest`
 * and registers it into `pmProviderRegistry` at module load. It's pulled in by
 * the single canonical entrypoint (`src/integrations/entrypoint.ts`), so no
 * runtime surface imports this file directly — that's the "one import line in
 * the barrel" half of the registration pattern (ai/CODING_STANDARDS.md "Module
 * shape for a provider").
 *
 * The manifest is also exported for tests and for callers that want the
 * provider's pieces without going through the registry.
 */

import { GitHubProjectsRouterAdapter } from '../../../router/adapters/github-projects.js';
import { PM_WEBHOOK_SECRET_ROLE, type PMProviderManifest } from '../manifest.js';
import { registerPMProvider } from '../registry.js';
import { githubProjectsConfigSchema } from './config-schema.js';
import { createGitHubProjectsProvider } from './provider.js';
import { verifyGitHubProjectsWebhookSignature } from './webhook.js';

export const githubProjectsManifest: PMProviderManifest = {
	id: 'github-projects',
	label: 'GitHub Projects',
	category: 'pm',
	createProvider: createGitHubProjectsProvider,
	configSchema: githubProjectsConfigSchema,
	routerAdapter: new GitHubProjectsRouterAdapter(),
	// The one credential this provider resolves for itself (issue #497), and it is
	// the *shared* GitHub webhook secret: the board and the repo are literally the
	// same webhook, so the role inherits `credentials.webhookSecret` rather than
	// asking a project to configure the same reference twice. Declaring that as data
	// keeps the reach out of shared resolution code (ai/RULES.md §2).
	//
	// Its **persona tokens** are deliberately absent: GitHub Projects scopes board
	// writes with `GitHubSCMIntegration`'s persona helpers (`./provider.ts`), because
	// board and repo are the same account — the named cross-category reach in
	// ai/RULES.md §2, not a credential of its own. Declaring `reviewer`/implementer
	// roles here would duplicate that resolution and imply a project could point the
	// board at a different account than the repo, which GitHub does not allow.
	credentialRoles: [
		{
			role: PM_WEBHOOK_SECRET_ROLE,
			label: 'Webhook Secret',
			envVarKey: 'SCM_WEBHOOK_SECRET',
			inheritsSharedCredential: 'webhookSecret',
		},
	],
	// The same route and secret as the GitHub SCM provider: GitHub delivers
	// `projects_v2_item` on the very webhook the repo's events arrive on
	// (docs/github-projects-v2-api.md §5), so the receiver serves this as a
	// co-tenant of `/github/webhook` rather than mounting a second handler.
	webhookRoute: '/github/webhook',
	verifyWebhookSignature: verifyGitHubProjectsWebhookSignature,
	// Board discovery reads the authenticated user's (and their orgs') Projects v2
	// boards; state discovery reads a selected board's single-select Status field.
	discovery: ['containers', 'states'],
};

registerPMProvider(githubProjectsManifest);
