/**
 * Router entry point — the control plane's process boundary.
 *
 * All the request logic lives in `webhook-receiver.ts` and
 * `worker-transport.ts` (both testable without a live server); this module is
 * just the process boundary: build the app (the route composition lives in
 * `./app.ts`, shared with the all-in-one control plane in `src/serve/index.ts`),
 * bind the port, inject the WebSocket upgrade, and shut down cleanly. Verified
 * webhook events are enqueued onto BullMQ at the `enqueue.ts` seam (producer in
 * `queue/producer.ts`); the worker transport keeps the `worker_sessions`
 * liveness signal fresh over the wire (ADR-003 §1).
 *
 * The router also hosts the **control-plane dispatch consumer** (`./dispatcher.ts`,
 * ADR-003 §2, issue #407): it dequeues BullMQ wake-ups, runs the ADR-001
 * eligibility gate, and pushes a `TaskAssignment` to the selected connected worker
 * — which executes the phase and reports back over the same worker transport.
 * Unconditionally since issue #553 deleted the in-process alternative, so this
 * process is the queue's only consumer.
 */

import { serve } from '@hono/node-server';

import { runMigrations } from '../db/migrate.js';
import { describeError } from '../lib/errors.js';
import { configureLogger, logger } from '../lib/logger.js';
import { closeQueue } from '../queue/producer.js';
import { createRouterApp, warnWhenOperatorTokenUnset } from './app.js';
import type { DispatchConsumerHandle } from './dispatcher.js';
import { startRolloutAdvanceTicker } from './worker-rollout-advance.js';
import { subscribeWorktreeSweepDispatch } from './worktree-sweep-dispatch.js';

// Tag every line this process emits so router and worker logs stay
// distinguishable in a shared stream (ai/ARCHITECTURE.md "Observability").
configureLogger({ component: 'router' });

const port = Number(process.env.PORT ?? 3000);

const { app, injectWebSocket } = createRouterApp();
warnWhenOperatorTokenUnset();
const server = serve({ fetch: app.fetch, port }, () => {
	logger.debug('swarm-router: listening', { port });
});
injectWebSocket(server);

// The cross-process bridge for the abandoned-worktree sweep (issue #955): this
// process is the one holding worker sockets, so the API server records the request
// and publishes it and the push happens here. Subscribed beside the transport rather
// than inside the dispatch consumer, because a sweep concerns the *machine* rather
// than any dispatch, and only this process can push the frame to it.
//
// Operator-requested worker self-updates used to be delivered by a second such
// bridge. Since issue #972 an update is a durable queued unit like every other piece
// of work, so its push is driven by the dispatch consumer below — which runs in this
// same process — and there is nothing to subscribe here.
const worktreeSweeps = subscribeWorktreeSweepDispatch();

// Keep a staged fleet update moving with nobody watching (issue #941). The report
// route and the socket-open hook cover every move a machine announces; this timer
// covers the two it cannot — a machine that applied and never came back, and a wave
// whose members were still mid-phase when they were drained. Started here for the
// sweep bridge's reason: this is the process that holds worker sockets and already
// runs migrations, so a control-plane timer belongs here. Ahead
// of those migrations is safe — the first sweep is a minute away, by which time they
// have either run or this process has exited over them.
const rolloutAdvance = startRolloutAdvanceTicker();

// Control-plane dispatch (ADR-003 §2): host the BullMQ consumer + eligibility
// gate here and push assignments to connected workers. There is no alternative
// consumer any more (issue #553), so this is unconditional.
const dispatchShutdown = new AbortController();
let dispatchConsumer: DispatchConsumerHandle | undefined;
try {
	// Bring the schema up to date before serving any dispatch: the control plane
	// owns the run-row lifecycle and durable dispatch state, so it must never act
	// against an older DB.
	await runMigrations();
	// Loaded dynamically so the dispatcher's pipeline import tree is pulled in
	// *after* `configureLogger` has tagged this process's output and the port is
	// bound — a static import would hoist it above both.
	const { startControlPlaneDispatch } = await import('./dispatcher.js');
	dispatchConsumer = await startControlPlaneDispatch({ shutdownSignal: dispatchShutdown.signal });
} catch (err) {
	logger.error('Failed to start the control-plane dispatch consumer — refusing to start', {
		error: describeError(err),
	});
	process.exit(1);
}

// Docker sends SIGTERM on `compose down`/`stop`; close the listener so the
// container stops promptly instead of being killed after the grace period.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		if (stopping) return;
		stopping = true;
		// Abort any in-flight assignment wait, close the dispatch consumer, stop
		// accepting requests, then drain the BullMQ producer so the process exits
		// instead of hanging on an open Redis socket.
		dispatchShutdown.abort();
		// Stop the rollout tick first, and synchronously: it is a bare timer with
		// nothing to drain, and a sweep started during shutdown would only open a
		// transaction against a database this process is about to stop using.
		rolloutAdvance.close();
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
