/**
 * Control-plane host maintenance (issue #550) — the stated owner of the chores
 * that have nothing to do with executing a phase: the startup orphaned-`running`
 * reap, the background worktree retention sweep, and, since issue #956, the
 * installation-wide abandoned-worktree sweep that asks every machine in the fleet
 * to clear its own long-untouched checkouts once a week.
 *
 * They used to run only as a side effect of a database-holding host worker's
 * BullMQ startup path, which no longer exists (issue #553 — every worker is the
 * DB-free `src/transport/connect-entry.ts`). They cannot move to the **router**
 * either: it runs in Docker (`docker-compose.yml`) with no repository checkout,
 * which is what the retention sweep prunes. The **API server** is the process that
 * has both — `DATABASE_URL` and the checkout — so it owns them.
 *
 * The fleet sweep added by issue #956 needs no checkout, only a clock and the
 * database, and it lands here for the other half of that rule: this is the stated
 * owner of the control plane's non-phase chores, and it is the *asking* side of the
 * `swarm:worktree-sweep` hand-off, exactly as `workers.requestWorktreeSweep` is —
 * the router is the side that subscribes and pushes.
 *
 * Periodic CLI capability/quota discovery used to be a third chore here and is
 * gone (issue #823): it could only ever describe *this* machine, which is nobody's
 * worker, so the row it wrote was unattributable and was shown to every user as
 * their own. A worker reports its own host's allowance instead.
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
import {
	getLastFleetWorktreeSweepAt,
	recordFleetWorktreeSweepAt,
} from '../db/repositories/appSettingsRepository.js';
import { listAllProjectsFromDb } from '../db/repositories/projectsRepository.js';
import { failOrphanedRunningRuns } from '../db/repositories/runsRepository.js';
import { listAllWorkers } from '../identity/worker-service.js';
import { optionalEnv } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { pruneStaleWorktrees } from '../worktree/retention.js';
import { fanOutWorktreeSweep } from './worktree-sweep-fanout.js';

/** Default worktree retention sweep cadence when `SWARM_WORKTREE_SWEEP_INTERVAL_MS` is unset. */
const DEFAULT_WORKTREE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Default cadence at which a fleet-wide abandoned-worktree sweep falls **due**
 * when `SWARM_WORKTREE_ABANDONED_SWEEP_INTERVAL_MS` is unset — 7 days, the weekly
 * schedule issue #951 asked for.
 */
const DEFAULT_FLEET_SWEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How often due-ness is *checked*, which is deliberately not the cadence itself.
 * The tick costs one settings read when nothing is due, and keeping it hourly is
 * what makes a weekly schedule hold across restarts and what makes "the following
 * week" true for a machine that was offline: the marker decides, the timer only
 * asks.
 */
const FLEET_SWEEP_DUE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface HostMaintenanceOptions {
	/** Worktree sweep cadence; defaults to `SWARM_WORKTREE_SWEEP_INTERVAL_MS`. */
	worktreeSweepIntervalMs?: number;
	/**
	 * How long after the last fleet-wide sweep the next one falls due; defaults to
	 * `SWARM_WORKTREE_ABANDONED_SWEEP_INTERVAL_MS`. A *due* interval, not a timer
	 * period — see {@link FLEET_SWEEP_DUE_CHECK_INTERVAL_MS}.
	 */
	fleetSweepIntervalMs?: number;
	/** Injectable collaborators so a unit test needs no database, git checkout, or agent CLI. */
	failOrphanedRuns?: typeof failOrphanedRunningRuns;
	listProjects?: typeof listAllProjectsFromDb;
	pruneWorktrees?: (project: ProjectConfig) => Promise<unknown>;
	listWorkers?: typeof listAllWorkers;
	fanOutSweep?: typeof fanOutWorktreeSweep;
	readMarker?: typeof getLastFleetWorktreeSweepAt;
	writeMarker?: typeof recordFleetWorktreeSweepAt;
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
 * Resolve the interval after which a fleet-wide abandoned-worktree sweep falls
 * due, validated at API startup exactly as its neighbour above is — a bad value
 * throws rather than silently falling back to a weekly fan-out nobody asked for.
 */
function resolveFleetSweepIntervalMs(): number {
	const raw = optionalEnv(
		'SWARM_WORKTREE_ABANDONED_SWEEP_INTERVAL_MS',
		String(DEFAULT_FLEET_SWEEP_INTERVAL_MS),
	);
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(
			`SWARM_WORKTREE_ABANDONED_SWEEP_INTERVAL_MS must be a positive integer, got '${raw}'`,
		);
	}
	return parsed;
}

/**
 * Start the control-plane host maintenance loop.
 *
 * The startup reap runs once; the retention sweep runs once immediately and then on
 * its own interval; the fleet sweep's due check runs once immediately and then
 * hourly, doing nothing on a tick where no interval has elapsed. Nothing is
 * awaited, so the API server binds its port without waiting on a database
 * round-trip or a filesystem walk.
 */
