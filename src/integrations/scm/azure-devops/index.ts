/**
 * Azure DevOps SCM provider — registration entry.
 *
 * Side-effect module: importing it builds the provider's `SCMProviderManifest`
 * and registers it into `scmProviderRegistry` at module load. It's pulled in by
 * the single canonical entrypoint (`src/integrations/entrypoint.ts`), so no
 * runtime surface imports this file directly (ai/CODING_STANDARDS.md "Module shape
 * for a provider").
 *
 * **Why registration arrived in issue #1089's phase 5/6.** Like GitLab, Azure
 * DevOps registered nothing while its contract was being built: the multi-provider
 * conformance suite (`tests/unit/integrations/scm/scm-conformance.test.ts`) asserts
 * that no *registered* manifest stubs a contract method, so a stub-bearing manifest
 * would have forced an exemption that disabled that gate for the providers already
 * passing it. Registration lands together with the last stub's removal (ai/TESTING.md).
 *
 * The manifest is also exported for tests and for callers that want the
 * provider's pieces without going through the registry.
 */

import type { SCMProviderManifest } from '../manifest.js';
import { registerSCMProvider } from '../registry.js';
import { AzureDevOpsSCMIntegration } from './scm-integration.js';

export const azureDevOpsScmManifest: SCMProviderManifest = {
	id: 'azure-devops',
	label: 'Azure DevOps',
	category: 'scm',
	// Served verbatim by the receiver (`src/router/webhook-receiver.ts`) since this
	// manifest declared itself runtime-ready: a GET ping plus the POST deliveries an
	// Azure DevOps service-hook subscription sends.
	webhookRoute: '/azure-devops/webhook',
	// Declared ready to carry traffic by issue #1089 phase 6/6, the fourth provider to
	// claim it. The contract has been complete since phase 5/6 — no method is stubbed
	// (`tests/unit/integrations/scm/scm-conformance.test.ts`) — and the wiring it still
	// lacked lands with the flip: the receiver mounts `/azure-devops/webhook` from the
	// same loop that mounts every other provider's, `requireProjectSCMProvider` routes a
	// project that sets `"scm": "azure-devops"` here (`../registry.ts`), and the
	// dashboard's pre-project verify / default-branch reads gained an Azure DevOps branch
	// (`src/api/scm-verification.ts`, `src/api/scm-default-branch.ts`).
	//
	// **The webhook trade-off this makes live, decided here as GitLab's was (issue
	// #619).** Azure DevOps service hooks do not sign their deliveries; the Web Hooks
	// consumer sends the operator-chosen password as HTTP Basic auth, so
	// `verifyAzureDevOpsWebhookAuth` (`./webhook.ts`) authenticates the *sender* where
	// GitHub's and Bitbucket's HMAC also covers the exact body bytes. Serving the route
	// is judged **acceptable as-is**: Basic auth is Azure's own mechanism for this
	// consumer, Azure refuses it over plain HTTP so the password only ever travels under
	// TLS, the check fails closed on an absent, malformed, or mismatched credential, and
	// it compares in constant time — so a delivery cannot be forged without the secret.
	// What it does not add on top of TLS is body integrity and replay protection, and an
	// attacker positioned to tamper with or replay a delivery has already broken the TLS
	// the password itself travels under.
	runtimeReady: true,
	// Azure DevOps' own reference names for the contract's two credentials (issue
	// #628's per-provider shape), in the `<PROVIDER>_TOKEN_REVIEWER` form GitHub's uses.
	// `webhookSecret` is the password a service
	// hook sends as HTTP basic auth (`./webhook.ts`), not an HMAC key. `instanceDefault`
	// on `reviewer` follows issue #778's installation-wide rule, offered now that this
	// manifest is runtime-ready (`listInstanceDefaultScmRoles`).
	credentialRoles: [
		{ role: 'reviewer', envVarKey: 'AZURE_DEVOPS_TOKEN_REVIEWER', instanceDefault: true },
		{ role: 'webhookSecret', envVarKey: 'AZURE_DEVOPS_WEBHOOK_SECRET' },
	],
	// One shared instance: the integration is stateless and takes `project` per
	// call, so there is nothing to construct per project (see the manifest doc).
	provider: new AzureDevOpsSCMIntegration(),
};

registerSCMProvider(azureDevOpsScmManifest);
