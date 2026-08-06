import { describe, expect, it, vi } from 'vitest';

import { findWorkItemForPullRequest } from '@/pm/pull-request-work-item.js';
import type { PMProvider } from '@/pm/types.js';
import { createMockWorkItem } from '../../helpers/factories.js';

/**
 * A provider whose only exercised method is the narrow card lookup — the seam the
 * gate resolves a PR's board item through (issue #354). `impl` answers per URL
 * suffix so a test can say which suffix has a card behind it.
 */
function pmReturning(impl: (urlSuffix: string) => Promise<unknown>) {
	const findWorkItemByUrlSuffix = vi.fn(impl);
	return {
		pm: { findWorkItemByUrlSuffix } as unknown as PMProvider,
		findWorkItemByUrlSuffix,
	};
}

describe('findWorkItemForPullRequest', () => {
	it('resolves the backing work item from the PR task branch', async () => {
		const item = createMockWorkItem({ id: 'item-354' });
		const { pm, findWorkItemByUrlSuffix } = pmReturning(async (suffix) =>
			suffix === '/issues/354' ? item : undefined,
		);

		await expect(
			findWorkItemForPullRequest(pm, { issueNumber: '354', prNumber: '512' }),
		).resolves.toBe(item);
		// The item's own card wins, so the PR suffix is never even asked for.
		expect(findWorkItemByUrlSuffix).toHaveBeenCalledTimes(1);
		expect(findWorkItemByUrlSuffix).toHaveBeenCalledWith('/issues/354');
	});

	it('falls back to the PR itself when no card wraps the work item', async () => {
		const prCard = createMockWorkItem({ id: 'item-pr-512' });
		const { pm, findWorkItemByUrlSuffix } = pmReturning(async (suffix) =>
			suffix === '/pull/512' ? prCard : undefined,
		);

		await expect(
			findWorkItemForPullRequest(pm, { issueNumber: '354', prNumber: '512' }),
		).resolves.toBe(prCard);
		expect(findWorkItemByUrlSuffix.mock.calls.map(([suffix]) => suffix)).toEqual([
			'/issues/354',
			'/pull/512',
		]);
	});

	it('asks only for the PR when the branch decodes to no work item', async () => {
		const { pm, findWorkItemByUrlSuffix } = pmReturning(async () => undefined);

		await expect(findWorkItemForPullRequest(pm, { prNumber: '512' })).resolves.toBeUndefined();
		expect(findWorkItemByUrlSuffix).toHaveBeenCalledExactlyOnceWith('/pull/512');
	});

	it('resolves undefined when nothing on the board backs the PR', async () => {
		const { pm } = pmReturning(async () => undefined);

		await expect(
			findWorkItemForPullRequest(pm, { issueNumber: '354', prNumber: '512' }),
		).resolves.toBeUndefined();
	});

	it('swallows a provider error rather than propagating it (fails open)', async () => {
		const { pm } = pmReturning(async () => {
			throw new Error('graphql 502');
		});

		await expect(
			findWorkItemForPullRequest(pm, { issueNumber: '354', prNumber: '512' }),
		).resolves.toBeUndefined();
	});
});
