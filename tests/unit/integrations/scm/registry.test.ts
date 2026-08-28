import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@/config/schema.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	getSCMProvider,
	listInstanceDefaultScmRoles,
	listSCMProviders,
	registerSCMProvider,
	requireProjectSCMProvider,
	requireProjectSCMProviderId,
	requireSCMProvider,
} from '@/integrations/scm/registry.js';
import { createMockProjectConfig } from '../../../helpers/factories.js';

/**
 * A minimal manifest stand-in. The registry only ever hands `provider` back, never
 * calls into it, so the tests cast a bare identity object rather than constructing
 * the real integration — keeps these unit tests about the registry's bookkeeping,
 * not the provider's wiring.
 */
function fakeManifest(
	id: string,
	runtimeReady?: boolean,
	/** Whether the fake's `reviewer` role opts into an instance-level default (issue #769). */
	instanceDefault = false,
): SCMProviderManifest {
	return {
		id,
		label: id,
		category: 'scm',
		// Declared so a project config parsed while this fake is registered still
		// validates its `credentials.scm[id]` roles against something (issue #628); the
		// registry itself never reads them.
		credentialRoles: [
			{
				role: 'reviewer',
				envVarKey: `${id.toUpperCase()}_TOKEN_REVIEWER`,
				...(instanceDefault ? { instanceDefault: true } : {}),
			},
			{ role: 'webhookSecret', envVarKey: `${id.toUpperCase()}_WEBHOOK_SECRET` },
		],
		provider: { id },
		...(runtimeReady === undefined ? {} : { runtimeReady }),
	} as unknown as SCMProviderManifest;
}

const project: ProjectConfig = createMockProjectConfig();

describe('scmProviderRegistry', () => {
	beforeEach(() => {
		_resetSCMProviderRegistryForTesting();
	});

	it('registers a manifest and looks it up by id', () => {
		const manifest = fakeManifest('github');
		registerSCMProvider(manifest);
		expect(getSCMProvider('github')).toBe(manifest);
	});

	it('returns null for an unregistered id', () => {
		expect(getSCMProvider('nope')).toBeNull();
	});

	it('lists registered manifests in registration order', () => {
		registerSCMProvider(fakeManifest('a'));
		registerSCMProvider(fakeManifest('b'));
		expect(listSCMProviders().map((m) => m.id)).toEqual(['a', 'b']);
	});

	it('throws on a duplicate id rather than silently shadowing', () => {
		registerSCMProvider(fakeManifest('github'));
		expect(() => registerSCMProvider(fakeManifest('github'))).toThrow(/already registered/);
	});

	it('returns a copy from listSCMProviders so callers cannot mutate the registry', () => {
		registerSCMProvider(fakeManifest('a'));
		const list = listSCMProviders() as SCMProviderManifest[];
		list.push(fakeManifest('b'));
		expect(listSCMProviders().map((m) => m.id)).toEqual(['a']);
	});

	it('reset clears the registry', () => {
		registerSCMProvider(fakeManifest('a'));
		_resetSCMProviderRegistryForTesting();
		expect(listSCMProviders()).toHaveLength(0);
		expect(getSCMProvider('a')).toBeNull();
	});

	// The by-id lookup's exemption from the runtime-ready filter (issue #478): its id
	// comes from an enqueued job's envelope, written by this process's own ingress, so
	// the comment must land on the provider the event actually came from — even one
	// the *project-scoped* lookup would refuse to route to.
	it('resolves a provider that is not runtime-ready when something names it by id', () => {
		const bitbucket = fakeManifest('bitbucket', false);
		registerSCMProvider(bitbucket);
		expect(requireSCMProvider('bitbucket')).toBe(bitbucket.provider);
	});

	it('throws naming the id when nothing is registered under it', () => {
		expect(() => requireSCMProvider('bitbucket')).toThrow(
			"SCM provider 'bitbucket' is not registered",
		);
	});
});

