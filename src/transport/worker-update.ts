/**
 * The daemon side of worker self-update (issue #933): what a machine does when the
 * control plane asks it to move to a build, and what it says about it afterwards.
 *
 * The mechanism it drives is phase 1's (`../worker/self-update.ts`), which knows how
 * to move an install root and nothing about *when* that is safe. This module is the
 * "when", and it is three refusals and one wait:
 *
 * - **The machine must have opted in.** `SWARM_WORKER_SELF_UPDATE=true` on the host,
 *   read from its own environment and never from the wire. Until phase 4's
 *   shared-install lock lands, a machine whose install root is shared by several
 *   daemons must not set it — the other daemons' code would be swapped underneath
 *   them — so the flag is the operator stating that this host is not one of those
 *   (`docs/onboarding-worker.md`).
 * - **The target is re-validated here**, against the same grammar the frame already
 *   enforced. Not redundancy for its own sake: this value is about to be handed to
 *   `git` on an unattended machine, so it is checked at every seam it crosses rather
 *   than once at the edge.
 * - **The daemon must hold no in-flight phase.** It waits for that rather than
 *   forcing it: no run is cancelled, deferred or failed by an update. The control
 *   plane's own precondition — the machine is already draining (issue #919) — is what
 *   makes the wait terminate, since no *new* work is dispatched while it waits.
 * - A **shutdown** abandons the attempt silently. The request is durable on the
 *   `workers` row, so the next connection is pushed it again; reporting a refusal
 *   nobody asked for would instead leave an operator reading "refused" for a machine
 *   that simply restarted.
 *
 * **Every outcome is reported** — `POST /worker/delivery/update-report`, an HTTP
 * route rather than a stream frame for the reason the frame's own schema states
 * (`./protocol.ts`) — and only one of them ends the process. On `applied` the daemon
 * releases its session and exits 0, so launchd `KeepAlive` / systemd
 * `Restart=always` starts it again on the code that is now in the install root; the
 * new build's identity reaches the control plane on the next handshake through the
 * existing `build` field (issue #918), with no extra wiring. On `declined`,
 * `refused`, `failed` or `already-current` it reports and **keeps taking work** on
 * the build it has: nothing about the running process changed, because its modules
 * were loaded at startup.
 *
 * The exit deliberately goes through the daemon's own graceful path rather than a
 * bare `process.exit`: the session is released so the control plane frees the lease
 * promptly, quota reporting stops, and the checkout lock is dropped so the restarted
 * process can re-acquire it instead of waiting out the previous holder's liveness
 * check.
 */

import { type WorkerUpdateStatus, WorkerUpdateTargetSchema } from '../lib/build-identity.js';
import { describeError } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { applyUpdateTarget, type UpdateOutcome } from '../worker/self-update.js';
import { postDelivery } from './delivery-client.js';
import {
	type ReportWorkerUpdateDeliveryResponse,
	ReportWorkerUpdateDeliveryResponseSchema,
	type WorkerUpdate,
} from './protocol.js';

/** The host-level opt-in. Only the literal `true` enables it, like `SWARM_SINGLE_USER_MODE`. */
export const SELF_UPDATE_ENV = 'SWARM_WORKER_SELF_UPDATE';

/** The route this daemon reports to. */
export const UPDATE_REPORT_PATH = '/worker/delivery/update-report';

/**
 * How often the wait re-checks whether this daemon has gone idle. Coded rather than
 * configurable, like `WORKER_QUOTA_REPORT_INTERVAL_MS`: a phase runs for minutes at
 * least, so the only thing a shorter interval buys is a busier log, and the only
 * thing a longer one costs is a few seconds before a restart nobody is watching.
 */
export const IDLE_POLL_INTERVAL_MS = 5_000;

/**
 * Whether this machine opted in to self-update. Unset, empty, or any other value
 * keeps the coded default — the machine reports `declined` and keeps working — so
 * opting in is explicit and opting out needs no action, which is the safe direction
 * for a mechanism that rewrites the install root.
 */
export function selfUpdateEnabled(raw = process.env[SELF_UPDATE_ENV]): boolean {
	return raw === 'true';
}

/** The subset of the daemon's logger this module uses — injected in tests. */
export interface UpdateLogger {
	info: (message: string, meta?: Record<string, unknown>) => void;
	warn: (message: string, meta?: Record<string, unknown>) => void;
	error: (message: string, meta?: Record<string, unknown>) => void;
}

