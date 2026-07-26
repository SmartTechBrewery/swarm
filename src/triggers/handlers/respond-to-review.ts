/**
 * Respond-to-review trigger — starts the Respond-to-review phase
 * (`src/pipeline/respond-to-review.ts`) whenever the reviewer persona submits
 * a reviewer-persona review. By default it only starts when that review requests
 * changes, avoiding a separate agent run for approvals and minor comments.
 *
 * Set `pipeline.respondToReview.skipOnMinors` to `false` to restore the former
 * every-verdict behaviour, including an acknowledgement after an approval. This
 * handler decides whether the review warrants a run; the phase itself remains
 * responsible for addressing the batched findings it receives.
 *
 * Two gates make this fire on exactly the right event:
 *  - **The final submitted review, not line comments.** Only a
 *    `pull-request-review` `submitted` event matches; individual line comments
 *    arrive as a different provider event (which SWARM doesn't process) and edits /
 *    dismissals carry a non-`submitted` action.
 *  - **Authored by the reviewer persona.** Self-review is impossible, so a human's
 *    review or the implementer's own event must not start a response.
 *    `SCMProvider.personaForActor` confirms the review's author is the *reviewer*
 *    persona before dispatching.
 *
 * **The review-verdict safety cap (issue #235).** A `changes_requested` event
 * that is the last permitted verdict the review-verdict ledger allowed
 * (`src/db/repositories/reviewVerdictsRepository.ts`) stops the cycle here
 * instead of dispatching another Respond-to-review run: the PR needs a human
 * to intervene, not a further automatic review. The ledger record is resolved by
 * the submitted review's id, falling back to PR/head for the narrow webhook
 * race before the Review phase has stored it; a lookup error or a missing
 * record for a `changes_requested` event fails closed (skips the dispatch)
 * rather than risk reopening an unbounded cycle on a persistence outage.
 */

import type { ProjectConfig } from '../../config/schema.js';
import {
	getReviewVerdictByHead as getReviewVerdictByHeadDefault,
	getReviewVerdictByReviewId as getReviewVerdictByReviewIdDefault,
	isCapReachingRequestChanges,
} from '../../db/repositories/reviewVerdictsRepository.js';
import { logger } from '../../lib/logger.js';
import type { ScmEvent } from '../../scm/events.js';
import type { TriggerContext, TriggerHandler, TriggerResult } from '../types.js';

/**
 * Resolve the webhook coordinates that cannot be recovered from the verdict
 * ledger, or `null` — logging why — when any is missing from the event. The
 * head SHA is deliberately excluded: a provider can omit both of its webhook SHA
 * fields, while a SWARM-submitted review has already recorded its exact head in
 * the durable ledger under `reviewId`.
 */
function resolveWebhookCoordinates(
	event: ScmEvent,
): { prNumber: string; prBranch: string; reviewId: string } | null {
	const { workItemId: prNumber, prBranch, reviewId } = event;
	if (!prNumber || !prBranch || !reviewId) {
		logger.warn('respond-to-review: event missing PR/branch/review coordinates — skipping', {
			prNumber,
			hasBranch: !!prBranch,
			hasReviewId: !!reviewId,
		});
		return null;
	}
	return { prNumber, prBranch, reviewId };
}

export interface RespondToReviewTriggerDeps {
	/**
	 * Injectable review-verdict ledger lookups (issue #235) — default to the real
	 * repository calls; overridden in tests. Persona identities are *not* injected:
	 * they resolve through the context's `SCMProvider`, which a test substitutes
	 * wholesale.
	 */
	getReviewVerdictByReviewId?: typeof getReviewVerdictByReviewIdDefault;
	getReviewVerdictByHead?: typeof getReviewVerdictByHeadDefault;
}

