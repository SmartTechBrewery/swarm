/**
 * Unreviewed-pull-request recovery (issue #862) — the periodic sweep that hands a
 * pull request which is *ready for review and has not received one* back to
 * Review, so no single non-recurring event is the only thing that can start one.
 *
 * **The terminal state this exists to break.** In practice `pr-review`
 * (`src/triggers/handlers/review.ts`) dispatches Review from exactly one event: a
 * `checks`/`completed` whose aggregate is green. A mergeable pull request
 * arriving on `pull-request updated` is deliberately skipped, and `checks
 * completed` never fires twice for one head SHA. So every way a Review can die
 * after that event lands in the same place — green, mergeable, permanently
 * unreviewed, with nothing scheduled and no human signal. It happened twice in
 * two days from unrelated causes: `SmartTechBrewery/rover#116`, where a leaked
 * `pending` ledger row blocked the dispatch before any run row existed (issue
 * #856), and `SmartTechBrewery/swarm#860`, where the Review run itself failed
 * terminally (issue #861). Both needed a human to re-run CI or reset the run.
 *
 * **Why the periodic shape rather than a terminal-failure hand-back.** The
 * `no-fix` pattern (`./ci-no-fix-recovery.ts`, issue #841) needs a run to hand
 * back *from*. `rover#116` had none — the trigger skipped before dispatching —
 * and neither does the largest unenumerated failure mode of all: a `checks`
 * webhook lost while the control plane was offline, which is gone for good. Only
 * a sweep over the pull request's *own* state covers those, which is what
 * acceptance criterion "independent of why the Review died" actually requires.
 *
 * **It constructs trigger input and nothing else.** Each recovery is one
 * synthetic `checks`/`completed` {@link ScmEvent} for a (PR, head SHA), exactly
 * as `src/pipeline/follow-up-review.ts` and `./ci-no-fix-recovery.ts` build —
 * minus their markers, so the re-entered handler takes the PR+SHA dispatch claim
 * itself and a race with a real webhook resolves to one Review. Every guard the
 * handler applies still applies unchanged: the closed-PR skip (#772), the
 * work-item origin gate (#836), the mergeability/conflict route, the
 * `state-pending` defer, the automation-label gate, the PR-scoped in-flight hold
 * (#850), and the durable review-verdict reservation with its cap (#235) and
 * operator override (#511). The gates below are the sweep's own: they keep it off
 * the healthy path and bound its provider cost — they are not a second copy of
 * the handler's.
 *
 * **Bounded three ways**, so this can never become a re-review loop:
 *  - {@link MAX_RECOVERY_ATTEMPTS} deterministic dedup keys per (project, repo,
 *    PR, head), and an attempt is only ever *spent* on a dispatch that produced
 *    no Review ({@link isDeadDispatch}) — the moment one submits a verdict, the
 *    ledger reads `reviewed-at-head` and the sweep stops looking at that head
 *    entirely, so no extra verdict is ever burned;
 *  - the PR+SHA dispatch claim the re-entered handler takes;
 *  - the review-verdict ledger, pre-checked here
 *    ({@link classifyReviewLedgerForRecovery}) and decided authoritatively there.
 *
 * **The boundary with #856/#857.** A `pending` slot reads as `review-in-flight`,
 * so a *leaked* reservation still blocks recovery. That is deliberate: a
 * `pending` slot means a Review is in flight, and disturbing one is exactly what
 * this must not do. Telling a live reservation from a leaked one is #856's fix
 * (a `no-trigger` Review settle now hands back both the claim and the
 * reservation) plus #857's durable safety net. The division is clean —
 * **#856/#857 free the slot; this sweep supplies the re-dispatch neither of them
 * provides** — and it leaves this reason-agnostic for every failure that leaves
 * the ledger consistent, which after #856 includes both live shapes above.
 *
 * **Provider cost.** One pull-request list read per repository per pass, plus one
 * aggregate-checks read only for a pull request that is genuinely unreviewed at
 * its head. In steady state the per-PR call count is zero. The list read runs
 * under the **implementer** persona — i.e. the router's own
 * `SWARM_OPERATOR_GH_TOKEN` (`src/integrations/scm/github/personas.ts`, the
 * credential the router already reads for `src/router/worker-delivery.ts`) — the
 * same credential the `resolve-conflicts` fan-out reads it with, because
 * `listConflictCandidates` is the seam being reused. A router without it degrades
 * to a logged warning per pass and no recovery; widening the seam's persona is
 * out of scope here.
 *
 * **Known limitation, stated rather than fixed:** `PullRequestDetails` carries no
 * draft flag, so a SWARM-managed pull request converted back to draft is not
 * filtered here. That matches every other synthetic path and real `checks`
 * webhook — their events leave `isDraft` unset too, and the handler's draft gate
 * only ever sees it on a `pull-request` event.
 *
 * Lives under `src/dispatch/` for the reason `./ci-no-fix-recovery.ts` and
 * `./force-re-review.ts` do: it is queue work scheduled at the composition root
 * (`src/router/dispatcher.ts`), not by a phase (ai/RULES.md §2).
 */

