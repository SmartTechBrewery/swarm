/**
 * Bitbucket Cloud's pull-request **writes** — the comment, review-verdict, PR
 * creation, and direct-merge half of `../github/client.ts` (issue #296, phase
 * 4/4). The reads they pair with live in `./pull-requests.ts`; both sit outside
 * `./client.ts` because that module is the credential/transport primitive and
 * these are the endpoint-shaped callers of it.
 *
 * Same conventions as the reads: the credential comes from the async context (each
 * call must already run inside a `withBitbucketCredential` scope, in practice
 * `BitbucketSCMIntegration.withPersonaCredentials`), and a `BitbucketApiError`
 * propagates rather than being swallowed — the merge classifier
 * (`./scm-integration.ts`) is what turns a refusal into an outcome, and it needs
 * the status.
 *
 * ## The delivery marker is the idempotency anchor
 *
 * Every write a delivery performs appends the shared per-delivery marker
 * ({@link deliveryMarker}, `src/scm/swarm-origin.ts`) to the body it posts, and
 * scans for that marker before posting. The marker is the retry contract, not a
 * per-provider detail: a resumed delivery recognises its own earlier comment and
 * returns that comment's id instead of posting a duplicate.
 *
 * That matters more here than on GitHub, because **Bitbucket has no review
 * object**. GitHub's `pulls.createReview` submits body + verdict atomically and
 * hands back a review id; Bitbucket splits them into a comment and a separate
 * `approve` / `request-changes` call, neither of which returns anything durable to
 * key on. So the marker-carrying comment *is* the review as far as SWARM's
 * idempotency is concerned, and its id is the neutral review id
 * ({@link submitBitbucketReview}).
 */

import type { z } from 'zod';
import type { ReviewHandoffSchema } from '../../../scm/delivery.js';
import { deliveryMarker } from '../../../scm/swarm-origin.js';
import { bitbucketRequest, paginateBitbucket } from './client.js';
import { abbreviateBitbucketSha } from './commits.js';
import {
	type BitbucketPullRequestReference,
	toBitbucketPullRequestReference,
} from './pull-requests.js';

/** Bitbucket's page size cap for the comment scan. */
const PAGE_LENGTH = '50';

/** The verdicts the delivery seam can ask for — `src/scm/delivery.ts`'s own enum. */
type ReviewVerdict = z.infer<typeof ReviewHandoffSchema>['verdict'];

/**
 * The endpoint each verdict adds on top of the comment. Bitbucket models a verdict
 * as a *participant state* rather than a review event, so both are plain POSTs with
 * no body. There is no third `comment` verdict to map: SWARM stopped producing one
 * (issue #470), and on Bitbucket a comment-only review would be nothing but the
 * comment this function already posts.
 */
const VERDICT_ENDPOINT: Readonly<Record<ReviewVerdict, string>> = {
	approve: 'approve',
	'request-changes': 'request-changes',
};

/** One top-level pull-request comment, as Bitbucket returns and lists it. */
interface BitbucketComment {
	id?: number;
	content?: { raw?: string };
	/** Bitbucket keeps deleted comments in the listing, with their content stripped. */
	deleted?: boolean;
}

function repositoryPath(workspace: string, slug: string): string {
	return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
}

function pullRequestPath(workspace: string, slug: string, prNumber: number): string {
	return `${repositoryPath(workspace, slug)}/pullrequests/${prNumber}`;
}

/**
 * Post a top-level comment on a pull request, returning the new comment's id.
 *
 * The body goes out verbatim — appending the SWARM attribution footer is the
 * caller's job, exactly as it is for GitHub's `postIssueComment`, because a body
 * assembled by a phase already carries one.
 */
export async function postBitbucketPullRequestComment(
	workspace: string,
	slug: string,
	prNumber: number,
	body: string,
): Promise<number> {
	const comment = await bitbucketRequest<BitbucketComment>(
		'POST',
		`${pullRequestPath(workspace, slug, prNumber)}/comments`,
		{ content: { raw: body } },
	);
	if (comment.id === undefined) {
		throw new Error(
			`Bitbucket accepted a comment on ${workspace}/${slug}#${prNumber} but returned no comment id`,
		);
	}
	return comment.id;
}

/**
 * The id of the comment on `prNumber` carrying `marker`, or `undefined` when this
 * delivery hasn't posted yet. Deleted comments are skipped: Bitbucket keeps them in
 * the listing with their content stripped, and treating one as this delivery's own
 * write would leave the retry with nothing posted at all.
 */
async function findMarkedComment(
	workspace: string,
	slug: string,
	prNumber: number,
	marker: string,
): Promise<number | undefined> {
	const comments = await paginateBitbucket<BitbucketComment>(
		`${pullRequestPath(workspace, slug, prNumber)}/comments?pagelen=${PAGE_LENGTH}`,
	);
	return comments.find((comment) => !comment.deleted && comment.content?.raw?.includes(marker))?.id;
}

