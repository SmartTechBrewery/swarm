/**
 * Control-plane host maintenance (issue #550) — the stated owner of three chores
 * that have nothing to do with executing a phase: the startup orphaned-`running`
 * reap, periodic CLI capability/quota discovery, and the background worktree
 * retention sweep.
 *
 * They used to run only as a side effect of a database-holding host worker's
 * BullMQ startup path, which no longer exists (issue #553 — every worker is the
 * DB-free `src/transport/connect-entry.ts`). They cannot move to the **router**
 * either: it runs in Docker (`docker-compose.yml`) with no agent CLIs on PATH and
 * no repository checkout, which is exactly what quota discovery probes and what
 * the sweep prunes. The **API server** is the process that has all three —
 * `DATABASE_URL`, the operator's PATH, and the checkout — and it already runs
 * host-local CLI discovery on demand (`quota.refreshQuotas`), so it owns the
 * periodic form too.
 *
 * What stays elsewhere, deliberately: migrations and the dispatch/stale-run
 * reconcilers are the **router**'s (`src/router/index.ts`, `src/router/dispatcher.ts`),
 * which already state that ownership; running a phase is the **worker**'s. See the
 * ownership table in `ai/ARCHITECTURE.md` ("Process responsibilities").
 *
 * Everything here is best-effort per iteration and every timer is `unref`'d, so a
 * failing chore never stops the API server and a pending sweep never holds the
 * process open.
 */

import type { ProjectConfig } from '../config/schema.js';
import { upsertCliQuota } from '../db/repositories/cliQuotasRepository.js';
import { listAllProjectsFromDb } from '../db/repositories/projectsRepository.js';
import { failOrphanedRunningRuns } from '../db/repositories/runsRepository.js';
import { discoverCliQuotas, discoveryHost } from '../harness/quota-discovery.js';
import { optionalEnv } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { pruneStaleWorktrees } from '../worktree/retention.js';

/**
 * How often CLI capability/quota discovery re-probes the host. Coded rather than
 * configurable, moved verbatim from the worker's `HEARTBEAT_INTERVAL_MS`.
 */
const QUOTA_DISCOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Default worktree retention sweep cadence when `SWARM_WORKTREE_SWEEP_INTERVAL_MS` is unset. */
const DEFAULT_WORKTREE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface HostMaintenanceOptions {
	/** Worktree sweep cadence; defaults to `SWARM_WORKTREE_SWEEP_INTERVAL_MS`. */
	worktreeSweepIntervalMs?: number;
	/** Quota discovery cadence; defaults to {@link QUOTA_DISCOVERY_INTERVAL_MS}. */
	quotaDiscoveryIntervalMs?: number;
	/** Injectable collaborators so a unit test needs no database, git checkout, or agent CLI. */
	failOrphanedRuns?: typeof failOrphanedRunningRuns;
	listProjects?: typeof listAllProjectsFromDb;
	pruneWorktrees?: (project: ProjectConfig) => Promise<unknown>;
	discoverQuotas?: typeof discoverCliQuotas;
	persistQuota?: typeof upsertCliQuota;
}

/** A running host-maintenance loop — closed on API server shutdown. */
export interface HostMaintenanceHandle {
	close: () => Promise<void>;
}

/**
 * Resolve the worktree retention sweep cadence, validated at API startup (a bad
 * value throws rather than silently falling back, like every other env parser).
 */
function resolveWorktreeSweepIntervalMs(): number {
	const raw = optionalEnv(
		'SWARM_WORKTREE_SWEEP_INTERVAL_MS',
		String(DEFAULT_WORKTREE_SWEEP_INTERVAL_MS),
	);
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`SWARM_WORKTREE_SWEEP_INTERVAL_MS must be a positive integer, got '${raw}'`);
	}
	return parsed;
}

/**
 * Start the control-plane host maintenance loop.
 *
 * The startup reap runs once; the sweep and quota discovery run once immediately
 * and then on their own interval. Nothing is awaited, so the API server binds its
 * port without waiting on a CLI probe.
 */
