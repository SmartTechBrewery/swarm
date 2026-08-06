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
import { GITHUB_PROJECTS_API_TOKEN_ROLE } from './credentials.js';
import { createGitHubProjectsProvider } from './provider.js';
import { verifyGitHubProjectsWebhookSignature } from './webhook.js';

export const githubProjectsManifest: PMProviderManifest = {
	id: 'github-projects',
	label: 'GitHub Projects',
	category: 'pm',
	createProvider: createGitHubProjectsProvider,
	configSchema: githubProjectsConfigSchema,
	routerAdapter: new GitHubProjectsRouterAdapter(),
	// Two roles, and they are credentials of two different kinds.
	//
	// `apiToken` is the provider's **own** board credential (issue #537). It used to
	// be absent, and board reads/writes borrowed `GitHubSCMIntegration`'s implementer
	// persona instead — i.e. the worker-local `SWARM_OPERATOR_GH_TOKEN`. That made a
	// worker's SCM identity a hidden requirement of the API host and left a project
	// admin no way to configure board access; the token is now a project-scoped role
	// resolved through `credentials.pm` like any other provider's
	// (`./credentials.ts`), with no fallback to the operator token.
	//
	// `webhookSecret` is the *shared* GitHub webhook secret: the board and the repo
	// are literally the same webhook, so the role inherits `credentials.webhookSecret`
	// rather than asking a project to configure the same reference twice. Declaring
	// that as data keeps the reach out of shared resolution code (ai/RULES.md §2).
	credentialRoles: [
		{
			role: GITHUB_PROJECTS_API_TOKEN_ROLE,
			label: 'GitHub Projects API Token',
			description:
				'GitHub token the board is read and written with. Needs `repo` and `project` (fine-grained: repository Issues + Pull requests read/write and organization Projects read/write), plus `read:org` to discover organization-owned boards.',
			envVarKey: 'PM_GITHUB_PROJECTS_TOKEN',
		},
		{
			role: PM_WEBHOOK_SECRET_ROLE,
			label: 'Webhook Secret',
			description:
				"HMAC secret GitHub signs board deliveries with. It is the repository's webhook secret — one webhook carries both — so it is configured on the Source Control tab, not here.",
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
