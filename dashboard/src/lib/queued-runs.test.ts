import { describe, expect, it } from 'vitest';
import type { QueuedRun } from '@/types/runs.js';
import {
	groupQueuedRuns,
	hideBoardRowsWithActiveRun,
	queuedPhaseLabel,
	queuedRunKey,
	queuedWorkItemLabel,
	queuedWorkItemTitle,
	queuedWorkItemUrl,
	reviewGateSourceEventLabel,
} from './queued-runs.js';

function githubRun(overrides: Partial<QueuedRun> = {}): QueuedRun {
	return {
		jobId: 'job-gh',
		projectId: 'proj',
		type: 'github',
		state: 'waiting',
		phaseHint: 'review',
		repo: 'acme/widgets',
		prNumber: '42',
		priority: 0,
		continuation: false,
		prioritizeContinuations: true,
		enqueuedAt: '2026-07-17T10:00:00.000Z',
		availableAt: '2026-07-17T10:00:00.000Z',
		...overrides,
	};
}

function boardRun(overrides: Partial<QueuedRun> = {}): QueuedRun {
	return {
		jobId: 'job-board',
		projectId: 'proj',
		type: 'github-projects',
		state: 'delayed',
		phaseHint: 'board',
		workItemNodeId: 'PVTI_lADODb1Ycc4Bcnwuzabc123',
		contentType: 'Issue',
		workItemTitle: 'Fix the widget',
		workItemUrl: 'https://github.com/acme/widgets/issues/42',
		priority: 5,
		continuation: false,
		prioritizeContinuations: true,
		enqueuedAt: '2026-07-17T09:00:00.000Z',
		availableAt: '2026-07-17T12:00:00.000Z',
		runsAt: '2026-07-17T12:00:00.000Z',
		...overrides,
	};
}

describe('queuedPhaseLabel', () => {
	it.each([
		['board', 'Board (Planning/Impl)'],
		['review', 'Review'],
		['respond-to-review', 'Respond to review'],
		['respond-to-ci', 'Respond to CI'],
		['resolve-conflicts', 'Resolve conflicts'],
		['unknown', 'Unknown'],
	] as const)('labels %s as "%s"', (hint, label) => {
		expect(queuedPhaseLabel(hint)).toBe(label);
	});
});

describe('queuedWorkItemLabel', () => {
	it('renders a github job as owner/repo #<n>', () => {
		expect(queuedWorkItemLabel(githubRun())).toBe('PR #42');
	});

	it('falls back to #<n> for a github job missing its repo', () => {
		expect(queuedWorkItemLabel(githubRun({ repo: undefined }))).toBe('PR #42');
	});

	it('renders a resolved github-projects job using the persisted run label rules', () => {
		expect(queuedWorkItemLabel(boardRun())).toBe('Issue: #42');
		expect(queuedWorkItemTitle(boardRun())).toBe('Fix the widget');
		expect(queuedWorkItemUrl(githubRun())).toBe('https://github.com/acme/widgets/pull/42');
		expect(queuedWorkItemUrl(boardRun())).toBe('https://github.com/acme/widgets/issues/42');
	});

	it('does not expose an opaque board node id when metadata is unavailable', () => {
		expect(
			queuedWorkItemLabel(
				boardRun({
					contentType: undefined,
					workItemNodeId: undefined,
					workItemTitle: undefined,
					workItemUrl: undefined,
				}),
			),
		).toBe('—');
	});

	it('uses an em dash when a board item cannot be resolved', () => {
		expect(queuedWorkItemLabel(boardRun({ workItemUrl: undefined }))).toBe('—');
	});
});

describe('queuedRunKey', () => {
	it('is the BullMQ job id', () => {
		expect(queuedRunKey(githubRun({ jobId: 'unique-job-id' }))).toBe('unique-job-id');
	});
});

function reviewGateRun(overrides: Partial<QueuedRun> = {}): QueuedRun {
	return githubRun({
		reviewGate: { sourceEvent: 'pull_request', sourceAction: 'opened', headSha: 'sha-1' },
		...overrides,
	});
}

