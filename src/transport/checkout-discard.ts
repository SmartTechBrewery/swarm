/**
 * The daemon side of a reset's checkout discard (issue #1402): what a machine does
 * when the control plane tells it that a run whose checkout it preserved was reset
 * and restarted somewhere else.
 *
 * Reset & restart (`../dispatch/run-reset.ts`) abandons the preserved worker, so the
 * `'discard'` intent riding the replacement dispatch reaches only whichever machine
 * runs the restart. This frame reaches the one that actually holds the checkout, and
 * applies **the same rule a reset applies to a checkout it does reach** —
 * `discardCheckout` in `../pipeline/resume.ts`: the checkout is force-removed whatever
 * its dirty or unpushed state, and its preservation pin goes with it, so a later
 * dispatch of the task on this machine provisions cleanly.
 *
 * What it will **not** remove, reported as `retained` rather than refused:
 *
 * - a checkout no pin or lease attributes to the reset run
 *   (`WorktreeRuntime.isOwnedByRun`) — it may be a newer run's;
 * - a checkout a live phase holds, or another run's fresh pin protects — decided by
 *   the same lease-then-liveness claim the abandoned sweep takes
 *   (`GitWorktreeManager.claimForSweep`), held across the removal so nothing in this
 *   process can provision at the path while it goes.
 *
 * Bookkeeping copies `./worktree-sweep.ts`: a request already handled here is never
 * redone, a report that did not land is re-sent on the next push, requests run one at
 * a time, and a shutdown abandons one silently (the row stays pending and is pushed
 * again on the next connection).
 */

import { existsSync } from 'node:fs';
import type { ProjectConfig } from '../config/schema.js';
import { describeError } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { GitWorktreeManager } from '../worker/git-worktree-manager.js';
import { createHostLocalWorktreeRuntime } from '../worktree/host-local-runtime.js';
import { postDelivery } from './delivery-client.js';
import {
	type CheckoutDiscard,
	type CheckoutDiscardOutcome,
	type ReportCheckoutDiscardDeliveryResponse,
	ReportCheckoutDiscardDeliveryResponseSchema,
} from './protocol.js';
import { selectCheckout, type WorkerCheckout } from './worker-checkouts.js';

/** The route this daemon reports to. */
export const CHECKOUT_DISCARD_REPORT_PATH = '/worker/delivery/checkout-discard-report';

/** The upper bound on the report's prose, as the wire schema states. */
const DETAIL_MAX_LENGTH = 4000;

/** The outcomes a machine reports — `superseded` is decided control-plane side only. */
export type ReportedCheckoutDiscardOutcome = Exclude<CheckoutDiscardOutcome, 'superseded'>;

/** What this daemon reports about one request — the wire body minus the version stamp. */
export interface CheckoutDiscardReport {
	requestId: string;
	outcome: ReportedCheckoutDiscardOutcome;
	detail: string;
}

/** What one discard attempt found. */
export interface CheckoutDiscardResult {
	outcome: ReportedCheckoutDiscardOutcome;
	detail: string;
}

/** The subset of the daemon's logger this module uses — injected in tests. */
export interface CheckoutDiscardLogger {
	info: (message: string, meta?: Record<string, unknown>) => void;
	warn: (message: string, meta?: Record<string, unknown>) => void;
	error: (message: string, meta?: Record<string, unknown>) => void;
}

export interface CheckoutDiscardHandlerOptions {
	/** This machine's own checkouts — host-local, never on the wire. */
	checkouts: readonly WorkerCheckout[];
	controlPlaneUrl: string;
	workerCredential: string;
	/**
	 * The daemon's live in-flight set. It answers "is the lease's owner live" for a
	 * lease this process wrote, and the discard joins it while it runs so its own lease
	 * reads as live to a provisioner here — the move `./worktree-sweep.ts` makes.
	 */
	inFlight: Set<string>;
	onInFlightChange?: () => void;
	shutdownSignal: AbortSignal;
	/** Discard under one checkout root; defaults to {@link discardRunCheckout}. Injected in tests. */
	discard?: (frame: CheckoutDiscard, repoRoot: string) => Promise<CheckoutDiscardResult>;
	/** Deliver one report; defaults to a `postDelivery` call. Injected in tests. */
	report?: (report: CheckoutDiscardReport) => Promise<ReportCheckoutDiscardDeliveryResponse>;
	logger?: CheckoutDiscardLogger;
}

