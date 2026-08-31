/**
 * GitLab's merge-request and commit-status **reads** — the GitLab twin of
 * `../bitbucket/pull-requests.ts` (issue #295, phase 3/4). Every function here
 * mirrors a Bitbucket one so the three adapters' surfaces line up:
 * `getGitLabMergeRequest`, `getGitLabMergeRequestTitle`,
 * `getGitLabMergeRequestMergeState`, `getGitLabMergeRequestApprovals`,
 * `listOpenGitLabMergeRequestsForBase`, `getGitLabCommitStatuses`,
 * `listGitLabMergeRequestsForCommit`, `findOpenGitLabMergeRequest`.
 *
 * They live in their own file rather than in `./client.ts` because that module is
 * the credential/transport primitive (token scoping, auth header, error envelope,
 * pagination) and these are its endpoint-shaped callers.
 *
 * Conventions every read here follows:
 *
 * - **The token comes from the async context**, never an argument: each call must
 *   already run inside a `withGitLabToken` scope — in practice
 *   `GitLabSCMIntegration.withPersonaCredentials`, which is what makes the read
 *   authenticate as the persona the caller asked for.
 * - **A `GitLabApiError` propagates.** A 404/401 is never swallowed into an empty
 *   result: an absent merge request must not read as "no conflicts", and an
 *   unreadable commit must not read as "CI is green".
 * - **Every SHA is GitLab's full 40-character spelling** (`./pipelines.ts`), so a
 *   value read here and a value parsed off a webhook are the same string for the
 *   same commit — there is no abbreviation invariant to honour as Bitbucket has.
 *
 * Writes — notes, verdicts, merge-request creation, the direct merge — live next
 * door in `./writes.ts` (phase 4/4), which shares this module's
 * {@link GitLabMergeRequestReference} so a found and a created merge request are
 * the same shape to the delivery seam.
 */

import type {
	AggregateCheckStatus,
	CheckRunState,
	PullRequestDetails,
} from '../../../scm/types.js';
import { gitlabRequest, paginateGitLab, projectPath } from './client.js';
import { isTerminalPipelineStatus, pipelineConclusion } from './pipelines.js';

/** Name reported for a commit status GitLab exposes no `name` for. */
const UNNAMED_COMMIT_STATUS = '<unnamed commit status>';

/** Keep conflict-candidate refreshes below GitLab's request burst limits. */
const CONFLICT_CANDIDATE_READ_CONCURRENCY = 10;

/**
 * A merge request, typed to the fields these reads depend on.
 *
 * `diff_refs` is optional because GitLab populates it **asynchronously** after a
 * merge request is created, and because the *list* endpoint omits it entirely —
 * both cases {@link toPullRequestDetails} refuses rather than papers over.
 */
interface GitLabMergeRequest {
	iid?: number;
	title?: string;
	/** `opened` | `closed` | `locked` | `merged`. */
	state?: string;
	draft?: boolean;
	/** The head commit, full 40 characters. */
	sha?: string;
	source_branch?: string;
	target_branch?: string;
	/** Equal to `target_project_id` unless the merge request comes from a fork. */
	source_project_id?: number;
	target_project_id?: number;
	author?: { username?: string } | null;
	/** `can_be_merged` | `cannot_be_merged` | `checking` | `unchecked`. Deprecated by GitLab 15.6. */
	merge_status?: string;
	/** The successor to `merge_status`, which also reports *policy* blockers. */
	detailed_merge_status?: string;
	diff_refs?: { base_sha?: string } | null;
	web_url?: string;
}

/** One commit status — GitLab's equivalent of a GitHub check run. */
interface GitLabCommitStatus {
	/** The job/context name, which is what identifies a status across re-runs. */
	name?: string;
	/** The same vocabulary a pipeline reports (`./pipelines.ts`). */
	status?: string;
	created_at?: string | null;
	/** `null` until the job settles, which is why the dedupe falls back to `created_at`. */
	finished_at?: string | null;
	/** GitLab does not let this job affect the pipeline result. */
	allow_failure?: boolean;
}

