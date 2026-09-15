/**
 * The daemon side of worker self-update (issue #933): what a machine does when the
 * control plane asks it to move to a build, and what it says about it afterwards.
 *
 * The mechanism it drives is phase 1's (`../worker/self-update.ts`), which knows how
 * to move an install root and nothing about *when* that is safe. This module is the
 * "when", and it is three refusals and one wait:
 *
 * - **The machine must have opted in.** `SWARM_WORKER_SELF_UPDATE=true` on the host,
 *   read from its own environment and never from the wire. A host whose install root
 *   is shared by several daemons may set it since issue #935: the apply takes a
 *   machine-local lock on that root and refuses outright while a peer daemon is
 *   mid-phase (`../worktree/install-lock.ts`), so the flag is now only the operator
 *   saying this machine may replace its own code (`docs/onboarding-worker.md`).
 * - **The target is re-validated here**, against the same grammar the frame already
 *   enforced. Not redundancy for its own sake: this value is about to be handed to
 *   `git` on an unattended machine, so it is checked at every seam it crosses rather
 *   than once at the edge.
 * - **The daemon must hold no in-flight phase.** It waits for that rather than
 *   forcing it: no run is cancelled, deferred or failed by an update. The control
 *   plane's own precondition — the machine is already draining (issue #919) — is what
 *   makes the wait terminate, since no *new* work is dispatched while it waits. It
 *   waits only for *its own* runs, and what it does about a **peer** daemon sharing
 *   this install root depends on what that peer is doing: one **mid-phase** is refused
 *   rather than waited for, because nothing here can drain somebody else's machine role
 *   and a wait on it would not terminate (issue #935); one **updating** *is* waited for,
 *   because its finish is exactly what makes this daemon's own restart safe (issue #973).
 *   Both decisions live in the mechanism.
 * - A **shutdown** abandons the attempt silently. The request is durable on the
 *   `workers` row, so the next connection is pushed it again; reporting a refusal
 *   nobody asked for would instead leave an operator reading "refused" for a machine
 *   that simply restarted.
 *
 * **Every outcome is reported** — `POST /worker/delivery/update-report`, an HTTP
 * route rather than a stream frame for the reason the frame's own schema states
 * (`./protocol.ts`) — and two of them end the process. On `applied` — this daemon did
 * the fetch and the build — and on `adopted` — a peer on the same machine did, and the
 * install root is on a build this process is not running (issue #973) — the daemon
 * releases its session and exits 0, so launchd `KeepAlive` / systemd `Restart=always`
 * starts it again on the code that is now in the install root; the new build's identity
 * reaches the control plane on the next handshake through the existing `build` field
 * (issue #918), with no extra wiring. Both are successes, and they are distinguishable
 * precisely so an operator can tell which machine paid for the fetch. On `declined`,
 * `refused`, `failed` or `already-current` it reports and **keeps taking work** on the
 * build it has: nothing about the running process changed, because its modules were
 * loaded at startup.
 *
 * The exit deliberately goes through the daemon's own graceful path rather than a
 * bare `process.exit`: the session is released so the control plane frees the lease
 * promptly, quota reporting stops, and the checkout lock is dropped so the restarted
 * process can re-acquire it instead of waiting out the previous holder's liveness
 * check.
 */

import {
	type WorkerBuild,
	type WorkerUpdateStatus,
	WorkerUpdateTargetSchema,
} from '../lib/build-identity.js';
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
	/**
	 * The build this daemon is *running*, resolved once at startup
	 * (`../lib/build-identity.ts`). It is what tells an install root already on the
	 * target apart from one a peer moved there while this process went on executing the
	 * modules it loaded at start — the difference between nothing to do and a restart
	 * (issue #973).
	 */
	build?: WorkerBuild;
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
 * At most **one** update runs at a time, because two `applyUpdateTarget` calls on one
 * install root would interleave a checkout with a build. A *different* request
 * arriving while one is being applied is therefore not started — but it is **held**,
 * and applied as soon as the one in flight finishes without restarting the daemon.
 * Dropping it instead would strand it: the control plane pushes a request once per
 * notification and otherwise only on a new connection, so a re-target received during
 * an update that then reports `failed` or `refused` would sit `pending` on a machine
 * that stayed connected and had nothing left to do. Only the newest held request is
 * kept — an operator who re-targets twice means the last target, and the control plane
 * is no longer waiting on the rows the earlier ones named. When the update in flight
 * *does* apply, the held request is left for the re-push on the restarted daemon's
 * next connection, since this process is on its way out.
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
	/** The newest distinct request that arrived mid-apply, waiting for the current one. */
	let heldBack: WorkerUpdate | null = null;

	/**
	 * Start the request held back during the update that just finished, if there is
	 * one. Called only after a non-restarting outcome: a daemon that is exiting into a
	 * new build gets the held request re-pushed on its next connection instead.
	 */
	function startHeldBack(): void {
		const next = heldBack;
		if (!next) return;
		heldBack = null;
		logger.info('taking up the worker update held while the previous one ran', {
			requestId: next.requestId,
			target: next.target,
		});
		handleUpdate(next);
	}

	function handleUpdate(update: WorkerUpdate): void {
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
			// Held rather than dropped: an outcome that does not restart this daemon leaves
			// it connected, and the control plane has no later push to make.
			logger.warn('holding a worker update — another one is being applied here first', {
				requestId: update.requestId,
				target: update.target,
			});
			heldBack = update;
			return;
		}
		// Recorded before the work starts, so a re-push arriving mid-apply is recognised
		// as the repeat it is rather than starting a second one.
		handled.set(update.requestId, null);
		active = true;
		void runUpdate(update, options, logger, (owed) => handled.set(update.requestId, owed)).then(
			(restarting) => {
				active = false;
				if (!restarting) startHeldBack();
			},
			(err) => {
				// `runUpdate` reports its own failures, so anything arriving here is a bug in
				// this module — but it must still clear the flag, or every later request would
				// queue behind an update that is no longer running.
				logger.error('a worker update ended without reporting an outcome', {
					requestId: update.requestId,
					error: describeError(err),
				});
				active = false;
				startHeldBack();
			},
		);
	}

	return handleUpdate;
}

