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
	// Not served yet: the receiver mounts only runtime-ready manifests' routes, so
	// this path is declared now and mounted by phase 6/6.
	webhookRoute: '/azure-devops/webhook',
	// Registered, complete, and **not** ready to carry traffic. Phase 6/6 of issue
	// #1089 flips this together with what it still lacks — the served route, the
	// dashboard's Azure DevOps copy, and the pre-project verify / default-branch API —
	// so until then `requireProjectSCMProvider` refuses a project selecting
	// `"scm": "azure-devops"` rather than routing it to a provider nothing serves.
	runtimeReady: false,
	// Azure DevOps' own reference names for the contract's two credentials (issue
	// #628's per-provider shape), spelled like the sibling operator variable
	// `SWARM_OPERATOR_AZURE_DEVOPS_TOKEN`. `webhookSecret` is the password a service
	// hook sends as HTTP basic auth (`./webhook.ts`), not an HMAC key. `instanceDefault`
	// on `reviewer` follows issue #778's installation-wide rule; it is offered only
	// once this manifest is runtime-ready (`listInstanceDefaultScmRoles`).
	credentialRoles: [
		{ role: 'reviewer', envVarKey: 'AZURE_DEVOPS_TOKEN_REVIEWER', instanceDefault: true },
		{ role: 'webhookSecret', envVarKey: 'AZURE_DEVOPS_WEBHOOK_SECRET' },
	],
	// One shared instance: the integration is stateless and takes `project` per
	// call, so there is nothing to construct per project (see the manifest doc).
	provider: new AzureDevOpsSCMIntegration(),
};

registerSCMProvider(azureDevOpsScmManifest);
