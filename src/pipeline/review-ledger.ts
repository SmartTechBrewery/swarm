/**
 * The Review phase's **review-verdict ledger** seam — the three ledger
 * operations `./review.ts` performs around a submitted verdict, named as one
 * contract so a caller can substitute where they run.
 *
 * The ledger itself is a Postgres table (`review_verdicts`,
 * `../db/repositories/reviewVerdictsRepository.ts`): it enforces the two-verdict
 * safety cap (issue #235) and answers "did this PR already receive a submitted
 * verdict at an earlier head?", which turns the next run into a re-review (issue
 * #328). Both matter to correctness, so a Review run cannot simply skip them.
 *
 * A **DB-free** remote worker (ADR-003 §2) holds no `DATABASE_URL`, so it cannot
 * call the repository at all. It injects a transport-backed implementation of
 * this interface instead (`../transport/review-ledger-delivery.ts`), which POSTs
 * to the control plane's ledger routes (`../router/worker-delivery.ts`) — the
 * same shape as the metadata-delivery split: the operation runs where its backing
 * resource lives, and only its inputs and result cross the wire. The in-process
 * and same-host paths inject nothing and keep the repository defaults, so their
 * behaviour is byte-for-byte unchanged.
 *
 * Typed against the repository's own `ReviewVerdictKey`/`ReviewVerdictRecord`
 * (type-only imports, erased at build) so the contract cannot drift from the
 * table it fronts.
 */

import type {
	ReviewVerdictKey,
	ReviewVerdictRecord,
} from '../db/repositories/reviewVerdictsRepository.js';

/** The three ledger operations a Review run performs. See the module header. */
export interface ReviewVerdictLedger {
	/**
	 * The PR's most recent *submitted* verdict at an **earlier** head, or
	 * `undefined` when this is its first review — the re-review signal (issue #328).
	 */
	getPriorSubmittedReview(
		projectId: string,
		repository: string,
		prNumber: string,
		currentHeadSha: string,
	): Promise<ReviewVerdictRecord | undefined>;

	/**
	 * Mark this PR/head's reserved slot `submitted` and return its ordinal — which
	 * decides whether this verdict is the cap-reaching second `request-changes`
	 * (issue #235). Idempotent by natural key.
	 */
	markReviewVerdictSubmitted(
		key: ReviewVerdictKey,
		data: { verdict: string; reviewId?: string },
	): Promise<{ id: string; ordinal: number } | undefined>;

	/**
	 * Release this PR/head's still-`pending` slot after a failure that certainly
	 * submitted nothing, so the failed attempt doesn't charge the PR a slot.
	 */
	abandonReviewVerdict(key: ReviewVerdictKey): Promise<void>;
}
