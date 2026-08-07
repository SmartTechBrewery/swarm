/**
 * Worker entry point — the BullMQ consumer side of the router→worker queue
 * (ai/ARCHITECTURE.md "Components"). A long-lived process, not Cascade's
 * one-container-per-job model: the MVP runs one worker on the host (NOT in
 * Docker Compose — it needs the developer's PATH/auth for git and the agent
 * CLIs), pulling jobs off `swarm-jobs` one at a time (env-overridable pool).
 */

// Single canonical integration registration — same entrypoint as the router,
// so a provider can never be registered on one runtime surface but not another.
import '../integrations/entrypoint.js';

import { hostname } from 'node:os';
import { Worker } from 'bullmq';
import { runMigrations } from '../db/migrate.js';
import { upsertCliQuota } from '../db/repositories/cliQuotasRepository.js';
import { listAllProjectsFromDb } from '../db/repositories/projectsRepository.js';
import {
	failOrphanedRunningRuns,
	failStaleRunningRuns,
} from '../db/repositories/runsRepository.js';
import { cancelDispatchAndWake, promoteNextCapacityDispatch } from '../dispatch/dispatcher.js';
import {
	reconcileDispatchesAtStartup,
	reconcileDispatchesPeriodically,
	reconcileSupersededWorkerClaims,
} from '../dispatch/reconciler.js';
import { discoverCliQuotas } from '../harness/quota-discovery.js';
import { declareWorkerSupportedPhases } from '../identity/worker-service.js';
import { optionalEnv, requireEnv, resolveDispatchMode } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { addFileSink, configureLogger, logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';
import { closeRunCancellationRedis, subscribeToRunCancellations } from '../queue/cancellation.js';
import { QUEUE_NAME, SwarmJobSchema } from '../queue/jobs.js';
import { discoverAvailableClis, parseDeclaredClisOverride } from '../transport/cli-discovery.js';
import { createTriggerRegistry, registerBuiltInTriggers } from '../triggers/index.js';
import { ALL_TRIGGER_PHASES } from '../triggers/types.js';
import { pruneStaleWorktrees } from '../worktree/retention.js';
import {
	type JobOutcome,
	processJob,
	reportInterruptedJobToBoard,
	resolveAgentTimeoutMs,
} from './consumer.js';
import {
	acquireWorkerExecutionSession,
	type WorkerExecutionSession,
} from './execution-identity.js';
import { isJobStale, resolveMaxJobAgeMs } from './job-freshness.js';
import { resetProjectSlot } from './project-concurrency.js';
import { abortRun } from './run-cancellation.js';
import { resolveWorkerConcurrency, resolveWorkerLockOptions } from './runtime-options.js';
import { startWorkerTransportDispatch } from './transport-client.js';

// Tag every line this process emits so router and worker logs stay
// distinguishable in a shared stream (ai/ARCHITECTURE.md "Observability").
// This runs after the hoisted imports above (notably the integrations
// entrypoint), so any module that logs at import time would emit an untagged
// line before this call — nothing does today; keep it that way.
configureLogger({ component: 'worker' });

// Tee the worker's logs to a durable file (in addition to stdout) so an
// unattended run leaves a greppable record behind — a terminal scrollback is
// easy to lose, and the worker's runs are long. Defaults to `logs/worker.log`
// under the repo root; override the path (or point it elsewhere) with
// SWARM_LOG_FILE. The file always receives the JSON form (see logger.ts).
addFileSink(optionalEnv('SWARM_LOG_FILE', 'logs/worker.log'));

// How many jobs this worker runs at once. The `--concurrency <n>` launch flag
// wins over the `SWARM_WORKER_CONCURRENCY` env var, which wins over the default
// of 1 (see resolveWorkerConcurrency).
const concurrency = resolveWorkerConcurrency();

const { lockDuration, lockRenewTime } = resolveWorkerLockOptions();

const rawSweepInterval = optionalEnv('SWARM_WORKTREE_SWEEP_INTERVAL_MS', String(60 * 60 * 1000));
const sweepIntervalMs = Number(rawSweepInterval);
if (!Number.isInteger(sweepIntervalMs) || sweepIntervalMs < 1) {
	throw new Error(
		`SWARM_WORKTREE_SWEEP_INTERVAL_MS must be a positive integer, got '${rawSweepInterval}'`,
	);
}

// The default wall-clock timeout every agent run is bounded by (issue #165),
// resolved here too so the stale-run reconciliation below reaps a `running` row
// only once it has outlived any run that could still legitimately be behind it.
// Reading it at startup also validates `SWARM_AGENT_TIMEOUT_MS` (throws on a bad
// value) alongside the other worker knobs, rather than only when the first job
// runs.
const agentTimeoutMs = resolveAgentTimeoutMs();

// A worker can be deliberately offline while Redis keeps accepting webhooks.
// Those old board states are no longer actionable when it comes back, so do
// not let a restart replay work the operator already completed manually.
const maxJobAgeMs = resolveMaxJobAgeMs();

// How often the worker sweeps for stale `running` rows (a phase whose process
// died while the worker kept serving jobs — its finalize never landed). Cheap
// (one bounded UPDATE), so it can run far more often than the hourly worktree
// sweep; default every 5 min.
const rawStaleRunSweepInterval = optionalEnv(
	'SWARM_STALE_RUN_SWEEP_INTERVAL_MS',
	String(5 * 60 * 1000),
);
const staleRunSweepIntervalMs = Number(rawStaleRunSweepInterval);
if (!Number.isInteger(staleRunSweepIntervalMs) || staleRunSweepIntervalMs < 1) {
	throw new Error(
		`SWARM_STALE_RUN_SWEEP_INTERVAL_MS must be a positive integer, got '${rawStaleRunSweepInterval}'`,
	);
}

// Grace added on top of the largest configured timeout before a `running` row is
// judged stale: the harness's SIGTERM→SIGKILL grace plus headroom for a slow
// finalize write, so an in-flight run that is merely finishing up is never reaped.
const STALE_RUN_MARGIN_MS = 10 * 60 * 1000;

const registry = createTriggerRegistry();
registerBuiltInTriggers(registry);

// Bring the DB schema up to date before serving any job. This is required for
// direct/source starts and the opt-in `dev:worker:watch` mode alike; a restarted
// process must never run newer schema-referencing code against an older DB.
// Fatal on failure: crash loudly rather than serve jobs with broken run history.
try {
	await runMigrations();
} catch (err) {
	logger.error('Failed to apply database migrations — refusing to start', {
		error: describeError(err),
	});
	process.exit(1);
}

// Dispatch mode (ADR-003 §2). Default `in-process` falls straight through to the
// BullMQ consumer below — today's behavior, unchanged. `transport` instead runs
// the worker-side transport-dispatch client: this same-host worker connects to
// the control plane, receives pushed TaskAssignment frames, runs each phase
// locally (persona tokens still resolve from the DB), and reports results back
// over the transport back-channel. The top-level `await` on the client's `done`
// suspends the rest of this entry point (the BullMQ setup) for the client's
// lifetime, so the two paths never run at once.
if (resolveDispatchMode() === 'transport') {
	const credential = requireEnv('SWARM_WORKER_CREDENTIAL').trim();
	const controlPlaneUrl = requireEnv('SWARM_CONTROL_PLANE_URL').trim();
	// Declare the CLIs this host can run — an explicit override, else a PATH probe.
	// The control plane routes on this set; an empty one can't handshake.
	const declaredOverride = parseDeclaredClisOverride(process.env.SWARM_WORKER_TRANSPORT_CLIS);
	const capabilities = declaredOverride ?? (await discoverAvailableClis());
	if (capabilities.length === 0) {
		logger.error(
			'No agent CLIs found on PATH to declare (looked for claude, agy, codex) — refusing to start in transport dispatch mode. Install at least one, or set SWARM_WORKER_TRANSPORT_CLIS.',
		);
		process.exit(1);
	}
	const transportShutdown = new AbortController();
	const client = startWorkerTransportDispatch({
		controlPlaneUrl,
		credential,
		capabilities,
		// A discovered set gets a second look if the control plane rejects it; an
		// explicit override does not (issue #559).
		refreshCapabilities: declaredOverride ? undefined : discoverAvailableClis,
		hostname: hostname(),
		daemonVersion: process.env.npm_package_version ?? '0.0.0',
		shutdownSignal: transportShutdown.signal,
	});
	logger.info('swarm-worker started in transport dispatch mode', { controlPlaneUrl, capabilities });

	let stoppingTransport = false;
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.on(signal, () => {
			if (stoppingTransport) return;
			stoppingTransport = true;
			logger.debug(`Received ${signal} — stopping transport dispatch client`);
			// Abort any in-flight agent CLI, then release the session via a normal
			// close so the control plane frees the lease promptly.
			transportShutdown.abort();
			void client.stop().then(
				() => process.exit(0),
				(err) => {
					logger.error('Transport dispatch client shutdown failed', {
						error: describeError(err),
					});
					process.exit(1);
				},
			);
		});
	}

	// Resolves on a graceful stop; rejects on a fatal, non-recoverable handshake
	// error (bad credential, protocol mismatch, capability rejection).
	try {
		await client.done;
		process.exit(0);
	} catch (err) {
		logger.error('Transport dispatch client exited with a fatal error', {
			error: describeError(err),
		});
		process.exit(1);
	}
}

