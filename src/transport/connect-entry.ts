/**
 * The worker entrypoint — runs the worker-side transport client
 * (`./worker-client.ts`) as a long-lived process (ADR-003 §1, Phase 2 of issue
 * #391). Run it via `npm run dev:worker`.
 *
 * **Every** worker runs this program — there is no second one (issue #553). The
 * control-plane host used to run a database-holding BullMQ executor of its own
 * (the deleted `../worker/index.ts`), so the same role shipped as two programs and
 * only one of them was exercised on a given run. That host now points
 * `SWARM_CONTROL_PLANE_URL` at its own router over loopback
 * (`http://localhost:<ROUTER_PORT>`), so "local" is a network distance rather than
 * a code path, and whatever works here works there.
 *
 * The process holds **only** `SWARM_WORKER_CREDENTIAL`,
 * `SWARM_CONTROL_PLANE_URL`, the operator's own `SWARM_OPERATOR_GH_TOKEN`, and
 * its host-local checkout path (`SWARM_WORKER_REPO_ROOT`, defaulting to cwd) —
 * never `DATABASE_URL`/`REDIS_URL`, even on a host that has them. It connects to
 * the control plane (over the Cloudflare tunnel from a remote machine, over
 * loopback on the control-plane host), declares the CLIs it can run, and
 * heartbeats to keep its `worker_sessions` lease live so the eligibility gate sees
 * it as connected. On each pushed
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
 * even though it now excludes nothing, and the repository this daemon declares at
 * handshake is handed to the same executor so an assignment for a *different*
 * repository is refused before the checkout is touched (issue #688). Before any of
 * that it takes a host-local lock on that checkout (`../worktree/checkout-lock.ts`,
 * issue #689), so a second daemon pointed at the same `SWARM_WORKER_REPO_ROOT`
 * refuses to start rather than driving git in the same repository as this one. It
 * never opens a database or queue connection.
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
import { resolveAgentContainment } from '../harness/containment.js';
import {
	optionalEnv,
	requireEnv,
	resolveOperatorGitHubToken,
	resolveWorkerRepoRoot,
} from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { addFileSink, configureLogger, logger } from '../lib/logger.js';
import { resolveDeclarableOriginRepoSlug } from '../scm/repo-slug.js';
import {
	acquireCheckoutLock,
	CHECKOUT_LOCK_REFRESH_MS,
	CheckoutHeldError,
	type CheckoutLock,
} from '../worktree/checkout-lock.js';
import {
	handleTaskCancel,
	runAssignmentDbFree,
	SUPPORTED_DB_FREE_PHASES,
} from './assignment-execution.js';
import { discoverAvailableClis, parseDeclaredClisOverride } from './cli-discovery.js';
import { connectWorkerTransport } from './worker-client.js';

// Tag every line this process emits so it stays distinguishable from the router
// and the API server in a shared log stream (ai/ARCHITECTURE.md "Observability").
configureLogger({ component: 'worker-transport' });

// Tee the worker's logs to a durable file (in addition to stdout) so an
// unattended run leaves a greppable record behind — a terminal scrollback is easy
// to lose, and the worker's runs are long. Defaults to `logs/worker.log` under the
// repo root; override the path with SWARM_LOG_FILE. The file always receives the
// JSON form (see logger.ts). This moved here with the deleted in-process entry
// point (issue #553): the file sink belongs to whichever process actually runs
// the agents, which is now only this one.
addFileSink(optionalEnv('SWARM_LOG_FILE', 'logs/worker.log'));

/**
 * The checkout lock this process holds (issue #689), with the timer that keeps it
 * fresh. Module-scoped so every exit path can drop it — a released lock is
 * immediately re-acquirable, where a lock left behind waits for the next daemon to
 * find its pid dead.
 */
let heldCheckoutLock: CheckoutLock | undefined;
let checkoutRefreshTimer: ReturnType<typeof setInterval> | undefined;

function releaseCheckoutLock(): void {
	if (checkoutRefreshTimer) clearInterval(checkoutRefreshTimer);
	checkoutRefreshTimer = undefined;
	try {
		heldCheckoutLock?.release();
	} catch (err) {
		// Never let a filesystem hiccup turn a graceful shutdown into a crash: the lock
		// is reclaimable on liveness grounds once this process is gone.
		logger.warn('releasing the checkout lock failed', { error: describeError(err) });
	}
	heldCheckoutLock = undefined;
}

/**
 * Take the host-local lock on this checkout, or refuse to start (issue #689).
 *
 * Two daemons holding two *different* credentials can still be pointed at one
 * `SWARM_WORKER_REPO_ROOT`, and both would then run `git worktree add` against the
 * same main repository and contend on its `index.lock`. The control plane cannot
 * see that — `repoRoot` is host-local and never travels, and two checkouts of one
 * repository are legitimate capacity — so the guard is a filesystem lock and the
 * refusal happens here, before the handshake.
 */
