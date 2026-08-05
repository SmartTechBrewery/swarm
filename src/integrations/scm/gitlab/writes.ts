/**
 * GitLab's merge-request **writes** — the note, review-verdict, merge-request
 * creation, and direct-merge half of `../github/client.ts` (issue #295, phase
 * 4/4). The reads they pair with live in `./merge-requests.ts`; both sit outside
 * `./client.ts` because that module is the credential/transport primitive and
 * these are the endpoint-shaped callers of it.
 *
 * Same conventions as the reads: the token comes from the async context (each call
 * must already run inside a `withGitLabToken` scope, in practice
 * `GitLabSCMIntegration.withPersonaCredentials`), and a `GitLabApiError`
 * propagates rather than being swallowed — the merge classifier
 * (`./scm-integration.ts`) is what turns a refusal into an outcome, and it needs
 * the status.
 *
 * ## The delivery marker is the idempotency anchor
 *
 * Every write a delivery performs appends the shared per-delivery marker
 * ({@link deliveryMarker}, `src/scm/swarm-origin.ts`) to the body it posts, and
 * scans for that marker before posting. The marker is the retry contract, not a
 * per-provider detail: a resumed delivery recognises its own earlier note and
 * returns that note's id instead of posting a duplicate.
 *
 * That matters more here than on GitHub, because — exactly as on Bitbucket —
 * **GitLab has no review object**. GitHub's `pulls.createReview` submits body +
 * verdict atomically and hands back a review id; GitLab splits them into a note
 * and a separate `approve` / `unapprove` call, neither of which returns anything
 * durable to key on. So the marker-carrying note *is* the review as far as SWARM's
 * idempotency is concerned, and its id is the neutral review id
 * ({@link submitGitLabReview}).
 */

import type { z } from 'zod';
import type { ReviewHandoffSchema } from '../../../scm/delivery.js';
import { deliveryMarker } from '../../../scm/swarm-origin.js';
import { GitLabApiError, gitlabRequest, paginateGitLab, projectPath } from './client.js';
import {
	type GitLabMergeRequestReference,
	toGitLabMergeRequestReference,
} from './merge-requests.js';

/** The verdicts the delivery seam can ask for — `src/scm/delivery.ts`'s own enum. */
type ReviewVerdict = z.infer<typeof ReviewHandoffSchema>['verdict'];

/** One merge-request note, as GitLab returns and lists it. */
interface GitLabNote {
	id?: number;
	body?: string;
	/**
	 * GitLab's own activity entries ("changed the description", "approved this
	 * merge request") are notes too, and the listing mixes them in with human
	 * comments.
	 */
	system?: boolean;
}

function mergeRequestPath(repo: string, iid: number): string {
	return `${projectPath(repo)}/merge_requests/${iid}`;
}

/**
 * Post a note on a merge request, returning the new note's id.
 *
 * The body goes out verbatim — appending the SWARM attribution footer is the
 * caller's job, exactly as it is for GitHub's `postIssueComment`, because a body
 * assembled by a phase already carries one.
 */
export async function postGitLabMergeRequestNote(
	repo: string,
	iid: number,
	body: string,
): Promise<number> {
	const note = await gitlabRequest<GitLabNote>('POST', `${mergeRequestPath(repo, iid)}/notes`, {
		body,
	});
	if (note.id === undefined) {
		throw new Error(`GitLab accepted a note on ${repo}!${iid} but returned no note id`);
	}
	return note.id;
}

/**
 * The id of the note on `iid` carrying `marker`, or `undefined` when this delivery
 * hasn't posted yet.
 *
 * **System notes are skipped.** GitLab files its own bookkeeping entries into the
 * same listing, and one of them quotes the note it describes — so treating a
 * system note as this delivery's own write would let a retry return an id it never
 * created and leave the real body unposted.
 */
async function findMarkedNote(
	repo: string,
	iid: number,
	marker: string,
): Promise<number | undefined> {
	const notes = await paginateGitLab<GitLabNote>(`${mergeRequestPath(repo, iid)}/notes`);
	return notes.find((note) => !note.system && note.body?.includes(marker))?.id;
}

