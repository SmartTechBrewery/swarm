/**
 * Control-plane delivery of an abandoned-worktree sweep request to the machine it
 * names (issue #955) — a copy of `./worker-update-dispatch.ts`, and the same bridge
 * for the same reason: `workers.requestWorktreeSweep` runs in the API server, only
 * the *router* holds worker sockets, so the mutation records the request on the
 * `workers` row and publishes the worker id (`../queue/worker-sweeps.ts`) and this
 * module turns that notification into a push.
 *
 * The frame is built **from the row and the machine's own enrollments**, never from
 * the notification's payload — the channel carries a worker id and nothing else — so
 * a message that arrives late, twice, or after an enrollment was revoked cannot ask
 * a machine to sweep a project it is no longer offered to. Which projects those are
 * is resolved here rather than at request time for the same reason: the push may
 * happen days after the request, when the machine finally reconnects.
 *
 * Best-effort, exactly as the notification it rides is: a worker that is not
 * connected here is skipped, and the request stays pending until the machine
 * reconnects and {@link resendPendingWorktreeSweepToWorker} states it again from the
 * socket-open side. Nothing is armed, timed, or settled on a missed push — an
 * unanswered sweep leaves the machine working exactly as it was, since a sweep
 * disturbs no in-flight run.
 */

import { PROJECT_DEFAULTS } from '../config/schema.js';
import { findProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import { listEnrollmentsForWorker } from '../db/repositories/workerEnrollmentsRepository.js';
import { getWorker } from '../identity/worker-service.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
	closeWorktreeSweepRedis,
	subscribeToWorktreeSweepRequests,
} from '../queue/worker-sweeps.js';
import type { WorktreeSweepProject } from '../transport/protocol.js';
import { sendToWorker } from './worker-connections.js';

/**
 * The projects `workerId` may be asked to sweep: one entry per **approved**
 * enrollment whose project still resolves, carrying that project's own relative
 * `worktreeRoot` and abandoned-age threshold.
 *
 * Approval (`status === 'active'`) is the gate rather than `isRoutable`, which the
 * dispatch path uses: sharing consent governs whether the project may be given
 * *work* on this machine, and a sweep gives it none — it removes this machine's own
 * long-untouched checkouts, which are most worth removing precisely on a machine
 * whose owner has stopped offering it. A *suspended or pending* enrollment is
 * skipped, because the project never accepted this machine in the first place.
 *
 * A project whose row has since been deleted is skipped with a log line rather than
 * defaulted: nothing here knows what `worktreeRoot` that project used, and guessing
 * one would name a directory on somebody's machine.
 */
async function sweepableProjectsFor(workerId: string): Promise<WorktreeSweepProject[]> {
	const enrollments = await listEnrollmentsForWorker(workerId);
	const entries: WorktreeSweepProject[] = [];
	for (const enrollment of enrollments) {
		if (enrollment.status !== 'active') continue;
		const project = await findProjectByIdFromDb(enrollment.projectId);
		if (!project) {
			logger.warn('worktree sweep: skipping an enrollment whose project no longer exists', {
				workerId,
				projectId: enrollment.projectId,
			});
			continue;
		}
		entries.push({
			projectId: project.id,
			worktreeRoot: project.worktreeRoot,
			abandonedAfterDays:
				project.worktreeRetention?.abandonedAfterDays ?? PROJECT_DEFAULTS.abandonedAfterDays,
		});
	}
	return entries;
}

/**
 * Push the sweep request `workerId`'s row is waiting on, if any, to its live
 * socket. Returns whether a frame was actually sent; `false` covers "no request
 * pending", "already reported", "no approved enrollment to sweep", and "its socket
 * is not here", none of which is an error.
 *
 * The row and the enrollments are re-read on every call rather than cached, which is
 * what makes a re-push safe: the daemon deduplicates on `requestId`, so a machine
 * already sweeping this request ignores the repeat, and a machine that was away gets
 * whatever it is enrolled in *now*.
 */
export async function pushPendingWorktreeSweep(workerId: string): Promise<boolean> {
	const worker = await getWorker(workerId);
	const requestId = worker?.worktreeSweep?.requestId;
	if (!requestId) {
		logger.debug('worktree sweep: no request pending for that worker — nothing to push', {
			workerId,
		});
		return false;
	}

	const projects = await sweepableProjectsFor(workerId);
	if (projects.length === 0) {
		// Logged and left alone rather than pushed an empty frame: the machine has
		// nothing it could sweep, and the request stays on the row so enrolling it
		// somewhere and reconnecting is enough for the sweep to happen.
		logger.info('worktree sweep: the worker has no approved enrollment — nothing to sweep', {
			workerId,
			requestId,
		});
		return false;
	}

	const sent = sendToWorker(workerId, {
		type: 'worktree-sweep',
		requestId,
		// Re-spread into the non-empty tuple the frame declares, which the emptiness
		// check above has just established — the schema states that a frame naming no
		// project asks for nothing, and this is where that is honoured rather than cast
		// away.
		projects: [projects[0], ...projects.slice(1)],
	});
	if (!sent) {
		// Not a failure worth escalating: the request is durable on the row, and the
		// socket-open hook below states it again the moment the machine is back.
		logger.info('worktree sweep: the worker is not connected here — leaving the request pending', {
			workerId,
			requestId,
			projects: projects.length,
		});
		return false;
	}
	logger.info('worktree sweep: pushed the sweep request to the worker', {
		workerId,
		requestId,
		projects: projects.length,
	});
	return true;
}

/**
 * Hand a reconnected worker the sweep request it missed while its socket was down.
 *
 * The case this exists for is the ordinary one rather than an edge — and more so
 * than for a self-update, since phase 3 will ask on a schedule nobody is watching:
 * a machine that happens to be offline when the sweep is requested would otherwise
 * never be asked again, the notification having fired once.
 *
 * Fire-and-forget: it returns `void` so the transport's connection hooks stay
 * synchronous (`./worker-transport.ts`), and every failure is caught and logged so
 * a socket that just opened never fails on it.
 */
export function resendPendingWorktreeSweepToWorker(workerId: string): void {
	void pushPendingWorktreeSweep(workerId).catch((err) => {
		logger.warn('worktree sweep: could not push a pending request to a reconnected worker', {
			workerId,
			error: describeError(err),
		});
	});
}

/**
 * Subscribe to sweep requests and push each to the worker it names. Started with
 * the router process and closed with it (`./index.ts`), so the subscription exists
 * exactly while this process is the side holding worker sockets.
 *
 * Closing drops the shared client as well as the subscriber, mirroring
 * `subscribeWorkerUpdateDispatch`: the subscriber is a duplicate of that client, so
 * quitting only the duplicate would leave the router hanging on an open Redis
 * socket.
 */
export function subscribeWorktreeSweepDispatch(): { close: () => Promise<void> } {
	const subscription = subscribeToWorktreeSweepRequests((workerId) => {
		void pushPendingWorktreeSweep(workerId).catch((err) => {
			logger.warn('worktree sweep: could not push a requested sweep', {
				workerId,
				error: describeError(err),
			});
		});
	});
	return {
		close: async () => {
			await subscription.close();
			await closeWorktreeSweepRedis();
		},
	};
}
