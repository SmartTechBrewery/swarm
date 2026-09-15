/**
 * The worker daemon — runs the worker-side transport client (`./worker-client.ts`)
 * as a long-lived process (ADR-003 §1, Phase 2 of issue #391). Run it via
 * `npm run dev:worker`, which starts `./connect-entry.ts`: that is the process
 * entrypoint and this is everything it does once a start has been counted. The two
 * are separate modules on purpose — see that file's header — and this one is reached
 * through a **dynamic** import, so nothing here is evaluated until the durable
 * start counter is already on disk.
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
 * `SWARM_CONTROL_PLANE_URL`, and its host-local checkout path
 * (`SWARM_WORKER_REPO_ROOT`, defaulting to cwd) — never `DATABASE_URL`/`REDIS_URL`,
 * even on a host that has them, and, since issue #765, no operator SCM credential
 * either: that identity is stored per `(worker, scmProvider)` on the control plane
 * and arrives on each assignment, so rotating it needs no restart here and
 * `SWARM_OPERATOR_GH_TOKEN` is no longer read by any worker. It connects to
 * the control plane (over the Cloudflare tunnel from a remote machine, over
 * loopback on the control-plane host), declares the CLIs it can run, and
 * heartbeats to keep its `worker_sessions` lease live so the eligibility gate sees
 * it as connected. On each pushed
 * `TaskAssignment` it runs the phase **DB-free** (`./assignment-execution.ts`):
 * the project config comes from the assignment's non-secret slice, source-carrying
 * delivery uses that frame's operator credential through the registered SCM provider
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
 * refuses to start rather than driving git in the same repository as this one, and
 * it registers as a **participant** of the SWARM install root it is loaded from
 * (`../worktree/install-lock.ts`, issue #935) — which, unlike the checkout, several
 * daemons legitimately share, so that record refuses nothing and is read by a
 * self-update on this machine instead. It never opens a database or queue connection.
 *
 * Besides executing phases it reports one background fact about its own machine:
 * its agent CLIs' remaining allowance (`./quota-reporting.ts`, issue #825). No
 * other process can — a snapshot describes this host's installation and logins —
 * and it is best-effort, so a failed probe or report never touches a run.
 *
 * It also answers one thing asked *of* its machine rather than of a dispatch: a
 * pushed request to move the SWARM install root to a build and restart into it
 * (`./worker-update.ts`, issue #933). It acts only if this host opted in
 * (`SWARM_WORKER_SELF_UPDATE`), only once it holds no in-flight phase, only while no
 * *peer* daemon on this machine holds one either (issue #935), and on
 * success takes the same graceful teardown a SIGTERM does before exiting 0 — so
 * launchd `KeepAlive` / systemd `Restart=always` starts it again on the new build,
 * whose identity reaches the control plane through the `build` field above. Every
 * other outcome is reported and the daemon keeps taking work on the build it has.
 *
 * The other half of that is what `./connect-entry.ts` does before this module is even
 * loaded (`./build-verification.ts`, issue #934): an applied update is not trusted
 * until a daemon running it has handshaked once, so every start on an unproved build
 * is counted before anything here is evaluated. The two moments this module still
 * owns are the ones that need a live transport — the first session promotes the
 * build, and a handshake the control plane rejects outright puts the install root
 * back on the last known good build and exits for the supervisor to restart it
 * there. Once a bad build has taken the socket, that is the only channel left.
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
import { resolveOwnBuildIdentity, swarmInstallRoot } from '../lib/build-identity.js';
import { requireEnv, resolveWorkerRepoRoot } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { resolveDeclarableOriginRepoSlug } from '../scm/repo-slug.js';
import {
	acquireCheckoutLock,
	CHECKOUT_LOCK_REFRESH_MS,
	CheckoutHeldError,
	type CheckoutLock,
} from '../worktree/checkout-lock.js';
import { type InstallParticipation, registerInstallParticipant } from '../worktree/install-lock.js';
import {
	handleTaskCancel,
	runAssignmentDbFree,
	SUPPORTED_DB_FREE_PHASES,
} from './assignment-execution.js';
import { createHandshakePromotion, returnAfterFatalHandshake } from './build-verification.js';
import { discoverAvailableClis, parseDeclaredClisOverride } from './cli-discovery.js';
import {
	startWorkerQuotaReporting,
	WORKER_QUOTA_REPORT_INTERVAL_MS,
	type WorkerQuotaReportingHandle,
} from './quota-reporting.js';
import { connectWorkerTransport } from './worker-client.js';
import { createWorkerUpdateHandler, selfUpdateEnabled } from './worker-update.js';
import { createWorktreeSweepHandler } from './worktree-sweep.js';

/**
 * The two host-local records this process leaves on its own machine: the checkout
 * lock (issue #689) and its participation in the SWARM install root it is loaded
 * from (issue #935), with the one timer that keeps both fresh. Module-scoped so every
 * exit path can drop them — a released record is immediately reclaimable, where one
 * left behind waits for the next daemon to find its pid dead.
 */
