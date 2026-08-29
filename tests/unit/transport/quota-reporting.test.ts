import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { CliQuotaSnapshot } from '@/harness/quota.js';
import type { discoverCliQuotas } from '@/harness/quota-discovery.js';
import {
	startWorkerQuotaReporting,
	WORKER_QUOTA_REPORT_INTERVAL_MS,
	type WorkerQuotaReportingOptions,
} from '@/transport/quota-reporting.js';

const CONTROL_PLANE = 'https://swarm.example';
const CREDENTIAL = 'raw-worker-credential-secret';

function snapshot(overrides: Partial<CliQuotaSnapshot> = {}): CliQuotaSnapshot {
	return {
		cli: 'claude',
		status: 'available',
		source: 'live',
		lastUpdated: '2026-08-29T09:00:00.000Z',
		...overrides,
	};
}

type DiscoverMock = Mock<typeof discoverCliQuotas>;
type PostMock = Mock<NonNullable<WorkerQuotaReportingOptions['post']>>;

/** A probe that answers one live snapshot. */
function fakeDiscover(): DiscoverMock {
	return vi.fn<typeof discoverCliQuotas>().mockResolvedValue([snapshot()]);
}

/** A report the control plane accepts. */
function fakePost(): PostMock {
	return vi.fn<NonNullable<WorkerQuotaReportingOptions['post']>>().mockResolvedValue({ stored: 1 });
}

/**
 * The reporter with both collaborators faked, so no CLI is spawned and no request
 * is made. The startup report runs synchronously from `startWorkerQuotaReporting`,
 * so a test that wants it to fail passes an already-configured mock in.
 */
function start(
	overrides: Partial<WorkerQuotaReportingOptions> & {
		discover?: DiscoverMock;
		post?: PostMock;
	} = {},
) {
	const discover = overrides.discover ?? fakeDiscover();
	const post = overrides.post ?? fakePost();
	const handle = startWorkerQuotaReporting({
		controlPlaneUrl: CONTROL_PLANE,
		workerCredential: CREDENTIAL,
		...overrides,
		discover,
		post,
	});
	return { discover, post, handle };
}

/** Let the started report (and any interval tick) settle before asserting. */
async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

describe('startWorkerQuotaReporting', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('runs a full probe at startup and on every interval, never a cheap one', async () => {
		// A cheap pass carries no windows and no remaining allowance, and the report
		// is an upsert — one cheap tick would blank the stored live row for the life
		// of the daemon, since nothing else re-fills it.
		const { discover, post, handle } = start();

		await settle();
		expect(discover.mock.calls[0][0]).toBe(false);
		expect(post).toHaveBeenCalledWith([snapshot()]);

		await vi.advanceTimersByTimeAsync(WORKER_QUOTA_REPORT_INTERVAL_MS);
		expect(discover).toHaveBeenCalledTimes(2);
		expect(discover.mock.calls[1][0]).toBe(false);

		await vi.advanceTimersByTimeAsync(WORKER_QUOTA_REPORT_INTERVAL_MS);
		expect(discover).toHaveBeenCalledTimes(3);
		expect(discover.mock.calls[2][0]).toBe(false);

		handle.stop();
	});

	it('probes with a run-derived fallback resolver that answers null', async () => {
		// A worker holds no DATABASE_URL, so discovery must never reach for Postgres.
		const { discover, handle } = start();

		await settle();

		const resolver = discover.mock.calls[0][1]?.fallbackRateLimitInfo;
		expect(resolver).toBeDefined();
		await expect(resolver?.('claude')).resolves.toBeNull();

		handle.stop();
	});

	it('survives a rejected probe and keeps reporting on the next interval', async () => {
		const failingProbe = fakeDiscover();
		failingProbe.mockRejectedValueOnce(new Error('claude is not on PATH'));
		const { discover, post, handle } = start({ intervalMs: 1000, discover: failingProbe });

		await settle();
		expect(post).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1000);
		expect(discover).toHaveBeenCalledTimes(2);
		expect(post).toHaveBeenCalledTimes(1);

		handle.stop();
	});

	it('survives a refused report — an older control plane serves no such route', async () => {
		const refusedPost = fakePost();
		refusedPost.mockRejectedValueOnce(
			new Error('Control-plane delivery /worker/delivery/quota failed with status 404'),
		);
		const { discover, post, handle } = start({ intervalMs: 1000, post: refusedPost });

		await settle();

		await vi.advanceTimersByTimeAsync(1000);
		expect(discover).toHaveBeenCalledTimes(2);
		expect(post).toHaveBeenCalledTimes(2);

		handle.stop();
	});

	it('reports nothing more after stop()', async () => {
		const { discover, handle } = start({ intervalMs: 1000 });

		await settle();
		expect(discover).toHaveBeenCalledTimes(1);

		handle.stop();
		await vi.advanceTimersByTimeAsync(5000);

		expect(discover).toHaveBeenCalledTimes(1);
	});

	it('defaults the cadence to the coded six-hour interval', async () => {
		const { discover, handle } = start();

		await settle();
		await vi.advanceTimersByTimeAsync(WORKER_QUOTA_REPORT_INTERVAL_MS - 1);
		expect(discover).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(discover).toHaveBeenCalledTimes(2);

		handle.stop();
	});
});
