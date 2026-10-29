/**
 * Derivation of a deferred dispatch's next-attempt payload (issue #284;
 * previously buried in `src/worker/deferred-retry.ts`'s enqueue path) — pure
 * apart from the fresh session id a non-resuming attempt mints. The
 * worker persists this payload on the dispatch row *when it settles the
 * deferral* — before any queue work — so the retry intent survives a crash
 * between settle and wake-up publication, instead of living only inside a
 * fire-and-forget BullMQ handler.
 *
 * It also owns the two *manual* counterparts — the payloads an operator-driven
 * attempt runs with — which live here rather than in the tRPC router so both
 * operator paths are built in one place. They are deliberately **not** the same
 * builder (issue #741): {@link reconstructRetryJob} serves "Retry now"
 * (`runs.retryNow`) and inherits recovery intent, because a retry's whole purpose
 * can be to re-enter a session or adopt a preserved checkout;
 * {@link reconstructResetJob} serves "Reset & restart"
 * (`src/dispatch/run-reset.ts`, issue #424) and inherits none of it, because a
 * reset's contract is that the phase runs as if it had never run.
 */

import { randomUUID } from 'node:crypto';
import type { AgentCli } from '../harness/agent-cli.js';
import type { ReasoningLevel } from '../harness/models.js';
import {
	normalizeStoredJobPayload,
	type RecoveryMode,
	type SwarmJob,
	stripRecoveryIntent,
} from '../queue/jobs.js';
import type { TriggerPhase } from '../triggers/types.js';

/** The slice of a `phase-deferred` outcome the payload derivation needs. */
export interface DeferredRetryIntent {
	phase: TriggerPhase;
	runId?: string;
	/** Resume the preserved agent session on retry (rate-limit/timeout/stalled). */
	resumable: boolean;
	/**
	 * Continue from the Tier 2 checkpoint in the preserved worktree instead of a
	 * session (issue #503, `docs/CHECKPOINTS.md`). Mutually exclusive with
	 * {@link resumable} by construction — the fallback is only chosen when no session
	 * can be resumed — and it is what puts `recoveryMode: 'checkpoint'` and a freshly
	 * minted session id on the next attempt.
	 */
	checkpointed?: boolean;
	/** Resume deterministic-delivery progress from the preserved worktree. */
	resumeDelivery?: boolean;
	/** A PM-driven phase was actually entered before it deferred. */
	pmPhaseStarted?: boolean;
	/** The retry must reuse the held review-dispatch dedup claim (issue #214). */
	continuationDispatchClaimed?: boolean;
	/**
	 * This is a dependency re-check deferral (issue #330), not an agent failure:
	 * consume the separate {@link SwarmJob.dependencyRecheckAttempt} budget instead
	 * of the small rate-limit one, so a task can wait days on an unfinished
	 * prerequisite without exhausting its retry budget.
	 */
	dependencyRecheck?: boolean;
	/**
	 * The prerequisites a {@link dependencyRecheck} deferral waits on (issue #1087),
	 * recorded on the payload as {@link SwarmJob.dependencyBlockers}.
	 */
	dependencyBlockers?: NonNullable<SwarmJob['dependencyBlockers']>;
	/**
	 * This is a worker-eligibility re-check deferral (issue #339), not an agent
	 * failure: no eligible worker could take the dispatch, so it consumes the
	 * separate {@link SwarmJob.workerEligibilityRecheckAttempt} budget while it
	 * waits for a worker to free up (or for consent/enrollment to be granted).
	 */
	workerEligibilityRecheck?: boolean;
	/**
	 * This is an automatic retry of a failure that used to be terminal (issue #1075,
	 * `../worker/automatic-retry-policy.ts`): it consumes the separate
	 * {@link SwarmJob.automaticRetryAttempt} budget and leaves the rate-limit one
	 * untouched.
	 */
	automaticRetry?: boolean;
	/**
	 * This deferral re-attempts a **continuation whose stopped attempt never reported**
	 * (issue #1138): a lost worker transport carries no exit, session or checkpoint,
	 * so there is nothing to re-derive recovery intent from, and the work the attempt
	 * was continuing is still on the machine that lost its transport. The attempt's own
	 * recovery intent (`recoveryMode`, `resumeSession`, `resumeDelivery`) is carried
	 * instead of re-derived, so the retry stays a continuation and stays pinned.
	 */
	carriedContinuation?: boolean;
}

