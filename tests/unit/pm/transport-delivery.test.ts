import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransportPmDeliveryProvider, type FetchLike } from '@/pm/transport-delivery.js';
import type { PMProvider } from '@/pm/types.js';
import { TRANSPORT_PROTOCOL_VERSION } from '@/transport/protocol.js';

const CONTROL_PLANE = 'https://swarm.example';
const CREDENTIAL = 'raw-worker-credential-secret';
const PROJECT_ID = 'swarm';

/** A local delegate whose every op records that it was called (reads/other writes stay local). */
function makeLocalDelegate(overrides: Partial<PMProvider> = {}): PMProvider {
	return {
		type: 'github-projects',
		supportsAssignees: true,
		supportsDependencies: true,
		getWorkItem: vi.fn().mockResolvedValue({ id: 'i1' }),
		listWorkItems: vi.fn().mockResolvedValue([]),
		moveWorkItem: vi.fn().mockResolvedValue(undefined),
		addComment: vi.fn().mockResolvedValue('local-comment'),
		findComment: vi.fn().mockResolvedValue(undefined),
		createWorkItem: vi.fn().mockResolvedValue({ id: 'new' }),
		updateWorkItem: vi.fn().mockResolvedValue(undefined),
		addLabel: vi.fn().mockResolvedValue(undefined),
		listBlockers: vi.fn().mockResolvedValue([]),
		addBlockedBy: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('createTransportPmDeliveryProvider', () => {
	beforeEach(() => vi.clearAllMocks());

	it('POSTs moveWorkItem to the pm/move endpoint with the bearer header and schema-valid body', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, {}));
		const provider = createTransportPmDeliveryProvider({
			controlPlaneUrl: CONTROL_PLANE,
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			localDelegate: makeLocalDelegate(),
			fetchImpl,
		});

		await provider.moveWorkItem('PVTI_item1', 'inReview');

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://swarm.example/worker/delivery/pm/move');
		expect(init.method).toBe('POST');
		expect(init.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
		// A canonical status key crosses the wire, never a board option ID (RULES.md §2).
		expect(JSON.parse(init.body)).toEqual({
			projectId: PROJECT_ID,
			itemId: 'PVTI_item1',
			status: 'inReview',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	it('POSTs addComment to the pm/comment endpoint and parses the string comment id', async () => {
		const fetchImpl = vi
			.fn<FetchLike>()
			.mockResolvedValue(jsonResponse(200, { commentId: 'IC_kw88' }));
		const provider = createTransportPmDeliveryProvider({
			controlPlaneUrl: CONTROL_PLANE,
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			localDelegate: makeLocalDelegate(),
			fetchImpl,
		});

		const commentId = await provider.addComment('PVTI_item1', 'Plan posted');

		expect(commentId).toBe('IC_kw88');
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://swarm.example/worker/delivery/pm/comment');
		expect(JSON.parse(init.body)).toEqual({
			projectId: PROJECT_ID,
			itemId: 'PVTI_item1',
			body: 'Plan posted',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	it('tolerates a trailing slash on the control-plane URL', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, {}));
		const provider = createTransportPmDeliveryProvider({
			controlPlaneUrl: 'https://swarm.example/',
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			localDelegate: makeLocalDelegate(),
			fetchImpl,
		});
		await provider.moveWorkItem('PVTI_item1', 'todo');
		expect(fetchImpl.mock.calls[0][0]).toBe('https://swarm.example/worker/delivery/pm/move');
	});

	it('throws on a non-2xx response so the caller behaves as a failed write', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(503, {}));
		const provider = createTransportPmDeliveryProvider({
			controlPlaneUrl: CONTROL_PLANE,
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			localDelegate: makeLocalDelegate(),
			fetchImpl,
		});
		await expect(provider.moveWorkItem('PVTI_item1', 'inReview')).rejects.toThrow(/503/);
	});

	it('throws on an unparseable / schema-invalid comment response body', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { nope: true }));
		const provider = createTransportPmDeliveryProvider({
			controlPlaneUrl: CONTROL_PLANE,
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			localDelegate: makeLocalDelegate(),
			fetchImpl,
		});
		await expect(provider.addComment('PVTI_item1', 'x')).rejects.toThrow();
	});

	it('delegates every read + non-metadata-write op locally and never hits fetch', async () => {
		const fetchImpl = vi.fn<FetchLike>();
		const local = makeLocalDelegate();
		const provider = createTransportPmDeliveryProvider({
			controlPlaneUrl: CONTROL_PLANE,
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			localDelegate: local,
			fetchImpl,
		});

		expect(provider.type).toBe(local.type);
		expect(provider.supportsAssignees).toBe(local.supportsAssignees);
		expect(provider.supportsDependencies).toBe(local.supportsDependencies);

		await provider.getWorkItem('i1');
		await provider.listWorkItems({ status: 'todo' });
		await provider.findComment('i1', 'marker');
		await provider.createWorkItem({ title: 't', description: 'd', status: 'planning' });
		await provider.updateWorkItem('i1', { title: 't2' });
		await provider.addLabel('i1', 'planned');
		await provider.listBlockers('i1');
		await provider.addBlockedBy('i1', 'i2');

		expect(local.getWorkItem).toHaveBeenCalledWith('i1');
		expect(local.listWorkItems).toHaveBeenCalledWith({ status: 'todo' });
		expect(local.findComment).toHaveBeenCalledWith('i1', 'marker');
		expect(local.createWorkItem).toHaveBeenCalledWith({
			title: 't',
			description: 'd',
			status: 'planning',
		});
		expect(local.updateWorkItem).toHaveBeenCalledWith('i1', { title: 't2' });
		expect(local.addLabel).toHaveBeenCalledWith('i1', 'planned');
		expect(local.listBlockers).toHaveBeenCalledWith('i1');
		expect(local.addBlockedBy).toHaveBeenCalledWith('i1', 'i2');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('does not expose discovery over the write transport, even when the local delegate supports it', () => {
		// `discover` is a server-side board-mapping concern reached through the PM
		// registry, never a pipeline phase's `pm` op, so the write-only transport
		// delegate leaves it absent rather than routing discovery over the wire.
		const discover = vi.fn();
		const provider = createTransportPmDeliveryProvider({
			controlPlaneUrl: CONTROL_PLANE,
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			localDelegate: makeLocalDelegate({ discover }),
		});
		expect(provider.discover).toBeUndefined();
		expect(discover).not.toHaveBeenCalled();
	});
});
