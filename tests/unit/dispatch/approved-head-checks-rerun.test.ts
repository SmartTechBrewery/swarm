import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovedHeadSlot } from '@/db/repositories/reviewVerdictsRepository.js';

// The review-verdict ledger's counted re-run claim, once-only notice stamp and the
// slot read (issues #1128, #1463). Mocked: the conditional updates themselves are
// the ledger's own integration suite; this one asserts the policy built on their
// answers.
const claimApprovedHeadChecksRerun = vi.fn(
	async (_key: unknown, _expected: number, _max: number) => true,
);
const getApprovedHeadSlot = vi.fn(
	async (_key: unknown): Promise<ApprovedHeadSlot | undefined> => undefined,
);
const claimApprovedHeadOperatorNotice = vi.fn(async (_key: unknown) => true);
// The verdict's recorded failure and the once-only re-route (issue #1474).
const recordApprovedHeadAdjudicatedFailure = vi.fn(
	async (_key: unknown, _signature: unknown) => true,
);
const claimApprovedHeadFailureChangeRoute = vi.fn(async (_key: unknown) => true);
vi.mock('@/db/repositories/reviewVerdictsRepository.js', () => ({
	claimApprovedHeadChecksRerun: (key: unknown, expected: number, max: number) =>
		claimApprovedHeadChecksRerun(key, expected, max),
	getApprovedHeadSlot: (key: unknown) => getApprovedHeadSlot(key),
	claimApprovedHeadOperatorNotice: (key: unknown) => claimApprovedHeadOperatorNotice(key),
	recordApprovedHeadAdjudicatedFailure: (key: unknown, signature: unknown) =>
		recordApprovedHeadAdjudicatedFailure(key, signature),
	claimApprovedHeadFailureChangeRoute: (key: unknown) => claimApprovedHeadFailureChangeRoute(key),
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

// The re-run is a write made for the pull request's author (issue #1249): it runs as
// the operator whose worker produced it. Resolving that reads the run and worker
// tables, so it is mocked; by default an operator resolves and the write runs.
const runAsPullRequestOperator = vi.fn(
	async (
		_project: unknown,
		_prNumber: string,
		fn: (operator: { workerId: string; workerName: string }) => Promise<unknown>,
	) => fn({ workerId: 'worker-1', workerName: 'alice-laptop' }),
);
vi.mock('@/identity/pull-request-operator.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/identity/pull-request-operator.js')>()),
	runAsPullRequestOperator: (project: unknown, prNumber: string, fn: never) =>
		runAsPullRequestOperator(project, prNumber, fn),
}));

// The shared-check-failure detection (issue #1464) — its own suite covers it; here
// it answers which failing checks a standing episode covers. By default none: a
// pull request failing on its own keeps the per-head policy.
const noteAdjudicatedCheckFailures = vi.fn(async (_input: unknown) => new Set<string>());
vi.mock('@/dispatch/shared-check-failure.js', () => ({
	noteAdjudicatedCheckFailures: (input: unknown) => noteAdjudicatedCheckFailures(input),
}));