/**
 * The owner id a discard's lease is written under and registered in the in-flight set
 * as — one definition, because the two must match for the registration to protect it.
 */
function discardOwnerId(): string {
	return `checkout-discard:${process.pid}`;
}

/**
 * Build the `onCheckoutDiscard` handler for `connectWorkerTransport`. Returns `void`
 * and fires the work off, as the sweep handler does, so the socket's message listener
 * never waits on git.
 */
export function createCheckoutDiscardHandler(
	options: CheckoutDiscardHandlerOptions,
): (frame: CheckoutDiscard) => void {
	const logger = options.logger ?? defaultLogger;
	/** Request id → the report still owed to the control plane, or `null` once delivered. */
	const handled = new Map<string, CheckoutDiscardReport | null>();
	/** Serialises requests: two discards must never race over leases. */
	let tail: Promise<void> = Promise.resolve();

	function handle(frame: CheckoutDiscard): void {
		const owed = handled.get(frame.requestId);
		if (owed !== undefined) {
			if (!owed) {
				logger.info('ignoring a re-pushed checkout discard already handled here', {
					requestId: frame.requestId,
				});
				return;
			}
			void report(options, logger, owed).then((delivered) => {
				if (delivered) handled.set(frame.requestId, null);
			});
			return;
		}
		// Recorded before the work starts, so a re-push arriving meanwhile is the repeat.
		handled.set(frame.requestId, null);
		tail = tail.then(async () => {
			try {
				const done = await runDiscard(frame, options, logger, (body) =>
					handled.set(frame.requestId, body),
				);
				// Abandoned to a shutdown: forget it, so a re-push may start from scratch.
				if (!done) handled.delete(frame.requestId);
			} catch (err) {
				logger.error('a checkout discard ended without reporting an outcome', {
					requestId: frame.requestId,
					error: describeError(err),
				});
				handled.delete(frame.requestId);
			}
		});
	}

	return handle;
}

/**
 * One request, from the checkout lookup to the report. Resolves `false` when it was
 * abandoned to a shutdown and nothing was reported.
 */
async function runDiscard(
	frame: CheckoutDiscard,
	options: CheckoutDiscardHandlerOptions,
	logger: CheckoutDiscardLogger,
	owe: (report: CheckoutDiscardReport) => void,
): Promise<boolean> {
	if (options.shutdownSignal.aborted) {
		logger.info('abandoning a checkout discard — this daemon is shutting down', {
			requestId: frame.requestId,
		});
		return false;
	}

	const checkout = selectCheckout(options.checkouts, frame.repository);
	let result: CheckoutDiscardResult;
	if (!checkout) {
		result = {
			outcome: 'absent',
			detail: `This worker holds no checkout of '${frame.repository}', so there is no checkout of task '${frame.taskId}' to discard.`,
		};
	} else {
		const discard = options.discard ?? discardRunCheckout(options.inFlight);
		const owner = discardOwnerId();
		options.inFlight.add(owner);
		options.onInFlightChange?.();
		try {
			result = await discard(frame, checkout.repoRoot);
		} catch (err) {
			result = {
				outcome: 'failed',
				detail: `Discarding the checkout failed: ${describeError(err)}`,
			};
		} finally {
			options.inFlight.delete(owner);
			options.onInFlightChange?.();
		}
	}

	const level = result.outcome === 'failed' ? 'warn' : 'info';
	logger[level]('checkout discard requested by a reset settled', {
		requestId: frame.requestId,
		runId: frame.runId,
		projectId: frame.projectId,
		taskId: frame.taskId,
		outcome: result.outcome,
		detail: result.detail,
	});

	// Bounded at the wire's own limit; a removal's git error is the only long part.
	const detail =
		result.detail.length <= DETAIL_MAX_LENGTH
			? result.detail
			: `${result.detail.slice(0, DETAIL_MAX_LENGTH - 1)}…`;
	const body: CheckoutDiscardReport = {
		requestId: frame.requestId,
		outcome: result.outcome,
		detail,
	};
	if (!(await report(options, logger, body))) owe(body);
	return true;
}

