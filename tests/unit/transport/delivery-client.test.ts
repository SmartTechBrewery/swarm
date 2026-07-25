import { describe, expect, it, vi } from 'vitest';

import { deliveryUrl, type FetchLike, postDelivery } from '@/transport/delivery-client.js';
import { TRANSPORT_PROTOCOL_VERSION } from '@/transport/protocol.js';

const CONTROL_PLANE = 'https://swarm.example';
const CREDENTIAL = 'raw-worker-credential-secret';

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const identity = (value: unknown): unknown => value;

describe('deliveryUrl', () => {
	it('joins a base URL and a path, tolerating trailing slashes', () => {
		expect(deliveryUrl(CONTROL_PLANE, '/worker/delivery/review')).toBe(
			'https://swarm.example/worker/delivery/review',
		);
		expect(deliveryUrl('https://swarm.example//', '/worker/delivery/pm/move')).toBe(
			'https://swarm.example/worker/delivery/pm/move',
		);
	});
});

describe('postDelivery', () => {
	it('POSTs JSON with the bearer credential and the protocol version stamped on', async () => {
		const fetchImpl = vi
			.fn<FetchLike>()
			.mockResolvedValue(jsonResponse(200, { commentId: 'IC_1' }));

		const payload = await postDelivery(
			{ controlPlaneUrl: CONTROL_PLANE, workerCredential: CREDENTIAL, fetchImpl },
			'/worker/delivery/pm/comment',
			{ projectId: 'swarm', itemId: 'PVTI_1', body: 'hello' },
			identity,
		);

		expect(payload).toEqual({ commentId: 'IC_1' });
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://swarm.example/worker/delivery/pm/comment');
		expect(init.method).toBe('POST');
		expect(init.headers['content-type']).toBe('application/json');
		// The raw credential rides the header only — never the URL or the body.
		expect(init.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
		expect(url).not.toContain(CREDENTIAL);
		expect(init.body).not.toContain(CREDENTIAL);
		expect(JSON.parse(init.body)).toEqual({
			projectId: 'swarm',
			itemId: 'PVTI_1',
			body: 'hello',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	it('throws with the status on a non-2xx response, without leaking the credential', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(403, {}));

		await expect(
			postDelivery(
				{ controlPlaneUrl: CONTROL_PLANE, workerCredential: CREDENTIAL, fetchImpl },
				'/worker/delivery/review',
				{},
				identity,
			),
		).rejects.toThrow(/\/worker\/delivery\/review failed with status 403/);
	});

	it('throws when the response body cannot be read', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => {
				throw new Error('not json');
			},
		});

		await expect(
			postDelivery(
				{ controlPlaneUrl: CONTROL_PLANE, workerCredential: CREDENTIAL, fetchImpl },
				'/worker/delivery/review',
				{},
				identity,
			),
		).rejects.toThrow(/unparseable response: not json/);
	});

	it('propagates the parser’s rejection so a malformed body is never used', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { nope: true }));

		await expect(
			postDelivery(
				{ controlPlaneUrl: CONTROL_PLANE, workerCredential: CREDENTIAL, fetchImpl },
				'/worker/delivery/review',
				{},
				() => {
					throw new Error('schema mismatch');
				},
			),
		).rejects.toThrow(/schema mismatch/);
	});
});