/**
 * The approvals standing on a merge request. Each `approved_by` entry is
 * `{ user, approved_at }`, but only its *presence* is load-bearing: the verdict is
 * uniform (GitLab records approval, never a changes-requested state, here) and the
 * commit comes from the merge request itself, so nothing inside an entry is read.
 */
interface GitLabMergeRequestApprovals {
	approved_by?: unknown[];
}

/** A merge request's merge-relevant state — where the eligibility recheck starts. */
export interface GitLabMergeRequestMergeState {
	merged: boolean;
	/** `open` | `closed` — the neutral spelling GitHub's `pulls.get` reports. */
	state: string;
	draft: boolean;
	/** The exact head commit a merge attempt is allowed to merge. */
	headSha: string;
	/**
	 * Whether a reviewer's "request changes" verdict currently blocks the merge.
	 *
	 * Read from `detailed_merge_status`, not from {@link getGitLabMergeRequestApprovals}:
	 * GitLab records that verdict on `reviewers[].state` and the approvals entity does
	 * not carry it at all, so this single merge-request read is the only place one
	 * request exposes it. Without it a standing changes-requested verdict would only
	 * surface as the merge endpoint's own 405 — classified `not-ready`, which the merge
	 * dispatch would retry even though a reviewer decision cannot clear on its own.
	 */
	changesRequested: boolean;
}

/**
 * One standing approval, in GitHub's review-state spelling so phase 4's
 * merge-eligibility recheck reads identically for all three providers.
 */
export interface GitLabApprovalState {
	state: 'APPROVED';
	commitId: string;
}

/** A merge request as the delivery seam refers to one, where `number` is the `iid`. */
export interface GitLabMergeRequestReference {
	number: number;
	url: string;
}

/** A merge request a commit belongs to — enough to tie a branch pipeline back to it. */
export interface GitLabCommitMergeRequest {
	number: number;
	/** `opened` | `closed` | `locked` | `merged`, verbatim from GitLab. */
	state: string;
	headBranch: string;
}

function mergeRequestPath(repo: string, iid: number): string {
	return `${projectPath(repo)}/merge_requests/${iid}`;
}

function getMergeRequestObject(repo: string, iid: number): Promise<GitLabMergeRequest> {
	return gitlabRequest<GitLabMergeRequest>('GET', mergeRequestPath(repo, iid));
}

/**
 * `merge_status` → the contract's tri-state. This is the *git-only* signal — it
 * answers "would this merge cleanly?" and nothing else — which is exactly what
 * {@link PullRequestDetails.mergeable} means, so it is preferred over
 * `detailed_merge_status` even though GitLab deprecated it in 15.6.
 *
 * `undefined` means "not one of the documented values" (GitLab's internal state
 * machine also has `cannot_be_merged_recheck`), which defers to
 * {@link mergeableFromDetailedMergeStatus} — the same path that covers
 * `merge_status` finally disappearing in a future API version.
 */
function mergeableFromMergeStatus(status: string): boolean | null | undefined {
	switch (status) {
		case 'can_be_merged':
			return true;
		case 'cannot_be_merged':
			return false;
		case 'checking':
		case 'unchecked':
			return null;
		default:
			return undefined;
	}
}

/**
 * `detailed_merge_status` → the contract's tri-state. It reports the *first*
 * thing standing between the merge request and a merge, policy included, so it
 * needs collapsing onto the narrower question the contract asks.
 *
 * Anything that is not a conflict and not an in-flight computation reports
 * `true`, because `mergeable` means "no merge conflict", not "policy satisfied":
 * `not_approved`, `ci_still_running`, `discussions_not_resolved`, `draft_status`,
 * `need_rebase`, `requested_changes`, and the rest are blockers a human or a
 * later pipeline phase clears, and answering `false` for them would send the
 * conflict-resolution trigger to rewrite a branch that has no conflict.
 */