/**
 * Discard `frame.runId`'s checkout of `frame.taskId` under `repoRoot` — the default
 * `discard`. See the module header for what is retained instead.
 *
 * The host-local runtime is built with the reset run's id as its owner key, which is
 * what makes the run's *own* preservation pin not block the claim while another run's
 * fresh pin still does. The project value carries the three fields the manager reads
 * here and nothing else, the same assertion `./worktree-sweep.ts` makes.
 */
export function discardRunCheckout(
	inFlight: Set<string>,
): (frame: CheckoutDiscard, repoRoot: string) => Promise<CheckoutDiscardResult> {
	return async (frame, repoRoot) => {
		const project = {
			id: frame.projectId,
			repoRoot,
			worktreeRoot: frame.worktreeRoot,
		} as unknown as ProjectConfig;
		const runtime = createHostLocalWorktreeRuntime({
			repoRoot,
			worktreeRoot: frame.worktreeRoot,
			ownerId: discardOwnerId(),
			runId: frame.runId,
			isOwnerLive: (ownerId) => inFlight.has(ownerId),
		});
		const worktrees = new GitWorktreeManager(project, runtime);
		const path = worktrees.worktreePath(frame.taskId);
		if (!existsSync(path)) {
			return { outcome: 'absent', detail: `No checkout of task '${frame.taskId}' exists here.` };
		}
		// Read before the claim, which rewrites the lease owner and clears the run's pin.
		if (!(await runtime.isOwnedByRun(frame.projectId, frame.taskId, frame.runId))) {
			return {
				outcome: 'retained',
				detail: `The checkout of task '${frame.taskId}' here is not attributed to the reset run, so it was kept.`,
			};
		}
		const claim = await worktrees.claimForSweep(frame.taskId);
		if (!claim.safe) {
			return {
				outcome: 'retained',
				detail: `The checkout of task '${frame.taskId}' here ${claim.detail}, so it was kept.`,
			};
		}
		try {
			await worktrees.removeCheckoutUnderLease(frame.taskId);
		} finally {
			await worktrees.releaseSweepClaim(frame.taskId, claim.token);
		}
		return {
			outcome: 'discarded',
			detail: `Discarded the reset run's checkout of task '${frame.taskId}', with any uncommitted or unpushed work in it.`,
		};
	};
}

/**
 * POST one report, returning whether the control plane settled a request still
 * pending. Never throws — a failed report is one `warn` line and is re-sent on the
 * next push of the same request.
 */
async function report(
	options: CheckoutDiscardHandlerOptions,
	logger: CheckoutDiscardLogger,
	body: CheckoutDiscardReport,
): Promise<boolean> {
	const post =
		options.report ??
		((report: CheckoutDiscardReport) =>
			postDelivery(
				{ controlPlaneUrl: options.controlPlaneUrl, workerCredential: options.workerCredential },
				CHECKOUT_DISCARD_REPORT_PATH,
				{ ...report },
				ReportCheckoutDiscardDeliveryResponseSchema.parse,
			));
	try {
		const { recorded } = await post(body);
		if (!recorded) {
			logger.info('the control plane had already settled this checkout discard', {
				requestId: body.requestId,
				outcome: body.outcome,
			});
		}
		// A request the control plane already settled is not owed again either.
		return true;
	} catch (err) {
		logger.warn('reporting the outcome of a checkout discard failed', {
			requestId: body.requestId,
			outcome: body.outcome,
			error: describeError(err),
		});
		return false;
	}
}
