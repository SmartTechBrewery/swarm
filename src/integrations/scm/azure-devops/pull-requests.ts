/**
 * Azure DevOps' pull-request and CI **reads** — the Azure DevOps twin of
 * `../gitlab/merge-requests.ts` (issue #1089, phase 4/6):
 * `getAzureDevOpsPullRequest`, `getAzureDevOpsPullRequestTitle`,
 * `getAzureDevOpsPullRequestMergeState`, `getAzureDevOpsBranchHead`,
 * `getAzureDevOpsCommitChecks`, `listAzureDevOpsPullRequestsForCommit`,
 * `listActiveAzureDevOpsPullRequestsForBase`, `findActiveAzureDevOpsPullRequest`.
 *
 * They live in their own file rather than in `./client.ts` because that module is
 * the credential/transport primitive (token scoping, auth header, error envelope,
 * pagination) and these are its endpoint-shaped callers.
 *
 * Conventions every read here follows:
 *
 * - **The token comes from the async context**, never an argument: each call must
 *   already run inside a `withAzureDevOpsToken` scope — in practice
 *   `AzureDevOpsSCMIntegration.withPersonaCredentials`.
 * - **An `AzureDevOpsApiError` propagates.** A 404/401 is never swallowed into an
 *   empty result: an absent pull request must not read as "no conflicts", and an
 *   unreadable commit must not read as "CI is green".
 * - **One narrow interface per response shape**, typed to the fields read here, and
 *   a mapper that throws on a missing load-bearing field rather than substituting a
 *   stand-in.
 *
 * Out of scope here: branch-policy evaluations (a policy is not CI — see
 * {@link getAzureDevOpsCommitChecks}). Every write — threads, votes, pull-request
 * creation, completion — lives next door in `./writes.ts` (phase 5/6), which shares
 * {@link AzureDevOpsPullRequestReference} so a found and a created pull request are
 * the same shape to the delivery seam.
 */

import { logger } from '../../../lib/logger.js';
import type {
	AggregateCheckStatus,
	CheckRunState,
	CommitPullRequest,
	PullRequestDetails,
} from '../../../scm/types.js';
import { buildCheckRun, commitStatusCheckRun } from './builds.js';
import {
	azureDevOpsRequest,
	azureRepoCoordinates,
	paginateAzureDevOps,
	repositoryApiPath,
} from './client.js';
import { pullRequestWebUrl } from './webhook.js';

/** Prefix a branch ref carries in `sourceRefName` / `targetRefName` / a ref listing. */
const BRANCH_REF_PREFIX = 'refs/heads/';

/** Keep conflict-candidate re-reads below Azure DevOps' request burst limits (GitLab's figure). */
const CONFLICT_CANDIDATE_READ_CONCURRENCY = 10;

/**
 * How many of a repository's most recently queued builds {@link getAzureDevOpsCommitChecks}
 * scans for the ones that ran on a commit. The builds API cannot filter by commit, so
 * this is the explicit bound on that scan; a full page is logged, since a build older
 * than the window is then invisible to the aggregate.
 */
export const BUILD_SCAN_LIMIT = 200;

/** The repository type every Azure Repos Git build names. */
const AZURE_REPOS_GIT = 'TfsGit';

/** A pull request, typed to the fields these reads depend on. */
interface AzureDevOpsPullRequest {
	pullRequestId?: number;
	title?: string;
	/** `active` | `completed` | `abandoned` (`notSet` on a malformed record). */
	status?: string;
	isDraft?: boolean;
	createdBy?: { id?: string } | null;
	sourceRefName?: string;
	targetRefName?: string;
	/**
	 * `notSet` | `queued` | `conflicts` | `succeeded` | `rejectedByPolicy` | `failure`
	 * — Azure's last merge evaluation, recomputed asynchronously after each push.
	 */
	mergeStatus?: string;
	/** The source commit Azure last evaluated the merge of — the pull request's head. */
	lastMergeSourceCommit?: { commitId?: string } | null;
	/** The target commit Azure last evaluated the merge against. */
	lastMergeTargetCommit?: { commitId?: string } | null;
	/** The commit a completed pull request landed as on the target branch. */
	lastMergeCommit?: { commitId?: string } | null;
	/** Present only when the source branch lives in a fork. */
	forkSource?: unknown;
	reviewers?: Array<{ id?: string; vote?: number; isRequired?: boolean }> | null;
}