import { scopeProjectToRepository } from '../config/project-repository.js';
import type { ProjectConfig } from '../config/schema.js';
import { hasActiveDispatchForPullRequest } from '../db/repositories/dispatchesRepository.js';
import { listAllProjectRecordsFromDb } from '../db/repositories/projectsRepository.js';
import {
	listActiveReviewSlotsForPullRequest,
	type PullRequestReviewSlot,
	REVIEW_VERDICT_CAP,
} from '../db/repositories/reviewVerdictsRepository.js';
import { requireProjectSCMProvider } from '../integrations/scm/registry.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { deliveryIdentity } from '../scm/delivery.js';
import type { ScmEvent } from '../scm/events.js';
import type { PullRequestDetails, SCMProvider } from '../scm/types.js';
import { decideAggregateCheckOutcome } from '../triggers/handlers/aggregate-check-decision.js';
import { resolveSwarmManagedPr } from '../triggers/swarm-managed-pr.js';
import { isDeadDispatch } from './dead-dispatch.js';
import { createAndPublishDispatch, deliveryDedupKey } from './dispatcher.js';

/**
 * How often the sweep runs. Longer than the reconciler's stale-run cadence
 * because a pass costs a provider pull-request list read per repository (GitHub's
 * implementation re-reads each candidate individually) while the reconciler's
 * pass is bounded `UPDATE`s. Not configurable, on `DISPATCH_CONSUMER_CONCURRENCY`'s
 * precedent: recovery latency is not an operator dial, and a shorter cadence only
 * spends provider budget faster.
 */
export const UNREVIEWED_PR_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How many recovery dispatches may ever be created for one
 * (project, repository, PR, head SHA).
 *
 * More than one because a single-shot recovery would itself be a non-recurring
 * event — the exact trap this module exists to remove — and the collisions that
 * would spend one are real: a stale PR+SHA claim left by a Review that died, a
 * Redis outage making the handler's claim fail closed, or the recovery's own
 * Review dying of the same unenumerated cause. Bounded at three because an
 * attempt is only ever spent on a dispatch that produced *no* Review, so this
 * bounds failures, never reviews.
 */
