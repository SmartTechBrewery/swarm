import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { CheckoutDiscardRow } from '@/db/repositories/checkoutDiscardsRepository.js';
import {
	type CheckoutDiscardDispatchDeps,
	pushPendingCheckoutDiscards,
} from '@/router/checkout-discard-dispatch.js';

/**
 * The router half of a reset's checkout discard (issue #1402): pending rows become
 * `checkout-discard` frames to the worker that holds the checkout, and a request a
 * newer preserved attempt on the same worker has overtaken is settled, not pushed.
 */

const WORKER_A = '11111111-1111-4111-8111-111111111111';
const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function row(overrides: Partial<CheckoutDiscardRow> = {}): CheckoutDiscardRow {
	return {
		id: '14021402-1402-4402-8402-140214021402',
		workerId: WORKER_A,
		runId: RUN_ID,
		projectId: 'p1',
		repository: 'SmartTechBrewery/swarm',
		taskId: '2119-conflicts',
		worktreeRoot: '.swarm-workspaces',
		requestedAt: new Date('2026-11-10T09:08:48Z'),
		settledAt: null,
		outcome: null,
		detail: null,
		...overrides,
	};
}

function deps(overrides: Partial<CheckoutDiscardDispatchDeps> = {}): CheckoutDiscardDispatchDeps {
	return {
		listPending: vi.fn().mockResolvedValue([row()]),
		settle: vi.fn().mockResolvedValue(true),
		// The reset cleared the pin; the restart ran on worker B.
		preservedWorkerOf: vi.fn().mockResolvedValue(null),
		send: vi.fn().mockReturnValue(true),
		...overrides,
	};
}

describe('pushPendingCheckoutDiscards', () => {
	it('pushes each pending discard to the worker that holds the checkout', async () => {
		const d = deps();

		await expect(pushPendingCheckoutDiscards(WORKER_A, d)).resolves.toBe(1);

		expect(d.send).toHaveBeenCalledWith(WORKER_A, {
			type: 'checkout-discard',
			requestId: row().id,
			runId: RUN_ID,
			projectId: 'p1',
			repository: 'SmartTechBrewery/swarm',
			taskId: '2119-conflicts',
			worktreeRoot: '.swarm-workspaces',
		});
		expect(d.settle).not.toHaveBeenCalled();
	});

	it('leaves the request pending when the worker is not connected here', async () => {
		const d = deps({ send: vi.fn().mockReturnValue(false) });

		await expect(pushPendingCheckoutDiscards(WORKER_A, d)).resolves.toBe(0);

		expect(d.settle).not.toHaveBeenCalled();
	});

	it('settles a request superseded by a newer preserved attempt on the same worker', async () => {
		const d = deps({ preservedWorkerOf: vi.fn().mockResolvedValue(WORKER_A) });

		await expect(pushPendingCheckoutDiscards(WORKER_A, d)).resolves.toBe(0);

		expect(d.send).not.toHaveBeenCalled();
		expect(d.settle).toHaveBeenCalledWith(WORKER_A, row().id, 'superseded', expect.any(String));
	});
});