const rawWorkerCredential = optionalEnv('SWARM_WORKER_CREDENTIAL', '').trim();
let executionSession: WorkerExecutionSession | undefined;
if (rawWorkerCredential) {
	try {
		executionSession = await acquireWorkerExecutionSession(rawWorkerCredential);
		logger.info('Authenticated worker execution session acquired', {
			workerId: executionSession.identity.workerId,
			sessionId: executionSession.identity.sessionId,
		});
	} catch (err) {
		logger.error('Failed to acquire configured worker execution session — refusing to start', {
			error: describeError(err),
		});
		process.exit(1);
	}
	// Declare this program's phase repertoire now that the fenced session proves it
	// owns the row (the same ordering the transport handshake uses). This process runs
	// every phase through the full `processJob` switch — it holds `DATABASE_URL`, so
	// `planning`'s board write/split surface is available — and saying so is what keeps
	// a row from carrying the narrower set a previous `dev:worker:connect` run
	// declared, which would otherwise refuse `planning` here forever (issue #467). Only
	// the phases are written; the CLI set stays the operator-registered one.
	//
	// Its own try/catch, outside the acquire above, so a failure here is reported as
	// what it is rather than as a session-acquisition failure. Still fatal: this
	// process cannot serve jobs without the database anyway, and starting with a
	// stale narrow set would silently refuse phases this host can run — the exact
	// failure #467 closes.
	try {
		await declareWorkerSupportedPhases(executionSession.identity.workerId, [...ALL_TRIGGER_PHASES]);
	} catch (err) {
		logger.error('Failed to declare this worker’s runnable phases — refusing to start', {
			workerId: executionSession.identity.workerId,
			error: describeError(err),
		});
		process.exit(1);
	}
} else {
	logger.warn(
		'SWARM_WORKER_CREDENTIAL is unset — this process may serve unfederated projects only',
	);
}

