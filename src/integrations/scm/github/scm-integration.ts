/**
 * GitHubSCMIntegration — GitHub's implementation of the provider-neutral
 * {@link SCMProvider} contract (`src/scm/types.ts`), ported from Cascade's
 * `src/github/scm-integration.ts`.
 *
 * The core job of this class is to run a block of GitHub operations under the
 * correct persona's credentials. Callers hand it a project + persona and a
 * function; it resolves that persona's token and binds it to the async context
 * (via `withGitHubToken`) for the duration of the call. Because resolution
 * happens per invocation, a single pipeline can review as the reviewer and push
 * fixes as the implementer without either token ever appearing in a signature
 * (ai/CODING_STANDARDS.md "Scope credentials with AsyncLocalStorage").
 *
 * The `implements SCMProvider` declaration below is the compile-time conformance
 * check; the runtime one is the multi-provider harness that landed with the second
 * complete provider (`tests/unit/integrations/scm/scm-conformance.test.ts`, issue
 * #296 phase 4/4), which asserts every *registered* manifest's surface — what
 * shared code actually holds. Everything GitHub-specific — Octokit
 * types, GraphQL node IDs, which REST status means which merge outcome — stays
 * inside this module, `./client.js`, and `./webhook.js` (which owns every raw
 * webhook name, header, payload path, and the `sha256=` signature framing since
 * issue #385 moved ingress behind this contract).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPersonaToken, getPersonaTokenOrNull } from '../../../config/provider.js';
import type { ProjectConfig } from '../../../config/schema.js';
import type { ScmDeliveryProvider } from '../../../scm/delivery.js';
import type { ScmEvent } from '../../../scm/events.js';
import type {
	MergePullRequestOutcome,
	UpdatePullRequestBranchOutcome,
} from '../../../scm/merge.js';
import type {
	AggregateCheckStatus,
	CommitPullRequest,
	PullRequestDetails,
	SCMProvider,
	ScmPersona,
	ScmPersonaIdentities,
	ScmWebhookRequest,
	WebhookHeaderReader,
} from '../../../scm/types.js';
import {
	createPullRequest,
	findOpenPullRequest,
	getBranchHead,
	getCheckSuiteStatus,
	getGitHubUserForToken,
	getPullRequest,
	getPullRequestMergeState,
	getPullRequestReviewDecision,
	getPullRequestReviews,
	getPullRequestTitle,
	listOpenPullRequestsForBase,
	listPullRequestsForCommit,
	mergePullRequestDirect,
	postIdempotentPullRequestComment,
	postIssueComment,
	submitPullRequestReview,
	updatePullRequestBranchDirect,
	withGitHubToken,
} from './client.js';
import { createOperatorDeliveryProvider } from './operator-delivery.js';
import { getPersonaForLogin, isSwarmBot, resolvePersonaIdentities } from './personas.js';
import {
	isSwarmGeneratedGitHubEvent,
	parseGitHubWebhook,
	readGitHubWebhookRequest,
	verifyGitHubSignature,
} from './webhook.js';

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Octokit's `RequestError#status`, if `error` carries one. */
function errorStatus(error: unknown): number | undefined {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === 'number' ? status : undefined;
}

/**
 * Classify a thrown Octokit error from the direct-merge REST endpoint into the
 * provider-neutral outcome. A repository whose rules require the merge queue
 * cannot be merged through the direct endpoint at all — GitHub names the queue
 * in the error body — so that's `unsupported` (it needs a human or a queue
 * integration, not a retry). Otherwise GitHub responds 405 for a PR that isn't
 * currently mergeable (pending/failing checks, missing approvals, conflicts)
 * and 409 for a race on the expected head — both transient, so `not-ready`. A
 * 403 means the repository's own rules refuse the merge outright:
 * `policy-blocked`. Anything else (401, 404, 5xx, network failure) is an
 * unexpected `provider-error`.
 */
function classifyDirectMergeError(error: unknown): MergePullRequestOutcome {
	const message = errorMessage(error);
	const status = errorStatus(error);
	if (/merge queue/i.test(message)) return { status: 'unsupported', message };
	if (status === 405 || status === 409) return { status: 'not-ready', message };
	if (status === 403) return { status: 'policy-blocked', message };
	return { status: 'provider-error', message };
}

