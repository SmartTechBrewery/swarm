import { beforeEach, describe, expect, it } from 'vitest';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	getSCMProvider,
	listSCMProviders,
	registerSCMProvider,
} from '@/integrations/scm/registry.js';

/**
 * A minimal manifest stand-in. The registry never touches `provider`, so the
 * tests cast a bare identity object rather than constructing the real
 * integration — keeps these unit tests about the registry's bookkeeping, not the
 * provider's wiring.
 */
function fakeManifest(id: string): SCMProviderManifest {
	return { id, label: id, category: 'scm' } as unknown as SCMProviderManifest;
}

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
