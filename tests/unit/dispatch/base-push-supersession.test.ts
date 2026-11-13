import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supersedeApprovalsParkedAtHead } from '@/dispatch/base-push-supersession.js';
import { MERGE_REARM_OUTCOMES } from '@/worker/merge-rearm-outcomes.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

// The two ledgers the stamp writes, mocked at their repository boundary: this suite
// asserts which approvals are stamped, with which keys and in which order — whether
// the rows match is the runs repository's integration suite.
const listParkedApprovalsAtMergeHead = vi.fn();
const markReviewRunSuperseded = vi.fn();
vi.mock('@/db/repositories/runsRepository.js', () => ({
	listParkedApprovalsAtMergeHead: (key: unknown, outcomes: unknown) =>
		listParkedApprovalsAtMergeHead(key, outcomes),
	markReviewRunSuperseded: (runId: string) => markReviewRunSuperseded(runId),
}));
const markReviewVerdictSuperseded = vi.fn();
vi.mock('@/db/repositories/reviewVerdictsRepository.js', () => ({
	markReviewVerdictSuperseded: (key: unknown) => markReviewVerdictSuperseded(key),
}));

const PROJECT = createMockProjectConfig();
const INPUT = {
	project: PROJECT,
	prNumber: '17',
	fromHeadSha: 'head-b',
	cause: 'resolve-conflicts' as const,
};

beforeEach(() => {
	listParkedApprovalsAtMergeHead.mockReset();
	listParkedApprovalsAtMergeHead.mockResolvedValue([]);
	markReviewRunSuperseded.mockReset();
	markReviewRunSuperseded.mockResolvedValue(true);
	markReviewVerdictSuperseded.mockReset();
	markReviewVerdictSuperseded.mockResolvedValue(true);
});

describe('supersedeApprovalsParkedAtHead (issue #1445)', () => {
	it('asks for the approvals parked at the head with the re-armable outcomes', async () => {
		await supersedeApprovalsParkedAtHead(INPUT);

		expect(listParkedApprovalsAtMergeHead).toHaveBeenCalledExactlyOnceWith(
			{ projectId: PROJECT.id, repository: PROJECT.repo, prNumber: '17', headSha: 'head-b' },
			MERGE_REARM_OUTCOMES,
		);
	});

	// `#2254`'s shape: an approval whose merge advanced onto `head-b`, and the
	// no-fix hand-back's Review of `head-b` itself — both parked there.
	it('stamps each approval’s ledger slot at its reviewed head, then its run', async () => {
		listParkedApprovalsAtMergeHead.mockResolvedValue([
			{ id: 'run-x', reviewedHeadSha: 'head-x' },
			{ id: 'run-b', reviewedHeadSha: 'head-b' },
		]);

		expect(await supersedeApprovalsParkedAtHead(INPUT)).toBe(2);

		expect(markReviewVerdictSuperseded.mock.calls).toEqual([
			[{ projectId: PROJECT.id, repository: PROJECT.repo, prNumber: '17', headSha: 'head-x' }],
			[{ projectId: PROJECT.id, repository: PROJECT.repo, prNumber: '17', headSha: 'head-b' }],
		]);
		expect(markReviewRunSuperseded.mock.calls).toEqual([['run-x'], ['run-b']]);
		expect(markReviewVerdictSuperseded.mock.invocationCallOrder[0]).toBeLessThan(
			markReviewRunSuperseded.mock.invocationCallOrder[0],
		);
	});

	// A retry after a crash between the two writes finds the ledger already stamped.
	it('still reaches the run row when the ledger slot was already stamped', async () => {
		listParkedApprovalsAtMergeHead.mockResolvedValue([{ id: 'run-x', reviewedHeadSha: 'head-x' }]);
		markReviewVerdictSuperseded.mockResolvedValue(false);

		expect(await supersedeApprovalsParkedAtHead(INPUT)).toBe(1);
		expect(markReviewRunSuperseded).toHaveBeenCalledExactlyOnceWith('run-x');
	});

	it('writes nothing when no approval is parked at the head', async () => {
		expect(await supersedeApprovalsParkedAtHead(INPUT)).toBe(0);

		expect(markReviewVerdictSuperseded).not.toHaveBeenCalled();
		expect(markReviewRunSuperseded).not.toHaveBeenCalled();
	});

	it('logs a repository failure rather than throwing it', async () => {
		listParkedApprovalsAtMergeHead.mockResolvedValue([{ id: 'run-x', reviewedHeadSha: 'head-x' }]);
		markReviewVerdictSuperseded.mockRejectedValue(new Error('db down'));

		await expect(supersedeApprovalsParkedAtHead(INPUT)).resolves.toBe(0);
		expect(markReviewRunSuperseded).not.toHaveBeenCalled();
	});
});
