/**
 * `pr-review` trigger — the PR-lifecycle handler. It starts the Review phase
 * (`src/pipeline/review.ts`) when a PR is opened or its checks pass, and routes
 * a *failing* check suite to the Respond-to-CI phase (`src/pipeline/respond-to-ci.ts`),
 * mirroring Cascade's review-agent + respond-to-ci triggers on `check_suite`
 * completion (ai/ARCHITECTURE.md "Pipeline phases" #3 / respond-to-ci).
 *
 * Two entry events, one handler:
 *  - `pull-request` `opened` (non-draft) — review the freshly opened PR.
 *  - `checks` `completed` — review the commit CI just validated (why the phase
 *    pins its checkout to the head SHA), or fix it if CI failed.
 *
 * **The `opened` dispatch races the Implementation phase's own wrap-up — by
 * design.** The implementer opens the PR (`gh pr create`) as one of its last
 * actions *inside* its still-running agent process, so GitHub delivers
 * a `pull-request` `opened` event — and this handler dispatches Review — a few
 * seconds before the Implementation phase logs its own `Phase finished` and moves
 * the board. In an interleaved log, when several phases run concurrently, that
 * reads as "Review started before Implementation finished", which looks like an
 * out-of-order pipeline but isn't: Review provisions its *own* detached worktree
 * at the head SHA and touches nothing the implementer owns, and if the implementer
 * pushes further commits after opening the PR, their `checks` event re-enters here
 * and re-reviews at the final SHA (the PR+SHA dedup keys on the new commit, so the
 * later review isn't dropped). No serialization needed; the per-run `logContext`
 * (`taskId`/`phase` on every `agent run finished` line) is what disambiguates the
 * interleave.
 *
 * **Aggregate check state, not this event's conclusion.** A provider fires one
 * check-completion event per workflow, so any single event's own `conclusion`
 * describes only its own suite while siblings may still be running. On a `checks`
 * event the handler re-queries *every* check on the head SHA
 * (`SCMProvider.getAggregateCheckStatus`) and decides via
 * `decideAggregateCheckOutcome` (`aggregate-check-decision.ts`): review if all
 * complete and none failed, respond-to-ci if a check failed, or **defer** if some
 * check is still incomplete. Ported from Cascade's `check-suite-success`/`-failure`
 * triggers. A zero-check head defers too, under the default
 * `pipeline.review.checks: 'required'` policy — a project with no CI at all can
 * instead set `'if-present'` to review immediately on zero checks (issue #274).
 *
 * **Respond-to-CI loop guard.** Fixing a build pushes a commit → a new head SHA
 * → a fresh `checks` event, so if the fix doesn't stick the same PR routes back
 * here. The PR+SHA dedup can't stop that (each attempt is a new SHA), so
 * `dispatchRespondToCi` adds a per-PR fix-attempt cap (`respond-to-ci-attempts.ts`)
 * that winds a never-sticking fix down to a warn-and-drop, mirroring Cascade's
 * `MAX_ATTEMPTS`.
 *
 * **Deferred recheck, on two separate budgets** (issue #720). A defer schedules
 * a coalesced re-enqueue of this same event (`scheduleCoalescedDispatch`), and
 * which allowance it spends is decided by *why* the handler could not decide —
 * not by which scheduler ran:
 *  - `state-pending` — the provider answered and its answer is not final yet: a
 *    check still `in_progress`, no checks registered on the head, `mergeable`
 *    still `null`. Guards the case where the provider's checks API lags webhook
 *    delivery (the suite reports complete over the webhook, but a query moments
 *    later still shows it running, and no further webhook will arrive to wake
 *    us). Fixed ~30s cadence, capped by `recheckAttempt`/{@link MAX_CHECK_RECHECKS}.
 *  - `read-failed` — the read never answered at all: the provider threw (a
 *    transient checks-API error, a 5xx/rate-limit, an unresolvable reviewer
 *    token) or the run-history lookup threw. Degrading to a defer keeps the
 *    throw from escaping `handle` and burning the job's BullMQ retries; it draws
 *    on `readFailureRecheckAttempt`/{@link MAX_READ_FAILURE_RECHECKS} with its
 *    own capped exponential backoff, so a provider that is not there is
 *    outlasted rather than hammered.
 *
 * Keeping them apart is the point: one shared counter let a source-control
 * outage spend the allowance reserved for CI that is still running, and the
 * synthetic follow-up Review (`src/pipeline/follow-up-review.ts`), which has no
 * later webhook to fall back on, was dropped. A `read-failed` defer therefore
 * carries `recheckAttempt` through untouched, and a defer that *did* get an
 * answer clears the read-failure count.
 *
 * **A closed pull request stops a chain before either budget is touched**
 * (issue #772). The mergeability gate reads `PullRequestDetails.state` and skips
 * outright once the PR is closed or merged, because no provider reports a final
 * `mergeable` for one — so a chain still in flight when the PR merges would
 * otherwise poll to its cap and record a give-up for work that already finished.
 * That is a plain skip, not an abandonment: the give-up records below exist for a
 * provider that failed to answer, not for a question that stopped mattering.
 *
 * **Exhausting either budget leaves a durable trace** (issue #742). Whichever
 * path gives up — mergeability or aggregate-check — writes one `failed` Review
 * run to SWARM's own Postgres naming the PR, head SHA, exhausted budget,
 * attempts spent and last read (`recordAbandonedReview`). It is written there
 * rather than posted to the provider because the give-up is usually caused by
 * that provider being unreachable; the pull-request comment stays a best-effort
 * extra, and the row is retryable from the dashboard.
 *
 * **Same-repo gate.** Fork PRs are dropped (`pull-request` events, via
 * `isCrossRepo`): the Review phase's `provision` fetches only the base repo's
 * refs, so a fork's head SHA is unreachable and the detached checkout would
 * fail the job (see `src/pipeline/review.ts`'s header). A `checks` payload
 * doesn't reliably tell us fork-ness, so that path can't pre-filter forks — an
 * unreachable SHA there surfaces as a failed job rather than a silent drop.
 *
 * **Work-item origin gate.** SWARM reviews only PRs it manages itself: a
 * human- or third-party-authored PR completing its checks (or being opened) must
 * not burn a review. Ownership is decided from the PR's *work-item origin*, not
 * its author — its head branch must be exact `<branchPrefix><taskId>`
 * and SWARM must hold an `implementation` run row for that item
 * (`isSwarmManagedPullRequest`, `../swarm-managed-pr.ts`). Author identity no
 * longer carries the signal: under the federated model (ADR-004 §3, issue #397)
 * a SWARM PR is opened by the worker operator's own account, so the former
 * persona-login gate skipped every federated PR. The gate runs once for both
 * entry events, inside `checkMergeabilityAndConflicts` — which already fetches
 * the PR (and so its head branch) for the mergeability check — and therefore
 * still precedes the heavier aggregate checks-API query on the `checks`
 * path, which no longer needs an author PR read at all. The configurable
 * own/external/all `authorMode` and base-branch gate Cascade exposes stay out of
 * scope: SWARM only ever acts on its own output, so there is nothing to
 * configure.
 *
 * **Cross-process dedup.** A PR that opens *and* then passes checks (or a PR
 * with several check suites) would otherwise dispatch Review more than once for
 * the same head SHA, each burning agent tokens. `handle` claims a Redis-backed
 * slot keyed on the PR+SHA (`review-dispatch-dedup.ts`) before returning a
 * dispatch; a duplicate claim short-circuits to a skip. The claim happens here,
 * at the single dispatch-decision point, so the duplicate is dropped before any
 * worktree is provisioned.
 */

