/**
 * Board-driven phase retirement (issue #909) — the rule that makes **a card's
 * current column the single source of truth for which board-driven phase is
 * queued for it**.
 *
 * A board move creates a dispatch; until this, nothing ever retired one. So a
 * card moved more than once accumulated one queued phase per move — Planning
 * queued behind busy workers, the operator drags the card to ToDo, and now both
 * a stale Planning *and* an Implementation are queued, with issue #761 making the
 * second wait behind the first. The only cure was to find the stale run in the
 * dashboard and hit Terminate.
 *
 * {@link retireSupersededBoardPhases} is the missing half: when a board move is
 * evaluated, whatever board-driven phase an *earlier* move left **waiting** is
 * cancelled, and its `deferred` run row is settled in the same transaction. It
 * composes existing pieces only — a read, a transactional settle, and the
 * best-effort wake-up removal every cancel path already does — so it is a
 * *sequence*, not a new lifecycle, which is why it lives under `src/dispatch/`
 * beside `run-reset.ts` and knows nothing about tRPC or about a PM provider.
 *
 * **Retirement fires from the newer move, not as a self-check on the stale
 * dispatch.** The issue asks for that to be decided explicitly. Cancelling when
 * the new move is evaluated is what satisfies "it must not linger in the
 * dashboard as queued work"; a claim-time "does my card still ask for me?" check
 * would leave the stale row in the Queue for as long as it waits. The self-heal
 * that alternative was credited with is already covered from another direction: a
 * dispatch from an earlier move that was never claimed has a null `phase`, is
 * invisible to this rule, and when it finally *is* claimed it re-reads the card
 * and is dropped by the existing status-change gate.
 *
 * **It fails open.** Every failure is logged and answered with `0`, matching the
 * posture of the `recordDispatchResolution` write beside it in `processJob`: the
 * failure direction is "a stale phase survives", which is exactly today's
 * behaviour, whereas throwing would fail a board dispatch that is otherwise
 * perfectly good.
 *
 * **A move to Backlog also stops the phase that is already running** (issue
 * #1451). Retirement only ever touches *waiting* dispatches; Backlog is the one
 * column that says "stop working on this", so on that move alone
 * {@link terminateRunningBoardPhases} asks for the dashboard's own Terminate on
 * every `running` Planning/Implementation run of the card's task. It is the very
 * request `runs.terminate` makes for a running run — `requestRunCancellation`,
 * with an origin saying why — so settlement, worktree reconciliation, the pushed
 * `task-cancel` to a federated worker, and the absence of any follow-on board
 * move or pull request are Terminate's, not a second mechanism's. Review and the
 * other SCM-driven phases are keyed on the pull request rather than the card's
 * column and are never touched: the read filters on {@link BOARD_DRIVEN_PHASES}.
 * It fails open the same way.
 */

import {
	listRetirableBoardDispatchesForTask,
	retireWaitingDispatch,
} from '../db/repositories/dispatchesRepository.js';
import { listRunningBoardDrivenRunsForTask } from '../db/repositories/runsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { phaseLabel } from '../pipeline/phase-label.js';
import { BOARD_DRIVEN_PHASES, type PipelinePhase } from '../pm/pipeline.js';
import { requestRunCancellation } from '../queue/cancellation.js';
import { removePendingJobById } from '../queue/producer.js';
import { wakeJobId } from './dispatcher.js';

export interface RetireBoardPhasesInput {
	projectId: string;
	/** The card's own SCM artifact id — the worktree task id its phases share. */
	taskId: string;
	/**
	 * The phase this card's *current* column calls for, or `undefined` when it
	 * calls for none (Backlog, In review, Done). `undefined` retires every waiting
	 * board-driven phase for the task: it is the same rule, not a second one.
	 */
	keepPhase: PipelinePhase | undefined;
	/** This evaluation's own dispatch — never retired. */
	excludeDispatchId: string;
}

/**
 * The retired row's phase, narrowed back from the column's wider `string | null`
 * with no cast. The read filters on {@link BOARD_DRIVEN_PHASES}, so a returned
 * row always carries one of them — the column is nullable only because a
 * dispatch whose trigger has not run yet has no phase, and such a row is
 * invisible to that read.
 */
function retiredPhase(phase: string | null): PipelinePhase | undefined {
	return BOARD_DRIVEN_PHASES.find((candidate) => candidate === phase);
}

/**
 * The operator-facing sentence recorded on the retired dispatch and its run.
 * Built from the canonical phase vocabulary alone — never a board's native
 * status name — so no provider-shaped string reaches shared code
 * (ai/RULES.md §2).
 */
