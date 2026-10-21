/**
 * Azure DevOps' pull-request **writes** — the comment-thread, review-vote,
 * pull-request creation, and completion half of the provider (issue #1089, phase
 * 5/6), the Azure DevOps twin of `../gitlab/writes.ts`. The reads they pair with
 * live in `./pull-requests.ts`; both sit outside `./client.ts` because that module
 * is the credential/transport primitive and these are its endpoint-shaped callers.
 *
 * Same conventions as the reads: the token comes from the async context (each call
 * must already run inside a `withAzureDevOpsToken` scope, in practice
 * `AzureDevOpsSCMIntegration.withPersonaCredentials`), and an `AzureDevOpsApiError`
 * propagates rather than being swallowed — the merge classifier
 * (`./scm-integration.ts`) is what turns a refusal into an outcome, and it needs the
 * status.
 *
 * ## A comment is a thread, and its comment id is the neutral id
 *
 * Azure DevOps has no free-standing pull-request comment: every comment lives in a
 * thread, and a top-level comment is a new thread holding one comment. The neutral
 * comment / review id this module returns is that **comment's** id — Azure
 * documents comment ids as unique within the pull request — not the id of the
 * thread around it.
 *
 * ## The delivery marker is the idempotency anchor
 *
 * Every write a delivery performs appends the shared per-delivery marker
 * ({@link deliveryMarker}, `src/scm/swarm-origin.ts`) to the content it posts, and
 * scans the pull request's threads for that marker before posting — the same retry
 * contract every provider honours. As on GitLab and Bitbucket, **Azure DevOps has
 * no review object**: a verdict is a reviewer *vote*, which returns nothing durable
 * to key on, so the marker-carrying findings thread *is* the review as far as
 * SWARM's idempotency is concerned ({@link submitAzureDevOpsReview}).
 */

import type { z } from 'zod';
import type { ReviewHandoffSchema } from '../../../scm/delivery.js';
import { deliveryMarker } from '../../../scm/swarm-origin.js';
import { azureDevOpsRequest, repositoryApiPath } from './client.js';
import {
	type AzureDevOpsPullRequestReference,
	toAzureDevOpsPullRequestReference,
} from './pull-requests.js';
import { azureDevOpsRequestChangesMarker } from './review-marker.js';

/** The verdicts the delivery seam can ask for — `src/scm/delivery.ts`'s own enum. */
type ReviewVerdict = z.infer<typeof ReviewHandoffSchema>['verdict'];

/** Prefix a branch ref carries in `sourceRefName` / `targetRefName`. */
const BRANCH_REF_PREFIX = 'refs/heads/';

/** `commentType` of a human-authored comment (Azure's `CommentType.text`). */
const TEXT_COMMENT_TYPE = 1;

/** How Azure lists the `commentType` of its own bookkeeping comments. */
const SYSTEM_COMMENT_TYPE = 'system';

/**
 * Azure DevOps refuses a pull-request description longer than this (a documented
 * limit of the create endpoint), and a refusal would fail the whole delivery over
 * prose — so the description is truncated instead (see {@link pullRequestDescription}).
 */
export const MAX_PULL_REQUEST_DESCRIPTION_CHARS = 4000;

/**
 * The reviewer votes SWARM casts. `approve` is "approved" (`10`); `request-changes`
 * is "waiting for author" (`-5`), **not** "rejected" (`-10`): a rejection blocks
 * completion until a human resets it, while waiting-for-author is the state that
 * matches GitHub's "changes requested" — the author pushes, and a fresh review
 * replaces the vote.
 */
export const AZURE_DEVOPS_REVIEW_VOTES = {
	approve: 10,
	'request-changes': -5,
} as const satisfies Record<ReviewVerdict, number>;

/** One pull-request thread, as Azure returns and lists it. */
interface AzureDevOpsThread {
	id?: number;
	comments?: AzureDevOpsThreadComment[] | null;
}

/** One comment of a {@link AzureDevOpsThread}. */
interface AzureDevOpsThreadComment {
	id?: number;
	content?: string;
	/**
	 * `text` | `system` | `codeChange` — Azure's own activity entries ("updated the
	 * pull request status", "voted") are comments too, and they quote what changed.
	 */
	commentType?: string;
}

