/**
 * The all-in-one control plane's app (issue #1148): every route the router serves
 * and every route the API server serves, on one Hono app, so one port carries the
 * whole control plane and a reverse proxy needs no path rules.
 *
 * **The router is built first and the API is mounted onto it — never the other way
 * round.** Hono runs matching handlers in registration order and a handler that
 * answers short-circuits the rest, which gives three properties this depends on:
 *
 * - the API's SPA catch-all (`get('*')`) cannot swallow a router `GET` — the
 *   provider webhook pings, `/operator/session`, `/health` — because the router's
 *   handler answers first; registered the other way, the dashboard's `index.html`
 *   would answer them all;
 * - there is exactly one `/health`, the router's; the API's is shadowed;
 * - the WebSocket upgrade keeps working: `injectWebSocket` routes the server's
 *   `upgrade` event through the very app `createNodeWebSocket` was given, which is
 *   the router's, so the API has to be mounted onto that instance.
 *
 * The API's CORS middleware still runs ahead of its own routes (a `/trpc/*`
 * preflight is answered as before), and is inert for the CLI and workers, which
 * never pre-flight.
 */

import { createApiApp } from '../api/server.js';
import { createRouterApp, type RouterApp } from '../router/app.js';

export interface AllInOneAppOptions {
	/** Passed to `createApiApp` — tests supply a static root; production passes nothing. */
	api?: Parameters<typeof createApiApp>[0];
}

/** Build the combined router + API app. */
export function createAllInOneApp(options: AllInOneAppOptions = {}): RouterApp {
	const { app, injectWebSocket } = createRouterApp();
	app.route('/', createApiApp(options.api));
	return { app, injectWebSocket };
}