function retirementReason(phase: string | null, keepPhase: PipelinePhase | undefined): string {
	const retired = retiredPhase(phase);
	const subject = retired ? `queued ${phaseLabel(retired)} phase` : 'queued phase';
	return keepPhase
		? `Retired — the board card now asks for the ${phaseLabel(keepPhase)} phase, so this ${subject} is no longer what its column asks for.`
		: `Retired — the board card moved to a status that starts no phase, so this ${subject} is no longer what its column asks for.`;
}

/**
 * Retire every board-driven phase still *waiting* for this task that the card's
 * new column no longer asks for, settling each one's run row with it. Returns how
 * many were retired (`0` when there were none, and `0` on any failure).
 */
export async function retireSupersededBoardPhases(input: RetireBoardPhasesInput): Promise<number> {
	const { projectId, taskId, keepPhase, excludeDispatchId } = input;
	try {
		const stale = await listRetirableBoardDispatchesForTask(
			projectId,
			taskId,
			keepPhase,
			excludeDispatchId,
		);
		if (stale.length === 0) return 0;

		const retired: { id: string; phase: string | null; runId: string | null }[] = [];
		for (const row of stale) {
			const settled = await retireWaitingDispatch(row.id, retirementReason(row.phase, keepPhase));
			// `null` means a worker claimed it between the read and the conditional
			// cancel — it is executing now, and stopping it is Terminate's job (which
			// a move to Backlog asks for itself: `terminateRunningBoardPhases`).
			if (!settled) continue;
			// Best-effort, exactly as `cancelDispatchAndWake` and
			// `scheduleCoalescedDispatch` do it: claim-time refusal covers any wake-up
			// that survives, because the dispatch is already terminal.
			await removePendingJobById(wakeJobId(settled.dispatch)).catch(() => false);
			retired.push({
				id: settled.dispatch.id,
				phase: settled.dispatch.phase,
				runId: settled.dispatch.runId,
			});
		}

		if (retired.length > 0) {
			logger.info(
				'pm-status: retired board-driven phases superseded by the card’s current column',
				{
					projectId,
					taskId,
					keepPhase,
					retired,
				},
			);
		}
		return retired.length;
	} catch (err) {
		logger.warn('pm-status: board-driven phase retirement failed (leaving the queue as it was)', {
			projectId,
			taskId,
			keepPhase,
			error: describeError(err),
		});
		return 0;
	}
}

export interface TerminateBoardPhasesInput {
	projectId: string;
	/**
	 * The run's own scoped repository (`project.repo`) — the card's task id is a
	 * number only within it, and what this terminates must not be another
	 * repository's same-numbered task.
	 */
	repository: string;
	/** The card's own SCM artifact id — the worktree task id its phases share. */
	taskId: string;
}

/**
 * Terminate every board-driven phase (Planning, Implementation) **running** for
 * this task, through the dashboard Terminate's own request — called when an
 * operator moves the card to Backlog (issue #1451). Returns how many runs a
 * termination was requested for (`0` when none were running, and `0` on a failed
 * read). Never throws: a failure is logged and the board move proceeds.
 *
 * Each request is attempted on its own, so one failed Redis write does not spare
 * the other run. The recorded origin (`board-backlog`) is what the settled run
 * shows as its reason; the run's error stays the neutral cancellation message,
 * exactly as for a dashboard Terminate.
 */
export async function terminateRunningBoardPhases(
	input: TerminateBoardPhasesInput,
): Promise<number> {
	const { projectId, repository, taskId } = input;
	try {
		const running = await listRunningBoardDrivenRunsForTask(projectId, repository, taskId);
		if (running.length === 0) return 0;

		const terminated: { runId: string; phase: string }[] = [];
		for (const run of running) {
			try {
				await requestRunCancellation(
					run.id,
					{ source: 'board-backlog', requestedAt: new Date().toISOString() },
					{ action: 'terminate', projectId, taskId, phase: run.phase },
				);
				terminated.push({ runId: run.id, phase: run.phase });
			} catch (err) {
				logger.warn(
					'pm-status: could not terminate a running board-driven phase for a card moved to Backlog',
					{
						projectId,
						repository,
						taskId,
						runId: run.id,
						phase: run.phase,
						error: describeError(err),
					},
				);
			}
		}

		if (terminated.length > 0) {
			logger.info(
				'pm-status: terminating running board-driven phases — the card was moved to Backlog',
				{
					projectId,
					repository,
					taskId,
					terminated,
				},
			);
		}
		return terminated.length;
	} catch (err) {
		logger.warn(
			'pm-status: running board-driven phase termination failed (leaving the runs as they were)',
			{ projectId, repository, taskId, error: describeError(err) },
		);
		return 0;
	}
}
