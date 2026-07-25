/**
 * `pr-review` trigger — the PR-lifecycle handler. It starts the Review phase
 * (`src/pipeline/review.ts`) when a PR is opened or its checks pass, and routes
 * a *failing* check suite to the Respond-to-CI phase (`src/pipeline/respond-to-ci.ts`),
 * mirroring Cascade's review-agent + respond-to-ci triggers on `check_suite`
 * completion (ai/ARCHITECTURE.md "Pipeline phases" #3 / respond-to-ci).
 *
 * Two entry events, one handler:
 *  - `pull_request` `opened` (non-draft) — review the freshly opened PR.
 *  - `check_suite` `completed` — review the commit CI just validated (why the
 *    phase pins its checkout to the head SHA), or fix it if CI failed.
 *
 * **The `opened` dispatch races the Implementation phase's own wrap-up — by
 * design.** The implementer opens the PR (`gh pr create`) as one of its last
 * actions *inside* its still-running agent process, so GitHub delivers
 * `pull_request opened` — and this handler dispatches Review — a few seconds
 * before the Implementation phase logs its own `Phase finished` and moves the
 * board. In an interleaved worker log (`SWARM_WORKER_CONCURRENCY > 1`) that reads
 * as "Review started before Implementation finished", which looks like an
 * out-of-order pipeline but isn't: Review provisions its *own* detached worktree
 * at the head SHA and touches nothing the implementer owns, and if the implementer
 * pushes further commits after opening the PR, their `check_suite` re-enters here
 * and re-reviews at the final SHA (the PR+SHA dedup keys on the new commit, so the
 * later review isn't dropped). No serialization needed; the per-run `logContext`
 * (`taskId`/`phase` on every `agent run finished` line) is what disambiguates the
 * interleave.
 *
 * **Aggregate check state, not this suite's conclusion.** GitHub fires one
 * `check_suite.completed` per workflow, so any single event's own `conclusion`
 * describes only its suite while siblings may still be running. On a
 * `check_suite` event the handler re-queries *every* check on the head SHA
 * (`getCheckSuiteStatus`) and decides via `decideCheckSuiteOutcome`
 * (`check-suite-decision.ts`): review if all complete and none failed,
 * respond-to-ci if a check failed, or **defer** if some check is still
 * incomplete. Ported from Cascade's `check-suite-success`/`-failure` triggers.
 * A zero-check head defers too, under the default `pipeline.review.checks:
 * 'required'` policy — a project with no CI at all can instead set
 * `'if-present'` to review immediately on zero checks (issue #274).
 *
 * **Respond-to-CI loop guard.** Fixing a build pushes a commit → a new head SHA
 * → a fresh `check_suite`, so if the fix doesn't stick the same PR routes back
 * here. The PR+SHA dedup can't stop that (each attempt is a new SHA), so
 * `dispatchRespondToCi` adds a per-PR fix-attempt cap (`respond-to-ci-attempts.ts`)
 * that winds a never-sticking fix down to a warn-and-drop, mirroring Cascade's
 * `MAX_ATTEMPTS`.
 *
 * **Deferred recheck.** A defer schedules a coalesced re-enqueue of this same
 * event ~30s out (`scheduleCoalescedDispatch`). This guards the case where the
 * Actions API lags webhook delivery — the suite reports complete over the
 * webhook, but a query moments later still shows it `in_progress`, and no
 * further webhook will arrive to wake us. The recheck re-queries fresh API
 * state; `recheckAttempt` caps the loop so a permanently-stale API can't
 * reschedule forever (a genuinely slow CI run is re-triggered by its own later
 * `check_suite` webhook, so the cap can't drop a legitimate review). A *failed*
 * aggregate query (transient Actions-API error, or an unresolvable reviewer
 * token) degrades to the same bounded recheck rather than throwing out of the
 * handler and burning the job's retries — see `resolveCheckSuiteReview`.
 *
 * **Same-repo gate.** Fork PRs are dropped (`pull_request` events, via
 * `isCrossRepo`): the Review phase's `provision` fetches only the base repo's
 * refs, so a fork's head SHA is unreachable and the detached checkout would
 * fail the job (see `src/pipeline/review.ts`'s header). A `check_suite` payload
 * doesn't reliably tell us fork-ness, so that path can't pre-filter forks — an
 * unreachable SHA there surfaces as a failed job rather than a silent drop.
 *
 * **Author-persona gate.** SWARM reviews only PRs authored by one of its own
 * personas (the implementer opens every SWARM PR), mirroring Cascade's
 * `decideCheckSuiteGates` in its default `authorMode='own'` mode: a human- or
 * third-party-bot-authored PR completing its checks (or being opened) must not
 * burn a review. On the `pull_request` path the author rides in the payload
 * (`prAuthorLogin`), so the gate is free; on the `check_suite` path the payload
 * carries no author, so it costs one `pulls.get` — run *before* the aggregate
 * query so a PR we'd never review doesn't also pay for the (heavier) Actions-API
 * call. The configurable own/external/all knob and base-branch gate Cascade
 * exposes are out of scope — see `isSwarmAuthoredPr`.
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
import { scheduleCoalescedDispatch } from '../../dispatch/dispatcher.js';
import {
	type CheckSuiteStatus,
	type ConflictCandidatePullRequest,
	getCheckSuiteStatus,
	getPullRequestAuthorLogin,
} from '../../integrations/scm/github/client.js';
import { isSwarmBot, resolvePersonaIdentities } from '../../integrations/scm/github/personas.js';
import { GitHubSCMIntegration } from '../../integrations/scm/github/scm-integration.js';
import { logger } from '../../lib/logger.js';
import type { GitHubParsedEvent } from '../../router/adapters/github.js';
import { buildConflictResolutionKey, claimConflictResolution } from '../resolve-conflicts-dedup.js';
import { buildRespondToCiAttemptKey, claimRespondToCiAttempt } from '../respond-to-ci-attempts.js';
import { buildReviewDispatchKey, claimReviewDispatch } from '../review-dispatch-dedup.js';
import type { TriggerContext, TriggerHandler, TriggerResult } from '../types.js';
import { decideCheckSuiteOutcome } from './check-suite-decision.js';

/**
 * What a shape-matched event resolves to once its per-event-type gate has run.
 * A `check_suite` whose checks all passed → `review`; one where a check failed →
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

/** How long to wait before re-querying check state when the Actions API looks stale. */
const RECHECK_DELAY_MS = 30_000;

