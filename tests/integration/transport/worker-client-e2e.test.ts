import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ALL_TRIGGER_PHASES } from '@/triggers/types.js';

import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { registerWorker } from '../../../src/identity/worker-service.js';
import { getLiveSessionForWorker } from '../../../src/identity/worker-session-service.js';
import { registerWorkerTransport } from '../../../src/router/worker-transport.js';
import {
	connectWorkerTransport,
	type TransportSocket,
} from '../../../src/transport/worker-client.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

// A short-ish heartbeat TTL so a stopped/dropped connection expires the lease
// within the test, but comfortably above the client's ~1s heartbeat-cadence floor
// (`heartbeatCadenceMs`, mirroring the in-process worker) so the live heartbeats
// actually refresh the lease rather than the cadence outrunning the TTL.
const TTL_MS = 3_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `predicate` until it holds or the deadline passes. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await sleep(25);
	}
	throw new Error('waitFor timed out');
}

/** Stand up the real Phase-1 router transport on an ephemeral port. */
async function startTransport() {
	const app = new Hono();
	const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
	registerWorkerTransport(app, upgradeWebSocket);
	const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
		const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s));
	});
	injectWebSocket(server);
	const { port } = server.address() as AddressInfo;
	return {
		httpBase: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('worker transport client (e2e)', () => {
	let transport: Awaited<ReturnType<typeof startTransport>>;
	let credential: string;
	let workerId: string;
	const originalTtl = process.env.SWARM_WORKER_HEARTBEAT_TTL_MS;

	beforeEach(async () => {
		process.env.SWARM_WORKER_HEARTBEAT_TTL_MS = String(TTL_MS);
		await truncateAll();
		await seedProject({ id: 'proj-worker-client', repo: 'jkwiecien/worker-client-repo' });
		const owner = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });
		const registered = await registerWorker({
			ownerUserId: owner.id,
			displayName: 'ada-laptop',
			capabilities: ['claude'],
		});
		credential = registered.credential;
		workerId = registered.worker.id;
		transport = await startTransport();
	});

	afterEach(async () => {
		await transport.close();
		if (originalTtl === undefined) delete process.env.SWARM_WORKER_HEARTBEAT_TTL_MS;
		else process.env.SWARM_WORKER_HEARTBEAT_TTL_MS = originalTtl;
	});

	it('connects with only the credential + URL, keeps the lease live, and releases it on stop', async () => {
		const client = connectWorkerTransport({
			controlPlaneUrl: transport.httpBase,
			credential,
			capabilities: ['claude'],
			supportedPhases: ALL_TRIGGER_PHASES,
			hostname: 'ada-laptop',
			daemonVersion: 'test',
		});

		try {
			// The handshake acquires the lease and the stream keeps it live.
			await waitFor(async () => Boolean(await getLiveSessionForWorker(workerId, TTL_MS)));
			// Heartbeats refresh it past a full TTL — it does not lapse while connected.
			await sleep(TTL_MS + 150);
			expect(await getLiveSessionForWorker(workerId, TTL_MS)).toBeDefined();
		} finally {
			await client.stop();
		}

		// A graceful stop releases the lease, so the worker stops being selectable —
		// the exact liveness signal the eligibility gate consumes.
		await waitFor(async () => !(await getLiveSessionForWorker(workerId, TTL_MS)));
		expect(await getLiveSessionForWorker(workerId, TTL_MS)).toBeUndefined();
	});

	it('reconnects after the socket drops, re-establishing the session with a bumped fencing token', async () => {
		const opened: WebSocket[] = [];
		const client = connectWorkerTransport(
			{
				controlPlaneUrl: transport.httpBase,
				credential,
				capabilities: ['claude'],
				supportedPhases: ALL_TRIGGER_PHASES,
				hostname: 'ada-laptop',
				daemonVersion: 'test',
				backoff: { baseMs: 20, maxMs: 120 },
			},
			{
				createWebSocket: (url, headers) => {
					const socket = new WebSocket(url, { headers });
					opened.push(socket);
					return socket as unknown as TransportSocket;
				},
			},
		);

		try {
			await waitFor(async () => Boolean(await getLiveSessionForWorker(workerId, TTL_MS)));
			const first = await getLiveSessionForWorker(workerId, TTL_MS);
			expect(first).toBeDefined();

			// Drop the live socket out from under the client, as a network blip would.
			opened[0].terminate();

			// The reconnect loop re-handshakes and the session goes live again, this time
			// on a fresh lease (a bumped fencing token — existing acquire semantics).
			await waitFor(
				async () => opened.length >= 2 && Boolean(await getLiveSessionForWorker(workerId, TTL_MS)),
			);
			const second = await getLiveSessionForWorker(workerId, TTL_MS);
			expect(second).toBeDefined();
			expect(second?.fencingToken ?? 0).toBeGreaterThan(first?.fencingToken ?? 0);
		} finally {
			await client.stop();
		}
	});
});
