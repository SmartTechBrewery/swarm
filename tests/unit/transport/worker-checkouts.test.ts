import { describe, expect, it, vi } from 'vitest';
import {
	declaredRepositories,
	resolveWorkerCheckouts,
	selectCheckout,
	WorkerCheckoutConfigError,
} from '@/transport/worker-checkouts.js';

/** The `origin` read, stubbed from a path → slug map so no git checkout is needed. */
function slugResolver(byRoot: Record<string, string | undefined>) {
	return vi.fn(async (repoRoot: string) => byRoot[repoRoot]);
}

describe('resolveWorkerCheckouts (issue #1058)', () => {
	it('resolves each root to the repository it is, keeping declaration order', async () => {
		const checkouts = await resolveWorkerCheckouts(
			['/checkouts/swarm', '/checkouts/cascade'],
			slugResolver({
				'/checkouts/swarm': 'smarttechbrewery/swarm',
				'/checkouts/cascade': 'mongrel-intelligence/cascade',
			}),
		);

		expect(checkouts).toEqual([
			{ repoRoot: '/checkouts/swarm', repository: 'smarttechbrewery/swarm' },
			{ repoRoot: '/checkouts/cascade', repository: 'mongrel-intelligence/cascade' },
		]);
		// Primary first — what the handshake declares as `repository` for a control plane
		// predating the set.
		expect(declaredRepositories(checkouts)).toEqual([
			'smarttechbrewery/swarm',
			'mongrel-intelligence/cascade',
		]);
	});

	// Nothing could choose between them, and an operator who named one checkout twice
	// through two spellings meant to name two.
	it('refuses two checkouts of the same repository, naming both paths', async () => {
		await expect(
			resolveWorkerCheckouts(
				['/checkouts/swarm', '/elsewhere/swarm'],
				slugResolver({
					'/checkouts/swarm': 'smarttechbrewery/swarm',
					'/elsewhere/swarm': 'smarttechbrewery/swarm',
				}),
			),
		).rejects.toThrow(WorkerCheckoutConfigError);

		await expect(
			resolveWorkerCheckouts(
				['/checkouts/swarm', '/elsewhere/swarm'],
				slugResolver({
					'/checkouts/swarm': 'smarttechbrewery/swarm',
					'/elsewhere/swarm': 'smarttechbrewery/swarm',
				}),
			),
		).rejects.toThrow(/\/checkouts\/swarm and \/elsewhere\/swarm/);
	});

	// With several checkouts there is no other way to pick one, so accepting an
	// unidentifiable one would mean routing assignments to a checkout nobody can name.
	it('refuses an unidentifiable checkout when there is more than one', async () => {
		await expect(
			resolveWorkerCheckouts(
				['/checkouts/swarm', '/checkouts/mystery'],
				slugResolver({
					'/checkouts/swarm': 'smarttechbrewery/swarm',
					'/checkouts/mystery': undefined,
				}),
			),
		).rejects.toThrow(/\/checkouts\/mystery/);
	});

	// The primary checkout gets no exemption: `swarm workers add-checkout` mirrors this.
	it('refuses an unidentifiable primary checkout beside another', async () => {
		await expect(
			resolveWorkerCheckouts(
				['/checkouts/mystery', '/checkouts/swarm'],
				slugResolver({
					'/checkouts/mystery': undefined,
					'/checkouts/swarm': 'smarttechbrewery/swarm',
				}),
			),
		).rejects.toThrow(/\/checkouts\/mystery/);
	});

	// Today's behaviour (issue #687) and it stays: the daemon declares nothing and
	// `assertRepoIdentity` is its guard at provision time.
	it('allows a single unidentifiable checkout, which declares nothing', async () => {
		const checkouts = await resolveWorkerCheckouts(
			['/checkouts/mystery'],
			slugResolver({ '/checkouts/mystery': undefined }),
		);

		expect(checkouts).toEqual([{ repoRoot: '/checkouts/mystery' }]);
		expect(declaredRepositories(checkouts)).toEqual([]);
	});
});

describe('selectCheckout (issue #1058)', () => {
	const SWARM = { repoRoot: '/checkouts/swarm', repository: 'smarttechbrewery/swarm' };
	const CASCADE = { repoRoot: '/checkouts/cascade', repository: 'mongrel-intelligence/cascade' };

	it('picks the checkout whose repository the assignment names', () => {
		expect(selectCheckout([SWARM, CASCADE], 'mongrel-intelligence/cascade')).toBe(CASCADE);
	});

	// Both sides go through the shared normaliser, so a host's own casing and a trailing
	// `.git` are noise rather than a different repository.
	it('matches through the shared slug normaliser', () => {
		expect(selectCheckout([SWARM, CASCADE], 'SmartTechBrewery/Swarm.git')).toBe(SWARM);
	});

	it('returns undefined for a repository this worker holds no checkout of', () => {
		expect(selectCheckout([SWARM, CASCADE], 'acme/backend')).toBeUndefined();
	});

	// The #687 fallback, narrowed to the only case it is not a guess in.
	it('falls back to the single checkout that declared nothing', () => {
		const undeclared = { repoRoot: '/checkouts/mystery' };
		expect(selectCheckout([undeclared], 'acme/backend')).toBe(undeclared);
		expect(selectCheckout([undeclared, SWARM], 'acme/backend')).toBeUndefined();
	});
});
