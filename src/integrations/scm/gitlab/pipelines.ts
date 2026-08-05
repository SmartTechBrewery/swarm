/**
 * GitLab's pipeline vocabulary, shared by every half that has to agree on it:
 * webhook ingress (`./webhook.ts`, phase 2/4) and the aggregate check read
 * (phase 3/4). Both a normalized event's `checkConclusion` and an API read's
 * conclusion end up in the *same* exact-match consumers — the queue read model
 * keys on `failure` (`src/queue/queued-runs.ts`) and
 * `src/triggers/handlers/aggregate-check-decision.ts` classifies the rest — so a
 * second spelling of a status would split one pipeline into two answers. This is
 * the role `../bitbucket/commits.ts` plays for Bitbucket's build states.
 *
 * ## There is no abbreviated-hash invariant here
 *
 * Bitbucket abbreviates a pull request's commit hash to 12 characters in its
 * event payloads while naming the same commit in full elsewhere, which is why
 * `../bitbucket/commits.ts` narrows every SHA it emits (`abbreviateBitbucketSha`)
 * and compares prefix-tolerantly. GitLab has no such split: merge-request hooks
 * (`object_attributes.last_commit.id`), pipeline hooks
 * (`object_attributes.sha`), and the REST reads all report the **full
 * 40-character SHA**. Do not port Bitbucket's abbreviation helpers here —
 * truncating would invent a second spelling of a commit that GitLab itself only
 * ever spells one way.
 */

/**
 * GitLab pipeline status → the neutral conclusion vocabulary. An unrecognized
 * status rides through verbatim, same as an unmapped action: the value is
 * tracing-only (no trigger gates on it), so passing it through beats guessing.
 *
 * Only the four *terminal* statuses are mapped. GitLab's in-flight statuses
 * (`created`, `waiting_for_resource`, `preparing`, `pending`, `running`,
 * `manual`, `scheduled`) have no conclusion to report yet, so they ride through
 * as themselves rather than being flattened onto a fake one.
 */
const PIPELINE_CONCLUSIONS: Readonly<Record<string, string>> = {
	success: 'success',
	failed: 'failure',
	canceled: 'cancelled',
	skipped: 'skipped',
};

/** Pipeline statuses that mean CI is finished, not still progressing. */
const TERMINAL_PIPELINE_STATUSES: ReadonlySet<string> = new Set([
	'success',
	'failed',
	'canceled',
	'skipped',
]);

/** The neutral conclusion a GitLab pipeline status means; an unknown status passes through. */
export function pipelineConclusion(status: string): string {
	return PIPELINE_CONCLUSIONS[status] ?? status;
}

/**
 * Whether a pipeline status means CI is finished. An *unrecognized* status is
 * deliberately non-terminal: the aggregate decision then defers and re-reads
 * rather than judging a pipeline it doesn't understand
 * (`src/triggers/handlers/aggregate-check-decision.ts`). GitLab's own
 * intermediate cancellation state (`canceling`) falls out of that rule correctly
 * — it is not `canceled`, so it defers until the pipeline actually settles.
 */
export function isTerminalPipelineStatus(status: string): boolean {
	return TERMINAL_PIPELINE_STATUSES.has(status);
}