let heldCheckoutLock: CheckoutLock | undefined;
let installParticipation: InstallParticipation | undefined;
let hostStateRefreshTimer: ReturnType<typeof setInterval> | undefined;

/**
 * The CLI-quota reporter this process runs (issue #825). Module-scoped for the
 * same reason the lock is: every exit path drops it, the fatal-error one included.
 */
let quotaReporting: WorkerQuotaReportingHandle | undefined;

function stopQuotaReporting(): void {
	quotaReporting?.stop();
	quotaReporting = undefined;
}

function releaseHostLocalState(): void {
	if (hostStateRefreshTimer) clearInterval(hostStateRefreshTimer);
	hostStateRefreshTimer = undefined;
	try {
		// Dropped before the checkout lock only because it is the cheaper of the two to
		// lose: an update on this machine reads it to decide whether a peer is mid-phase,
		// and this process no longer is one.
		installParticipation?.release();
	} catch (err) {
		logger.warn('releasing this install root participation failed', {
			error: describeError(err),
		});
	}
	installParticipation = undefined;
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
	const repoRoot = resolveWorkerRepoRoot();
	// Claimed before anything else this daemon does with the checkout, so a second
	// worker on it exits without ever handshaking. Refreshed below, and released on
	// every exit path.
	const checkoutLock = acquireCheckoutLockOrExit(repoRoot);
	heldCheckoutLock = checkoutLock;
	// Say, on this machine, that a daemon is running from this SWARM install root
	// (issue #935). Not a lock and never a reason to refuse a start: several daemons
	// sharing one npm-linked checkout is the control-plane host's ordinary shape. It is
	// what a self-update on this machine reads to refuse before it swaps the code under
	// a peer that is mid-phase, and a write it cannot make is swallowed there rather
	// than raised here — a daemon is worth more than a record under `~/.swarm`.
	installParticipation = registerInstallParticipant(swarmInstallRoot());
	// An unref'd interval: it keeps both records alive but must never be the reason this
	// process stays alive. The cadence is what lets their TTL stay short — a lapsed
	// `refreshedAt` then means a departed daemon rather than a long-running one — and
	// one timer serves both, which is why they share that TTL.
	hostStateRefreshTimer = setInterval(() => {
		installParticipation?.refresh();
		if (checkoutLock.refresh()) return;
		logger.warn('this checkout lock is no longer held by this process', {
			repoRoot,
			lockDir: checkoutLock.lockDir,
		});
	}, CHECKOUT_LOCK_REFRESH_MS);
	hostStateRefreshTimer.unref();
	// Which repository that one checkout actually is, read from its `origin` remote
	// (issue #687) — the fact the control plane cannot otherwise learn, since
	// `repoRoot` is host-local and never travels. Resolved once, because the process
	// holds exactly one checkout for its whole life and re-reading per assignment
	// would only invite the two answers to differ. A checkout with no identifiable
	// `origin` resolves to `undefined` and declares nothing rather than failing startup.
	const repository = await resolveDeclarableOriginRepoSlug(repoRoot);
	// Which SWARM build this daemon is actually running (issue #918) — the commit of
	// the *install root*, which is anchored on this module's own path and is not
	// `repoRoot`: one npm-linked checkout serves daemons whose `cwd` is a different
	// project repository each. Resolved once at startup for the same reason as the
	// repository above, and `undefined` when the install root is not a git checkout.
	const build = await resolveOwnBuildIdentity();
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
	/**
	 * Publish that set's emptiness to the rest of this machine (issue #935). A peer
	 * daemon sharing this SWARM install root reads it before it updates, so a run here
	 * never has its code swapped underneath it. Written at the two moments the set
	 * can change rather than polled, and always derived from the set itself so a
	 * concurrent dispatch cannot clear the flag for the one still running.
	 */
	const publishBusy = (): void => installParticipation?.setBusy(inFlight.size > 0);
	const shutdownSignal = new AbortController();
	// Declared up here rather than beside the signal handlers below, because a
	// self-update restart (issue #933) takes the same teardown and must not race a
	// SIGTERM arriving mid-way through it.
	let shuttingDown = false;
	/**
	 * The graceful teardown both exits share: release the session so the control plane
	 * frees the lease promptly instead of waiting out the TTL, stop reporting this
	 * host's quota, then drop the host-local records — last, so a departing daemon never
	 * hands the checkout to another worker while its own aborted agent may still be
	 * writing there, and at all so an operator (or a supervisor restarting this
	 * process) can re-acquire it immediately.
	 */
	const releaseSessionAndResources = async (): Promise<void> => {
		shuttingDown = true;
		shutdownSignal.abort();
		try {
			await client.stop();
		} finally {
			stopQuotaReporting();
			releaseHostLocalState();
		}
	};
	// Declare *which phases* this daemon can execute, not just which CLIs it has
	// (issue #467). Since issue #536 that is every phase, but the declaration is not
	// therefore redundant: the control plane cannot infer a daemon's repertoire, and a
	// worker row keeps whatever an older daemon last declared until this one
	// reconnects — so stating it is what widens the row back. The gate in
	// `runAssignmentDbFree` stays as the backstop.
	const supportedPhases = [...SUPPORTED_DB_FREE_PHASES];
	// A session is the proof an applied update was waiting for, so the first one this
	// process establishes is what makes the build it is running this machine's last
	// known good one (issue #934). Every reconnect after it is a no-op.
	const promoteBuild = createHandshakePromotion();
	const client = connectWorkerTransport({
		controlPlaneUrl,
		credential,
		capabilities,
		// Only a *discovered* set is worth re-probing when the control plane rejects
		// it (issue #559); an explicit override is the operator's own declaration.
		refreshCapabilities: declaredOverride ? undefined : discoverAvailableClis,
		supportedPhases,
		repository,
		build,
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
				// The delivery seam for the metadata writes this worker holds no
				// credential for (a review, a board move/comment): POSTed to the control
				// plane under this worker's own credential (ADR-004 §2).
				controlPlaneUrl,
				workerCredential: credential,
				shutdownSignal: shutdownSignal.signal,
				inFlight,
				// Both ends of the dispatch: `runAssignmentDbFree` adds to `inFlight` before
				// its first await and removes in a `finally`, so the flag this machine's peers
				// read is accurate from the moment the phase starts to the moment it settles.
			}).finally(publishBusy);
			publishBusy();
		},
		// The only channel a user termination has to this daemon (issue #549): it
		// holds no `REDIS_URL`, so it cannot read the durable cancellation marker the
		// dashboard writes — the control plane pushes the frame instead. The sink is
		// what lets the handler *answer* a cancel it cannot apply (issue #724).
		onCancel: (cancel, sink) => handleTaskCancel(cancel, sink, logger),
		// The one pushed frame that concerns this *machine* rather than a dispatch
		// (issue #933): move the SWARM install root to a build and restart into it. The
		// handler declines outright unless this host opted in, waits until `inFlight` is
		// empty so no run is ever disturbed, and on a successful apply takes the same
		// graceful teardown a SIGTERM does before exiting 0 for the supervisor to
		// restart. Always wired, even with the opt-in off: a machine that will not act
		// still owes the operator the reason.
		onUpdate: createWorkerUpdateHandler({
			controlPlaneUrl,
			workerCredential: credential,
			inFlight,
			shutdownSignal: shutdownSignal.signal,
			shutdown: releaseSessionAndResources,
			// The build resolved above, which is the *startup* commit — and that is the
			// point (issue #973): a peer daemon on this shared install root can move the
			// files under this process at any time, and the only thing that still names
			// the code this process is actually executing is what it read before it
			// connected. Comparing that against the install root is how an update that
			// found the files already moved decides whether it has anything to restart for.
			build,
		}),
		// The second frame about this *machine* rather than a dispatch (issue #955):
		// remove the `task-<id>` checkouts under this host's own repo root that nothing
		// has touched for the project's configured threshold. Wired unconditionally and
		// with no precondition: unlike an update it disturbs no run, because the same
		// `inFlight` set makes a checkout this daemon is using read as leased and be
		// skipped, and it never restarts anything. The sweep also *joins* that set for
		// its duration, so the lease it holds across a removal is not mistaken for an
		// orphan by a dispatch starting here — hence `publishBusy` on both edges, as
		// with an assignment, so the flag this machine's peers read stays derived from
		// the set rather than from the last dispatch alone. A machine therefore reads
		// busy while it sweeps, which is the right answer for what that flag guards: a
		// peer must not swap the install root under a daemon that is mid-removal.
		onWorktreeSweep: createWorktreeSweepHandler({
			repoRoot,
			controlPlaneUrl,
			workerCredential: credential,
			inFlight,
			onInFlightChange: publishBusy,
			shutdownSignal: shutdownSignal.signal,
		}),
		// The handshake is the only place this daemon learns which worker it
		// authenticates as, so it is where the checkout lock stops naming a bare pid:
		// a second daemon's refusal can then name the *worker* holding it (issue #689).
		// The participant record is annotated for the same reason (issue #935): an update
		// refused because this daemon is mid-phase has to name a worker an operator can
		// drain, not a pid they would have to map back themselves.
		onSession: (session) => {
			checkoutLock.annotate(session.workerId);
			installParticipation?.annotate(session.workerId);
			promoteBuild();
		},
	});

	// This host's own CLI allowance, reported to the control plane under this
	// daemon's credential so the row is attributable to the worker it describes
	// (issue #825). Started after the transport rather than before it because the
	// same credential authenticates both, and best-effort either way — nothing here
	// gates the session.
	quotaReporting = startWorkerQuotaReporting({ controlPlaneUrl, workerCredential: credential });

	logger.info('worker transport client starting', {
		controlPlaneUrl,
		hostname: host,
		quotaReportIntervalMs: WORKER_QUOTA_REPORT_INTERVAL_MS,
		capabilities,
		supportedPhases,
		repoRoot,
		// Printed beside `repoRoot` so an operator can see what this daemon declared its
		// checkout to be. Explicitly `null` rather than left undefined when there is no
		// declaration, since the logger drops an undefined field and "nothing declared" is
		// precisely what an operator debugging a later phase's refusal needs to see.
		repository: repository ?? null,
		// Explicitly null for the same reason, and the field an operator reads first when
		// asking whether this daemon carries a fix (issue #918).
		build: build ?? null,
		// Whether this host will act on a pushed update at all (issue #933). Logged at
		// startup because the alternative is discovering it from a `declined` report
		// after an operator has already asked.
		selfUpdate: selfUpdateEnabled(),
	});

	// Graceful shutdown: abort any in-flight agent CLI, then release the session
	// via a normal WS close so the control plane frees the lease promptly instead
	// of waiting out the TTL, then drop the checkout lock and exit.
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.on(signal, () => {
			if (shuttingDown) return;
			logger.info(`received ${signal} — releasing worker session and exiting`);
			void releaseSessionAndResources().then(
				() => process.exit(0),
				(err) => {
					logger.error('worker transport shutdown failed', { error: describeError(err) });
					process.exit(1);
				},
			);
		});
	}

	// Resolves on a graceful stop; rejects on a fatal, non-recoverable error.
	try {
		await client.done;
	} catch (err) {
		// A handshake the control plane rejects outright — its protocol version, its
		// capabilities, its credential — is *this build* saying it cannot serve this
		// control plane. On a build still awaiting proof that is the one failure no
		// restart and no pushed update can fix, so the machine goes back to its last
		// known good build by itself and ends here rather than dying on the new one
		// (issue #934). Anything else is fatal exactly as it was.
		if (await returnAfterFatalHandshake(err, { shutdown: releaseSessionAndResources })) return;
		throw err;
	}
	stopQuotaReporting();
	releaseHostLocalState();
	logger.info('worker transport client stopped');
}

/**
 * Run the daemon. `./connect-entry.ts` awaits this and owns the fatal log line and
 * the exit code; what belongs here is releasing what *this* module holds — the
 * quota reporter, the checkout lock and this machine's participant record are
 * module-scoped, so the entrypoint cannot reach them, and a record left behind waits
 * for the next daemon to find its pid dead.
 */
export async function runWorkerDaemon(): Promise<void> {
	try {
		await main();
	} catch (err) {
		stopQuotaReporting();
		releaseHostLocalState();
		throw err;
	}
}
