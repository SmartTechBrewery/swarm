/**
 * Trello PM provider — registration entry.
 *
 * Side-effect module: importing it builds the provider's `PMProviderManifest`
 * and registers it into `pmProviderRegistry` at module load, pulled in by the
 * single canonical entrypoint (`src/integrations/entrypoint.ts`) exactly as the
 * GitHub Projects, Linear, and Jira entries are (ai/CODING_STANDARDS.md "Module
 * shape for a provider").
 *
 * It lands **last** of the provider's six phases on purpose: the conformance
 * suite (`tests/unit/integrations/pm/pm-conformance.test.ts`) scans each
 * *registered* manifest's `PMProvider`/`PMRouterAdapter` methods for a
 * not-implemented sentinel, so registering while any of them was a stub would
 * have forced an exemption that disabled the gate for the providers already
 * passing it (ai/RULES.md §2 "Register when the contract is satisfied, not when
 * the folder appears" — GitLab's #295, Linear's #530, and Jira's #580
 * sequencing). `supportsDependencies: false` is no such stub: the suite asserts
 * the flag is a boolean and that `listBlockers`/`addBlockedBy` carry no
 * sentinel, and this provider's are the contract's **declared opt-out**
 * (`./provider.ts`), so Trello registers with no exemption either.
 *
 * From here `pm.type: 'trello'` is a fully selectable provider: the receiver
 * mounts and authenticates `/trello/webhook`, `requireProjectPMProvider`
 * resolves this manifest, and the dashboard's board-mapping screen discovers
 * Trello boards and their lists.
 */

import { TrelloRouterAdapter } from '../../../router/adapters/trello.js';
import { PM_WEBHOOK_SECRET_ROLE, type PMProviderManifest } from '../manifest.js';
import { registerPMProvider } from '../registry.js';
import { trelloConfigSchema } from './config-schema.js';
import { TRELLO_API_KEY_ROLE, TRELLO_TOKEN_ROLE } from './credentials.js';
import { createTrelloProvider } from './provider.js';
import { verifyTrelloWebhookSignature } from './webhook.js';

export const trelloManifest: PMProviderManifest = {
	id: 'trello',
	label: 'Trello',
	category: 'pm',
	createProvider: createTrelloProvider,
	configSchema: trelloConfigSchema,
	routerAdapter: new TrelloRouterAdapter(),
	// Three roles — Trello authenticates with a **key/token pair** passed as query
	// parameters, and signs its deliveries with a third secret — and **none**
	// inherits a shared SCM credential, the rule
	// `PmCredentialRoleSpec.inheritsSharedCredential` states for exactly this case:
	// a Trello board is a separate system from the GitHub repo it is paired with, so
	// borrowing the repo side's webhook secret (as GitHub Projects legitimately does,
	// board and repo being one webhook) would point Trello's verifier at a secret
	// GitHub chose and Trello never signs with.
	credentialRoles: [
		{
			role: TRELLO_API_KEY_ROLE,
			label: 'API Key',
			// Plain prose, not markdown: the dashboard renders a description as text
			// (`pm-credentials-panel.tsx`), so backticks would show up literally.
			description:
				'Trello developer API key from the Power-Up admin screen, which names the integration on every request. It pairs with the token: neither half authenticates a request on its own.',
			envVarKey: 'TRELLO_API_KEY',
		},
		{
			role: TRELLO_TOKEN_ROLE,
			label: 'Token',
			description:
				'Token issued for that API key, which every board read and write runs as. The member it belongs to is the identity board loop prevention recognizes as SWARM, so do not use the account a human moves cards from.',
			envVarKey: 'TRELLO_TOKEN',
		},
		{
			role: PM_WEBHOOK_SECRET_ROLE,
			label: 'Webhook Secret',
			description:
				'Trello API secret shown beside the API key, which signs every webhook delivery for this integration. It is not a per-webhook secret you choose, and it is the board secret only — not the repository one.',
			// The role name is the *receiver's* vocabulary and the credential behind it
			// is Trello's own API secret, hence the mismatch with the env-var key: the
			// receiver resolves exactly `PM_WEBHOOK_SECRET_ROLE` into
			// `PmWebhookVerification.secret`, so declaring this as `apiSecret` would
			// reach the verifier as `null` and 401 every delivery.
			envVarKey: 'TRELLO_API_SECRET',
			// Deliberately **not** `optional`, unlike Cascade's Trello manifest. SWARM's
			// verifier fails closed on a null secret (`./webhook.ts`), so an optional
			// role would validate happily at `swarm config apply` and then 401 every
			// delivery — a board that looks configured and silently never triggers.
			// Requiring it moves that failure to config validation, where it names the
			// role and its env var.
		},
	],
	// Its own route: Trello posts to the `callbackURL` a webhook is created with, and
	// nothing else serves this path, so the receiver mounts a GET ping + POST pair
	// for it rather than co-tenanting an SCM route (`src/router/webhook-receiver.ts`).
	// That GET also answers the `HEAD` Trello probes the URL with before it will
	// accept a subscription — Hono dispatches `HEAD` onto the mounted `GET`.
	webhookRoute: '/trello/webhook',
	verifyWebhookSignature: verifyTrelloWebhookSignature,
	// A container is a Trello **board** and a state is one of that board's **lists**,
	// which is why both capabilities are declared: the board-mapping screen picks a
	// board, then maps SWARM's canonical status keys onto its lists. A card has no
	// status field — the list it sits in *is* its status.
	discovery: ['containers', 'states'],
};

registerPMProvider(trelloManifest);
