/**
 * Bitbucket Cloud's pull-request and build-status **reads** — the Bitbucket twin
 * of the read half of `../github/client.ts` (issue #296, phase 3/4). Every
 * function here mirrors a GitHub one so the two adapters' surfaces line up:
 * `getPullRequest`, `getPullRequestTitle`, `getPullRequestMergeState`,
 * `getPullRequestReviews`, `listOpenPullRequestsForBase`, `getCheckSuiteStatus`.
 *
 * They live in their own file rather than in `./client.ts` because that module is
 * the credential/transport primitive (scoping, auth form, error envelope,
 * pagination) and these are the endpoint-shaped callers of it — GitHub keeps both
 * in one file only because Octokit supplies the transport half.
 *
 * Conventions every read here follows:
 *
 * - **Credentials come from the async context**, never an argument: each call
 *   must already run inside a `withBitbucketCredential` scope — in practice
 *   `BitbucketSCMIntegration.withPersonaCredentials`, which is what makes the
 *   read authenticate as the persona the caller asked for.
 * - **A `BitbucketApiError` propagates.** A 404/401 is never swallowed into an
 *   empty result: an absent PR must not read as "no conflicts" or "CI is green".
 * - **Every SHA is Bitbucket's abbreviated 12-character spelling** (`./commits.ts`),
 *   so a value read here and a value parsed off a webhook are the same string for
 *   the same commit.
 *
 * Writes — comments, approvals, review submission, PR creation, merge — live in
 * `./writes.ts` (phase 4/4), which reuses the mapping helpers here so a found pull
 * request and a just-created one are described identically.
 */

import type {
	AggregateCheckStatus,
	CheckRunState,
	PullRequestDetails,
} from '../../../scm/types.js';
import { bitbucketRequest, paginateBitbucket } from './client.js';
import {
	abbreviateBitbucketSha,
	buildStatusConclusion,
	isTerminalBuildStatusState,
} from './commits.js';

/** Bitbucket's page size cap for the collections read here. */
const PAGE_LENGTH = '50';

/** Name reported for a build status that exposes neither a `name` nor a `key`. */
const UNNAMED_BUILD_STATUS = '<unnamed build status>';

/**
 * One side of a pull request (`source` / `destination`). Typed with the fields
 * these reads depend on; `repository` is optional because Bitbucket omits it once
 * the source repository is deleted — the same hole GitHub's `head.repo?` has.
 */
interface BitbucketPullRequestRef {
	branch?: { name?: string };
	commit?: { hash?: string };
	repository?: { full_name?: string };
}

/**
 * A pull-request participant — Bitbucket's stand-in for a review. It records a
 * *current* verdict per user (`state`), not an event history, and pins it to no
 * commit; see {@link getBitbucketPullRequestApprovals}.
 */
interface BitbucketParticipant {
	/** `approved` | `changes_requested` | `null` while the participant hasn't voted. */
	state?: string | null;
}

interface BitbucketPullRequest {
	id?: number;
	title?: string;
	/** `OPEN` | `MERGED` | `DECLINED` | `SUPERSEDED`. */
	state?: string;
	draft?: boolean;
	author?: { nickname?: string };
	source?: BitbucketPullRequestRef;
	destination?: BitbucketPullRequestRef;
	participants?: BitbucketParticipant[];
	links?: { html?: { href?: string } };
}

/** One build status on a commit — Bitbucket's equivalent of a GitHub check run. */
interface BitbucketBuildStatus {
	/** Unique per build definition on the commit, which is what makes it the dedupe key. */
	key?: string;
	name?: string;
	/** `SUCCESSFUL` | `FAILED` | `INPROGRESS` | `STOPPED`. */
	state?: string;
	created_on?: string;
	updated_on?: string;
}

/** A PR's merge-relevant state — the lookup the merge-eligibility recheck starts from. */
export interface BitbucketPullRequestMergeState {
	merged: boolean;
	/** `open` | `closed` — the neutral spelling GitHub's `pulls.get` reports. */
	state: string;
	draft: boolean;
	/** The exact head commit a merge attempt is allowed to merge. */
	headSha: string;
}

/**
 * One participant's standing verdict, in GitHub's review-state spelling so the
 * merge-eligibility recheck reads identically for both providers.
 */
export interface BitbucketApprovalState {
	state: 'APPROVED' | 'CHANGES_REQUESTED';
	commitId: string;
}

/** A pull request as the delivery seam names one — `{ number, url }` (`src/scm/delivery.ts`). */
export interface BitbucketPullRequestReference {
	number: number;
	url: string;
}

/** A pull request a commit belongs to — enough to tie a build status back to its PR. */
export interface BitbucketCommitPullRequest {
	number: number;
	/** `OPEN` | `MERGED` | `DECLINED` | `SUPERSEDED`, verbatim from Bitbucket. */
	state: string;
	headBranch: string;
}

