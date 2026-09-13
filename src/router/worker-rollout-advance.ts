/**
 * Advance a fleet rollout with **nobody watching** (issue #941) — the trigger half
 * of the state machine phase 2 built, and deliberately nothing but triggers.
 *
 * Phase 2 made `swarm workers update --all <ref>` a rollout an operator advances by
 * re-running the command; this module hooks the very same `advanceRollout`
 * (`../api/worker-update-rollout.ts`) onto the events the control plane already
 * sees, so the command is genuinely one operator action rather than one to re-run
 * until the fleet has moved. **Every rule stays over there** — the wave bound, the
 * come-back verdict, the halt and the undrain are phase 2's and are only *triggered*
 * here — so nothing in this file decides anything about a rollout beyond *when* it
 * is advanced.
 *
 * Three triggers, which between them cover every way a rollout can move on:
 *
 * - **A machine's update report** lands on `POST /worker/delivery/update-report`
 *   (`./worker-delivery.ts`). That is the answer step 1 of the advance reads off the
 *   `workers` row, so the report arriving is exactly the moment the answer became
 *   readable.
 * - **A machine's handshake** opens a `/worker/stream` socket (`./worker-transport.ts`).
 *   A reconnect is the event the come-back verdict waits for: by the time the socket
 *   opens the daemon has already acquired its fenced lease and declared the build it
 *   is running, which are the two facts that verdict is reached against.
 * - **A periodic tick**, here, for the two moves no event announces: a machine that
 *   applied and never came back (silence is the verdict, and silence sends nothing),
 *   and a wave whose members were still running a phase at the last advance, since
 *   a machine going idle is not something the control plane is told.
 *
 * Both per-machine triggers are **fire-and-forget and caught**, on exactly the
 * contract `resendPendingWorkerUpdateToWorker` already keeps on the socket-open path
 * (`./worker-update-dispatch.ts`): they return `void`, so a report route and a
 * handshake stay synchronous, and every failure is logged rather than raised — a
 * rollout must never be able to fail a machine's report or refuse its connection.
 *
 * Nothing here serializes the triggers against each other, because the rollout row's
 * own `FOR UPDATE` lock already does (`advanceUnderRolloutLock`): two hooks firing at
 * the same instant take it in turn, and the second decides against the state the
 * first left behind, so a wave cannot be drained or signalled twice. That lock was
 * written for this phase — phase 2 had one caller.
 *
 * It lives in `src/router/` rather than beside the policy it drives, for the reason
 * `./worker-update-dispatch.ts` already gives: this is the process that holds worker
 * sockets and serves the delivery routes, so it is where the events are — and it
 * already runs migrations and hosts the control plane's other timers
 * (`./dispatcher.ts`), so it is where a control-plane timer belongs too.
 */

import { advanceRollout } from '../api/worker-update-rollout.js';
import {
	findInProgressRolloutForOwner,
	listInProgressRollouts,
} from '../db/repositories/workerUpdateRolloutsRepository.js';
import { getWorker } from '../identity/worker-service.js';
import type { WorkerUpdateRollout } from '../identity/worker-update-rollout.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * How often every rollout still in progress is advanced with nobody watching.
 *
 * A minute, because of what the tick is actually *for*. Both per-machine triggers
 * below fire the instant their event happens, so the tick is not how a rollout
 * normally moves — it exists for the two moves no event announces: a machine that
 * applied and never came back, which the advance halts on only once
 * `COME_BACK_WINDOW_MS` (ten minutes) has passed, and a wave whose members were
 * still mid-phase when they were drained, which the advance signals as soon as they
 * go idle. Against a ten-minute window a minute is a rounding error, and against a
 * phase that runs for many minutes it is the shortest wait worth having.
 *
 * Seconds would buy nothing and cost a locked transaction per rollout per tick;
 * longer would add its own latency to every wave whose machines were busy, which is
 * the ordinary case on a fleet that is actually working. Coded rather than
 * configurable, like `COME_BACK_WINDOW_MS` and `MAX_FAILED_STARTS` before it: there
 * is no installation for which another number is right, and one more knob would only
 * be a way to stall a rollout by accident.
 */
