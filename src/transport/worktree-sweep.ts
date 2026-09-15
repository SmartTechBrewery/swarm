/**
 * The daemon side of the fleet worktree sweep (issue #955): what a machine does
 * when the control plane asks it to remove its own long-abandoned `task-<id>`
 * checkouts, and what it says about it afterwards.
 *
 * The mechanism it drives is phase 1's (`../worktree/abandoned.ts`), which knows how
 * to sweep one project's `worktreeRoot` and nothing about *when* that happens or
 * *who* hears the result. This module is the "when" and the "who", and beside
 * `./worker-update.ts` — the round trip it is a deliberate copy of — it is mostly a
 * list of things it does **not** have to do:
 *
 * - **Nothing here is the operator's own working copy.** A self-update rewrites the
 *   install root, and the guards on it are correspondingly careful about where the
 *   code may come from (`../worker/self-update.ts`). A sweep removes only `task-<id>`
 *   checkouts under a project's own `worktreeRoot`, behind phase 1's liveness gate,
 *   so the `abandonedAfterDays` setting is the whole of the opt-out.
 * - **No wait for the machine to go idle, and no draining precondition.** A checkout
 *   a phase on this daemon currently holds reads as *leased* — `isOwnerLive` is
 *   answered from this process's own in-flight set — so it is skipped by
 *   construction rather than by timing. Waiting would buy nothing and would make
 *   phase 3's unattended weekly sweep impossible. The same set carries the answer
 *   back the other way while a sweep runs; see {@link runSweep}.
 * - **No exit.** Unlike an applied update, nothing about the running daemon changed:
 *   it keeps its session and carries on taking work.
 *
 * What it does keep from that module is the bookkeeping, because the same re-push
 * exists here: a `requestId` already handled is never swept twice, but a report that
 * never reached the control plane **is re-sent** (the `takeUndelivered` move), at
 * most one sweep runs at a time, and a shutdown abandons the attempt silently — the
 * request is durable on the `workers` row, so the next connection is pushed it
 * again, where reporting a failure nobody asked for would leave an operator reading
 * an outcome for a machine that simply restarted.
 *
 * **One project's failure is never the sweep's.** Projects are swept serially, each
 * in its own `try`; a throw is counted and its text folded into the report's
 * `message`, and the remaining projects are still swept. The report goes to
 * `POST /worker/delivery/worktree-sweep-report` — an HTTP route rather than a stream
 * frame, for the reason the frame's own schema states (`./protocol.ts`).
 */

import type { ProjectConfig } from '../config/schema.js';
import {
	WORKTREE_SWEEP_REMOVAL_CAP,
	type WorktreeSweepRemoval,
	type WorktreeSweepStatus,
} from '../identity/worker.js';
import { describeError } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { GitWorktreeManager } from '../worker/git-worktree-manager.js';
import {
	type SweepAbandonedWorktreesResult,
	sweepAbandonedWorktrees,
} from '../worktree/abandoned.js';
import { createHostLocalWorktreeRuntime } from '../worktree/host-local-runtime.js';
import { postDelivery } from './delivery-client.js';
import {
	type ReportWorktreeSweepDeliveryResponse,
	ReportWorktreeSweepDeliveryResponseSchema,
	type WorktreeSweep,
	type WorktreeSweepProject,
} from './protocol.js';

/** The route this daemon reports to. */
export const WORKTREE_SWEEP_REPORT_PATH = '/worker/delivery/worktree-sweep-report';

/** The upper bound on the report's operator-facing prose, as the wire schema states. */
const MESSAGE_MAX_LENGTH = 4000;

/** The subset of the daemon's logger this module uses — injected in tests. */
export interface SweepLogger {
	info: (message: string, meta?: Record<string, unknown>) => void;
	warn: (message: string, meta?: Record<string, unknown>) => void;
	error: (message: string, meta?: Record<string, unknown>) => void;
}

