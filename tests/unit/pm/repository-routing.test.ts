import { describe, expect, it, vi } from 'vitest';

import {
	repositoryRoutingCandidates,
	resolveCardRepository,
	routeByClaimTokens,
	routeByRepositoryValue,
} from '@/pm/repository-routing.js';
import type { ItemRepositoryRoute, PMProvider, RepositoryRoutingCandidate } from '@/pm/types.js';
import { createMockProjectRecord } from '../../helpers/factories.js';

const CANDIDATES: RepositoryRoutingCandidate[] = [
	{ repo: 'acme/default', routingToken: 'token-default' },
	{ repo: 'acme/second', routingToken: 'token-second' },
];

describe('routeByClaimTokens', () => {
	it('routes a card to the non-default repository whose token it carries', () => {
		expect(routeByClaimTokens(['token-second'], CANDIDATES)).toEqual({
			status: 'routed',
			repo: 'acme/second',
		});
	});

	it('reports a card that claims nothing as unrouted rather than guessing the default', () => {
		expect(routeByClaimTokens([], CANDIDATES)).toEqual({ status: 'unrouted' });
	});

	it('reports a claim no candidate declares as unrouted', () => {
		expect(routeByClaimTokens(['token-nobody-owns'], CANDIDATES)).toEqual({ status: 'unrouted' });
	});

	it('reports a card claimed by two repositories as ambiguous, with the repos sorted', () => {
		expect(routeByClaimTokens(['token-second', 'token-default'], CANDIDATES)).toEqual({
			status: 'ambiguous',
			repos: ['acme/default', 'acme/second'],
		});
	});

	it('still routes when two claims name the same repository', () => {
		const candidates: RepositoryRoutingCandidate[] = [
			{ repo: 'acme/one', routingToken: 'alpha' },
			{ repo: 'acme/one', routingToken: 'beta' },
		];
		expect(routeByClaimTokens(['alpha', 'beta'], candidates)).toEqual({
			status: 'routed',
			repo: 'acme/one',
		});
	});

	it('never claims for a candidate that declares no token', () => {
		expect(routeByClaimTokens(['token-second'], [{ repo: 'acme/tokenless' }])).toEqual({
			status: 'unrouted',
		});
	});

	it('matches tokens exactly — these are opaque provider ids, not slugs', () => {
		expect(routeByClaimTokens(['TOKEN-SECOND'], CANDIDATES)).toEqual({ status: 'unrouted' });
		expect(routeByClaimTokens([' token-second'], CANDIDATES)).toEqual({ status: 'unrouted' });
	});

	it('answers unrouted for an empty candidate list', () => {
		expect(routeByClaimTokens(['token-second'], [])).toEqual({ status: 'unrouted' });
	});
});

// Issue #1237: a card that names its repository in a text field routes on the
// repository's own path, so no candidate needs a token.
describe('routeByRepositoryValue', () => {
	const REPOSITORIES: RepositoryRoutingCandidate[] = [
		{ repo: 'core3pl/KV-TMS/ai-sdlc' },
		{ repo: 'core3pl/KV-TMS/VikingKurier' },
	];
	const claim = (value: string) => ({ source: 'Repozytorium', value });

	it('routes to the repository whose repo equals the value, with no routing token declared', () => {
		expect(routeByRepositoryValue(claim('core3pl/KV-TMS/VikingKurier'), REPOSITORIES)).toEqual({
			status: 'routed',
			repo: 'core3pl/KV-TMS/VikingKurier',
		});
	});

	it('ignores surrounding whitespace a person typed around the value', () => {
		expect(routeByRepositoryValue(claim('  core3pl/KV-TMS/ai-sdlc\n'), REPOSITORIES)).toEqual({
			status: 'routed',
			repo: 'core3pl/KV-TMS/ai-sdlc',
		});
	});

	it('reports an empty value as unrouted, carrying the claim', () => {
		expect(routeByRepositoryValue(claim('   '), REPOSITORIES)).toEqual({
			status: 'unrouted',
			claim: { source: 'Repozytorium', value: '' },
		});
	});

	it.each([
		['a bare repository name', 'ai-sdlc'],
		['another casing', 'core3pl/kv-tms/ai-sdlc'],
		['a repository the project does not own', 'core3pl/KV-TMS/other'],
	])('matches exactly — %s names nothing', (_label, value) => {
		expect(routeByRepositoryValue(claim(value), REPOSITORIES)).toEqual({
			status: 'unrouted',
			claim: { source: 'Repozytorium', value },
		});
	});

	it('ignores routing tokens: a value equal to a token is not a repository', () => {
		expect(
			routeByRepositoryValue(claim('10001'), [{ repo: 'acme/one', routingToken: '10001' }]),
		).toEqual({ status: 'unrouted', claim: { source: 'Repozytorium', value: '10001' } });
	});
});