function acquireCheckoutLockOrExit(repoRoot: string): CheckoutLock {
	try {
		return acquireCheckoutLock({ repoRoot });
	} catch (err) {
		if (!(err instanceof CheckoutHeldError)) throw err;
		// Names the holding worker (a pid, until that daemon's own handshake told it
		// which worker it is) so an operator knows which process to stop.
		logger.error('refusing to start — another worker already holds this checkout', {
			repoRoot,
			lockDir: err.lockDir,
			holderWorkerId: err.holder?.workerId ?? null,
			holderPid: err.holder?.pid ?? null,
			reason: err.message,
		});
		process.exit(1);
	}
}

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
	// Claimed before anything else this daemon does with the checkout, so a second
	// worker on it exits without ever handshaking. Refreshed below, and released on
	// every exit path.
	const checkoutLock = acquireCheckoutLockOrExit(repoRoot);
	heldCheckoutLock = checkoutLock;
	// An unref'd interval: it keeps the lock alive but must never be the reason this
	// process stays alive. The cadence is what lets the TTL stay short — a lapsed
	// `refreshedAt` then means a departed daemon rather than a long-running one.
	checkoutRefreshTimer = setInterval(() => {
		if (checkoutLock.refresh()) return;
		logger.warn('this checkout lock is no longer held by this process', {
			repoRoot,
			lockDir: checkoutLock.lockDir,
		});
	}, CHECKOUT_LOCK_REFRESH_MS);
	checkoutRefreshTimer.unref();
	// Which repository that one checkout actually is, read from its `origin` remote
	// (issue #687) — the fact the control plane cannot otherwise learn, since
	// `repoRoot` is host-local and never travels. Resolved once, because the process
	// holds exactly one checkout for its whole life and re-reading per assignment
	// would only invite the two answers to differ. A checkout with no identifiable
	// `origin` resolves to `undefined` and declares nothing rather than failing startup.
	const repository = await resolveDeclarableOriginRepoSlug(repoRoot);
	// Same reason: a typo in SWARM_AGENT_CONTAINMENT should fail this daemon at
	// startup, not once per dispatched phase (issue #614). The resolved value is
	// not held — `runAgentCli` reads it per run — this is validation only, and
	// it also logs which mode this host will actually launch agents under.
	logger.info('agent containment', { mode: resolveAgentContainment() });

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
	// re-pushed dispatch is deduplicated across pushes. The shutdown signal kills
	// any in-flight agent CLI on a graceful stop before the session is released.
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
		repository,
		hostname: host,
		daemonVersion: resolveDaemonVersion(),
		onAssignment: (assignment, sink) => {
			void runAssignmentDbFree(assignment, sink, {
				repoRoot,
				// The same declaration the handshake carries, so the executor can refuse an
				// assignment for a repository this checkout is not before it touches the
				// checkout (issue #688) — passed from the one startup resolution above
				// rather than re-read per assignment.
				checkoutRepository: repository,
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
		// The only channel a user termination has to this daemon (issue #549): it
		// holds no `REDIS_URL`, so it cannot read the durable cancellation marker the
		// dashboard writes — the control plane pushes the frame instead. The sink is
		// what lets the handler *answer* a cancel it cannot apply (issue #724).
		onCancel: (cancel, sink) => handleTaskCancel(cancel, sink, logger),
		// The handshake is the only place this daemon learns which worker it
		// authenticates as, so it is where the checkout lock stops naming a bare pid:
		// a second daemon's refusal can then name the *worker* holding it (issue #689).
		onSession: (session) => {
			checkoutLock.annotate(session.workerId);
		},
	});

	logger.info('worker transport client starting', {
		controlPlaneUrl,
		hostname: host,
		capabilities,
		supportedPhases,
		repoRoot,
		// Printed beside `repoRoot` so an operator can see what this daemon declared its
		// checkout to be. Explicitly `null` rather than left undefined when there is no
		// declaration, since the logger drops an undefined field and "nothing declared" is
		// precisely what an operator debugging a later phase's refusal needs to see.
		repository: repository ?? null,
	});

	// Graceful shutdown: abort any in-flight agent CLI, then release the session
	// via a normal WS close so the control plane frees the lease promptly instead
	// of waiting out the TTL, then drop the checkout lock and exit.
	let shuttingDown = false;
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.on(signal, () => {
			if (shuttingDown) return;
			shuttingDown = true;
			logger.info(`received ${signal} — releasing worker session and exiting`);
			shutdownSignal.abort();
			void client
				.stop()
				.then(
					() => 0,
					(err) => {
						logger.error('worker transport shutdown failed', { error: describeError(err) });
						return 1;
					},
				)
				.then((code) => {
					// The checkout goes last: a departing daemon must not hand it to another
					// worker while its own aborted agent may still be writing there. Releasing
					// it at all is what lets an operator restart immediately rather than wait
					// for the next daemon's liveness check.
					releaseCheckoutLock();
					process.exit(code);
				});
		});
	}

	// Resolves on a graceful stop; rejects on a fatal, non-recoverable error.
	await client.done;
	releaseCheckoutLock();
	logger.info('worker transport client stopped');
}

main().catch((err) => {
	releaseCheckoutLock();
	logger.error('worker transport client exited with a fatal error', { error: describeError(err) });
	process.exit(1);
});