vi.mock('@/lib/logger.js', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { ProjectConfig } from '@/config/schema.js';
import {
	APPROVED_HEAD_RERUN_GAPS_MS,
	approvedHeadRerunInFlight,
	describeVerdictAgainstLatest,
	failureMateriallyChanged,
	failureSignatureOf,
	MAX_APPROVED_HEAD_RERUNS,
	nextApprovedHeadRerunDueAt,
	RERUN_DUE_RECHECK_MARGIN_MS,
	RERUN_SETTLE_MS,
	RERUN_SETTLE_RECHECK_DELAY_MS,
	type RecoverAdjudicatedApprovedHeadInput,
	recoverAdjudicatedApprovedHead,
	summarizeAttemptRunners,
} from '@/dispatch/approved-head-checks-rerun.js';
import { PullRequestOperatorUnavailableError } from '@/identity/pull-request-operator.js';
import { deliveryIdentity, type ScmDeliveryProvider } from '@/scm/delivery.js';
import type { CheckAttemptRunner, RerunFailedChecksOutcome } from '@/scm/types.js';
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
// Where each failed attempt ran (issue #1468). By default the provider reports none.
const describeFailedCheckAttempts = vi.fn(
	async (_p: ProjectConfig, _ref: string, _persona?: string): Promise<CheckAttemptRunner[]> => [],
);
const getPullRequest = vi.fn();
const postComment = vi.fn(async (_input: unknown) => 1);
const deliveryProvider = vi.fn(
	async (_p: ProjectConfig, _persona: string) =>
		({ postComment }) as unknown as ScmDeliveryProvider,
);

const NOW = new Date('2026-11-15T12:00:00.000Z');
const MINUTE = 60 * 1000;

/** An approved head's slot with `attempts` re-runs spent, the latest `agoMs` before {@link NOW}. */
function slot(
	attempts: number,
	agoMs?: number,
	operatorNotifiedAt: Date | null = null,
	extra: Partial<Pick<ApprovedHeadSlot, 'adjudicatedFailure' | 'failureChangeRoutedAt'>> = {},
): ApprovedHeadSlot {
	return {
		checksRerunAttempts: attempts,
		checksRerunAt: agoMs === undefined ? null : new Date(NOW.getTime() - agoMs),
		operatorNotifiedAt,
		adjudicatedFailure: null,
		failureChangeRoutedAt: null,
		...extra,
	};
}

function input(
	overrides: Partial<RecoverAdjudicatedApprovedHeadInput> = {},
): RecoverAdjudicatedApprovedHeadInput {
	return {
		project: PROJECT,
		scm: {
			rerunFailedChecks,
			deliveryProvider,
			describeFailedCheckAttempts,
			getPullRequest,
		} as unknown as RecoverAdjudicatedApprovedHeadInput['scm'],
		prNumber: '42',
		headSha: 'abc123',
		failedChecks: ['ci'],
		...overrides,
	};
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	claimApprovedHeadChecksRerun.mockReset();
	claimApprovedHeadChecksRerun.mockResolvedValue(true);
	getApprovedHeadSlot.mockReset();
	getApprovedHeadSlot.mockResolvedValue(slot(0));
	claimApprovedHeadOperatorNotice.mockReset();
	claimApprovedHeadOperatorNotice.mockResolvedValue(true);
	recordApprovedHeadAdjudicatedFailure.mockReset();
	recordApprovedHeadAdjudicatedFailure.mockResolvedValue(true);
	claimApprovedHeadFailureChangeRoute.mockReset();
	claimApprovedHeadFailureChangeRoute.mockResolvedValue(true);
	createFailedRun.mockClear();
	releaseReviewDispatch.mockClear();
	rerunFailedChecks.mockClear();
	describeFailedCheckAttempts.mockReset();
	describeFailedCheckAttempts.mockResolvedValue([]);
	postComment.mockClear();
	deliveryProvider.mockClear();
	runAsPullRequestOperator.mockClear();
	noteAdjudicatedCheckFailures.mockReset();
	noteAdjudicatedCheckFailures.mockResolvedValue(new Set());
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the re-run schedule', () => {
	it('re-runs up to three times, the requests landing at about 0, +15 and +45 minutes', () => {
		expect(MAX_APPROVED_HEAD_RERUNS).toBe(3);
		expect(APPROVED_HEAD_RERUN_GAPS_MS).toHaveLength(MAX_APPROVED_HEAD_RERUNS);
		expect(APPROVED_HEAD_RERUN_GAPS_MS).toEqual([0, 15 * MINUTE, 30 * MINUTE]);
	});

	it.each([
		['unspent: due at once', slot(0), new Date(0)],
		['one spent: due 15 min after it', slot(1, 0), new Date(NOW.getTime() + 15 * MINUTE)],
		['two spent: due 30 min after the second', slot(2, 0), new Date(NOW.getTime() + 30 * MINUTE)],
		['all spent: none due', slot(3, 0), null],
		['a spent attempt with no stamp: due at once', slot(1), new Date(0)],
	])('nextApprovedHeadRerunDueAt — %s', (_name, given, expected) => {
		expect(nextApprovedHeadRerunDueAt(given)).toEqual(expected);
	});

	it.each([
		['nothing spent', slot(0), false],
		['inside the settle window', slot(1, RERUN_SETTLE_MS - 1_000), true],
		['the last re-run, still settling', slot(3, RERUN_SETTLE_MS - 1_000), true],
		['waiting for the next re-run', slot(1, 5 * MINUTE), true],
		[
			'past due, within the recheck grace',
			slot(1, 15 * MINUTE + RERUN_SETTLE_RECHECK_DELAY_MS - 1_000),
			true,
		],
		['past due and past the grace', slot(1, 15 * MINUTE + RERUN_SETTLE_RECHECK_DELAY_MS), false],
		['every re-run spent and settled', slot(3, RERUN_SETTLE_MS + 1_000), false],
		['already handed to the operator', slot(1, 5 * MINUTE, new Date(NOW)), false],
	])('approvedHeadRerunInFlight — %s', (_name, given, expected) => {
		expect(approvedHeadRerunInFlight(given, NOW)).toBe(expected);
	});
});