describe('repositoryRoutingCandidates', () => {
	it('carries every entry, with the routing token only where one is declared', () => {
		const record = createMockProjectRecord({
			repositories: [
				{ repo: 'acme/default', pmRoutingToken: 'token-default' },
				{ repo: 'acme/tokenless' },
			],
		});

		expect(repositoryRoutingCandidates(record)).toEqual([
			{ repo: 'acme/default', routingToken: 'token-default' },
			{ repo: 'acme/tokenless' },
		]);
	});
});

// Issue #686 phase 2 — the routing call ingress makes before it enqueues a `pm` job.
describe('resolveCardRepository', () => {
	/** A provider whose only interesting method is the routing one. */
	function fakeProvider(route: ItemRepositoryRoute | Error) {
		const resolveItemRepository = vi.fn(async () => {
			if (route instanceof Error) throw route;
			return route;
		});
		return { resolveItemRepository } as unknown as PMProvider & {
			resolveItemRepository: typeof resolveItemRepository;
		};
	}

	// The property that keeps every existing single-repository project unchanged: with
	// one repository there is nothing to choose, so no provider is built and no board
	// read is paid for.
	it('short-circuits a single-repository project without building a provider', async () => {
		const record = createMockProjectRecord({ repositories: [{ repo: 'acme/only' }] });
		const createProvider = vi.fn(() => {
			throw new Error('a single-repository project must consult no provider');
		});

		expect(await resolveCardRepository(record, createProvider, 'card-1')).toEqual({
			status: 'routed',
			repo: 'acme/only',
		});
		expect(createProvider).not.toHaveBeenCalled();
	});

	it("delegates a multi-repository project to the provider, with the project's candidates", async () => {
		const record = createMockProjectRecord({
			repositories: [
				{ repo: 'acme/default', pmRoutingToken: 'token-default' },
				{ repo: 'acme/second', pmRoutingToken: 'token-second' },
			],
		});
		const provider = fakeProvider({ status: 'routed', repo: 'acme/second' });

		expect(await resolveCardRepository(record, () => provider, 'card-1')).toEqual({
			status: 'routed',
			repo: 'acme/second',
		});
		expect(provider.resolveItemRepository).toHaveBeenCalledWith('card-1', [
			{ repo: 'acme/default', routingToken: 'token-default' },
			{ repo: 'acme/second', routingToken: 'token-second' },
		]);
	});

	it("passes the provider's refusals through rather than resolving them", async () => {
		const record = createMockProjectRecord({
			repositories: [{ repo: 'acme/default' }, { repo: 'acme/second' }],
		});

		expect(
			await resolveCardRepository(record, () => fakeProvider({ status: 'unrouted' }), 'card-1'),
		).toEqual({ status: 'unrouted' });
	});

	// An unknown answer must surface, never degrade to the default entry — the caller
	// refuses the delivery instead of pushing a branch into a repository nobody chose.
	it('lets a provider failure surface instead of falling back to the default entry', async () => {
		const record = createMockProjectRecord({
			repositories: [{ repo: 'acme/default' }, { repo: 'acme/second' }],
		});

		await expect(
			resolveCardRepository(record, () => fakeProvider(new Error('board unreachable')), 'card-1'),
		).rejects.toThrow('board unreachable');
	});
});
