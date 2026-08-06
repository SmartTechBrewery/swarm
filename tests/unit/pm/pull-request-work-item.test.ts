import { describe, expect, it, vi } from 'vitest';

import { findWorkItemForPullRequest } from '@/pm/pull-request-work-item.js';
import type { PMProvider } from '@/pm/types.js';
import { createMockWorkItem } from '../../helpers/factories.js';

/**
 * A provider whose only exercised method is the narrow card lookup — the seam the
 * gate resolves a PR's board item through (issue #354). `impl` answers per
 * repository-scoped artifact so a test can say which card it finds.
 */
function pmReturning(
	impl: (artifact: { repository: string; kind: string; number: string }) => Promise<unknown>,
) {
	const findWorkItemForArtifact = vi.fn(impl);
	return {
		pm: { findWorkItemForArtifact } as unknown as PMProvider,
		findWorkItemForArtifact,
	};
}

describe('findWorkItemForPullRequest', () => {
	it('resolves the backing work item from the PR task branch', async () => {
		const item = createMockWorkItem({ id: 'item-354' });
		const { pm, findWorkItemForArtifact } = pmReturning(async (artifact) =>
			artifact.kind === 'issue' && artifact.number === '354' ? item : undefined,
		);

		await expect(
			findWorkItemForPullRequest(pm, {
				repository: 'SmartTechBrewery/swarm',
				issueNumber: '354',
				prNumber: '512',
			}),
		).resolves.toBe(item);
		// The item's own card wins, so the PR suffix is never even asked for.
		expect(findWorkItemForArtifact).toHaveBeenCalledExactlyOnceWith({
			repository: 'SmartTechBrewery/swarm',
			kind: 'issue',
			number: '354',
		});
	});

	it('falls back to the PR itself when no card wraps the work item', async () => {
		const prCard = createMockWorkItem({ id: 'item-pr-512' });
		const { pm, findWorkItemForArtifact } = pmReturning(async (artifact) =>
			artifact.kind === 'pullRequest' && artifact.number === '512' ? prCard : undefined,
		);

		await expect(
			findWorkItemForPullRequest(pm, {
				repository: 'SmartTechBrewery/swarm',
				issueNumber: '354',
				prNumber: '512',
			}),
		).resolves.toBe(prCard);
		expect(findWorkItemForArtifact.mock.calls.map(([artifact]) => artifact)).toEqual([
			{ repository: 'SmartTechBrewery/swarm', kind: 'issue', number: '354' },
			{ repository: 'SmartTechBrewery/swarm', kind: 'pullRequest', number: '512' },
		]);
	});

	it('asks only for the PR when the branch decodes to no work item', async () => {
		const { pm, findWorkItemForArtifact } = pmReturning(async () => undefined);

		await expect(
			findWorkItemForPullRequest(pm, { repository: 'SmartTechBrewery/swarm', prNumber: '512' }),
		).resolves.toBeUndefined();
		expect(findWorkItemForArtifact).toHaveBeenCalledExactlyOnceWith({
			repository: 'SmartTechBrewery/swarm',
			kind: 'pullRequest',
			number: '512',
		});
	});

	it('resolves undefined when nothing on the board backs the PR', async () => {
		const { pm } = pmReturning(async () => undefined);

		await expect(
			findWorkItemForPullRequest(pm, {
				repository: 'SmartTechBrewery/swarm',
				issueNumber: '354',
				prNumber: '512',
			}),
		).resolves.toBeUndefined();
	});

	it('swallows a provider error rather than propagating it (fails open)', async () => {
		const { pm } = pmReturning(async () => {
			throw new Error('graphql 502');
		});

		await expect(
			findWorkItemForPullRequest(pm, {
				repository: 'SmartTechBrewery/swarm',
				issueNumber: '354',
				prNumber: '512',
			}),
		).resolves.toBeUndefined();
	});

	it('does not accept a same-numbered artifact from another repository', async () => {
		const own = createMockWorkItem({ id: 'own-card' });
		const { pm } = pmReturning(async (artifact) =>
			artifact.repository === 'SmartTechBrewery/swarm' ? own : undefined,
		);

		await expect(
			findWorkItemForPullRequest(pm, {
				repository: 'SmartTechBrewery/swarm',
				issueNumber: '354',
				prNumber: '512',
			}),
		).resolves.toBe(own);
	});
});
