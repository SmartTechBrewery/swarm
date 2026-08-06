/**
 * The multi-provider PM conformance harness — one suite run against **every**
 * registered manifest, so a provider cannot silently skip part of the contract
 * (ai/TESTING.md "Provider conformance", the PM twin of
 * `tests/unit/integrations/scm/scm-conformance.test.ts` and, like it, mirroring
 * Cascade's `tests/unit/integrations/pm-conformance.test.ts`).
 *
 * Deliberately deferred until issue #297's phase 6/6: through phases 1–5 the PM
 * surface a provider has to satisfy was still being built — the neutral `PmEvent`
 * and `PMRouterAdapter` (#297), the `project.pm` union (#495), the manifest's
 * `webhookRoute`/`verifyWebhookSignature` (#496), its `credentialRoles` (#497),
 * and the card↔artifact mapping (#498) — so a harness written earlier would have
 * asserted a shape that changed under it. It lands now that the surface is
 * settled, which is what makes it a gate on the *second* PM provider rather than
 * a description of the first.
 *
 * Scope is the same as the SCM suite's: manifest surface plus stub detection. It
 * asserts nothing about behavior — Cascade's `lifecycle` fixture harness has no
 * counterpart here, and a provider's own folder tests still own its semantics.
 */

import { describe, expect, it } from 'vitest';
// Importing the entrypoint is what a real runtime surface does; it triggers every
// provider's side-effect registration. Vitest isolates module state per test file,
// so this registration is independent of registry.test.ts's resets.
import '@/integrations/entrypoint.js';
import type { ProjectConfig } from '@/config/schema.js';
import type { PMProviderManifest } from '@/integrations/pm/manifest.js';
import { listPMProviders } from '@/integrations/pm/registry.js';
import type { PMRouterAdapter } from '@/pm/router-adapter.js';
import { PM_DISCOVERY_CAPABILITIES, type PMProvider, type PMType } from '@/pm/types.js';
import { createMockProjectConfig } from '../../../helpers/factories.js';

/**
 * The names of `PMProvider`'s method members. `-?` is the one difference from the
 * SCM suite's otherwise identical mapped type: `PMProvider` has an *optional*
 * member (`discover`), and without stripping the modifier the mapped property
 * stays optional and drops a bare `undefined` into the union, which the
 * {@link AssertNever} guard below would then report forever.
 */
type PMContractMethod = {
	[Key in keyof PMProvider]-?: PMProvider[Key] extends (...args: never[]) => unknown ? Key : never;
}[keyof PMProvider];

/**
 * Every method `PMProvider` (`src/pm/types.ts`) declares. TypeScript checks this
 * at compile time for a provider that says `implements PMProvider`; the list is
 * what turns that into a check on the **registered** manifest, which is all shared
 * code ever holds.
 *
 * `discover` is absent on purpose: it is the one *optional* member of the
 * contract, declared per provider on `PMProviderManifest.discovery`, so it is
 * checked against that declaration further down rather than required of everyone.
 */
const PM_CONTRACT_METHODS = [
	'getWorkItem',
	'listWorkItems',
	'findWorkItemByUrlSuffix',
	'findWorkItemForArtifact',
	'moveWorkItem',
	'addComment',
	'findComment',
	'createWorkItem',
	'updateWorkItem',
	'addLabel',
	'listBlockers',
	'addBlockedBy',
] as const satisfies ReadonlyArray<PMContractMethod>;

/** The capability flags a provider answers with a boolean rather than a method. */
const PM_CAPABILITY_FLAGS = ['supportsAssignees', 'supportsDependencies'] as const;

type PMAdapterContractMethod = {
	[Key in keyof PMRouterAdapter]: PMRouterAdapter[Key] extends (...args: never[]) => unknown
		? Key
		: never;
}[keyof PMRouterAdapter];

/**
 * Every method `PMRouterAdapter` (`src/pm/router-adapter.ts`) declares — the
 * *inbound* half of the same contract (ai/RULES.md §2). Checked here too because
 * a provider that stubs `isSelfAuthored` has a loop-prevention hole, not a missing
 * feature, and nothing else asserts it for a provider other than GitHub Projects.
 */