/**
 * Post a marker-carrying note on a merge request **once**: a retried delivery
 * finds the marker from its earlier attempt and returns that note's id without
 * posting again. GitLab twin of GitHub's `postIdempotentPullRequestComment`.
 */
export async function postIdempotentGitLabMergeRequestNote(
	repo: string,
	input: { iid: number; body: string; deliveryId: string },
): Promise<number> {
	const marker = deliveryMarker(input.deliveryId);
	const existing = await findMarkedNote(repo, input.iid, marker);
	if (existing !== undefined) return existing;
	return postGitLabMergeRequestNote(repo, input.iid, `${input.body}\n\n${marker}`);
}

/**
 * Apply one verdict endpoint, tolerating the status GitLab uses to refuse a
 * **no-op** so the retry story above actually holds.
 *
 * GitLab does not absorb a redundant verdict the way Bitbucket's participant
 * endpoints do: `approve` answers 401 for an account that is not an eligible
 * approver *including because it has already approved*, and `unapprove` answers
 * 404 when there is no approval of its own to withdraw. Both are exactly the state
 * a retry re-enters after the verdict landed and the note POST did not — the
 * window {@link submitGitLabReview}'s ordering deliberately leaves open — so
 * rethrowing would strand every such retry with the reviewer's findings unposted.
 *
 * Neither tolerated status can mean an unknown project or a dead credential: the
 * marker scan has already read this merge request with this token one request
 * earlier. What a tolerated 401 *can* also mean is a token that may never approve
 * (a project forbidding self-approval, say). Proceeding is still right: the note
 * carrying the review is posted, and whether an approval actually stands is the
 * merge-eligibility recheck's question — it reads the approvals and refuses the
 * merge when none covers the reviewed head, which surfaces the misconfiguration as
 * a merge refusal instead of a Review run that fails forever.
 */
async function applyVerdict(
	repo: string,
	iid: number,
	endpoint: 'approve' | 'unapprove',
	body?: unknown,
): Promise<void> {
	const redundantStatus = endpoint === 'approve' ? 401 : 404;
	try {
		await gitlabRequest<unknown>('POST', `${mergeRequestPath(repo, iid)}/${endpoint}`, body);
	} catch (error) {
		if (error instanceof GitLabApiError && error.status === redundantStatus) return;
		throw error;
	}
}

/**
 * Submit a reviewer verdict on a merge request, returning the id of the note that
 * carries its body — the neutral review id, since GitLab has no review object to
 * take one from (see this module's header).
 *
 * Idempotent on the marker: an earlier attempt's note short-circuits the whole
 * operation, so a retried delivery neither double-posts the body nor re-votes.
 *
 * **`approve` is pinned to `headSha`.** GitLab's approve endpoint takes a `sha`
 * that must match the merge request's head and answers 409 otherwise, so an
 * approval can never silently land on a commit other than the one the caller named
 * — the expected-head protection GitHub has at merge time and Bitbucket lacks
 * entirely.
 *
 * **`request-changes` clears the standing approval and lets the note carry the
 * verdict.** GitLab's reviewer "request changes" state is a UI/GraphQL concept with
 * no REST endpoint on either the merge-requests or the merge-request-approvals API
 * (verified against GitLab 19.1's REST reference), so there is nothing native to
 * prefer. `unapprove` is what SWARM can do: it removes this reviewer's own
 * approval, and the verdict then lives in the *absence* of an approval plus the
 * findings in the note. The limitation is real and worth naming — GitLab's own
 * `requested_changes` reviewer state, which blocks the merge on its own, is not
 * set, so a human reading the merge request sees an unapproved merge request with a
 * findings note rather than a red "changes requested" badge.
 *
 * **The verdict is applied before the note**, inverting the reading order. The note
 * is the anchor a retry matches on, so it has to be the *last* write: a crash
 * between the two then leaves no marker, and the retry re-applies the verdict —
 * which {@link applyVerdict} makes harmless. Posting the note first would strand
 * the opposite case, where the marker exists and the verdict was never recorded,
 * and no retry would ever fix it.
 */