/**
 * Cap on deferred rechecks per job. ~10 min of Actions-API lag at
 * {@link RECHECK_DELAY_MS} — well beyond any real lag, and past it a fresh
 * `check_suite` webhook (which every completing suite emits) re-triggers anyway,
 * so the cap can only stop a pathological self-reschedule loop, never drop a
 * legitimate review.
 */
const MAX_CHECK_SUITE_RECHECKS = 20;

/**
 * True when the event is a review entry point by *shape* — an opened PR or a
 * completed check suite. The draft/fork/aggregate-CI specifics are decided in
 * `handle` so a near-miss can fall through to the registry's next handler.
 */
function matchesReviewShape(ctx: TriggerContext): boolean {
	if (ctx.source !== 'github') return false;
	const { event } = ctx;
	if (
		event.eventType === 'pull_request' &&
		(event.action === 'opened' || event.action === 'synchronize')
	) {
		return true;
	}
	if (event.eventType === 'check_suite' && event.action === 'completed') return true;
	return false;
}

/**
 * Author-persona gate — whether `authorLogin` is one of the project's SWARM
 * personas. SWARM reviews only PRs it authored itself (the implementer opens
 * every SWARM PR), so a human- or third-party-bot-authored PR never burns a
 * review — mirroring Cascade's `decideCheckSuiteGates` in its default
 * `authorMode='own'` mode. Resolves the project's persona identities (cached,
 * 60s TTL) and defers the throw-vs-skip decision to the caller: it throws only
 * if identity resolution throws, so the `check_suite` path can degrade to a
 * bounded recheck while the `pull_request` path fails closed.
 *
 * The configurable own/external/all `authorMode` Cascade exposes is deliberately
 * out of scope: SWARM's dual-persona loop-prevention model only ever acts on its
 * own output, and it has no MVP requirement to review human/external PRs — so
 * there is nothing to configure. Base-branch gating is subsumed for the same
 * reason: Cascade's own-authored PRs skip the base-branch check (its
 * `decideCheckSuiteGates` "Bug 2" note, so stacked PRs aren't rejected), so with
 * an own-only gate the base check could never reject anything SWARM authored.
 */
