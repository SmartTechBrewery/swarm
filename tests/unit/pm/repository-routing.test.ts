import { describe, expect, it } from 'vitest';

import { routeByClaimTokens } from '@/pm/repository-routing.js';
import type { RepositoryRoutingCandidate } from '@/pm/types.js';

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
