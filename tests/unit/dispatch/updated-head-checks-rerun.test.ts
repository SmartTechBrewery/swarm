import { beforeEach, describe, expect, it, vi } from 'vitest';

// The run-row lookup and the once-per-head claim (issue #1433). Mocked: the
// conditional update itself is the runs repository's own integration suite; this
// one asserts the policy built on its answers.
type UpdatedHeadRun = { id: string; checksRerunHeadSha: string | null; checksRerunAt: Date | null };
const findUpdatedHeadReviewRun = vi.fn(
	async (_key: unknown): Promise<UpdatedHeadRun | undefined> => undefined,
);
const claimUpdatedHeadChecksRerun = vi.fn(async (_runId: string, _headSha: string) => true);
vi.mock('@/db/repositories/runsRepository.js', () => ({
	findUpdatedHeadReviewRun: (key: unknown) => findUpdatedHeadReviewRun(key),
	claimUpdatedHeadChecksRerun: (runId: string, headSha: string) =>
		claimUpdatedHeadChecksRerun(runId, headSha),
}));

const releaseReviewDispatch = vi.fn(async (_key: string) => {});
vi.mock('@/triggers/review-dispatch-dedup.js', () => ({
	buildReviewDispatchKey: (repo: string, prNumber: string, headSha: string) =>
		`${repo}:${prNumber}:${headSha}`,
	releaseReviewDispatch: (key: string) => releaseReviewDispatch(key),
}));

// The re-run is a write made for the pull request's author (issue #1249): it runs
// as the operator whose worker produced it. By default an operator resolves.
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

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger.js', () => ({ logger }));

import type { ProjectConfig } from '@/config/schema.js';
import { RERUN_SETTLE_MS } from '@/dispatch/approved-head-checks-rerun.js';
import {
	type RerunUpdatedHeadOnceInput,
	rerunUpdatedHeadOnce,
} from '@/dispatch/updated-head-checks-rerun.js';
import { PullRequestOperatorUnavailableError } from '@/identity/pull-request-operator.js';
import type { RerunFailedChecksOutcome } from '@/scm/types.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const PROJECT = createMockProjectConfig({ autoMerge: true });
const UNSPENT: UpdatedHeadRun = { id: 'run-review', checksRerunHeadSha: null, checksRerunAt: null };

const rerunFailedChecks = vi.fn(
	async (
		_p: ProjectConfig,
		_ref: string,
		_persona?: string,
	): Promise<RerunFailedChecksOutcome> => ({ status: 'requested', checks: ['ci'] }),
);

function input(overrides: Partial<RerunUpdatedHeadOnceInput> = {}): RerunUpdatedHeadOnceInput {
	return {
		project: PROJECT,
		scm: { rerunFailedChecks },
		prNumber: '42',
		headSha: 'sha-updated',
		failedChecks: ['ci'],
		...overrides,
	};
}

/** The head's re-run already spent, `agoMs` ago. */
function spent(agoMs: number): UpdatedHeadRun {
	return {
		id: 'run-review',
		checksRerunHeadSha: 'sha-updated',
		checksRerunAt: new Date(Date.now() - agoMs),
	};
}

beforeEach(() => {
	findUpdatedHeadReviewRun.mockReset();
	findUpdatedHeadReviewRun.mockResolvedValue(UNSPENT);
	claimUpdatedHeadChecksRerun.mockReset();
	claimUpdatedHeadChecksRerun.mockResolvedValue(true);
	releaseReviewDispatch.mockClear();
	rerunFailedChecks.mockClear();
	runAsPullRequestOperator.mockClear();
	logger.warn.mockClear();
	logger.error.mockClear();
});

