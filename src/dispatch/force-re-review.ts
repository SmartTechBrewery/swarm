/**
 * "Force re-review" (issue #511) — the operator action that deliberately
 * continues a corrective cycle the review-verdict safety cap stopped.
 *
 * When a Review run submits the last `request-changes` verdict
 * `REVIEW_VERDICT_CAP` allows, SWARM stops on purpose: the
 * `pr-review-submitted` trigger refuses to enqueue a further Respond-to-review,
 * and the run is rendered as **Manual action required**. That is the right
 * default, but until now the only way past it was hand-editing the database —
 * the same gap "Reset & restart" (`./run-reset.ts`) closed for a wedged run.
 *
 * {@link forceReReview} closes it here, and like `resetRun` it is a *sequence*
 * over existing pieces, not a new lifecycle:
 *
 *   1. verify the run really is a capped Review run (every guard runs before the
 *      first mutation, so a refused force changes nothing);
 *   2. grant the PR exactly one extra review slot on its own ledger record
 *      (`grantReviewCapOverride`), so the Review that *follows* the response is
 *      not rejected by the cap it is deliberately bypassing;
 *   3. enqueue the corrective Respond-to-review dispatch — a synthetic
 *      `pull-request-review` event replaying the ledger's own record of the
 *      capped verdict, carrying `forcedReReview` so the trigger's cap gate stands
 *      aside for it.
 *
 * Grant before dispatch, deliberately: a failure between the two leaves an
 * unconsumed grant and no work, which the next call simply re-uses. The reverse
 * order would run the response and then have its follow-up Review rejected.
 *
 * From there the normal pipeline takes over unchanged — Respond-to-review
 * pushes a fix, its `fixed` outcome schedules the follow-up Review
 * (`src/pipeline/follow-up-review.ts`), and that Review reserves the granted
 * slot. Nothing here re-implements any of it.
 *
 * **Idempotent by construction, not by checking.** Both mutations are
 * conditional writes on durable state: the grant only fires while none exists,
 * and the dispatch carries a deterministic dedup key derived from
 * (repo, PR, reviewed head), which the dispatch layer treats as "already
 * recorded" (issue #284). So repeated clicks, concurrent requests, and refreshes
 * all resolve to one corrective cycle, and a second call reports what it found
 * rather than duplicating it or erroring.
 *
 * **A dead prior attempt is not "already recorded".** The dedup key above is
 * deterministic *and permanent* — nothing ever changes a `dispatches` row's
 * `dedup_key` once written, and the unique index that backs it is not
 * partial-by-state. That is exactly right while the prior attempt is still
 * in flight or actually succeeded (a real Respond-to-review run started), but
 * it is wrong for every other terminal outcome: `no-trigger` (the one
 * surfaced live — a stale worker process still running pre-#511 code
 * evaluated the synthetic event before it understood `forcedReReview` and
 * refused it for having no reviewer-persona author), `skipped-not-eligible`,
 * `skipped-duplicate`, `superseded`, or a hard `failed`/`cancelled` dispatch
 * state. None of those produced a corrective run, yet the dedup key is
 * already spent — every future click for that PR/head would find the same
 * dead row forever and report it as "already completed" without ever
 * scheduling real work again. {@link isDeadDispatch} names that condition, and
 * {@link publishForcedDispatch} chains a fresh dedup key off a dead row's own
 * id — deterministically, so concurrent retries still collide with each other
 * — instead of accepting its dead outcome as the last word.
 *
 * **Two shapes, two continuations (issue #1040).** The cap stops a pull request in
 * a second way, and the sequence above is the wrong lever for it: the last
 * permitted verdict is an **approval** whose merge automation then refused because
 * a later push superseded the reviewed head. There is no requested change to
 * answer, so a Respond-to-review has nothing to do — what that shape needs is one
 * authoritative Review of the pull request's *current* head. {@link forceReReview}
 * therefore classifies the run first ({@link classifyForcedContinuation}) and runs
 * one of two branches. The branches share this module's invariant (every guard
 * before the first mutation), the grant primitive, and
 * {@link publishForcedDispatch}'s dedup key and dead-dispatch chaining; they
 * differ only in the event they enqueue — a synthetic `pull-request-review` that
 * starts Respond-to-review, vs. a synthetic `checks`/`completed` naming the
 * current head (the shape `./unreviewed-pr-recovery.ts` builds, under its own
 * delivery-id prefix) that the `pr-review` trigger turns into exactly one Review,
 * with every one of that handler's own gates still applying.
 *
 * The approval branch makes the one provider read this module has — the pull
 * request's current head is in no row SWARM holds — and that read also backs its
 * two extra refusals: a head that never moved (so the merge refusal had another
 * cause, which the run's own merge message names) and a pull request that is
 * closed. It is made here, once per operator click, rather than on every render of
 * the run-detail page.
 *
 * Its cap guard is the one place the two branches read the ledger differently, and
 * deliberately so: it asks whether every permitted verdict has been *submitted*
 * ({@link hasSubmittedEveryPermittedVerdict}) rather than whether the allowance is
 * spent, because the grant this very action writes makes the allowance read
 * unspent until a reservation consumes it. A guard that counted that grant would
 * refuse every click after the first — including the one that exists to chain past
 * a forced dispatch that died before starting a Review — while telling the
 * operator the allowance has room. The #511 branch is unaffected: it is gated on
 * {@link isCapReachingRequestChanges}, which no grant changes.
 *
 * Like `run-reset.ts`, this module knows nothing about tRPC: the API router is a
 * thin surface over it.
 */

