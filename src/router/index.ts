/**
 * Router entry point — the control plane's process boundary.
 *
 * All the request logic lives in `webhook-receiver.ts` and
 * `worker-transport.ts` (both testable without a live server); this module is
 * just the process boundary: build the app, mount the worker-transport routes,
 * bind the port, inject the WebSocket upgrade, and shut down cleanly. Verified
 * webhook events are enqueued onto BullMQ at the `enqueue.ts` seam (producer in
 * `queue/producer.ts`); the worker transport keeps the `worker_sessions`
 * liveness signal fresh over the wire (ADR-003 §1).
 *
 * When `SWARM_DISPATCH_MODE=transport` (ADR-003 §2, issue #407) the router also
 * hosts the **control-plane dispatch consumer** (`./dispatcher.ts`): it dequeues
 * BullMQ wake-ups, runs the ADR-001 eligibility gate, and pushes a
 * `TaskAssignment` to the selected connected worker — which executes the phase
 * and reports back over the same worker transport. In the default `in-process`
 * mode the consumer stays on the host worker (`../worker/index.ts`) and this block
 * is skipped, so the queue is consumed by exactly one side.
 */

import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';

import { runMigrations } from '../db/migrate.js';
import { resolveDispatchMode } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { configureLogger, logger } from '../lib/logger.js';
import { closeQueue } from '../queue/producer.js';
import type { DispatchConsumerHandle } from './dispatcher.js';
import { createWebhookApp } from './webhook-receiver.js';
import { registerWorkerDelivery } from './worker-delivery.js';
import { registerWorkerTransport } from './worker-transport.js';

// Tag every line this process emits so router and worker logs stay
// distinguishable in a shared stream (ai/ARCHITECTURE.md "Observability").
configureLogger({ component: 'router' });

const port = Number(process.env.PORT ?? 3000);

const app = createWebhookApp();
// The Cloudflare-tunnel-fronted router also hosts the authenticated
// worker-transport endpoint (ADR-003 §1). `createNodeWebSocket` must bind the
// same `app` whose `injectWebSocket` upgrades the server created by `serve`.
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
registerWorkerTransport(app, upgradeWebSocket);
// The router also hosts the server-side SCM metadata delivery API (ADR-002 §2):
// a federated worker POSTs review/comment content here and the router performs
// the GitHub write under the per-project reviewer PAT, which never leaves it.
registerWorkerDelivery(app);
const server = serve({ fetch: app.fetch, port }, () => {
	logger.debug('swarm-router: listening', { port });
});
injectWebSocket(server);

// Control-plane dispatch (ADR-003 §2): host the BullMQ consumer + eligibility
// gate here and push assignments to connected workers. Only in `transport` mode;
// the default `in-process` mode leaves the consumer on the host worker.
const dispatchShutdown = new AbortController();
let dispatchConsumer: DispatchConsumerHandle | undefined;
if (resolveDispatchMode() === 'transport') {
	try {
		// Bring the schema up to date before serving any dispatch: in transport mode
		// the control plane owns the run-row lifecycle and durable dispatch state, so
		// it must never act against an older DB (mirrors the host worker's startup).
		await runMigrations();
		// Loaded dynamically so the default `in-process` router never pulls in the
		// dispatcher's pipeline import tree — its startup surface is unchanged.
		const { startControlPlaneDispatch } = await import('./dispatcher.js');
		dispatchConsumer = await startControlPlaneDispatch({ shutdownSignal: dispatchShutdown.signal });
	} catch (err) {
		logger.error('Failed to start the control-plane dispatch consumer — refusing to start', {
			error: describeError(err),
		});
		process.exit(1);
	}
}

// Docker sends SIGTERM on `compose down`/`stop`; close the listener so the
// container stops promptly instead of being killed after the grace period.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		if (stopping) return;
		stopping = true;
		// Abort any in-flight assignment wait, close the dispatch consumer (transport
		// mode), stop accepting requests, then drain the BullMQ producer so the
		// process exits instead of hanging on an open Redis socket.
		dispatchShutdown.abort();
		server.close(() => {
			void (async () => {
				try {
					await dispatchConsumer?.close();
				} catch (err) {
					logger.error('Dispatch consumer close failed', { error: describeError(err) });
				}
				try {
					await closeQueue();
					process.exit(0);
				} catch (err) {
					logger.error('Producer queue close failed', { error: describeError(err) });
					process.exit(1);
				}
			})();
		});
	});
}