describe('rerunUpdatedHeadOnce', () => {
	it('does not apply when merge automation is off for the repository', async () => {
		expect(await rerunUpdatedHeadOnce(input({ project: createMockProjectConfig() }))).toBe(
			'not-applicable',
		);
		expect(findUpdatedHeadReviewRun).not.toHaveBeenCalled();
		expect(rerunFailedChecks).not.toHaveBeenCalled();
	});

	it('does not apply to a head merge automation did not produce for an approval', async () => {
		findUpdatedHeadReviewRun.mockResolvedValue(undefined);

		expect(await rerunUpdatedHeadOnce(input())).toBe('not-applicable');
		expect(claimUpdatedHeadChecksRerun).not.toHaveBeenCalled();
		expect(rerunFailedChecks).not.toHaveBeenCalled();
	});

	it('re-runs the failed checks once, as the operator, and releases the head’s claim', async () => {
		expect(await rerunUpdatedHeadOnce(input())).toBe('rerun-requested');

		expect(findUpdatedHeadReviewRun).toHaveBeenCalledWith({
			projectId: PROJECT.id,
			repository: PROJECT.repo,
			prNumber: '42',
			headSha: 'sha-updated',
		});
		expect(claimUpdatedHeadChecksRerun).toHaveBeenCalledWith('run-review', 'sha-updated');
		expect(runAsPullRequestOperator).toHaveBeenCalledWith(PROJECT, '42', expect.any(Function));
		expect(rerunFailedChecks).toHaveBeenCalledWith(PROJECT, 'sha-updated', 'implementer');
		expect(releaseReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:42:sha-updated`);
	});

	it('lets a re-run requested moments ago settle', async () => {
		claimUpdatedHeadChecksRerun.mockResolvedValue(false);
		findUpdatedHeadReviewRun.mockResolvedValueOnce(UNSPENT).mockResolvedValueOnce(spent(10_000));

		expect(await rerunUpdatedHeadOnce(input())).toBe('rerun-settling');
		expect(rerunFailedChecks).not.toHaveBeenCalled();
		expect(releaseReviewDispatch).not.toHaveBeenCalled();
	});

	it('answers spent once the settle window has passed', async () => {
		claimUpdatedHeadChecksRerun.mockResolvedValue(false);
		findUpdatedHeadReviewRun.mockResolvedValue(spent(RERUN_SETTLE_MS + 1_000));

		expect(await rerunUpdatedHeadOnce(input())).toBe('spent');
		expect(rerunFailedChecks).not.toHaveBeenCalled();
	});

	it('does not apply when the merge generation moved off the head between the two reads', async () => {
		claimUpdatedHeadChecksRerun.mockResolvedValue(false);
		findUpdatedHeadReviewRun.mockResolvedValueOnce(UNSPENT).mockResolvedValueOnce(undefined);

		expect(await rerunUpdatedHeadOnce(input())).toBe('not-applicable');
	});

	it.each<[string, RerunFailedChecksOutcome, string]>([
		['nothing-to-rerun', { status: 'nothing-to-rerun' }, 'no failed check it could re-run'],
		['unsupported', { status: 'unsupported', message: 'no re-run API' }, 'unsupported'],
		[
			'provider-error',
			{ status: 'provider-error', message: 'HTTP 502' },
			"acting as the operator credential stored for worker 'alice-laptop'",
		],
	])('hands a %s refusal to Respond-to-CI with the reason logged', async (_l, answer, reason) => {
		rerunFailedChecks.mockResolvedValueOnce(answer);

		expect(await rerunUpdatedHeadOnce(input())).toBe('rerun-refused');
		expect(releaseReviewDispatch).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('could not re-run'),
			expect.objectContaining({ reason: expect.stringContaining(reason) }),
		);
	});

	it('hands the red to Respond-to-CI when there is no operator to re-run as', async () => {
		runAsPullRequestOperator.mockRejectedValueOnce(
			new PullRequestOperatorUnavailableError('no registered SWARM worker produced it'),
		);

		expect(await rerunUpdatedHeadOnce(input())).toBe('rerun-refused');
		expect(rerunFailedChecks).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('could not re-run'),
			expect.objectContaining({ reason: 'no registered SWARM worker produced it' }),
		);
	});

	it('contains a provider that throws despite the contract', async () => {
		rerunFailedChecks.mockRejectedValueOnce(new Error('boom'));

		expect(await rerunUpdatedHeadOnce(input())).toBe('rerun-refused');
	});

	it('does not apply when the bound cannot be read or claimed', async () => {
		claimUpdatedHeadChecksRerun.mockRejectedValue(new Error('db down'));

		expect(await rerunUpdatedHeadOnce(input())).toBe('not-applicable');
		expect(rerunFailedChecks).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalled();
	});
});