export interface WorkerUpdateHandlerOptions {
	/** Base URL of the control-plane delivery API — where the report goes. */
	controlPlaneUrl: string;
	/** Raw registered-worker credential: the only thing that names the reporting worker. */
	workerCredential: string;
	/**
	 * The daemon's live in-flight dispatch set (`./assignment-execution.ts`). Read,
	 * never written: the update waits for it to empty and never empties it itself.
	 */
	inFlight: ReadonlySet<string>;
	/** The daemon's graceful-shutdown signal — abandons a wait rather than racing it. */
	shutdownSignal: AbortSignal;
	/**
	 * Release the session the way a SIGTERM would, before the process exits. Supplied
	 * by `./connect-entry.ts`, which owns the quota reporter and the checkout lock
	 * that go with it.
	 */
	shutdown: () => Promise<void>;
	/** Whether this machine opted in; defaults to {@link selfUpdateEnabled}. */
	enabled?: boolean;
	/** Move the install root; defaults to phase 1's {@link applyUpdateTarget}. */
	apply?: (target: string) => Promise<UpdateOutcome>;
	/** Deliver one report; defaults to a `postDelivery` call. Injected in tests. */
	report?: (report: WorkerUpdateReport) => Promise<ReportWorkerUpdateDeliveryResponse>;
	/** Ends the process after a successful apply; defaults to `process.exit`. */
	exit?: (code: number) => void;
	/** Idle re-check cadence; defaults to {@link IDLE_POLL_INTERVAL_MS}. */
	idlePollIntervalMs?: number;
	logger?: UpdateLogger;
}

/** What this daemon reports about one request — the wire body minus the version stamp. */
export interface WorkerUpdateReport {
	requestId: string;
	target: string;
	status: WorkerUpdateStatus;
	message: string;
}

/**
 * Build the `onUpdate` handler for {@link connectWorkerTransport}.
 *
 * Returns a `void` function on purpose: the frame arrives on the socket's message
 * listener, and an update waits for the machine to go idle and then spends minutes
 * in `npm ci` — awaiting it there would stall the heartbeat loop and cost the daemon
 * the very lease it needs to report the outcome on. So the work is fired and
 * forgotten, exactly as a pushed assignment is.
 *
 * At most **one** update runs at a time. A *different* request arriving while one is
 * being applied is ignored and logged as such, because two `applyUpdateTarget` calls
 * on one install root would interleave a checkout with a build; nothing is lost,
 * since the pending request is durable on the `workers` row and is pushed again on
 * the next connection.
 *
 * A repeat of a request already handled here is the ordinary reconnect re-push
 * (`../router/worker-update-dispatch.ts`), and what it does depends on whether the
 * outcome ever reached the control plane. The work is **never** redone — that is the
 * point of remembering the request at all — but a report that did not land is
 * **re-sent**, which is the `takeUndelivered` move `AssignmentSink` already makes for
 * a phase result (issue #718): the row keeps pushing precisely because it is still
 * waiting for an answer this daemon already has, so the answer is what it gets.
 * Without that, a blip while POSTing would leave the request reading `pending`
 * forever on a machine that had long since decided.
 */
export function createWorkerUpdateHandler(
	options: WorkerUpdateHandlerOptions,
): (update: WorkerUpdate) => void {
	const logger = options.logger ?? defaultLogger;
	/** Request id → the report still owed to the control plane, or `null` once delivered. */
	const handled = new Map<string, WorkerUpdateReport | null>();
	let active = false;

	return (update) => {
		const held = handled.get(update.requestId);
		if (held !== undefined) {
			if (!held) {
				logger.info('ignoring a re-pushed worker update already reported from here', {
					requestId: update.requestId,
				});
				return;
			}
			logger.warn('re-reporting the outcome of an update the control plane never received', {
				requestId: update.requestId,
				status: held.status,
			});
			void report(options, logger, held, update).then((delivered) => {
				if (delivered) handled.set(update.requestId, null);
			});
			return;
		}
		if (active) {
			// Deliberately not queued: the request stays pending on the control plane and
			// is re-pushed on the next connection, which this machine is about to make if
			// the update in flight applies.
			logger.warn('ignoring a worker update — another one is already being applied here', {
				requestId: update.requestId,
				target: update.target,
			});
			return;
		}
		// Recorded before the work starts, so a re-push arriving mid-apply is recognised
		// as the repeat it is rather than starting a second one.
		handled.set(update.requestId, null);
		active = true;
		void runUpdate(update, options, logger, (owed) => handled.set(update.requestId, owed)).finally(
			() => {
				active = false;
			},
		);
	};
}

