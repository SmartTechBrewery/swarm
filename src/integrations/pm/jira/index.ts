/**
 * Jira PM provider — registration entry.
 *
 * Side-effect module: importing it builds the provider's `PMProviderManifest`
 * and registers it into `pmProviderRegistry` at module load, pulled in by the
 * single canonical entrypoint (`src/integrations/entrypoint.ts`) exactly as the
 * GitHub Projects and Linear entries are (ai/CODING_STANDARDS.md "Module shape
 * for a provider").
 *
 * It lands **last** of the provider's six phases on purpose: the conformance
 * suite (`tests/unit/integrations/pm/pm-conformance.test.ts`) scans each
 * *registered* manifest's `PMProvider`/`PMRouterAdapter` methods for a
 * not-implemented sentinel, so registering while any of them was a stub would
 * have forced an exemption that disabled the gate for the providers already
 * passing it (ai/RULES.md §2 "Register when the contract is satisfied, not when
 * the folder appears" — GitLab's #295 and Linear's #530 sequencing).
 *
 * From here `pm.type: 'jira'` is a fully selectable provider: the receiver
 * mounts and authenticates `/jira/webhook`, `requireProjectPMProvider` resolves
 * this manifest, and the dashboard's board-mapping screen discovers Jira
 * projects and their workflow statuses.
 */

import { JiraRouterAdapter } from '../../../router/adapters/jira.js';
import { PM_WEBHOOK_SECRET_ROLE, type PMProviderManifest } from '../manifest.js';
import { registerPMProvider } from '../registry.js';
import { jiraConfigSchema } from './config-schema.js';
import { JIRA_API_TOKEN_ROLE, JIRA_EMAIL_ROLE } from './credentials.js';
import { createJiraProvider } from './provider.js';
import { verifyJiraWebhookSignature } from './webhook.js';

export const jiraManifest: PMProviderManifest = {
	id: 'jira',
	label: 'Jira',
	category: 'pm',
	createProvider: createJiraProvider,
	configSchema: jiraConfigSchema,
	routerAdapter: new JiraRouterAdapter(),
	// Three roles — Jira Cloud authenticates with basic auth, so the email and the
	// API token are two halves of one credential — and **none** inherits a shared
	// SCM credential, the rule `PmCredentialRoleSpec.inheritsSharedCredential`
	// states for exactly this case: a Jira site is a separate system from the
	// GitHub repo it is paired with, so borrowing the repo side's webhook secret (as
	// GitHub Projects legitimately does, board and repo being one webhook) would
	// point Jira's verifier at a secret GitHub chose and Jira never signs with.
	credentialRoles: [
		{
			role: JIRA_EMAIL_ROLE,
			label: 'Account Email',
			// Plain prose, not markdown: the dashboard renders a description as text
			// (`pm-credentials-panel.tsx`), so backticks would show up literally.
			description:
				'Atlassian account email the API token belongs to — the username half of Jira Cloud basic auth. Its account is the identity board loop prevention recognizes as SWARM, so do not use the account a human moves cards from.',
			envVarKey: 'JIRA_EMAIL',
		},
		{
			role: JIRA_API_TOKEN_ROLE,
			label: 'API Token',
			description:
				'Atlassian API token for that account, created from Atlassian account settings, which SWARM uses to read and write the board. It pairs with the account email: neither half authenticates a request on its own.',
			envVarKey: 'JIRA_API_TOKEN',
		},
		{
			role: PM_WEBHOOK_SECRET_ROLE,
			label: 'Webhook Secret',
			description:
				'Secret you enter on the Jira webhook screen, which signs board deliveries. It is the board webhook secret only — not the repository one.',
			envVarKey: 'JIRA_WEBHOOK_SECRET',
			// Deliberately **not** `optional`, unlike Cascade's Jira manifest. SWARM's
			// verifier fails closed on a null secret (`./webhook.ts`), so an optional
			// role would validate happily at `swarm config apply` and then 401 every
			// delivery — a board that looks configured and silently never triggers.
			// Requiring it moves that failure to config validation, where it names the
			// role and its env var.
		},
	],
	// Its own route: Jira posts to a URL an operator configures per webhook, and
	// nothing else serves this path, so the receiver mounts a GET ping + POST pair
	// for it rather than co-tenanting an SCM route (`src/router/webhook-receiver.ts`).
	// Jira's `sha256=<hex>` framing coincides with GitHub's, but the secret does
	// not — see `./webhook.ts`.
	webhookRoute: '/jira/webhook',
	verifyWebhookSignature: verifyJiraWebhookSignature,
	// A container is a Jira **project** and a state is one of that project's
	// workflow **statuses**, which is why both capabilities are declared: the
	// board-mapping screen picks a project, then maps SWARM's canonical status keys
	// onto its statuses.
	discovery: ['containers', 'states'],
};

registerPMProvider(jiraManifest);