async function isSwarmAuthoredPr(project: ProjectConfig, authorLogin: string): Promise<boolean> {
	const identities = await resolvePersonaIdentities(project);
	return isSwarmBot(authorLogin, identities);
}

/**
 * The `pull_request`-only gate: a PR must be a non-draft, same-repo PR authored
 * by a SWARM persona to be reviewable. Logs and returns `none` on a near-miss so
 * `handle` can fall through to the registry's next handler. A `pull_request`
 * event never routes to Respond-to-CI — that path is driven only by a failed
 * `check_suite`.
 *
 * The author is in the payload (`prAuthorLogin`), so the persona gate costs no
 * extra fetch. On an identity-resolution failure it fails closed (skip): the
 * PR's own completing `check_suite` re-runs this same gate with its own bounded
 * recheck, so a transient blip here can't permanently drop a legit review.
 */
async function isReviewablePullRequest(
	project: ProjectConfig,
	event: GitHubParsedEvent,
	prNumber: string,
): Promise<ReviewDisposition> {
	if (event.isDraft) {
		logger.debug('review: PR is a draft — skipping', { prNumber });
		return { kind: 'none' };
	}
	if (event.isCrossRepo) {
		logger.debug('review: fork PR — skipping (head SHA unreachable for review)', { prNumber });
		return { kind: 'none' };
	}
	if (!event.prAuthorLogin) {
		logger.warn('review: PR event carries no author login — skipping', { prNumber });
		return { kind: 'none' };
	}
	try {
		if (!(await isSwarmAuthoredPr(project, event.prAuthorLogin))) {
			logger.debug('review: PR not authored by a SWARM persona — skipping', {
				prNumber,
				prAuthorLogin: event.prAuthorLogin,
			});
			return { kind: 'none' };
		}
	} catch (err) {
		logger.warn(
			'review: could not resolve persona identities for author gate — skipping (check_suite will re-evaluate)',
			{ prNumber, error: err instanceof Error ? err.message : String(err) },
		);
		return { kind: 'none' };
	}
	return { kind: 'review' };
}

/**
 * Schedule a bounded, coalesced recheck of this `check_suite` event, or give up
 * once {@link MAX_CHECK_SUITE_RECHECKS} is reached. Always returns `{ kind: 'none' }`
 * — the event is fully handled here whether a recheck was queued or the cap
 * stopped the loop. Shared by the two defer paths in {@link resolveCheckSuiteReview}:
 * some check still incomplete, and a failed aggregate query. `details` is merged
 * into the log line so each caller records why it deferred.
 */
async function scheduleCheckSuiteRecheck(
	project: ProjectConfig,
	event: GitHubParsedEvent,
	deliveryId: string | undefined,
	recheckAttempt: number,
	prNumber: string,
	headSha: string,
	details: Record<string, unknown>,
): Promise<ReviewDisposition> {
	if (recheckAttempt >= MAX_CHECK_SUITE_RECHECKS) {
		logger.warn('review: giving up on check-suite recheck (cap reached)', {
			prNumber,
			headSha,
			recheckAttempt,
			...details,
		});
		return { kind: 'none' };
	}

	const coalesceKey = `check-suite:${project.repo}:${prNumber}:${headSha}`;
	await scheduleCoalescedDispatch(
		{
			type: 'github',
			projectId: project.id,
			...(deliveryId ? { deliveryId } : {}),
			recheckAttempt: recheckAttempt + 1,
			event,
		},
		coalesceKey,
		RECHECK_DELAY_MS,
	);
	logger.debug('review: scheduled deferred check-suite recheck', {
		prNumber,
		headSha,
		recheckAttempt: recheckAttempt + 1,
		delayMs: RECHECK_DELAY_MS,
		coalesceKey,
		...details,
	});
	return { kind: 'none' };
}

