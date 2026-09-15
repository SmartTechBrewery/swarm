import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCli } from '@/harness/agent-cli.js';
import type { TaskExecutionResult } from '@/transport/protocol.js';
import { RETRY_BUFFER_MS, retryDelayForFailure } from '@/worker/consumer.js';
import type { DispatchSelection } from '@/worker/eligibility-gate.js';

// The one DB collaborator, mocked at its module boundary (ai/TESTING.md). Everything
// else here is the policy that decides *whether* and *for how long* to record.
const recordWorkerCliRateLimit = vi.fn<
	(input: {
		workerId: string;
		cli: AgentCli;
		expiresAt: Date;
		observedAt: Date;
		resetHint?: string;
	}) => Promise<void>
>(async () => {});
vi.mock('@/db/repositories/workerCliRateLimitsRepository.js', () => ({
	recordWorkerCliRateLimit: (input: Parameters<typeof recordWorkerCliRateLimit>[0]) =>
		recordWorkerCliRateLimit(input),
}));

import { recordReportedRateLimit } from '@/router/dispatcher.js';

const SELECTION: DispatchSelection = {
	workerId: 'w-1',
	workerName: 'ada-laptop',
	ownerUserId: 'user-1',
	target: { cli: 'claude' },
	targetIndex: 0,
	cli: 'claude',
	skippedClis: [],
};

const DISPATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** The instant every case is judged at, so a recorded expiry is exactly derivable. */
const NOW = new Date('2026-09-15T12:00:00Z');

function frame(overrides: Partial<TaskExecutionResult>): TaskExecutionResult {
	return {
		type: 'task-execution-result',
		dispatchId: DISPATCH,
		status: 'deferred',
		phase: 'implementation',
		taskId: '981',
		...overrides,
	} as TaskExecutionResult;
}

/** What the recorded expiry must equal — the shared policy's own answer, never a re-derived number. */
function expiryFor(retryAfter?: Date): number {
	return NOW.getTime() + retryDelayForFailure({ kind: 'rate-limit', retryAfter }, NOW.getTime());
}