export function startHostMaintenance(options: HostMaintenanceOptions = {}): HostMaintenanceHandle {
	const sweepIntervalMs = options.worktreeSweepIntervalMs ?? resolveWorktreeSweepIntervalMs();
	const quotaIntervalMs = options.quotaDiscoveryIntervalMs ?? QUOTA_DISCOVERY_INTERVAL_MS;
	const failOrphanedRuns = options.failOrphanedRuns ?? failOrphanedRunningRuns;
	const listProjects = options.listProjects ?? listAllProjectsFromDb;
	const pruneWorktrees = options.pruneWorktrees ?? ((project) => pruneStaleWorktrees(project));
	const discoverQuotas = options.discoverQuotas ?? discoverCliQuotas;
	const persistQuota = options.persistQuota ?? upsertCliQuota;

	/**
	 * Reconcile zombie runs left `running` by a prior crash or watch restart that
	 * killed the process before it wrote a terminal status — otherwise they show as
	 * "running" in the dashboard forever.
	 *
	 * Scoped to **worker-less** runs (`workerId = null`), which is the control
	 * plane's honest share of the worker's startup reap: that one narrowed to its
	 * own authenticated worker or to worker-less local runs, and this process is no
	 * worker and holds no execution session. A federated run belongs to whichever
	 * host is executing it, and is already owned by the dispatch-lease reconciler
	 * plus `failStaleRunningRuns` (`src/router/dispatcher.ts`) — so the reap is
	 * deliberately **not** widened to other hosts' runs, which a restart of this
	 * process would otherwise kill mid-flight.
	 * Best-effort: a hiccup must not stop the API server from serving requests.
	 */
	async function reapOrphanedRuns(): Promise<void> {
		try {
			const reconciled = await failOrphanedRuns(
				'Control plane restarted while this run was in progress',
				null,
			);
			if (reconciled > 0) {
				logger.debug('Reconciled orphaned running runs at startup', { count: reconciled });
			}
		} catch (err) {
			logger.error('Failed to reconcile orphaned running runs at startup', {
				error: describeError(err),
			});
		}
	}

	/**
	 * Probe this host's agent CLIs and persist their capability/quota snapshots
	 * against it — the snapshot describes one machine's installation, so it is
	 * stored under that machine's name rather than the installation's (issue #703).
	 */
	async function runQuotaDiscovery(cheap: boolean): Promise<void> {
		try {
			const host = discoveryHost();
			logger.debug('Starting CLI capability/quota discovery...', { cheap, host });
			const snapshots = await discoverQuotas(cheap);
			for (const snapshot of snapshots) {
				await persistQuota(host, snapshot.cli, snapshot.status, snapshot);
			}
			logger.debug('CLI capability/quota discovery completed and persisted.', { host });
		} catch (err) {
			logger.error('Failed to run CLI capability/quota discovery', {
				error: describeError(err),
			});
		}
	}

	/**
	 * Prune stale `task-<id>` worktrees for every project (see "Worktree lifecycle"
	 * in `ai/ARCHITECTURE.md` for the retention gate this runs). Per-project
	 * failures are logged and stepped over so one broken checkout can't stop the
	 * sweep for the rest. This reaches only *this* host's filesystem — a remote
	 * worker's checkout has no sweeper, the same known gap as today.
	 */
	async function runWorktreeSweep(): Promise<void> {
		try {
			logger.debug('Starting background worktree retention sweep');
			const projects = await listProjects();
			for (const project of projects) {
				try {
					await pruneWorktrees(project);
				} catch (err) {
					logger.error('Failed to run worktree retention sweep for project', {
						projectId: project.id,
						error: describeError(err),
					});
				}
			}
		} catch (err) {
			logger.error('Failed to list projects for worktree retention sweep', {
				error: describeError(err),
			});
		}
	}

	void reapOrphanedRuns();
	void runQuotaDiscovery(false);
	void runWorktreeSweep();

	const sweepInterval = setInterval(() => {
		void runWorktreeSweep();
	}, sweepIntervalMs);
	sweepInterval.unref();

	const quotaDiscoveryInterval = setInterval(() => {
		void runQuotaDiscovery(true);
	}, quotaIntervalMs);
	quotaDiscoveryInterval.unref();

	logger.debug('Control-plane host maintenance started', {
		sweepIntervalMs,
		quotaDiscoveryIntervalMs: quotaIntervalMs,
	});

	return {
		close: () => {
			clearInterval(sweepInterval);
			clearInterval(quotaDiscoveryInterval);
			return Promise.resolve();
		},
	};
}