export const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * Deterministic dispatch identity for one recovery attempt. Its own
 * `review-recovery` prefix keeps it from ever colliding with
 * `followUpReviewDeliveryId` or `ciNoFixRecoveryDeliveryId` for the same head,
 * and `project.repo` is in the hash because a project spans repositories (issue
 * #685) — a shared key would have the dispatch layer absorb the second
 * repository's recovery as an already-recorded repeat of the first's.
 */
export function unreviewedPrRecoveryDeliveryId(
	project: ProjectConfig,
	prNumber: string,
	headSha: string,
	attempt: number,
): string {
	return deliveryIdentity(['review-recovery', project.repo, prNumber, headSha, String(attempt)]);
}

/** What the review-verdict ledger says about recovering this pull request at this head. */
export type LedgerRecoveryVerdict = 'recover' | 'reviewed-at-head' | 'review-in-flight' | 'capped';

/**
 * The read-only ledger pre-check, in `reserveReviewVerdict`'s own decision order
 * so the sweep can never reach a conclusion the reservation would contradict.
 * Pure, so it unit-tests without a database.
 *
 * Rule 3 mirrors issue #511 exactly — a granted, unconsumed cap override makes a
 * capped pull request recoverable again, which is what lets a forced
 * continuation whose follow-up Review died still be rescued. The grant is only
 * *observed* here; `reserveReviewVerdict` is the only thing that spends one, and
 * it does so inside its advisory lock.
 */
export function classifyReviewLedgerForRecovery(
	slots: readonly PullRequestReviewSlot[],
	headSha: string,
): LedgerRecoveryVerdict {
	const sameHead = slots.find((slot) => slot.headSha === headSha);
	if (sameHead) return sameHead.state === 'submitted' ? 'reviewed-at-head' : 'review-in-flight';
	if (slots.some((slot) => slot.state === 'pending')) return 'review-in-flight';

	const submitted = slots.filter((slot) => slot.state === 'submitted').length;
	if (submitted >= REVIEW_VERDICT_CAP) {
		const grant = slots.some(
			(slot) => slot.capOverrideGrantedAt !== null && slot.capOverrideConsumedAt === null,
		);
		if (!grant) return 'capped';
	}
	return 'recover';
}

/** What one candidate's enqueue resolved to — the log line's vocabulary, and the unit tests'. */
type RecoveryEnqueueOutcome = 'scheduled' | 'already-scheduled' | 'exhausted';

/**
 * Enqueue this pull request's next recovery attempt, or report that its
 * allowance is spent.
 *
 * A fixed attempt index rather than `./force-re-review.ts`'s chain-off-the-dead-
 * row-id: it is the same policy with a simpler, deterministic key set, three rows
 * worst case, and the sweep is single-instance so there is no concurrent-minting
 * problem to solve. `taskId`/`phase` are preset for the Queue read model's
 * benefit (`force-re-review.ts` does the same) and are not a gate —
 * `createDispatch` records no `repository`/`pr_number`, so the row stays
 * invisible to {@link hasActiveDispatchForPullRequest} until the trigger resolves
 * it, and the dedup key is what prevents a same-head duplicate meanwhile.
 */
async function enqueueRecovery(
	project: ProjectConfig,
	provider: SCMProvider,
	candidate: PullRequestDetails,
	prNumber: string,
): Promise<RecoveryEnqueueOutcome> {
	// No marker: not `ciNoFixRecovery` (this head is green, not an adjudicated red)
	// and not `continuationDispatchClaimed` — the handler must take the PR+SHA claim
	// itself, which is what makes a race with a real webhook resolve to one Review.
	const event: ScmEvent = {
		kind: 'checks',
		action: 'completed',
		repoFullName: project.repo,
		workItemId: prNumber,
		isCommentEvent: false,
		headSha: candidate.headSha,
		prBranch: candidate.headBranch,
	};

	for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
		const deliveryId = unreviewedPrRecoveryDeliveryId(
			project,
			prNumber,
			candidate.headSha,
			attempt,
		);
		const { dispatch, created } = await createAndPublishDispatch({
			projectId: project.id,
			jobPayload: {
				type: 'scm',
				providerId: provider.type,
				projectId: project.id,
				deliveryId,
				event,
			},
			dedupKey: deliveryDedupKey(deliveryId),
			source: 'synthetic',
			taskId: prNumber,
			phase: 'review',
		});
		if (created) {
			logger.info('review recovery: handing a ready, unreviewed pull request back to Review', {
				projectId: project.id,
				repository: project.repo,
				prNumber,
				headSha: candidate.headSha,
				attempt,
				dispatchId: dispatch.id,
			});
			return 'scheduled';
		}
		// Still in flight, or it actually produced a Review — either way this head is
		// already accounted for and nothing new may be minted.
		if (!isDeadDispatch(dispatch)) return 'already-scheduled';
		// Dead: that attempt was spent on a dispatch that produced no Review, so the
		// next index is legitimately available.
	}

	logger.warn('review recovery: every permitted recovery attempt for this head is spent', {
		projectId: project.id,
		repository: project.repo,
		prNumber,
		headSha: candidate.headSha,
		maxAttempts: MAX_RECOVERY_ATTEMPTS,
	});
	return 'exhausted';
}

/**
 * Decide and, when nothing objects, recover one candidate pull request.
 *
 * Ordered cheapest-and-most-selective first, with the one extra provider call
 * last, so a healthy repository costs nothing beyond the list read that found it.
 */