/** A `{ count, value }` list response. */
interface AzureDevOpsList<T> {
	value?: T[];
}

/** One ref, as `GET …/refs` lists it. */
interface AzureDevOpsRef {
	name?: string;
	objectId?: string;
}

/** One Git commit status — what an external CI posts to Azure Repos. */
interface AzureDevOpsCommitStatus {
	/** `notSet` | `pending` | `succeeded` | `failed` | `error` | `notApplicable` | `partiallySucceeded`. */
	state?: string;
	/** `genre/name` identifies a status across re-posts. */
	context?: { name?: string; genre?: string } | null;
	creationDate?: string;
}

/** One Azure Pipelines build, typed to the fields the aggregate reads. */
interface AzureDevOpsBuild {
	id?: number;
	status?: string;
	result?: string;
	/** The commit built — Azure's merge commit for a pull-request build. */
	sourceVersion?: string;
	/** A pull-request build names the pull request's real head here. */
	triggerInfo?: Record<string, string | undefined> | null;
	definition?: { id?: number; name?: string } | null;
}

/** A pull request's merge-relevant state — where phase 5's eligibility recheck starts. */
export interface AzureDevOpsPullRequestMergeState {
	merged: boolean;
	/** `open` | `closed` — the neutral spelling GitHub's `pulls.get` reports. */
	state: 'open' | 'closed';
	draft: boolean;
	/** The exact head commit a merge attempt is allowed to merge. */
	headSha: string;
	/**
	 * Every reviewer's current vote, verbatim: `10` approved, `5` approved with
	 * suggestions, `0` no vote, `-5` waiting for author, `-10` rejected. Phase 5
	 * decides which of them block; this read only reports them.
	 */
	reviewers: Array<{ id: string; vote: number; isRequired: boolean }>;
	/** Azure's last merge evaluation, verbatim (`conflicts`, `succeeded`, …), or `null` when unreported. */
	mergeStatus: string | null;
	/** The commit a completed pull request landed as, or `null` while it has not. */
	mergeCommitSha: string | null;
}

/** A pull request as the delivery seam names it: its id and its web URL. */
export interface AzureDevOpsPullRequestReference {
	number: number;
	url: string;
}

/** Strip `refs/heads/` off a branch ref; any other ref passes through verbatim. */
function branchName(ref: string): string {
	return ref.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) : ref;
}

/**
 * A pull request `status` → the contract's neutral pair, or `undefined` for one
 * that is neither: neither default is safe (`closed` would silently skip a
 * legitimate review, `open` would resume the recheck loop issue #772 removed), so
 * every caller throws on it.
 */
function neutralState(status: string | undefined): 'open' | 'closed' | undefined {
	switch (status) {
		case 'active':
			return 'open';
		case 'completed':
		case 'abandoned':
			return 'closed';
		default:
			return undefined;
	}
}

/**
 * `mergeStatus` → the contract's git-only tri-state. `rejectedByPolicy` and
 * `failure` are `null`, not `false`: the contract's `mergeable` means "no merge
 * conflict", and answering `false` for a policy rejection or an evaluation error
 * would send the conflict-resolution trigger to rewrite a branch that has no
 * conflict. Once the pull request is no longer active the value is always `null`,
 * because Azure stops re-evaluating it.
 */
function toMergeable(pr: AzureDevOpsPullRequest): boolean | null {
	if (pr.status !== 'active') return null;
	switch (pr.mergeStatus) {
		case 'succeeded':
			return true;
		case 'conflicts':
			return false;
		default:
			return null;
	}
}

/**
 * Map Azure's pull request onto the neutral {@link PullRequestDetails}.
 *
 * `headSha` is `lastMergeSourceCommit` — the commit phase 5's merge pins to.
 * `baseSha` is `lastMergeTargetCommit`: the **target tip at Azure's last merge
 * evaluation**, not a merge base (Azure exposes none on the pull request). It is
 * still stable per (head, target-evaluation), which is what the conflict-resolution
 * claim key (`buildConflictResolutionKey`, `src/triggers/resolve-conflicts-dedup.ts`)
 * needs: one claim per evaluated conflict state, not one per unrelated read.
 *
 * Throws when a load-bearing field is absent. Both commits are populated
 * **asynchronously** right after a pull request is created and become part of that
 * exact-match key, so a stand-in would key a conflict claim on the wrong commit
 * instead of failing; the caller re-reads on its next sweep.
 */