import type { ProjectConfig } from '../../config/schema.js';
import {
	REVIEW_VERDICT_CAP,
	reserveReviewVerdict,
} from '../../db/repositories/reviewVerdictsRepository.js';
import { createFailedRun } from '../../db/repositories/runsRepository.js';
import { scheduleCoalescedDispatch } from '../../dispatch/dispatcher.js';
import { logger } from '../../lib/logger.js';
import type { SwarmJob } from '../../queue/jobs.js';
import type { ScmEvent } from '../../scm/events.js';
import { SWARM_GENERATED_FOOTER } from '../../scm/swarm-origin.js';
import type { AggregateCheckStatus, PullRequestDetails, SCMProvider } from '../../scm/types.js';
import { buildConflictResolutionKey, claimConflictResolution } from '../resolve-conflicts-dedup.js';
import { buildRespondToCiAttemptKey, claimRespondToCiAttempt } from '../respond-to-ci-attempts.js';
import { buildReviewDispatchKey, claimReviewDispatch } from '../review-dispatch-dedup.js';
import { resolveSwarmManagedPr, type SwarmManagedPrResult } from '../swarm-managed-pr.js';
import type { ScmTriggerContext, TriggerContext, TriggerHandler, TriggerResult } from '../types.js';
import { decideAggregateCheckOutcome } from './aggregate-check-decision.js';

/**
 * What a shape-matched event resolves to once its per-event-kind gate has run.
 * A `checks` event whose checks all passed → `review`; one where a check failed →
 * `respond-to-ci` (carrying the failing run names for the dispatch log); a
 * draft/fork PR or an incomplete/deferred suite → `none`.
 */
type ReviewDisposition =
	| { kind: 'review' }
	| { kind: 'respond-to-ci'; failedChecks: string[] }
	| { kind: 'none' };

function isDispositionDisabled(
	project: ProjectConfig,
	disposition: Exclude<ReviewDisposition, { kind: 'none' }>,
	prNumber?: string,
	headSha?: string,
): boolean {
	if (disposition.kind === 'review' && project.pipeline?.review?.enabled === false) {
		logger.debug('review: phase disabled — skipping', { prNumber, headSha });
		return true;
	}
	if (disposition.kind === 'respond-to-ci' && project.pipeline?.respondToCi?.enabled === false) {
		logger.debug('respond-to-ci: phase disabled — skipping', { prNumber, headSha });
		return true;
	}
	return false;
}