function pullRequestPath(repo: string, pullRequestId: number): string {
	return `${repositoryApiPath(repo)}/pullrequests/${pullRequestId}`;
}

/**
 * Post a new top-level comment thread on a pull request, returning the id of the
 * comment it was created with.
 *
 * The content goes out verbatim — appending the SWARM attribution footer is the
 * caller's job, exactly as for the other providers' comment writes, because a body
 * assembled by a phase already carries one.
 */
export async function postAzureDevOpsPullRequestThread(
	repo: string,
	pullRequestId: number,
	content: string,
): Promise<number> {
	const thread = await azureDevOpsRequest<AzureDevOpsThread>(
		'POST',
		`${pullRequestPath(repo, pullRequestId)}/threads`,
		{
			comments: [{ parentCommentId: 0, content, commentType: TEXT_COMMENT_TYPE }],
			status: 'active',
		},
	);
	const commentId = thread.comments?.[0]?.id;
	if (commentId === undefined) {
		throw new Error(
			`Azure DevOps accepted a thread on ${repo}!${pullRequestId} but returned no comment id`,
		);
	}
	return commentId;
}

/**
 * The id of the comment on `pullRequestId` carrying `marker`, or `undefined` when
 * this delivery hasn't posted yet. The threads endpoint answers every thread of the
 * pull request in one response — it is not paged.
 *
 * **System comments are skipped.** Azure files its own bookkeeping comments into
 * threads too, and one that quotes a comment's text would otherwise let a retry
 * return an id it never created and leave the real body unposted.
 */
async function findMarkedComment(
	repo: string,
	pullRequestId: number,
	marker: string,
): Promise<number | undefined> {
	const listed = await azureDevOpsRequest<{ value?: AzureDevOpsThread[] } | undefined>(
		'GET',
		`${pullRequestPath(repo, pullRequestId)}/threads`,
	);
	return (listed?.value ?? [])
		.flatMap((thread) => thread.comments ?? [])
		.find(
			(comment) => comment.commentType !== SYSTEM_COMMENT_TYPE && comment.content?.includes(marker),
		)?.id;
}

/**
 * Post a marker-carrying thread on a pull request **once**: a retried delivery
 * finds the marker from its earlier attempt and returns that comment's id without
 * posting again. Azure DevOps twin of GitHub's `postIdempotentPullRequestComment`.
 */
export async function postIdempotentAzureDevOpsPullRequestThread(
	repo: string,
	input: { pullRequestId: number; body: string; deliveryId: string },
): Promise<number> {
	const marker = deliveryMarker(input.deliveryId);
	const existing = await findMarkedComment(repo, input.pullRequestId, marker);
	if (existing !== undefined) return existing;
	return postAzureDevOpsPullRequestThread(repo, input.pullRequestId, `${input.body}\n\n${marker}`);
}

/**
 * Submit a reviewer verdict on a pull request, returning the id of the comment that
 * carries its findings — the neutral review id, since Azure has no review object to
 * take one from (see this module's header).
 *
 * Idempotent on the marker: an earlier attempt's thread short-circuits the whole
 * operation, so a retried delivery neither double-posts the body nor re-votes.
 *
 * **The vote is cast as `reviewerId`** — the identity the scoped PAT authenticates
 * as, which is the only identity Azure lets a PAT vote for. `PUT …/reviewers/{id}`
 * adds the account as a reviewer if it is not one yet and sets its vote; repeating
 * it with the same vote is a no-op, so — unlike GitLab's `approve`, which refuses a
 * redundant approval — no status needs tolerating on a retry. The votes are
 * {@link AZURE_DEVOPS_REVIEW_VOTES}. A vote is not pinned to a commit; whether it
 * still covers the reviewed head is the merge recheck's question.
 *
 * **`request-changes` adds the provider-local request-changes marker**
 * (`./review-marker.ts`). A vote change reaches a service hook as a plain
 * `git.pullrequest.updated`, so ingress recognises the findings comment instead and
 * synthesizes the submitted `changes-requested` review that wakes Respond-to-review.
 *
 * **The vote is cast before the thread**, inverting the reading order. The thread
 * is the anchor a retry matches on, so it has to be the *last* write: a crash
 * between the two then leaves no marker, and the retry re-casts the (idempotent)
 * vote. Posting the thread first would strand the opposite case, where the marker
 * exists and the vote was never recorded, and no retry would ever fix it.
 */