const PM_ADAPTER_CONTRACT_METHODS = [
	'parseWebhook',
	'resolveProject',
	'isStatusChange',
	'isSelfAuthored',
	'synthesizeStateChange',
] as const satisfies ReadonlyArray<PMAdapterContractMethod>;

type AssertNever<T extends never> = T;

/** Generic wording a registered-but-unbuilt provider throws with. */
const STUB_SENTINEL = /\bnot\s+implemented\b/i;

/**
 * A project config whose `pm` member selects the manifest under test. Unlike an
 * SCM manifest's shared `provider` instance, a PM manifest builds its provider
 * *per project* (`createProvider(project)`), so the harness needs one fixture per
 * provider — a new provider adds an entry here alongside its `ProjectPmSchema`
 * union member (issue #495).
 */
const PROJECT_FIXTURES: Partial<Record<PMType, () => ProjectConfig>> = {
	'github-projects': () => createMockProjectConfig(),
};

function projectFor(manifest: PMProviderManifest): ProjectConfig {
	const fixture = PROJECT_FIXTURES[manifest.id];
	if (!fixture) {
		throw new Error(
			`No project-config fixture for PM provider '${manifest.id}' — add one to PROJECT_FIXTURES`,
		);
	}
	return fixture();
}

const manifests = listPMProviders();

