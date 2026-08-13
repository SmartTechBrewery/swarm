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
 * Like `run-reset.ts`, this module knows nothing about tRPC: the API router is a
 * thin surface over it.
 */

import type { ProjectConfig } from '../config/schema.js';
import {
	ACTIVE_DISPATCH_STATES,
	type DispatchRow,
} from '../db/repositories/dispatchesRepository.js';
import { getProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import {
	getSubmittedReviewSlot,
	grantReviewCapOverride,
	isCapReachingRequestChanges,
} from '../db/repositories/reviewVerdictsRepository.js';
import { getRunByIdFromDb } from '../db/repositories/runsRepository.js';
import { requireProjectSCMProvider } from '../integrations/scm/registry.js';
import { logger } from '../lib/logger.js';
import { normalizeStoredJobPayload, type SwarmJob } from '../queue/jobs.js';
import { deliveryIdentity } from '../scm/delivery.js';
import type { ScmEvent } from '../scm/events.js';
import { createAndPublishDispatch, deliveryDedupKey } from './dispatcher.js';

/** Why a force was refused, machine-readable so each surface maps it to its own error shape. */
export type ForceReReviewRefusal =
	| 'run-not-found'
	| 'project-not-found'
	| 'respond-to-review-disabled'
	| 'not-capped'
	| 'missing-coordinates'
	| 'missing-review-record';

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
	/** The reviewed head the capped verdict covered — what the response answers. */
	headSha: string;
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
 * The PR coordinates a forced Respond-to-review needs, recovered from the capped
 * Review run's own stored job payload. They are read rather than re-fetched from
 * the provider for the same reason the trigger handlers read them off the
 * normalized event (`src/scm/events.ts`): the dispatch that started the Review
 * already carried them, so a provider round-trip would only re-derive data SWARM
 * durably holds.
 */
function reviewCoordinates(run: {
	id: string;
	prNumber: string | null;
	jobPayload: SwarmJob | null;
}): { prNumber: string; headSha: string; prBranch: string } {
	// Normalized first: a row written before the queue's #385 envelope rename is
	// *typed* current while still carrying the legacy shape.
	const payload = run.jobPayload ? normalizeStoredJobPayload(run.jobPayload) : undefined;
	const event = payload?.type === 'scm' ? payload.event : undefined;
	const prNumber = run.prNumber ?? event?.workItemId;
	const headSha = event?.headSha;
	const prBranch = event?.prBranch;
	if (!prNumber || !headSha || !prBranch) {
		throw new ForceReReviewError(
			'missing-coordinates',
			`Cannot force a re-review for run "${run.id}" — its stored payload no longer names the PR number, reviewed commit, and branch the corrective run needs.`,
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
 * Whether a dispatch's outcome means the corrective cycle it was meant to run
 * never actually happened (see the module header). A non-terminal dispatch is
 * never dead — it may yet succeed, and forcing past one still in flight would
 * race the attempt already running. A `completed` dispatch is dead unless its
 * outcome is `phase-succeeded`: every other completion (`no-trigger`,
 * `skipped-not-eligible`, `skipped-duplicate`, `superseded`) means the trigger
 * refused the event or the worker decided against a run, not that Respond-to-review
 * actually started.
 *
 * `DispatchOutcome` also names merge-automation-only completions (`merged`,
 * `merge-not-eligible`, …), which this would likewise call dead. That's outside
 * what a Respond-to-review dispatch can ever actually record — this module
 * always creates one with `phase: 'respond-to-review'`, never `merge-automation`
 * — so it's a harmless breadth mismatch, not a bug: the check is scoped to
 * "is this a real outcome", and no code path here ever produces a merge one.
 */
function isDeadDispatch(dispatch: Pick<DispatchRow, 'state' | 'outcome'>): boolean {
	if (ACTIVE_DISPATCH_STATES.includes(dispatch.state as (typeof ACTIVE_DISPATCH_STATES)[number])) {
		return false;
	}
	if (dispatch.state === 'completed') return dispatch.outcome !== 'phase-succeeded';
	// 'cancelled' or 'failed'.
	return true;
}

/**
 * Publish the forced Respond-to-review dispatch under its deterministic
 * (repo, PR, reviewed head) dedup key, or — when that key already names a dead
 * dispatch (issue #511 follow-up; see the module header) — chain a fresh key
 * off the dead row's own id and retry. Each chained key is derived only from
 * data already durable on the dead row, so two callers who both find the same
 * dead row (a genuine double-click, not a webhook redelivery) still derive the
 * same next key and collide with each other rather than each minting their own
 * corrective attempt.
 */
async function publishForcedDispatch(
	project: ProjectConfig,
	prNumber: string,
	headSha: string,
	event: ScmEvent,
): Promise<{ dispatch: DispatchRow; created: boolean; deadChain: DispatchRow[] }> {
	let deliveryId = deliveryIdentity(['force-re-review', project.repo, prNumber, headSha]);
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
				forcedReReview: true,
				event,
			},
			dedupKey: deliveryDedupKey(deliveryId),
			source: 'manual',
			taskId: `${prNumber}-respond`,
			phase: 'respond-to-review',
		});
		if (created || !isDeadDispatch(dispatch)) {
			return { dispatch, created, deadChain };
		}
		logger.warn('force re-review: prior forced dispatch resolved dead — chaining a fresh attempt', {
			projectId: project.id,
			prNumber,
			headSha,
			deadDispatchId: dispatch.id,
			deadDispatchState: dispatch.state,
			deadDispatchOutcome: dispatch.outcome,
			attempt,
		});
		deadChain.push(dispatch);
		deliveryId = deliveryIdentity([
			'force-re-review',
			project.repo,
			prNumber,
			headSha,
			dispatch.id,
		]);
	}
	throw new Error(
		`force re-review: exhausted ${MAX_DISPATCH_CHAIN_ATTEMPTS} chained dispatch attempts for PR #${prNumber} at ${headSha} without reaching a live or successful one — the corrective path is persistently broken (check the worker), not a single stale miss`,
	);
}

