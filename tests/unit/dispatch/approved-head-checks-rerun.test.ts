import { beforeEach, describe, expect, it, vi } from 'vitest';

// The review-verdict ledger's two once-only stamps and the slot read (issue
// #1128). Mocked: the conditional updates themselves are the ledger's own
// integration suite; this one asserts the policy built on their answers.
const claimApprovedHeadChecksRerun = vi.fn(async (_key: unknown) => true);
const getApprovedHeadSlot = vi.fn(
	async (_key: unknown): Promise<{ checksRerunAt: Date | null } | undefined> => undefined,
);
const claimApprovedHeadOperatorNotice = vi.fn(async (_key: unknown) => true);
vi.mock('@/db/repositories/reviewVerdictsRepository.js', () => ({
	claimApprovedHeadChecksRerun: (key: unknown) => claimApprovedHeadChecksRerun(key),
	getApprovedHeadSlot: (key: unknown) => getApprovedHeadSlot(key),
	claimApprovedHeadOperatorNotice: (key: unknown) => claimApprovedHeadOperatorNotice(key),
}));

const createFailedRun = vi.fn(async (_input: unknown) => 'run-notice');
vi.mock('@/db/repositories/runsRepository.js', () => ({
	createFailedRun: (input: unknown) => createFailedRun(input),
}));

const releaseReviewDispatch = vi.fn(async (_key: string) => {});
vi.mock('@/triggers/review-dispatch-dedup.js', () => ({
	buildReviewDispatchKey: (repo: string, prNumber: string, headSha: string) =>
		`${repo}:${prNumber}:${headSha}`,
	releaseReviewDispatch: (key: string) => releaseReviewDispatch(key),
}));