/**
 * The project-scoped lookup every outbound call site uses (issue #386), which
 * selects on the `ProjectConfig.scm` discriminator since issue #478. Two halves to
 * pin: that a project *does* route to the provider it names, even alongside another
 * runtime-ready one, and that every way of failing to resolve is loud and specific
 * rather than a silent fallback onto whatever else happens to be registered.
 */
describe('requireProjectSCMProvider', () => {
	beforeEach(() => {
		_resetSCMProviderRegistryForTesting();
	});

	it('resolves the sole runtime-ready provider when the project selects none', () => {
		const manifest = fakeManifest('github');
		registerSCMProvider(manifest);
		// The back-compat path: a project written before the discriminator existed
		// resolves with no config change (issue #478).
		expect(project.scm).toBeUndefined();
		expect(requireProjectSCMProvider(project)).toBe(manifest.provider);
	});

	// The point of the whole change: two runtime-ready providers registered at once,
	// two projects in the same installation, each routing to its own — asserted, not
	// assumed.
	it('routes two projects on different providers to their own provider', () => {
		const github = fakeManifest('github');
		const bitbucket = fakeManifest('bitbucket');
		registerSCMProvider(github);
		registerSCMProvider(bitbucket);

		const onGitHub = createMockProjectConfig({ id: 'gh-project', scm: 'github' });
		const onBitbucket = createMockProjectConfig({ id: 'bb-project', scm: 'bitbucket' });

		expect(requireProjectSCMProvider(onGitHub)).toBe(github.provider);
		expect(requireProjectSCMProvider(onBitbucket)).toBe(bitbucket.provider);
	});

	it('resolves a selected provider even when it is the only one registered', () => {
		const github = fakeManifest('github');
		registerSCMProvider(github);
		expect(requireProjectSCMProvider(createMockProjectConfig({ scm: 'github' }))).toBe(
			github.provider,
		);
	});

	it('throws naming the project and the selected id when that provider is not registered', () => {
		const github = fakeManifest('github');
		registerSCMProvider(github);
		const onBitbucket = createMockProjectConfig({ id: 'bb-project', scm: 'bitbucket' });

		// Substring, not a built RegExp: the project id is data, and a factory id
		// that ever grew a regex metacharacter would silently stop matching.
		expect(() => requireProjectSCMProvider(onBitbucket)).toThrow(
			"Cannot resolve the SCM provider for project 'bb-project': it selects 'bitbucket', which is not registered",
		);
		// Never the sole registered provider instead — that silent fallback is the
		// failure mode this lookup exists to prevent.
		expect(() => requireProjectSCMProvider(onBitbucket)).toThrow(/Registered: github\./);
	});

	// The `runtimeReady: false` opt-out (issue #296) still gates a *selected*
	// provider: flipping it is the decision of the issue completing that provider,
	// and until then naming it is an error rather than a redirect.
	it('throws when the selected provider is registered but not runtime-ready', () => {
		registerSCMProvider(fakeManifest('github'));
		registerSCMProvider(fakeManifest('bitbucket', false));
		const onBitbucket = createMockProjectConfig({ id: 'bb-project', scm: 'bitbucket' });

		expect(() => requireProjectSCMProvider(onBitbucket)).toThrow(
			"Cannot resolve the SCM provider for project 'bb-project': it selects 'bitbucket', which is registered but not runtime-ready",
		);
		expect(() => requireProjectSCMProvider(onBitbucket)).toThrow(
			/will not fall back to another provider/,
		);
	});

	it('ignores a provider that is not runtime-ready when the project selects none', () => {
		const github = fakeManifest('github');
		registerSCMProvider(github);
		registerSCMProvider(fakeManifest('bitbucket', false));
		expect(requireProjectSCMProvider(project)).toBe(github.provider);
	});

	it('tells the operator to set scm when two runtime-ready providers are registered', () => {
		registerSCMProvider(fakeManifest('github'));
		registerSCMProvider(fakeManifest('bitbucket'));
		expect(() => requireProjectSCMProvider(project)).toThrow(
			/it selects no provider and 2 of 2 registered are runtime-ready/,
		);
		expect(() => requireProjectSCMProvider(project)).toThrow(
			/set "scm" on the project config to one of: github, bitbucket/,
		);
	});

	it('throws naming the project when nothing is registered', () => {
		expect(() => requireProjectSCMProvider(project)).toThrow(
			`Cannot resolve the SCM provider for project '${project.id}': it selects no provider and 0 of 0 registered are runtime-ready`,
		);
	});

	it('throws when the only registered provider is not runtime-ready', () => {
		registerSCMProvider(fakeManifest('bitbucket', false));
		expect(() => requireProjectSCMProvider(project)).toThrow(
			/it selects no provider and 0 of 1 registered are runtime-ready/,
		);
	});
});