export function startHostMaintenance(options: HostMaintenanceOptions = {}): HostMaintenanceHandle {
	const sweepIntervalMs = options.worktreeSweepIntervalMs ?? resolveWorktreeSweepIntervalMs();
	const fleetSweepIntervalMs = options.fleetSweepIntervalMs ?? resolveFleetSweepIntervalMs();
	const failOrphanedRuns = options.failOrphanedRuns ?? failOrphanedRunningRuns;
	const listProjects = options.listProjects ?? listAllProjectsFromDb;
	const pruneWorktrees = options.pruneWorktrees ?? ((project) => pruneStaleWorktrees(project));
	const listWorkers = options.listWorkers ?? listAllWorkers;
	const fanOutSweep = options.fanOutSweep ?? fanOutWorktreeSweep;
	const readMarker = options.readMarker ?? getLastFleetWorktreeSweepAt;
	const writeMarker = options.writeMarker ?? recordFleetWorktreeSweepAt;

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
	 * Prune stale `task-<id>` worktrees for every project (see "Worktree lifecycle"
	 * in `ai/ARCHITECTURE.md` for the retention gate this runs). Per-project
	 * failures are logged and stepped over so one broken checkout can't stop the
	 * sweep for the rest. This reaches only *this* host's filesystem; a remote
	 * worker's checkouts are reached by {@link runFleetWorktreeSweepIfDue} below,
	 * which asks each machine to sweep its own rather than reaching for them.
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

	/**
	 * Ask **every machine on the installation** to sweep its own abandoned
	 * `task-<id>` checkouts, but only when a full interval has passed since the last
	 * time the fleet was asked (issue #956).
	 *
	 * This is a second, independent chore beside `runWorktreeSweep` above, not a
	 * widening of it. That one is a *rank* over this host's own filesystem
	 * (`maxWorktrees`, keeping a dirty or unpushed checkout forever); this one puts
	 * the host's clock in front of the per-machine request issue #955 built, so every
	 * machine — including the ones whose checkouts this process cannot even see —
	 * clears its own long-untouched work without an operator asking.
	 *
	 * **The marker is what makes the cadence real, not the timer.** Due-ness is
	 * `now - last >= fleetSweepIntervalMs` against a durable instant in `app_settings`,
	 * so an API server restarted daily fans out weekly rather than daily; the tick
	 * that calls this is hourly and cheap. A machine that was offline when the signal
	 * went out is not skipped forever either — phase 2's request is durable on its row
	 * and re-stated on its next connection, and failing even that it is asked again
	 * the following week.
	 *
	 * No marker at all means due, which is what makes a fresh installation (and an
	 * existing one the first time this ships) sweep once and then settle into the
	 * cadence.
	 *
	 * The whole body is in a `try`, like every other chore here: a failure must never
	 * stop the API server, and the fan-out itself already refuses to let one machine's
	 * failure cost the rest of the fleet its sweep. What the marker records is that
	 * the fleet **was asked** — so a fan-out that asked nobody leaves it where it was
	 * and the next hourly tick tries again, exactly as one that threw does.
	 */
	async function runFleetWorktreeSweepIfDue(): Promise<void> {
		try {
			const lastSweptAt = await readMarker();
			const now = Date.now();
			if (lastSweptAt && now - lastSweptAt.getTime() < fleetSweepIntervalMs) return;

			const workers = await listWorkers();
			const entries = await fanOutSweep(workers);
			// The marker says "the fleet was asked", not "the chore ran", so a fan-out
			// that asked nobody must not advance it. A fan-out that threw outright is
			// already retried on the next tick because the write below never runs; this
			// is the same rule for the case the fan-out swallows by design — it logs each
			// machine it could not ask and returns normally, so a database hiccup that hit
			// every per-machine write returns an empty report with nothing else to signal
			// it. Advancing the marker there would skip the whole fleet for an interval on
			// the strength of a failure. A *genuinely* empty fleet (no machines at all) is
			// not that case and does advance it: there was nothing to ask.
			if (workers.length > 0 && entries.length === 0) {
				logger.warn(
					'Asked no machine to sweep its abandoned worktrees; retrying on the next tick',
					{
						machines: workers.length,
						intervalMs: fleetSweepIntervalMs,
						previousSweepAt: lastSweptAt?.toISOString() ?? null,
					},
				);
				return;
			}
			await writeMarker(new Date(now));
			logger.info('Requested an abandoned-worktree sweep across the installation', {
				machines: workers.length,
				requested: entries.filter((entry) => entry.disposition === 'requested').length,
				queuedOffline: entries.filter((entry) => entry.disposition === 'queued-offline').length,
				alreadyAsked: entries.filter((entry) => entry.disposition === 'already-asked').length,
				intervalMs: fleetSweepIntervalMs,
				previousSweepAt: lastSweptAt?.toISOString() ?? null,
			});
		} catch (err) {
			logger.error('Failed to request an abandoned-worktree sweep across the installation', {
				error: describeError(err),
			});
		}
	}

	void reapOrphanedRuns();
	void runWorktreeSweep();
	void runFleetWorktreeSweepIfDue();

	const sweepInterval = setInterval(() => {
		void runWorktreeSweep();
	}, sweepIntervalMs);
	sweepInterval.unref();

	const fleetSweepInterval = setInterval(() => {
		void runFleetWorktreeSweepIfDue();
	}, FLEET_SWEEP_DUE_CHECK_INTERVAL_MS);
	fleetSweepInterval.unref();

	logger.debug('Control-plane host maintenance started', { sweepIntervalMs, fleetSweepIntervalMs });

	return {
		close: () => {
			clearInterval(sweepInterval);
			clearInterval(fleetSweepInterval);
			return Promise.resolve();
		},
	};
}