function mergeableFromDetailedMergeStatus(status: string): boolean | null {
	switch (status) {
		case 'mergeable':
			return true;
		// `commits_status` (the source branch is gone or carries no commits) is what
		// GitLab renamed `broken_status` to; both spellings are accepted so the table
		// doesn't depend on the instance's version.
		case 'conflict':
		case 'broken_status':
		case 'commits_status':
			return false;
		case 'checking':
		case 'preparing':
		case 'unchecked':
			return null;
		default:
			return true;
	}
}

/**
 * GitLab's real mergeability tri-state — the field Bitbucket cannot report at all.
 * `null` means GitLab has not finished computing it, which
 * `src/triggers/handlers/resolve-conflicts.ts` answers with a bounded recheck; the
 * recheck converges because reading a *single* merge request is itself what asks
 * GitLab to recompute mergeability.
 */
function toMergeable(mr: GitLabMergeRequest): boolean | null {
	const fromMergeStatus =
		mr.merge_status === undefined ? undefined : mergeableFromMergeStatus(mr.merge_status);
	if (fromMergeStatus !== undefined) return fromMergeStatus;
	if (mr.detailed_merge_status === undefined) return null;
	return mergeableFromDetailedMergeStatus(mr.detailed_merge_status);
}

/**
 * Map GitLab's merge request onto the neutral {@link PullRequestDetails}.
 *
 * `number` is the `iid` — GitLab's per-project internal id, which is what the
 * contract's generic `prNumber` means for this provider and what every merge-request
 * path below is addressed by.
 *
 * `baseSha` is `diff_refs.base_sha`, the **merge base** of (head, target) rather
 * than the target branch tip GitHub's `base.sha` reports. That is the value the
 * conflict-resolution claim key wants (`buildConflictResolutionKey`,
 * `src/triggers/resolve-conflicts-dedup.ts`): being stable per (head, base) pair, it
 * keys one claim per genuine conflict state instead of a fresh one per unrelated
 * push to the target branch.
 *
 * Throws when a load-bearing field is absent rather than substituting a stand-in:
 * `headSha`/`baseSha` become part of that exact-match claim key, so a stand-in would
 * key a conflict claim on the wrong commit instead of failing. A merge request whose
 * `diff_refs` GitLab has not populated yet — it lands asynchronously after creation —
 * is one of the cases that throws. `state` refuses for its own reason: neither
 * default is safe, since `closed` would silently skip a legitimate review and `open`
 * would resume the recheck loop issue #772 removed.
 */
function toPullRequestDetails(mr: GitLabMergeRequest): PullRequestDetails {
	const number = mr.iid;
	const headBranch = mr.source_branch;
	const headSha = mr.sha;
	const baseBranch = mr.target_branch;
	const baseSha = mr.diff_refs?.base_sha;
	if (number === undefined || !headBranch || !headSha || !baseBranch || !baseSha || !mr.state) {
		throw new Error(
			`GitLab merge-request response is missing required fields (iid=${number}, state=${mr.state}, source=${headBranch}@${headSha}, target=${baseBranch}@${baseSha})`,
		);
	}
	return {
		number,
		headBranch,
		headSha,
		baseBranch,
		baseSha,
		mergeable: toMergeable(mr),
		authorLogin: mr.author?.username ?? null,
		// `opened` | `closed` | `locked` | `merged` collapsed onto the contract's
		// neutral pair, the same mapping `getGitLabMergeRequestMergeState` applies.
		state: mr.state === 'opened' ? ('open' as const) : ('closed' as const),
	};
}

/** {@link PullRequestDetails} for one merge request. */
export async function getGitLabMergeRequest(
	repo: string,
	iid: number,
): Promise<PullRequestDetails> {
	return toPullRequestDetails(await getMergeRequestObject(repo, iid));
}

/**
 * A merge request's title, or `null` when GitLab reports none — same contract as
 * GitHub's and Bitbucket's, for the same caller (the worker's run-history row, which
 * treats the title as best-effort).
 */
