/**
 * Linear PM provider — registration entry.
 *
 * Side-effect module: importing it builds the provider's `PMProviderManifest`
 * and registers it into `pmProviderRegistry` at module load, pulled in by the
 * single canonical entrypoint (`src/integrations/entrypoint.ts`) exactly as the
 * GitHub Projects entry is (ai/CODING_STANDARDS.md "Module shape for a
 * provider").
 *
 * It lands **last** of the provider's six phases on purpose: the conformance
 * suite (`tests/unit/integrations/pm/pm-conformance.test.ts`) scans each
 * *registered* manifest's `PMProvider`/`PMRouterAdapter` methods for a
 * not-implemented sentinel, so registering while any of them was a stub would
 * have forced an exemption that disabled the gate for the provider already
 * passing it (ai/RULES.md §2 "Register when the contract is satisfied, not when
 * the folder appears" — GitLab's #295 sequencing).
 *
 * From here `pm.type: 'linear'` is a fully selectable provider: the receiver
 * mounts and authenticates `/linear/webhook`, `requireProjectPMProvider`
 * resolves this manifest, and the dashboard's board-mapping screen discovers
 * Linear teams and their workflow states.
 */

import { LinearRouterAdapter } from '../../../router/adapters/linear.js';
import { PM_WEBHOOK_SECRET_ROLE, type PMProviderManifest } from '../manifest.js';
import { registerPMProvider } from '../registry.js';
import { linearBlankPm, linearConfigSchema } from './config-schema.js';
import { LINEAR_API_KEY_ROLE } from './credentials.js';
import { createLinearProvider } from './provider.js';
import { verifyLinearWebhookSignature } from './webhook.js';

export const linearManifest: PMProviderManifest = {
	id: 'linear',
	label: 'Linear',
	category: 'pm',
	createProvider: createLinearProvider,
	configSchema: linearConfigSchema,
	// No `blankPmDiscoveryBlocker`: both capabilities read the API key's own workspace
	// — its teams, then one selected team's workflow states — so neither needs anything
	// out of the `pm` member, and an incoming Linear board is discoverable with nothing
	// configured but the key.
	blankPm: linearBlankPm,
	routerAdapter: new LinearRouterAdapter(),
	// Two roles, and **neither** inherits a shared SCM credential — the rule
	// `PmCredentialRoleSpec.inheritsSharedCredential` states for exactly this
	// case: a Linear board is a separate system from the GitHub repo it is paired
	// with, so borrowing the repo side's webhook secret (as GitHub Projects legitimately
	// does, board and repo being one webhook) would point Linear's verifier at a
	// secret GitHub chose and Linear never signs with.
	credentialRoles: [
		{
			role: LINEAR_API_KEY_ROLE,
			label: 'API Key',
			// Plain prose, not markdown: the dashboard renders a description as text
			// (`pm-credentials-panel.tsx`), so backticks would show up literally.
			description:
				'Linear personal API key from Linear Settings that SWARM uses to read and write the board. Its account is the identity board loop prevention recognizes as SWARM, so do not use the account a human moves cards from.',
			envVarKey: 'LINEAR_API_KEY',
		},
		{
			role: PM_WEBHOOK_SECRET_ROLE,
			label: 'Webhook Secret',
			description:
				'Signing secret Linear shows when you create the webhook. It signs board deliveries, and it is the board webhook secret only — not the repository one.',
			envVarKey: 'LINEAR_WEBHOOK_SECRET',
			// Deliberately **not** `optional`, unlike Cascade's Linear manifest.
			// SWARM's verifier fails closed on a null secret (`./webhook.ts`), so an
			// optional role would validate happily at `swarm config apply` and then
			// 401 every delivery — a board that looks configured and silently never
			// triggers. Requiring it moves that failure to config validation, where it
			// names the role and its env var.
		},
	],
	// Its own route: Linear posts to a URL an operator configures per webhook, and
	// nothing else serves this path, so the receiver mounts a GET ping + POST pair
	// for it rather than co-tenanting an SCM route (`src/router/webhook-receiver.ts`).
	webhookRoute: '/linear/webhook',
	verifyWebhookSignature: verifyLinearWebhookSignature,
	// A container is a Linear **team** and a state is that team's **workflow
	// state**, which is why both capabilities are declared: the board-mapping
	// screen picks a team, then maps SWARM's canonical status keys onto its states.
	discovery: ['containers', 'states'],
};

registerPMProvider(linearManifest);
