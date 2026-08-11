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
	// Served verbatim by the receiver (`src/router/webhook-receiver.ts`) since this
	// manifest declared itself runtime-ready: a GET ping plus the POST deliveries
	// Bitbucket Cloud sends.
	webhookRoute: '/bitbucket/webhook',
	// Declared ready to carry traffic by issue #618, the second provider to claim it.
	// The contract has been complete since issue #296 phase 4/4 — no method is stubbed
	// (`tests/unit/integrations/scm/scm-conformance.test.ts`) — and the two pieces of
	// wiring that were still missing land with the flip: the receiver now mounts
	// `/bitbucket/webhook`, and `requireProjectSCMProvider` routes a project that sets
	// `"scm": "bitbucket"` here (`../registry.ts`). GitHub is unaffected — each project
	// resolves the manifest it names — but a project that names *no* provider no longer
	// resolves a sole runtime-ready one and must now set `scm` (see `../registry.ts`
	// and the `scm` field doc in `src/config/schema.ts`).
	runtimeReady: true,
	// Bitbucket's own reference names for the contract's two credentials (issue #628),
	// so a project can hold these alongside GitHub's or GitLab's instead of the three
	// sharing (and overwriting) one pair. Spelled like the sibling operator variable
	// `SWARM_OPERATOR_BITBUCKET_TOKEN`.
	credentialRoles: [
		{ role: 'reviewer', envVarKey: 'BITBUCKET_TOKEN_REVIEWER' },
		{ role: 'webhookSecret', envVarKey: 'BITBUCKET_WEBHOOK_SECRET' },
	],
	// One shared instance: the integration is stateless and takes `project` per
	// call, so there is nothing to construct per project (see the manifest doc).
	provider: new BitbucketSCMIntegration(),
};

registerSCMProvider(bitbucketScmManifest);