/**
 * Which attempt counter this deferral spends. The two token-free re-checks
 * (dependency, worker eligibility) each have their own budget so a long wait on
 * one can't exhaust the other or the small rate-limit budget, and so does an
 * automatic retry of a failure that used to be terminal (issue #1075); every other
 * deferral is a failure retry and consumes the rate-limit one as before.
 */
function attemptCounterPatch(
	job: SwarmJob,
	intent: DeferredRetryIntent,
): {
	dependencyRecheckAttempt?: number;
	workerEligibilityRecheckAttempt?: number;
	rateLimitRetryAttempt?: number;
	automaticRetryAttempt?: number;
} {
	if (intent.dependencyRecheck) {
		return { dependencyRecheckAttempt: (job.dependencyRecheckAttempt ?? 0) + 1 };
	}
	if (intent.workerEligibilityRecheck) {
		return { workerEligibilityRecheckAttempt: (job.workerEligibilityRecheckAttempt ?? 0) + 1 };
	}
	if (intent.automaticRetry) {
		return { automaticRetryAttempt: (job.automaticRetryAttempt ?? 0) + 1 };
	}
	return { rateLimitRetryAttempt: (job.rateLimitRetryAttempt ?? 0) + 1 };
}

/**
 * The payload a scheduled retry runs with. Retry intent is derived from this
 * outcome — a stale flag from an earlier queued job must not turn a
 * pre-provisioning capacity retry into a branch resume, so the prior
 * `resumePmPhase`/`resumeSession`/`resumeDelivery` flags are dropped and
 * re-derived.
 *
 * `recoveryMode` is dropped and re-derived only for the value this function itself
 * sets, `'checkpoint'` (issue #503): a continuation that stops involuntarily again
 * and *can* resume its session this time must not still ask the recovery gate to
 * adopt a checkpoint. An operator-selected `'resume'`/`'fresh'` is left alone, as
 * before.
 *
 * `'discard'` is dropped too, and for a different reason (issue #592): it is a
 * one-shot instruction to destroy a checkout, issued by an operator for *one*
 * forced reset. Carrying it forward would put it on every later automatic deferral
 * of the same run, so the retry of a run that had just preserved its checkout for a
 * resume would delete that checkout instead of continuing from it.
 *
 * {@link SwarmJob.agentSessionId} is dropped and re-derived with them — it is
 * destructured out below rather than carried by the rest spread, so the id can't
 * survive a branch that didn't decide it — because `resumeSession` is what
 * decides *which of its two meanings* the id carries: the session to `--resume`
 * when the flag is set, the session to **assign** (`claude --session-id`) when it
 * is not. Those are not interchangeable — an id `claude` has already opened a
 * session under cannot be assigned a second time; it exits 1 with `Session ID
 * <id> is already in use` before doing any work. So a non-resumable retry mints a
 * fresh id rather than carrying the spent one forward.
 *
 * Two branches carry recovery intent instead of re-deriving it: a token-free
 * re-check (the same attempt, still waiting) and a **carried continuation** (issue
 * #1138, {@link DeferredRetryIntent.carriedContinuation}) — a continuation whose
 * attempt was lost without reporting anything, so its own intent is the only
 * evidence of what the retry should adopt.
 */
/**
 * The PM dispatch-intent patch, shared by both branches of
 * {@link deriveRetryJobPayload}: keep the board-dispatch marker when this attempt
 * already carried it, or when the outcome says the phase was entered.
 */
function pmIntentPatch(
	job: SwarmJob,
	intent: DeferredRetryIntent,
	carriedResumePmPhase: SwarmJob['resumePmPhase'],
): { resumePmPhase?: 'planning' | 'implementation' } {
	if (!(intent.pmPhaseStarted || carriedResumePmPhase !== undefined)) return {};
	if (job.type !== 'pm') return {};
	if (intent.phase !== 'planning' && intent.phase !== 'implementation') return {};
	return { resumePmPhase: intent.phase };
}

