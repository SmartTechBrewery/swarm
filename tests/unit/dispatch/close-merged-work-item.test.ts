import { describe, expect, it, vi } from 'vitest';

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import type { RunRow } from '@/db/repositories/runsRepository.js';
import {
	applyCloseMergedWorkItem,
	type CloseMergedWorkItemDeps,
	planCloseMergedWorkItem,
} from '@/dispatch/close-merged-work-item.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';
import type { PullRequestDetails } from '@/scm/types.js';
import {
	createFakeScmProvider,
	createMockProjectConfig,
	createMockWorkItem,
} from '../../helpers/factories.js';

/**
 * Closing the work item behind a merged pull request (issue #1351). The provider
 * reads, the run read and the dependency wake are all fakes, so what is under test
 * is when the close is refused, which work item it resolves, and that the write is
 * the provider-agnostic close + move to `done` followed by the wake.
 */

vi.mock('@/lib/logger.js', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const project = createMockProjectConfig({ id: 'proj-a', repo: 'acme/app' });

function pullRequest(overrides: Partial<PullRequestDetails> = {}): PullRequestDetails {
	return {
		number: 42,
		headBranch: 'issue-17',
		headSha: 'head',
		baseBranch: 'main',
		baseSha: 'base',
		mergeable: null,
		authorLogin: 'someone',
		state: 'closed',
		merged: true,
		...overrides,
	};
}

function openCard(overrides: Partial<WorkItem> = {}): WorkItem {
	return createMockWorkItem({
		id: 'card-17',
		title: 'Ship it',
		url: 'https://example.test/card-17',
		status: 'In review',
		statusKey: 'inReview',
		...overrides,
	});
}

function pmWith(overrides: Partial<PMProvider> = {}): PMProvider {
	return {
		type: 'github-projects',
		getWorkItem: vi.fn(async (id: string) => openCard({ id })),
		listWorkItems: vi.fn(async () => {
			throw new Error('a one-card close must never read the whole board');
		}),
		findWorkItemByUrlSuffix: vi.fn(async () => undefined),
		findWorkItemForArtifact: vi.fn(async () => undefined),
		findWorkItemByDescriptionMarker: vi.fn(async () => undefined),
		moveWorkItem: vi.fn(async () => {}),
		closeWorkItem: vi.fn(async () => {}),
		addComment: vi.fn(async () => 'c1'),
		findComment: vi.fn(async () => undefined),
		createWorkItem: vi.fn(async () => createMockWorkItem()),
		updateWorkItem: vi.fn(async () => {}),
		addLabel: vi.fn(async () => {}),
		supportsDependencies: true,
		supportsAssignees: true,
		listBlockers: vi.fn(async () => []),
		listDependents: vi.fn(async () => []),
		addBlockedBy: vi.fn(async () => {}),
		resolveItemRepository: vi.fn(async () => ({ status: 'unrouted' }) as const),
		...overrides,
	};
}

function depsWith(overrides: Partial<CloseMergedWorkItemDeps> = {}): CloseMergedWorkItemDeps {
	return {
		latestReviewRun: vi.fn(async () => undefined),
		taskIdForPrBranch: vi.fn(async () => '17'),
		promoteDependencyWaits: vi.fn(async () => [{ id: 'dispatch-1' } as DispatchRow]),
		...overrides,
	};
}

function target(pm: PMProvider, pr: PullRequestDetails = pullRequest()) {
	return {
		project,
		pm,
		scm: createFakeScmProvider({ getPullRequest: vi.fn(async () => pr) }),
		prNumber: 42,
	};
}

describe('planCloseMergedWorkItem', () => {
	it("resolves the card through the issue the PR's task branch names, and plans the close", async () => {
		const pm = pmWith({
			findWorkItemForArtifact: vi.fn(async (artifact) =>
				artifact.kind === 'issue' && artifact.number === '17' ? openCard() : undefined,
			),
		});
		const deps = depsWith();

		const plan = await planCloseMergedWorkItem(target(pm), deps);

		expect(plan).toMatchObject({
			projectId: 'proj-a',
			repository: 'acme/app',
			prNumber: 42,
			pullRequest: { state: 'closed', merged: true, headBranch: 'issue-17' },
			workItem: {
				id: 'card-17',
				status: 'In review',
				statusKey: 'inReview',
				resolvedVia: 'task-issue',
			},
			refusal: null,
		});
		expect(plan.intendedChanges).toHaveLength(3);
		expect(deps.taskIdForPrBranch).toHaveBeenCalledWith(project, 'issue-17');
		expect(pm.closeWorkItem).not.toHaveBeenCalled();
		expect(deps.promoteDependencyWaits).not.toHaveBeenCalled();
	});

	it("prefers the card SWARM recorded on the PR's Review run", async () => {
		const pm = pmWith();
		const deps = depsWith({
			latestReviewRun: vi.fn(async () => ({ workItemId: 'card-recorded' }) as RunRow),
		});

		const plan = await planCloseMergedWorkItem(target(pm), deps);

		expect(deps.latestReviewRun).toHaveBeenCalledWith('proj-a', 'acme/app', '42');
		expect(pm.getWorkItem).toHaveBeenCalledWith('card-recorded');
		expect(pm.findWorkItemForArtifact).not.toHaveBeenCalled();
		expect(plan.workItem).toMatchObject({ id: 'card-recorded', resolvedVia: 'run-link' });
	});

	it('falls back to the pull request itself as the artifact', async () => {
		const pm = pmWith({
			findWorkItemForArtifact: vi.fn(async (artifact) =>
				artifact.kind === 'pullRequest' ? openCard({ id: 'card-pr' }) : undefined,
			),
		});

		const plan = await planCloseMergedWorkItem(target(pm), depsWith());

		expect(pm.findWorkItemForArtifact).toHaveBeenCalledTimes(2);
		expect(pm.findWorkItemForArtifact).toHaveBeenLastCalledWith({
			repository: 'acme/app',
			kind: 'pullRequest',
			number: '42',
		});
		expect(plan.workItem).toMatchObject({ id: 'card-pr', resolvedVia: 'pull-request' });
	});

	it.each([
		['still open', { state: 'open', merged: false } as const, /still open/],
		['closed without merging', { state: 'closed', merged: false } as const, /without being merged/],
	])('refuses a pull request %s', async (_label, prState, message) => {
		const pm = pmWith({ findWorkItemForArtifact: vi.fn(async () => openCard()) });

		const plan = await planCloseMergedWorkItem(target(pm, pullRequest(prState)), depsWith());

		expect(plan.refusal).toMatchObject({
			reason: 'not-merged',
			message: expect.stringMatching(message),
		});
		expect(plan.workItem).toMatchObject({ id: 'card-17' });
		expect(plan.intendedChanges).toEqual([]);
	});

	it('refuses a work item that is already done', async () => {
		const pm = pmWith({
			findWorkItemForArtifact: vi.fn(async () => openCard({ status: 'Done', statusKey: 'done' })),
		});

		const plan = await planCloseMergedWorkItem(target(pm), depsWith());

		expect(plan.refusal).toMatchObject({ reason: 'already-done' });
		expect(plan.workItem).toMatchObject({ status: 'Done', statusKey: 'done' });
		expect(plan.intendedChanges).toEqual([]);
	});

	it('refuses a merged pull request no work item backs', async () => {
		const plan = await planCloseMergedWorkItem(target(pmWith()), depsWith());

		expect(plan.refusal).toMatchObject({ reason: 'no-work-item' });
		expect(plan.workItem).toBeNull();
	});

	it('throws when a board lookup fails, rather than reading it as no work item', async () => {
		const pm = pmWith({
			findWorkItemForArtifact: vi.fn(async () => {
				throw new Error('board down');
			}),
		});

		await expect(planCloseMergedWorkItem(target(pm), depsWith())).rejects.toThrow('board down');
	});
});

describe('applyCloseMergedWorkItem', () => {
	it('closes the work item, moves it to done, then wakes the dependency waits', async () => {
		const pm = pmWith({ findWorkItemForArtifact: vi.fn(async () => openCard()) });
		const deps = depsWith();
		const plan = await planCloseMergedWorkItem(target(pm), deps);
		if (!plan.workItem) throw new Error('expected a work item');

		const result = await applyCloseMergedWorkItem({ ...plan, workItem: plan.workItem }, pm, deps);

		expect(pm.closeWorkItem).toHaveBeenCalledWith('card-17');
		expect(pm.moveWorkItem).toHaveBeenCalledWith('card-17', 'done');
		expect(deps.promoteDependencyWaits).toHaveBeenCalledWith('proj-a', 'operator');
		const closeOrder = vi.mocked(pm.closeWorkItem).mock.invocationCallOrder[0];
		const moveOrder = vi.mocked(pm.moveWorkItem).mock.invocationCallOrder[0];
		const wakeOrder = vi.mocked(deps.promoteDependencyWaits).mock.invocationCallOrder[0];
		expect(closeOrder).toBeLessThan(moveOrder);
		expect(moveOrder).toBeLessThan(wakeOrder);
		expect(result).toEqual({
			projectId: 'proj-a',
			repository: 'acme/app',
			prNumber: 42,
			workItem: plan.workItem,
			closed: true,
			woken: 1,
			wokenDispatchIds: ['dispatch-1'],
		});
	});

	it('wakes nothing when the close fails', async () => {
		const pm = pmWith({
			findWorkItemForArtifact: vi.fn(async () => openCard()),
			closeWorkItem: vi.fn(async () => {
				throw new Error('refused by the board');
			}),
		});
		const deps = depsWith();
		const plan = await planCloseMergedWorkItem(target(pm), deps);
		if (!plan.workItem) throw new Error('expected a work item');

		await expect(
			applyCloseMergedWorkItem({ ...plan, workItem: plan.workItem }, pm, deps),
		).rejects.toThrow('refused by the board');
		expect(pm.moveWorkItem).not.toHaveBeenCalled();
		expect(deps.promoteDependencyWaits).not.toHaveBeenCalled();
	});
});