async function recoverCandidate(
	project: ProjectConfig,
	provider: SCMProvider,
	candidate: PullRequestDetails,
): Promise<void> {
	const prNumber = String(candidate.number);
	const context = { projectId: project.id, repository: project.repo, prNumber };

	// The list is open-filtered, but each candidate is re-read, so it can report a
	// pull request that closed or merged in between.
	if (candidate.state !== 'open') return;
	// `false` belongs to the `resolve-conflicts` path; `null` is not an answer yet
	// and the next pass simply re-reads it. The sweep runs no defer chain of its own.
	if (candidate.mergeable !== true) return;

	const owned = await resolveSwarmManagedPr(project, candidate.headBranch, 'review-recovery');
	if (owned === 'error') {
		logger.debug('review recovery: ownership unresolved — skipping this pass', context);
		return;
	}
	if (!owned.managed) return;

	if (await hasActiveDispatchForPullRequest(project.id, project.repo, prNumber)) {
		logger.debug('review recovery: something is still due for this pull request — skipping', {
			...context,
			headSha: candidate.headSha,
		});
		return;
	}

	const verdict = classifyReviewLedgerForRecovery(
		await listActiveReviewSlotsForPullRequest(project.id, project.repo, prNumber),
		candidate.headSha,
	);
	if (verdict !== 'recover') {
		logger.debug('review recovery: the review ledger already accounts for this head — skipping', {
			...context,
			headSha: candidate.headSha,
			verdict,
		});
		return;
	}

	let checkStatus: Awaited<ReturnType<SCMProvider['getAggregateCheckStatus']>>;
	try {
		checkStatus = await provider.getAggregateCheckStatus(project, candidate.headSha);
	} catch (err) {
		logger.warn('review recovery: aggregate check read failed — skipping this pass', {
			...context,
			headSha: candidate.headSha,
			error: describeError(err),
		});
		return;
	}
	// Read with the project's own policy, exactly as the handler reads it. `defer`
	// is a pull request legitimately waiting on CI — the case the sweep must not
	// disturb, and the reason it must not spend an attempt yet. `respond-to-ci` is a
	// red that belongs to Respond-to-CI and to #841's hand-back, not here.
	const decision = decideAggregateCheckOutcome(
		checkStatus,
		prNumber,
		project.pipeline?.review?.checks ?? 'required',
	);
	if (decision.action !== 'review') {
		logger.debug('review recovery: checks are not a green completed aggregate — skipping', {
			...context,
			headSha: candidate.headSha,
			checks: decision.action,
		});
		return;
	}

	await enqueueRecovery(project, provider, candidate, prNumber);
}

/** Sweep one repository of one project. Throws nothing the caller has to handle. */
async function recoverRepository(project: ProjectConfig): Promise<void> {
	if (project.pipeline?.review?.enabled === false) {
		logger.debug('review recovery: Review is disabled for this project — skipping repository', {
			projectId: project.id,
			repository: project.repo,
		});
		return;
	}

	// Never a fallback: `requireProjectSCMProvider` throws for an unregistered, a
	// not-runtime-ready, and an unstated `scm`, and resolving a project's operations
	// onto a provider it did not name is the exact failure it exists to prevent.
	let provider: SCMProvider;
	try {
		provider = requireProjectSCMProvider(project);
	} catch (err) {
		logger.debug('review recovery: no SCM provider for this project — skipping repository', {
			projectId: project.id,
			repository: project.repo,
			error: describeError(err),
		});
		return;
	}

	let candidates: PullRequestDetails[];
	try {
		candidates = await provider.listConflictCandidates(project, project.baseBranch);
	} catch (err) {
		logger.warn('review recovery: could not list open pull requests — skipping repository', {
			projectId: project.id,
			repository: project.repo,
			error: describeError(err),
		});
		return;
	}

	logger.debug('review recovery: sweeping open pull requests', {
		projectId: project.id,
		repository: project.repo,
		candidates: candidates.length,
	});

	for (const candidate of candidates) {
		try {
			await recoverCandidate(project, provider, candidate);
		} catch (err) {
			logger.warn('review recovery: candidate failed — continuing the pass', {
				projectId: project.id,
				repository: project.repo,
				prNumber: String(candidate.number),
				error: describeError(err),
			});
		}
	}
}

/**
 * One sweep pass over every repository of every project.
 *
 * Best-effort throughout, on `reconcileDispatchesPeriodically`'s posture: every
 * failure is logged and the pass continues, and this never throws — an unhandled
 * rejection out of a bare `setInterval` callback would take the router down.
 */
export async function recoverUnreviewedPullRequests(): Promise<void> {
	try {
		const records = await listAllProjectRecordsFromDb();
		for (const record of records) {
			for (const entry of record.repositories) {
				try {
					await recoverRepository(scopeProjectToRepository(record, entry.repo));
				} catch (err) {
					logger.warn('review recovery: repository pass failed — continuing the sweep', {
						projectId: record.id,
						repository: entry.repo,
						error: describeError(err),
					});
				}
			}
		}
	} catch (err) {
		logger.error('review recovery: sweep failed (continuing)', { error: describeError(err) });
	}
}
