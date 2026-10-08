import { describe, expect, it, vi } from 'vitest';

import type { FetchLike } from '@/transport/delivery-client.js';
import { createTransportFollowUpReviewScheduler } from '@/transport/follow-up-review-delivery.js';
import { TRANSPORT_PROTOCOL_VERSION } from '@/transport/protocol.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const CONTROL_PLANE = 'https://swarm.example';
const CREDENTIAL = 'raw-worker-credential-secret';
const PROJECT_ID = 'swarm';

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function scheduler(fetchImpl: FetchLike) {
	return createTransportFollowUpReviewScheduler({
		controlPlaneUrl: CONTROL_PLANE,
		workerCredential: CREDENTIAL,
		projectId: PROJECT_ID,
		fetchImpl,
	});
}

const INPUT = {
	// The run's repository — deliberately not the project's default entry (#1055).
	project: createMockProjectConfig({ repo: 'SmartTechBrewery/swarm-mobile' }),
	prNumber: '42',
	prBranch: 'issue-21',
	headSha: 'newsha',
};

describe('createTransportFollowUpReviewScheduler', () => {
	it('POSTs the PR coordinates to the follow-up route under the worker’s own credential', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, {}));

		await scheduler(fetchImpl)(INPUT);

		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://swarm.example/worker/delivery/follow-up-review');
		expect(init.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
		// Only the project's repository is sent: the server resolves the project from
		// the authenticated enrollment, so a worker can't schedule into another
		// project, and checks the repository against that project's list (#1055).
		expect(JSON.parse(init.body)).toEqual({
			projectId: PROJECT_ID,
			repository: 'SmartTechBrewery/swarm-mobile',
			prNumber: '42',
			prBranch: 'issue-21',
			headSha: 'newsha',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	it('throws on a refused response, so the phase defers and the retry re-schedules', async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(503, {}));
		await expect(scheduler(fetchImpl)(INPUT)).rejects.toThrow(/503/);
	});
});