/**
 * The blockers a dependency deferral records on the payload (issue #1087), so the
 * Queue can name and link them without parsing the gate's free-text message.
 */
function dependencyBlockersPatch(
	intent: DeferredRetryIntent,
): Pick<SwarmJob, 'dependencyBlockers'> {
	return intent.dependencyRecheck && intent.dependencyBlockers
		? { dependencyBlockers: intent.dependencyBlockers }
		: {};
}

export function deriveRetryJobPayload(parsed: SwarmJob, intent: DeferredRetryIntent): SwarmJob {
	// The blockers a dependency wait names (issue #1087) describe the deferral that
	// recorded them, so they are dropped here and re-recorded only when this deferral
	// is itself a dependency wait.
	const { dependencyBlockers: _priorBlockers, ...carried } = parsed;
	// A **token-free re-check** deferral (issue #330's dependency gate, issue #339's
	// eligibility gate) is not a retry of an attempt — it is the *same* attempt still
	// waiting. Both gates run before any worktree is provisioned or any agent is
	// launched, so nothing was consumed: no session was opened, no checkout adopted,
	// no checkpoint spent. Re-deriving recovery intent here would therefore rewrite a
	// still-valid plan into a different one — a `'checkpoint'` continuation would lose
	// its mode outright, and a `'resume'` would have its session id replaced with a
	// freshly minted one it could never resume — so the wait would quietly become the
	// start-over it exists to prevent (issue #567). The payload is carried through
	// verbatim instead; only the wait's own bookkeeping changes.
	if (intent.dependencyRecheck || intent.workerEligibilityRecheck) {
		return {
			...carried,
			...attemptCounterPatch(parsed, intent),
			...dependencyBlockersPatch(intent),
			...(intent.runId ? { runId: intent.runId } : {}),
			...pmIntentPatch(parsed, intent, parsed.resumePmPhase),
			...(intent.continuationDispatchClaimed ? { continuationDispatchClaimed: true } : {}),
		};
	}
	// A **carried continuation** (issue #1138): the stopped attempt was continuing
	// preserved work and reported nothing about itself, so its recovery intent is the
	// only evidence there is. Re-deriving would drop it and turn the retry into a
	// fresh, unpinned start; carrying it keeps the retry the same continuation. Unlike
	// a re-check, this *is* a new attempt, so it spends a retry and the session id is
	// re-decided: a session continuation re-enters the same session, while every other
	// kind *assigns* one — and the lost attempt may already have opened a session under
	// the id it was assigned, which `claude` refuses to assign twice.
	//
	// It also records *when* the machine was lost (issue #1141): the retry's wait for
	// that machine is the bounded one, measured from this loss — a new loss starts a
	// new window rather than inheriting an earlier one's.
	if (intent.carriedContinuation) {
		const { recoveryMode: carriedMode, ...rest } = carried;
		return {
			...rest,
			preservedWorkerLostTransportAt: new Date().toISOString(),
			// The one-shot `'discard'` (issue #592) is never carried, on any branch.
			...(carriedMode && carriedMode !== 'discard' ? { recoveryMode: carriedMode } : {}),
			...attemptCounterPatch(parsed, intent),
			...(intent.runId ? { runId: intent.runId } : {}),
			...pmIntentPatch(parsed, intent, parsed.resumePmPhase),
			...(parsed.resumeSession === true || carriedMode === 'resume'
				? {}
				: { agentSessionId: randomUUID() }),
			...(intent.continuationDispatchClaimed ? { continuationDispatchClaimed: true } : {}),
		};
	}
	const {
		resumePmPhase,
		resumeSession: _resumeSession,
		resumeDelivery: _resumeDelivery,
		recoveryMode,
		agentSessionId: priorSessionId,
		// This attempt ran past the gate, so the machine it waited for came back
		// (issue #1141): a later wait for it is #567's unbounded one again.
		preservedWorkerLostTransportAt: _servedLoss,
		...job
	} = carried;
	return {
		...job,
		...(recoveryMode && recoveryMode !== 'checkpoint' && recoveryMode !== 'discard'
			? { recoveryMode }
			: {}),
		// A re-check waits on an external condition, not a failure, so it spends its
		// own budget and leaves the rate-limit one untouched; every other deferral
		// consumes a rate-limit attempt as before.
		...attemptCounterPatch(parsed, intent),
		// Carry the originating run row forward (issue #136) so the retry resets
		// that same row instead of inserting a second one. `intent.runId` wins
		// over any stale value on `parsed`.
		...(intent.runId ? { runId: intent.runId } : {}),
		// Keep PM dispatch intent when this attempt already carried it, or when
		// the outcome says the phase started. Branch reuse is governed by the
		// separate durable provisioning checkpoint on `job`.
		...pmIntentPatch(job, intent, resumePmPhase),
		// Continue the prior agent session on the retry when the deferral was a
		// resumable one; separate from `resumePmPhase`, which is only the PM
		// board-dispatch signal. A non-resumable retry re-assigns instead of
		// resuming, so it needs an *unused* id: keeping the spent one made every such
		// retry of an already-started run die instantly on `claude`'s
		// already-in-use check. Minted here rather than left undefined so the id is
		// still known before the agent starts — for claude, the only CLI with an
		// assign-upfront flag, the harness falls back to it when a run dies before
		// emitting a parseable `session_id`, which is what lets Tier 1 resume a run
		// that produced no output. codex/agy ignore it and capture their own.
		...(intent.resumable
			? { resumeSession: true, ...(priorSessionId ? { agentSessionId: priorSessionId } : {}) }
			: { agentSessionId: randomUUID() }),
		// Tier 2 (issue #503): the preserved checkout is adopted on the strength of its
		// checkpoint, so the attempt runs through the recovery gate's `'checkpoint'`
		// branch — with a *fresh* session id, since a continuation carries no session to
		// re-enter and may even run on a different CLI than the stopped run did.
		...(intent.checkpointed
			? { recoveryMode: 'checkpoint' as const, agentSessionId: randomUUID() }
			: {}),
		// Delivery retries reuse a valid progress-marked worktree, independent of
		// whether the completed agent run exposed a session id.
		...(intent.resumeDelivery ? { resumeDelivery: true } : {}),
		// A prioritized continuation already holds its dispatch dedup claim; the
		// retry's handler must reuse it rather than re-claim (issue #214).
		...(intent.continuationDispatchClaimed ? { continuationDispatchClaimed: true } : {}),
	};
}

