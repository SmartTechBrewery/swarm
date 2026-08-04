/**
 * Bitbucket Cloud's commit vocabulary, shared by every half that has to agree on
 * it: webhook ingress (`./webhook.ts`, phase 2/4), the REST reads
 * (`./pull-requests.ts`, phase 3/4), and the writes plus the merge-eligibility
 * recheck (`./writes.ts` / `./scm-integration.ts`, phase 4/4). Both a normalized
 * event's `headSha` and an API read's `headSha` end up in the *same* exact-match
 * consumers — the review-dispatch dedup key
 * (`src/triggers/review-dispatch-dedup.ts`), the `reviewVerdicts.headSha` SQL
 * predicate, the conflict-resolution claim key — so a second spelling of either the
 * commit hash or a build state would silently split one commit into two.
 *
 * ## The abbreviated-hash invariant
 *
 * Bitbucket abbreviates a pull request's `source.commit.hash` to **12
 * characters** (Atlassian's own event-payload reference shows
 * `"hash": "d3022fc0ca3d"`), while a build status names its commit through
 * `links.commit.href`, whose last path segment is the full 40-character SHA. The
 * adapter therefore narrows *every* SHA it emits — from an event or from an API
 * read — to Bitbucket's 12-character spelling via
 * {@link abbreviateBitbucketSha}.
 */

/** Bitbucket Cloud's own abbreviated commit-hash length. */
export const BITBUCKET_SHA_LENGTH = 12;

/** Narrow a commit hash to Bitbucket's canonical 12-character spelling. */
export function abbreviateBitbucketSha(sha: string): string;
export function abbreviateBitbucketSha(sha: string | undefined): string | undefined;
export function abbreviateBitbucketSha(sha: string | undefined): string | undefined {
	return sha?.slice(0, BITBUCKET_SHA_LENGTH);
}

/**
 * Whether two Bitbucket commit spellings name the same commit — a prefix compare
 * over the shorter of the two, requiring at least {@link BITBUCKET_SHA_LENGTH}
 * characters to agree.
 *
 * Every SHA this adapter *emits* is already narrowed to 12 characters, but a value
 * a caller hands back need not be: the merge capability's `approvedHeadSha` comes
 * from whatever recorded the approval, and a 40-character spelling of the same
 * commit must not read as "the head moved". The length floor is what keeps that
 * tolerance from turning into a match on a truncated or empty value — a shorter
 * spelling fails closed, so the merge-eligibility recheck refuses rather than
 * merging on a hash it cannot pin down.
 */
export function sameBitbucketCommit(a: string, b: string): boolean {
	const shared = Math.min(a.length, b.length);
	if (shared < BITBUCKET_SHA_LENGTH) return false;
	return a.slice(0, shared) === b.slice(0, shared);
}

/**
 * Bitbucket build-status state → the neutral conclusion vocabulary the queue read
 * model reads (`src/queue/queued-runs.ts` keys on `failure`) and
 * `aggregate-check-decision.ts` classifies. An unrecognized state rides through
 * verbatim, same as an unmapped action.
 */
const BUILD_STATUS_CONCLUSIONS: Readonly<Record<string, string>> = {
	SUCCESSFUL: 'success',
	FAILED: 'failure',
	INPROGRESS: 'pending',
	STOPPED: 'cancelled',
};

/** Build-status states that mean CI is finished, not still progressing. */
const TERMINAL_BUILD_STATUS_STATES: ReadonlySet<string> = new Set([
	'SUCCESSFUL',
	'FAILED',
	'STOPPED',
]);

/** The neutral conclusion a Bitbucket build state means; an unknown state passes through. */
export function buildStatusConclusion(state: string): string {
	return BUILD_STATUS_CONCLUSIONS[state] ?? state;
}

/**
 * Whether a build state means CI is finished. An *unrecognized* state is
 * deliberately non-terminal: the aggregate decision then defers and re-reads
 * rather than judging a build it doesn't understand
 * (`src/triggers/handlers/aggregate-check-decision.ts`).
 */
export function isTerminalBuildStatusState(state: string): boolean {
	return TERMINAL_BUILD_STATUS_STATES.has(state);
}