export async function getGitLabMergeRequestTitle(
	repo: string,
	iid: number,
): Promise<string | null> {
	const mr = await getMergeRequestObject(repo, iid);
	return mr.title ?? null;
}

/**
 * A merge request's merge-relevant state. GitLab has one `state` field where GitHub
 * has `state` + `merged`, so both are derived from it: `merged` is the only state
 * that merged, and everything but `opened` — `merged`, `closed`, `locked` — is
 * closed.
 */
export async function getGitLabMergeRequestMergeState(
	repo: string,
	iid: number,
): Promise<GitLabMergeRequestMergeState> {
	const mr = await getMergeRequestObject(repo, iid);
	if (!mr.sha) {
		throw new Error(`GitLab merge request ${repo}!${iid} response carries no sha`);
	}
	return {
		merged: mr.state === 'merged',
		state: mr.state === 'opened' ? 'open' : 'closed',
		draft: Boolean(mr.draft),
		headSha: mr.sha,
		changesRequested: mr.detailed_merge_status === 'requested_changes',
	};
}

/**
 * Map a merge-request response onto the delivery seam's `{ number, url }`.
 *
 * A missing `iid` throws — every merge-request path is addressed by it, so a
 * delivery that could not name its own merge request has nothing to resume. A
 * missing `web_url` is derived instead: the URL is only ever shown to a human (a
 * merge-request comment, a run-history row), so deriving beats failing the
 * delivery over it. Same split as `toBitbucketPullRequestReference`, and the
 * derivation is safe for the same reason the client's base URL is a constant —
 * this adapter is GitLab.com-only.
 */
export function toGitLabMergeRequestReference(
	repo: string,
	mr: { iid?: number; web_url?: string },
): GitLabMergeRequestReference {
	if (mr.iid === undefined) {
		throw new Error(
			`GitLab merge-request response for ${repo} carries no iid, so it cannot be referenced`,
		);
	}
	return {
		number: mr.iid,
		url: mr.web_url ?? gitLabMergeRequestUrl(repo, mr.iid),
	};
}

/**
 * GitLab's canonical **web** URL for one merge request — the grammar behind both
 * the derivation above and {@link GitLabSCMIntegration.pullRequestUrl}, so the
 * two cannot drift into different spellings of the same path. Safe to derive for
 * the same reason the client's base URL is a constant: this adapter is
 * GitLab.com-only.
 */
export function gitLabMergeRequestUrl(repo: string, iid: number | string): string {
	return `https://gitlab.com/${repo}/-/merge_requests/${iid}`;
}

/**
 * The open merge request whose **source** branch is `branch`, or `undefined` when
 * none is open — the delivery seam's "has this branch already got a merge request?"
 * lookup, which is what makes a resumed delivery reuse its own merge request
 * instead of opening a second one.
 *
 * Filtered server-side, and unlike Bitbucket there is no query language to go
 * through: GitLab exposes the same `source_branch=` filter GitHub's `head=` gives.
 * When more than one open merge request shares a source branch (GitLab permits it,
 * one per target branch), the first is taken — matching GitHub's and Bitbucket's
 * find. One page suffices for that, so this is a plain request rather than a
 * paginated walk.
 */
export async function findOpenGitLabMergeRequest(
	repo: string,
	branch: string,
): Promise<GitLabMergeRequestReference | undefined> {
	const query = new URLSearchParams({ state: 'opened', source_branch: branch });
	const listed = await gitlabRequest<GitLabMergeRequest[] | undefined>(
		'GET',
		`${projectPath(repo)}/merge_requests?${query}`,
	);
	const mr = listed?.[0];
	return mr ? toGitLabMergeRequestReference(repo, mr) : undefined;
}