describe('PM provider conformance', () => {
	it('registers every provider the suite runs over', () => {
		expect(manifests.map((manifest) => manifest.id)).toEqual(['github-projects']);
	});

	it('gives every provider a unique id', () => {
		const ids = manifests.map((manifest) => manifest.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	// No "exactly one runtime-ready provider" assertion, deliberately — do not add
	// the SCM suite's. `project.pm.type` already *is* the config discriminator
	// `ProjectConfig` lacks on the SCM side, so `requireProjectPMProvider` is a plain
	// registry lookup with no single-provider assertion and the PM manifest carries no
	// `runtimeReady` flag (`src/integrations/pm/registry.ts`, ai/RULES.md §2). A second
	// PM provider is selectable the day it registers; nothing here has to gate it.

	it('has a project-config fixture for every registered provider', () => {
		for (const manifest of manifests) {
			expect(() => projectFor(manifest), manifest.id).not.toThrow();
		}
	});

	it('lists every PMProvider method', () => {
		const allMethodsAreListed: AssertNever<
			Exclude<PMContractMethod, (typeof PM_CONTRACT_METHODS)[number]>
		> = undefined as never;
		expect(allMethodsAreListed).toBeUndefined();
	});

	it('lists every PMRouterAdapter method', () => {
		const allMethodsAreListed: AssertNever<
			Exclude<PMAdapterContractMethod, (typeof PM_ADAPTER_CONTRACT_METHODS)[number]>
		> = undefined as never;
		expect(allMethodsAreListed).toBeUndefined();
	});

	for (const manifest of manifests) {
		describe(manifest.id, () => {
			it('declares the manifest metadata shared code reads', () => {
				expect(manifest.category).toBe('pm');
				expect(manifest.label).not.toBe('');
				expect(manifest.createProvider).toBeTypeOf('function');
				// The receiver mounts this path verbatim, or co-tenants it onto an SCM
				// route that already owns it (`src/router/webhook-receiver.ts`).
				expect(manifest.webhookRoute).toMatch(/^\/[\w-]+\/webhook$/);
				expect(manifest.verifyWebhookSignature).toBeTypeOf('function');
			});

			// The manifest's schema and the `project.pm` union member are two
			// declarations of one shape (issue #495); a provider that lets them drift
			// passes config validation and then builds a provider against a mapping its
			// own schema rejects.
			it('declares a config schema that accepts its own project fixture', () => {
				const project = projectFor(manifest);
				expect(project.pm.type).toBe(manifest.id);
				expect(() => manifest.configSchema.parse(project.pm)).not.toThrow();
			});

			// `credentials.pm` is validated against these (`src/config/schema.ts`), so a
			// blank or duplicated role key silently disables the check for that role.
			it('declares credential roles config validation can resolve', () => {
				for (const spec of manifest.credentialRoles) {
					expect(spec.role, `${manifest.id} credential role key`).not.toBe('');
					expect(spec.label, `${manifest.id}.${spec.role} label`).not.toBe('');
					expect(spec.envVarKey, `${manifest.id}.${spec.role} envVarKey`).not.toBe('');
				}
				const roles = manifest.credentialRoles.map((spec) => spec.role);
				expect(new Set(roles).size).toBe(roles.length);
			});

			it('registers a router adapter whose own type matches the manifest id', () => {
				expect(manifest.routerAdapter.type).toBe(manifest.id);
			});

			it('builds a provider whose own type matches the manifest id', () => {
				const provider = manifest.createProvider(projectFor(manifest));
				expect(provider.type).toBe(manifest.id);
				for (const flag of PM_CAPABILITY_FLAGS) {
					expect(provider[flag], `${manifest.id}.${flag}`).toBeTypeOf('boolean');
				}
			});

			it('exposes every contract method', () => {
				const provider = manifest.createProvider(projectFor(manifest));
				for (const method of PM_CONTRACT_METHODS) {
					expect(provider[method], `${manifest.id}.${method}`).toBeTypeOf('function');
				}
				for (const method of PM_ADAPTER_CONTRACT_METHODS) {
					expect(manifest.routerAdapter[method], `${manifest.id} adapter.${method}`).toBeTypeOf(
						'function',
					);
				}
			});

			// A stub still has the right function shape, so inspect its own source for the
			// generic sentinel rather than relying on the surface assertion above.
			it('implements every contract method rather than stubbing it', () => {
				const provider = manifest.createProvider(projectFor(manifest));
				for (const method of PM_CONTRACT_METHODS) {
					expect(
						String(provider[method]),
						`${manifest.id}.${method} still throws the not-implemented sentinel`,
					).not.toMatch(STUB_SENTINEL);
				}
				for (const method of PM_ADAPTER_CONTRACT_METHODS) {
					expect(
						String(manifest.routerAdapter[method]),
						`${manifest.id} adapter.${method} still throws the not-implemented sentinel`,
					).not.toMatch(STUB_SENTINEL);
				}
			});

			/**
			 * `discover` is dispatched through the manifest's declaration (`src/api/routers/pm.ts`),
			 * so a capability declared but never answered surfaces as a `NOT_IMPLEMENTED`
			 * at the board-mapping screen rather than at registration. This closes that
			 * gap by *reading* the dispatch rather than exercising it: calling `discover`
			 * would authenticate and hit the provider's API, which a unit suite must not
			 * do (ai/TESTING.md "Test runner"). The scan is therefore a floor, not a
			 * proof — it catches a capability the provider never branches on at all.
			 */
			it('answers every discovery capability its manifest declares', () => {
				const capabilities = manifest.discovery;
				expect(new Set(capabilities).size, `${manifest.id} declares a capability twice`).toBe(
					capabilities.length,
				);
				if (capabilities.length === 0) return;

				const provider = manifest.createProvider(projectFor(manifest));
				expect(provider.discover, `${manifest.id}.discover`).toBeTypeOf('function');
				const source = String(provider.discover);
				expect(source, `${manifest.id}.discover is a stub`).not.toMatch(STUB_SENTINEL);
				for (const capability of capabilities) {
					expect(PM_DISCOVERY_CAPABILITIES).toContain(capability);
					expect(
						source,
						`${manifest.id}.discover never dispatches on the declared '${capability}' capability`,
					).toContain(capability);
				}
			});
		});
	}

	it('recognizes generic provider-stub wording', () => {
		function addBlockedBy(): never {
			throw new Error('addBlockedBy is not implemented for the Jira PM provider');
		}
		expect(String(addBlockedBy)).toMatch(STUB_SENTINEL);
	});

	// A separate webhook route per PM provider is what lets the receiver serve them
	// all without naming one. Uniqueness is asserted **among PM manifests only**:
	// sharing a path with an *SCM* manifest is the supported case, not a collision —
	// GitHub delivers `projects_v2_item` to the same `/github/webhook` URL as the
	// repo's own events, so the receiver co-tenants that PM manifest onto the SCM
	// route rather than mounting a second, shadowed handler (issue #496).
	it('gives every PM provider its own webhook route', () => {
		const routes = manifests.map((manifest) => manifest.webhookRoute);
		expect(new Set(routes).size).toBe(routes.length);
	});
});