/**
 * Decide a `check_suite` event's fate from the head SHA's *aggregate* check
 * state. Returns `review` to proceed to review, `respond-to-ci` when a check
 * failed (routing the PR to the build-fix phase), or `none` when the event is
 * handled here (an incomplete suite's recheck scheduled, or a bounded give-up).
 * The aggregate query runs as the reviewer persona — read-only, and the persona
 * whose review follows.
 *
 * The query resolves the reviewer token and hits the Actions API, so it can
 * throw — a transient 5xx/rate-limit/network blip, or a project with no
 * resolvable reviewer token. That throw must not escape `handle`: it would land
 * outside `processJob`'s `runPhase`-only try/catch, failing the job and burning
 * its BullMQ retries re-running this same query (an implementer-token-only
 * project would fail+retry on *every* `check_suite` event). We degrade to a
 * bounded recheck instead — Cascade skips on error; we defer so a transient blip
 * can't silently drop a legitimate review, and the cap winds a persistent
 * failure down to one warn+drop rather than a retry storm.
 */
async function resolveCheckSuiteReview(
	project: ProjectConfig,
	event: GitHubParsedEvent,
	deliveryId: string | undefined,
	recheckAttempt: number,
	prNumber: string,
	headSha: string,
): Promise<ReviewDisposition> {
	const [owner, repo] = project.repo.split('/');
	const scm = new GitHubSCMIntegration();

	// Author-persona gate, *before* the aggregate query so a PR we'd never review
	// doesn't also pay for the (heavier) Actions-API call. The `check_suite`
	// payload carries no author, so resolve it with a single `pulls.get` as the
	// reviewer persona (the persona whose review would follow). A resolved author
	// that isn't ours — or a PR with no resolvable author — is a definitive skip;
	// any *error* determining authorship degrades to the same bounded recheck as a
	// failed aggregate query (a transient blip must not silently drop a legit
	// review, and the cap winds a persistent failure down to one warn+drop).
	try {
		const authorLogin = await scm.withPersonaCredentials(project, 'reviewer', () =>
			getPullRequestAuthorLogin(owner, repo, Number(prNumber)),
		);
		if (!authorLogin) {
			logger.debug('review: check-suite PR has no resolvable author — skipping', {
				prNumber,
				headSha,
			});
			return { kind: 'none' };
		}
		if (!(await isSwarmAuthoredPr(project, authorLogin))) {
			logger.debug('review: check-suite PR not authored by a SWARM persona — skipping', {
				prNumber,
				headSha,
				prAuthorLogin: authorLogin,
			});
			return { kind: 'none' };
		}
	} catch (err) {
		return scheduleCheckSuiteRecheck(
			project,
			event,
			deliveryId,
			recheckAttempt,
			prNumber,
			headSha,
			{
				reason: 'author gate failed',
				error: err instanceof Error ? err.message : String(err),
			},
		);
	}

	let checkStatus: CheckSuiteStatus;
	try {
		checkStatus = await scm.withPersonaCredentials(project, 'reviewer', () =>
			getCheckSuiteStatus(owner, repo, headSha),
		);
	} catch (err) {
		return scheduleCheckSuiteRecheck(
			project,
			event,
			deliveryId,
			recheckAttempt,
			prNumber,
			headSha,
			{ reason: 'aggregate query failed', error: err instanceof Error ? err.message : String(err) },
		);
	}

	const checksPolicy = project.pipeline?.review?.checks ?? 'required';
	const decision = decideCheckSuiteOutcome(checkStatus, prNumber, checksPolicy);
	if (decision.action === 'review') return { kind: 'review' };

	if (decision.action === 'respond-to-ci') {
		return { kind: 'respond-to-ci', failedChecks: decision.failedChecks };
	}

	// defer — some check is still incomplete; re-query fresh API state shortly.
	return scheduleCheckSuiteRecheck(project, event, deliveryId, recheckAttempt, prNumber, headSha, {
		incompleteChecks: decision.incompleteChecks,
	});
}