export async function submitAzureDevOpsReview(
	repo: string,
	input: {
		pullRequestId: number;
		verdict: ReviewVerdict;
		body: string;
		deliveryId: string;
		/** The identity id the vote is cast as — the scoped PAT's own. */
		reviewerId: string;
	},
): Promise<number> {
	const marker = deliveryMarker(input.deliveryId);
	const existing = await findMarkedComment(repo, input.pullRequestId, marker);
	if (existing !== undefined) return existing;
	await azureDevOpsRequest<unknown>(
		'PUT',
		`${pullRequestPath(repo, input.pullRequestId)}/reviewers/${encodeURIComponent(input.reviewerId)}`,
		{ vote: AZURE_DEVOPS_REVIEW_VOTES[input.verdict] },
	);
	const requestChangesMarker =
		input.verdict === 'request-changes'
			? `\n${azureDevOpsRequestChangesMarker(input.deliveryId)}`
			: '';
	return postAzureDevOpsPullRequestThread(
		repo,
		input.pullRequestId,
		`${input.body}\n\n${marker}${requestChangesMarker}`,
	);
}

/**
 * The description a pull request is opened with: the body verbatim, or — past
 * Azure's {@link MAX_PULL_REQUEST_DESCRIPTION_CHARS} — cut short with a visible
 * note, so an over-long summary costs the tail of the prose rather than the
 * delivery.
 */
function pullRequestDescription(body: string): string {
	if (body.length <= MAX_PULL_REQUEST_DESCRIPTION_CHARS) return body;
	const note = '\n\n_…truncated to fit Azure DevOps’ pull-request description limit._';
	return `${body.slice(0, MAX_PULL_REQUEST_DESCRIPTION_CHARS - note.length)}${note}`;
}

/** Open a pull request, returning the delivery seam's `{ number, url }`. */
export async function createAzureDevOpsPullRequest(
	repo: string,
	input: { baseBranch: string; branch: string; title: string; body: string },
): Promise<AzureDevOpsPullRequestReference> {
	const pr = await azureDevOpsRequest<{ pullRequestId?: number }>(
		'POST',
		`${repositoryApiPath(repo)}/pullrequests`,
		{
			sourceRefName: `${BRANCH_REF_PREFIX}${input.branch}`,
			targetRefName: `${BRANCH_REF_PREFIX}${input.baseBranch}`,
			title: input.title,
			description: pullRequestDescription(input.body),
		},
	);
	return toAzureDevOpsPullRequestReference(repo, pr);
}

/**
 * Ask Azure DevOps to complete (merge) an active pull request, pinned to
 * `approvedHeadSha` — the only merge `AzureDevOpsSCMIntegration.mergePullRequest`
 * performs (issue #292: no provider's own merge automation is requested, so
 * `autoCompleteSetBy` is never set).
 *
 * `lastMergeSourceCommit` is the expected head: Azure refuses the completion when
 * it no longer names the source branch's tip, which gives this adapter the
 * expected-head protection GitHub and GitLab have.
 *
 * What the request deliberately leaves alone:
 *
 * - **The merge strategy and commit message.** The repository's own defaults (and
 *   any merge-type branch policy) win, the same choice the other adapters make.
 * - **`deleteSourceBranch: false`.** The branch is SWARM's own delivery branch and
 *   the worktree lifecycle owns its cleanup.
 * - **`bypassPolicy: false`.** A branch policy is the repository owner's gate; SWARM
 *   never asks to step around it.
 *
 * **Completion is asynchronous**: Azure accepts the request and merges in the
 * background, so the response is not the outcome — the caller polls the pull
 * request for it. Any non-2xx throws an `AzureDevOpsApiError`; classifying it is the
 * adapter's job.
 */
export async function completeAzureDevOpsPullRequest(
	repo: string,
	pullRequestId: number,
	approvedHeadSha: string,
): Promise<void> {
	await azureDevOpsRequest<unknown>('PATCH', pullRequestPath(repo, pullRequestId), {
		status: 'completed',
		lastMergeSourceCommit: { commitId: approvedHeadSha },
		completionOptions: { deleteSourceBranch: false, bypassPolicy: false },
	});
}