/**
 * The approvals standing on a merge request — GitLab's answer to GitHub's
 * `listReviews`. An empty array means nobody has approved.
 *
 * Approvals themselves are available on Free; only approval **rules** (who must
 * approve, how many) are Premium, and nothing here reads a rule.
 *
 * Only approvals: GitLab records a changes-requested verdict on
 * `reviewers[].state`, not on this endpoint (which is why `./webhook.ts` derives
 * that verdict from the acting reviewer's own state), so this read reports the one
 * verdict the endpoint actually carries rather than implying it saw both.
 *
 * **`commitId` is an approximation.** GitLab pins an approval to no commit — and the
 * approvals entity carries no SHA at all, hence the second read — so every returned
 * verdict carries the merge request's *current* head. That is only exactly right when
 * the project enables "remove all approvals when commits are added to the source
 * branch"; without it, a stale approval reads as covering the current head. Exactly
 * the trade-off Bitbucket's participant read documents: GitLab leans on the project
 * setting for the head-change protection GitHub gets from a review's own `commit_id`.
 */
export async function getGitLabMergeRequestApprovals(
	repo: string,
	iid: number,
): Promise<GitLabApprovalState[]> {
	const [approvals, mr] = await Promise.all([
		gitlabRequest<GitLabMergeRequestApprovals>('GET', `${mergeRequestPath(repo, iid)}/approvals`),
		getMergeRequestObject(repo, iid),
	]);
	const commitId = mr.sha ?? '';
	return (approvals.approved_by ?? []).map(() => ({ state: 'APPROVED' as const, commitId }));
}

/** Whether a merge request's source branch lives in the project it targets — i.e. it isn't from a fork. */
function isSameProjectMergeRequest(mr: GitLabMergeRequest): boolean {
	return (
		mr.source_project_id !== undefined &&
		mr.target_project_id !== undefined &&
		mr.source_project_id === mr.target_project_id
	);
}

/**
 * Same-project open merge requests targeting `targetBranch` — the conflict-detection
 * seam after a base advances. Filtering happens server-side (`state=opened`,
 * `target_branch=`), then forks are dropped the way GitHub's and Bitbucket's
 * equivalents do: a fork's source branch doesn't exist in this project, so SWARM
 * cannot push a conflict resolution to it.
 *
 * Each surviving candidate is then read **individually**, which is the one place this
 * adapter costs a request per candidate. Both fields the conflict trigger decides on
 * force it: the list endpoint omits `diff_refs` entirely (so there would be no merge
 * base to key a claim on), and it reports whatever `merge_status` was last cached
 * rather than a fresh one — GitLab recomputes mergeability *when a single merge
 * request is read*. `with_merge_status_recheck=true` asks the list endpoint to refresh
 * its half too, but cannot supply the omitted merge base. Mapping list entries directly
 * would therefore produce candidates with no `baseSha`; the extra read is what makes
 * both fields trustworthy, and what makes the trigger's bounded recheck converge
 * instead of re-reading the same cached answer 20 times.
 *
 * A candidate GitLab has not finished preparing (no `diff_refs` yet) fails the whole
 * listing rather than being quietly dropped — same all-or-nothing as the other two
 * adapters. A merge request with no merge base cannot be keyed, let alone judged, and
 * the caller re-lists on its next sweep.
 */
export async function listOpenGitLabMergeRequestsForBase(
	repo: string,
	targetBranch: string,
): Promise<PullRequestDetails[]> {
	const query = new URLSearchParams({
		state: 'opened',
		target_branch: targetBranch,
		with_merge_status_recheck: 'true',
	});
	const listed = await paginateGitLab<GitLabMergeRequest>(
		`${projectPath(repo)}/merge_requests?${query}`,
	);
	const sameProject = listed.filter(isSameProjectMergeRequest);
	const candidates: PullRequestDetails[] = [];
	for (let index = 0; index < sameProject.length; index += CONFLICT_CANDIDATE_READ_CONCURRENCY) {
		const batch = sameProject.slice(index, index + CONFLICT_CANDIDATE_READ_CONCURRENCY);
		candidates.push(
			...(await Promise.all(
				batch.map(async (mr) => {
					if (mr.iid === undefined) {
						throw new Error(`GitLab merge-request list entry for ${repo} carries no iid`);
					}
					return getGitLabMergeRequest(repo, mr.iid);
				}),
			)),
		);
	}
	return candidates;
}