function repositoryPath(workspace: string, slug: string): string {
	return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
}

function pullRequestPath(workspace: string, slug: string, prNumber: number): string {
	return `${repositoryPath(workspace, slug)}/pullrequests/${prNumber}`;
}

function getPullRequestObject(
	workspace: string,
	slug: string,
	prNumber: number,
): Promise<BitbucketPullRequest> {
	return bitbucketRequest<BitbucketPullRequest>('GET', pullRequestPath(workspace, slug, prNumber));
}

/**
 * Map Bitbucket's pull-request object onto the neutral {@link PullRequestDetails}.
 *
 * Throws when a load-bearing field is absent rather than substituting an empty
 * string: `headSha`/`baseSha` become part of an exact-match claim key
 * (`buildConflictResolutionKey`, `src/triggers/resolve-conflicts-dedup.ts`), so a
 * stand-in would key a conflict claim on the wrong commit instead of failing.
 * `state` is treated the same way — and deliberately, since neither default is
 * safe: read as `closed` it would silently skip a legitimate review, read as
 * `open` it would resume the recheck loop issue #772 removed.
 * {@link listBitbucketPullRequestsForCommit} already refuses a missing `state`
 * for the same reason.
 */
function toPullRequestDetails(pr: BitbucketPullRequest): PullRequestDetails {
	const number = pr.id;
	const headBranch = pr.source?.branch?.name;
	const headSha = pr.source?.commit?.hash;
	const baseBranch = pr.destination?.branch?.name;
	const baseSha = pr.destination?.commit?.hash;
	if (number === undefined || !headBranch || !headSha || !baseBranch || !baseSha || !pr.state) {
		throw new Error(
			`Bitbucket pull-request response is missing required fields (id=${number}, state=${pr.state}, source=${headBranch}@${headSha}, destination=${baseBranch}@${baseSha})`,
		);
	}
	return {
		number,
		headBranch,
		headSha: abbreviateBitbucketSha(headSha),
		baseBranch,
		baseSha: abbreviateBitbucketSha(baseSha),
		// Always `null`: Bitbucket Cloud exposes no mergeability flag on a pull
		// request (there is no `mergeable` field to be pending or resolved), and
		// deriving one would mean a diff or a merge dry-run — a follow-up, not this
		// phase. `null` is the contract's "not known yet", which
		// `src/triggers/handlers/resolve-conflicts.ts` answers by scheduling a
		// bounded recheck (the `candidate.mergeable === null` branch), so a Bitbucket
		// conflict candidate exhausts its rechecks and is dropped rather than ever
		// being mislabelled as cleanly mergeable.
		mergeable: null,
		authorLogin: pr.author?.nickname ?? null,
		// `OPEN` | `MERGED` | `DECLINED` | `SUPERSEDED` collapsed onto the contract's
		// neutral pair, the same mapping `getBitbucketPullRequestMergeState` applies.
		state: pr.state === 'OPEN' ? ('open' as const) : ('closed' as const),
	};
}

/** {@link PullRequestDetails} for one pull request. */
export async function getBitbucketPullRequest(
	workspace: string,
	slug: string,
	prNumber: number,
): Promise<PullRequestDetails> {
	return toPullRequestDetails(await getPullRequestObject(workspace, slug, prNumber));
}

/**
 * A pull request's title, or `null` when Bitbucket reports none — same contract
 * as GitHub's `getPullRequestTitle`, for the same caller (the worker's run-history
 * row, which treats the title as best-effort).
 */
export async function getBitbucketPullRequestTitle(
	workspace: string,
	slug: string,
	prNumber: number,
): Promise<string | null> {
	const pr = await getPullRequestObject(workspace, slug, prNumber);
	return pr.title ?? null;
}

/**
 * A pull request's merge-relevant state. Bitbucket has one `state` field where
 * GitHub has `state` + `merged`, so both are derived from it: `MERGED` is the only
 * state that merged, and everything but `OPEN` — `MERGED`, `DECLINED`,
 * `SUPERSEDED` — is closed.
 */
export async function getBitbucketPullRequestMergeState(
	workspace: string,
	slug: string,
	prNumber: number,
): Promise<BitbucketPullRequestMergeState> {
	const pr = await getPullRequestObject(workspace, slug, prNumber);
	const headSha = pr.source?.commit?.hash;
	if (!headSha) {
		throw new Error(
			`Bitbucket pull request ${workspace}/${slug}#${prNumber} response carries no source.commit.hash`,
		);
	}
	return {
		merged: pr.state === 'MERGED',
		state: pr.state === 'OPEN' ? 'open' : 'closed',
		draft: Boolean(pr.draft),
		headSha: abbreviateBitbucketSha(headSha),
	};
}