/** How long to wait before re-querying check state when the checks API looks stale. */
const RECHECK_DELAY_MS = 30_000;

/**
 * Cap on deferred rechecks per job for a `state-pending` defer — the provider
 * answered, its answer is not final yet. ~10 min of checks-API lag at
 * {@link RECHECK_DELAY_MS}, well beyond any real lag.
 *
 * Past it a *webhook-driven* review is re-triggered anyway by the fresh `checks`
 * webhook every completing suite emits, so there the cap only stops a
 * pathological self-reschedule loop. That argument does **not** cover the
 * synthetic follow-up Review a `fixed` Respond-to-review enqueues
 * (`src/pipeline/follow-up-review.ts`, issue #241): SWARM enqueues that one
 * itself and no later webhook is guaranteed, so exhausting this budget there
 * does drop a legitimate review. Which is exactly why a *failed read* no longer
 * spends it (issue #720) — it draws on {@link MAX_READ_FAILURE_RECHECKS}.
 */
const MAX_CHECK_RECHECKS = 20;

/**
 * Cap on deferred rechecks per job for a `read-failed` defer — the read never
 * answered (issue #720). Its own budget, so a source-control outage can no
 * longer draw down the CI-lag allowance above: on PR #694 seventeen of twenty
 * attempts went to a DNS failure and the follow-up Review was dropped with it.
 * Still bounded — a provider that never comes back must wind down to one warn
 * rather than reschedule forever.
 */
const MAX_READ_FAILURE_RECHECKS = 15;

/** First read-failure backoff step; doubles per attempt up to {@link READ_FAILURE_MAX_DELAY_MS}. */
const READ_FAILURE_BASE_DELAY_MS = 30_000;
const READ_FAILURE_MAX_DELAY_MS = 300_000;

/**
 * Capped exponential backoff for a read-failure recheck: 30s, 1m, 2m, 4m, then
 * 5m — about 62 minutes of provider unavailability outlasted over the full
 * {@link MAX_READ_FAILURE_RECHECKS} budget, at 15 cheap single reads rather than
 * a fixed-cadence hammering of a provider that is not answering.
 */
function readFailureRecheckDelayMs(attemptsSpent: number): number {
	return Math.min(READ_FAILURE_BASE_DELAY_MS * 2 ** attemptsSpent, READ_FAILURE_MAX_DELAY_MS);
}

/**
 * Which allowance a defer draws on, classified by *why* the handler could not
 * decide rather than by which scheduler runs (issue #720).
 */
type DeferBudget =
	/** The provider answered; the answer is not final yet — a check still running, `mergeable` unknown. */
	| 'state-pending'
	/** The read never answered — the provider threw, or the run-history lookup threw. */
	| 'read-failed';

/** How each exhausted budget reads to an operator in the durable give-up record. */
const ABANDONED_REVIEW_REASONS: Record<DeferBudget, string> = {
	'read-failed': 'the source-control provider never answered',
	'state-pending': 'the source-control provider never reported a final state',
};

/**
 * This event's job payload carrying **no recheck counters** — the shape the
 * recheck scheduler extends, and the one the abandonment record below stores, so
 * that a "Retry now" on that record re-enters this handler with a clean budget
 * rather than one already at its cap.
 */
function baseReviewJobPayload(ctx: ScmTriggerContext): SwarmJob {
	return {
		type: 'scm',
		providerId: ctx.providerId,
		projectId: ctx.project.id,
		...(ctx.deliveryId ? { deliveryId: ctx.deliveryId } : {}),
		event: ctx.event,
	};
}

/**
 * Record a terminal give-up as a durable `failed` Review run (issue #742) — the
 * notice an operator actually finds when asking why an item stopped.
 *
 * It is written to SWARM's own Postgres rather than posted to the provider
 * precisely because the give-up that produces it is usually *caused* by that
 * provider being unreachable: in the incident behind issue #720 the give-up
 * comment failed against the same DNS failure that had exhausted the budget, the
 * dispatch settled as an ordinary `no-trigger`, and the abandoned review left no
 * trace anywhere. The pull-request comment ({@link scmCommentReviewGaveUp}) stays
 * a best-effort extra on top of this.
 *
 * The row carries the repository, PR, phase and head SHA already, names which
 * budget ran out, how many attempts it spent and what the last read reported —
 * and, because it stores this event's payload, `runs.retryNow` re-runs the
 * review decision from the dashboard on a fresh budget.
 *
 * Bookkeeping, so it swallows and logs its own failures: a throw here would
 * escape `handle` into `processJob`'s untried region and fail the job.
 */