describe('recoverAdjudicatedApprovedHead', () => {
	it('does not apply when merge automation is off for the repository', async () => {
		expect(
			await recoverAdjudicatedApprovedHead(input({ project: createMockProjectConfig() })),
		).toEqual({ outcome: 'not-applicable' });
		expect(getApprovedHeadSlot).not.toHaveBeenCalled();
		expect(claimApprovedHeadChecksRerun).not.toHaveBeenCalled();
		expect(rerunFailedChecks).not.toHaveBeenCalled();
	});

	it('does not apply to a head with no submitted approval', async () => {
		getApprovedHeadSlot.mockResolvedValue(undefined);
		expect(await recoverAdjudicatedApprovedHead(input())).toEqual({ outcome: 'not-applicable' });
		expect(claimApprovedHeadChecksRerun).not.toHaveBeenCalled();
		expect(rerunFailedChecks).not.toHaveBeenCalled();
		expect(createFailedRun).not.toHaveBeenCalled();
	});

	describe('a check failing on several pull requests (issue #1464)', () => {
		it('stands down when every failing check is shared: no re-run, claim, notice or comment', async () => {
			noteAdjudicatedCheckFailures.mockResolvedValue(new Set(['lint', 'test']));
			for (const given of [slot(0), slot(1, 20 * MINUTE), slot(3, 60 * MINUTE)]) {
				getApprovedHeadSlot.mockResolvedValue(given);
				expect(
					await recoverAdjudicatedApprovedHead(input({ failedChecks: ['lint', 'test'] })),
				).toEqual({ outcome: 'shared-failure' });
			}
			expect(noteAdjudicatedCheckFailures).toHaveBeenCalledWith(
				expect.objectContaining({
					prNumber: '42',
					headSha: 'abc123',
					failedChecks: ['lint', 'test'],
				}),
			);
			expect(claimApprovedHeadChecksRerun).not.toHaveBeenCalled();
			expect(rerunFailedChecks).not.toHaveBeenCalled();
			expect(claimApprovedHeadOperatorNotice).not.toHaveBeenCalled();
			expect(createFailedRun).not.toHaveBeenCalled();
			expect(postComment).not.toHaveBeenCalled();
		});

		it('keeps the per-head policy while one failing check is not shared', async () => {
			noteAdjudicatedCheckFailures.mockResolvedValue(new Set(['lint']));
			expect(
				await recoverAdjudicatedApprovedHead(input({ failedChecks: ['lint', 'test'] })),
			).toEqual({ outcome: 'rerun-requested' });
			expect(rerunFailedChecks).toHaveBeenCalledTimes(1);
		});

		it('fails open to the per-head policy when the detection throws', async () => {
			noteAdjudicatedCheckFailures.mockRejectedValue(new Error('db down'));
			expect(await recoverAdjudicatedApprovedHead(input())).toEqual({
				outcome: 'rerun-requested',
			});
		});

		it('is not consulted for a head already handed to the operator', async () => {
			getApprovedHeadSlot.mockResolvedValue(slot(3, 60 * MINUTE, new Date(NOW)));
			expect((await recoverAdjudicatedApprovedHead(input())).outcome).toBe('needs-operator');
			expect(noteAdjudicatedCheckFailures).not.toHaveBeenCalled();
		});
	});

	it('spends the first re-run at once, as the pull request’s operator, and releases the PR+SHA claim', async () => {
		expect(await recoverAdjudicatedApprovedHead(input())).toEqual({
			outcome: 'rerun-requested',
		});
		expect(claimApprovedHeadChecksRerun).toHaveBeenCalledWith(KEY, 0, MAX_APPROVED_HEAD_RERUNS);
		expect(runAsPullRequestOperator.mock.calls[0]?.slice(0, 2)).toEqual([PROJECT, '42']);
		expect(rerunFailedChecks).toHaveBeenCalledWith(PROJECT, 'abc123', 'implementer');
		// So the re-run's own `checks completed` is decided, not dropped as a duplicate.
		expect(releaseReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:42:abc123`);
		expect(createFailedRun).not.toHaveBeenCalled();
		expect(postComment).not.toHaveBeenCalled();
	});

	it('lets a re-run requested moments ago settle rather than reading it as failed', async () => {
		getApprovedHeadSlot.mockResolvedValue(slot(1, 10_000));
		expect(await recoverAdjudicatedApprovedHead(input())).toEqual({
			outcome: 'rerun-settling',
			recheckAfterMs: RERUN_SETTLE_RECHECK_DELAY_MS,
		});
		expect(claimApprovedHeadChecksRerun).not.toHaveBeenCalled();
		expect(rerunFailedChecks).not.toHaveBeenCalled();
		expect(claimApprovedHeadOperatorNotice).not.toHaveBeenCalled();
	});

	it('waits for the next re-run when one failed before its gap has passed', async () => {
		getApprovedHeadSlot.mockResolvedValue(slot(1, 5 * MINUTE));
		expect(await recoverAdjudicatedApprovedHead(input())).toEqual({
			outcome: 'rerun-waiting',
			recheckAfterMs: 10 * MINUTE + RERUN_DUE_RECHECK_MARGIN_MS,
		});
		expect(claimApprovedHeadChecksRerun).not.toHaveBeenCalled();
		expect(rerunFailedChecks).not.toHaveBeenCalled();
		expect(claimApprovedHeadOperatorNotice).not.toHaveBeenCalled();
	});

	it('spaces the re-runs by a growing gap', async () => {
		// Re-run 2 falls due 15 min after re-run 1.
		getApprovedHeadSlot.mockResolvedValue(slot(1, 15 * MINUTE));
		expect(await recoverAdjudicatedApprovedHead(input())).toEqual({
			outcome: 'rerun-requested',
		});
		expect(claimApprovedHeadChecksRerun).toHaveBeenLastCalledWith(KEY, 1, MAX_APPROVED_HEAD_RERUNS);

		// Re-run 3 is still waiting 29 min after re-run 2…
		getApprovedHeadSlot.mockResolvedValue(slot(2, 29 * MINUTE));
		expect((await recoverAdjudicatedApprovedHead(input())).outcome).toBe('rerun-waiting');
		expect(claimApprovedHeadChecksRerun).toHaveBeenCalledTimes(1);

		// …and falls due at 30 min.
		getApprovedHeadSlot.mockResolvedValue(slot(2, 30 * MINUTE));
		expect((await recoverAdjudicatedApprovedHead(input())).outcome).toBe('rerun-requested');
		expect(claimApprovedHeadChecksRerun).toHaveBeenLastCalledWith(KEY, 2, MAX_APPROVED_HEAD_RERUNS);
		expect(rerunFailedChecks).toHaveBeenCalledTimes(2);
		expect(createFailedRun).not.toHaveBeenCalled();
	});

	it('settles, re-running nothing, when a concurrent caller spent the attempt first', async () => {
		getApprovedHeadSlot.mockResolvedValue(slot(1, 20 * MINUTE));
		claimApprovedHeadChecksRerun.mockResolvedValue(false);
		expect(await recoverAdjudicatedApprovedHead(input())).toEqual({
			outcome: 'rerun-settling',
			recheckAfterMs: RERUN_SETTLE_RECHECK_DELAY_MS,
		});
		expect(rerunFailedChecks).not.toHaveBeenCalled();
		expect(claimApprovedHeadOperatorNotice).not.toHaveBeenCalled();
	});

	// The `pr-review` trigger's settle recheck waits this long, so even a read the
	// instant the last re-run was stamped is decided — never `rerun-settling` — next time.
	it('decides the re-read a settle recheck makes, however early it was scheduled', async () => {
		getApprovedHeadSlot.mockResolvedValue(slot(3, RERUN_SETTLE_RECHECK_DELAY_MS));
		expect(RERUN_SETTLE_RECHECK_DELAY_MS).toBeGreaterThan(RERUN_SETTLE_MS);
		expect((await recoverAdjudicatedApprovedHead(input())).outcome).toBe('needs-operator');
	});

	it('hands the head to the operator once its last re-run failed again', async () => {
		getApprovedHeadSlot.mockResolvedValue(slot(3, RERUN_SETTLE_MS + 1_000));
		expect(
			await recoverAdjudicatedApprovedHead(
				input({ failedChecks: ['lint', 'test'], jobPayload: { type: 'scm' } as never }),
			),
		).toEqual({ outcome: 'needs-operator' });
		// Never a fourth re-run.
		expect(claimApprovedHeadChecksRerun).not.toHaveBeenCalled();
		expect(rerunFailedChecks).not.toHaveBeenCalled();
		const run = createFailedRun.mock.calls[0][0] as { error: string; jobPayload?: unknown };
		expect(run.error).toContain('PR #42 at abc123');
		expect(run.error).toContain('lint, test');
		expect(run.error).toContain("SWARM's CI agent judged the failure unrelated");
		expect(run.error).toContain(
			'SWARM re-ran the failing checks 3 times over at least 45 minutes, and they failed every time.',
		);
		expect(run.jobPayload).toEqual({ type: 'scm' });
		// The notice speaks as the reviewer, like every comment the router posts (issue #1249).
		expect(deliveryProvider).toHaveBeenCalledWith(PROJECT, 'reviewer');
		const comment = postComment.mock.calls[0][0] as { body: string };
		expect(comment.body).toContain('`lint`, `test`');
		expect(comment.body).toContain('3 times');
	});

	it('writes the operator notice once only', async () => {
		getApprovedHeadSlot.mockResolvedValue(slot(3, 60 * MINUTE));
		claimApprovedHeadOperatorNotice.mockResolvedValueOnce(true).mockResolvedValue(false);
		expect((await recoverAdjudicatedApprovedHead(input())).outcome).toBe('needs-operator');
		expect((await recoverAdjudicatedApprovedHead(input())).outcome).toBe('needs-operator');
		expect(claimApprovedHeadOperatorNotice).toHaveBeenCalledTimes(2);
		expect(createFailedRun).toHaveBeenCalledTimes(1);
		expect(postComment).toHaveBeenCalledTimes(1);
		// The runner read is made once per head too: not by the caller that lost the claim.
		expect(describeFailedCheckAttempts).toHaveBeenCalledTimes(1);
	});

	it('names the runner each failed attempt ran on in the run and the comment', async () => {
		getApprovedHeadSlot.mockResolvedValue(slot(3, 60 * MINUTE));
		describeFailedCheckAttempts.mockResolvedValue([
			{ check: 'Verify', attempt: 1, runner: 'm5_pro_sm_1' },
			{ check: 'Verify', attempt: 2, runner: 'm5_pro_sm_1' },
			{ check: 'Verify', attempt: 3, runner: 'm5_pro_sm_1' },
		]);
		expect(
			(await recoverAdjudicatedApprovedHead(input({ failedChecks: ['Verify'] }))).outcome,
		).toBe('needs-operator');
		expect(describeFailedCheckAttempts).toHaveBeenCalledWith(PROJECT, 'abc123');
		const summary = 'All 3 attempts ran on one runner, `m5_pro_sm_1`.';
		const run = createFailedRun.mock.calls[0][0] as { error: string };
		expect(run.error).toContain('`Verify` — attempt 1: `m5_pro_sm_1`');
		expect(run.error).toContain(summary);
		const comment = postComment.mock.calls[0][0] as { body: string };
		expect(comment.body).toContain('`Verify` — attempt 3: `m5_pro_sm_1`');
		expect(comment.body).toContain(summary);
	});

	it.each([
		['throws', () => describeFailedCheckAttempts.mockRejectedValueOnce(new Error('HTTP 502'))],
		['reports no attempts', () => describeFailedCheckAttempts.mockResolvedValueOnce([])],
	])('still writes the notice, without runners, when the runner read %s', async (_name, arrange) => {
		getApprovedHeadSlot.mockResolvedValue(slot(3, 60 * MINUTE));
		arrange();
		expect((await recoverAdjudicatedApprovedHead(input())).outcome).toBe('needs-operator');
		const run = createFailedRun.mock.calls[0][0] as { error: string };
		expect(run.error).not.toContain('ran on');
		expect(run.error).toContain('failed every time. Re-run the checks');
		expect(postComment).toHaveBeenCalledOnce();
		expect((postComment.mock.calls[0][0] as { body: string }).body).not.toContain('ran on');
	});

	it('writes nothing on a head already handed to the operator', async () => {
		getApprovedHeadSlot.mockResolvedValue(slot(1, 5 * MINUTE, new Date(NOW)));
		expect(await recoverAdjudicatedApprovedHead(input())).toEqual({ outcome: 'needs-operator' });
		expect(claimApprovedHeadChecksRerun).not.toHaveBeenCalled();
		expect(claimApprovedHeadOperatorNotice).not.toHaveBeenCalled();
		expect(createFailedRun).not.toHaveBeenCalled();
		expect(postComment).not.toHaveBeenCalled();
	});

	it.each([
		['unsupported', { status: 'unsupported', message: 'no re-run API' }, 'no re-run API'],
		['provider-error', { status: 'provider-error', message: 'HTTP 502' }, 'HTTP 502'],
		['nothing-to-rerun', { status: 'nothing-to-rerun' }, 'no failed check it could re-run'],
	] as const)('hands the head to the operator at once when the provider answers %s', async (_name, outcome, quoted) => {
		rerunFailedChecks.mockResolvedValueOnce(outcome as RerunFailedChecksOutcome);
		expect((await recoverAdjudicatedApprovedHead(input())).outcome).toBe('needs-operator');
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
		// The durable marker Resolve problem reads to leave the hand-off alone (issue #1462).
		expect(
			(createFailedRun.mock.calls[0][0] as { failureDiagnosis: { kind: string } }).failureDiagnosis,
		).toMatchObject({
			kind: 'approved-head-needs-operator',
			title: 'Approved head needs the operator',
		});
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

	it('hands the head off at once when a later re-run is refused, naming the ones before it', async () => {
		getApprovedHeadSlot.mockResolvedValue(slot(1, 15 * MINUTE));
		rerunFailedChecks.mockResolvedValueOnce({ status: 'unsupported', message: 'no re-run API' });
		expect((await recoverAdjudicatedApprovedHead(input())).outcome).toBe('needs-operator');
		expect((createFailedRun.mock.calls[0][0] as { error: string }).error).toContain(
			'SWARM re-ran the failing checks once and they failed again, then could not re-run them again',
		);
	});

	it('hands the head to the operator, re-running nothing, when there is no operator to act as', async () => {
		const reason =
			"no operator source-control credential is stored for worker 'alice-laptop' on github";
		runAsPullRequestOperator.mockRejectedValueOnce(new PullRequestOperatorUnavailableError(reason));

		expect((await recoverAdjudicatedApprovedHead(input())).outcome).toBe('needs-operator');
		expect(rerunFailedChecks).not.toHaveBeenCalled();
		expect(releaseReviewDispatch).not.toHaveBeenCalled();
		const run = createFailedRun.mock.calls[0]?.[0] as { error: string };
		expect(run.error).toContain(`SWARM could not re-run the failing checks: ${reason}.`);
		expect(run.error).not.toMatch(/SWARM_OPERATOR_/);
		expect(postComment).toHaveBeenCalledOnce();
	});

	it('hands the head off at once when there is no operator for a later re-run', async () => {
		getApprovedHeadSlot.mockResolvedValue(slot(2, 30 * MINUTE));
		runAsPullRequestOperator.mockRejectedValueOnce(
			new PullRequestOperatorUnavailableError('no operator'),
		);
		expect((await recoverAdjudicatedApprovedHead(input())).outcome).toBe('needs-operator');
		expect(rerunFailedChecks).not.toHaveBeenCalled();
		expect((createFailedRun.mock.calls[0]?.[0] as { error: string }).error).toContain(
			'SWARM re-ran the failing checks 2 times and they failed again, then could not re-run them again: no operator.',
		);
	});

	it('names the operator whose credential the provider refused', async () => {
		rerunFailedChecks.mockResolvedValueOnce({ status: 'provider-error', message: 'HTTP 401' });

		expect((await recoverAdjudicatedApprovedHead(input())).outcome).toBe('needs-operator');
		expect((createFailedRun.mock.calls[0]?.[0] as { error: string }).error).toContain(
			"HTTP 401 (acting as the operator credential stored for worker 'alice-laptop')",
		);
	});

	it('never throws: a ledger read error leaves the head to its caller', async () => {
		getApprovedHeadSlot.mockRejectedValue(new Error('db down'));
		expect(await recoverAdjudicatedApprovedHead(input())).toEqual({ outcome: 'not-applicable' });
		expect(rerunFailedChecks).not.toHaveBeenCalled();
	});

	it('never throws: a ledger claim error leaves the head to its caller', async () => {
		claimApprovedHeadChecksRerun.mockRejectedValue(new Error('db down'));
		expect(await recoverAdjudicatedApprovedHead(input())).toEqual({ outcome: 'not-applicable' });
		expect(rerunFailedChecks).not.toHaveBeenCalled();
	});

	it('keeps the notice best-effort when neither the run nor the comment can be written', async () => {
		rerunFailedChecks.mockResolvedValueOnce({ status: 'unsupported', message: 'nope' });
		createFailedRun.mockRejectedValueOnce(new Error('db down'));
		postComment.mockRejectedValueOnce(new Error('HTTP 502'));
		expect((await recoverAdjudicatedApprovedHead(input())).outcome).toBe('needs-operator');
	});
});

// Issue #1474: a `no-fix` verdict covers only the failure it was made on.
describe('a re-run failing differently from the verdict (issue #1474)', () => {
	const CHECK = 'Lint, typecheck, and test';
	const JUDGED = [{ check: CHECK, attempt: 1, failedStep: null }];
	const verdictAttempt: CheckAttemptRunner = {
		check: CHECK,
		attempt: 1,
		runner: 'm5_pro_sm_1',
		failedStep: null,
	};
	const adjudicatedSlot = (attempts: number, agoMs: number, routedAt: Date | null = null) =>
		slot(attempts, agoMs, null, { adjudicatedFailure: JUDGED, failureChangeRoutedAt: routedAt });

	it('records the failure the verdict was made on before the first re-run runs', async () => {
		describeFailedCheckAttempts.mockResolvedValue([verdictAttempt]);
		expect((await recoverAdjudicatedApprovedHead(input({ failedChecks: [CHECK] }))).outcome).toBe(
			'rerun-requested',
		);
		expect(recordApprovedHeadAdjudicatedFailure).toHaveBeenCalledExactlyOnceWith(KEY, JUDGED);
		expect(recordApprovedHeadAdjudicatedFailure.mock.invocationCallOrder[0] as number).toBeLessThan(
			rerunFailedChecks.mock.invocationCallOrder[0] as number,
		);
	});

	it('does not record it again on a later re-run', async () => {
		getApprovedHeadSlot.mockResolvedValue(slot(1, 15 * MINUTE));
		describeFailedCheckAttempts.mockResolvedValue([verdictAttempt]);
		expect((await recoverAdjudicatedApprovedHead(input({ failedChecks: [CHECK] }))).outcome).toBe(
			'rerun-requested',
		);
		expect(recordApprovedHeadAdjudicatedFailure).not.toHaveBeenCalled();
	});

	it.each([
		['throws', () => describeFailedCheckAttempts.mockRejectedValueOnce(new Error('HTTP 502'))],
		['reports nothing', () => describeFailedCheckAttempts.mockResolvedValueOnce([])],
		[
			'reports no steps',
			() =>
				describeFailedCheckAttempts.mockResolvedValueOnce([
					{ check: CHECK, attempt: 1, runner: 'r1' },
				]),
		],
	])('records nothing, and still re-runs, when the provider read %s', async (_name, arrange) => {
		arrange();
		expect((await recoverAdjudicatedApprovedHead(input({ failedChecks: [CHECK] }))).outcome).toBe(
			'rerun-requested',
		);
		expect(recordApprovedHeadAdjudicatedFailure).not.toHaveBeenCalled();
		expect(rerunFailedChecks).toHaveBeenCalledOnce();
	});

	it('still re-runs when the verdict failure cannot be written', async () => {
		describeFailedCheckAttempts.mockResolvedValue([verdictAttempt]);
		recordApprovedHeadAdjudicatedFailure.mockRejectedValueOnce(new Error('db down'));
		expect((await recoverAdjudicatedApprovedHead(input({ failedChecks: [CHECK] }))).outcome).toBe(
			'rerun-requested',
		);
	});

	// The incident: the verdict was made on an attempt whose runner was lost (no
	// step failed); the re-run then failed in the verify step itself.
	it('sends a re-run that failed in a concrete new step back to Respond-to-CI, once', async () => {
		getApprovedHeadSlot.mockResolvedValue(adjudicatedSlot(1, RERUN_SETTLE_MS + 1_000));
		describeFailedCheckAttempts.mockResolvedValue([
			verdictAttempt,
			{ check: CHECK, attempt: 2, runner: 'm5_pro_sm_2', failedStep: 'Run npm run verify' },
		]);
		expect(
			await recoverAdjudicatedApprovedHead(
				input({ failedChecks: [CHECK], routeChangedFailure: true }),
			),
		).toEqual({ outcome: 'failure-changed' });
		expect(claimApprovedHeadFailureChangeRoute).toHaveBeenCalledExactlyOnceWith(KEY);
		expect(claimApprovedHeadChecksRerun).not.toHaveBeenCalled();
		expect(rerunFailedChecks).not.toHaveBeenCalled();
		expect(claimApprovedHeadOperatorNotice).not.toHaveBeenCalled();
	});

	it('re-routes the last re-run too, rather than handing it to the operator', async () => {
		getApprovedHeadSlot.mockResolvedValue(adjudicatedSlot(3, 60 * MINUTE));
		describeFailedCheckAttempts.mockResolvedValue([
			{ check: CHECK, attempt: 4, runner: 'r', failedStep: 'Run npm run verify' },
		]);
		expect(
			(
				await recoverAdjudicatedApprovedHead(
					input({ failedChecks: [CHECK], routeChangedFailure: true }),
				)
			).outcome,
		).toBe('failure-changed');
		expect(claimApprovedHeadOperatorNotice).not.toHaveBeenCalled();
	});

	it.each([
		['no step failed again', null],
		['the same step failed again', 'Run npm run verify'],
	])('keeps the re-runs, then the notice, when %s', async (_name, failedStep) => {
		const judged = [{ check: CHECK, attempt: 1, failedStep }];
		const sameAgain = (attempt: number): CheckAttemptRunner => ({
			check: CHECK,
			attempt,
			runner: 'r',
			failedStep,
		});
		getApprovedHeadSlot.mockResolvedValue(
			slot(1, 5 * MINUTE, null, { adjudicatedFailure: judged }),
		);
		describeFailedCheckAttempts.mockResolvedValue([sameAgain(1), sameAgain(2)]);
		const routed = input({ failedChecks: [CHECK], routeChangedFailure: true });
		expect((await recoverAdjudicatedApprovedHead(routed)).outcome).toBe('rerun-waiting');

		getApprovedHeadSlot.mockResolvedValue(
			slot(3, 60 * MINUTE, null, { adjudicatedFailure: judged }),
		);
		describeFailedCheckAttempts.mockResolvedValue([sameAgain(1), sameAgain(4)]);
		expect((await recoverAdjudicatedApprovedHead(routed)).outcome).toBe('needs-operator');
		expect(claimApprovedHeadFailureChangeRoute).not.toHaveBeenCalled();
		expect(createFailedRun).toHaveBeenCalledOnce();
	});

	it('runs no comparison for a caller that cannot dispatch the fix', async () => {
		getApprovedHeadSlot.mockResolvedValue(adjudicatedSlot(1, 5 * MINUTE));
		describeFailedCheckAttempts.mockResolvedValue([
			{ check: CHECK, attempt: 2, runner: 'r', failedStep: 'Run npm run verify' },
		]);
		expect((await recoverAdjudicatedApprovedHead(input({ failedChecks: [CHECK] }))).outcome).toBe(
			'rerun-waiting',
		);
		expect(describeFailedCheckAttempts).not.toHaveBeenCalled();
		expect(claimApprovedHeadFailureChangeRoute).not.toHaveBeenCalled();
	});

	it('re-routes a head only once: a stamped head keeps the re-runs and the notice', async () => {
		getApprovedHeadSlot.mockResolvedValue(adjudicatedSlot(3, 60 * MINUTE, new Date(NOW)));
		describeFailedCheckAttempts.mockResolvedValue([
			{ check: CHECK, attempt: 4, runner: 'r', failedStep: 'Run npm run verify' },
		]);
		expect(
			(
				await recoverAdjudicatedApprovedHead(
					input({ failedChecks: [CHECK], routeChangedFailure: true }),
				)
			).outcome,
		).toBe('needs-operator');
		expect(claimApprovedHeadFailureChangeRoute).not.toHaveBeenCalled();
	});

	it('settles when another caller won the re-route', async () => {
		getApprovedHeadSlot.mockResolvedValue(adjudicatedSlot(1, 5 * MINUTE));
		describeFailedCheckAttempts.mockResolvedValue([
			{ check: CHECK, attempt: 2, runner: 'r', failedStep: 'Run npm run verify' },
		]);
		claimApprovedHeadFailureChangeRoute.mockResolvedValueOnce(false);
		expect(
			await recoverAdjudicatedApprovedHead(
				input({ failedChecks: [CHECK], routeChangedFailure: true }),
			),
		).toEqual({ outcome: 'rerun-settling', recheckAfterMs: RERUN_SETTLE_RECHECK_DELAY_MS });
	});

	it('names the attempt the verdict was made on, and what the latest failed on, in the notice', async () => {
		getApprovedHeadSlot.mockResolvedValue(adjudicatedSlot(3, 60 * MINUTE, new Date(NOW)));
		describeFailedCheckAttempts.mockResolvedValue([
			verdictAttempt,
			{ check: CHECK, attempt: 4, runner: 'm5_pro_sm_1', failedStep: 'Run npm run verify' },
		]);
		expect((await recoverAdjudicatedApprovedHead(input({ failedChecks: [CHECK] }))).outcome).toBe(
			'needs-operator',
		);
		const sentence =
			"SWARM's CI agent made its judgement on attempt 1 of `Lint, typecheck, and test`, where " +
			'no step reported a failure (the job produced no result); the latest attempt, 4, failed ' +
			'in step `Run npm run verify`.';
		expect((createFailedRun.mock.calls[0][0] as { error: string }).error).toContain(sentence);
		expect((postComment.mock.calls[0][0] as { body: string }).body).toContain(sentence);
	});

	it('leaves that sentence out when the provider reports no steps', async () => {
		getApprovedHeadSlot.mockResolvedValue(adjudicatedSlot(3, 60 * MINUTE));
		describeFailedCheckAttempts.mockResolvedValue([{ check: CHECK, attempt: 4, runner: 'r' }]);
		expect((await recoverAdjudicatedApprovedHead(input({ failedChecks: [CHECK] }))).outcome).toBe(
			'needs-operator',
		);
		expect((createFailedRun.mock.calls[0][0] as { error: string }).error).not.toContain(
			'made its judgement',
		);
		expect((postComment.mock.calls[0][0] as { body: string }).body).not.toContain(
			'made its judgement',
		);
	});
});

describe('failureSignatureOf', () => {
	it('keeps the latest attempt of each failing check, with its failed step', () => {
		expect(
			failureSignatureOf(
				[
					{ check: 'a', attempt: 1, runner: 'r', failedStep: null },
					{ check: 'a', attempt: 2, runner: 'r', failedStep: 'Test' },
					{ check: 'b', attempt: 1, runner: 'r', failedStep: 'Lint' },
				],
				[],
			),
		).toEqual([
			{ check: 'a', attempt: 2, failedStep: 'Test' },
			{ check: 'b', attempt: 1, failedStep: 'Lint' },
		]);
	});

	it('keeps only the checks named as failing', () => {
		expect(
			failureSignatureOf(
				[
					{ check: 'a', attempt: 1, runner: 'r', failedStep: 'Test' },
					{ check: 'b', attempt: 1, runner: 'r', failedStep: 'Lint' },
				],
				['b'],
			),
		).toEqual([{ check: 'b', attempt: 1, failedStep: 'Lint' }]);
	});

	it('gives no signature when the provider reports no steps', () => {
		expect(failureSignatureOf([{ check: 'a', attempt: 1, runner: 'r' }], [])).toBeNull();
		expect(failureSignatureOf([], [])).toBeNull();
	});
});

describe('failureMateriallyChanged', () => {
	const judged = (failedStep: string | null) => [{ check: 'ci', attempt: 1, failedStep }];
	const latest = (failedStep: string | null, attempt = 2, check = 'ci') => [
		{ check, attempt, failedStep },
	];

	it('is a change when a newer attempt fails in a step the verdict did not see', () => {
		expect(failureMateriallyChanged(judged(null), latest('Run npm run verify'))).toBe(true);
		expect(failureMateriallyChanged(judged('Lint'), latest('Test'))).toBe(true);
	});

	it('is the same failure when the same step fails, or no step fails, again', () => {
		expect(failureMateriallyChanged(judged('Test'), latest('Test'))).toBe(false);
		expect(failureMateriallyChanged(judged(null), latest(null))).toBe(false);
		expect(failureMateriallyChanged(judged('Test'), latest(null))).toBe(false);
	});

	it('is a change when a check the verdict did not cover fails in a step', () => {
		expect(failureMateriallyChanged(judged(null), latest('Build', 1, 'other'))).toBe(true);
	});

	it('is no change while the latest attempt is not newer than the verdict’s', () => {
		expect(failureMateriallyChanged(judged(null), latest('Test', 1))).toBe(false);
	});
});

describe('describeVerdictAgainstLatest', () => {
	const judged = [{ check: 'ci', attempt: 1, failedStep: 'Lint' }];

	it('says so when no attempt has run since the verdict', () => {
		expect(
			describeVerdictAgainstLatest(
				judged,
				[{ check: 'ci', attempt: 1, runner: 'r', failedStep: 'Lint' }],
				['ci'],
			),
		).toBe(
			"SWARM's CI agent made its judgement on attempt 1 of `ci`, where step `Lint` failed, and that is still its latest attempt.",
		);
	});

	it('describes a latest attempt in which no step failed', () => {
		expect(
			describeVerdictAgainstLatest(
				judged,
				[{ check: 'ci', attempt: 3, runner: 'r', failedStep: null }],
				['ci'],
			),
		).toContain(
			'the latest attempt, 3, had no step report a failure (the job produced no result).',
		);
	});

	it('is null when either side is unknown', () => {
		const attempts = [{ check: 'ci', attempt: 2, runner: 'r', failedStep: 'Lint' }];
		expect(describeVerdictAgainstLatest(null, attempts, ['ci'])).toBeNull();
		expect(
			describeVerdictAgainstLatest(judged, [{ check: 'ci', attempt: 2, runner: 'r' }], ['ci']),
		).toBeNull();
	});
});

describe('summarizeAttemptRunners', () => {
	it('lists each attempt of each failed check, grouped by check, oldest first', () => {
		expect(
			summarizeAttemptRunners(
				[
					{ check: 'lint', attempt: 2, runner: 'runner-b' },
					{ check: 'test', attempt: 1, runner: 'runner-a' },
					{ check: 'lint', attempt: 1, runner: 'runner-a' },
				],
				['lint', 'test'],
			),
		).toBe(
			'The failed attempts ran on: `lint` — attempt 1: `runner-a`; `lint` — attempt 2: ' +
				'`runner-b`; `test` — attempt 1: `runner-a`.',
		);
	});

	it('says plainly when every attempt ran on one runner', () => {
		expect(
			summarizeAttemptRunners(
				[1, 2, 3].map((attempt) => ({ check: 'Verify', attempt, runner: 'm5_pro_sm_1' })),
				['Verify'],
			),
		).toBe(
			'The failed attempts ran on: `Verify` — attempt 1: `m5_pro_sm_1`; `Verify` — attempt 2: ' +
				'`m5_pro_sm_1`; `Verify` — attempt 3: `m5_pro_sm_1`. All 3 attempts ran on one runner, ' +
				'`m5_pro_sm_1`.',
		);
	});

	it('does not call a single attempt "all on one runner"', () => {
		expect(
			summarizeAttemptRunners([{ check: 'Verify', attempt: 1, runner: 'r1' }], ['Verify']),
		).toBe('The failed attempts ran on: `Verify` — attempt 1: `r1`.');
	});

	it('names an attempt whose runner was not reported, and does not call the rest "all on one"', () => {
		expect(
			summarizeAttemptRunners(
				[
					{ check: 'Verify', attempt: 1, runner: null },
					{ check: 'Verify', attempt: 2, runner: 'r1' },
				],
				['Verify'],
			),
		).toBe(
			'The failed attempts ran on: `Verify` — attempt 1: runner not reported; `Verify` — attempt 2: `r1`.',
		);
	});

	it.each([
		['no attempts', []],
		['no attempt names a runner', [{ check: 'Verify', attempt: 1, runner: null }]],
		['only checks that are not failing', [{ check: 'lint', attempt: 1, runner: 'r1' }]],
	] as const)('says nothing for %s', (_name, attempts) => {
		expect(summarizeAttemptRunners(attempts, ['Verify'])).toBeNull();
	});

	it('ignores attempts of checks not named as failing', () => {
		expect(
			summarizeAttemptRunners(
				[
					{ check: 'Verify', attempt: 1, runner: 'r1' },
					{ check: 'lint', attempt: 1, runner: 'r2' },
				],
				['Verify'],
			),
		).toBe('The failed attempts ran on: `Verify` — attempt 1: `r1`.');
	});

	it('keeps every attempt when no failing check is named', () => {
		expect(
			summarizeAttemptRunners(
				[
					{ check: 'Verify', attempt: 1, runner: 'r1' },
					{ check: 'lint', attempt: 1, runner: 'r1' },
				],
				[],
			),
		).toBe(
			'The failed attempts ran on: `Verify` — attempt 1: `r1`; `lint` — attempt 1: `r1`. ' +
				'All 2 attempts ran on one runner, `r1`.',
		);
	});
});
