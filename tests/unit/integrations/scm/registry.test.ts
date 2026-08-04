import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@/config/schema.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	getSCMProvider,
	listSCMProviders,
	registerSCMProvider,
	requireProjectSCMProvider,
} from '@/integrations/scm/registry.js';
import { createMockProjectConfig } from '../../../helpers/factories.js';

/**
 * A minimal manifest stand-in. The registry only ever hands `provider` back, never
 * calls into it, so the tests cast a bare identity object rather than constructing
 * the real integration — keeps these unit tests about the registry's bookkeeping,
 * not the provider's wiring.
 */
function fakeManifest(id: string, runtimeReady?: boolean): SCMProviderManifest {
	return {
		id,
		label: id,
		category: 'scm',
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
});

/**
 * The project-scoped lookup every outbound call site uses (issue #386). Its whole
 * contract is "exactly one provider, or throw" — no selection, no fallback — so
 * these cases pin the throw as deliberate behavior rather than an oversight a
 * future provider's author would "fix" by picking the first manifest.
 */
describe('requireProjectSCMProvider', () => {
	beforeEach(() => {
		_resetSCMProviderRegistryForTesting();
	});

	it('resolves the sole registered provider', () => {
		const manifest = fakeManifest('github');
		registerSCMProvider(manifest);
		expect(requireProjectSCMProvider(project)).toBe(manifest.provider);
	});

	it('throws naming the project when nothing is registered', () => {
		// Substring, not a built RegExp: the project id is data, and a factory id
		// that ever grew a regex metacharacter would silently stop matching.
		expect(() => requireProjectSCMProvider(project)).toThrow(
			`Cannot resolve the SCM provider for project '${project.id}': 0 runtime-ready of 0 registered`,
		);
	});

	it('throws rather than picking one once a second runtime-ready provider registers', () => {
		registerSCMProvider(fakeManifest('github'));
		registerSCMProvider(fakeManifest('bitbucket'));
		expect(() => requireProjectSCMProvider(project)).toThrow(
			/2 runtime-ready of 2 registered, expected exactly one/,
		);
	});

	// The `runtimeReady: false` opt-out (issue #296) is what lets a provider being
	// built out phase by phase register without every project-scoped call site
	// refusing to choose. It is not a selection mechanism: the case above still
	// throws for two providers that both claim readiness.
	it('ignores a provider that is not runtime-ready', () => {
		const github = fakeManifest('github');
		registerSCMProvider(github);
		registerSCMProvider(fakeManifest('bitbucket', false));
		expect(requireProjectSCMProvider(project)).toBe(github.provider);
	});

	it('throws when the only registered provider is not runtime-ready', () => {
		registerSCMProvider(fakeManifest('bitbucket', false));
		expect(() => requireProjectSCMProvider(project)).toThrow(
			/0 runtime-ready of 1 registered, expected exactly one/,
		);
	});
});