/**
 * One request, from the opt-in check to the report (and, on `applied`, the exit).
 *
 * `owe` is how the outcome survives a report that did not land: it is called with the
 * report whenever the POST failed, so the handler above can re-send it on the next
 * push rather than redoing the work or losing the answer.
 *
 * Resolves `true` when this daemon is restarting into the new build and `false` when
 * it stays on the one it has — which is what tells the handler whether a request held
 * back during this one should be taken up here or left to the next connection.
 */
async function runUpdate(
	update: WorkerUpdate,
	options: WorkerUpdateHandlerOptions,
	logger: UpdateLogger,
	owe: (report: WorkerUpdateReport) => void,
): Promise<boolean> {
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
				`${SELF_UPDATE_ENV}=true in the daemon's environment and restart it.`,
		});
		return false;
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
		return false;
	}

	if (!(await waitUntilIdle(options, logger, update))) return false;

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

	// The *reported* status, not the mechanism's, is what decides the restart: the two
	// readings of `already-current` are only told apart here, against this daemon's own
	// build (issue #973).
	const reported: WorkerUpdateReport = {
		requestId: update.requestId,
		target: parsedTarget.data,
		...describeOutcome(outcome, options.build),
	};
	const delivered = await reportOrOwe(options, logger, update, owe, reported);

	if (!RESTARTING_STATUSES.has(reported.status)) {
		logger.info('keeping this machine on the build it has', {
			requestId: update.requestId,
			target: parsedTarget.data,
			status: reported.status,
		});
		return false;
	}

	// Reported *before* exiting, and its delivery logged rather than gated on: an
	// install root already moved to the new build must restart into it whether or not
	// the control plane heard about it, since the alternative is a daemon running code
	// that no longer matches the files under it. That holds for `adopted` too, which is
	// why a report the control plane rejected — an older router that has never heard the
	// word — still restarts this daemon rather than stranding it on stale code; the run
	// it leaves behind is settled by the control plane's own stale sweep.
	logger.info('restarting into the updated build', {
		requestId: update.requestId,
		target: parsedTarget.data,
		status: reported.status,
		commit: restartCommit(outcome),
		// Only an apply knows what it moved off; an adopting daemon knows only what it
		// was itself running, which is the same fact from its own side.
		previousCommit:
			outcome.status === 'applied' ? outcome.previousCommit : (options.build?.commit ?? null),
		fetchedHere: reported.status === 'applied',
		reported: delivered,
	});
	await releaseAndExit(options, logger);
	return true;
}

/** The two reported outcomes that end with this process exiting into a new build. */
const RESTARTING_STATUSES = new Set<WorkerUpdateStatus>(['applied', 'adopted']);

/**
 * The commit a restart is going *to*. Narrowed rather than cast: only the two
 * commit-carrying members of {@link UpdateOutcome} can reach a restart, and spelling
 * that out here is what keeps a third one from silently logging `undefined`.
 */
function restartCommit(outcome: UpdateOutcome): string | null {
	return outcome.status === 'applied' || outcome.status === 'already-current'
		? outcome.commit
		: null;
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
 * 1's wherever phase 1 has any — it already names the install root, the step that
 * failed, and whether the checkout was returned to the build it was on — so
 * re-wording it here would only let the operator-facing message and the daemon's log
 * drift apart.
 *
 * The one place this module has words of its own is the split below, and it has to:
 * the mechanism answers about the *install root*, so both readings of
 * `already-current` reach it as the same value, and only `build` — this daemon's own
 * startup commit — tells "nothing to do" from "a peer moved the files and I am the
 * process still running the old ones" (issue #973).
 */
function describeOutcome(
	outcome: UpdateOutcome,
	build: WorkerBuild | undefined,
): { status: WorkerUpdateStatus; message: string } {
	switch (outcome.status) {
		case 'applied':
			return {
				status: 'applied',
				message:
					`Applied: the SWARM install root moved from ${outcome.previousCommit} to ` +
					`${outcome.commit} and was rebuilt there. The daemon is restarting into it.`,
			};
		case 'already-current': {
			// The files are on the target; whether *this* process is running them is a
			// different question, and the only one that decides a restart. Its own commit was
			// resolved before the transport opened, so a peer's checkout since cannot have
			// moved it (issue #973).
			if (build?.commit === outcome.commit) {
				return {
					status: 'already-current',
					message: `Already on ${outcome.commit} — nothing to do, and nothing was restarted.`,
				};
			}
			// A build this daemon could not identify biases to `adopted`: the failure this
			// path exists to fix is a daemon that did *not* restart, and one extra supervisor
			// restart costs seconds. (Unreachable in practice — an install root that is not a
			// readable git checkout is refused by the mechanism long before. Such a daemon also
			// comes back unidentifiable, so a rollout's come-back verdict falls back to the
			// fresh lease alone, which is the same position issue #940 already puts it in.)
			// `dirty` is deliberately not consulted: it would make a machine genuinely on the
			// target report `adopted`, come back on the same commit, and be read as "came back
			// still on the build it was asked to move off".
			return {
				status: 'adopted',
				message:
					`The SWARM install root is on ${outcome.commit}, fetched and built by another ` +
					`daemon on this machine; this one was still running ` +
					`${build?.commit ?? 'a build it could not identify'} and is restarting into it.`,
			};
		}
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
