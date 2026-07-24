/**
 * Router entry point — serves the GitHub webhook receiver over HTTP.
 *
 * All the request logic lives in `webhook-receiver.ts` and
 * `worker-transport.ts` (both testable without a live server); this module is
 * just the process boundary: build the app, mount the worker-transport routes,
 * bind the port, inject the WebSocket upgrade, and shut down cleanly. Verified
 * webhook events are enqueued onto BullMQ at the `enqueue.ts` seam (producer in
 * `queue/producer.ts`); the worker transport keeps the `worker_sessions`
 * liveness signal fresh over the wire (ADR-003 §1).
 */

import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';

import { configureLogger, logger } from '../lib/logger.js';
import { closeQueue } from '../queue/producer.js';
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

// Docker sends SIGTERM on `compose down`/`stop`; close the listener so the
// container stops promptly instead of being killed after the grace period.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		// Stop accepting requests, then drain the BullMQ producer connection so the
		// process exits instead of hanging on an open Redis socket.
		server.close(() => {
			void closeQueue().then(
				() => process.exit(0),
				(err) => {
					logger.error('Producer queue close failed', {
						error: err instanceof Error ? err.message : String(err),
					});
					process.exit(1);
				},
			);
		});
	});
}