function toPullRequestDetails(pr: AzureDevOpsPullRequest): PullRequestDetails {
	const number = pr.pullRequestId;
	const headSha = pr.lastMergeSourceCommit?.commitId;
	const baseSha = pr.lastMergeTargetCommit?.commitId;
	const state = neutralState(pr.status);
	if (
		number === undefined ||
		!pr.sourceRefName ||
		!headSha ||
		!pr.targetRefName ||
		!baseSha ||
		!state
	) {
		throw new Error(
			`Azure DevOps pull-request response is missing required fields (pullRequestId=${number}, status=${pr.status}, source=${pr.sourceRefName}@${headSha}, target=${pr.targetRefName}@${baseSha})`,
		);
	}
	return {
		number,
		headBranch: branchName(pr.sourceRefName),
		headSha,
		baseBranch: branchName(pr.targetRefName),
		baseSha,
		mergeable: toMergeable(pr),
		// The identity GUID — the namespace `./personas.ts` resolves personas in.
		authorLogin: pr.createdBy?.id ?? null,
		state,
	};
}

function pullRequestPath(repo: string, pullRequestId: number): string {
	return `${repositoryApiPath(repo)}/pullrequests/${pullRequestId}`;
}

function getPullRequestObject(
	repo: string,
	pullRequestId: number,
): Promise<AzureDevOpsPullRequest> {
	return azureDevOpsRequest<AzureDevOpsPullRequest>('GET', pullRequestPath(repo, pullRequestId));
}

/** {@link PullRequestDetails} for one pull request. */
export async function getAzureDevOpsPullRequest(
	repo: string,
	pullRequestId: number,
): Promise<PullRequestDetails> {
	return toPullRequestDetails(await getPullRequestObject(repo, pullRequestId));
}

/**
 * A pull request's title, or `null` when Azure reports none — same contract as the
 * other providers', for the same best-effort caller (the worker's run-history row).
 */
export async function getAzureDevOpsPullRequestTitle(
	repo: string,
	pullRequestId: number,
): Promise<string | null> {
	return (await getPullRequestObject(repo, pullRequestId)).title ?? null;
}

/**
 * A pull request's merge-relevant state, including the two things only Azure's pull
 * request itself carries — `isDraft` and the reviewers' votes — for phase 5's
 * eligibility recheck. Throws when the head commit or the status is absent: a merge
 * must never pin to a commit it could not read.
 */
export async function getAzureDevOpsPullRequestMergeState(
	repo: string,
	pullRequestId: number,
): Promise<AzureDevOpsPullRequestMergeState> {
	const pr = await getPullRequestObject(repo, pullRequestId);
	const headSha = pr.lastMergeSourceCommit?.commitId;
	const state = neutralState(pr.status);
	if (!headSha || !state) {
		throw new Error(
			`Azure DevOps pull request ${repo}!${pullRequestId} response is missing required fields (status=${pr.status}, lastMergeSourceCommit=${headSha})`,
		);
	}
	return {
		merged: pr.status === 'completed',
		state,
		draft: Boolean(pr.isDraft),
		headSha,
		reviewers: (pr.reviewers ?? []).flatMap((reviewer) =>
			reviewer.id
				? [{ id: reviewer.id, vote: reviewer.vote ?? 0, isRequired: Boolean(reviewer.isRequired) }]
				: [],
		),
		mergeStatus: pr.mergeStatus ?? null,
		mergeCommitSha: pr.lastMergeCommit?.commitId ?? null,
	};
}

/**
 * The delivery seam's `{ number, url }` for a pull-request response. A missing id
 * throws — every pull-request path is addressed by it. The URL is always derived
 * ({@link pullRequestWebUrl}): Azure's own `url` field is the REST resource, not a
 * page a human can open.
 */