/**
 * Post a marker-carrying comment on a pull request **once**: a retried delivery
 * finds the marker from its earlier attempt and returns that comment's id without
 * posting again. Bitbucket twin of GitHub's `postIdempotentPullRequestComment`.
 */
export async function postIdempotentBitbucketPullRequestComment(
	workspace: string,
	slug: string,
	input: { prNumber: number; body: string; deliveryId: string },
): Promise<number> {
	const marker = deliveryMarker(input.deliveryId);
	const existing = await findMarkedComment(workspace, slug, input.prNumber, marker);
	if (existing !== undefined) return existing;
	return postBitbucketPullRequestComment(
		workspace,
		slug,
		input.prNumber,
		`${input.body}\n\n${marker}`,
	);
}

/**
 * Submit a reviewer verdict on a pull request, returning the id of the comment that
 * carries its body — the neutral review id, since Bitbucket has no review object to
 * take one from (see this module's header).
 *
 * Idempotent on the marker: an earlier attempt's comment short-circuits the whole
 * operation, so a retried delivery neither double-posts the body nor re-votes.
 *
 * **The verdict is applied before the comment**, inverting the reading order. The
 * comment is the anchor a retry matches on, so it has to be the *last* write: a
 * crash between the two then leaves no marker, and the retry re-applies the verdict
 * — which is harmless, because Bitbucket's approve / request-changes endpoints set a
 * standing participant state rather than appending an event. Posting the comment
 * first would strand the opposite case, where the marker exists and the verdict was
 * never recorded, and no retry would ever fix it.
 */
export async function submitBitbucketReview(
	workspace: string,
	slug: string,
	input: { prNumber: number; verdict: ReviewVerdict; body: string; deliveryId: string },
): Promise<number> {
	const marker = deliveryMarker(input.deliveryId);
	const existing = await findMarkedComment(workspace, slug, input.prNumber, marker);
	if (existing !== undefined) return existing;
	await bitbucketRequest<unknown>(
		'POST',
		`${pullRequestPath(workspace, slug, input.prNumber)}/${VERDICT_ENDPOINT[input.verdict]}`,
	);
	return postBitbucketPullRequestComment(
		workspace,
		slug,
		input.prNumber,
		`${input.body}\n\n${marker}`,
	);
}

/** Open a pull request, returning the delivery seam's `{ number, url }`. */
export async function createBitbucketPullRequest(
	workspace: string,
	slug: string,
	input: { baseBranch: string; branch: string; title: string; body: string },
): Promise<BitbucketPullRequestReference> {
	const pull = await bitbucketRequest<{ id?: number; links?: { html?: { href?: string } } }>(
		'POST',
		`${repositoryPath(workspace, slug)}/pullrequests`,
		{
			title: input.title,
			description: input.body,
			source: { branch: { name: input.branch } },
			destination: { branch: { name: input.baseBranch } },
		},
	);
	return toBitbucketPullRequestReference(workspace, slug, pull);
}

/** Result of a direct pull-request merge attempt — GitHub's `DirectMergeResult` shape. */
export interface BitbucketDirectMergeResult {
	merged: boolean;
	message: string;
	sha?: string;
}

/**
 * Merge an open pull request through Bitbucket's direct merge endpoint — the only
 * merge strategy `BitbucketSCMIntegration.mergePullRequest` uses (issue #292: no
 * provider's own merge automation is ever requested).
 *
 * Two deliberate omissions from the request body:
 *
 * - **No `merge_strategy`.** Bitbucket falls back to the repository's configured
 *   default, which is the same choice GitHub's adapter makes by not naming a merge
 *   method. Hard-coding `merge_commit` would be rejected outright by a repository
 *   restricted to squash merges.
 * - **`close_source_branch: false`.** The branch is SWARM's own delivery branch and
 *   the worktree lifecycle owns its cleanup; letting Bitbucket delete it server-side
 *   would pull the ref out from under a still-running phase.
 *
 * Bitbucket answers with the pull-request object, so `merged` is read off its state
 * rather than a dedicated flag — a 200 that somehow did not merge reports
 * `merged: false` and becomes `not-ready`, never a silent success. Any non-2xx
 * throws a `BitbucketApiError`; classifying it is the adapter's job.
 */
export async function mergeBitbucketPullRequestDirect(
	workspace: string,
	slug: string,
	prNumber: number,
	message: string,
): Promise<BitbucketDirectMergeResult> {
	const pull = await bitbucketRequest<{ state?: string; merge_commit?: { hash?: string } }>(
		'POST',
		`${pullRequestPath(workspace, slug, prNumber)}/merge`,
		{ message, close_source_branch: false },
	);
	const merged = pull.state === 'MERGED';
	return {
		merged,
		message: merged
			? 'pull request merged'
			: `Bitbucket accepted the merge request but the pull request is ${pull.state ?? 'in an unreported state'}`,
		// Narrowed like every other SHA this adapter emits (`./commits.ts`).
		sha: abbreviateBitbucketSha(pull.merge_commit?.hash),
	};
}