/**
 * Settle a manually rebuilt attempt's recovery mode and session, in place — the
 * half of {@link reconstructRetryJob} that decides whether the attempt re-enters a
 * session or starts one, and which stored intent it may keep.
 *
 * A stored `'discard'` is **never inherited** (issue #592). The forced reset's payload
 * is persisted onto the run row by `resetRunToRunning` when a worker claims it, so a
 * later "Retry now" — which passes no `recoveryMode` for an ordinary `failed` run —
 * would otherwise replay a *destructive* intent from an action that has no force
 * opt-in and promises nothing of the sort. `'fresh'` and `'checkpoint'` are carried as
 * before: both still refuse a dirty or unpushed checkout, so inheriting either is
 * harmless, and one-shot-ness is a property of the only mode allowed to destroy work.
 * An inherited `'checkpoint'` does also pin the dispatch to the machine holding the
 * checkout (issue #567), so `runs.retryNow` drops it when the run records no such
 * machine (issue #1101, {@link dropCheckoutContinuation}).
 */
function applyManualRecoveryIntent(
	job: SwarmJob,
	freshSession: boolean,
	recoveryMode?: RecoveryMode,
	expectedSessionId?: string | null,
): void {
	if (!recoveryMode) {
		if (job.recoveryMode === 'discard') delete job.recoveryMode;
		if (!freshSession) return;
		job.agentSessionId = randomUUID();
		delete job.resumeSession;
		return;
	}

	job.recoveryMode = recoveryMode;
	if (recoveryMode === 'resume') {
		job.resumeSession = true;
		if (expectedSessionId) job.agentSessionId = expectedSessionId;
		return;
	}
	// `'fresh'` (start over), `'checkpoint'` (continue from the checkpoint, issue
	// #503) and `'discard'` (a forced reset destroying the checkout, issue #592)
	// all run a brand-new session: none re-enters the stopped run's, and a
	// checkpoint continuation is CLI-agnostic precisely because it has no session
	// to carry, so a cli/model override composes with it.
	job.agentSessionId = randomUUID();
	delete job.resumeSession;
}

