import { describe, expect, it, vi } from 'vitest';

import type { FetchLike } from '@/transport/delivery-client.js';
import { TRANSPORT_PROTOCOL_VERSION } from '@/transport/protocol.js';
import { createTransportReviewLedger } from '@/transport/review-ledger-delivery.js';

const CONTROL_PLANE = 'https://swarm.example';
const CREDENTIAL = 'raw-worker-credential-secret';
const PROJECT_ID = 'swarm';
const KEY = {
	projectId: PROJECT_ID,
	repository: 'jkwiecien/swarm',
	prNumber: '42',
	headSha: 'deadbeef',
};

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function ledger(fetchImpl: FetchLike) {
	return createTransportReviewLedger({
		controlPlaneUrl: CONTROL_PLANE,
		workerCredential: CREDENTIAL,
		projectId: PROJECT_ID,
		fetchImpl,
	});
}

describe('createTransportReviewLedger', () => {
	it('reads a prior submitted verdict over the ledger route', async () => {
		const record = {
			ordinal: 1,
			state: 'submitted',
			verdict: 'request-changes',
			headSha: 'cafe',
		};
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { record }));

		const prior = await ledger(fetchImpl).getPriorSubmittedReview(
			PROJECT_ID,
			'jkwiecien/swarm',
			'42',
			'deadbeef',
		);

		expect(prior).toEqual(record);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://swarm.example/worker/delivery/review-ledger/prior');
		expect(init.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
		// The repository is deliberately absent: the server derives it from the
		// authenticated project, so a worker can't key a row to another repo.
		expect(JSON.parse(init.body)).toEqual({
			projectId: PROJECT_ID,
			prNumber: '42',
			currentHeadSha: 'deadbeef',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	it('maps a null record back to undefined, the shape the repository returns', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { record: null }));
		await expect(
			ledger(fetchImpl).getPriorSubmittedReview(PROJECT_ID, 'jkwiecien/swarm', '42', 'deadbeef'),
		).resolves.toBeUndefined();
	});

	it('marks a submitted verdict and returns its slot', async () => {
		const fetchImpl = vi
			.fn<FetchLike>()
			.mockResolvedValue(jsonResponse(200, { slot: { id: 'verdict-2', ordinal: 2 } }));

		const slot = await ledger(fetchImpl).markReviewVerdictSubmitted(KEY, {
			verdict: 'request-changes',
			reviewId: '9911',
		});

		expect(slot).toEqual({ id: 'verdict-2', ordinal: 2 });
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://swarm.example/worker/delivery/review-ledger/mark');
		expect(JSON.parse(init.body)).toEqual({
			projectId: PROJECT_ID,
			prNumber: '42',
			headSha: 'deadbeef',
			verdict: 'request-changes',
			reviewId: '9911',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	it('maps a null slot back to undefined so the phase treats the ordinal as unknown', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { slot: null }));
		await expect(
			ledger(fetchImpl).markReviewVerdictSubmitted(KEY, { verdict: 'approve' }),
		).resolves.toBeUndefined();
	});

	it('abandons a pending slot', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, {}));

		await ledger(fetchImpl).abandonReviewVerdict(KEY);

		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://swarm.example/worker/delivery/review-ledger/abandon');
		expect(JSON.parse(init.body)).toEqual({
			projectId: PROJECT_ID,
			prNumber: '42',
			headSha: 'deadbeef',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	it('throws on a refused or malformed response, exactly as a failed repository call would', async () => {
		const refused = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(403, {}));
		await expect(
			ledger(refused).getPriorSubmittedReview(PROJECT_ID, 'jkwiecien/swarm', '42', 'deadbeef'),
		).rejects.toThrow(/403/);

		const malformed = vi
			.fn<FetchLike>()
			.mockResolvedValue(jsonResponse(200, { slot: { ordinal: 0 } }));
		await expect(
			ledger(malformed).markReviewVerdictSubmitted(KEY, { verdict: 'approve' }),
		).rejects.toThrow();
	});
});