/**
 * What a shape-matched event resolves to, routing to the per-event-type gate: a
 * `pull_request`'s draft/fork check (`review`/`none`), or a `check_suite`'s
 * aggregate-CI decision (`review`/`respond-to-ci`/`none`, and it may defer a
 * recheck in place).
 */
function resolveDisposition(
	project: ProjectConfig,
	event: GitHubParsedEvent,
	deliveryId: string | undefined,
	recheckAttempt: number,
	prNumber: string,
	headSha: string,
): Promise<ReviewDisposition> {
	if (event.eventType === 'pull_request') {
		return isReviewablePullRequest(project, event, prNumber);
	}
	return resolveCheckSuiteReview(project, event, deliveryId, recheckAttempt, prNumber, headSha);
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
	event: GitHubParsedEvent,
	prNumber: string,
	headSha: string,
	failedChecks: string[],
	continuationDispatchClaimed: boolean,
): Promise<TriggerResult | null> {
	if (!event.prBranch) {
		// A `check_suite` payload should carry its PR's head ref; without it the
		// fix phase has no branch to check out and push to.
		logger.warn('respond-to-ci: check suite carries no PR branch — skipping', {
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
 * narrowed GitHub event, project, prNumber, and headSha on success, or `null`
 * when any guard short-circuits.
 *
 * Extracted from {@link createReviewTrigger}'s `handle` to keep its cognitive
 * complexity within the configured lint threshold.
 */
function validateReviewEvent(ctx: TriggerContext): {
	event: GitHubParsedEvent;
	project: ProjectConfig;
	prNumber: string;
	headSha: string;
} | null {
	if (ctx.source !== 'github') return null;
	const { event, project } = ctx;

	if (event.eventType === 'pull_request' && isDispositionDisabled(project, { kind: 'review' })) {
		return null;
	}

	const prNumber = event.workItemId;
	if (!prNumber) {
		// A check suite with no associated PR, or a PR event missing its number —
		// nothing to review.
		logger.debug('review: event carries no PR number — skipping', {
			eventType: event.eventType,
		});
		return null;
	}

	if (!event.headSha) {
		// The Review phase pins its checkout to the head SHA; without it there's
		// nothing to review against.
		logger.warn('review: event carries no head SHA — skipping', {
			prNumber,
			eventType: event.eventType,
		});
		return null;
	}

	return { event, project, prNumber, headSha: event.headSha };
}

async function scmCommentUnknownMergeability(
	project: ProjectConfig,
	prNumber: number,
): Promise<void> {
	try {
		await new GitHubSCMIntegration().commentOnPullRequest(
			project,
			prNumber,
			'## ⚠️ SWARM conflict check needs attention\n\nGitHub did not produce a mergeability result after repeated checks. No branch changes were made. Please inspect this PR manually and retry after GitHub reports its mergeability.\n\n---\n_Generated by SWARM._',
		);
	} catch (error) {
		logger.error('review: failed to post terminal mergeability comment', {
			prNumber,
			error: String(error),
		});
	}
}

async function scheduleMergeabilityRecheck(
	ctx: Extract<TriggerContext, { source: 'github' }>,
	prNumber: string,
	headSha: string,
	details: Record<string, unknown>,
): Promise<null> {
	const recheckAttempt = ctx.recheckAttempt ?? 0;
	if (recheckAttempt >= MAX_CHECK_SUITE_RECHECKS) {
		logger.warn('review: giving up on mergeability recheck (cap reached)', {
			prNumber,
			headSha,
			recheckAttempt,
			...details,
		});
		await scmCommentUnknownMergeability(ctx.project, Number(prNumber));
		return null;
	}

	// A synchronize event intentionally never dispatches Review; a completed
	// check-suite event can. Keep their rechecks separate so a later synchronize
	// delivery cannot replace the follow-up Review's dispatch-capable recheck.
	const coalesceKey = `review-mergeability:${ctx.project.repo}:${prNumber}:${headSha}:${ctx.event.eventType}`;
	await scheduleCoalescedDispatch(
		{
			type: 'github',
			projectId: ctx.project.id,
			...(ctx.deliveryId ? { deliveryId: ctx.deliveryId } : {}),
			recheckAttempt: recheckAttempt + 1,
			event: ctx.event,
		},
		coalesceKey,
		RECHECK_DELAY_MS,
	);
	logger.debug('review: scheduled deferred mergeability recheck', {
		prNumber,
		headSha,
		recheckAttempt: recheckAttempt + 1,
		delayMs: RECHECK_DELAY_MS,
		coalesceKey,
		...details,
	});
	return null;
}

async function isSwarmAuthoredPrDetails(
	project: ProjectConfig,
	authorLogin: string | null,
): Promise<boolean | 'error'> {
	try {
		const identities = await resolvePersonaIdentities(project);
		return !authorLogin || isSwarmBot(authorLogin, identities);
	} catch (err) {
		logger.error('review: author gate resolution failed', {
			projectId: project.id,
			error: err instanceof Error ? err.message : String(err),
		});
		return 'error';
	}
}

async function checkMergeabilityAndConflicts(
	ctx: Extract<TriggerContext, { source: 'github' }>,
	event: GitHubParsedEvent,
	project: ProjectConfig,
	prNumber: string,
	headSha: string,
): Promise<TriggerResult | null | 'continue'> {
	if (event.isDraft || event.isCrossRepo) {
		logger.debug('review: draft or fork PR — skipping mergeability check', {
			prNumber,
			isDraft: event.isDraft,
			isCrossRepo: event.isCrossRepo,
		});
		return null;
	}

	const scm = new GitHubSCMIntegration();
	const persona = (await scm.hasPersonaToken(project, 'reviewer')) ? 'reviewer' : 'implementer';
	let prDetails: Awaited<ReturnType<typeof scm.getPullRequest>>;
	try {
		prDetails = await scm.getPullRequest(project, Number(prNumber), persona);
	} catch (err) {
		return scheduleMergeabilityRecheck(ctx, prNumber, headSha, {
			reason: 'fetch PR failed',
			error: err instanceof Error ? err.message : String(err),
		});
	}

	if (!prDetails) {
		logger.debug('review: PR details not found — skipping', { prNumber });
		return null;
	}

	const isSwarm = await isSwarmAuthoredPrDetails(project, prDetails.authorLogin);
	if (isSwarm === 'error') {
		return scheduleMergeabilityRecheck(ctx, prNumber, headSha, {
			reason: 'author gate resolution failed',
		});
	}
	if (!isSwarm) {
		logger.debug('review: PR not authored by a SWARM persona — skipping', {
			prNumber,
			prAuthorLogin: prDetails.authorLogin,
		});
		return null;
	}

	if (prDetails.mergeable === null) {
		return scheduleMergeabilityRecheck(ctx, prNumber, headSha, {
			reason: 'mergeable is null (unknown)',
		});
	}

	if (prDetails.mergeable === false) {
		return handleConflictingPullRequest(ctx, project, prDetails, prNumber, headSha);
	}

	if (event.eventType === 'pull_request' && event.action === 'synchronize') {
		logger.debug('review: PR is mergeable on synchronize event; waiting for checks — skipping', {
			prNumber,
			headSha,
		});
		return null;
	}

	return 'continue';
}

async function handleConflictingPullRequest(
	ctx: Extract<TriggerContext, { source: 'github' }>,
	project: ProjectConfig,
	prDetails: ConflictCandidatePullRequest,
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
		description: 'Starts the Review phase on a PR opened / check suite completing',

		matches: matchesReviewShape,

		async handle(ctx: TriggerContext): Promise<TriggerResult | null> {
			if (ctx.source !== 'github') return null;
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
			if (mergeCheck !== 'continue') return mergeCheck;

			const disposition = await resolveDisposition(
				ctx.project,
				event,
				ctx.deliveryId,
				ctx.recheckAttempt ?? 0,
				prNumber,
				headSha,
			);
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
			return { phase: 'review', taskId: prNumber, prNumber, headSha };
		},
	};
}