export interface WorktreeSweepHandlerOptions {
	/**
	 * This machine's own checkout root (`SWARM_WORKER_REPO_ROOT`). Host-local and
	 * never on the wire: the frame names a project's *relative* `worktreeRoot`, and
	 * this is what it is resolved against — so nothing the control plane sends can
	 * point a sweep at a directory this daemon does not already own.
	 */
	repoRoot: string;
	/** Base URL of the control-plane delivery API — where the report goes. */
	controlPlaneUrl: string;
	/** Raw registered-worker credential: the only thing that names the reporting worker. */
	workerCredential: string;
	/**
	 * The daemon's live in-flight dispatch set (`./assignment-execution.ts`). It is
	 * the whole of this feature's safety, in both directions: it is the
	 * `isOwnerLive` answer the host-local runtime gives, so a checkout a phase here
	 * still holds reads as leased and is never removed whatever its age — and a
	 * running sweep **adds its own owner id** to it for the same reason, so the lease
	 * it takes over a removal reads as live to a provisioner in this process instead
	 * of as an orphan that one would take over mid-removal (see {@link runSweep}).
	 */
	inFlight: Set<string>;
	/**
	 * Called whenever the sweep adds or removes its entry above, so anything derived
	 * from that set stays accurate — the daemon publishes its busy flag from it
	 * (`./worker-main.ts`), and it recomputes only when told to.
	 */
	onInFlightChange?: () => void;
	/** The daemon's graceful-shutdown signal — abandons the sweep rather than racing it. */
	shutdownSignal: AbortSignal;
	/** Sweep one project; defaults to phase 1's {@link sweepAbandonedWorktrees}. Injected in tests. */
	sweep?: (entry: WorktreeSweepProject) => Promise<SweepAbandonedWorktreesResult>;
	/** Deliver one report; defaults to a `postDelivery` call. Injected in tests. */
	report?: (report: WorktreeSweepReport) => Promise<ReportWorktreeSweepDeliveryResponse>;
	logger?: SweepLogger;
}

/** What this daemon reports about one request — the wire body minus the version stamp. */
export interface WorktreeSweepReport {
	requestId: string;
	status: WorktreeSweepStatus;
	removed: WorktreeSweepRemoval[];
	/** The true total, even when `removed` above was capped. */
	removedCount: number;
	keptLiveCount: number;
	failedCount: number;
	message: string;
}

/**
 * Build the `onWorktreeSweep` handler for {@link connectWorkerTransport}.
 *
 * Returns a `void` function on purpose, exactly as the update handler does: the
 * frame arrives on the socket's message listener, and a sweep stats and removes
 * directories across every enrolled project — awaiting it there would stall the
 * heartbeat loop and cost the daemon the very lease it needs to report on. So the
 * work is fired and forgotten, as a pushed assignment is.
 *
 * At most **one** sweep runs at a time, because two would race each other over the
 * same checkouts and the same leases. A *different* request arriving while one runs
 * is not started but is **held**, and taken up as soon as the one in flight
 * finishes. Dropping it would strand it: the control plane pushes once per
 * notification and otherwise only on a new connection, so a request received during
 * a sweep would sit `pending` on a machine that stayed connected and had nothing
 * left to do. Only the newest held request is kept — the row holds one request, so
 * the earlier ones are no longer what anything waits on.
 *
 * A repeat of a request already handled here is the ordinary reconnect re-push
 * (`../router/worktree-sweep-dispatch.ts`), and what it does depends on whether the
 * outcome ever reached the control plane. The work is **never** redone — that is the
 * point of remembering the request at all, and re-sweeping would mean re-removing —
 * but a report that did not land is **re-sent**, which is the `takeUndelivered` move
 * `AssignmentSink` already makes for a phase result. Without it a blip while POSTing
 * would leave the request reading `pending` forever on a machine that had long since
 * done the work.
 */
export function createWorktreeSweepHandler(
	options: WorktreeSweepHandlerOptions,
): (frame: WorktreeSweep) => void {
	const logger = options.logger ?? defaultLogger;
	/** Request id → the report still owed to the control plane, or `null` once delivered. */
	const handled = new Map<string, WorktreeSweepReport | null>();
	let active = false;
	/** The newest distinct request that arrived mid-sweep, waiting for the current one. */
	let heldBack: WorktreeSweep | null = null;

	function startHeldBack(): void {
		const next = heldBack;
		if (!next) return;
		heldBack = null;
		logger.info('taking up the worktree sweep held while the previous one ran', {
			requestId: next.requestId,
		});
		handleSweep(next);
	}

	function handleSweep(frame: WorktreeSweep): void {
		const owed = handled.get(frame.requestId);
		if (owed !== undefined) {
			if (!owed) {
				logger.info('ignoring a re-pushed worktree sweep already handled here', {
					requestId: frame.requestId,
				});
				return;
			}
			logger.warn('re-reporting the outcome of a sweep the control plane never received', {
				requestId: frame.requestId,
				status: owed.status,
			});
			void report(options, logger, owed).then((delivered) => {
				if (delivered) handled.set(frame.requestId, null);
			});
			return;
		}
		if (active) {
			logger.warn('holding a worktree sweep — another one is running here first', {
				requestId: frame.requestId,
			});
			heldBack = frame;
			return;
		}
		// Recorded before the work starts, so a re-push arriving mid-sweep is recognised
		// as the repeat it is rather than starting a second one.
		handled.set(frame.requestId, null);
		active = true;
		void runSweep(frame, options, logger, (report) => handled.set(frame.requestId, report)).then(
			(swept) => {
				active = false;
				// An abandoned attempt is forgotten rather than remembered as handled: this
				// process is on its way out, and a re-push must be free to sweep from scratch.
				if (!swept) handled.delete(frame.requestId);
				startHeldBack();
			},
			(err) => {
				// `runSweep` reports its own failures, so anything arriving here is a bug in
				// this module — but it must still clear the flag, or every later request would
				// queue behind a sweep that is no longer running.
				logger.error('a worktree sweep ended without reporting an outcome', {
					requestId: frame.requestId,
					error: describeError(err),
				});
				active = false;
				handled.delete(frame.requestId);
				startHeldBack();
			},
		);
	}

	return handleSweep;
}