describe('groupQueuedRuns', () => {
	it('renders a job with no reviewGate metadata as its own ungrouped row', () => {
		const rows = groupQueuedRuns([boardRun()]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ isReviewGateGroup: false, sourceEvents: [] });
		expect(rows[0].representative.jobId).toBe('job-board');
	});

	it('renders a single review-gate job as an ungrouped row carrying its one source event', () => {
		const rows = groupQueuedRuns([reviewGateRun()]);
		expect(rows).toHaveLength(1);
		expect(rows[0].isReviewGateGroup).toBe(false);
		expect(rows[0].sourceEvents).toEqual([
			{
				jobId: 'job-gh',
				sourceEvent: 'pull_request',
				sourceAction: 'opened',
				recheckAttempt: undefined,
			},
		]);
	});

	// Regression (issue #275): a fixed Respond-to-review push produces both
	// SWARM's synthetic `check_suite` follow-up and GitHub's real
	// `pull_request:synchronize` webhook for the same PR/SHA — the exact
	// scenario the grouping must collapse into one logical row.
	it('groups a synthetic check_suite follow-up with a real pull_request:synchronize webhook for the same PR/SHA', () => {
		const followUp = reviewGateRun({
			jobId: 'job-followup',
			reviewGate: { sourceEvent: 'check_suite', sourceAction: 'completed', headSha: 'sha-fix' },
		});
		const synchronize = reviewGateRun({
			jobId: 'job-synchronize',
			reviewGate: { sourceEvent: 'pull_request', sourceAction: 'synchronize', headSha: 'sha-fix' },
		});

		const rows = groupQueuedRuns([followUp, synchronize]);

		expect(rows).toHaveLength(1);
		expect(rows[0].isReviewGateGroup).toBe(true);
		expect(rows[0].representative.jobId).toBe('job-followup');
		expect(rows[0].sourceEvents).toEqual([
			{
				jobId: 'job-followup',
				sourceEvent: 'check_suite',
				sourceAction: 'completed',
				recheckAttempt: undefined,
			},
			{
				jobId: 'job-synchronize',
				sourceEvent: 'pull_request',
				sourceAction: 'synchronize',
				recheckAttempt: undefined,
			},
		]);
	});

	it('preserves the position of the first job in a group within the overall row order', () => {
		const before = boardRun({ jobId: 'job-before', workItemNodeId: 'PVTI_card_before' });
		const followUp = reviewGateRun({
			jobId: 'job-followup',
			reviewGate: { sourceEvent: 'check_suite', headSha: 'sha-fix' },
		});
		const after = boardRun({ jobId: 'job-after', workItemNodeId: 'PVTI_card_after' });
		const synchronize = reviewGateRun({
			jobId: 'job-synchronize',
			reviewGate: { sourceEvent: 'pull_request', sourceAction: 'synchronize', headSha: 'sha-fix' },
		});

		const rows = groupQueuedRuns([before, followUp, after, synchronize]);

		expect(rows.map((r) => r.representative.jobId)).toEqual([
			'job-before',
			'job-followup',
			'job-after',
		]);
		expect(rows[1].isReviewGateGroup).toBe(true);
		expect(rows[1].sourceEvents.map((e) => e.jobId)).toEqual(['job-followup', 'job-synchronize']);
	});

	it('never groups across a different PR number', () => {
		const first = reviewGateRun({
			jobId: 'job-pr-42',
			prNumber: '42',
			reviewGate: { sourceEvent: 'check_suite', headSha: 'sha-fix' },
		});
		const second = reviewGateRun({
			jobId: 'job-pr-43',
			prNumber: '43',
			reviewGate: { sourceEvent: 'pull_request', headSha: 'sha-fix' },
		});

		const rows = groupQueuedRuns([first, second]);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => !r.isReviewGateGroup)).toBe(true);
	});

	it('never groups across a different head SHA', () => {
		const first = reviewGateRun({
			jobId: 'job-sha-1',
			reviewGate: { sourceEvent: 'check_suite', headSha: 'sha-1' },
		});
		const second = reviewGateRun({
			jobId: 'job-sha-2',
			reviewGate: { sourceEvent: 'pull_request', headSha: 'sha-2' },
		});

		const rows = groupQueuedRuns([first, second]);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => !r.isReviewGateGroup)).toBe(true);
	});

	it('never groups across a different project', () => {
		const first = reviewGateRun({
			jobId: 'job-proj-a',
			projectId: 'proj-a',
			reviewGate: { sourceEvent: 'check_suite', headSha: 'sha-fix' },
		});
		const second = reviewGateRun({
			jobId: 'job-proj-b',
			projectId: 'proj-b',
			reviewGate: { sourceEvent: 'pull_request', headSha: 'sha-fix' },
		});

		const rows = groupQueuedRuns([first, second]);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => !r.isReviewGateGroup)).toBe(true);
	});

	it('does not group a review-gate job missing a PR number', () => {
		const noPr = reviewGateRun({ jobId: 'job-no-pr', prNumber: undefined });
		const withPr = reviewGateRun({ jobId: 'job-with-pr' });

		const rows = groupQueuedRuns([noPr, withPr]);
		expect(rows).toHaveLength(2);
	});

	it('leaves unrelated phase hints (e.g. respond-to-review, resolve-conflicts) ungrouped', () => {
		const respondToReview = githubRun({ jobId: 'job-rtr', phaseHint: 'respond-to-review' });
		const resolveConflicts = githubRun({ jobId: 'job-rc', phaseHint: 'resolve-conflicts' });

		const rows = groupQueuedRuns([respondToReview, resolveConflicts]);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => !r.isReviewGateGroup && r.sourceEvents.length === 0)).toBe(true);
	});

	it('reports boardDuplicateCount 0 for a lone board dispatch', () => {
		const rows = groupQueuedRuns([boardRun({ jobId: 'solo', workItemNodeId: 'PVTI_solo' })]);
		expect(rows).toHaveLength(1);
		expect(rows[0].boardDuplicateCount).toBe(0);
	});

	// Regression (issue #374): one board-card drag fires `reordered` + `edited`
	// webhooks (and Planning self-enqueues Implementation), each a separate
	// dispatch for the same card — the queue must show one row, not two/three.
	it('folds fresh board dispatches for the same card into one row', () => {
		const reordered = boardRun({ jobId: 'job-reordered', workItemNodeId: 'PVTI_card_x' });
		const edited = boardRun({ jobId: 'job-edited', workItemNodeId: 'PVTI_card_x' });

		const rows = groupQueuedRuns([reordered, edited]);
		expect(rows).toHaveLength(1);
		expect(rows[0].representative.jobId).toBe('job-reordered');
		expect(rows[0].boardDuplicateCount).toBe(1);
		expect(rows[0].isReviewGateGroup).toBe(false);
	});

	it('never folds board dispatches for different cards', () => {
		const cardA = boardRun({ jobId: 'job-a', workItemNodeId: 'PVTI_card_a' });
		const cardB = boardRun({ jobId: 'job-b', workItemNodeId: 'PVTI_card_b' });

		const rows = groupQueuedRuns([cardA, cardB]);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.boardDuplicateCount === 0)).toBe(true);
	});

	it('never folds board dispatches across different projects', () => {
		const projA = boardRun({ jobId: 'job-pa', projectId: 'proj-a', workItemNodeId: 'PVTI_same' });
		const projB = boardRun({ jobId: 'job-pb', projectId: 'proj-b', workItemNodeId: 'PVTI_same' });

		const rows = groupQueuedRuns([projA, projB]);
		expect(rows).toHaveLength(2);
	});

	// A dispatch that already owns a run (a capacity-blocked continuation or a
	// deferred/resuming run) is a distinct unit of work, not a display duplicate.
	it('never folds a board dispatch that owns a runId', () => {
		const fresh = boardRun({ jobId: 'job-fresh', workItemNodeId: 'PVTI_card_y' });
		const deferred = boardRun({
			jobId: 'job-deferred',
			workItemNodeId: 'PVTI_card_y',
			runId: 'run-123',
		});

		const rows = groupQueuedRuns([fresh, deferred]);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.boardDuplicateCount === 0)).toBe(true);
	});

	// Once the worker resolves the authoritative phase (Planning vs Implementation)
	// the row is no longer an ambiguous "board" duplicate — keep it on its own row.
	it('never folds a board dispatch whose phase already resolved', () => {
		const board = boardRun({ jobId: 'job-board-hint', workItemNodeId: 'PVTI_card_z' });
		const planning = boardRun({
			jobId: 'job-planning',
			workItemNodeId: 'PVTI_card_z',
			phaseHint: 'planning',
		});

		const rows = groupQueuedRuns([board, planning]);
		expect(rows).toHaveLength(2);
	});

	it('keeps the earliest folded board dispatch as the representative and preserves order', () => {
		const other = boardRun({ jobId: 'job-other', workItemNodeId: 'PVTI_other' });
		const first = boardRun({ jobId: 'job-first', workItemNodeId: 'PVTI_dup' });
		const second = boardRun({ jobId: 'job-second', workItemNodeId: 'PVTI_dup' });

		const rows = groupQueuedRuns([first, other, second]);
		expect(rows.map((r) => r.representative.jobId)).toEqual(['job-first', 'job-other']);
		expect(rows[0].boardDuplicateCount).toBe(1);
	});
});