export async function submitGitLabReview(
	repo: string,
	input: {
		iid: number;
		verdict: ReviewVerdict;
		body: string;
		deliveryId: string;
		/** The head commit the verdict is cast against — see above. */
		headSha: string;
	},
): Promise<number> {
	const marker = deliveryMarker(input.deliveryId);
	const existing = await findMarkedNote(repo, input.iid, marker);
	if (existing !== undefined) return existing;
	if (input.verdict === 'approve') {
		await applyVerdict(repo, input.iid, 'approve', { sha: input.headSha });
	} else {
		await applyVerdict(repo, input.iid, 'unapprove');
	}
	return postGitLabMergeRequestNote(repo, input.iid, `${input.body}\n\n${marker}`);
}

/** Open a merge request, returning the delivery seam's `{ number, url }`. */
export async function createGitLabMergeRequest(
	repo: string,
	input: { baseBranch: string; branch: string; title: string; body: string },
): Promise<GitLabMergeRequestReference> {
	const mr = await gitlabRequest<{ iid?: number; web_url?: string }>(
		'POST',
		`${projectPath(repo)}/merge_requests`,
		{
			source_branch: input.branch,
			target_branch: input.baseBranch,
			title: input.title,
			description: input.body,
		},
	);
	return toGitLabMergeRequestReference(repo, mr);
}

/** Result of a direct merge attempt — GitHub's `DirectMergeResult` shape. */
export interface GitLabDirectMergeResult {
	merged: boolean;
	message: string;
	sha?: string;
}

/**
 * Merge an open merge request through GitLab's direct merge endpoint — the only
 * merge strategy `GitLabSCMIntegration.mergePullRequest` uses (issue #292: no
 * provider's own merge automation is ever requested, so `auto_merge` is never sent
 * and a merge either happens now or is refused now).
 *
 * `sha` pins the merge to `approvedHeadSha`: GitLab refuses with 409 when it no
 * longer matches the source branch's head, which gives this adapter the same
 * expected-head protection GitHub has and Bitbucket cannot get at all.
 *
 * Three deliberate omissions from the request body:
 *
 * - **No `squash` and no merge-method override.** The project's configured default
 *   wins, which is the same choice GitHub's and Bitbucket's adapters make; naming
 *   one would be rejected outright by a project restricted to the other.
 * - **No commit message.** Bitbucket's adapter passes one because Bitbucket's own
 *   default is thin; GitLab composes a merge commit message from the merge request
 *   itself, and a project configured to squash reads `squash_commit_message`
 *   instead of `merge_commit_message` — so naming one would produce a SWARM-written
 *   subject on some projects and GitLab's on others. Neither is named.
 * - **`should_remove_source_branch: false`.** The branch is SWARM's own delivery
 *   branch and the worktree lifecycle owns its cleanup; letting GitLab delete it
 *   server-side would pull the ref out from under a still-running phase.
 *
 * GitLab answers with the merge-request object, so `merged` is read off its state
 * rather than a dedicated flag — a 2xx that somehow did not merge reports
 * `merged: false` and becomes `not-ready`, never a silent success. Any non-2xx
 * throws a `GitLabApiError`; classifying it is the adapter's job.
 */
export async function mergeGitLabMergeRequestDirect(
	repo: string,
	iid: number,
	approvedHeadSha: string,
): Promise<GitLabDirectMergeResult> {
	const mr = await gitlabRequest<{
		state?: string;
		merge_commit_sha?: string | null;
		squash_commit_sha?: string | null;
	}>('PUT', `${mergeRequestPath(repo, iid)}/merge`, {
		sha: approvedHeadSha,
		should_remove_source_branch: false,
	});
	const merged = mr.state === 'merged';
	return {
		merged,
		message: merged
			? 'merge request merged'
			: `GitLab accepted the merge request but it is ${mr.state ?? 'in an unreported state'}`,
		// Whichever of the two the project's configured strategy produced; GitLab
		// reports full 40-character SHAs, so there is nothing to narrow.
		sha: mr.merge_commit_sha ?? mr.squash_commit_sha ?? undefined,
	};
}
