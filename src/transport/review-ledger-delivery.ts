/**
 * Worker-side transport-backed {@link ReviewVerdictLedger} (ADR-003 §2) — the
 * ledger half of the DB-free Review phase, sibling to the metadata-write
 * delegates (`../scm/transport-delivery.ts`, `../pm/transport-delivery.ts`).
 *
 * A DB-free remote worker holds no `DATABASE_URL`, so it cannot read or write
 * `review_verdicts` — the table carrying the two-verdict safety cap (issue #235)
 * and the prior-submitted-verdict answer that makes a run a re-review (issue
 * #328). Skipping them is not an option: the cap would stop capping and every
 * re-review would be prompted as a first review. So the three operations travel
 * up the transport to the control plane, which owns the database
 * (`../router/worker-delivery.ts`), and only the PR coordinates and the resulting
 * slot cross the wire — never the repository tree (ai/RULES.md §1).
 *
 * `projectId`/`repository` in the ledger key are resolved **server-side** from the
 * authenticated project, so the `projectId` this client sends is an
 * authorization input, not a key the worker gets to choose, and the `repository`
 * the phase passes is deliberately not sent at all.
 *
 * A non-2xx or unparseable response **throws**, exactly as a failed repository
 * call would, so the Review phase's existing handling applies unchanged: a
 * pre-agent lookup failure fails the run before any delivery, and a post-delivery
 * failure runs the same worktree-preserving deferral.
 */

import type { ReviewVerdictLedger } from '../pipeline/review-ledger.js';
import { type DeliveryClientOptions, postDelivery } from './delivery-client.js';
import {
	AbandonReviewLedgerResponseSchema,
	MarkReviewLedgerResponseSchema,
	PriorReviewLedgerResponseSchema,
} from './protocol.js';

export interface TransportReviewLedgerOptions extends DeliveryClientOptions {
	/** The project id, sent so the server authorizes this worker and keys the ledger row. */
	projectId: string;
}

/**
 * Build a transport-backed review-verdict ledger. Every operation POSTs to the
 * control plane's `/worker/delivery/review-ledger/*` routes; `null` in a response
 * (no prior review, no reserved slot) maps back to the `undefined` the repository
 * returns, so the phase reads one shape on both paths.
 */
export function createTransportReviewLedger(
	options: TransportReviewLedgerOptions,
): ReviewVerdictLedger {
	return {
		// `repository` is intentionally unused: the server derives it from the
		// authenticated project, so a worker cannot key a row to another repo.
		getPriorSubmittedReview: (_projectId, _repository, prNumber, currentHeadSha) =>
			postDelivery(
				options,
				'/worker/delivery/review-ledger/prior',
				{ projectId: options.projectId, prNumber, currentHeadSha },
				(value) => PriorReviewLedgerResponseSchema.parse(value).record ?? undefined,
			),
		markReviewVerdictSubmitted: (key, data) =>
			postDelivery(
				options,
				'/worker/delivery/review-ledger/mark',
				{
					projectId: options.projectId,
					prNumber: key.prNumber,
					headSha: key.headSha,
					verdict: data.verdict,
					reviewId: data.reviewId,
				},
				(value) => MarkReviewLedgerResponseSchema.parse(value).slot ?? undefined,
			),
		abandonReviewVerdict: (key) =>
			postDelivery(
				options,
				'/worker/delivery/review-ledger/abandon',
				{ projectId: options.projectId, prNumber: key.prNumber, headSha: key.headSha },
				(value) => {
					AbandonReviewLedgerResponseSchema.parse(value);
				},
			),
	};
}