export function toAzureDevOpsPullRequestReference(
	repo: string,
	pr: { pullRequestId?: number },
): AzureDevOpsPullRequestReference {
	if (pr.pullRequestId === undefined) {
		throw new Error(
			`Azure DevOps pull-request response for ${repo} carries no pullRequestId, so it cannot be referenced`,
		);
	}
	return { number: pr.pullRequestId, url: pullRequestWebUrl(repo, pr.pullRequestId) };
}

/**
 * The active pull request whose **source** branch is `branch`, or `undefined` when
 * none is — the delivery seam's "has this branch already got a pull request?"
 * lookup, which is what makes a resumed delivery reuse its own pull request instead
 * of opening a second one. Filtered server-side on the exact source ref; Azure
 * refuses a second active pull request for the same source/target pair, so the
 * first match is the one to reuse and a single page suffices.
 */
export async function findActiveAzureDevOpsPullRequest(
	repo: string,
	branch: string,
): Promise<AzureDevOpsPullRequestReference | undefined> {
	const query = new URLSearchParams({
		'searchCriteria.sourceRefName': `${BRANCH_REF_PREFIX}${branch}`,
		'searchCriteria.status': 'active',
	});
	const listed = await azureDevOpsRequest<AzureDevOpsList<AzureDevOpsPullRequest> | undefined>(
		'GET',
		`${repositoryApiPath(repo)}/pullrequests?${query}`,
	);
	const pr = listed?.value?.[0];
	return pr ? toAzureDevOpsPullRequestReference(repo, pr) : undefined;
}

/**
 * The commit `branch` currently points at ({@link SCMProvider.getBranchHead}).
 *
 * `filter=heads/{branch}` is a **prefix** match — `heads/main` also lists
 * `main-old` — so the exact `refs/heads/{branch}` is selected from the listing. An
 * exact miss **throws** "not found or not visible" rather than answering `null`:
 * Azure answers an absent branch with an empty listing rather than a 404, and the
 * contract reserves `null` for a provider that replied without naming a head, so an
 * empty listing has to read the way a 404 does on every other provider. A ref that
 * names no `objectId` is that `null`. An `AzureDevOpsApiError` propagates.
 */
export async function getAzureDevOpsBranchHead(
	repo: string,
	branch: string,
): Promise<string | null> {
	const query = new URLSearchParams({ filter: `heads/${branch}` });
	const refs = await paginateAzureDevOps<AzureDevOpsRef>(
		`${repositoryApiPath(repo)}/refs?${query}`,
		'continuation',
	);
	const exact = refs.find((ref) => ref.name === `${BRANCH_REF_PREFIX}${branch}`);
	if (!exact) {
		throw new Error(
			`Azure DevOps branch '${branch}' in ${repo} was not found or is not visible to this credential`,
		);
	}
	return exact.objectId ?? null;
}

/** When a commit status was posted, for keeping the newest of a re-post pair. */
function postedAt(status: AzureDevOpsCommitStatus): number {
	const parsed = Date.parse(status.creationDate ?? '');
	return Number.isNaN(parsed) ? 0 : parsed;
}

/** A commit status's identity across re-posts: `genre/name`, or `name` with no genre. */
function commitStatusName(status: AzureDevOpsCommitStatus): string | undefined {
	const name = status.context?.name;
	if (!name) return undefined;
	return status.context?.genre ? `${status.context.genre}/${name}` : name;
}

/**
 * The external-CI half of the aggregate: Git commit statuses on `sha`, newest per
 * `genre/name`. `latestOnly=true` already asks Azure for that; the client-side
 * dedupe keeps the count right even if it does not. An unnamed status cannot be
 * identified, so it is counted on its own.
 */
async function commitStatusChecks(repo: string, sha: string): Promise<Map<string, CheckRunState>> {
	const listed = await azureDevOpsRequest<AzureDevOpsList<AzureDevOpsCommitStatus> | undefined>(
		'GET',
		`${repositoryApiPath(repo)}/commits/${encodeURIComponent(sha)}/statuses?latestOnly=true`,
	);
	const latest = new Map<string, AzureDevOpsCommitStatus>();
	for (const [index, status] of (listed?.value ?? []).entries()) {
		const key = commitStatusName(status) ?? `#${index}`;
		const existing = latest.get(key);
		if (!existing || postedAt(status) >= postedAt(existing)) latest.set(key, status);
	}
	const checks = new Map<string, CheckRunState>();
	for (const [key, status] of latest) {
		checks.set(
			`status:${key}`,
			commitStatusCheckRun(commitStatusName(status) ?? key, status.state),
		);
	}
	return checks;
}

