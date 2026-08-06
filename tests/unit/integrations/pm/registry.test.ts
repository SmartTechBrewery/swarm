import { beforeEach, describe, expect, it } from 'vitest';
import type { PMProviderManifest } from '@/integrations/pm/manifest.js';
import {
	_resetPMProviderRegistryForTesting,
	getPMProvider,
	listPMProviders,
	registerPMProvider,
	requireProjectPMAdapter,
	requireProjectPMProvider,
} from '@/integrations/pm/registry.js';
import type { PMRouterAdapter } from '@/pm/router-adapter.js';
import type { PMProvider, PMType } from '@/pm/types.js';
import { createMockProjectConfig } from '../../../helpers/factories.js';

/**
 * A minimal manifest stand-in. The registry doesn't touch `configSchema` /
 * `routerAdapter`, so the tests cast a bare identity object rather than
 * constructing the real provider — keeps these unit tests about the registry's
 * bookkeeping, not the provider's wiring.
 */
function fakeManifest(id: string): PMProviderManifest {
	return { id, label: id, category: 'pm' } as unknown as PMProviderManifest;
}

describe('pmProviderRegistry', () => {
	beforeEach(() => {
		_resetPMProviderRegistryForTesting();
	});

	it('registers a manifest and looks it up by id', () => {
		const manifest = fakeManifest('github-projects');
		registerPMProvider(manifest);
		expect(getPMProvider('github-projects')).toBe(manifest);
	});

	it('returns null for an unregistered id', () => {
		expect(getPMProvider('nope')).toBeNull();
	});

	it('lists registered manifests in registration order', () => {
		registerPMProvider(fakeManifest('a'));
		registerPMProvider(fakeManifest('b'));
		expect(listPMProviders().map((m) => m.id)).toEqual(['a', 'b']);
	});

	it('throws on a duplicate id rather than silently shadowing', () => {
		registerPMProvider(fakeManifest('github-projects'));
		expect(() => registerPMProvider(fakeManifest('github-projects'))).toThrow(/already registered/);
	});

	it('returns a copy from listPMProviders so callers cannot mutate the registry', () => {
		registerPMProvider(fakeManifest('a'));
		const list = listPMProviders() as PMProviderManifest[];
		list.push(fakeManifest('b'));
		expect(listPMProviders().map((m) => m.id)).toEqual(['a']);
	});

	it('reset clears the registry', () => {
		registerPMProvider(fakeManifest('a'));
		_resetPMProviderRegistryForTesting();
		expect(listPMProviders()).toHaveLength(0);
		expect(getPMProvider('a')).toBeNull();
	});

	// Project→provider selection is a plain lookup on `project.pm.type` — the config
	// discriminator the SCM side lacks — so these need no single-provider assertion
	// (issue #297, ai/RULES.md §2).
	describe('project-scoped resolution', () => {
		const provider = { type: 'github-projects' } as unknown as PMProvider;
		const routerAdapter = { type: 'github-projects' } as unknown as PMRouterAdapter;

		function selectableManifest(id: PMType): PMProviderManifest {
			return {
				id,
				label: id,
				category: 'pm',
				createProvider: () => provider,
				routerAdapter,
				credentialRoles: [],
			} as unknown as PMProviderManifest;
		}

		it('resolves the provider named by project.pm.type', () => {
			registerPMProvider(selectableManifest('github-projects'));
			expect(requireProjectPMProvider(createMockProjectConfig())).toBe(provider);
		});

		it('resolves the router adapter named by project.pm.type', () => {
			registerPMProvider(selectableManifest('github-projects'));
			expect(requireProjectPMAdapter(createMockProjectConfig())).toBe(routerAdapter);
		});

		it('picks the manifest matching the discriminator, not whichever registered first', () => {
			registerPMProvider(selectableManifest('jira'));
			registerPMProvider(selectableManifest('github-projects'));
			expect(requireProjectPMProvider(createMockProjectConfig()).type).toBe('github-projects');
			expect(getPMProvider('github-projects')?.id).toBe('github-projects');
		});

		it('throws an actionable wiring error when nothing is registered for the id', () => {
			const project = createMockProjectConfig({ id: 'acme' });
			expect(() => requireProjectPMProvider(project)).toThrow(
				/PM provider 'github-projects' \(project 'acme'\) is not registered/,
			);
			expect(() => requireProjectPMAdapter(project)).toThrow(/is not registered/);
		});
	});
});