// A newly fenced session supersedes every older claim for the same registered
// worker. Reap those claims immediately rather than waiting for their longer
// agent-timeout dispatch leases; other hosts' claims remain untouched.
if (executionSession) {
	try {
		const reconciled = await reconcileSupersededWorkerClaims(
			executionSession.identity.workerId,
			executionSession.identity.fencingToken,
		);
		if (reconciled > 0) {
			logger.warn('Reconciled claims from a superseded worker session at startup', {
				count: reconciled,
				workerId: executionSession.identity.workerId,
			});
		}
	} catch (err) {
		logger.error('Failed to reconcile superseded worker-session claims at startup', {
			error: describeError(err),
		});
	}
}

// Reconcile zombie runs left `running` by a prior crash or watch restart that
// killed the process before it wrote a terminal status — otherwise they show as
// "running" in the dashboard forever. Startup scopes this cleanup to either the
// authenticated worker or worker-less local runs, so another live host's runs
// are never reaped.
// Best-effort: a hiccup must not stop the worker from serving jobs.
// In-process path only — `transport` mode returns above, and the API server owns
// the worker-less half of this reap there (`src/api/maintenance.ts`, issue #550).
try {
	const reconciled = await failOrphanedRunningRuns(
		'Worker restarted while this run was in progress',
		executionSession?.identity.workerId ?? null,
	);
	if (reconciled > 0) {
		logger.debug('Reconciled orphaned running runs at startup', { count: reconciled });
	}
} catch (err) {
	logger.error('Failed to reconcile orphaned running runs at startup', {
		error: describeError(err),
	});
}