/**
 * Rebuild a retry job payload from a stored one: carry the originating `runId`
 * forward (so the retry reuses that row) and reset the rate-limit,
 * automatic-retry and worker-eligibility attempt counters to 0 (a manual retry
 * bypasses the automatic caps — including the bounded wait for a pinned machine
 * that lost its transport, issue #1141, whose loss marker it drops), drop
 * any adopted late result (issue #1076), applying any
 * cli/model overrides. Shared by "Retry now"'s reopen-existing-dispatch path,
 * its reconstruct-from-run-row fallback, and "Reset & restart".
 *
 * The stored payload is normalized first: two of those three callers pass a raw
 * `run.jobPayload` straight out of `jsonb`, so a pre-#385/#297 row would otherwise be
 * re-persisted in its legacy envelope on every manual retry and never heal.
 */
export function reconstructRetryJob(
	jobPayload: SwarmJob,
	runId: string,
	phase: string,
	cli?: AgentCli,
	model?: string,
	reasoning?: ReasoningLevel,
	freshSession = false,
	recoveryMode?: RecoveryMode,
	expectedSessionId?: string | null,
): SwarmJob {
	const job = { ...normalizeStoredJobPayload(jobPayload) };
	job.runId = runId;
	job.rateLimitRetryAttempt = 0;
	job.automaticRetryAttempt = 0;
	job.workerEligibilityRecheckAttempt = 0;
	// The stored payload may be the one an attempt ran with after the machine it was
	// pinned to came back, so its loss marker says nothing about now (issue #1141): a
	// manual retry waits for its pinned machine on #567's unbounded wait — which the
	// run-detail callout states — with "Reset & restart" as the way out.
	delete job.preservedWorkerLostTransportAt;
	// A manual retry runs the phase; it never re-settles a late result an earlier
	// attempt was adopted with (issue #1076).
	delete job.adoptedResult;
	if (job.type === 'pm' && (phase === 'planning' || phase === 'implementation')) {
		job.resumePmPhase = phase;
	}
	if (cli) job.cliOverride = cli;
	if (model) job.modelOverride = model;
	if (reasoning) job.reasoningOverride = reasoning;
	applyManualRecoveryIntent(job, freshSession, recoveryMode, expectedSessionId);
	return job;
}

/**
 * The manual retry's payload with every **checkout-continuation** intent removed
 * (issue #1101): `recoveryMode` when it is `'resume'`/`'checkpoint'`, `resumeSession`,
 * `resumeDelivery`, and `implementationBranchProvisioned` (issue #1197) — exactly the
 * fields `jobContinuesPreservedCheckout` reads, so the result is never pinned to a
 * machine, and Implementation cuts its branch afresh rather than expecting one that
 * may exist only on an unrecorded machine. Everything else (the fresh `agentSessionId`
 * {@link reconstructRetryJob} minted, `resumePmPhase`, overrides, zeroed budgets) is
 * kept: the attempt is the ordinary from-scratch retry a fresh-start "Retry now"
 * already is. `'fresh'` is left in place — it is the escape hatch, not a continuation.
 */
export function dropCheckoutContinuation(job: SwarmJob): SwarmJob {
	const next = { ...job };
	if (next.recoveryMode === 'resume' || next.recoveryMode === 'checkpoint') {
		delete next.recoveryMode;
	}
	delete next.resumeSession;
	delete next.resumeDelivery;
	delete next.implementationBranchProvisioned;
	return next;
}