describe('recordReportedRateLimit (issue #981)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		recordWorkerCliRateLimit.mockClear();
		recordWorkerCliRateLimit.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('records the reported reset against the (worker, CLI) that hit it', async () => {
		const retryAfter = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
		await recordReportedRateLimit(
			frame({
				failureKind: 'rate-limit',
				retryAfter: retryAfter.toISOString(),
				resetHint: 'resets at 2pm',
			}),
			SELECTION,
		);

		expect(recordWorkerCliRateLimit).toHaveBeenCalledTimes(1);
		expect(recordWorkerCliRateLimit).toHaveBeenCalledWith({
			workerId: 'w-1',
			cli: 'claude',
			expiresAt: new Date(expiryFor(retryAfter)),
			observedAt: NOW,
			// Verbatim, for an operator — never parsed back.
			resetHint: 'resets at 2pm',
		});
	});

	// The record lapses at exactly the instant the deferred retry is scheduled for,
	// because both come from the same policy call on the same failure.
	it('degrades to the shared default backoff when the frame reports no reset', async () => {
		await recordReportedRateLimit(frame({ failureKind: 'rate-limit' }), SELECTION);

		const [input] = recordWorkerCliRateLimit.mock.calls[0] ?? [];
		expect(input?.expiresAt).toEqual(new Date(expiryFor()));
		expect(input?.expiresAt.getTime()).toBe(NOW.getTime() + 30 * 60 * 1000);
	});

	// Criterion 5: no sequence of events can hold a machine back indefinitely. The
	// ceiling is structural because the expiry goes through the shared policy rather
	// than being stored raw — it is the longest wait a deferred wake-up survives the
	// job-freshness gate for (`SWARM_MAX_JOB_AGE_MS`, 24 h, less a dequeue margin).
	it('caps a reset far in the future at the shared ceiling', async () => {
		const retryAfter = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
		await recordReportedRateLimit(
			frame({ failureKind: 'rate-limit', retryAfter: retryAfter.toISOString() }),
			SELECTION,
		);

		const [input] = recordWorkerCliRateLimit.mock.calls[0] ?? [];
		expect(input?.expiresAt.getTime()).toBe(expiryFor(retryAfter));
		expect((input?.expiresAt.getTime() ?? 0) - NOW.getTime()).toBe(
			24 * 60 * 60 * 1000 - 15 * 60 * 1000,
		);
	});

	// The observed agy exhaustion (issue #1013). A six-hour ceiling used to expire this
	// machine's Antigravity cool-down ten hours before the account had anything left,
	// so routing resumed sending it work — and the deferred run retried into the same
	// empty account, since the retry delay is this same answer.
	it('records the full reset an exhausted Antigravity account reported', async () => {
		const observed = 16 * 60 * 60 * 1000 + 39 * 60 * 1000 + 20 * 1000;
		const retryAfter = new Date(NOW.getTime() + observed);
		await recordReportedRateLimit(
			frame({
				failureKind: 'rate-limit',
				retryAfter: retryAfter.toISOString(),
				resetHint: 'in 16h39m20s',
			}),
			{ ...SELECTION, cli: 'antigravity', target: { cli: 'antigravity' } },
		);

		const [input] = recordWorkerCliRateLimit.mock.calls[0] ?? [];
		expect(input?.expiresAt.getTime()).toBe(expiryFor(retryAfter));
		// Past the reset by the shared buffer, never short of it.
		expect(input?.expiresAt.getTime()).toBe(retryAfter.getTime() + RETRY_BUFFER_MS);
	});

	it('floors a reset already in the past rather than recording a lapsed row', async () => {
		const retryAfter = new Date(NOW.getTime() - 60 * 60 * 1000);
		await recordReportedRateLimit(
			frame({ failureKind: 'rate-limit', retryAfter: retryAfter.toISOString() }),
			SELECTION,
		);

		const [input] = recordWorkerCliRateLimit.mock.calls[0] ?? [];
		expect(input?.expiresAt.getTime()).toBe(expiryFor(retryAfter));
		expect(input?.expiresAt.getTime() ?? 0).toBeGreaterThan(NOW.getTime());
	});

	// An older worker that reports no `failureKind` is read exactly as
	// `adaptResultToPhaseRun` reads the same frame, so the record can never disagree
	// with the retry the settle schedules moments later.
	it('applies the same rate-limit default a kindless deferral is settled under', async () => {
		await recordReportedRateLimit(frame({}), SELECTION);
		expect(recordWorkerCliRateLimit).toHaveBeenCalledTimes(1);
	});

	it('records nothing for a deferral of any other kind', async () => {
		for (const failureKind of ['capacity', 'timeout', 'aborted', 'delivery', 'stalled']) {
			await recordReportedRateLimit(frame({ failureKind }), SELECTION);
		}
		expect(recordWorkerCliRateLimit).not.toHaveBeenCalled();
	});

	it('records nothing for a succeeded or failed frame', async () => {
		await recordReportedRateLimit(frame({ status: 'succeeded', exitCode: 0 }), SELECTION);
		await recordReportedRateLimit(
			frame({ status: 'failed', failureKind: 'rate-limit' }),
			SELECTION,
		);
		expect(recordWorkerCliRateLimit).not.toHaveBeenCalled();
	});

	// Bookkeeping must never fail a settle — the same rule `tryCompleteDispatch`
	// follows. A lost record costs one avoidable bounce, not a dropped job.
	it('swallows a repository failure so the settle is unaffected', async () => {
		recordWorkerCliRateLimit.mockRejectedValue(new Error('db down'));

		await expect(
			recordReportedRateLimit(frame({ failureKind: 'rate-limit' }), SELECTION),
		).resolves.toBeUndefined();
	});
});