export const ROLLOUT_ADVANCE_TICK_MS = 60_000;

/**
 * Advance the rollout the machine `workerId` belongs to, if its operator has one
 * still moving. Returns whether a rollout was advanced; `false` covers "no such
 * machine" and "its operator has no rollout in progress", neither of which is an
 * error — most machines, most of the time, are in neither.
 *
 * The rollout is resolved through the machine's **owner** rather than through the
 * member rows: an owner has at most one `in_progress` rollout (the partial unique
 * index is what decides that) and a machine has exactly one owner, so the owner's
 * live rollout *is* the one this machine is in, found by an indexed lookup instead
 * of a scan over every member row ever written. The one case the two answers differ
 * is a machine enrolled after the rollout started, which is not a member — and
 * advancing on its event is still right, since an advance only ever reads the
 * rollout's own durable state and a spare trigger is a no-op.
 */
export async function advanceRolloutForWorker(workerId: string): Promise<boolean> {
	const worker = await getWorker(workerId);
	if (!worker) return false;
	const rollout = await findInProgressRolloutForOwner(worker.ownerUserId);
	if (!rollout) return false;

	const view = await advanceRollout(rollout.id);
	logger.info('fleet update: advanced a rollout on a worker event', {
		workerId,
		rolloutId: rollout.id,
		target: rollout.target,
		status: view?.rollout.status ?? rollout.status,
	});
	return view !== undefined;
}

/**
 * Advance this machine's rollout, in the background.
 *
 * The fire-and-forget wrapper the event hooks are wired to — `void` out, every
 * failure caught and logged — so neither an update report nor a handshake can be
 * failed by a rollout. A missed advance costs latency and nothing else: the next
 * event, or the tick below, re-decides the whole thing from durable state.
 */
export function advanceWorkerRollout(workerId: string): void {
	void advanceRolloutForWorker(workerId).catch((err) => {
		logger.warn('fleet update: could not advance the rollout this worker belongs to', {
			workerId,
			error: describeError(err),
		});
	});
}

/**
 * One sweep: advance every rollout that is still in progress.
 *
 * Best-effort throughout, on `recoverUnreviewedPullRequests`'s posture
 * (`../dispatch/unreviewed-pr-recovery.ts`): one rollout's failure is logged and the
 * sweep carries on, and this never throws — an unhandled rejection out of a bare
 * `setInterval` callback would take the router down.
 */
export async function advanceRolloutsInProgress(): Promise<void> {
	let rollouts: WorkerUpdateRollout[];
	try {
		rollouts = await listInProgressRollouts();
	} catch (err) {
		logger.error('fleet update: could not read the rollouts in progress (continuing)', {
			error: describeError(err),
		});
		return;
	}
	for (const rollout of rollouts) {
		try {
			await advanceRollout(rollout.id);
		} catch (err) {
			logger.warn('fleet update: advancing a rollout failed — continuing the sweep', {
				rolloutId: rollout.id,
				error: describeError(err),
			});
		}
	}
}

/**
 * Start the periodic advance and return the handle that stops it. Started with the
 * router process and closed with it (`./index.ts`), exactly like
 * `subscribeWorkerUpdateDispatch`.
 *
 * One sweep at a time: a sweep that outruns the interval would only queue a second
 * set of callers behind the same row locks, so a tick arriving while one is still
 * running is skipped rather than stacked. The timer is `unref`'d like the
 * dispatcher's own intervals, so it never by itself keeps the process alive.
 */
export function startRolloutAdvanceTicker(): { close: () => void } {
	let sweeping = false;
	const timer = setInterval(() => {
		if (sweeping) return;
		sweeping = true;
		void advanceRolloutsInProgress().finally(() => {
			sweeping = false;
		});
	}, ROLLOUT_ADVANCE_TICK_MS);
	timer.unref();
	return { close: () => clearInterval(timer) };
}