import type { ProjectConfig } from '../config/schema.js';
import type { DispatchPhase, DispatchRow } from '../db/repositories/dispatchesRepository.js';
import { getProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import {
	getSubmittedReviewSlot,
	grantReviewCapOverride,
	hasSubmittedEveryPermittedVerdict,
	isCapReachingRequestChanges,
	isLastPermittedVerdict,
	listActiveReviewSlotsForPullRequest,
} from '../db/repositories/reviewVerdictsRepository.js';
import {
	getRunByIdFromDb,
	isPipelineRun,
	type PipelineRunRow,
	type RunRow,
} from '../db/repositories/runsRepository.js';
import { requireProjectSCMProvider } from '../integrations/scm/registry.js';
import { logger } from '../lib/logger.js';
import { normalizeStoredJobPayload, type SwarmJob } from '../queue/jobs.js';
import { deliveryIdentity } from '../scm/delivery.js';
import type { ScmEvent } from '../scm/events.js';
import { isDeadDispatch } from './dead-dispatch.js';
import { createAndPublishDispatch, deliveryDedupKey } from './dispatcher.js';

/** Why a force was refused, machine-readable so each surface maps it to its own error shape. */
export type ForceReReviewRefusal =
	| 'run-not-found'
	| 'project-not-found'
	| 'respond-to-review-disabled'
	| 'review-disabled'
	| 'not-capped'
	| 'missing-coordinates'
	| 'missing-review-record'
	| 'head-unchanged'
	| 'pull-request-closed';

/** A refused force. Its `message` is already operator-facing; surfaces re-use it verbatim. */
export class ForceReReviewError extends Error {
	constructor(
		readonly reason: ForceReReviewRefusal,
		message: string,
	) {
		super(message);
		this.name = 'ForceReReviewError';
	}
}

export interface ForceReReviewResult {
	runId: string;
	prNumber: string;
	/**
	 * Which continuation this force started: the corrective sequence for a capped
	 * `request-changes` run (issue #511), or one Review of the pull request's
	 * current head for the cap-spent approval merge automation refused (issue
	 * #1040).
	 */
	continuation: 'respond-to-review' | 'review';
	/** The reviewed head the capped verdict covered — what the response answers. */
	headSha: string;
	/**
	 * Set only when `continuation === 'review'`: the head the forced Review
	 * targets, i.e. the one that superseded {@link ForceReReviewResult.headSha}.
	 */
	reviewHeadSha?: string;
	/** Whether this call granted the extra review slot or found one already granted. */
	capOverride: 'granted' | 'already-granted';
	/**
	 * Whether this call enqueued the corrective run, found it active, found it
	 * genuinely complete, or — {@link isDeadDispatch} — found a prior attempt
	 * that resolved to a dead terminal outcome and scheduled a fresh one in its
	 * place ('retried').
	 */
	dispatch: 'scheduled' | 'already-scheduled' | 'already-completed' | 'retried';
	dispatchId: string;
	/** The durable dispatch state, including an existing terminal state on a repeated force. */
	dispatchState?: string;
	/** The completed dispatch's outcome, when the worker recorded one. */
	dispatchOutcome?: string | null;
	/**
	 * Set only when `dispatch === 'retried'`: the dead prior attempt's own
	 * outcome, so the caller can explain *why* a fresh dispatch was needed
	 * instead of just reporting the new one as if it were the first.
	 */
	previousAttemptOutcome?: string | null;
}

/**
 * The PR coordinates *both* forced continuations need, recovered from the capped
 * Review run's own stored job payload. They are read rather than re-fetched from
 * the provider for the same reason the trigger handlers read them off the
 * normalized event (`src/scm/events.ts`): the dispatch that started the Review
 * already carried them, so a provider round-trip would only re-derive data SWARM
 * durably holds.
 *
 * Exactly the two each branch actually uses — together they are the ledger key
 * the grant is written on. The branch name is *not* here: only the
 * Respond-to-review continuation replays an event that carries one, so requiring
 * it of both would refuse the superseded-head review over a field it never reads
 * ({@link respondToReviewCoordinates} asks for it where it is needed).
 */
function reviewCoordinates(run: {
	id: string;
	prNumber: string | null;
	jobPayload: SwarmJob | null;
}): { prNumber: string; headSha: string; event: ScmEvent | undefined } {
	// Normalized first: a row written before the queue's #385 envelope rename is
	// *typed* current while still carrying the legacy shape.
	const payload = run.jobPayload ? normalizeStoredJobPayload(run.jobPayload) : undefined;
	const event = payload?.type === 'scm' ? payload.event : undefined;
	const prNumber = run.prNumber ?? event?.workItemId;
	const headSha = event?.headSha;
	if (!prNumber || !headSha) {
		throw new ForceReReviewError(
			'missing-coordinates',
			`Cannot force a re-review for run "${run.id}" — its stored payload no longer names the PR number and reviewed commit the forced continuation needs.`,
		);
	}
	return { prNumber, headSha, event };
}

/**
 * {@link reviewCoordinates} plus the branch the corrective Respond-to-review's
 * synthetic `pull-request-review` event must carry — the one coordinate that
 * belongs to that continuation alone, so its absence refuses only it.
 */
function respondToReviewCoordinates(run: {
	id: string;
	prNumber: string | null;
	jobPayload: SwarmJob | null;
}): { prNumber: string; headSha: string; prBranch: string } {
	const { prNumber, headSha, event } = reviewCoordinates(run);
	const prBranch = event?.prBranch;
	if (!prBranch) {
		throw new ForceReReviewError(
			'missing-coordinates',
			`Cannot force a re-review for run "${run.id}" — its stored payload no longer names the branch the corrective run needs.`,
		);
	}
	return { prNumber, headSha, prBranch };
}

/**
 * Bounds {@link publishForcedDispatch}'s chain walk. Reached only if several
 * forced attempts in a row all resolved dead before this call started — a
 * persistently broken corrective path, not a single stale-worker miss — so the
 * function throws past this rather than inventing a plausible-looking result.
 */
const MAX_DISPATCH_CHAIN_ATTEMPTS = 5;

/**
 * One forced continuation's dispatch stated as data — everything
 * {@link publishForcedDispatch} needs that differs between the two shapes
 * (issue #1040), so the chaining below stays one implementation.
 */
interface ForcedDispatchSpec {
	/**
	 * The delivery-id prefix, one per continuation. Distinct prefixes are what keep
	 * the two shapes' keys apart for the same (repo, PR, head), and what keeps both
	 * apart from `unreviewedPrRecoveryDeliveryId`'s — whose prefix must not be
	 * reused, for the reason stated there.
	 */
	prefix: string;
	/** The head the key is scoped to: the reviewed head for #511, the current one for #1040. */
	headSha: string;
	event: ScmEvent;
	taskId: string;
	phase: DispatchPhase;
	/**
	 * The `respond-to-review` trigger's own cap-gate bypass, set by that
	 * continuation alone: a forced Review is licensed by the ledger grant its
	 * reservation consumes, and no handler but that one reads this flag.
	 */
	forcedReReview?: true;
}

/**
 * Publish a forced dispatch under its deterministic (repo, PR, head) dedup key,
 * or — when that key already names a dead dispatch (issue #511 follow-up; see the
 * module header) — chain a fresh key off the dead row's own id and retry. Each
 * chained key is derived only from data already durable on the dead row, so two
 * callers who both find the same dead row (a genuine double-click, not a webhook
 * redelivery) still derive the same next key and collide with each other rather
 * than each minting their own attempt.
 */
async function publishForcedDispatch(
	project: ProjectConfig,
	prNumber: string,
	spec: ForcedDispatchSpec,
): Promise<{ dispatch: DispatchRow; created: boolean; deadChain: DispatchRow[] }> {
	const { prefix, headSha } = spec;
	let deliveryId = deliveryIdentity([prefix, project.repo, prNumber, headSha]);
	// Every dead row this call walked past, oldest first — not just the latest —
	// so the caller's own log line can name the whole chain, not only its last
	// hop (a multi-hop chain is already an anomaly worth seeing in full).
	const deadChain: DispatchRow[] = [];
	for (let attempt = 0; attempt < MAX_DISPATCH_CHAIN_ATTEMPTS; attempt++) {
		const { dispatch, created } = await createAndPublishDispatch({
			projectId: project.id,
			jobPayload: {
				type: 'scm',
				providerId: requireProjectSCMProvider(project).type,
				projectId: project.id,
				deliveryId,
				...(spec.forcedReReview ? { forcedReReview: true } : {}),
				event: spec.event,
			},
			dedupKey: deliveryDedupKey(deliveryId),
			source: 'manual',
			taskId: spec.taskId,
			phase: spec.phase,
		});
		if (created || !isDeadDispatch(dispatch)) {
			return { dispatch, created, deadChain };
		}
		logger.warn('force re-review: prior forced dispatch resolved dead — chaining a fresh attempt', {
			projectId: project.id,
			prNumber,
			headSha,
			phase: spec.phase,
			deadDispatchId: dispatch.id,
			deadDispatchState: dispatch.state,
			deadDispatchOutcome: dispatch.outcome,
			attempt,
		});
		deadChain.push(dispatch);
		deliveryId = deliveryIdentity([prefix, project.repo, prNumber, headSha, dispatch.id]);
	}
	throw new Error(
		`force re-review: exhausted ${MAX_DISPATCH_CHAIN_ATTEMPTS} chained dispatch attempts for PR #${prNumber} at ${headSha} without reaching a live or successful one — the corrective path is persistently broken (check the worker), not a single stale miss`,
	);
}

/**
 * How {@link publishForcedDispatch}'s answer resolves into the operator-facing
 * report, shared by both branches so "already scheduled" and "retried past a dead
 * attempt" mean exactly the same thing on each.
 */
function describeForcedDispatch(published: {
	dispatch: DispatchRow;
	created: boolean;
	deadChain: DispatchRow[];
}): Pick<
	ForceReReviewResult,
	'dispatch' | 'dispatchId' | 'dispatchState' | 'dispatchOutcome' | 'previousAttemptOutcome'
> {
	// The chain's last hop — the dead dispatch this call's fresh attempt directly
	// replaces — vs. the full chain, which the warn logs above already carried
	// one hop at a time.
	const deadPriorAttempt = published.deadChain.at(-1);
	return {
		dispatch: deadPriorAttempt
			? 'retried'
			: published.created
				? 'scheduled'
				: published.dispatch.state === 'completed'
					? 'already-completed'
					: 'already-scheduled',
		dispatchId: published.dispatch.id,
		dispatchState: published.dispatch.state,
		dispatchOutcome: published.dispatch.outcome,
		previousAttemptOutcome: deadPriorAttempt?.outcome,
	};
}

/**
 * Which recoverable cap stop this run is, or `null` for a run no forced
 * continuation applies to (issue #1040).
 *
 * The two shapes are mutually exclusive by verdict, and only the first is decided
 * in full here. An approval's cap stop is a fact about the *pull request's*
 * ledger, which no column on the run holds (the run-detail view resolves it per
 * read, `reviewCapSpent`), so this admits every completed approving Review and
 * {@link forceReviewOfSupersededHead}'s own guards refuse the rest — including
 * with `not-capped`, so an operator clicking a stale page gets the same answer
 * either way.
 */
function classifyForcedContinuation(
	run: RunRow,
): 'request-changes-capped' | 'cap-spent-approval' | null {
	if (run.status !== 'completed' || run.phase !== 'review') return null;
	if (
		run.reviewVerdict === 'request-changes' &&
		run.reviewAutomationOutcome === 'manual-intervention-required'
	) {
		return 'request-changes-capped';
	}
	return run.reviewVerdict === 'approve' ? 'cap-spent-approval' : null;
}

/**
 * Continue the corrective cycle for one capped `request-changes` Review run —
 * issue #511's original sequence, unchanged in guard order, messages, dedup key
 * and result.
 */
async function continueCorrectiveCycle(
	run: PipelineRunRow,
	project: ProjectConfig,
): Promise<ForceReReviewResult> {
	const runId = run.id;
	if (project.pipeline?.respondToReview?.enabled === false) {
		throw new ForceReReviewError(
			'respond-to-review-disabled',
			`Cannot force a re-review for run "${runId}" because Respond-to-review is disabled for this project. Enable pipeline.respondToReview.enabled before continuing the corrective cycle.`,
		);
	}

	const { prNumber, headSha, prBranch } = respondToReviewCoordinates(run);
	// The submitted review the forced response must answer. Its id pins the
	// Respond-to-review phase to that one batched review, exactly as the real
	// webhook would have.
	const slot = await getSubmittedReviewSlot({
		projectId: project.id,
		repository: project.repo,
		prNumber,
		headSha,
	});
	if (!slot?.reviewId) {
		throw new ForceReReviewError(
			'missing-review-record',
			`Cannot force a re-review for run "${runId}" — the review-verdict ledger holds no submitted review for PR #${prNumber} at ${headSha}.`,
		);
	}
	if (!isCapReachingRequestChanges(slot.ordinal, slot.verdict ?? run.reviewVerdict)) {
		throw new ForceReReviewError(
			'not-capped',
			`Run "${runId}" reports a capped review, but its ledger slot (ordinal ${slot.ordinal}) is not at the cap — refresh to see the PR's current review state.`,
		);
	}

	const capOverride = await grantReviewCapOverride({
		projectId: project.id,
		repository: project.repo,
		prNumber,
		headSha,
	});
	if (capOverride === 'no-submitted-slot') {
		// Only reachable if the slot was voided between the two reads above.
		throw new ForceReReviewError(
			'missing-review-record',
			`Cannot force a re-review for run "${runId}" — PR #${prNumber}'s review-verdict slot for ${headSha} is no longer submitted.`,
		);
	}

	const event: ScmEvent = {
		kind: 'pull-request-review',
		action: 'submitted',
		repoFullName: project.repo,
		workItemId: prNumber,
		isCommentEvent: false,
		reviewState: 'changes-requested',
		reviewId: slot.reviewId,
		headSha,
		prBranch,
	};
	const published = await publishForcedDispatch(project, prNumber, {
		prefix: 'force-re-review',
		headSha,
		event,
		taskId: `${prNumber}-respond`,
		phase: 'respond-to-review',
		forcedReReview: true,
	});
	const described = describeForcedDispatch(published);

	logger.info('force re-review scheduled', {
		runId: run.id,
		projectId: project.id,
		prNumber,
		headSha,
		reviewOrdinal: slot.ordinal,
		capOverride,
		dispatchId: published.dispatch.id,
		created: published.created,
		chainedPastDeadDispatchId: published.deadChain.at(-1)?.id,
		deadDispatchChain: published.deadChain.map((d) => d.id),
	});

	return {
		runId: run.id,
		prNumber,
		continuation: 'respond-to-review',
		headSha,
		capOverride,
		...described,
	};
}

/**
 * Force one Review of the pull request's current head for a cap-spent approval
 * merge automation refused (issue #1040).
 *
 * Same shape as the branch above and the same invariant — every guard, including
 * the provider read, runs before the grant — but a different continuation: the
 * approval answered a commit a later push superseded, so what is missing is a
 * verdict on the head that is actually there, not a response to a request that
 * was never made.
 *
 * The grant is recorded on the *approving* slot, which is legitimate because
 * `reserveReviewVerdict` looks for any unconsumed grant among the pull request's
 * active slots — so it licenses the review of the new head without the ledger
 * needing a concept of "granted for head X".
 */
async function forceReviewOfSupersededHead(
	run: PipelineRunRow,
	project: ProjectConfig,
): Promise<ForceReReviewResult> {
	const runId = run.id;
	// This continuation *is* a Review, so it is `review` that gates it — the
	// `respondToReview` switch the other branch reads has no say here.
	if (project.pipeline?.review?.enabled === false) {
		throw new ForceReReviewError(
			'review-disabled',
			`Cannot force a review for run "${runId}" because Review is disabled for this project. Enable pipeline.review.enabled before forcing a review of the pull request's current head.`,
		);
	}

	const { prNumber, headSha } = reviewCoordinates(run);
	// The branch is deliberately not read: this continuation's synthetic event
	// names the *current* head's branch, which comes from the provider below.
	// The slot the grant will be written on. No `reviewId` is needed — nothing
	// replays this approval; the dispatch below names a commit, not a review.
	const slot = await getSubmittedReviewSlot({
		projectId: project.id,
		repository: project.repo,
		prNumber,
		headSha,
	});
	if (!slot) {
		throw new ForceReReviewError(
			'missing-review-record',
			`Cannot force a review for run "${runId}" — the review-verdict ledger holds no submitted review for PR #${prNumber} at ${headSha}, so there is no slot to record the override on.`,
		);
	}
	// The ledger re-check, mirroring the other branch's: the run row alone cannot
	// say whether the pull request is stopped, because a later verdict or a
	// recovered slot changes the answer after the run ended.
	//
	// `hasSubmittedEveryPermittedVerdict`, deliberately, and not
	// `isReviewAllowanceSpent`: the latter also answers false while an unconsumed
	// grant exists — which is exactly the state *this action* leaves behind between
	// writing the grant and the Review it pays for reserving its slot. Refusing
	// there would make the first click the only one this pull request ever gets,
	// and would put the dispatch step — the half that chains past a prior attempt
	// that resolved dead without starting a run — out of reach for the case it was
	// written for. Both writes past this point are idempotent, so a repeat click
	// reports the grant and the dispatch it finds instead.
	const slots = await listActiveReviewSlotsForPullRequest(project.id, project.repo, prNumber);
	if (!hasSubmittedEveryPermittedVerdict(slots) || !isLastPermittedVerdict(slots, slot.ordinal)) {
		throw new ForceReReviewError(
			'not-capped',
			`Run "${runId}" approved PR #${prNumber}, but that approval is not the verdict the review cap stopped the pull request at (ledger ordinal ${slot.ordinal}) — either the allowance still has a verdict left, or a later review has since superseded this one. Refresh to see the pull request's current review state.`,
		);
	}

	// The one provider read: the current head is in no row SWARM holds, and it is
	// what both remaining refusals are decided against. A read that throws is an
	// internal failure, not a refusal the operator is asked to resolve.
	const details = await requireProjectSCMProvider(project).getPullRequest(
		project,
		Number(prNumber),
	);
	if (details.state !== 'open') {
		throw new ForceReReviewError(
			'pull-request-closed',
			`Cannot force a review for run "${runId}" — PR #${prNumber} is no longer open, so it has no current head to review.`,
		);
	}
	if (details.headSha === headSha) {
		throw new ForceReReviewError(
			'head-unchanged',
			`Cannot force a review for run "${runId}" — PR #${prNumber} is still at ${headSha}, the commit this run approved. Nothing superseded the approval, so the merge was refused for another reason; see this run's merge result for the provider's own message.`,
		);
	}

	const capOverride = await grantReviewCapOverride({
		projectId: project.id,
		repository: project.repo,
		prNumber,
		headSha,
	});
	if (capOverride === 'no-submitted-slot') {
		// Only reachable if the slot was voided between the two reads above.
		throw new ForceReReviewError(
			'missing-review-record',
			`Cannot force a review for run "${runId}" — PR #${prNumber}'s review-verdict slot for ${headSha} is no longer submitted.`,
		);
	}

	// No marker, exactly as `./unreviewed-pr-recovery.ts` builds it: the `pr-review`
	// handler takes the PR+SHA claim itself, so a race with a real `checks` webhook
	// for the same head resolves to one Review, and every one of that handler's own
	// gates (closed-PR skip, mergeability route, automation label, aggregate-checks
	// routing, the ledger reservation that spends the grant) still applies.
	const event: ScmEvent = {
		kind: 'checks',
		action: 'completed',
		repoFullName: project.repo,
		workItemId: prNumber,
		isCommentEvent: false,
		headSha: details.headSha,
		prBranch: details.headBranch,
	};
	const published = await publishForcedDispatch(project, prNumber, {
		prefix: 'force-review-head',
		headSha: details.headSha,
		event,
		taskId: prNumber,
		phase: 'review',
	});
	const described = describeForcedDispatch(published);

	logger.info('force review of superseded head scheduled', {
		runId: run.id,
		projectId: project.id,
		prNumber,
		reviewedHeadSha: headSha,
		currentHeadSha: details.headSha,
		reviewOrdinal: slot.ordinal,
		capOverride,
		dispatchId: published.dispatch.id,
		created: published.created,
		chainedPastDeadDispatchId: published.deadChain.at(-1)?.id,
		deadDispatchChain: published.deadChain.map((d) => d.id),
	});

	return {
		runId: run.id,
		prNumber,
		continuation: 'review',
		headSha,
		reviewHeadSha: details.headSha,
		capOverride,
		...described,
	};
}

/**
 * Continue past the review cap for one stopped Review run, in whichever of the
 * two ways its shape allows. Throws {@link ForceReReviewError} for every refusal
 * the caller is expected to surface; anything else propagates as an internal
 * failure.
 */
export async function forceReReview(runId: string): Promise<ForceReReviewResult> {
	const run = await getRunByIdFromDb(runId);
	if (!run) {
		throw new ForceReReviewError('run-not-found', `Run with ID "${runId}" not found`);
	}
	const shape = classifyForcedContinuation(run);
	// `isPipelineRun` (issue #971) is stated here rather than left to ride on the
	// `missing-coordinates` refusal inside each branch: a maintenance run does trip
	// that one, but only through `prNumber`/`workItemId`, whereas `run.repository` is
	// consumed by the project read in between — so this is the site that has to
	// decide, and a machine-maintenance run is exactly "not a Review run at all".
	if (!shape || !isPipelineRun(run)) {
		throw new ForceReReviewError(
			'not-capped',
			`Run "${runId}" is neither a completed Review run the cap stopped with a changes-requested verdict nor a completed Review run that approved, so there is no cycle to continue and no superseded head to review.`,
		);
	}
	// Scoped to the repository the *run* recorded, not the project's default entry
	// (issue #684 phase 2): every value derived from `project` below — the dedup
	// delivery id, the ledger key, the provider read, the synthetic event's
	// `repoFullName` — has to name the repository whose PR was actually reviewed, or
	// the forced continuation would answer a review in a different repository. A
	// project that no longer owns it throws out of the read rather than falling back.
	const project = await getProjectByIdFromDb(run.projectId, run.repository);
	if (!project) {
		throw new ForceReReviewError(
			'project-not-found',
			`Cannot force a re-review for run "${runId}" — its project "${run.projectId}" no longer exists.`,
		);
	}
	return shape === 'request-changes-capped'
		? continueCorrectiveCycle(run, project)
		: forceReviewOfSupersededHead(run, project);
}
