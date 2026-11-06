import { describe, expect, it } from 'vitest';

import {
	RUN_ERROR_SUMMARY_MAX_LENGTH,
	runRetryCount,
	summarizeRunError,
} from '@/db/repositories/runsRepository.js';
import type { SwarmJob } from '@/queue/jobs.js';

import { createMockScmWebhookJob } from '../../../helpers/factories.js';

// Issue #1339 — the list-only facts `listRunsFromDb` adds to each row.
describe('summarizeRunError', () => {
	it('is null for a run that recorded no error, or only whitespace', () => {
		expect(summarizeRunError(null)).toBeNull();
		expect(summarizeRunError(' \n\t\r\n ')).toBeNull();
	});

	it('keeps the first non-blank line, trimmed', () => {
		expect(summarizeRunError('\r\n  Agent exited with code 1  \r\n  stack frame')).toBe(
			'Agent exited with code 1',
		);
	});

	it('caps a long line, ellipsis included', () => {
		const summary = summarizeRunError('x'.repeat(RUN_ERROR_SUMMARY_MAX_LENGTH + 50));

		expect(summary).toHaveLength(RUN_ERROR_SUMMARY_MAX_LENGTH);
		expect(summary?.endsWith('…')).toBe(true);
	});

	it('leaves a line exactly at the cap untouched', () => {
		const line = 'y'.repeat(RUN_ERROR_SUMMARY_MAX_LENGTH);

		expect(summarizeRunError(line)).toBe(line);
	});
});

describe('runRetryCount', () => {
	it('is zero for a run with no persisted payload or no retries', () => {
		expect(runRetryCount(null)).toBe(0);
		expect(runRetryCount(createMockScmWebhookJob())).toBe(0);
	});

	it('sums the retry counters and leaves the re-check waits out', () => {
		const job = {
			...createMockScmWebhookJob(),
			rateLimitRetryAttempt: 2,
			automaticRetryAttempt: 1,
			preservedWorkRetryAttempt: 1,
			dependencyRecheckAttempt: 9,
			workerEligibilityRecheckAttempt: 4,
		} as SwarmJob;

		expect(runRetryCount(job)).toBe(4);
	});
});
