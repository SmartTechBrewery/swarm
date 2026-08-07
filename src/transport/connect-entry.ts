/**
 * `swarm worker connect` entrypoint — runs the worker-side transport client
 * (`./worker-client.ts`) as a long-lived process (ADR-003 §1, Phase 2 of issue
 * #391). Run it via `npm run dev:worker:connect`.
 *
 * This is the **remote** worker mode: unlike the in-process host worker
 * (`../worker/index.ts`), which holds `DATABASE_URL`/`REDIS_URL` and pulls jobs off
 * BullMQ, this process holds **only** `SWARM_WORKER_CREDENTIAL`,
 * `SWARM_CONTROL_PLANE_URL`, the operator's own `SWARM_OPERATOR_GH_TOKEN`, and
 * its host-local checkout path (`SWARM_WORKER_REPO_ROOT`, defaulting to cwd). It
 * connects to the control plane over the network (through the Cloudflare tunnel),
 * declares the CLIs it can run, and heartbeats to keep its `worker_sessions` lease
 * live so the eligibility gate sees it as connected. On each pushed
 * `TaskAssignment` it runs the phase **DB-free** (`./assignment-execution.ts`):
 * the project config comes from the assignment's non-secret slice, source-carrying
 * delivery uses the operator token through the registered SCM provider
 * (`SCMProvider.operatorDeliveryProvider`), the reviewer/PM metadata writes go up to the
 * control plane's delivery API (`./delivery-client.ts`) so those credentials stay
 * server-side, and results stream back over the transport back-channel. **Every
 * phase runs this way** — `respond-to-review` since issue #418 gave it the
 * `pm/find-item` card lookup and `follow-up-review` enqueue seams, and `planning`
 * since issue #536 routed its whole board surface through five more PM delivery
 * routes. The supported-phase gate in `runAssignmentDbFree` stays as the backstop
 * even though it now excludes nothing. It never opens a database or queue
 * connection.
 */

import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

// Register every integration, so the DB-free executor can resolve this project's
// SCM provider from the registry instead of naming one (ai/RULES.md §2) — the same
// side-effect import `../router/webhook-receiver.ts` and `../api/router.ts` do.
// Safe on a DB-free worker: nothing in that module graph opens a Postgres or Redis
// connection at load (`getDb()` is lazy, `src/db/client.ts`), so this process still
// connects to neither.
import '../integrations/entrypoint.js';
import { requireEnv, resolveOperatorGitHubToken, resolveWorkerRepoRoot } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { configureLogger, logger } from '../lib/logger.js';
import { runAssignmentDbFree, SUPPORTED_DB_FREE_PHASES } from './assignment-execution.js';
import { discoverAvailableClis, parseDeclaredClisOverride } from './cli-discovery.js';
import { connectWorkerTransport } from './worker-client.js';

// Tag every line this process emits so it stays distinguishable from the router
// and the in-process worker in a shared log stream (ai/ARCHITECTURE.md
// "Observability").
configureLogger({ component: 'worker-transport' });

/** The daemon version reported at handshake — diagnostic only. */
function resolveDaemonVersion(): string {
	if (process.env.npm_package_version) return process.env.npm_package_version;
	try {
		const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
		return pkg.version ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
}

async function main(): Promise<void> {
	const credential = requireEnv('SWARM_WORKER_CREDENTIAL').trim();
	const controlPlaneUrl = requireEnv('SWARM_CONTROL_PLANE_URL').trim();
	// The operator's own GitHub token, held only on this machine — the identity
	// every source-carrying delivery op runs as (ADR-003 §2). Resolved up front so
	// a missing token fails startup rather than mid-assignment.
	const operatorToken = resolveOperatorGitHubToken();
	const repoRoot = resolveWorkerRepoRoot();

	// Declare the CLIs this host can run: an explicit override if set, otherwise
	// probe PATH. An empty set can't handshake (the protocol requires a non-empty
	// capability list), so fail loudly with an actionable message.
	const declaredOverride = parseDeclaredClisOverride(process.env.SWARM_WORKER_TRANSPORT_CLIS);
	const capabilities = declaredOverride ?? (await discoverAvailableClis());
	if (capabilities.length === 0) {
		throw new Error(
			'No agent CLIs found on PATH to declare (looked for claude, agy, codex). Install at least one, or set SWARM_WORKER_TRANSPORT_CLIS explicitly.',
		);
	}

	const host = hostname();
	// One in-flight set shared across every assignment on the session, so a
	// re-pushed dispatch is deduplicated across pushes (matches the same-host
	// dispatch client). The shutdown signal kills any in-flight agent CLI on a
	// graceful stop before the session is released.
	const inFlight = new Set<string>();
	const shutdownSignal = new AbortController();
	// Declare *which phases* this daemon can execute, not just which CLIs it has
	// (issue #467). Since issue #536 that is every phase, but the declaration is not
	// therefore redundant: the control plane cannot infer a daemon's repertoire, and a
	// worker row keeps whatever an older daemon last declared until this one
	// reconnects — so stating it is what widens the row back. The gate in
	// `runAssignmentDbFree` stays as the backstop.
	const supportedPhases = [...SUPPORTED_DB_FREE_PHASES];
	const client = connectWorkerTransport({
		controlPlaneUrl,
		credential,
		capabilities,
		// Only a *discovered* set is worth re-probing when the control plane rejects
		// it (issue #559); an explicit override is the operator's own declaration.
		refreshCapabilities: declaredOverride ? undefined : discoverAvailableClis,
		supportedPhases,
		hostname: host,
		daemonVersion: resolveDaemonVersion(),
		onAssignment: (assignment, sink) => {
			void runAssignmentDbFree(assignment, sink, {
				repoRoot,
				operatorToken,
				// The delivery seam for the metadata writes this worker holds no
				// credential for (a review, a board move/comment): POSTed to the control
				// plane under this worker's own credential (ADR-004 §2).
				controlPlaneUrl,
				workerCredential: credential,
				shutdownSignal: shutdownSignal.signal,
				inFlight,
			});
		},
	});

	logger.info('worker transport client starting', {
		controlPlaneUrl,
		hostname: host,
		capabilities,
		supportedPhases,
		repoRoot,
	});

	// Graceful shutdown: abort any in-flight agent CLI, then release the session
	// via a normal WS close so the control plane frees the lease promptly instead
	// of waiting out the TTL, then exit.
	let shuttingDown = false;
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.on(signal, () => {
			if (shuttingDown) return;
			shuttingDown = true;
			logger.info(`received ${signal} — releasing worker session and exiting`);
			shutdownSignal.abort();
			void client.stop().then(
				() => process.exit(0),
				(err) => {
					logger.error('worker transport shutdown failed', { error: describeError(err) });
					process.exit(1);
				},
			);
		});
	}

	// Resolves on a graceful stop; rejects on a fatal, non-recoverable error.
	await client.done;
	logger.info('worker transport client stopped');
}

main().catch((err) => {
	logger.error('worker transport client exited with a fatal error', { error: describeError(err) });
	process.exit(1);
});