/**
 * The credential-scoped body of {@link GitHubSCMIntegration.mergePullRequest}.
 * Re-reads the PR's current state on every call (never trusts a cached
 * lookup from an earlier attempt), so a durable retry re-evaluates
 * eligibility from scratch rather than merging stale approval context.
 */
async function mergeReadyPullRequest(
	owner: string,
	repo: string,
	prNumber: number,
	approvedHeadSha: string,
): Promise<MergePullRequestOutcome> {
	let state: Awaited<ReturnType<typeof getPullRequestMergeState>>;
	try {
		state = await getPullRequestMergeState(owner, repo, prNumber);
	} catch (error) {
		return { status: 'provider-error', message: errorMessage(error) };
	}
	if (state.merged) return { status: 'merged', message: 'pull request already merged' };
	// The approval this attempt was requested for only covers one exact commit.
	// A push since then (including a rebase/force-push that keeps the same
	// diff) means nobody has reviewed the PR's *current* head, so merging it
	// would silently ship unreviewed content — this needs a fresh review, not a
	// retry.
	if (state.headSha !== approvedHeadSha)
		return {
			status: 'not-eligible',
			message: `pull request head changed since the reviewed commit (reviewed ${approvedHeadSha}, now ${state.headSha}); a fresh review is required before merge automation can proceed`,
		};
	if (state.draft)
		return {
			status: 'not-eligible',
			message: 'pull request was converted back to a draft after the review was approved',
		};
	if (state.state !== 'open')
		return { status: 'not-eligible', message: `pull request is ${state.state}` };

	// The head is unchanged, but the approval itself may no longer be in
	// effect (a reviewer dismissed it, or another review requested changes).
	// `REVIEW_REQUIRED` is only left to flow into the merge attempt below when
	// we verify that the approved review at the head Sha is still active (e.g.
	// during the short propagation window right after a review is submitted).
	// If the approval has been dismissed (meaning there is no active APPROVED
	// review at the expected head Sha), we return not-eligible immediately.
	let reviewDecision: Awaited<ReturnType<typeof getPullRequestReviewDecision>>;
	try {
		reviewDecision = await getPullRequestReviewDecision(owner, repo, prNumber);
	} catch (error) {
		return { status: 'provider-error', message: errorMessage(error) };
	}
	if (reviewDecision === 'CHANGES_REQUESTED')
		return {
			status: 'not-eligible',
			message: 'the approving review is no longer in effect — changes have since been requested',
		};
	if (reviewDecision === 'REVIEW_REQUIRED') {
		let reviews: Awaited<ReturnType<typeof getPullRequestReviews>>;
		try {
			reviews = await getPullRequestReviews(owner, repo, prNumber);
		} catch (error) {
			return { status: 'provider-error', message: errorMessage(error) };
		}
		const hasApproved = reviews.some(
			(r) => r.state === 'APPROVED' && r.commitId === approvedHeadSha,
		);
		if (!hasApproved) {
			return {
				status: 'not-eligible',
				message: 'the approving review is no longer in effect — it has since been dismissed',
			};
		}
	}

	// The approval holds and the request is otherwise ready — but its checks ran
	// against a base that has since moved, so nothing has verified the tree this
	// merge would actually produce (issue #874). Deliberately last, after every
	// eligibility check above: a request whose approval no longer holds must
	// report that rather than be brought up to date and re-verified for nothing.
	if (state.behindBase)
		return {
			status: 'stale-base',
			message: `pull request head ${state.headSha} is behind its base branch, so its checks did not build the tree this merge would produce`,
		};

	try {
		const merge = await mergePullRequestDirect(owner, repo, prNumber, state.headSha);
		return merge.merged
			? { status: 'merged', message: merge.message, sha: merge.sha }
			: { status: 'not-ready', message: merge.message };
	} catch (error) {
		return classifyDirectMergeError(error);
	}
}

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * How long to wait for GitHub's branch-update job to actually produce the new
 * head. `PUT .../update-branch` answers 202 and merges the base in the
 * background, so the new commit is not observable in the response — and the
 * caller cannot proceed without it, because the SHA it re-pins the approval to
 * is the whole guarantee that only a commit SWARM asked for is carried forward.
 * Five one-second reads: the job typically settles in well under a second, and
 * blocking a merge attempt for a few seconds costs nothing (merging is not a hot
 * path), while a longer wait would hold the dispatch's worker slot for a
 * condition that is better reported than waited out.
 */
