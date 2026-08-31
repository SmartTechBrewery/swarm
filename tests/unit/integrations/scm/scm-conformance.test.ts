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
 * together with the last stub's removal; issue #619 then declared it runtime-ready.
 * A fourth provider adds a manifest to the list below and inherits every assertion
 * unchanged.
 */

import { describe, expect, it } from 'vitest';
// Importing the entrypoint is what a real runtime surface does; it triggers every
// provider's side-effect registration. Vitest isolates module state per test file,
// so this registration is independent of registry.test.ts's resets.
import '@/integrations/entrypoint.js';
import { isRuntimeReadySCMProvider } from '@/integrations/scm/manifest.js';
import {
	listInstanceDefaultScmRoles,
	listSCMProviders,
	requireProjectSCMProvider,
} from '@/integrations/scm/registry.js';
import { SCM_CREDENTIAL_ROLES, type SCMProvider } from '@/scm/types.js';
import { createMockProjectConfig } from '../../../helpers/factories.js';

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
	'pullRequestUrl',
	'getBranchHead',
	'getAggregateCheckStatus',
	'listPullRequestsForCommit',
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

	// All three registered providers are runtime-ready as of issue #619, which served
	// `/gitlab/webhook` the way #618 served Bitbucket's; the several-projects-several-
	// providers routing itself is asserted in `registry.test.ts`, against fake
	// manifests, because this suite runs over the real registrations. The tripwire is
	// unchanged in spirit: this list is the exhaustive set of providers declared ready
	// to carry traffic, so a fourth provider flipping its flag has to update it
	// deliberately — in the issue that serves that provider's ingress route — rather
	// than as a side effect of unrelated work.
	it('declares exactly the providers that have been made runtime-reachable', () => {
		expect(manifests.filter(isRuntimeReadySCMProvider).map((m) => m.id)).toEqual([
			'github',
			'bitbucket',
			'gitlab',
		]);
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

	// The project-scoped lookup, against the **real** registrations rather than
	// `registry.test.ts`'s fakes — because since issue #618 its multi-provider
	// branches are what production actually takes.
	describe('requireProjectSCMProvider against the real registry', () => {
		for (const id of ['github', 'bitbucket', 'gitlab'] as const) {
			it(`routes a project that selects '${id}' to that provider`, () => {
				const manifest = manifests.find((candidate) => candidate.id === id);
				expect(requireProjectSCMProvider(createMockProjectConfig({ scm: id }))).toBe(
					manifest?.provider,
				);
			});
		}

		// The two "selected but unusable" throws have no real manifest to run against any
		// more: `ScmType` is a closed enum, so an unregistered id cannot even be put on a
		// `ProjectConfig`, and every registered provider carries traffic since issue #619.
		// Both stay asserted against fake manifests in `registry.test.ts` ('throws naming
		// the project and the selected id when that provider is not registered' and
		// 'throws when the selected provider is registered but not runtime-ready').

		// The migration issue #618 created: the sole-runtime-ready fallback stopped
		// resolving the moment Bitbucket became the second ready provider, so an
		// installation predating `ProjectConfig.scm` must set the field. The error is
		// the notice, so it has to name the field and list the choices — all three of
		// them now that GitLab is ready too.
		it('tells an unmigrated project to set scm rather than picking a provider for it', () => {
			const unmigrated = createMockProjectConfig();
			expect(unmigrated.scm).toBeUndefined();
			expect(() => requireProjectSCMProvider(unmigrated)).toThrow(
				/it selects no provider and 3 of 3 registered are runtime-ready/,
			);
			expect(() => requireProjectSCMProvider(unmigrated)).toThrow(
				/set "scm" on the project config to one of: github, bitbucket, gitlab/,
			);
		});
	});

	// A separate, mounted webhook route per provider is what lets the receiver serve
	// them all without naming one — two providers sharing a path would shadow.
	it('gives every provider its own webhook route', () => {
		const routes = manifests.map((manifest) => manifest.webhookRoute);
		expect(new Set(routes).size).toBe(routes.length);
	});

	// Issue #628: the two credentials the contract names are declared per provider, with
	// each provider's own conventional reference name.
	describe('credential roles', () => {
		it('declares exactly the contract’s two roles for every provider', () => {
			for (const manifest of manifests) {
				expect(
					manifest.credentialRoles.map((spec) => spec.role).sort(),
					`${manifest.id}.credentialRoles`,
				).toEqual([...SCM_CREDENTIAL_ROLES].sort());
			}
		});

		it('gives every role a non-empty, UPPER_SNAKE_CASE env var key', () => {
			for (const manifest of manifests) {
				for (const spec of manifest.credentialRoles) {
					expect(spec.envVarKey, `${manifest.id}.${spec.role}`).toMatch(/^[A-Z][A-Z0-9_]*$/);
				}
			}
		});

		// The structural guard against the in-place overwrite this issue is about: two
		// providers sharing a reference name would store one secret over the other, which is
		// exactly what per-provider references exist to stop.
		it('shares no env var key between two providers', () => {
			const keys = manifests.flatMap((manifest) =>
				manifest.credentialRoles.map((spec) => spec.envVarKey),
			);
			expect(new Set(keys).size).toBe(keys.length);
		});

		// The structural guard for issue #769, in the same spirit as the one above: a
		// webhook secret is tied to *one project's* own webhook endpoint, so one
		// installation-wide value for it would be wrong rather than merely redundant. No
		// provider may opt it in, by accident or otherwise.
		it('never declares an instance-level default for webhookSecret', () => {
			for (const manifest of manifests) {
				for (const spec of manifest.credentialRoles) {
					if (spec.role !== 'webhookSecret') continue;
					expect(spec.instanceDefault, `${manifest.id}.webhookSecret`).not.toBe(true);
				}
			}
		});

		// Issue #769 pinned this to exactly `[{ github, reviewer }]` as a tripwire, because
		// opting a reviewer role in was then a per-provider decision made in that provider's
		// own issue. Issue #778 made it installation-wide policy instead — the reviewer
		// identity is a requirement of the installation, not a per-provider convenience — so
		// the assertion is now the rule rather than an enumeration, and a fourth provider
		// inherits it instead of editing a list.
		it('offers every runtime-ready provider’s reviewer role as an instance default', () => {
			const eligible = listInstanceDefaultScmRoles();

			expect(eligible.map((entry) => ({ providerId: entry.providerId, role: entry.role }))).toEqual(
				manifests
					.filter(isRuntimeReadySCMProvider)
					.map((manifest) => ({ providerId: manifest.id, role: 'reviewer' as const })),
			);
			for (const manifest of manifests.filter(isRuntimeReadySCMProvider)) {
				const spec = manifest.credentialRoles.find((entry) => entry.role === 'reviewer');
				expect(spec?.instanceDefault, `${manifest.id}.reviewer`).toBe(true);
			}
		});
	});
});
