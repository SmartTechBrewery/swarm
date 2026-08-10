/**
 * GitLab SCM provider — registration entry.
 *
 * Side-effect module: importing it builds the provider's `SCMProviderManifest`
 * and registers it into `scmProviderRegistry` at module load. It's pulled in by
 * the single canonical entrypoint (`src/integrations/entrypoint.ts`), so no
 * runtime surface imports this file directly — the "one import line in the
 * barrel" half of the registration pattern (ai/CODING_STANDARDS.md "Module shape
 * for a provider").
 *
 * **Why registration arrived in issue #295's last phase rather than its first.**
 * Bitbucket registered a `runtimeReady: false` manifest from its own phase 1;
 * GitLab deliberately registered nothing until the contract was complete, because
 * the multi-provider conformance suite
 * (`tests/unit/integrations/scm/scm-conformance.test.ts`) asserts that no
 * *registered* manifest stubs a contract method. A stub-bearing manifest would
 * have forced an exemption that disabled that gate for the two providers already
 * passing it, so registration landed together with the last stub's removal
 * (ai/TESTING.md).
 *
 * The manifest is also exported for tests and for callers that want the
 * provider's pieces without going through the registry.
 */

import type { SCMProviderManifest } from '../manifest.js';
import { registerSCMProvider } from '../registry.js';
import { GitLabSCMIntegration } from './scm-integration.js';

export const gitlabScmManifest: SCMProviderManifest = {
	id: 'gitlab',
	label: 'GitLab',
	category: 'scm',
	// Served verbatim by the receiver (`src/router/webhook-receiver.ts`) since this
	// manifest declared itself runtime-ready: a GET ping plus the POST deliveries
	// gitlab.com sends.
	webhookRoute: '/gitlab/webhook',
	// Declared ready to carry traffic by issue #619, the third provider to claim it.
	// The contract has been complete since issue #295 phase 4/4 — no method is stubbed
	// (`tests/unit/integrations/scm/scm-conformance.test.ts`) — and the two pieces of
	// wiring that were still missing land with the flip: the receiver now mounts
	// `/gitlab/webhook`, and `requireProjectSCMProvider` routes a project that sets
	// `"scm": "gitlab"` here (`../registry.ts`). GitHub and Bitbucket projects are
	// unaffected — each project resolves the manifest it names.
	//
	// **The webhook trade-off this makes live, decided here rather than deferred
	// again.** GitLab authenticates a delivery by echoing the operator-chosen secret
	// verbatim in `X-Gitlab-Token`, so `verifyGitLabWebhookToken` (`./webhook.ts`)
	// authenticates the *sender* where GitHub's and Bitbucket's HMAC also covers the
	// exact body bytes. Serving the route is judged **acceptable as-is**, not a
	// prerequisite: the token check is GitLab's own long-standing mechanism, it fails
	// closed on an absent, empty, or mismatched value, and it compares in constant
	// time, so a delivery cannot be forged without the secret. What it does not add on
	// top of TLS is body integrity and replay protection — and an attacker positioned
	// to tamper with or replay a delivery has already broken the TLS the secret itself
	// travels under, so the token is not the weakest link. GitLab 19.0's
	// Standard-Webhooks signing tokens would close the gap and stay a recorded
	// follow-up, because they need `SCMProvider.verifyWebhookSignature` widened for the
	// `webhook-id`/`webhook-timestamp` headers it never sees **and** a per-provider
	// secret reference (a GitLab-minted `whsec_…` key cannot be the operator-chosen
	// secret the same project's PM webhook shares). See `./webhook.ts`'s header.
	runtimeReady: true,
	// One shared instance: the integration is stateless and takes `project` per
	// call, so there is nothing to construct per project (see the manifest doc).
	provider: new GitLabSCMIntegration(),
};

registerSCMProvider(gitlabScmManifest);