const UPDATE_BRANCH_READBACK_ATTEMPTS = 5;
const UPDATE_BRANCH_READBACK_DELAY_MS = 1_000;

/**
 * Classify a thrown Octokit error from the update-branch endpoint. GitHub
 * answers **422** both for "the head is not `expected_head_sha` any more" and
 * for "the base does not merge cleanly into this branch", with no machine-
 * readable way to tell them apart. Both are `conflict` here, which is right for
 * the caller either way: the merge dispatch settles terminally and hands the
 * pull request to a human (or, for a real conflict, to the Resolve-conflicts
 * path that owns them), rather than retrying an update that cannot succeed. A
 * 403 is the same permission refusal `classifyDirectMergeError` reads it as, but
 * on a capability rather than a merge, so it reports as `unsupported` — SWARM's
 * credential cannot write this branch, and no retry changes that. Anything else
 * is an unexpected `provider-error`.
 */
function classifyUpdateBranchError(error: unknown): UpdatePullRequestBranchOutcome {
	const message = errorMessage(error);
	const status = errorStatus(error);
	// The one 422 GitHub does name in words, and not a refusal at all: something
	// else advanced the branch between the merge attempt that reported
	// `stale-base` and this call.
	if (/up.to.date/i.test(message)) return { status: 'up-to-date' };
	if (status === 422) return { status: 'conflict', message };
	if (status === 403) return { status: 'unsupported', message };
	return { status: 'provider-error', message };
}

/** The credential-scoped body of {@link GitHubSCMIntegration.updatePullRequestBranch}. */
async function updateGitHubPullRequestBranch(
	owner: string,
	repo: string,
	prNumber: number,
	expectedHeadSha: string,
): Promise<UpdatePullRequestBranchOutcome> {
	try {
		await updatePullRequestBranchDirect(owner, repo, prNumber, expectedHeadSha);
	} catch (error) {
		return classifyUpdateBranchError(error);
	}

	let last: Awaited<ReturnType<typeof getPullRequestMergeState>> | null = null;
	for (let attempt = 0; attempt < UPDATE_BRANCH_READBACK_ATTEMPTS; attempt++) {
		await delay(UPDATE_BRANCH_READBACK_DELAY_MS);
		try {
			last = await getPullRequestMergeState(owner, repo, prNumber);
		} catch (error) {
			return { status: 'provider-error', message: errorMessage(error) };
		}
		if (last.headSha !== expectedHeadSha) return { status: 'updated', headSha: last.headSha };
	}
	// The head never moved. Either the base was already contained in it — GitHub
	// accepts the request and produces no commit — or the background job has not
	// published one yet. `behindBase` is what tells those apart, and only *after*
	// the wait above: it is computed asynchronously too, so reading it earlier
	// would call an in-progress update "up to date".
	if (last && !last.behindBase) return { status: 'up-to-date' };
	// Reported rather than assumed: answering `updated` with the old SHA would
	// re-pin the approval to a commit the update is about to replace, and the
	// next attempt would then read a moved head and refuse the merge outright.
	return {
		status: 'provider-error',
		message: `GitHub accepted the branch update for #${prNumber} but had not published the new head after ${UPDATE_BRANCH_READBACK_ATTEMPTS}s`,
	};
}

export class GitHubSCMIntegration implements SCMProvider {
	readonly type = 'github' as const;
	readonly category = 'scm' as const;

	/**
	 * Whether GitHub SCM is usable for a project — true if at least one persona
	 * token is configured. Some flows only need one persona, so this is
	 * deliberately an OR, not an AND.
	 */
	async hasIntegration(project: ProjectConfig): Promise<boolean> {
		const [implementer, reviewer] = await Promise.all([
			getPersonaTokenOrNull(project, 'implementer'),
			getPersonaTokenOrNull(project, 'reviewer'),
		]);
		return implementer !== null || reviewer !== null;
	}

	/** Whether a specific persona's token is configured for a project. */
	async hasPersonaToken(project: ProjectConfig, persona: ScmPersona): Promise<boolean> {
		const token = await getPersonaTokenOrNull(project, persona);
		return token !== null;
	}

	/**
	 * {@link SCMProvider.resolvePersonaIdentities} — the contract's view of the
	 * module-level `resolvePersonaIdentities`, including its per-project TTL cache.
	 * The module function stays exported for direct utility usage (the PM adapter
	 * `src/router/adapters/github-projects.ts` is the last direct importer).
	 */
	async resolvePersonaIdentities(project: ProjectConfig): Promise<ScmPersonaIdentities> {
		return resolvePersonaIdentities(project);
	}