/**
 * One request, from the first project to the report.
 *
 * `owe` is how the outcome survives a report that did not land: it is called with
 * the report whenever the POST failed, so the handler above can re-send it on the
 * next push rather than redoing the work or losing the answer.
 *
 * Resolves `false` when the attempt was abandoned to a shutdown — nothing was
 * reported and nothing should be remembered — and `true` otherwise.
 */
async function runSweep(
	frame: WorktreeSweep,
	options: WorktreeSweepHandlerOptions,
	logger: SweepLogger,
	owe: (report: WorktreeSweepReport) => void,
): Promise<boolean> {
	// The sweep announces *itself* as live for as long as it runs, and that is what
	// gives the lease phase 1 takes before a removal any force in this process. A
	// lease is only as strong as the liveness answer behind it, and this daemon's own
	// provisioner resolves one written by this same pid through `isOwnerLive` — this
	// very set (`../worktree/host-local-runtime.ts`). Unregistered, the sweep's lease
	// would read as an orphan and be taken over mid-removal, putting a fresh checkout
	// at the path about to be force-removed; cross-process, the pid check already
	// answers for it. Held for the whole sweep rather than per removal: it costs one
	// entry, and anything narrower is another window to get wrong.
	const sweepOwner = sweepOwnerId();
	options.inFlight.add(sweepOwner);
	options.onInFlightChange?.();
	try {
		return await sweepProjectsAndReport(frame, options, logger, owe);
	} finally {
		options.inFlight.delete(sweepOwner);
		options.onInFlightChange?.();
	}
}

/** The sweep itself, run with {@link runSweep}'s live-owner registration in place. */
async function sweepProjectsAndReport(
	frame: WorktreeSweep,
	options: WorktreeSweepHandlerOptions,
	logger: SweepLogger,
	owe: (report: WorktreeSweepReport) => void,
): Promise<boolean> {
	const sweep = options.sweep ?? ((entry: WorktreeSweepProject) => sweepProject(options, entry));
	const removed: WorktreeSweepRemoval[] = [];
	const failures: string[] = [];
	let keptLiveCount = 0;
	let failedCount = 0;

	logger.info('sweeping abandoned worktrees on request', {
		requestId: frame.requestId,
		projects: frame.projects.length,
	});

	for (const entry of frame.projects) {
		// Checked per project rather than once: a sweep of a large fleet machine can
		// outlast the SIGTERM that arrives mid-way, and stopping between projects leaves
		// the remaining ones for the re-push instead of racing the teardown.
		if (options.shutdownSignal.aborted) {
			logger.info('abandoning a worktree sweep — this daemon is shutting down', {
				requestId: frame.requestId,
			});
			return false;
		}
		try {
			const result = await sweep(entry);
			for (const entryRemoval of result.removed) {
				removed.push({ projectId: entry.projectId, ...entryRemoval });
			}
			keptLiveCount += result.keptLive.length;
			// A checkout that could not be removed is a failure of the same kind as a
			// project that threw — the operator asked for it to be gone and it is not —
			// so both land in the one count the report carries.
			failedCount += result.failed.length;
			for (const failure of result.failed) {
				failures.push(`${entry.projectId} ${failure.path}: ${failure.error}`);
			}
		} catch (err) {
			failedCount += 1;
			failures.push(`${entry.projectId}: ${describeError(err)}`);
			logger.warn('sweeping one project failed — continuing with the rest', {
				requestId: frame.requestId,
				projectId: entry.projectId,
				error: describeError(err),
			});
		}
	}

	const body: WorktreeSweepReport = {
		requestId: frame.requestId,
		status: failedCount > 0 ? 'failed' : 'swept',
		// Capped detail, uncapped count: the wire refuses to be a log sink, and an
		// operator still learns how many checkouts a machine that removed hundreds took.
		removed: removed.slice(0, WORKTREE_SWEEP_REMOVAL_CAP),
		removedCount: removed.length,
		keptLiveCount,
		failedCount,
		message: composeMessage(frame.projects.length, removed.length, keptLiveCount, failures),
	};

	const delivered = await report(options, logger, body);
	if (!delivered) owe(body);
	return true;
}

