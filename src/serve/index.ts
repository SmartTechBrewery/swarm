/**
 * All-in-one control plane entry point (issue #1148) — the router and the API
 * server in one process, on one port.
 *
 * It serves everything both serve today (webhooks, `/worker/*` including the
 * WebSocket upgrade, `/operator/*`, `/auth/*`, `/trpc/*`, the dashboard, one
 * `/health` — composition in `./app.ts`) and runs what both run: the router's
 * dispatch consumer, rollout ticker and worktree-sweep subscription, and the API
 * server's DB-only host maintenance. The two-process layout (`src/router/index.ts`
 * + `src/api/server.ts`) stays the default and is untouched by this module.
 *
 * Three things differ from those two processes, each on purpose:
 *
 * - **Migrations run before the port is bound**, not after as in the router, so
 *   no request and no dispatch is ever served against an older schema.
 * - **The unsafe-on-a-network configurations are refused** before anything
 *   touches Postgres or Redis (`assertServeStartupSafety`, `./settings.ts`).
 * - **The worktree retention sweep is off** unless `SWARM_SERVE_WORKTREE_SWEEP=true`:
 *   it runs `git` against checkouts on *this* host, which a server built for this
 *   mode usually does not have (`src/api/maintenance.ts`).
 *
 * Pure process boundary, like `src/router/index.ts`: never imported.
 */

import { serve } from '@hono/node-server';

import { type HostMaintenanceHandle, startHostMaintenance } from '../api/maintenance.js';
import { runMigrations } from '../db/migrate.js';
import { announceFirstRunSetup } from '../identity/first-run-setup.js';
import { resolveWebhookCallbackBaseUrl } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { configureLogger, logger } from '../lib/logger.js';
import { closeQueue } from '../queue/producer.js';
import { warnWhenOperatorTokenUnset } from '../router/app.js';
import type { DispatchConsumerHandle } from '../router/dispatcher.js';
import { startRolloutAdvanceTicker } from '../router/worker-rollout-advance.js';
import { subscribeWorktreeSweepDispatch } from '../router/worktree-sweep-dispatch.js';
import { createAllInOneApp } from './app.js';
import {
	assertServeStartupSafety,
	isServeWorktreeSweepEnabled,
	resolveServeListen,
	SERVE_ALLOW_INSECURE_ENV,
	type ServeListen,
} from './settings.js';

configureLogger({ component: 'control-plane' });

let listen: ServeListen;
try {
	listen = resolveServeListen();
	const { waived } = assertServeStartupSafety();
	if (waived.length > 0) {
		logger.warn(`Starting with unsafe settings because ${SERVE_ALLOW_INSECURE_ENV}=true`, {
			waived,
		});
	}
} catch (err) {
	logger.error(describeError(err));
	process.exit(1);
}

try {
	await runMigrations();
} catch (err) {
	logger.error('Failed to apply database migrations — refusing to start', {
		error: describeError(err),
	});
	process.exit(1);
}

const { app, injectWebSocket } = createAllInOneApp();
warnWhenOperatorTokenUnset();
const { hostname, port } = listen;
const server = serve({ fetch: app.fetch, port, ...(hostname ? { hostname } : {}) }, () => {
	logger.info('swarm control plane: listening', { hostname: hostname ?? null, port });
});
injectWebSocket(server);
// First-run setup (issue #1150), as in `src/api/server.ts`: this process serves
// `/auth/setup`, so it is the one that must hold the token and log the link.
// Migrations have already run; not awaited, and it never throws.
void announceFirstRunSetup({ baseUrl: resolveWebhookCallbackBaseUrl() });

// The same two control-plane bridges the router runs (see `src/router/index.ts`
// for why each lives beside the worker sockets). The sweep's publisher — the API
// half — is now this process too; the subscriber uses its own Redis connection,
// so the hand-off works unchanged within one process.
const worktreeSweeps = subscribeWorktreeSweepDispatch();
const rolloutAdvance = startRolloutAdvanceTicker();

const dispatchShutdown = new AbortController();
let dispatchConsumer: DispatchConsumerHandle | undefined;
let maintenance: HostMaintenanceHandle | undefined;
try {
	// Loaded dynamically, as in the router, so the dispatcher's pipeline import tree
	// is pulled in after `configureLogger` has tagged this process's output.
	const { startControlPlaneDispatch } = await import('../router/dispatcher.js');
	dispatchConsumer = await startControlPlaneDispatch({ shutdownSignal: dispatchShutdown.signal });
	// The orphan reap and the fleet sweep always; the retention sweep only when asked
	// for. A malformed interval env still throws here, and is fatal.
	maintenance = startHostMaintenance({ worktreeRetentionSweep: isServeWorktreeSweepEnabled() });
} catch (err) {
	logger.error('Failed to start the control plane — refusing to start', {
		error: describeError(err),
	});
	process.exit(1);
}

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		if (stopping) return;
		stopping = true;
		dispatchShutdown.abort();
		rolloutAdvance.close();
		void maintenance?.close();
		server.close(() => {
			void (async () => {
				try {
					await dispatchConsumer?.close();
				} catch (err) {
					logger.error('Dispatch consumer close failed', { error: describeError(err) });
				}
				try {
					await worktreeSweeps.close();
				} catch (err) {
					logger.error('Worktree-sweep subscriber close failed', { error: describeError(err) });
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
