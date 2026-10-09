import { beforeEach, describe, expect, it, vi } from 'vitest';

const { processJob, endOrphanTrustAtClaim, endOrphanTrustUnlessRetryPending } = vi.hoisted(() => ({
	processJob: vi.fn(),
	endOrphanTrustAtClaim: vi.fn(),
	endOrphanTrustUnlessRetryPending: vi.fn(),
}));
vi.mock('@/worker/consumer.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/worker/consumer.js')>()),
	processJob,
}));
vi.mock('@/router/transport-loss-reaper.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/router/transport-loss-reaper.js')>()),
	endOrphanTrustAtClaim,
	endOrphanTrustUnlessRetryPending,
}));

import { createControlPlaneDispatchDeps, processControlPlaneJob } from '@/router/dispatcher.js';
import { createTriggerRegistry } from '@/triggers/index.js';
import type { ProcessJobDeps } from '@/worker/consumer.js';
import { createMockPmWebhookJob } from '../../helpers/factories.js';

/**
 * The bracket the control plane puts around each claimed job (the review of #1078):
 * the trusted window of a transport-lost orphan ends at the claim and, failing a
 * push, when the job is over — never for a wake-up whose claim was refused.
 */

const DISPATCH_ID = 'ee14c88f-1f88-4b64-a740-4c308ec011e5';

function run() {
	return processControlPlaneJob(
		createMockPmWebhookJob({ dispatchId: DISPATCH_ID }),
		createTriggerRegistry(),
		new AbortController().signal,
		createControlPlaneDispatchDeps(),
	);
}

/** `processJob` claiming its dispatch, then ending as `end` says. */
function claimsThen(end: () => Promise<unknown>) {
	processJob.mockImplementation(async (...args: unknown[]) => {
		(args[4] as ProcessJobDeps).onDispatchClaimed?.(DISPATCH_ID);
		return end();
	});
}

describe('processControlPlaneJob', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		endOrphanTrustUnlessRetryPending.mockResolvedValue(undefined);
	});

	it('ends the trust at the claim, then checks the dispatch once the job is over', async () => {
		claimsThen(async () => ({ status: 'phase-deferred' }));

		await expect(run()).resolves.toEqual({ status: 'phase-deferred' });

		expect(endOrphanTrustAtClaim).toHaveBeenCalledExactlyOnceWith(DISPATCH_ID);
		expect(endOrphanTrustUnlessRetryPending).toHaveBeenCalledExactlyOnceWith(DISPATCH_ID);
		expect(endOrphanTrustAtClaim.mock.invocationCallOrder[0]).toBeLessThan(
			endOrphanTrustUnlessRetryPending.mock.invocationCallOrder[0],
		);
	});

	it('still checks the dispatch when the claimed job throws', async () => {
		claimsThen(async () => {
			throw new Error('unknown project');
		});

		await expect(run()).rejects.toThrow('unknown project');

		expect(endOrphanTrustUnlessRetryPending).toHaveBeenCalledExactlyOnceWith(DISPATCH_ID);
	});

	it('touches no orphan when the wake-up’s claim is refused', async () => {
		processJob.mockResolvedValue({ status: 'dispatch-refused', reason: 'stale-wake' });

		await run();

		expect(endOrphanTrustAtClaim).not.toHaveBeenCalled();
		expect(endOrphanTrustUnlessRetryPending).not.toHaveBeenCalled();
	});
});
