import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatePullRequestInput, ScmDeliveryProvider } from '@/scm/delivery.js';
import { createTransportScmDeliveryProvider, type FetchLike } from '@/scm/transport-delivery.js';
import { TRANSPORT_PROTOCOL_VERSION } from '@/transport/protocol.js';

const CONTROL_PLANE = 'https://swarm.example';
const CREDENTIAL = 'raw-worker-credential-secret';
const PROJECT_ID = 'swarm';

/** A local delegate whose every op records that it was called (source ops stay local). */
function makeLocalDelegate(overrides: Partial<ScmDeliveryProvider> = {}): ScmDeliveryProvider {
	return {
		commitIdentity: { name: 'ada', email: 'ada@users.noreply.github.com' },
		findPullRequest: vi.fn().mockResolvedValue({ number: 5, url: 'u' }),
		createPullRequest: vi.fn().mockResolvedValue({ number: 6, url: 'u' }),
		pushBranch: vi.fn().mockResolvedValue(undefined),
		submitReview: vi.fn(),
		postComment: vi.fn(),
		...overrides,
	};
}

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('createTransportScmDeliveryProvider', () => {
	beforeEach(() => vi.clearAllMocks());

	it('POSTs submitReview to the review endpoint with the bearer header and schema-valid body', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { reviewId: 77 }));
		const provider = createTransportScmDeliveryProvider({
			controlPlaneUrl: CONTROL_PLANE,
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			localDelegate: makeLocalDelegate(),
			fetchImpl,
		});

		const reviewId = await provider.submitReview({
			prNumber: 42,
			verdict: 'approve',
			body: 'Looks good',
			deliveryId: 'delivery-1',
		});

		expect(reviewId).toBe(77);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://swarm.example/worker/delivery/review');
		expect(init.method).toBe('POST');
		expect(init.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
		expect(JSON.parse(init.body)).toEqual({
			projectId: PROJECT_ID,
			prNumber: 42,
			verdict: 'approve',
			body: 'Looks good',
			deliveryId: 'delivery-1',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	it('POSTs postComment to the pr-comment endpoint and parses the comment id', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { commentId: 88 }));
		const provider = createTransportScmDeliveryProvider({
			controlPlaneUrl: CONTROL_PLANE,
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			localDelegate: makeLocalDelegate(),
			fetchImpl,
		});

		const commentId = await provider.postComment({
			prNumber: 42,
			body: 'Addressed',
			deliveryId: 'delivery-2',
		});

		expect(commentId).toBe(88);
		expect(fetchImpl.mock.calls[0][0]).toBe('https://swarm.example/worker/delivery/pr-comment');
	});

	it('tolerates a trailing slash on the control-plane URL', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { reviewId: 1 }));
		const provider = createTransportScmDeliveryProvider({
			controlPlaneUrl: 'https://swarm.example/',
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			localDelegate: makeLocalDelegate(),
			fetchImpl,
		});
		await provider.submitReview({ prNumber: 1, verdict: 'comment', body: 'x', deliveryId: 'd' });
		expect(fetchImpl.mock.calls[0][0]).toBe('https://swarm.example/worker/delivery/review');
	});

	it('throws on a non-2xx response so the phase can defer and retry', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(503, {}));
		const provider = createTransportScmDeliveryProvider({
			controlPlaneUrl: CONTROL_PLANE,
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			localDelegate: makeLocalDelegate(),
			fetchImpl,
		});
		await expect(
			provider.submitReview({ prNumber: 1, verdict: 'approve', body: 'x', deliveryId: 'd' }),
		).rejects.toThrow(/503/);
	});

	it('throws on an unparseable / schema-invalid response body', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { nope: true }));
		const provider = createTransportScmDeliveryProvider({
			controlPlaneUrl: CONTROL_PLANE,
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			localDelegate: makeLocalDelegate(),
			fetchImpl,
		});
		await expect(
			provider.postComment({ prNumber: 1, body: 'x', deliveryId: 'd' }),
		).rejects.toThrow();
	});

	it('delegates every source-carrying / attribution op locally and never hits fetch', async () => {
		const fetchImpl = vi.fn<FetchLike>();
		const local = makeLocalDelegate();
		const provider = createTransportScmDeliveryProvider({
			controlPlaneUrl: CONTROL_PLANE,
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			localDelegate: local,
			fetchImpl,
		});

		expect(provider.commitIdentity).toEqual(local.commitIdentity);
		await provider.findPullRequest('branch');
		const prInput: CreatePullRequestInput = {
			baseBranch: 'main',
			branch: 'feature',
			title: 't',
			body: 'b',
		};
		await provider.createPullRequest(prInput);
		await provider.pushBranch('/cwd', 'feature', 'sha');

		expect(local.findPullRequest).toHaveBeenCalledWith('branch');
		expect(local.createPullRequest).toHaveBeenCalledWith(prInput);
		expect(local.pushBranch).toHaveBeenCalledWith('/cwd', 'feature', 'sha');
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