describe('hideBoardRowsWithActiveRun', () => {
	const activeUrl = 'https://github.com/acme/widgets/issues/42';

	it('hides a fresh board row whose work-item URL has an in-progress run', () => {
		const rows = groupQueuedRuns([boardRun()]);
		expect(hideBoardRowsWithActiveRun(rows, new Set([activeUrl]))).toEqual([]);
	});

	it('keeps a fresh board row whose work-item URL is not in the active set', () => {
		const rows = groupQueuedRuns([boardRun()]);
		const result = hideBoardRowsWithActiveRun(
			rows,
			new Set(['https://github.com/acme/widgets/issues/99']),
		);
		expect(result).toHaveLength(1);
		expect(result[0].representative.jobId).toBe('job-board');
	});

	it('keeps a board row that owns a runId even when its URL is active', () => {
		const rows = groupQueuedRuns([boardRun({ jobId: 'job-deferred', runId: 'run-1' })]);
		const result = hideBoardRowsWithActiveRun(rows, new Set([activeUrl]));
		expect(result).toHaveLength(1);
		expect(result[0].representative.jobId).toBe('job-deferred');
	});

	it('keeps an unresolved board row (no work-item URL to match on)', () => {
		const rows = groupQueuedRuns([boardRun({ workItemUrl: undefined })]);
		// A non-empty set that (by construction) cannot contain an undefined URL.
		const result = hideBoardRowsWithActiveRun(rows, new Set([activeUrl]));
		expect(result).toHaveLength(1);
	});

	it('keeps a non-board (github) row even against a non-empty active set', () => {
		const rows = groupQueuedRuns([githubRun({ workItemUrl: activeUrl })]);
		const result = hideBoardRowsWithActiveRun(rows, new Set([activeUrl]));
		expect(result).toHaveLength(1);
	});

	it('returns rows unchanged when the active set is empty', () => {
		const rows = groupQueuedRuns([boardRun()]);
		const result = hideBoardRowsWithActiveRun(rows, new Set());
		expect(result).toBe(rows);
	});

	it('hides a folded board group as a single unit when the representative URL is active', () => {
		const reordered = boardRun({ jobId: 'job-reordered', workItemNodeId: 'PVTI_card_x' });
		const edited = boardRun({ jobId: 'job-edited', workItemNodeId: 'PVTI_card_x' });
		const rows = groupQueuedRuns([reordered, edited]);
		expect(rows).toHaveLength(1);
		expect(rows[0].boardDuplicateCount).toBe(1);
		expect(hideBoardRowsWithActiveRun(rows, new Set([activeUrl]))).toEqual([]);
	});
});

describe('reviewGateSourceEventLabel', () => {
	it('labels a pull_request source event with its action', () => {
		expect(
			reviewGateSourceEventLabel({
				jobId: 'j1',
				sourceEvent: 'pull_request',
				sourceAction: 'synchronize',
			}),
		).toBe('Pull request · synchronize');
	});

	it('labels a check_suite source event and includes its recheck attempt', () => {
		expect(
			reviewGateSourceEventLabel({
				jobId: 'j1',
				sourceEvent: 'check_suite',
				sourceAction: 'completed',
				recheckAttempt: 3,
			}),
		).toBe('Check suite · completed · recheck #3');
	});

	it('omits the action/recheck segments when absent', () => {
		expect(reviewGateSourceEventLabel({ jobId: 'j1', sourceEvent: 'pull_request' })).toBe(
			'Pull request',
		);
	});
});