export function createRespondToReviewTrigger(
	deps: RespondToReviewTriggerDeps = {},
): TriggerHandler {
	const getReviewVerdictByReviewId =
		deps.getReviewVerdictByReviewId ?? getReviewVerdictByReviewIdDefault;
	const getReviewVerdictByHead = deps.getReviewVerdictByHead ?? getReviewVerdictByHeadDefault;

	/**
	 * Resolve the safety-cap record for a changes-requested verdict. A matching
	 * record also supplies the authoritative reviewed SHA when GitHub omitted it
	 * from the webhook. Returns `null` for a cap-reaching verdict, lookup error,
	 * or missing record — all fail closed (see the module header).
	 */
	async function resolveChangesRequestedVerdict(
		project: ProjectConfig,
		prNumber: string,
		reviewId: string,
		headSha: string | undefined,
	): Promise<Awaited<ReturnType<typeof getReviewVerdictByReviewId>> | null> {
		try {
			const record =
				(await getReviewVerdictByReviewId(project.id, project.repo, reviewId)) ??
				(headSha
					? await getReviewVerdictByHead(project.id, project.repo, prNumber, headSha)
					: undefined);
			if (!record) {
				logger.error(
					'respond-to-review: no review-verdict ledger record for this changes-requested review — failing closed',
					{ prNumber, headSha, reviewId },
				);
				return null;
			}
			const verdict = record.verdict ?? 'request-changes';
			if (isCapReachingRequestChanges(record.ordinal, verdict)) {
				logger.warn(
					'respond-to-review: second changes-requested verdict reached the review cap — stopping the automatic cycle (manual intervention required)',
					{ prNumber, headSha, reviewId },
				);
				return null;
			}
			return record;
		} catch (err) {
			logger.error('respond-to-review: failed to read review-verdict cap state — failing closed', {
				prNumber,
				headSha,
				reviewId,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	async function resolveDispatchHeadSha(
		project: ProjectConfig,
		event: ScmEvent,
		coords: { prNumber: string; reviewId: string },
	): Promise<string | null> {
		if (event.reviewState !== 'changes-requested') return event.headSha ?? null;

		const record = await resolveChangesRequestedVerdict(
			project,
			coords.prNumber,
			coords.reviewId,
			event.headSha,
		);
		if (!record) return null;

		const headSha = event.headSha ?? record.headSha;
		if (headSha) return headSha;

		logger.warn(
			'respond-to-review: event and verdict ledger both lack reviewed head SHA — skipping',
			{
				prNumber: coords.prNumber,
				reviewId: coords.reviewId,
			},
		);
		return null;
	}

	return {
		name: 'pr-review-submitted',
		description:
			'Starts Respond-to-review on a reviewer-persona changes-requested review (or every verdict when skipOnMinors is false)',

		matches(ctx: TriggerContext): boolean {
			if (ctx.source !== 'scm') return false;
			const { event } = ctx;
			if (event.kind !== 'pull-request-review') return false;
			// Only a submitted review — not an edit or a dismissal. `handle` applies
			// the configured verdict policy after this cheap shape match.
			if (event.action !== 'submitted') return false;
			return true;
		},

		async handle(ctx: TriggerContext): Promise<TriggerResult | null> {
			if (ctx.source !== 'scm') return null;
			const { event, project } = ctx;
			if (project.pipeline?.respondToReview?.enabled === false) {
				logger.debug('respond-to-review: phase disabled — skipping');
				return null;
			}
			if (
				project.pipeline?.respondToReview?.skipOnMinors !== false &&
				event.reviewState !== 'changes-requested'
			) {
				logger.debug('respond-to-review: minor review skipped by project setting', {
					reviewState: event.reviewState,
				});
				return null;
			}

			if (!event.actorLogin) {
				logger.debug('respond-to-review: review has no author — skipping');
				return null;
			}

			const identities = await ctx.scm.resolvePersonaIdentities(project);
			const persona = ctx.scm.personaForActor(event.actorLogin, identities);
			if (persona !== 'reviewer') {
				// A human review, or the implementer's own event — not the reviewer
				// persona's batched review, so not an auto-response trigger.
				logger.debug('respond-to-review: review not authored by reviewer persona — skipping', {
					reviewAuthor: event.actorLogin,
					expectedReviewer: identities.reviewer,
				});
				return null;
			}

			const coords = resolveWebhookCoordinates(event);
			if (!coords) return null;
			const { prNumber, prBranch, reviewId } = coords;
			const headSha = await resolveDispatchHeadSha(project, event, coords);
			if (!headSha) return null;

			logger.debug('respond-to-review: dispatching Respond-to-review phase', {
				prNumber,
				prBranch,
				reviewId,
			});
			// Suffixed, not bare `prNumber`: the Review phase's own worktree
			// (`task-<prNumber>`) can still be open when this dispatches — a review
			// verdict fires this trigger the moment it's submitted, well before the
			// review agent's process (and its worktree cleanup) actually exits. A
			// shared taskId would make the two `provision` calls race for one
			// worktree path (see git history for the incident this fixed).
			return {
				phase: 'respond-to-review',
				taskId: `${prNumber}-respond`,
				prNumber,
				prBranch,
				reviewId,
				headSha,
			};
		},
	};
}