/**
 * One request, from the opt-in check to the report (and, on `applied`, the exit).
 *
 * `owe` is how the outcome survives a report that did not land: it is called with the
 * report whenever the POST failed, so the handler above can re-send it on the next
 * push rather than redoing the work or losing the answer.
 */
async function runUpdate(
	update: WorkerUpdate,
	options: WorkerUpdateHandlerOptions,
	logger: UpdateLogger,
	owe: (report: WorkerUpdateReport) => void,
): Promise<void> {
	const enabled = options.enabled ?? selfUpdateEnabled();
	if (!enabled) {
		logger.info('declining a worker update — this machine has not opted in', {
			requestId: update.requestId,
			target: update.target,
		});
		await reportOrOwe(options, logger, update, owe, {
			requestId: update.requestId,
			target: update.target,
			status: 'declined',
			message:
				`This machine has not opted in to self-update, so nothing was attempted. Set ` +
				`${SELF_UPDATE_ENV}=true in the daemon's environment and restart it — but only if ` +
				'its SWARM install root is not shared with another daemon.',
		});
		return;
	}

	const parsedTarget = WorkerUpdateTargetSchema.safeParse(update.target);
	if (!parsedTarget.success) {
		await reportOrOwe(options, logger, update, owe, {
			requestId: update.requestId,
			target: update.target,
			status: 'refused',
			message:
				'The requested target is not a well-formed branch name, tag, or commit id, so ' +
				'nothing was attempted. A target names a build — never a command, a script, a URL, ' +
				'or a git option.',
		});
		return;
	}

	if (!(await waitUntilIdle(options, logger, update))) return;

	logger.info('applying a requested worker update', {
		requestId: update.requestId,
		target: parsedTarget.data,
	});
	const apply = options.apply ?? ((target: string) => applyUpdateTarget({ target }));
	let outcome: UpdateOutcome;
	try {
		outcome = await apply(parsedTarget.data);
	} catch (err) {
		// `applyUpdateTarget` is contracted never to throw, so this can only be an
		// injected runner or a genuine bug. Report it as a failure rather than letting an
		// unhandled rejection take the daemon down over an update it was asked for.
		outcome = {
			status: 'failed',
			stage: 'checkout',
			reason: `Applying the update threw before it could report an outcome: ${describeError(err)}`,
			rolledBack: false,
			previousCommit: 'unknown',
			outputTail: '',
		};
	}

	const delivered = await reportOrOwe(options, logger, update, owe, {
		requestId: update.requestId,
		target: parsedTarget.data,
		...describeOutcome(outcome),
	});

	if (outcome.status !== 'applied') {
		logger.info('keeping this machine on the build it has', {
			requestId: update.requestId,
			target: parsedTarget.data,
			status: outcome.status,
		});
		return;
	}

	// Reported *before* exiting, and its delivery logged rather than gated on: an
	// install root already moved to the new build must restart into it whether or not
	// the control plane heard about it, since the alternative is a daemon running code
	// that no longer matches the files under it.
	logger.info('restarting into the updated build', {
		requestId: update.requestId,
		target: parsedTarget.data,
		commit: outcome.commit,
		previousCommit: outcome.previousCommit,
		reported: delivered,
	});
	await releaseAndExit(options, logger);
}

/**
 * Send a report, and hand it back to the handler when it did not land so the next
 * push can re-send it. Returns whether it was delivered.
 */
async function reportOrOwe(
	options: WorkerUpdateHandlerOptions,
	logger: UpdateLogger,
	update: WorkerUpdate,
	owe: (report: WorkerUpdateReport) => void,
	body: WorkerUpdateReport,
): Promise<boolean> {
	const delivered = await report(options, logger, body, update);
	if (!delivered) owe(body);
	return delivered;
}

/**
 * Wait until this daemon holds no in-flight phase. `true` when it is idle and the
 * update may proceed, `false` when the process is shutting down and the attempt is
 * abandoned (see the module header for why that reports nothing).
 *
 * Polls rather than subscribing: the in-flight set is a plain `Set` the executor
 * mutates, with no change signal to hook, and this is a once-per-request wait on a
 * multi-minute scale.
 */