/**
 * Rebuild a **reset's** replacement payload from a stored one (issue #741): the
 * phase's dispatch intent and bookkeeping are carried, and every piece of
 * resumption state is dropped, so the restart is composed exactly as a first
 * attempt is.
 *
 * This is not a flag on {@link reconstructRetryJob} because the two builders now
 * disagree on purpose. A manual retry *may* re-enter a session, adopt a preserved
 * checkout, and inherit a stored `'resume'`/`'fresh'`/`'checkpoint'`; a reset may do
 * none of that — "Reset & restart" promises the operator that the phase starts over.
 * Building it on the retry helper is what produced the reported failure: a stored
 * `implementationBranchProvisioned: true` survived every reset of run 2d3df9b3, so
 * each restart re-provisioned with `createBranch: false` against a branch that no
 * longer existed and died on `fatal: invalid reference: issue-719`, while an ordinary
 * fresh dispatch of the same task ran fine.
 *
 * What *is* carried is dispatch intent rather than resumption: `runId` (so the reset
 * reuses that row), zeroed rate-limit and automatic-retry budgets (a manual action
 * bypasses the automatic caps), and `resumePmPhase` for a board phase — which records only *which
 * phase this dispatch is*, after the card already moved to In progress, and makes the
 * run adopt no checkout, branch, or session.
 *
 * `recoveryMode` is the reset's **own** intent and nothing else: `'discard'` for a
 * forced reset, whose worker-side teardown is the only way a checkout on another host
 * is reached (issue #592), and absent for a plain one, which leaves the worker's
 * ordinary reclaim gate and its protections in place. It is applied *after* the strip,
 * so the mode the caller asks for is never removed along with the stored one.
 *
 * The stored payload is normalized first, exactly as the retry path does it: a reset
 * reads a raw `run.jobPayload` straight out of `jsonb`, so a pre-#385/#297 row heals
 * here instead of being re-persisted in its legacy envelope.
 */
export function reconstructResetJob(
	jobPayload: SwarmJob,
	runId: string,
	phase: string,
	recoveryMode?: RecoveryMode,
): SwarmJob {
	const job = stripRecoveryIntent(normalizeStoredJobPayload(jobPayload));
	job.runId = runId;
	job.rateLimitRetryAttempt = 0;
	job.automaticRetryAttempt = 0;
	delete job.adoptedResult;
	if (job.type === 'pm' && (phase === 'planning' || phase === 'implementation')) {
		job.resumePmPhase = phase;
	}
	// A fresh id is *assigned*, never resumed — the strip above removed the stored one,
	// and an id `claude` has already opened a session under cannot be assigned a second
	// time. Minted rather than left absent for the same reason `deriveRetryJobPayload`
	// mints one: it is what lets Tier 1 name a run that dies before emitting a
	// parseable `session_id`.
	job.agentSessionId = randomUUID();
	if (recoveryMode) job.recoveryMode = recoveryMode;
	return job;
}

/**
 * The payload an event-woken **pre-run** wait defers with — a task whose earlier
 * phase has not settled (`task-in-flight`: still executing, issue #759, or a
 * Planning dispatch an Implementation must not overtake, issue #761), a writing
 * phase behind another on the same pull request (`pr-in-flight`, issue #850), or a
 * ticket refused by its repository's WIP limit (`wip-limit`, issue #1185): the
 * attempt counter is *not* consumed (waiting on a slot or on a sibling phase isn't
 * a failure), but PM dispatch intent and the held dedup claim are
 * recorded so the eventual wake-up re-enters its original phase unambiguously even
 * after status-dedup TTLs expire.
 */
export function derivePreRunPendingPayload(
	parsed: SwarmJob,
	intent: DeferredRetryIntent,
): SwarmJob {
	return {
		...parsed,
		...(intent.runId ? { runId: intent.runId } : {}),
		...(parsed.type === 'pm' && (intent.phase === 'planning' || intent.phase === 'implementation')
			? { resumePmPhase: intent.phase }
			: {}),
		...(intent.continuationDispatchClaimed ? { continuationDispatchClaimed: true } : {}),
	};
}