/**
 * Continue the corrective cycle for one capped Review run. Throws
 * {@link ForceReReviewError} for every refusal the caller is expected to
 * surface; anything else propagates as an internal failure.
 */
export async function forceReReview(runId: string): Promise<ForceReReviewResult> {
	const run = await getRunByIdFromDb(runId);
	if (!run) {
		throw new ForceReReviewError('run-not-found', `Run with ID "${runId}" not found`);
	}
	// The exact state the run-detail view renders as "Manual action required" —
	// the only state a forced continuation makes sense from. Anything else either
	// never stopped (so nothing needs forcing) or is not a Review run at all.
	if (
		run.status !== 'completed' ||
		run.phase !== 'review' ||
		run.reviewVerdict !== 'request-changes' ||
		run.reviewAutomationOutcome !== 'manual-intervention-required'
	) {
		throw new ForceReReviewError(
			'not-capped',
			`Run "${runId}" is not a completed Review run stopped by the review cap, so there is no cycle to continue.`,
		);
	}
	// Scoped to the repository the *run* recorded, not the project's default entry
	// (issue #684 phase 2): every value derived from `project` below — the dedup
	// delivery id, the ledger key, the synthetic event's `repoFullName` — has to name
	// the repository whose PR was actually reviewed, or the forced continuation would
	// answer a review in a different repository. A project that no longer owns it
	// throws out of the read rather than falling back.
	const project = await getProjectByIdFromDb(run.projectId, run.repository);
	if (!project) {
		throw new ForceReReviewError(
			'project-not-found',
			`Cannot force a re-review for run "${runId}" — its project "${run.projectId}" no longer exists.`,
		);
	}
	if (project.pipeline?.respondToReview?.enabled === false) {
		throw new ForceReReviewError(
			'respond-to-review-disabled',
			`Cannot force a re-review for run "${runId}" because Respond-to-review is disabled for this project. Enable pipeline.respondToReview.enabled before continuing the corrective cycle.`,
		);
	}

	const { prNumber, headSha, prBranch } = reviewCoordinates(run);
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
	const { dispatch, created, deadChain } = await publishForcedDispatch(
		project,
		prNumber,
		headSha,
		event,
	);
	// The chain's last hop — the dead dispatch this call's fresh attempt directly
	// replaces — vs. the full chain, which the warn logs above already carried
	// one hop at a time.
	const deadPriorAttempt = deadChain.at(-1);

	logger.info('force re-review scheduled', {
		runId: run.id,
		projectId: project.id,
		prNumber,
		headSha,
		reviewOrdinal: slot.ordinal,
		capOverride,
		dispatchId: dispatch.id,
		created,
		chainedPastDeadDispatchId: deadPriorAttempt?.id,
		deadDispatchChain: deadChain.map((d) => d.id),
	});

	return {
		runId: run.id,
		prNumber,
		headSha,
		capOverride,
		dispatch: deadPriorAttempt
			? 'retried'
			: created
				? 'scheduled'
				: dispatch.state === 'completed'
					? 'already-completed'
					: 'already-scheduled',
		dispatchId: dispatch.id,
		dispatchState: dispatch.state,
		dispatchOutcome: dispatch.outcome,
		previousAttemptOutcome: deadPriorAttempt?.outcome,
	};
}
