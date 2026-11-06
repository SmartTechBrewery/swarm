import { describe, expect, it, vi } from 'vitest';

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import type { PipelineRunRow } from '@/db/repositories/runsRepository.js';
import {
	type ConsistencyCheckDeps,
	MAX_DEPENDENCY_WAITS_CHECKED,
	runConsistencyCheck,
} from '@/dispatch/consistency-check.js';
import type { PMProvider, WorkItem, WorkItemArtifact, WorkItemBlocker } from '@/pm/types.js';
import {
	createMockPmEvent,
	createMockPmWebhookJob,
	createMockProjectConfig,
	createMockScmEvent,
	createMockScmWebhookJob,
	createMockWorkItem,
} from '../../helpers/factories.js';

/**
 * The operator consistency check (issue #1344). The datastore reads are injected and
 * the board is a fake `PMProvider`, so what is under test is which candidates become
 * findings, through which one-card lookups, and that a failed read is reported as
 * unchecked rather than as a finding.
 */

vi.mock('@/lib/logger.js', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const NOW = new Date('2026-11-06T12:00:00Z');
const project = createMockProjectConfig({ id: 'proj-a', repo: 'acme/app' });

function pmWith(overrides: Partial<PMProvider> = {}): PMProvider {
	return {
		type: 'github-projects',
		getWorkItem: vi.fn(async (id: string) => createMockWorkItem({ id })),
		listWorkItems: vi.fn(async () => {
			throw new Error('a consistency check must never read the whole board');
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

function mergedRun(overrides: Partial<PipelineRunRow> = {}): PipelineRunRow {
	return {
		id: 'run-review-1',
		projectId: 'proj-a',
		repository: 'acme/app',
		taskId: '42',
		prNumber: '42',
		workItemId: null,
		phase: 'review',
		reviewMergeOutcome: 'merged',
		completedAt: new Date('2026-11-06T10:00:00Z'),
		jobPayload: createMockScmWebhookJob({
			event: createMockScmEvent({
				repoFullName: 'acme/app',
				workItemId: '42',
				prBranch: 'issue-17',
			}),
		}),
		...overrides,
	} as PipelineRunRow;
}

function dependencyWait(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'dispatch-1',
		projectId: 'proj-a',
		taskId: '17',
		phase: 'implementation',
		repository: 'acme/app',
		state: 'retry-scheduled',
		waitReason: 'dependency',
		availableAt: new Date('2026-11-06T12:05:00Z'),
		jobPayload: createMockPmWebhookJob({
			event: createMockPmEvent({ itemId: 'PVTI_17' }),
			dependencyBlockers: [{ reference: '#9', url: 'https://example.test/9' }],
		}),
		...overrides,
	} as DispatchRow;
}

function depsWith(overrides: Partial<ConsistencyCheckDeps> = {}): ConsistencyCheckDeps {
	return {
		listMergedReviewRuns: vi.fn(async () => []),
		listDependencyWaits: vi.fn(async () => []),
		taskIdForPrBranch: vi.fn(async (_projectId: string, _repo: string, branch: string) =>
			branch.replace(/^issue-/, ''),
		),
		now: () => NOW,
		...overrides,
	};
}

function blocker(overrides: Partial<WorkItemBlocker> = {}): WorkItemBlocker {
	return {
		reference: '#9',
		url: 'https://example.test/9',
		title: 'Prerequisite',
		open: false,
		source: 'dependency',
		...overrides,
	};
}

/** A board that holds `item` behind the issue artifact `#17` of `acme/app`. */
function boardWithIssue17(item: WorkItem) {
	return vi.fn(async (artifact: WorkItemArtifact) =>
		artifact.kind === 'issue' && artifact.number === '17' ? item : undefined,
	);
}

describe('runConsistencyCheck — merged pull requests', () => {
	it("reports a merged pull request whose task's card is still open", async () => {
		const card = createMockWorkItem({
			id: 'PVTI_17',
			title: 'Add the widget',
			url: 'https://example.test/issues/17',
			status: 'In review',
			statusKey: 'inReview',
		});
		const findWorkItemForArtifact = boardWithIssue17(card);
		const pm = pmWith({ findWorkItemForArtifact });
		const deps = depsWith({ listMergedReviewRuns: vi.fn(async () => [mergedRun()]) });

		const result = await runConsistencyCheck(project, pm, 24, deps);

		expect(deps.listMergedReviewRuns).toHaveBeenCalledWith(
			'proj-a',
			new Date('2026-11-05T12:00:00Z'),
			50,
		);
		expect(deps.taskIdForPrBranch).toHaveBeenCalledWith('proj-a', 'acme/app', 'issue-17');
		expect(findWorkItemForArtifact).toHaveBeenCalledWith({
			repository: 'acme/app',
			kind: 'issue',
			number: '17',
		});
		expect(result.findings).toEqual([
			{
				kind: 'merged-pr-open-work-item',
				repository: 'acme/app',
				prNumber: 42,
				taskId: '17',
				workItemId: 'PVTI_17',
				workItemUrl: 'https://example.test/issues/17',
				detail: expect.stringContaining('still in In review'),
				suggestedAction: expect.stringContaining('work_item_close'),
			},
		]);
		expect(result.unchecked).toEqual([]);
		expect(result.since).toBe('2026-11-05T12:00:00.000Z');
		expect(pm.listWorkItems).not.toHaveBeenCalled();
	});

	it('reports nothing once the card is done', async () => {
		const pm = pmWith({
			findWorkItemForArtifact: boardWithIssue17(
				createMockWorkItem({ id: 'PVTI_17', statusKey: 'done' }),
			),
		});
		const deps = depsWith({ listMergedReviewRuns: vi.fn(async () => [mergedRun()]) });

		const result = await runConsistencyCheck(project, pm, 24, deps);

		expect(result.findings).toEqual([]);
		expect(result.unchecked).toEqual([]);
	});

	it('falls back to the pull request artifact, and reports nothing for a PR with no card', async () => {
		const pm = pmWith();
		const deps = depsWith({ listMergedReviewRuns: vi.fn(async () => [mergedRun()]) });

		const result = await runConsistencyCheck(project, pm, 24, deps);

		expect(pm.findWorkItemForArtifact).toHaveBeenNthCalledWith(2, {
			repository: 'acme/app',
			kind: 'pullRequest',
			number: '42',
		});
		expect(result.findings).toEqual([]);
	});

	it('reads the card a run recorded directly, and checks each pull request once', async () => {
		const getWorkItem = vi.fn(async (id: string) =>
			createMockWorkItem({ id, statusKey: 'inProgress' }),
		);
		const pm = pmWith({ getWorkItem });
		const run = mergedRun({ workItemId: 'PVTI_REC' });
		const deps = depsWith({
			listMergedReviewRuns: vi.fn(async () => [run, { ...run, id: 'run-review-0' }]),
		});

		const result = await runConsistencyCheck(project, pm, 24, deps);

		expect(getWorkItem).toHaveBeenCalledTimes(1);
		expect(pm.findWorkItemForArtifact).not.toHaveBeenCalled();
		expect(result.findings.map((f) => f.workItemId)).toEqual(['PVTI_REC']);
	});

	it('reports a failed board read as unchecked, not as a finding', async () => {
		const pm = pmWith({
			findWorkItemForArtifact: vi.fn(async () => {
				throw new Error('board unavailable');
			}),
		});
		const deps = depsWith({ listMergedReviewRuns: vi.fn(async () => [mergedRun()]) });

		const result = await runConsistencyCheck(project, pm, 24, deps);

		expect(result.findings).toEqual([]);
		expect(result.unchecked).toEqual([
			expect.objectContaining({
				kind: 'merged-pr-open-work-item',
				prNumber: 42,
				taskId: '17',
				reason: expect.stringContaining('board unavailable'),
			}),
		]);
	});
});

describe('runConsistencyCheck — dependency waits', () => {
	it('reports a wait whose recorded blockers are all closed', async () => {
		const listBlockers = vi.fn(async () => [blocker({ open: false })]);
		const getWorkItem = vi.fn(async (id: string) =>
			createMockWorkItem({ id, title: 'Dependent', url: 'https://example.test/issues/17' }),
		);
		const pm = pmWith({ listBlockers, getWorkItem });
		const deps = depsWith({ listDependencyWaits: vi.fn(async () => [dependencyWait()]) });

		const result = await runConsistencyCheck(project, pm, 24, deps);

		expect(listBlockers).toHaveBeenCalledWith('PVTI_17');
		expect(result.findings).toEqual([
			{
				kind: 'dependency-wait-blockers-done',
				repository: 'acme/app',
				taskId: '17',
				dispatchId: 'dispatch-1',
				workItemId: 'PVTI_17',
				workItemUrl: 'https://example.test/issues/17',
				detail: expect.stringContaining('blocked by #9'),
				suggestedAction: expect.stringContaining('dependency_waits_wake'),
			},
		]);
	});

	it('reports nothing while a native blocker is still open', async () => {
		const pm = pmWith({ listBlockers: vi.fn(async () => [blocker({ open: true })]) });
		const deps = depsWith({ listDependencyWaits: vi.fn(async () => [dependencyWait()]) });

		const result = await runConsistencyCheck(project, pm, 24, deps);

		expect(result.findings).toEqual([]);
		expect(pm.getWorkItem).not.toHaveBeenCalled();
	});

	it('treats an open prose-only prerequisite as finished, exactly as the gate does, without commenting', async () => {
		const pm = pmWith({
			listBlockers: vi.fn(async () => [blocker({ open: true, source: 'mention' })]),
		});
		const deps = depsWith({ listDependencyWaits: vi.fn(async () => [dependencyWait()]) });

		const result = await runConsistencyCheck(project, pm, 24, deps);

		expect(result.findings.map((f) => f.kind)).toEqual(['dependency-wait-blockers-done']);
		expect(pm.addComment).not.toHaveBeenCalled();
	});

	it('skips the dependency check for a provider without dependencies', async () => {
		const pm = pmWith({ supportsDependencies: false });
		const deps = depsWith({ listDependencyWaits: vi.fn(async () => [dependencyWait()]) });

		const result = await runConsistencyCheck(project, pm, 24, deps);

		expect(deps.listDependencyWaits).not.toHaveBeenCalled();
		expect(pm.listBlockers).not.toHaveBeenCalled();
		expect(result.findings).toEqual([]);
	});

	it('reports a failed blocker read as unchecked', async () => {
		const pm = pmWith({
			listBlockers: vi.fn(async () => {
				throw new Error('rate limited');
			}),
		});
		const deps = depsWith({ listDependencyWaits: vi.fn(async () => [dependencyWait()]) });

		const result = await runConsistencyCheck(project, pm, 24, deps);

		expect(result.findings).toEqual([]);
		expect(result.unchecked).toEqual([
			expect.objectContaining({
				kind: 'dependency-wait-blockers-done',
				dispatchId: 'dispatch-1',
				workItemId: 'PVTI_17',
				reason: expect.stringContaining('rate limited'),
			}),
		]);
	});

	it('caps the waits it re-reads and says so', async () => {
		const waits = Array.from({ length: MAX_DEPENDENCY_WAITS_CHECKED + 1 }, (_, i) =>
			dependencyWait({ id: `dispatch-${i}` }),
		);
		const pm = pmWith({ listBlockers: vi.fn(async () => [blocker({ open: true })]) });
		const deps = depsWith({ listDependencyWaits: vi.fn(async () => waits) });

		const result = await runConsistencyCheck(project, pm, 24, deps);

		expect(pm.listBlockers).toHaveBeenCalledTimes(MAX_DEPENDENCY_WAITS_CHECKED);
		expect(result.truncated).toBe(true);
	});
});