// Reconcile the durable dispatch state machine (issue #284, ADR-002): reclaim
// leases abandoned by a dead process, import legacy Redis pending-continuation
// entries and orphaned deferred runs as durable dispatches, and re-publish any
// wake-up a crash window lost. Runs before the queue workers start so a
// backfilled dispatch can't race its own legacy delayed job.
await reconcileDispatchesAtStartup();

// Aborted on SIGTERM/SIGINT so an in-flight agent run is killed (SIGTERM→SIGKILL
// via `runAgentCli`'s signal option) instead of outliving the stop grace period.
const shutdown = new AbortController();

// In-process path only, and it has no counterpart anywhere else: these Redis slot
// counters serve unfederated in-process execution alone (federated capacity lives
// in durable dispatch claims), so `transport` mode needs no owner for them and
// they retire with this path rather than moving (issue #550).
async function resetProjectSlots(): Promise<void> {
	try {
		const projects = await listAllProjectsFromDb();
		// These Redis slot counters serve only unfederated execution and must be reset
		// after a crash. Federated capacity lives in durable dispatch claims. Pending
		// dispatches remain durable work, so retain them and wake one per project.
		await Promise.all(projects.map((project) => resetProjectSlot(project.id)));
		await Promise.all(
			projects.map((project) =>
				promoteNextCapacityDispatch(
					project.id,
					project.pipeline?.prioritizeContinuations !== false,
				),
			),
		);
	} catch (err) {
		logger.error('Failed to reset project concurrency counters at startup', {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

await resetProjectSlots();

// In-process path only — `transport` mode returns above, where the API server
// runs this instead (`src/api/maintenance.ts`, issue #550).
async function runQuotaDiscovery(cheap = false): Promise<void> {
	try {
		logger.debug('Starting CLI capability/quota discovery...', { cheap });
		const snapshots = await discoverCliQuotas(cheap);
		for (const snapshot of snapshots) {
			await upsertCliQuota(snapshot.cli, snapshot.status, snapshot);
		}
		logger.debug('CLI capability/quota discovery completed and persisted.');
	} catch (err) {
		logger.error('Failed to run CLI capability/quota discovery', {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// Run full discovery once immediately on startup
await runQuotaDiscovery(false);

const worker = new Worker(
	QUEUE_NAME,
	// Job data is untrusted at this boundary (anything could have been pushed to
	// Redis) — validate before acting on it.
	async (job) => {
		if (isJobStale(job.timestamp, maxJobAgeMs)) {
			logger.warn('Discarded stale queued job', {
				jobId: job.id,
				name: job.name,
				ageMs: Date.now() - job.timestamp,
				maxJobAgeMs,
			});
			// A stale wake-up must also settle its durable dispatch, or the
			// reconciler would faithfully re-publish the work the operator already
			// handled while the worker was offline. Cancelling is canonical and
			// board-visible in the queue history (issue #284).
			const parsed = SwarmJobSchema.safeParse(job.data);
			if (parsed.success && parsed.data.dispatchId) {
				await cancelDispatchAndWake(
					parsed.data.dispatchId,
					'Wake-up exceeded the maximum job age while the worker was offline',
				).catch((err) =>
					logger.warn('Failed to cancel stale dispatch', {
						dispatchId: parsed.data.dispatchId,
						error: describeError(err),
					}),
				);
			}
			return { status: 'no-trigger' } as const;
		}
		return await processJob(
			SwarmJobSchema.parse(job.data),
			registry,
			shutdown.signal,
			executionSession?.identity,
		);
	},
	{
		connection: parseRedisUrl(requireEnv('REDIS_URL')),
		concurrency,
		// Wide enough that an event-loop stall under concurrency can't slip a lock
		// renewal past the deadline and get the running phase reclaimed as stalled
		// (see SWARM_WORKER_LOCK_DURATION_MS above).
		lockDuration,
		lockRenewTime,
		// Agent runs aren't idempotent (see processJob's doc comment), so a job
		// interrupted by process death must fail visibly rather than be re-queued
		// by the stalled-job checker and silently re-run on restart. A stall that
		// slips through anyway is surfaced on the board by the `failed` handler
		// below (`reportInterruptedJobToBoard`) rather than vanishing into the log.
		maxStalledCount: 0,
	},
);

let stoppingForLostSession = false;
async function stopForLostWorkerSession(): Promise<void> {
	if (stoppingForLostSession) return;
	stoppingForLostSession = true;
	shutdown.abort();
	try {
		await worker.close();
	} catch (err) {
		logger.error('Worker close after execution-session loss failed', {
			error: describeError(err),
		});
	}
	process.exit(1);
}

const workerSessionHeartbeatInterval = executionSession
	? setInterval(
			() => {
				void executionSession?.heartbeat().then(
					(refreshed) => {
						if (refreshed) return;
						logger.error('Worker execution session was lost — aborting in-flight work', {
							workerId: executionSession?.identity.workerId,
						});
						void stopForLostWorkerSession();
					},
					(err) => {
						logger.error('Worker execution-session heartbeat failed — aborting in-flight work', {
							error: describeError(err),
						});
						void stopForLostWorkerSession();
					},
				);
			},
			Math.max(1_000, Math.floor(executionSession.identity.heartbeatTtlMs / 3)),
		)
	: undefined;
workerSessionHeartbeatInterval?.unref();

worker.on('completed', (job, outcome: JobOutcome) => {
	// A `phase-deferred` outcome needs no action here (issue #284): `processJob`
	// already persisted the derived retry intent on the dispatch record and
	// published its delayed wake-up before returning — the fire-and-forget
	// re-enqueue window this handler used to own no longer exists.
	logger.debug('Job completed', { jobId: job.id, name: job.name, outcome });
});

worker.on('failed', (job, err) => {
	logger.error('Job failed', { jobId: job?.id, name: job?.name, error: err.message });
	// A job reaches `failed` only outside `processJob` (which turns phase failures
	// into completed outcomes, never throws them): a stalled job the queue
	// reclaimed (`maxStalledCount: 0` → terminal, no retry) or the lone
	// unknown-project throw. The phase's own board-reporting never ran, so leave a
	// board-visible trace here. Fire-and-forget with its own error handling so a
	// comment failure can't reject the event handler; it no-ops when there's no
	// resolvable target (e.g. the unknown-project case).
	if (job?.data) {
		void reportInterruptedJobToBoard(job.data, err.message);
	}
});
// Connection-level errors (Redis down, …); BullMQ retries internally, but an
// unhandled 'error' event would crash the process.
worker.on('error', (err) => {
	logger.error('Worker queue error', { error: err.message });
});
worker.on('lockRenewalFailed', (jobIds) => {
	logger.error('Worker failed to renew active job locks', { jobIds });
});

// Subscribe to user-initiated run terminations from the dashboard (issue #166):
// when a cancellation for a run running in this worker arrives, abort its agent
// via the per-run controller registered in `processJob`. A notification for a run
// not currently executing here is a no-op — the durable set (checked at run
// start) covers that case.
const cancellationSubscription = subscribeToRunCancellations((runId) => {
	if (abortRun(runId)) {
		logger.info('Aborting run — user requested termination', { runId });
	}
});

logger.debug('swarm-worker started', { queue: QUEUE_NAME, concurrency });

// In-process path only — `transport` mode returns above, where the API server
// runs this instead (`src/api/maintenance.ts`, issue #550).
async function runWorktreeSweep(): Promise<void> {
	try {
		logger.debug('Starting background worktree retention sweep');
		const projects = await listAllProjectsFromDb();
		for (const project of projects) {
			try {
				await pruneStaleWorktrees(project);
			} catch (err) {
				logger.error('Failed to run worktree retention sweep for project', {
					projectId: project.id,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	} catch (err) {
		logger.error('Failed to list projects for worktree retention sweep', {
			error: describeError(err),
		});
	}
}

// Run once immediately after startup
void runWorktreeSweep();

const sweepInterval = setInterval(() => {
	void runWorktreeSweep();
}, sweepIntervalMs);
sweepInterval.unref();

/**
 * Reconcile stale `running` rows while the worker keeps serving jobs (issue
 * #165) — the running-worker safety net the startup-only `failOrphanedRunningRuns`
 * can't provide. A row still `running` past `max(configured timeout) + grace` is
 * a phase whose process died without finalizing (the exact `dd0ad860-…` symptom:
 * the agent exited but the row stayed `running`), since every live agent is
 * killed at its own timeout — so it is safe to fail without touching a genuinely
 * in-flight run. Best-effort: a hiccup must not stop the worker serving jobs.
 */
async function runStaleRunSweep(): Promise<void> {
	try {
		const reconciled = await failStaleRunningRuns(
			agentTimeoutMs,
			STALE_RUN_MARGIN_MS,
			'Run exceeded its wall-clock timeout without finalizing — reconciled as stale',
		);
		if (reconciled > 0) {
			logger.warn('Reconciled stale running runs while serving jobs', {
				count: reconciled,
			});
		}
	} catch (err) {
		logger.error('Failed to reconcile stale running runs', { error: describeError(err) });
	}
}

const staleRunSweepInterval = setInterval(() => {
	void runStaleRunSweep();
}, staleRunSweepIntervalMs);
staleRunSweepInterval.unref();

/**
 * Periodic dispatch reconciliation (issue #284): reclaim expired dispatch
 * leases, re-publish wake-ups a crash window lost, and nudge capacity-blocked
 * dispatches whose slot-release wake-up went missing. Shares the stale-run
 * sweep's cadence — both are cheap bounded queries.
 */
async function runDispatchReconcile(): Promise<void> {
	try {
		const projects = await listAllProjectsFromDb();
		const prioritize = new Map(
			projects.map((p) => [p.id, p.pipeline?.prioritizeContinuations !== false]),
		);
		await reconcileDispatchesPeriodically((projectId) => prioritize.get(projectId) ?? true);
	} catch (err) {
		logger.error('Failed to run periodic dispatch reconciliation', {
			error: describeError(err),
		});
	}
}

const dispatchReconcileInterval = setInterval(() => {
	void runDispatchReconcile();
}, staleRunSweepIntervalMs);
dispatchReconcileInterval.unref();

const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const quotaDiscoveryInterval = setInterval(() => {
	void runQuotaDiscovery(true);
}, HEARTBEAT_INTERVAL_MS);
quotaDiscoveryInterval.unref();

// On shutdown (Ctrl+C sends SIGINT; a `kill`/supervisor sends SIGTERM), abort
// the in-flight agent run (it completes as `phase-failed`; each phase runs its
// own worktree cleanup in a `finally`), then let worker.close() wait for the
// job to finish before exiting.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		logger.debug(`Received ${signal} — aborting in-flight agent run and closing worker`);
		clearInterval(sweepInterval);
		clearInterval(staleRunSweepInterval);
		clearInterval(dispatchReconcileInterval);
		clearInterval(quotaDiscoveryInterval);
		if (workerSessionHeartbeatInterval) clearInterval(workerSessionHeartbeatInterval);
		shutdown.abort();
		void cancellationSubscription.close();
		void closeRunCancellationRedis();
		void worker.close().then(
			async () => {
				await executionSession?.release().catch((err) =>
					logger.warn('Failed to release worker execution session during shutdown', {
						error: describeError(err),
					}),
				);
				process.exit(0);
			},
			(err) => {
				logger.error('Worker close failed', {
					error: err instanceof Error ? err.message : String(err),
				});
				process.exit(1);
			},
		);
	});
}