vi.mock('@/lib/logger.js', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { ProjectConfig } from '@/config/schema.js';
import {
	RERUN_SETTLE_MS,
	RERUN_SETTLE_RECHECK_DELAY_MS,
	type RecoverAdjudicatedApprovedHeadInput,
	recoverAdjudicatedApprovedHead,
} from '@/dispatch/approved-head-checks-rerun.js';
import { deliveryIdentity, type ScmDeliveryProvider } from '@/scm/delivery.js';
import type { RerunFailedChecksOutcome } from '@/scm/types.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const PROJECT = createMockProjectConfig({ autoMerge: true });
const KEY = {
	projectId: PROJECT.id,
	repository: PROJECT.repo,
	prNumber: '42',
	headSha: 'abc123',
};

const rerunFailedChecks = vi.fn(
	async (
		_p: ProjectConfig,
		_ref: string,
		_persona?: string,
	): Promise<RerunFailedChecksOutcome> => ({
		status: 'requested',
		checks: ['ci'],
	}),
);
const postComment = vi.fn(async (_input: unknown) => 1);
const deliveryProvider = vi.fn(
	async (_p: ProjectConfig, _persona: string) =>
		({ postComment }) as unknown as ScmDeliveryProvider,
);

function input(
	overrides: Partial<RecoverAdjudicatedApprovedHeadInput> = {},
): RecoverAdjudicatedApprovedHeadInput {
	return {
		project: PROJECT,
		scm: { rerunFailedChecks, deliveryProvider } as RecoverAdjudicatedApprovedHeadInput['scm'],
		prNumber: '42',
		headSha: 'abc123',
		failedChecks: ['ci'],
		...overrides,
	};
}

beforeEach(() => {
	claimApprovedHeadChecksRerun.mockReset();
	claimApprovedHeadChecksRerun.mockResolvedValue(true);
	getApprovedHeadSlot.mockReset();
	getApprovedHeadSlot.mockResolvedValue(undefined);
	claimApprovedHeadOperatorNotice.mockReset();
	claimApprovedHeadOperatorNotice.mockResolvedValue(true);
	createFailedRun.mockClear();
	releaseReviewDispatch.mockClear();
	rerunFailedChecks.mockClear();
	postComment.mockClear();
	deliveryProvider.mockClear();
});

describe('recoverAdjudicatedApprovedHead', () => {
	it('does not apply when merge automation is off for the repository', async () => {
		expect(
			await recoverAdjudicatedApprovedHead(input({ project: createMockProjectConfig() })),
		).toBe('not-applicable');
		expect(claimApprovedHeadChecksRerun).not.toHaveBeenCalled();
		expect(rerunFailedChecks).not.toHaveBeenCalled();
	});

	it('does not apply to a head with no submitted approval', async () => {
		claimApprovedHeadChecksRerun.mockResolvedValue(false);
		getApprovedHeadSlot.mockResolvedValue(undefined);
		expect(await recoverAdjudicatedApprovedHead(input())).toBe('not-applicable');
		expect(rerunFailedChecks).not.toHaveBeenCalled();
		expect(createFailedRun).not.toHaveBeenCalled();
	});

	it('spends the one re-run as the implementer and releases the PR+SHA claim', async () => {
		expect(await recoverAdjudicatedApprovedHead(input())).toBe('rerun-requested');
		expect(claimApprovedHeadChecksRerun).toHaveBeenCalledWith(KEY);
		expect(rerunFailedChecks).toHaveBeenCalledWith(PROJECT, 'abc123', 'implementer');
		// So the re-run's own `checks completed` is decided, not dropped as a duplicate.
		expect(releaseReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:42:abc123`);
		expect(createFailedRun).not.toHaveBeenCalled();
		expect(postComment).not.toHaveBeenCalled();
	});

	it.each([
		['unsupported', { status: 'unsupported', message: 'no re-run API' }, 'no re-run API'],
		['provider-error', { status: 'provider-error', message: 'HTTP 502' }, 'HTTP 502'],
		['nothing-to-rerun', { status: 'nothing-to-rerun' }, 'no failed check it could re-run'],
	] as const)('hands the head to the operator when the provider answers %s', async (_name, outcome, quoted) => {
		rerunFailedChecks.mockResolvedValueOnce(outcome as RerunFailedChecksOutcome);
		expect(await recoverAdjudicatedApprovedHead(input())).toBe('needs-operator');
		expect(releaseReviewDispatch).not.toHaveBeenCalled();
		expect(createFailedRun).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT.id,
				repository: PROJECT.repo,
				taskId: '42-ci',
				phase: 'respond-to-ci',
				prNumber: '42',
				error: expect.stringContaining('SWARM could not re-run the failing checks'),
			}),
		);
		expect((createFailedRun.mock.calls[0][0] as { error: string }).error).toContain(quoted);
		expect(postComment).toHaveBeenCalledWith(
			expect.objectContaining({
				prNumber: 42,
				deliveryId: deliveryIdentity([
					'approved-head-needs-operator',
					PROJECT.repo,
					'42',
					'abc123',
				]),
			}),
		);
	});

	it('lets a re-run requested moments ago settle rather than reading it as failed', async () => {
		claimApprovedHeadChecksRerun.mockResolvedValue(false);
		getApprovedHeadSlot.mockResolvedValue({ checksRerunAt: new Date(Date.now() - 10_000) });
		expect(await recoverAdjudicatedApprovedHead(input())).toBe('rerun-settling');
		expect(rerunFailedChecks).not.toHaveBeenCalled();
		expect(claimApprovedHeadOperatorNotice).not.toHaveBeenCalled();
	});

	// The `pr-review` trigger's settle recheck waits this long, so even a read the
	// instant the re-run was stamped is decided — never `rerun-settling` — next time.
	it('decides the re-read a settle recheck makes, however early it was scheduled', async () => {
		claimApprovedHeadChecksRerun.mockResolvedValue(false);
		getApprovedHeadSlot.mockResolvedValue({
			checksRerunAt: new Date(Date.now() - RERUN_SETTLE_RECHECK_DELAY_MS),
		});
		expect(RERUN_SETTLE_RECHECK_DELAY_MS).toBeGreaterThan(RERUN_SETTLE_MS);
		expect(await recoverAdjudicatedApprovedHead(input())).toBe('needs-operator');
	});

	it('hands the head to the operator once its one re-run failed again', async () => {
		claimApprovedHeadChecksRerun.mockResolvedValue(false);
		getApprovedHeadSlot.mockResolvedValue({
			checksRerunAt: new Date(Date.now() - RERUN_SETTLE_MS - 1_000),
		});
		expect(
			await recoverAdjudicatedApprovedHead(
				input({ failedChecks: ['lint', 'test'], jobPayload: { type: 'scm' } as never }),
			),
		).toBe('needs-operator');
		// Never a second re-run.
		expect(rerunFailedChecks).not.toHaveBeenCalled();
		const run = createFailedRun.mock.calls[0][0] as { error: string; jobPayload?: unknown };
		expect(run.error).toContain('PR #42 at abc123');
		expect(run.error).toContain('lint, test');
		expect(run.error).toContain("SWARM's CI agent judged the failure unrelated");
		expect(run.error).toContain('failed again');
		expect(run.jobPayload).toEqual({ type: 'scm' });
		expect(deliveryProvider).toHaveBeenCalledWith(PROJECT, 'implementer');
		const comment = postComment.mock.calls[0][0] as { body: string };
		expect(comment.body).toContain('`lint`, `test`');
	});

	it('writes the operator notice once only', async () => {
		claimApprovedHeadChecksRerun.mockResolvedValue(false);
		getApprovedHeadSlot.mockResolvedValue({ checksRerunAt: new Date(0) });
		claimApprovedHeadOperatorNotice.mockResolvedValueOnce(true).mockResolvedValue(false);
		expect(await recoverAdjudicatedApprovedHead(input())).toBe('needs-operator');
		expect(await recoverAdjudicatedApprovedHead(input())).toBe('needs-operator');
		expect(claimApprovedHeadOperatorNotice).toHaveBeenCalledTimes(2);
		expect(createFailedRun).toHaveBeenCalledTimes(1);
		expect(postComment).toHaveBeenCalledTimes(1);
	});

	it('never throws: a ledger error leaves the head to its caller', async () => {
		claimApprovedHeadChecksRerun.mockRejectedValue(new Error('db down'));
		expect(await recoverAdjudicatedApprovedHead(input())).toBe('not-applicable');
		expect(rerunFailedChecks).not.toHaveBeenCalled();
	});

	it('keeps the notice best-effort when neither the run nor the comment can be written', async () => {
		rerunFailedChecks.mockResolvedValueOnce({ status: 'unsupported', message: 'nope' });
		createFailedRun.mockRejectedValueOnce(new Error('db down'));
		postComment.mockRejectedValueOnce(new Error('HTTP 502'));
		expect(await recoverAdjudicatedApprovedHead(input())).toBe('needs-operator');
	});
});