async function recordAbandonedReview(
	ctx: ScmTriggerContext,
	budget: DeferBudget,
	prNumber: string,
	headSha: string,
	attemptsSpent: number,
	cap: number,
	details: Record<string, unknown>,
): Promise<void> {
	const lastRead = Object.entries(details)
		.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
		.join('; ');
	try {
		await createFailedRun({
			projectId: ctx.project.id,
			repository: ctx.project.repo,
			// The Review phase's own task id, so the record sits with the rest of this
			// PR's history rather than under an id nothing else uses.
			taskId: prNumber,
			phase: 'review',
			prNumber,
			jobPayload: baseReviewJobPayload(ctx),
			error:
				`Review abandoned: ${ABANDONED_REVIEW_REASONS[budget]}. ` +
				`PR #${prNumber} at ${headSha}; the ${budget} recheck budget is spent (${attemptsSpent}/${cap} attempts).` +
				(lastRead ? ` Last read — ${lastRead}.` : ''),
		});
	} catch (err) {
		logger.error('review: failed to record the abandoned review run', {
			budget,
			prNumber,
			headSha,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Schedule a coalesced re-enqueue of this event on `budget`'s allowance, or
 * report that the allowance is spent. Returns `false` (already logged) on the
 * latter, so each caller keeps its own terminal handling.
 *
 * Both counters travel on the replacement payload and only the chosen budget's
 * advances: a `read-failed` defer carries `recheckAttempt` through **untouched**
 * — the whole point of the split — while a `state-pending` defer omits the
 * read-failure count entirely, clearing it because the provider demonstrably
 * answered. As before, the payload deliberately carries no `runId` or
 * `continuationDispatchClaimed`: the recheck re-enters the handler as a fresh
 * decision.
 */
async function scheduleReviewRecheck(
	ctx: ScmTriggerContext,
	budget: DeferBudget,
	coalesceKey: string,
	prNumber: string,
	headSha: string,
	details: Record<string, unknown>,
): Promise<boolean> {
	const readFailed = budget === 'read-failed';
	const checkAttempt = ctx.recheckAttempt ?? 0;
	const readFailureAttempt = ctx.readFailureRecheckAttempt ?? 0;
	const attemptsSpent = readFailed ? readFailureAttempt : checkAttempt;
	const cap = readFailed ? MAX_READ_FAILURE_RECHECKS : MAX_CHECK_RECHECKS;
	if (attemptsSpent >= cap) {
		logger.warn('review: giving up on deferred recheck (cap reached)', {
			budget,
			prNumber,
			headSha,
			attemptsSpent,
			cap,
			coalesceKey,
			...details,
		});
		// Both terminal give-up paths — the mergeability one and the aggregate-check
		// one — funnel through this branch, so the durable trace is written once,
		// here, rather than repeated at (and forgettable from) each caller.
		await recordAbandonedReview(ctx, budget, prNumber, headSha, attemptsSpent, cap, details);
		return false;
	}

	const nextCheckAttempt = readFailed ? checkAttempt : checkAttempt + 1;
	const delayMs = readFailed ? readFailureRecheckDelayMs(readFailureAttempt) : RECHECK_DELAY_MS;
	await scheduleCoalescedDispatch(
		{
			...baseReviewJobPayload(ctx),
			...(nextCheckAttempt > 0 ? { recheckAttempt: nextCheckAttempt } : {}),
			...(readFailed ? { readFailureRecheckAttempt: readFailureAttempt + 1 } : {}),
		},
		coalesceKey,
		delayMs,
	);
	logger.debug('review: scheduled deferred recheck', {
		budget,
		prNumber,
		headSha,
		recheckAttempt: nextCheckAttempt,
		readFailureRecheckAttempt: readFailed ? readFailureAttempt + 1 : 0,
		delayMs,
		coalesceKey,
		...details,
	});
	return true;
}

/**
 * True when the event is a review entry point by *shape* — an opened/updated PR
 * or completed checks. The draft/fork/aggregate-CI specifics are decided in
 * `handle` so a near-miss can fall through to the registry's next handler.
 */
function matchesReviewShape(ctx: TriggerContext): boolean {
	if (ctx.source !== 'scm') return false;
	const { event } = ctx;
	if (event.kind === 'pull-request' && (event.action === 'opened' || event.action === 'updated')) {
		return true;
	}
	if (event.kind === 'checks' && event.action === 'completed') return true;
	return false;
}

/**
 * The `pull-request`-only gate: a non-draft, same-repo PR is reviewable. Logs
 * and returns `none` on a near-miss so `handle` can fall through to the
 * registry's next handler. A `pull-request` event never routes to Respond-to-CI
 * — that path is driven only by failed `checks`.
 *
 * Defensively duplicates `checkMergeabilityAndConflicts`'s own draft/fork early
 * return; the work-item origin gate already ran there for both entry events.
 */
function isReviewablePullRequest(event: ScmEvent, prNumber: string): ReviewDisposition {
	if (event.isDraft) {
		logger.debug('review: PR is a draft — skipping', { prNumber });
		return { kind: 'none' };
	}
	if (event.isCrossRepo) {
		logger.debug('review: fork PR — skipping (head SHA unreachable for review)', { prNumber });
		return { kind: 'none' };
	}
	return { kind: 'review' };
}

/**
 * Schedule a bounded, coalesced recheck of this `checks` event on `budget`'s
 * allowance, or give up once that allowance is spent. Always returns
 * `{ kind: 'none' }` — the event is fully handled here whether a recheck was
 * queued or the cap stopped the loop. Shared by the two defer paths in
 * {@link resolveAggregateCheckReview}: some check still incomplete
 * (`state-pending`), and a failed aggregate query (`read-failed`). `details` is
 * merged into the log line so each caller records why it deferred.
 */
async function scheduleCheckRecheck(
	ctx: ScmTriggerContext,
	budget: DeferBudget,
	prNumber: string,
	headSha: string,
	details: Record<string, unknown>,
): Promise<ReviewDisposition> {
	const coalesceKey = `check-suite:${ctx.project.repo}:${prNumber}:${headSha}`;
	await scheduleReviewRecheck(ctx, budget, coalesceKey, prNumber, headSha, details);
	return { kind: 'none' };
}

/**
 * Decide a `checks` event's fate from the head SHA's *aggregate* check state.
 * Returns `review` to proceed to review, `respond-to-ci` when a check failed
 * (routing the PR to the build-fix phase), or `none` when the event is handled
 * here (an incomplete suite's recheck scheduled, or a bounded give-up). The
 * aggregate query runs as the provider's default read persona — the reviewer,
 * read-only, and the persona whose review follows.
 *
 * The query resolves a credential and hits the provider's checks API, so it can
 * throw — a transient 5xx/rate-limit/network blip, or a project with no
 * resolvable reviewer token. That throw must not escape `handle`: it would land
 * outside `processJob`'s `runPhase`-only try/catch, failing the job and burning
 * its BullMQ retries re-running this same query (an implementer-token-only
 * project would fail+retry on *every* `checks` event). We degrade to a
 * bounded recheck instead — Cascade skips on error; we defer so a transient blip
 * can't silently drop a legitimate review, and the cap winds a persistent
 * failure down to one warn+drop rather than a retry storm. That degrade spends
 * the `read-failed` budget, not the CI-lag one (issue #720).
 */
async function resolveAggregateCheckReview(
	ctx: ScmTriggerContext,
	prNumber: string,
	headSha: string,
): Promise<ReviewDisposition> {
	const { project } = ctx;

	let checkStatus: AggregateCheckStatus;
	try {
		checkStatus = await ctx.scm.getAggregateCheckStatus(project, headSha);
	} catch (err) {
		return scheduleCheckRecheck(ctx, 'read-failed', prNumber, headSha, {
			reason: 'aggregate query failed',
			error: err instanceof Error ? err.message : String(err),
		});
	}

	const checksPolicy = project.pipeline?.review?.checks ?? 'required';
	const decision = decideAggregateCheckOutcome(checkStatus, prNumber, checksPolicy);
	if (decision.action === 'review') return { kind: 'review' };

	if (decision.action === 'respond-to-ci') {
		return { kind: 'respond-to-ci', failedChecks: decision.failedChecks };
	}

	// defer — some check is still incomplete; re-query fresh API state shortly.
	return scheduleCheckRecheck(ctx, 'state-pending', prNumber, headSha, {
		incompleteChecks: decision.incompleteChecks,
	});
}

/**
 * What a shape-matched event resolves to, routing to the per-event-kind gate: a
 * `pull-request`'s draft/fork check (`review`/`none`), or a `checks` event's
 * aggregate-CI decision (`review`/`respond-to-ci`/`none`, and it may defer a
 * recheck in place).
 */
function resolveDisposition(
	ctx: ScmTriggerContext,
	prNumber: string,
	headSha: string,
): ReviewDisposition | Promise<ReviewDisposition> {
	if (ctx.event.kind === 'pull-request') {
		return isReviewablePullRequest(ctx.event, prNumber);
	}
	return resolveAggregateCheckReview(ctx, prNumber, headSha);
}

/**
 * Turn a resolved `respond-to-ci` disposition into a dispatch. The PR+SHA dedup
 * slot is already claimed by the caller; a fresh dispatch adds the per-PR
 * fix-attempt cap (`claimRespondToCiAttempt`) — the guard the per-SHA dedup
 * can't provide, since each fix commit is a new SHA. A prioritized retry reuses
 * the attempt already counted before its concurrency deferral. Returns `null`
 * (not a dispatch) when the cap is hit or the PR branch is missing.
 */
async function dispatchRespondToCi(
	project: ProjectConfig,
	event: ScmEvent,
	prNumber: string,
	headSha: string,
	failedChecks: string[],
	continuationDispatchClaimed: boolean,
): Promise<TriggerResult | null> {
	if (!event.prBranch) {
		// A `checks` payload should carry its PR's head ref; without it the
		// fix phase has no branch to check out and push to.
		logger.warn('respond-to-ci: check event carries no PR branch — skipping', {
			prNumber,
			headSha,
		});
		return null;
	}

	let attempt: number | undefined;
	if (!continuationDispatchClaimed) {
		const attemptKey = buildRespondToCiAttemptKey(project.repo, prNumber);
		const claim = await claimRespondToCiAttempt(attemptKey, { prNumber, headSha });
		if (!claim.allowed) return null;
		attempt = claim.attempt;
	}

	logger.debug('respond-to-ci: dispatching Respond-to-CI phase', {
		prNumber,
		headSha,
		prBranch: event.prBranch,
		...(attempt === undefined ? {} : { attempt }),
		failedChecks,
	});
	// Suffixed, not bare `prNumber` — see the matching comment in
	// `handlers/respond-to-review.ts`: a shared taskId with the Review phase's
	// own `task-<prNumber>` worktree would let a still-running review of an
	// earlier SHA on this PR collide with this CI fix's `provision` call.
	return {
		phase: 'respond-to-ci',
		taskId: `${prNumber}-ci`,
		prNumber,
		prBranch: event.prBranch,
		headSha,
	};
}

/**
 * Reserve (or reuse) this PR/head's durable review-verdict slot — the
 * review-verdict safety cap (issue #235) — after the Redis dispatch dedup claim
 * and before returning a `review` dispatch. Only the `review` disposition
 * reserves a slot: Respond-to-CI shares the same PR+SHA dedup key but never
 * consumes a review verdict.
 *
 * Fails closed: a `blocked` (another head's reservation is still pending) or
 * `capped` (every permitted verdict already submitted) result skips the dispatch, as
 * does a persistence error — a re-review the ledger can't currently account
 * for must not run ahead of it. A `reserved`/`reused` result (the common
 * case, including a same-head retry) proceeds.
 */
async function reserveDurableReviewSlot(
	project: ProjectConfig,
	prNumber: string,
	headSha: string,
): Promise<boolean> {
	try {
		const reservation = await reserveReviewVerdict({
			projectId: project.id,
			repository: project.repo,
			prNumber,
			headSha,
		});
		if (reservation.status === 'blocked') {
			logger.debug('review: another review for this PR is still pending — skipping', {
				prNumber,
				headSha,
				pendingOrdinal: reservation.ordinal,
			});
			return false;
		}
		if (reservation.status === 'reused' && reservation.state === 'submitted') {
			logger.debug('review: slot already submitted for this head SHA — skipping same-head retry', {
				prNumber,
				headSha,
				ordinal: reservation.ordinal,
			});
			return false;
		}
		if (reservation.status === 'capped') {
			logger.warn('review: PR already used every permitted verdict — skipping (safety cap)', {
				prNumber,
				headSha,
				cap: REVIEW_VERDICT_CAP,
			});
			return false;
		}
		logger.debug('review: reserved durable review-verdict slot', {
			prNumber,
			headSha,
			ordinal: reservation.ordinal,
			reused: reservation.status === 'reused',
			capOverride: reservation.status === 'reserved' && reservation.capOverride === true,
		});
		return true;
	} catch (err) {
		logger.error('review: failed to reserve review-verdict slot — failing closed', {
			prNumber,
			headSha,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

/**
 * Validates a trigger context for the review handler, checking the source,
 * event-level gates, and required fields (PR number, head SHA). Returns the
 * narrowed event, project, prNumber, and headSha on success, or `null` when any
 * guard short-circuits.
 *
 * Extracted from {@link createReviewTrigger}'s `handle` to keep its cognitive
 * complexity within the configured lint threshold.
 */
function validateReviewEvent(ctx: TriggerContext): {
	event: ScmEvent;
	project: ProjectConfig;
	prNumber: string;
	headSha: string;
} | null {
	if (ctx.source !== 'scm') return null;
	const { event, project } = ctx;

	if (event.kind === 'pull-request' && isDispositionDisabled(project, { kind: 'review' })) {
		return null;
	}

	const prNumber = event.workItemId;
	if (!prNumber) {
		// A check event with no associated PR, or a PR event missing its number —
		// nothing to review.
		logger.debug('review: event carries no PR number — skipping', {
			eventKind: event.kind,
		});
		return null;
	}

	if (!event.headSha) {
		// The Review phase pins its checkout to the head SHA; without it there's
		// nothing to review against.
		logger.warn('review: event carries no head SHA — skipping', {
			prNumber,
			eventKind: event.kind,
		});
		return null;
	}

	return { event, project, prNumber, headSha: event.headSha };
}

/**
 * The terminal notice posted when the mergeability path exhausts a budget,
 * worded for the budget that ran out: an unknown mergeability is the provider
 * declining to answer a question, an exhausted read-failure budget is the
 * provider not answering at all.
 *
 * Best-effort by nature — and on the `read-failed` path it is *expected* to
 * fail, since it posts through the very provider that stopped answering. An
 * extra, therefore, not the notice: the record an operator is meant to find is
 * the durable `failed` run {@link recordAbandonedReview} has already written
 * (issue #742), which survives exactly that.
 */
async function scmCommentReviewGaveUp(
	scm: SCMProvider,
	project: ProjectConfig,
	prNumber: number,
	budget: DeferBudget,
): Promise<void> {
	const body =
		budget === 'read-failed'
			? `## ⚠️ SWARM could not reach the source-control provider\n\nRepeated attempts to read this pull request failed, so SWARM stopped waiting and abandoned the queued review. No branch changes were made. Please re-run the review once the provider is reachable again.\n\n---\n${SWARM_GENERATED_FOOTER}`
			: `## ⚠️ SWARM conflict check needs attention\n\nThe source-control provider did not produce a mergeability result after repeated checks. No branch changes were made. Please inspect this PR manually and retry after the provider reports its mergeability.\n\n---\n${SWARM_GENERATED_FOOTER}`;
	try {
		await scm.commentOnPullRequest(project, prNumber, body);
	} catch (error) {
		logger.error('review: failed to post terminal review give-up comment', {
			prNumber,
			budget,
			error: String(error),
		});
	}
}

async function scheduleMergeabilityRecheck(
	ctx: ScmTriggerContext,
	budget: DeferBudget,
	prNumber: string,
	headSha: string,
	details: Record<string, unknown>,
): Promise<null> {
	// A PR-updated event intentionally never dispatches Review; a completed
	// checks event can. Keep their rechecks separate so a later PR-updated
	// delivery cannot replace the follow-up Review's dispatch-capable recheck.
	const coalesceKey = `review-mergeability:${ctx.project.repo}:${prNumber}:${headSha}:${ctx.event.kind}`;
	const scheduled = await scheduleReviewRecheck(
		ctx,
		budget,
		coalesceKey,
		prNumber,
		headSha,
		details,
	);
	if (!scheduled) {
		await scmCommentReviewGaveUp(ctx.scm, ctx.project, Number(prNumber), budget);
	}
	return null;
}

function logOwnershipSkip(
	projectId: string,
	prNumber: string,
	prBranch: string,
	prAuthorLogin: string | null,
	isSwarm: Extract<SwarmManagedPrResult, { managed: false }>,
): void {
	if (isSwarm.reason === 'no-run') {
		logger.warn(
			'review: PR branch matches SWARM format but has no Implementation run row — skipping',
			{
				projectId,
				prNumber,
				prBranch,
				prAuthorLogin,
				taskId: isSwarm.taskId,
			},
		);
	} else {
		logger.debug('review: PR is not linked to a SWARM work item — skipping', {
			prNumber,
			prBranch,
			prAuthorLogin,
		});
	}
}

/**
 * The mergeability gate's "carry on to the disposition" answer. It carries the PR
 * head branch the gate already fetched, so the Review dispatch can name it
 * (`TriggerResult`'s `prBranch`) without a second provider round-trip.
 */
type MergeabilityCleared = { cleared: true; prBranch: string };

async function checkMergeabilityAndConflicts(
	ctx: ScmTriggerContext,
	event: ScmEvent,
	project: ProjectConfig,
	prNumber: string,
	headSha: string,
): Promise<TriggerResult | null | MergeabilityCleared> {
	if (event.isDraft || event.isCrossRepo) {
		logger.debug('review: draft or fork PR — skipping mergeability check', {
			prNumber,
			isDraft: event.isDraft,
			isCrossRepo: event.isCrossRepo,
		});
		return null;
	}

	const { scm } = ctx;
	const persona = (await scm.hasPersonaToken(project, 'reviewer')) ? 'reviewer' : 'implementer';
	let prDetails: Awaited<ReturnType<typeof scm.getPullRequest>>;
	try {
		prDetails = await scm.getPullRequest(project, Number(prNumber), persona);
	} catch (err) {
		return scheduleMergeabilityRecheck(ctx, 'read-failed', prNumber, headSha, {
			reason: 'fetch PR failed',
			error: err instanceof Error ? err.message : String(err),
		});
	}

	if (!prDetails) {
		logger.debug('review: PR details not found — skipping', { prNumber });
		return null;
	}

	// A closed (or merged) pull request is done, and no provider ever reports a
	// final `mergeable` for one — so a recheck chain that reaches this point can
	// never converge (issue #772: a stray `checks` chain on PR #768 polled a PR
	// merged 16 minutes earlier until its 20-attempt cap wrote a spurious `failed`
	// run). Not an error and not a budget exhaustion: the work this dispatch
	// existed for already happened, so it is a plain skip with no durable trace
	// and no give-up comment. Placed before the ownership gate so it covers every
	// entry point — both `pull-request` and `checks` chains, the synthetic
	// follow-up Review, and the ownership gate's own `read-failed` recheck — and
	// costs no DB read or aggregate checks-API query.
	if (prDetails.state === 'closed') {
		logger.debug('review: PR is already closed — nothing left to review', {
			prNumber,
			headSha,
			eventKind: event.kind,
		});
		return null;
	}

	// The single ownership gate for both entry events (see the module header): the
	// PR is SWARM's iff its head branch decodes to a work item SWARM ran
	// Implementation for. Runs here because this is the one place both events
	// already fetch the PR, and still *before* the `checks` path's heavier
	// aggregate checks-API query.
	const isSwarm = await resolveSwarmManagedPr(project, prDetails.headBranch, 'review');
	if (isSwarm === 'error') {
		return scheduleMergeabilityRecheck(ctx, 'read-failed', prNumber, headSha, {
			reason: 'ownership gate resolution failed',
		});
	}
	if (!isSwarm.managed) {
		logOwnershipSkip(project.id, prNumber, prDetails.headBranch, prDetails.authorLogin, isSwarm);
		return null;
	}

	if (prDetails.mergeable === null) {
		return scheduleMergeabilityRecheck(ctx, 'state-pending', prNumber, headSha, {
			reason: 'mergeable is null (unknown)',
		});
	}

	if (prDetails.mergeable === false) {
		return handleConflictingPullRequest(ctx, project, prDetails, prNumber, headSha);
	}

	if (event.kind === 'pull-request' && event.action === 'updated') {
		logger.debug('review: PR is mergeable on updated event; waiting for checks — skipping', {
			prNumber,
			headSha,
		});
		return null;
	}

	return { cleared: true, prBranch: prDetails.headBranch };
}

async function handleConflictingPullRequest(
	ctx: ScmTriggerContext,
	project: ProjectConfig,
	prDetails: PullRequestDetails,
	prNumber: string,
	headSha: string,
): Promise<TriggerResult | null> {
	logger.info('review: PR is conflicting; transitioning to Resolve-conflicts', {
		prNumber,
		headSha,
	});

	const stateKey = buildConflictResolutionKey(
		project.repo,
		String(prDetails.number),
		prDetails.headSha,
		prDetails.baseSha,
	);
	if (
		!ctx.runId &&
		!ctx.continuationDispatchClaimed &&
		!(await claimConflictResolution(stateKey))
	) {
		logger.debug('review: conflict resolution already claimed — skipping', {
			prNumber,
			headSha,
		});
		return null;
	}

	return {
		phase: 'resolve-conflicts',
		taskId: `${prDetails.number}-conflicts`,
		prNumber: String(prDetails.number),
		prBranch: prDetails.headBranch,
		headSha: prDetails.headSha,
		baseBranch: prDetails.baseBranch,
		baseSha: prDetails.baseSha,
	};
}

export function createReviewTrigger(): TriggerHandler {
	return {
		name: 'pr-review',
		description: 'Starts the Review phase on a PR opened / its checks completing',

		matches: matchesReviewShape,

		async handle(ctx: TriggerContext): Promise<TriggerResult | null> {
			if (ctx.source !== 'scm') return null;
			const validated = validateReviewEvent(ctx);
			if (!validated) return null;
			const { event, project, prNumber, headSha } = validated;

			const mergeCheck = await checkMergeabilityAndConflicts(
				ctx,
				event,
				project,
				prNumber,
				headSha,
			);
			// Anything but the cleared marker is this handler's answer already — a skip
			// (`null`) or a Resolve-conflicts dispatch.
			if (!mergeCheck || !('cleared' in mergeCheck)) return mergeCheck;

			const disposition = await resolveDisposition(ctx, prNumber, headSha);
			if (disposition.kind === 'none') return null;
			if (isDispositionDisabled(project, disposition, prNumber, headSha)) return null;

			// Cross-process dedup: claim this PR+SHA before dispatching so a sibling
			// event for the same commit (PR opened → check suite passed, or one
			// event per CI suite) doesn't launch a second phase. Fails closed, so a
			// claim we can't obtain (duplicate, or Redis down) drops to a skip. The
			// review and respond-to-ci paths share this slot deliberately: they are
			// mutually exclusive for a given SHA (a commit's checks either all pass or
			// one failed), and each is only dispatched once every check has completed,
			// so there is never a legitimate second dispatch for the same PR+SHA to
			// contend for it.
			const dispatchKey = buildReviewDispatchKey(ctx.project.repo, prNumber, headSha);
			// A prioritized continuation retry (issue #214) already holds this PR+SHA
			// claim from its original dispatch attempt — the concurrency deferral
			// refreshed the claim's TTL and is holding it open. Re-claiming now (well
			// within that TTL) would see the still-live claim and drop this Review as a
			// duplicate, so reuse the held claim instead of re-claiming.
			if (ctx.continuationDispatchClaimed) {
				logger.debug('review: reusing held dispatch claim for a prioritized continuation retry', {
					prNumber,
					headSha,
				});
			} else {
				const claimed = await claimReviewDispatch(dispatchKey, 'pr-review', {
					prNumber,
					headSha,
				});
				if (!claimed) return null;
			}

			if (disposition.kind === 'respond-to-ci') {
				return dispatchRespondToCi(
					ctx.project,
					event,
					prNumber,
					headSha,
					disposition.failedChecks,
					ctx.continuationDispatchClaimed === true,
				);
			}

			if (!(await reserveDurableReviewSlot(ctx.project, prNumber, headSha))) return null;

			logger.debug('review: dispatching Review phase', { prNumber, headSha });
			return {
				phase: 'review',
				taskId: prNumber,
				prNumber,
				prBranch: mergeCheck.prBranch,
				headSha,
			};
		},
	};
}