/** Whether a build ran on `sha` — directly, or as the head of a pull-request build's merge commit. */
function builtCommit(build: AzureDevOpsBuild, sha: string): boolean {
	const target = sha.toLowerCase();
	return (
		build.sourceVersion?.toLowerCase() === target ||
		build.triggerInfo?.['pr.sourceSha']?.toLowerCase() === target
	);
}

/**
 * The Azure Pipelines half of the aggregate: the newest build per pipeline
 * definition that ran on `sha`.
 *
 * Azure Pipelines does **not** post Git commit statuses for Azure Repos builds, so
 * this half is read from the builds API itself. That API filters by repository but
 * not by commit, so the repository's {@link BUILD_SCAN_LIMIT} most recently queued
 * builds are scanned and kept when `sourceVersion` — or, for a pull-request build,
 * which runs on Azure's merge commit, `triggerInfo['pr.sourceSha']` — names `sha`.
 * Newest first, so the first build seen per `definition.id` is the one kept: a
 * re-run's stale failure must not fail a green commit. The builds API names the
 * repository by GUID, which costs one repository read.
 */
async function buildChecks(repo: string, sha: string): Promise<Map<string, CheckRunState>> {
	const { organization, project } = azureRepoCoordinates(repo);
	const repository = await azureDevOpsRequest<{ id?: string }>('GET', repositoryApiPath(repo));
	if (!repository.id) {
		throw new Error(`Azure DevOps repository ${repo} response carries no id`);
	}
	const query = new URLSearchParams({
		repositoryId: repository.id,
		repositoryType: AZURE_REPOS_GIT,
		queryOrder: 'queueTimeDescending',
		$top: String(BUILD_SCAN_LIMIT),
	});
	const listed = await azureDevOpsRequest<AzureDevOpsList<AzureDevOpsBuild> | undefined>(
		'GET',
		`/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis/build/builds?${query}`,
	);
	const builds = listed?.value ?? [];
	if (builds.length >= BUILD_SCAN_LIMIT) {
		logger.warn(
			'Azure DevOps build scan hit its bound; older builds of this commit are not aggregated',
			{
				repo,
				sha,
				limit: BUILD_SCAN_LIMIT,
			},
		);
	}

	const checks = new Map<string, CheckRunState>();
	for (const [index, build] of builds.entries()) {
		if (!builtCommit(build, sha)) continue;
		const definitionId = build.definition?.id;
		const key = `build:${definitionId ?? `#${index}`}`;
		if (checks.has(key)) continue;
		const name = build.definition?.name ?? `build ${build.id ?? index}`;
		checks.set(key, buildCheckRun(name, build.status, build.result));
	}
	return checks;
}

/**
 * Aggregate every check on `sha` ({@link SCMProvider.getAggregateCheckStatus}): the
 * union of Git commit statuses (external CI) and Azure Pipelines builds, each deduped
 * within its own source, so `totalCount` is the deduped count.
 *
 * Branch-policy evaluations are deliberately **not** read: a policy (required
 * reviewers, a build-validation policy's own verdict) is merge gating, not CI, and a
 * build-validation policy's build is already counted here as a build.
 *
 * Either read failing throws — an unreadable commit must never read as green.
 */
export async function getAzureDevOpsCommitChecks(
	repo: string,
	sha: string,
): Promise<AggregateCheckStatus> {
	const [statuses, builds] = await Promise.all([
		commitStatusChecks(repo, sha),
		buildChecks(repo, sha),
	]);
	const checkRuns = [...statuses.values(), ...builds.values()];
	return { totalCount: checkRuns.length, checkRuns };
}