/**
 * The standing approval / changes-requested verdicts on a pull request, read off
 * `participants[]` — Bitbucket's answer to GitHub's `listReviews`. Participants
 * who haven't voted (`state: null`) are omitted, so an empty array means nobody
 * has ruled.
 *
 * **`commitId` is an approximation.** Bitbucket pins a participant's verdict to no
 * commit, so every returned verdict carries the PR's *current* head SHA. That is
 * only exactly right when the repository enables "reset approvals on new commit";
 * without it, a stale approval reads as covering the current head. The
 * merge-eligibility recheck (`mergeReadyBitbucketPullRequest`,
 * `./scm-integration.ts`) compares this against the head it was asked to merge, so
 * the effect is that Bitbucket leans on the repository setting for head-change
 * protection where GitHub gets it from the review's own `commit_id`.
 */
export async function getBitbucketPullRequestApprovals(
	workspace: string,
	slug: string,
	prNumber: number,
): Promise<BitbucketApprovalState[]> {
	const pr = await getPullRequestObject(workspace, slug, prNumber);
	const commitId = abbreviateBitbucketSha(pr.source?.commit?.hash) ?? '';
	const verdicts: BitbucketApprovalState[] = [];
	for (const participant of pr.participants ?? []) {
		if (participant.state === 'approved') verdicts.push({ state: 'APPROVED', commitId });
		else if (participant.state === 'changes_requested')
			verdicts.push({ state: 'CHANGES_REQUESTED', commitId });
	}
	return verdicts;
}

/**
 * A Bitbucket query-language string literal. Branch names are caller data, and an
 * unescaped quote would end the literal early and change what the filter means.
 */
