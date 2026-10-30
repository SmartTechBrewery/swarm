/**
 * The router's route composition — every route the control plane's router serves,
 * on one Hono app, with nothing bound and no process side effects.
 *
 * Two entrypoints serve it: the router itself (`./index.ts`) and the all-in-one
 * control plane (`src/serve/index.ts`, issue #1148), which mounts the API server's
 * app onto this one. Keeping the composition here rather than in each entrypoint is
 * what stops a route added to the router later from silently going missing in
 * all-in-one mode — which a remote worker would notice before anybody else did.
 */

import { createNodeWebSocket, type NodeWebSocket } from '@hono/node-ws';
import type { Hono } from 'hono';

import { registerOperatorApi } from './operator-api.js';
import { registerOperatorSession } from './operator-session.js';
import { createWebhookApp } from './webhook-receiver.js';
import { registerWorkerDelivery } from './worker-delivery.js';
import { registerWorkerTransport } from './worker-transport.js';

/** The router's app plus the hook that upgrades the server `serve` creates for it. */
export interface RouterApp {
	app: Hono;
	injectWebSocket: NodeWebSocket['injectWebSocket'];
}

/** Build the router's Hono app with the webhook, worker and operator routes mounted. */
export function createRouterApp(): RouterApp {
	const app = createWebhookApp();
	// The Cloudflare-tunnel-fronted router also hosts the authenticated
	// worker-transport endpoint (ADR-003 §1). `createNodeWebSocket` must bind the
	// same `app` whose `injectWebSocket` upgrades the server created by `serve`.
	const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
	registerWorkerTransport(app, upgradeWebSocket);
	// The router also hosts the server-side SCM metadata delivery API (ADR-004 §2):
	// a federated worker POSTs review/comment content here and the router performs
	// the GitHub write under the per-project reviewer PAT, which never leaves it.
	registerWorkerDelivery(app);
	// …and the operator session API (issue #798): `swarm login` authenticates a human
	// here because this is the process `SWARM_CONTROL_PLANE_URL` points at, and the
	// only one an operator off the control-plane host can reach.
	registerOperatorSession(app);
	// …and the operator API that token buys (issue #799): the `swarm workers`
	// operations at `/operator/trpc/*`, a strict subset of the dashboard's router —
	// the `workers` namespace alone, since this process is the internet-exposed one.
	registerOperatorApi(app);
	return { app, injectWebSocket };
}