/** Every active pull request matching `criteria`, walked with `$top`/`$skip`. */
function listActivePullRequests(
	repo: string,
	criteria: Record<string, string> = {},
): Promise<AzureDevOpsPullRequest[]> {
	const query = new URLSearchParams({ 'searchCriteria.status': 'active', ...criteria });
	return paginateAzureDevOps<AzureDevOpsPullRequest>(
		`${repositoryApiPath(repo)}/pullrequests?${query}`,
		'skip',
	);
}

/**
 * The pull requests commit `sha` is the head of
 * ({@link SCMProvider.listPullRequestsForCommit}) — how a **branch** build's
 * `checks` event, which names no pull request, is tied back to one.
 *
 * Read as the repository's **active** pull requests filtered on
 * `lastMergeSourceCommit`, not through `POST …/pullrequestquery`: that endpoint's
 * query types (`lastMergeCommit`, `commit`) find the pull request that *created* a
 * merge commit or that *merged* a commit, never the open one whose head it is. The
 * cost is one paginated listing of open pull requests — bounded by the client's
 * page cap, independent of history. Only open pull requests can be answered, which
 * is all the caller picks from. An empty array is an ordinary answer: Azure
 * re-evaluates `lastMergeSourceCommit` asynchronously after a push, so a commit
 * pushed a moment ago may not be indexed yet.
 */
export async function listAzureDevOpsPullRequestsForCommit(
	repo: string,
	sha: string,
): Promise<CommitPullRequest[]> {
	const target = sha.toLowerCase();
	const prs = await listActivePullRequests(repo);
	return prs
		.filter((pr) => pr.lastMergeSourceCommit?.commitId?.toLowerCase() === target)
		.map((pr) => {
			const state = neutralState(pr.status);
			if (pr.pullRequestId === undefined || !state || !pr.sourceRefName) {
				throw new Error(
					`Azure DevOps pull-request response for commit ${sha} is missing required fields (pullRequestId=${pr.pullRequestId}, status=${pr.status}, sourceRefName=${pr.sourceRefName})`,
				);
			}
			return { number: pr.pullRequestId, state, headBranch: branchName(pr.sourceRefName) };
		});
}

/** Whether a list entry already carries everything {@link toPullRequestDetails} needs. */
function isComplete(pr: AzureDevOpsPullRequest): boolean {
	return Boolean(
		pr.lastMergeSourceCommit?.commitId && pr.lastMergeTargetCommit?.commitId && pr.mergeStatus,
	);
}

/**
 * Active same-repository pull requests targeting `baseBranch` — the
 * conflict-detection seam after a base advances. Filtered server-side
 * (`status=active`, `targetRefName`), then forks — a pull request with a
 * `forkSource` — are dropped, as on the other providers: SWARM cannot push a
 * conflict resolution to a branch in someone else's repository.
 *
 * Unlike GitLab's list, Azure's normally carries both merge commits and
 * `mergeStatus`, so a complete entry is mapped as listed; only an entry missing one
 * of them is re-read individually, in batches of
 * {@link CONFLICT_CANDIDATE_READ_CONCURRENCY}. A candidate still incomplete after
 * that fails the whole listing (the same all-or-nothing as the other adapters).
 */
export async function listActiveAzureDevOpsPullRequestsForBase(
	repo: string,
	baseBranch: string,
): Promise<PullRequestDetails[]> {
	const listed = await listActivePullRequests(repo, {
		'searchCriteria.targetRefName': `${BRANCH_REF_PREFIX}${baseBranch}`,
	});
	const sameRepository = listed.filter((pr) => pr.forkSource == null);
	const candidates: PullRequestDetails[] = [];
	for (let index = 0; index < sameRepository.length; index += CONFLICT_CANDIDATE_READ_CONCURRENCY) {
		const batch = sameRepository.slice(index, index + CONFLICT_CANDIDATE_READ_CONCURRENCY);
		candidates.push(
			...(await Promise.all(
				batch.map(async (pr) => {
					if (isComplete(pr)) return toPullRequestDetails(pr);
					if (pr.pullRequestId === undefined) {
						throw new Error(
							`Azure DevOps pull-request list entry for ${repo} carries no pullRequestId`,
						);
					}
					return getAzureDevOpsPullRequest(repo, pr.pullRequestId);
				}),
			)),
		);
	}
	return candidates;
}
