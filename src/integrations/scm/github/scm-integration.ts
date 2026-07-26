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
 * The `implements SCMProvider` declaration below *is* the conformance check —
 * with one provider, a runtime conformance harness would be speculative
 * (ai/TESTING.md "Provider conformance"). Everything GitHub-specific — Octokit
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
import type { MergePullRequestOutcome } from '../../../scm/merge.js';
import type {
	AggregateCheckStatus,
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
	getCheckSuiteStatus,
	getGitHubUserForToken,
	getPullRequest,
	getPullRequestMergeState,
	getPullRequestReviewDecision,
	getPullRequestReviews,
	getPullRequestTitle,
	listOpenPullRequestsForBase,
	mergePullRequestDirect,
	postIdempotentPullRequestComment,
	postIssueComment,
	submitPullRequestReview,
	withGitHubToken,
} from './client.js';
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

	try {
		const merge = await mergePullRequestDirect(owner, repo, prNumber, state.headSha);
		return merge.merged
			? { status: 'merged', message: merge.message, sha: merge.sha }
			: { status: 'not-ready', message: merge.message };
	} catch (error) {
		return classifyDirectMergeError(error);
	}
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
	 * The module function stays exported: ingress and three trigger handlers still
	 * import it directly until issue #385.
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
	 * seam. Not the only producer of an {@link ScmDeliveryProvider}: see the
	 * contract's note on `operator-delivery.ts` and `src/scm/transport-delivery.ts`.
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
}