async function waitUntilIdle(
	options: WorkerUpdateHandlerOptions,
	logger: UpdateLogger,
	update: WorkerUpdate,
): Promise<boolean> {
	const intervalMs = options.idlePollIntervalMs ?? IDLE_POLL_INTERVAL_MS;
	let waited = false;
	while (options.inFlight.size > 0) {
		if (options.shutdownSignal.aborted) {
			logger.info('abandoning a worker update — this daemon is shutting down', {
				requestId: update.requestId,
			});
			return false;
		}
		if (!waited) {
			waited = true;
			logger.info('deferring a worker update until this machine is idle', {
				requestId: update.requestId,
				target: update.target,
				inFlight: options.inFlight.size,
			});
		}
		await sleep(intervalMs, options.shutdownSignal);
	}
	// Re-checked after the loop as well as inside it: a shutdown that arrives while the
	// last phase is settling would otherwise start an update the process is leaving.
	if (options.shutdownSignal.aborted) {
		logger.info('abandoning a worker update — this daemon is shutting down', {
			requestId: update.requestId,
		});
		return false;
	}
	return true;
}

/** A cancellable pause — resolves early when the daemon starts shutting down. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		// Never the reason this process stays alive.
		timer.unref?.();
		function onAbort(): void {
			clearTimeout(timer);
			resolve();
		}
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * The reported form of an {@link UpdateOutcome}: its status in the shared
 * vocabulary, plus the machine's own words for what happened. The prose is phase
 * 1's — it already names the install root, the step that failed, and whether the
 * checkout was returned to the build it was on — so re-wording it here would only
 * let the operator-facing message and the daemon's log drift apart.
 */
function describeOutcome(outcome: UpdateOutcome): { status: WorkerUpdateStatus; message: string } {
	switch (outcome.status) {
		case 'applied':
			return {
				status: 'applied',
				message:
					`Applied: the SWARM install root moved from ${outcome.previousCommit} to ` +
					`${outcome.commit} and was rebuilt there. The daemon is restarting into it.`,
			};
		case 'already-current':
			return {
				status: 'already-current',
				message: `Already on ${outcome.commit} — nothing to do, and nothing was restarted.`,
			};
		case 'refused':
			return { status: 'refused', message: outcome.reason };
		case 'failed':
			// The output tail rides the message rather than a field of its own: the row
			// records one operator-facing string, and a failure whose cause is only in the
			// daemon's log is exactly what this report exists to avoid.
			return {
				status: 'failed',
				message: outcome.outputTail ? `${outcome.reason}\n\n${outcome.outputTail}` : outcome.reason,
			};
	}
}

/**
 * POST one report, returning whether the control plane recorded it against the
 * request still pending.
 *
 * Best-effort by construction: a refused or unreachable control plane is one `warn`
 * line. The machine's own state is already whatever it is — the install root moved
 * or it did not — and failing here would neither undo that nor tell anybody, while a
 * thrown rejection out of a fire-and-forget handler would take the daemon down over
 * a status update. An older control plane that does not serve the route answers 404,
 * which `postDelivery` explains in one line (`./delivery-client.ts`).
 */
async function report(
	options: WorkerUpdateHandlerOptions,
	logger: UpdateLogger,
	body: WorkerUpdateReport,
	update: WorkerUpdate,
): Promise<boolean> {
	const post =
		options.report ??
		((report: WorkerUpdateReport) =>
			postDelivery(
				{
					controlPlaneUrl: options.controlPlaneUrl,
					workerCredential: options.workerCredential,
				},
				UPDATE_REPORT_PATH,
				{ ...report },
				ReportWorkerUpdateDeliveryResponseSchema.parse,
			));
	try {
		const { recorded } = await post(body);
		if (!recorded) {
			logger.info('the control plane has moved on from this update request', {
				requestId: update.requestId,
				status: body.status,
			});
		}
		return recorded;
	} catch (err) {
		logger.warn('reporting the outcome of a worker update failed', {
			requestId: update.requestId,
			status: body.status,
			error: describeError(err),
		});
		return false;
	}
}

/**
 * Release the session and end the process with a success code, so the supervisor
 * treats this as a clean stop and starts the daemon again on the new build. A
 * failure to release is logged and exited through anyway: the lease expires on its
 * own TTL, whereas a daemon that stayed up on swapped-out files would keep taking
 * work it can no longer be reasoned about.
 */
async function releaseAndExit(
	options: WorkerUpdateHandlerOptions,
	logger: UpdateLogger,
): Promise<void> {
	try {
		await options.shutdown();
	} catch (err) {
		logger.error('releasing the worker session before an update restart failed', {
			error: describeError(err),
		});
	}
	(options.exit ?? ((code: number) => process.exit(code)))(0);
}