	/** {@link SCMProvider.personaForActor} — GitHub's `getPersonaForLogin`. */
	personaForActor(login: string, identities: ScmPersonaIdentities): ScmPersona | null {
		return getPersonaForLogin(login, identities);
	}

	/**
	 * {@link SCMProvider.isSwarmActor} — GitHub's `isSwarmBot`, which matches
	 * configured persona identities and `[bot]`-suffixed App forms for the PM
	 * board's status-change gate and conflict filter (NOT the event drop gate,
	 * which uses markers per #443 and work-item origin per #397).
	 */
	isSwarmActor(login: string, identities: ScmPersonaIdentities): boolean {
		return isSwarmBot(login, identities);
	}

	/**
	 * {@link SCMProvider.verifyWebhookSignature} — GitHub signs the raw payload
	 * with HMAC-SHA256 and sends `sha256=<hex>` in `X-Hub-Signature-256`
	 * (`./webhook.js`, over the neutral timing-safe `verifyHmac`).
	 */
	verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
		return verifyGitHubSignature(rawBody, signature, secret);
	}

	/**
	 * {@link SCMProvider.readWebhookRequest} — GitHub's `X-GitHub-Event`,
	 * `X-GitHub-Delivery`, and `X-Hub-Signature-256` headers (`./webhook.js`).
	 */
	readWebhookRequest(header: WebhookHeaderReader): ScmWebhookRequest {
		return readGitHubWebhookRequest(header);
	}

	/**
	 * {@link SCMProvider.parseWebhookEvent} — maps GitHub's five processable event
	 * types and their payload shapes onto the neutral event (`./webhook.js`).
	 */
	parseWebhookEvent(eventName: string, payload: unknown): ScmEvent | null {
		return parseGitHubWebhook(eventName, payload);
	}

	/** {@link SCMProvider.isSwarmGeneratedEvent} — the comment-marker drop gate (`./webhook.js`). */
	async isSwarmGeneratedEvent(event: ScmEvent, project: ProjectConfig): Promise<boolean> {
		return isSwarmGeneratedGitHubEvent(event, project);
	}

	/**
	 * Resolve `persona`'s token for `project` and run `fn` within that GitHub
	 * credential scope. Every GitHub operation inside `fn` — via
	 * `getScopedClient()` — authenticates as that persona. Throws (before running
	 * `fn`) if the persona's token isn't configured.
	 */
	async withPersonaCredentials<T>(
		project: ProjectConfig,
		persona: ScmPersona,
		fn: () => Promise<T>,
	): Promise<T> {
		const token = await getPersonaToken(project, persona);
		return withGitHubToken(token, fn);
	}

	/**
	 * Convenience wrapper for the common case: run `fn` as the implementer, the
	 * persona behind most SCM writes (opening PRs, pushing, commenting).
	 */
	async withCredentials<T>(project: ProjectConfig, fn: () => Promise<T>): Promise<T> {
		return this.withPersonaCredentials(project, 'implementer', fn);
	}

	/**
	 * Post a top-level comment on a pull request as `persona`, returning the new
	 * comment's id. The PR-driven phases (review / respond-to-*) normally comment
	 * from *inside* the agent run via `gh`; this is the out-of-band path for the
	 * worker's stalled-job safety net, where the run was reclaimed before it could
	 * comment itself and the PM provider has no PR → comment mapping. Defaults to
	 * the implementer (the PR's author, whose token is always configured for a
	 * project that opens PRs); a comment triggers no pipeline phase, so the persona
	 * choice is immaterial to loop prevention.
	 */
	async commentOnPullRequest(
		project: ProjectConfig,
		prNumber: number,
		body: string,
		persona: ScmPersona = 'implementer',
	): Promise<number> {
		const [owner, repo] = project.repo.split('/');
		return this.withPersonaCredentials(project, persona, () =>
			postIssueComment(owner, repo, prNumber, body),
		);
	}

	/**
	 * Resolve a PR's title for a run-history row (the worker's `tryCreateRun`).
	 * Reads under the implementer persona (the PR's author, whose token is always
	 * configured for a project that opens PRs); reading a title triggers no
	 * pipeline phase, so the persona choice is immaterial to loop prevention.
	 */
	async getPullRequestTitle(
		project: ProjectConfig,
		prNumber: number,
		persona: ScmPersona = 'implementer',
	): Promise<string | null> {
		const [owner, repo] = project.repo.split('/');
		return this.withPersonaCredentials(project, persona, () =>
			getPullRequestTitle(owner, repo, prNumber),
		);
	}

	/**
	 * {@link SCMProvider.pullRequestUrl} — GitHub's `/pull/<number>` web path.
	 * Pure and github.com-only, exactly like the clone URL this adapter builds
	 * below: this integration targets github.com, not GitHub Enterprise.
	 */
	pullRequestUrl(repo: string, prNumber: number | string): string {
		return `https://github.com/${repo}/pull/${prNumber}`;
	}

	/**
	 * {@link SCMProvider.getBranchHead} — the branch's current head commit, read
	 * with `repos.getBranch`. Defaults to the **implementer** persona rather than
	 * the reviewer its two neighbours below default to: this is a repository-level
	 * read like {@link GitHubSCMIntegration.listConflictCandidates}, and its caller
	 * today is a router sweep holding only the operator's own credential
	 * (`SWARM_OPERATOR_GH_TOKEN`).
	 */
	async getBranchHead(
		project: ProjectConfig,
		branch: string,
		persona: ScmPersona = 'implementer',
	): Promise<string | null> {
		const [owner, repo] = project.repo.split('/');
		return this.withPersonaCredentials(project, persona, () => getBranchHead(owner, repo, branch));
	}

	/**
	 * {@link SCMProvider.getAggregateCheckStatus} — every check on `ref`,
	 * aggregated. Reads under the **reviewer** persona by default, the same scope
	 * the review handler's aggregate query uses today.
	 */
	async getAggregateCheckStatus(
		project: ProjectConfig,
		ref: string,
		persona: ScmPersona = 'reviewer',
	): Promise<AggregateCheckStatus> {
		const [owner, repo] = project.repo.split('/');
		return this.withPersonaCredentials(project, persona, () =>
			getCheckSuiteStatus(owner, repo, ref),
		);
	}

	/**
	 * {@link SCMProvider.listPullRequestsForCommit}. Reads under the **reviewer**
	 * persona by default — the same scope the aggregate check query that follows it
	 * on the `checks` path uses. GitHub's `check_suite` payload names associated pull
	 * requests when present; branch and default-branch checks need this read to resolve
	 * a pull request. The seam is neutral rather than Bitbucket-only (issue #618).
	 */
	async listPullRequestsForCommit(
		project: ProjectConfig,
		sha: string,
		persona: ScmPersona = 'reviewer',
	): Promise<CommitPullRequest[]> {
		const [owner, repo] = project.repo.split('/');
		return this.withPersonaCredentials(project, persona, () =>
			listPullRequestsForCommit(owner, repo, sha),
		);
	}

	/**
	 * {@link ScmMergeProvider.mergePullRequest} for GitHub (issue #253, retried
	 * durably as a merge dispatch per issue #292): merge an approved, ready PR
	 * as the implementer via GitHub's direct REST merge endpoint — the primary
	 * and only merge strategy. GitHub's native auto-merge is deliberately never
	 * requested: it is unavailable on many private repositories and has no
	 * portable equivalent in other SCMs (issue #292). Idempotent — a PR found
	 * already merged (e.g. a retried call) reports `merged` without attempting
	 * anything. Re-reads the PR's current state on every call, so a retry made
	 * long after the original approval re-checks eligibility rather than
	 * trusting stale context: a changed head, a dismissed/overridden approval,
	 * or a closed/draft PR reports `not-eligible` instead of merging. Never
	 * throws: every refusal or unexpected failure comes back as a terminal,
	 * non-`merged` {@link MergePullRequestOutcome} so a completed,
	 * already-submitted Review can't be retroactively failed by this call.
	 */
	async mergePullRequest(
		project: ProjectConfig,
		prNumber: number,
		approvedHeadSha: string,
	): Promise<MergePullRequestOutcome> {
		const [owner, repo] = project.repo.split('/');
		return this.withCredentials(project, () =>
			mergeReadyPullRequest(owner, repo, prNumber, approvedHeadSha),
		);
	}

	/**
	 * {@link ScmMergeProvider.updatePullRequestBranch} for GitHub (issue #874):
	 * merge the base into the pull request's branch as the implementer, through
	 * `PUT .../update-branch` pinned to `expectedHeadSha`. The pin is what lets
	 * the merge dispatch carry the approval onto the resulting commit — GitHub
	 * refuses with 422 if the head is not the commit SWARM believes it is, so an
	 * externally pushed head can never be swept into an approved merge.
	 *
	 * The new head is read back rather than derived, because the endpoint answers
	 * 202 with no SHA ({@link updateGitHubPullRequestBranch}). Never throws:
	 * every refusal or unexpected failure comes back as an
	 * {@link UpdatePullRequestBranchOutcome}, credential resolution included.
	 */
	async updatePullRequestBranch(
		project: ProjectConfig,
		prNumber: number,
		expectedHeadSha: string,
	): Promise<UpdatePullRequestBranchOutcome> {
		const [owner, repo] = project.repo.split('/');
		try {
			return await this.withCredentials(project, () =>
				updateGitHubPullRequestBranch(owner, repo, prNumber, expectedHeadSha),
			);
		} catch (error) {
			return { status: 'provider-error', message: errorMessage(error) };
		}
	}

	/** Provider seam for conflict detection after a base branch advances. */
	async listConflictCandidates(
		project: ProjectConfig,
		baseBranch: string,
	): Promise<PullRequestDetails[]> {
		const [owner, repo] = project.repo.split('/');
		return this.withPersonaCredentials(project, 'implementer', () =>
			listOpenPullRequestsForBase(owner, repo, baseBranch),
		);
	}

	async getPullRequest(
		project: ProjectConfig,
		prNumber: number,
		persona: ScmPersona = 'reviewer',
	): Promise<PullRequestDetails> {
		const [owner, repo] = project.repo.split('/');
		return this.withPersonaCredentials(project, persona, () =>
			getPullRequest(owner, repo, prNumber),
		);
	}

	/**
	 * {@link SCMProvider.deliveryProvider} — the same-host, per-persona delivery
	 * seam. Not the only producer of an {@link ScmDeliveryProvider}: see
	 * {@link GitHubSCMIntegration.operatorDeliveryProvider} and
	 * `src/scm/transport-delivery.ts`.
	 */
	async deliveryProvider(
		project: ProjectConfig,
		persona: ScmPersona,
	): Promise<ScmDeliveryProvider> {
		const [owner, repo] = project.repo.split('/');
		const token = await getPersonaToken(project, persona);
		const login = await getGitHubUserForToken(token);
		if (!login) throw new Error(`Could not resolve GitHub identity for ${persona} persona`);
		const scoped = <T>(fn: () => Promise<T>) => this.withPersonaCredentials(project, persona, fn);
		return {
			commitIdentity: { name: login, email: `${login}@users.noreply.github.com` },
			findPullRequest: (branch) => scoped(() => findOpenPullRequest(owner, repo, branch)),
			createPullRequest: (input) => scoped(() => createPullRequest(owner, repo, input)),
			pushBranch: async (cwd, branch, expectedSha) => {
				const authorization = Buffer.from(`x-access-token:${token}`).toString('base64');
				await promisify(execFile)(
					'git',
					[
						'push',
						'--no-verify',
						`https://github.com/${project.repo}.git`,
						`${expectedSha}:refs/heads/${branch}`,
					],
					{
						cwd,
						env: {
							...process.env,
							GIT_CONFIG_COUNT: '1',
							GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
							GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
						},
					},
				);
			},
			submitReview: (input) => scoped(() => submitPullRequestReview(owner, repo, input)),
			postComment: (input) => scoped(() => postIdempotentPullRequestComment(owner, repo, input)),
		};
	}

	/**
	 * {@link SCMProvider.operatorDeliveryProvider} — the operator-credential
	 * delivery seam a DB-free federated worker runs its source-carrying ops on,
	 * built by `./operator-delivery.js` (which keeps every GitHub specific — the
	 * `x-access-token` push header, the noreply commit email — inside this module).
	 * `submitReview` on the returned provider deliberately throws: a reviewer
	 * verdict is the server's write to make under the project's reviewer PAT.
	 */
	async operatorDeliveryProvider(repo: string, credential: string): Promise<ScmDeliveryProvider> {
		return createOperatorDeliveryProvider(repo, credential);
	}
}