function queryLiteral(value: string): string {
	return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * `{ number, url }` for a pull-request object — the shape the delivery seam names a
 * pull request by, shared with the creation write (`./writes.ts`) so a found PR and
 * a just-created one are described identically.
 *
 * Bitbucket normally carries the web URL in `links.html.href`; when a response omits
 * it, the canonical web path is derived from the coordinates rather than left empty,
 * because the delivery checkpoint validates `pullRequestUrl` as a URL
 * (`DeliveryProgressSchema`, `src/scm/delivery.ts`) and would otherwise fail a
 * delivery over a cosmetic field. `id` is load-bearing, so its absence throws.
 */
export function toBitbucketPullRequestReference(
	workspace: string,
	slug: string,
	pr: { id?: number; links?: { html?: { href?: string } } },
): BitbucketPullRequestReference {
	if (pr.id === undefined) {
		throw new Error(
			`Bitbucket pull-request response for ${workspace}/${slug} carries no id, so it cannot be referenced`,
		);
	}
	return {
		number: pr.id,
		url: pr.links?.html?.href ?? bitbucketPullRequestUrl(`${workspace}/${slug}`, pr.id),
	};
}

/**
 * Bitbucket Cloud's canonical **web** URL for one pull request, from the
 * `workspace/slug` coordinates — the grammar behind both the derivation above and
 * {@link BitbucketSCMIntegration.pullRequestUrl}, so the two cannot drift into
 * different spellings of the same path.
 */
export function bitbucketPullRequestUrl(repo: string, id: number | string): string {
	return `https://bitbucket.org/${repo}/pull-requests/${id}`;
}

/**
 * The open pull request whose **source** branch is `branch`, or `undefined` when
 * none is open — the delivery seam's "has this branch already got a PR?" lookup,
 * which is what makes a resumed delivery reuse its own pull request instead of
 * opening a second one.
 *
 * Bitbucket has no `head=` filter like GitHub's, so the branch match goes through
 * the query language. When more than one open PR shares a source branch (Bitbucket
 * permits it — one per destination), the first is taken, matching GitHub's
 * `findOpenPullRequest`.
 */
export async function findOpenBitbucketPullRequest(
	workspace: string,
	slug: string,
	branch: string,
): Promise<BitbucketPullRequestReference | undefined> {
	const query = new URLSearchParams({
		q: `state=${queryLiteral('OPEN')} AND source.branch.name=${queryLiteral(branch)}`,
		pagelen: PAGE_LENGTH,
	});
	const page = await bitbucketRequest<{ values?: BitbucketPullRequest[] }>(
		'GET',
		`${repositoryPath(workspace, slug)}/pullrequests?${query}`,
	);
	const pull = page.values?.[0];
	return pull ? toBitbucketPullRequestReference(workspace, slug, pull) : undefined;
}

/**
 * Same-repository open pull requests targeting `baseBranch` — the conflict-detection
 * seam after a base advances. Filtering happens server-side through Bitbucket's
 * query language (`q=`), then forks are dropped the way GitHub's equivalent does:
 * a cross-repository PR's head branch doesn't exist in this repository, so SWARM
 * cannot push a conflict resolution to it.
 */
export async function listOpenBitbucketPullRequestsForBase(
	workspace: string,
	slug: string,
	baseBranch: string,
): Promise<PullRequestDetails[]> {
	const query = new URLSearchParams({
		q: `state=${queryLiteral('OPEN')} AND destination.branch.name=${queryLiteral(baseBranch)}`,
		pagelen: PAGE_LENGTH,
	});
	const pulls = await paginateBitbucket<BitbucketPullRequest>(
		`${repositoryPath(workspace, slug)}/pullrequests?${query}`,
	);
	return pulls.filter(isSameRepositoryPullRequest).map(toPullRequestDetails);
}

/** Whether a PR's head lives in the repository it targets — i.e. it isn't from a fork. */
function isSameRepositoryPullRequest(pr: BitbucketPullRequest): boolean {
	const head = pr.source?.repository?.full_name;
	const base = pr.destination?.repository?.full_name;
	return head !== undefined && base !== undefined && head === base;
}

/** When a build status last changed, for picking the newest of a re-run pair. */
function statusUpdatedAt(status: BitbucketBuildStatus): number {
	const parsed = Date.parse(status.updated_on ?? status.created_on ?? '');
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * One build status as the neutral {@link CheckRunState}. Bitbucket reports a
 * single `state` where GitHub splits `status` from `conclusion`, so a
 * still-running or unrecognized state becomes `in_progress` with no conclusion
 * (and defers the aggregate decision), and a terminal one becomes `completed`
 * with the mapped conclusion.
 */
function toCheckRunState(status: BitbucketBuildStatus): CheckRunState {
	const name = status.name ?? status.key ?? UNNAMED_BUILD_STATUS;
	const state = status.state;
	if (state === undefined || !isTerminalBuildStatusState(state)) {
		return { name, status: 'in_progress', conclusion: null };
	}
	return { name, status: 'completed', conclusion: buildStatusConclusion(state) };
}

/**
 * Aggregate every build status on `sha`, so a caller decides whether CI is
 * finished from the whole picture rather than trusting the one `commit_status`
 * webhook that woke it — Bitbucket fires one per build definition.
 *
 * Deduped by status `key`, keeping the most recently updated, for the same reason
 * GitHub's equivalent dedupes by `workflow_id`: a re-run reports under the same
 * key, and letting its stale failure into the aggregate would make a green commit
 * look failed. An unkeyed, unnamed status can't be identified, so it is counted on
 * its own rather than collapsed with its neighbours.
 */
export async function getBitbucketCommitBuildStatus(
	workspace: string,
	slug: string,
	sha: string,
): Promise<AggregateCheckStatus> {
	const statuses = await paginateBitbucket<BitbucketBuildStatus>(
		`${repositoryPath(workspace, slug)}/commit/${encodeURIComponent(sha)}/statuses?pagelen=${PAGE_LENGTH}`,
	);

	const latestByKey = new Map<string, BitbucketBuildStatus>();
	for (const [index, status] of statuses.entries()) {
		const key = status.key ?? status.name ?? `#${index}`;
		const existing = latestByKey.get(key);
		if (!existing || statusUpdatedAt(status) >= statusUpdatedAt(existing)) {
			latestByKey.set(key, status);
		}
	}

	const checkRuns = [...latestByKey.values()].map(toCheckRunState);
	return { totalCount: checkRuns.length, checkRuns };
}

/**
 * The pull requests a commit belongs to. Bitbucket's `commit_status` payload
 * carries no pull-request association at all (unlike GitHub's
 * `check_suite.pull_requests`), so this is how a build-status event is tied back
 * to its PR.
 *
 * Bitbucket serves this endpoint through its own Pull Request Commit Links app,
 * which Atlassian installs on first use — so an empty result can mean "not linked
 * yet" as well as "no PR", and a caller must not read it as proof the commit has
 * none.
 */
export async function listBitbucketPullRequestsForCommit(
	workspace: string,
	slug: string,
	sha: string,
): Promise<BitbucketCommitPullRequest[]> {
	const pulls = await paginateBitbucket<BitbucketPullRequest>(
		`${repositoryPath(workspace, slug)}/commit/${encodeURIComponent(sha)}/pullrequests?pagelen=${PAGE_LENGTH}`,
	);
	return pulls.map((pr) => {
		const headBranch = pr.source?.branch?.name;
		if (pr.id === undefined || !headBranch || !pr.state) {
			throw new Error(
				`Bitbucket pull-request response for commit ${sha} is missing required fields (id=${pr.id}, state=${pr.state}, source branch=${headBranch})`,
			);
		}
		return { number: pr.id, state: pr.state, headBranch };
	});
}
