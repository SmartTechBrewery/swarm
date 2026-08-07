/**
 * The multi-provider SCM conformance harness — one suite run against **every**
 * registered manifest, so a provider cannot silently skip part of the contract
 * (ai/TESTING.md "Provider conformance", mirroring Cascade's
 * `tests/unit/integrations/pm-conformance.test.ts`).
 *
 * Deliberately deferred until issue #296's phase 4/4: while Bitbucket still threw
 * for the methods its later phases owned, a shared harness would only have asserted
 * that those throws existed. It landed once both providers implemented the whole
 * contract, so it asserts the surface *and* that no method is a stub — which is
 * what made it a gate on the third provider rather than a description of the second.
 *
 * **The third provider has now passed that gate.** GitLab (issue #295) built its
 * contract over four phases while registering nothing, precisely so it could not
 * claim an exemption from the no-stub assertion, and registered in its phase 4/4
 * together with the last stub's removal. A fourth provider adds a manifest to the
 * list below and inherits every assertion unchanged.
 */

import { describe, expect, it } from 'vitest';
// Importing the entrypoint is what a real runtime surface does; it triggers every
// provider's side-effect registration. Vitest isolates module state per test file,
// so this registration is independent of registry.test.ts's resets.
import '@/integrations/entrypoint.js';
import { isRuntimeReadySCMProvider } from '@/integrations/scm/manifest.js';
import { listSCMProviders } from '@/integrations/scm/registry.js';
import type { SCMProvider } from '@/scm/types.js';

type SCMContractMethod = {
	[Key in keyof SCMProvider]: SCMProvider[Key] extends (...args: never[]) => unknown ? Key : never;
}[keyof SCMProvider];

/**
 * Every method `SCMProvider` (`src/scm/types.ts`) declares. TypeScript checks this
 * at compile time for a provider that says `implements SCMProvider`; the list is
 * what turns that into a check on the **registered** manifest, which is all shared
 * code ever holds.
 */
const SCM_CONTRACT_METHODS = [
	'hasIntegration',
	'hasPersonaToken',
	'withPersonaCredentials',
	'resolvePersonaIdentities',
	'personaForActor',
	'isSwarmActor',
	'verifyWebhookSignature',
	'readWebhookRequest',
	'parseWebhookEvent',
	'isSwarmGeneratedEvent',
	'getPullRequest',
	'getPullRequestTitle',
	'getAggregateCheckStatus',
	'listConflictCandidates',
	'commentOnPullRequest',
	'deliveryProvider',
	'operatorDeliveryProvider',
	'mergePullRequest',
] as const satisfies ReadonlyArray<SCMContractMethod>;

type AssertNever<T extends never> = T;

const manifests = listSCMProviders();

describe('SCM provider conformance', () => {
	it('registers every provider the suite runs over', () => {
		expect(manifests.map((manifest) => manifest.id)).toEqual(['github', 'bitbucket', 'gitlab']);
	});

	it('gives every provider a unique id', () => {
		const ids = manifests.map((manifest) => manifest.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	// Project→provider selection exists since issue #478 (`ProjectConfig.scm`), so
	// several providers *can* be runtime-ready at once — the two-projects-two-providers
	// case is asserted in `registry.test.ts`, against fake manifests, because this suite
	// runs over the real registrations. What is left here is a deliberate tripwire: only
	// GitHub claims readiness today, and flipping any other provider's flag is a
	// decision made in the issue completing that provider (#457 for Bitbucket), together
	// with its served ingress route — never a side effect of unrelated work.
	it('has exactly one runtime-ready provider, since no other provider has been declared complete', () => {
		expect(manifests.filter(isRuntimeReadySCMProvider).map((m) => m.id)).toEqual(['github']);
	});

	it('lists every SCMProvider method', () => {
		const allMethodsAreListed: AssertNever<
			Exclude<SCMContractMethod, (typeof SCM_CONTRACT_METHODS)[number]>
		> = undefined as never;
		expect(allMethodsAreListed).toBeUndefined();
	});

	for (const manifest of manifests) {
		describe(manifest.id, () => {
			it('declares the manifest metadata shared code reads', () => {
				expect(manifest.category).toBe('scm');
				expect(manifest.label).not.toBe('');
				// The receiver mounts this path verbatim (`src/router/webhook-receiver.ts`).
				expect(manifest.webhookRoute).toMatch(/^\/[\w-]+\/webhook$/);
			});

			it('registers a provider whose own type matches the manifest id', () => {
				expect(manifest.provider.type).toBe(manifest.id);
				expect(manifest.provider.category).toBe('scm');
			});

			it('exposes every contract method', () => {
				for (const method of SCM_CONTRACT_METHODS) {
					expect(manifest.provider[method], `${manifest.id}.${method}`).toBeTypeOf('function');
				}
			});

			// A stub still has the right function shape, so inspect its own source for the
			// generic sentinel rather than relying on the surface assertion above.
			it('implements every contract method rather than stubbing it', () => {
				for (const method of SCM_CONTRACT_METHODS) {
					expect(
						String(manifest.provider[method]),
						`${manifest.id}.${method} still throws the not-implemented sentinel`,
					).not.toMatch(/\bnot\s+implemented\b/i);
				}
			});
		});
	}

	it('recognizes generic provider-stub wording', () => {
		function operatorDeliveryProvider(): never {
			throw new Error('operatorDeliveryProvider is not implemented for Bitbucket SCM');
		}
		expect(String(operatorDeliveryProvider)).toMatch(/\bnot\s+implemented\b/i);
	});

	// A separate, mounted webhook route per provider is what lets the receiver serve
	// them all without naming one — two providers sharing a path would shadow.
	it('gives every provider its own webhook route', () => {
		const routes = manifests.map((manifest) => manifest.webhookRoute);
		expect(new Set(routes).size).toBe(routes.length);
	});
});