/**
 * The operator-facing prose beside the structured counts: what was swept, and every
 * failure's own words. Bounded at the wire's own limit — the failure list is the
 * only unbounded part, so it is what gets truncated, and the summary line that says
 * how much was removed always survives.
 */
function composeMessage(
	projectCount: number,
	removedCount: number,
	keptLiveCount: number,
	failures: string[],
): string {
	const summary =
		`Swept ${projectCount} project(s): removed ${removedCount} abandoned checkout(s), ` +
		`kept ${keptLiveCount} still in use.`;
	if (failures.length === 0) return summary;
	const detail = `${summary}\n\nFailed (${failures.length}):\n${failures.join('\n')}`;
	return detail.length <= MESSAGE_MAX_LENGTH
		? detail
		: `${detail.slice(0, MESSAGE_MAX_LENGTH - 1)}…`;
}

/**
 * The owner id every lease a sweep on this daemon takes is written under, and the
 * one {@link runSweep} registers as live for its duration. One definition because
 * the two must be the same string — a sweep registering an id its own leases are not
 * written under would protect nothing.
 */
function sweepOwnerId(): string {
	return `worktree-sweep:${process.pid}`;
}

/**
 * Sweep one project the frame named, against **this machine's own** checkout root.
 *
 * `isOwnerLive` is the daemon's in-flight set, which is what makes a checkout a
 * phase here currently holds read as leased and be skipped — the acceptance
 * criterion this whole feature turns on. `ownerId` names the sweep itself, and it is
 * load-bearing rather than cosmetic: phase 1 *takes* the task lease across a removal
 * (`../worktree/abandoned.ts`), so this is the id {@link runSweep} puts in the
 * in-flight set to keep a provisioner in this process from taking that lease over.
 *
 * The project value carries the three fields a sweep reads and nothing else. A
 * `worktree-sweep` frame deliberately carries no repository, board mapping or
 * credential reference — a machine tidying its own directories needs none, and
 * sending them would hand a daemon configuration it has no business holding — so
 * this is asserted rather than parsed. The one consequence worth knowing: with no
 * `baseBranch` to fall back on, the *unpushed-work* record of a checkout whose
 * branch was never pushed at all fails closed and reads `true`, which is both the
 * safe direction and, for a branch with no remote, the right answer.
 */
function sweepProject(
	options: WorktreeSweepHandlerOptions,
	entry: WorktreeSweepProject,
): Promise<SweepAbandonedWorktreesResult> {
	const project = {
		id: entry.projectId,
		repoRoot: options.repoRoot,
		worktreeRoot: entry.worktreeRoot,
	} as unknown as ProjectConfig;
	return sweepAbandonedWorktrees(project, {
		worktrees: new GitWorktreeManager(
			project,
			createHostLocalWorktreeRuntime({
				repoRoot: options.repoRoot,
				worktreeRoot: entry.worktreeRoot,
				ownerId: sweepOwnerId(),
				isOwnerLive: (ownerId) => options.inFlight.has(ownerId),
			}),
		),
		abandonedAfterDays: entry.abandonedAfterDays,
	});
}

/**
 * POST one report, returning whether the control plane recorded it against the
 * request still pending.
 *
 * Best-effort by construction, exactly as the update report is: a refused or
 * unreachable control plane is one `warn` line. The checkouts are already gone —
 * failing here would neither restore them nor tell anybody — while a thrown
 * rejection out of a fire-and-forget handler would take the daemon down over a
 * status update. An older control plane that does not serve the route answers 404,
 * which `postDelivery` explains in one line (`./delivery-client.ts`).
 */
async function report(
	options: WorktreeSweepHandlerOptions,
	logger: SweepLogger,
	body: WorktreeSweepReport,
): Promise<boolean> {
	const post =
		options.report ??
		((report: WorktreeSweepReport) =>
			postDelivery(
				{
					controlPlaneUrl: options.controlPlaneUrl,
					workerCredential: options.workerCredential,
				},
				WORKTREE_SWEEP_REPORT_PATH,
				{ ...report },
				ReportWorktreeSweepDeliveryResponseSchema.parse,
			));
	try {
		const { recorded } = await post(body);
		if (!recorded) {
			logger.info('the control plane has moved on from this worktree-sweep request', {
				requestId: body.requestId,
				status: body.status,
			});
		}
		return recorded;
	} catch (err) {
		logger.warn('reporting the outcome of a worktree sweep failed', {
			requestId: body.requestId,
			status: body.status,
			error: describeError(err),
		});
		return false;
	}
}
