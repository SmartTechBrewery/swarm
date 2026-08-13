import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWriteOnlyTransportPmProvider, type FetchLike } from '@/pm/transport-delivery.js';
import { TRANSPORT_PROTOCOL_VERSION } from '@/transport/protocol.js';

const CONTROL_PLANE = 'https://swarm.example';
const CREDENTIAL = 'raw-worker-credential-secret';
const PROJECT_ID = 'swarm';

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('createWriteOnlyTransportPmProvider', () => {
	beforeEach(() => vi.clearAllMocks());

	function writeOnly(fetchImpl?: FetchLike) {
		return createWriteOnlyTransportPmProvider({
			controlPlaneUrl: CONTROL_PLANE,
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			providerType: 'github-projects',
			fetchImpl,
		});
	}

	it('rides the two metadata-write delivery routes under the worker credential', async () => {
		const fetchImpl = vi
			.fn<FetchLike>()
			.mockResolvedValueOnce(jsonResponse(200, {}))
			.mockResolvedValueOnce(jsonResponse(200, { commentId: 'IC_kw99' }));
		const provider = writeOnly(fetchImpl);

		await provider.moveWorkItem('PVTI_item1', 'inProgress');
		const commentId = await provider.addComment('PVTI_item1', 'Implementation done');

		expect(commentId).toBe('IC_kw99');
		expect(fetchImpl.mock.calls[0][0]).toBe('https://swarm.example/worker/delivery/pm/move');
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
			projectId: PROJECT_ID,
			itemId: 'PVTI_item1',
			status: 'inProgress',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
		expect(fetchImpl.mock.calls[1][0]).toBe('https://swarm.example/worker/delivery/pm/comment');
	});

	it('sends the worker credential as a bearer header on every write', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, {}));
		await writeOnly(fetchImpl).moveWorkItem('PVTI_item1', 'inReview');
		expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
	});

	it('tolerates a trailing slash on the control-plane URL', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, {}));
		const provider = createWriteOnlyTransportPmProvider({
			controlPlaneUrl: 'https://swarm.example/',
			workerCredential: CREDENTIAL,
			projectId: PROJECT_ID,
			providerType: 'github-projects',
			fetchImpl,
		});
		await provider.moveWorkItem('PVTI_item1', 'todo');
		expect(fetchImpl.mock.calls[0][0]).toBe('https://swarm.example/worker/delivery/pm/move');
	});

	it('throws on an unparseable / schema-invalid comment response body', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { nope: true }));
		await expect(writeOnly(fetchImpl).addComment('PVTI_item1', 'x')).rejects.toThrow();
	});

	it('reports the project’s configured provider type rather than hard-coding one', () => {
		expect(writeOnly().type).toBe('github-projects');
	});

	it('rejects only the three reads no DB-free phase calls, instead of inventing a result', async () => {
		const fetchImpl = vi.fn<FetchLike>();
		const provider = writeOnly(fetchImpl);

		// The control plane already read the assigned item and put it on the
		// assignment, and enumerating a whole board is not a worker's business.
		// Routing a card is a control-plane decision too: it is keyed on the whole
		// repository list, which a worker's repository-scoped config does not carry.
		for (const call of [
			() => provider.getWorkItem('PVTI_item1'),
			() => provider.listWorkItems({ status: 'todo' }),
			() => provider.resolveItemRepository('PVTI_item1', [{ repo: 'acme/second' }]),
		]) {
			await expect(call()).rejects.toThrow(/not available on a DB-free worker/i);
		}
		// A refused read is local — it never reaches the delivery API.
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('serves listBlockers over the transport so the dependency gate keeps gating', async () => {
		const blockers = [
			{
				id: 'PVTI_blocker',
				reference: '#319',
				url: 'https://github.com/SmartTechBrewery/swarm/issues/319',
				title: 'Prerequisite',
				open: true,
				source: 'dependency' as const,
			},
		];
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { blockers }));
		const provider = writeOnly(fetchImpl);

		// Declared ON: stubbing it off would short-circuit `findOpenBlockers` and let a
		// blocked item build out of order (issue #330).
		expect(provider.supportsDependencies).toBe(true);
		expect(provider.supportsAssignees).toBe(false);
		await expect(provider.listBlockers('PVTI_item1')).resolves.toEqual(blockers);
		expect(fetchImpl.mock.calls[0][0]).toBe('https://swarm.example/worker/delivery/pm/blockers');
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
			projectId: PROJECT_ID,
			itemId: 'PVTI_item1',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	it('accepts a blocker whose URL the provider left empty, rather than un-gating on a parse error', async () => {
		// `findOpenBlockers` treats a throw as "no blockers", so this wire schema must be
		// exactly as permissive as `WorkItemBlocker` (issue #330).
		const blockers = [
			{ reference: '#319', url: '', title: 'Prerequisite', open: true, source: 'mention' as const },
		];
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { blockers }));
		await expect(writeOnly(fetchImpl).listBlockers('PVTI_item1')).resolves.toEqual(blockers);
	});

	it('serves listDependents over the transport so the cycle backstop keeps working', async () => {
		// Issue #639: the gate runs on the worker, so refusing this read would leave
		// every federated Implementation deferring on a blocker it natively blocks
		// until the wait budget ran out — the deadlock the backstop exists to prevent.
		const dependents = [
			{
				reference: '#631',
				url: 'https://github.com/SmartTechBrewery/swarm/issues/631',
				title: 'Per-provider PM credentials',
				open: true,
			},
		];
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { dependents }));

		await expect(writeOnly(fetchImpl).listDependents('PVTI_item1')).resolves.toEqual(dependents);
		expect(fetchImpl.mock.calls[0][0]).toBe('https://swarm.example/worker/delivery/pm/dependents');
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
			projectId: PROJECT_ID,
			itemId: 'PVTI_item1',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	it("serves respond-to-review's card lookup as one narrow read over the transport", async () => {
		const wireItem = {
			id: 'ITEM_21',
			title: 'Example',
			url: 'https://github.com/SmartTechBrewery/swarm/issues/21',
		};
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { item: wireItem }));

		await expect(writeOnly(fetchImpl).findWorkItemByUrlSuffix('/issues/21')).resolves.toEqual({
			...wireItem,
			description: '',
			labels: [],
			assignees: [],
		});
		expect(fetchImpl.mock.calls[0][0]).toBe('https://swarm.example/worker/delivery/pm/find-item');
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
			projectId: PROJECT_ID,
			urlSuffix: '/issues/21',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
		// The narrow read is served, but the heavy one it replaces still refuses: a
		// worker has no business enumerating a board to answer a one-card question.
		await expect(writeOnly(fetchImpl).listWorkItems()).rejects.toThrow(
			/not available on a DB-free worker/i,
		);
	});

	it('serves a repository-scoped artifact lookup as one narrow read over the transport', async () => {
		const wireItem = {
			id: 'ITEM_21',
			title: 'Example',
			url: 'https://github.com/SmartTechBrewery/swarm/issues/21',
		};
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { item: wireItem }));

		await expect(
			writeOnly(fetchImpl).findWorkItemForArtifact({
				repository: 'SmartTechBrewery/swarm',
				kind: 'issue',
				number: '21',
			}),
		).resolves.toEqual({ ...wireItem, description: '', labels: [], assignees: [] });
		expect(fetchImpl.mock.calls[0][0]).toBe(
			'https://swarm.example/worker/delivery/pm/find-artifact',
		);
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
			projectId: PROJECT_ID,
			repository: 'SmartTechBrewery/swarm',
			kind: 'issue',
			number: '21',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	it("serves the split's resume lookup as one narrow read over the transport", async () => {
		// Issue #543: the plan-comment guard above only covers a delivery that got as
		// far as posting; this is how a split that died between children recognises the
		// card it already created instead of making a second one.
		const wireItem = {
			id: 'ITEM_61',
			title: 'Phase 2 of 3 — extract the reader',
			url: 'https://github.com/SmartTechBrewery/swarm/issues/61',
		};
		const hit = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { item: wireItem }));

		await expect(
			writeOnly(hit).findWorkItemByDescriptionMarker('<!-- swarm-split-child:run-1:0 -->'),
		).resolves.toEqual({ ...wireItem, description: '', labels: [], assignees: [] });
		expect(hit.mock.calls[0][0]).toBe(
			'https://swarm.example/worker/delivery/pm/find-item-by-marker',
		);
		expect(JSON.parse(hit.mock.calls[0][1].body)).toEqual({
			projectId: PROJECT_ID,
			marker: '<!-- swarm-split-child:run-1:0 -->',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});

		// A miss is the ordinary "this delivery has not created that child yet" answer.
		const miss = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { item: null }));
		await expect(
			writeOnly(miss).findWorkItemByDescriptionMarker('<!-- swarm-split-child:run-1:0 -->'),
		).resolves.toBeUndefined();
	});

	it('maps a null card back to undefined, the shape the interface returns', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { item: null }));
		await expect(
			writeOnly(fetchImpl).findWorkItemByUrlSuffix('/issues/999'),
		).resolves.toBeUndefined();
	});

	it("serves Planning's replay guard as a narrow read, mapping a miss back to undefined", async () => {
		// This is the load-bearing one (issue #536): a replayed Planning delivery finds
		// its own plan comment by marker and skips the split entirely, so refusing it
		// would have a retry create a second set of sibling cards.
		const hit = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { commentId: 'IC_kw77' }));
		await expect(
			writeOnly(hit).findComment('PVTI_item1', 'swarm-planning-delivery:run-1'),
		).resolves.toBe('IC_kw77');
		expect(hit.mock.calls[0][0]).toBe('https://swarm.example/worker/delivery/pm/find-comment');
		expect(JSON.parse(hit.mock.calls[0][1].body)).toEqual({
			projectId: PROJECT_ID,
			itemId: 'PVTI_item1',
			marker: 'swarm-planning-delivery:run-1',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});

		const miss = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { commentId: null }));
		await expect(writeOnly(miss).findComment('PVTI_item1', 'marker')).resolves.toBeUndefined();
	});

	it("creates a split's sibling card over the transport and hydrates the narrow frame", async () => {
		const wireItem = {
			id: 'ITEM_61',
			title: 'Phase 2 of 3 — extract the reader',
			url: 'https://github.com/SmartTechBrewery/swarm/issues/61',
		};
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { item: wireItem }));

		await expect(
			writeOnly(fetchImpl).createWorkItem({
				title: wireItem.title,
				description: 'child body',
				status: 'backlog',
				labels: ['swarm', 'swarm:split-child'],
			}),
		).resolves.toEqual({ ...wireItem, description: '', labels: [], assignees: [] });
		expect(fetchImpl.mock.calls[0][0]).toBe('https://swarm.example/worker/delivery/pm/create-item');
		// A canonical status key and label *names* cross the wire — never a board
		// option id or a provider label object (RULES.md §2).
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
			projectId: PROJECT_ID,
			title: wireItem.title,
			description: 'child body',
			status: 'backlog',
			labels: ['swarm', 'swarm:split-child'],
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	it('omits the labels key entirely when a creation names none', async () => {
		const fetchImpl = vi
			.fn<FetchLike>()
			.mockResolvedValue(jsonResponse(200, { item: { id: 'i', title: 't', url: 'u' } }));
		await writeOnly(fetchImpl).createWorkItem({ title: 't', description: 'd', status: 'planning' });
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty('labels');
	});

	it('sends only the patch fields a caller actually set, so an omitted field stays unchanged', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, {}));
		const provider = writeOnly(fetchImpl);

		await provider.updateWorkItem('PVTI_item1', { title: 'Phase 1 of 3 — the smaller task' });
		expect(fetchImpl.mock.calls[0][0]).toBe('https://swarm.example/worker/delivery/pm/update-item');
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
			projectId: PROJECT_ID,
			itemId: 'PVTI_item1',
			title: 'Phase 1 of 3 — the smaller task',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});

		// An empty description is a legitimate re-scope, so it must be *sent*, not
		// treated as "leave it alone".
		await provider.updateWorkItem('PVTI_item1', { description: '' });
		expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
			projectId: PROJECT_ID,
			itemId: 'PVTI_item1',
			description: '',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	it('applies a label and records a blocked-by edge over the transport', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, {}));
		const provider = writeOnly(fetchImpl);

		await provider.addLabel('PVTI_item1', 'planned');
		await provider.addBlockedBy('PVTI_child', 'PVTI_item1');

		expect(fetchImpl.mock.calls[0][0]).toBe('https://swarm.example/worker/delivery/pm/label');
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
			projectId: PROJECT_ID,
			itemId: 'PVTI_item1',
			name: 'planned',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
		expect(fetchImpl.mock.calls[1][0]).toBe('https://swarm.example/worker/delivery/pm/blocked-by');
		expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
			projectId: PROJECT_ID,
			itemId: 'PVTI_child',
			blockerId: 'PVTI_item1',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	it('throws on a refused Planning write, so the phase’s own failure handling applies', async () => {
		// `addLabel` on completion is a hard step (issue #384) and each per-child write
		// is best-effort — both behave correctly only if a refusal throws rather than
		// resolving silently.
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(403, { reason: 'nope' }));
		await expect(writeOnly(fetchImpl).addLabel('PVTI_item1', 'planned')).rejects.toThrow(/403/);
	});

	it('exposes no discovery capability', () => {
		expect(writeOnly().discover).toBeUndefined();
	});
});