/** When a commit status last changed, for picking the newest of a re-run pair. */
function statusChangedAt(status: GitLabCommitStatus): number {
	const parsed = Date.parse(status.finished_at ?? status.created_at ?? '');
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * One commit status as the neutral {@link CheckRunState}. GitLab reports a single
 * `status` where GitHub splits `status` from `conclusion`, so a still-running or
 * unrecognized status becomes `in_progress` with no conclusion — which is what makes
 * the aggregate decision defer instead of judging an unfinished pipeline — and a
 * terminal one becomes `completed` with the mapped conclusion. The vocabulary comes
 * from `./pipelines.ts`, shared with webhook ingress so an event and this read can't
 * spell one pipeline two ways.
 */
function toCheckRunState(status: GitLabCommitStatus): CheckRunState {
	const name = status.name ?? UNNAMED_COMMIT_STATUS;
	// GitLab's own pipeline result ignores advisory jobs, including manual ones.
	// Represent them as skipped so an all-advisory pipeline is immediately reviewable.
	if (status.allow_failure) return { name, status: 'completed', conclusion: 'skipped' };
	if (status.status === undefined || !isTerminalPipelineStatus(status.status)) {
		return { name, status: 'in_progress', conclusion: null };
	}
	return { name, status: 'completed', conclusion: pipelineConclusion(status.status) };
}

/**
 * Aggregate every commit status on `sha`, so a caller decides whether CI is finished
 * from the whole picture rather than trusting the one pipeline event that woke it.
 *
 * Deduped by `name`, keeping the most recently finished (or created) entry, for the
 * same reason Bitbucket dedupes by status `key` and GitHub by `workflow_id`: a re-run
 * reports under the same name, and letting its stale failure into the aggregate would
 * make a green commit look failed. An unnamed status can't be identified, so it is
 * counted on its own rather than collapsed with its neighbours. A status GitLab marks
 * `allow_failure` is retained as a completed, skipped run, so it cannot fail or defer
 * the aggregate while an all-advisory pipeline remains reviewable.
 */
export async function getGitLabCommitStatuses(
	repo: string,
	sha: string,
): Promise<AggregateCheckStatus> {
	const statuses = await paginateGitLab<GitLabCommitStatus>(
		`${projectPath(repo)}/repository/commits/${encodeURIComponent(sha)}/statuses`,
	);

	const latestByName = new Map<string, GitLabCommitStatus>();
	for (const [index, status] of statuses.entries()) {
		const name = status.name ?? `#${index}`;
		const existing = latestByName.get(name);
		if (!existing || statusChangedAt(status) >= statusChangedAt(existing)) {
			latestByName.set(name, status);
		}
	}

	const checkRuns = [...latestByName.values()].map(toCheckRunState);
	return { totalCount: checkRuns.length, checkRuns };
}

/**
 * The merge requests a commit belongs to. A GitLab **branch** pipeline event carries
 * no merge request at all (`./webhook.ts` leaves `workItemId` unset for it), so this
 * is how such a `checks` event is tied back to one — the same hole Bitbucket's commit
 * statuses have.
 */
export async function listGitLabMergeRequestsForCommit(
	repo: string,
	sha: string,
): Promise<GitLabCommitMergeRequest[]> {
	const mrs = await paginateGitLab<GitLabMergeRequest>(
		`${projectPath(repo)}/repository/commits/${encodeURIComponent(sha)}/merge_requests`,
	);
	return mrs.map((mr) => {
		if (mr.iid === undefined || !mr.state || !mr.source_branch) {
			throw new Error(
				`GitLab merge-request response for commit ${sha} is missing required fields (iid=${mr.iid}, state=${mr.state}, source_branch=${mr.source_branch})`,
			);
		}
		return { number: mr.iid, state: mr.state, headBranch: mr.source_branch };
	});
}