/**
 * The id half of the same lookup (issue #765) — what a caller needs when the
 * provider is a *value*, not an instance: the operator credential a dispatch hands
 * a worker is stored per `(worker, scmProviderId)`. It exists so no such caller
 * writes `project.scm ?? 'github'`, so both halves are asserted: it selects the same
 * manifest, and it refuses in the same three ways rather than defaulting.
 */
describe('requireProjectSCMProviderId', () => {
	beforeEach(() => {
		_resetSCMProviderRegistryForTesting();
	});

	it('returns the id of the manifest the project selects', () => {
		registerSCMProvider(fakeManifest('github'));
		registerSCMProvider(fakeManifest('bitbucket'));
		expect(requireProjectSCMProviderId(createMockProjectConfig({ scm: 'bitbucket' }))).toBe(
			'bitbucket',
		);
	});

	it('returns the sole runtime-ready id when the project selects none', () => {
		registerSCMProvider(fakeManifest('github'));
		expect(requireProjectSCMProviderId(project)).toBe('github');
	});

	it('throws the same three ways requireProjectSCMProvider does', () => {
		const onBitbucket = createMockProjectConfig({ id: 'bb-project', scm: 'bitbucket' });

		// Selected but unregistered — never silently the one that *is* registered.
		registerSCMProvider(fakeManifest('github'));
		expect(() => requireProjectSCMProviderId(onBitbucket)).toThrow(
			"Cannot resolve the SCM provider for project 'bb-project': it selects 'bitbucket', which is not registered",
		);

		// Registered but not runtime-ready.
		registerSCMProvider(fakeManifest('bitbucket', false));
		expect(() => requireProjectSCMProviderId(onBitbucket)).toThrow(
			/registered but not runtime-ready/,
		);

		// Nothing selected while the runtime-ready count is not exactly one.
		registerSCMProvider(fakeManifest('gitlab'));
		expect(() => requireProjectSCMProviderId(project)).toThrow(
			/it selects no provider and 2 of 3 registered are runtime-ready/,
		);
	});
});

describe('listInstanceDefaultScmRoles (issue #769)', () => {
	beforeEach(() => {
		_resetSCMProviderRegistryForTesting();
	});

	it('lists only the roles a provider opts in, in registration order', () => {
		registerSCMProvider(fakeManifest('github', undefined, true));
		registerSCMProvider(fakeManifest('bitbucket'));
		registerSCMProvider(fakeManifest('gitlab', undefined, true));

		expect(listInstanceDefaultScmRoles()).toEqual([
			{
				providerId: 'github',
				providerLabel: 'github',
				role: 'reviewer',
				envVarKey: 'GITHUB_TOKEN_REVIEWER',
			},
			{
				providerId: 'gitlab',
				providerLabel: 'gitlab',
				role: 'reviewer',
				envVarKey: 'GITLAB_TOKEN_REVIEWER',
			},
		]);
	});

	// Runtime-readiness is part of eligibility: no project may route to a provider that
	// is not ready, so offering an instance default for it would invite an operator to
	// configure something that cannot run.
	it('skips a provider that is registered but not runtime-ready', () => {
		registerSCMProvider(fakeManifest('under-construction', false, true));
		expect(listInstanceDefaultScmRoles()).toEqual([]);
	});

	it('is empty when no provider opts in', () => {
		registerSCMProvider(fakeManifest('github'));
		expect(listInstanceDefaultScmRoles()).toEqual([]);
	});
});
