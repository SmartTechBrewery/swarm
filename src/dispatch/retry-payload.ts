/**
 * Pure derivation of a deferred dispatch's next-attempt payload (issue #284;
 * previously buried in `src/worker/deferred-retry.ts`'s enqueue path). The
 * worker persists this payload on the dispatch row *when it settles the
 * deferral* — before any queue work — so the retry intent survives a crash
 * between settle and wake-up publication, instead of living only inside a
 * fire-and-forget BullMQ handler.
 *
 * It also owns {@link reconstructRetryJob}, the *manual* counterpart: the
 * payload an operator-driven attempt runs with. It lives here rather than in
 * the tRPC router so both operator paths — "Retry now" (`runs.retryNow`) and
 * "Reset & restart" (`src/dispatch/run-reset.ts`, issue #424) — rebuild an
 * attempt the same way.
 */

import { randomUUID } from 'node:crypto';
import type { AgentCli } from '../harness/agent-cli.js';
import type { ReasoningLevel } from '../harness/models.js';
import { normalizeStoredJobPayload, type SwarmJob } from '../queue/jobs.js';
import type { TriggerPhase } from '../triggers/types.js';

/** The slice of a `phase-deferred` outcome the payload derivation needs. */
export interface DeferredRetryIntent {
	phase: TriggerPhase;
	runId?: string;
	/** Resume the preserved agent session on retry (rate-limit/timeout/stalled). */
	resumable: boolean;
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
	 * This is a worker-eligibility re-check deferral (issue #339), not an agent
	 * failure: no eligible worker could take the dispatch, so it consumes the
	 * separate {@link SwarmJob.workerEligibilityRecheckAttempt} budget while it
	 * waits for a worker to free up (or for consent/enrollment to be granted).
	 */
	workerEligibilityRecheck?: boolean;
}

/**
 * Which attempt counter this deferral spends. The two token-free re-checks
 * (dependency, worker eligibility) each have their own budget so a long wait on
 * one can't exhaust the other or the small rate-limit budget; every other
 * deferral is a failure retry and consumes the rate-limit one as before.
 */
function attemptCounterPatch(
	job: SwarmJob,
	intent: DeferredRetryIntent,
): {
	dependencyRecheckAttempt?: number;
	workerEligibilityRecheckAttempt?: number;
	rateLimitRetryAttempt?: number;
} {
	if (intent.dependencyRecheck) {
		return { dependencyRecheckAttempt: (job.dependencyRecheckAttempt ?? 0) + 1 };
	}
	if (intent.workerEligibilityRecheck) {
		return { workerEligibilityRecheckAttempt: (job.workerEligibilityRecheckAttempt ?? 0) + 1 };
	}
	return { rateLimitRetryAttempt: (job.rateLimitRetryAttempt ?? 0) + 1 };
}

/**
 * The payload a scheduled retry runs with. Retry intent is derived from this
 * outcome — a stale flag from an earlier queued job must not turn a
 * pre-provisioning capacity retry into a branch resume, so the prior
 * `resumePmPhase`/`resumeSession`/`resumeDelivery` flags are dropped and
 * re-derived.
 */
export function deriveRetryJobPayload(parsed: SwarmJob, intent: DeferredRetryIntent): SwarmJob {
	const {
		resumePmPhase,
		resumeSession: _resumeSession,
		resumeDelivery: _resumeDelivery,
		...job
	} = parsed;
	return {
		...job,
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
		...((intent.pmPhaseStarted || resumePmPhase !== undefined) &&
		job.type === 'pm' &&
		(intent.phase === 'planning' || intent.phase === 'implementation')
			? { resumePmPhase: intent.phase }
			: {}),
		// Continue the prior agent session on the retry when the deferral was a
		// resumable one; separate from `resumePmPhase`, which is only the PM
		// board-dispatch signal.
		...(intent.resumable ? { resumeSession: true } : {}),
		// Delivery retries reuse a valid progress-marked worktree, independent of
		// whether the completed agent run exposed a session id.
		...(intent.resumeDelivery ? { resumeDelivery: true } : {}),
		// A prioritized continuation already holds its dispatch dedup claim; the
		// retry's handler must reuse it rather than re-claim (issue #214).
		...(intent.continuationDispatchClaimed ? { continuationDispatchClaimed: true } : {}),
	};
}

/**
 * Rebuild a retry job payload from a stored one: carry the originating `runId`
 * forward (so the retry reuses that row) and reset the rate-limit attempt
 * counter to 0 (a manual retry bypasses the automatic cap), applying any
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
	recoveryMode?: 'resume' | 'fresh',
	expectedSessionId?: string | null,
): SwarmJob {
	const job = { ...normalizeStoredJobPayload(jobPayload) };
	job.runId = runId;
	job.rateLimitRetryAttempt = 0;
	if (job.type === 'pm' && (phase === 'planning' || phase === 'implementation')) {
		job.resumePmPhase = phase;
	}
	if (cli) job.cliOverride = cli;
	if (model) job.modelOverride = model;
	if (reasoning) job.reasoningOverride = reasoning;
	if (recoveryMode) {
		job.recoveryMode = recoveryMode;
		if (recoveryMode === 'resume') {
			job.resumeSession = true;
			if (expectedSessionId) job.agentSessionId = expectedSessionId;
		} else {
			job.agentSessionId = randomUUID();
			delete job.resumeSession;
		}
	} else if (freshSession) {
		job.agentSessionId = randomUUID();
		delete job.resumeSession;
	}
	return job;
}

/**
 * The payload a project-capacity-blocked dispatch waits with: the attempt
 * counter is *not* consumed (waiting on a slot isn't a failure), but PM
 * dispatch intent and the held dedup claim are recorded so the eventual wake-up
 * re-enters its original phase unambiguously even after status-dedup TTLs
 * expire.
 */
export function deriveCapacityPendingPayload(
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
