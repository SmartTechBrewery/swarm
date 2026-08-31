/**
 * GitLabSCMIntegration — GitLab.com's implementation of the provider-neutral
 * {@link SCMProvider} contract (`src/scm/types.ts`), built out over four phases
 * (issue #295) along the same seams Bitbucket used, and now complete:
 * availability probing, persona credential scoping, and persona identity / actor
 * resolution (phase 1/4); the whole inbound half — header interpretation,
 * delivery authentication, event normalization, and the comment loop-prevention
 * gate (phase 2/4, delegated to `./webhook.ts`); the merge-request /
 * commit-status reads (phase 3/4, delegated to `./merge-requests.ts`); and notes,
 * the delivery seam, and the direct merge (phase 4/4, delegated to `./writes.ts`
 * / `./operator-delivery.ts`). No contract method is stubbed — the multi-provider
 * conformance suite (`tests/unit/integrations/scm/scm-conformance.test.ts`)
 * asserts that for every registered manifest, which is why the manifest
 * (`./index.ts`) could only land with this phase.
 *
 * Its core job is the same as the GitHub and Bitbucket classes': run a block of
 * GitLab operations under the correct persona's token. Callers hand it a project
 * + persona and a function; it resolves that persona's token and binds it to the
 * async context (`withGitLabToken`) for the duration of the call. Because
 * resolution happens per invocation, one pipeline can review as the reviewer and
 * push as the implementer without either token appearing in a signature
 * (ai/CODING_STANDARDS.md "Scope credentials with AsyncLocalStorage").
 *
 * **Implemented is still not reachable.** The manifest keeps `runtimeReady: false`
 * (`./index.ts`): nothing selects a project's SCM provider, so no served route or
 * project-scoped lookup resolves to GitLab. That wiring — project→provider
 * selection plus a served ingress route — is a separate follow-up, not part of
 * #295, and Bitbucket is waiting on the same one (ai/RULES.md §2).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { getGitLabBranchHead, getScopedGitLabUser, withGitLabToken } from './client.js';
import { getGitLabToken, getGitLabTokenOrNull } from './credentials.js';
import {
	findOpenGitLabMergeRequest,
	getGitLabCommitStatuses,
	getGitLabMergeRequest,
	getGitLabMergeRequestApprovals,
	getGitLabMergeRequestMergeState,
	getGitLabMergeRequestTitle,
	gitLabMergeRequestUrl,
	listGitLabMergeRequestsForCommit,
	listOpenGitLabMergeRequestsForBase,
} from './merge-requests.js';
import { createGitLabOperatorDeliveryProvider } from './operator-delivery.js';
import {
	getGitLabPersonaForLogin,
	isSwarmGitLabActor,
	resolveGitLabPersonaIdentities,
} from './personas.js';
import {
	isSwarmGeneratedGitLabEvent,
	parseGitLabWebhook,
	readGitLabWebhookRequest,
	verifyGitLabWebhookToken,
} from './webhook.js';
import {
	createGitLabMergeRequest,
	mergeGitLabMergeRequestDirect,
	postGitLabMergeRequestNote,
	postIdempotentGitLabMergeRequestNote,
	submitGitLabReview,
} from './writes.js';

/** GitLab.com's git-over-HTTPS host — the push remote and the `extraheader` scope. */
const GITLAB_GIT_ORIGIN = 'https://gitlab.com/';

/**
 * GitLab authenticates a git push with any token form under the reserved `oauth2`
 * user, so — unlike Bitbucket, whose `client.ts` must branch on whether the
 * credential is already a `user:password` pair — there is one spelling here.
 */
function gitlabGitBasicCredential(token: string): string {
	return `oauth2:${token}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `GitLabApiError#status`, if `error` carries one (it mirrors Octokit's field name). */
function errorStatus(error: unknown): number | undefined {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === 'number' ? status : undefined;
}

/**
 * Classify a thrown GitLab error from the direct-merge endpoint into the
 * provider-neutral outcome — the GitLab twin of GitHub's
 * `classifyDirectMergeError` and `classifyBitbucketDirectMergeError`. The statuses
 * are GitLab's own documented set for `PUT .../merge` (checked against GitLab
 * 19.1's REST reference), which is **not** the set the other two adapters see:
 *
 * - **409** is GitLab's "the `sha` no longer matches the head of the source
 *   branch". Since the pre-merge recheck ({@link mergeReadyGitLabMergeRequest})
 *   just verified that head against the reviewed commit, a 409 means the branch
 *   moved inside that window — so nobody has reviewed the current head and this
 *   needs a fresh review, `not-eligible`. That is the one place GitLab's mapping
 *   deliberately differs from GitHub's, where a 409 is a stale-head *race* on a
 *   merge that was never pinned to a reviewed commit.
 * - **405** ("the merge request cannot merge") covers every readiness blocker
 *   GitLab collapses into one status — a required pipeline still running,
 *   unresolved discussions, missing approvals, a draft — while **422** and **406**
 *   ("branch cannot be merged") mean a conflict. All are `not-ready`, which the merge
 *   dispatch retries. GitLab renamed that refusal from 406 to 422, so both
 *   spellings map rather than making the table depend on the instance's version.
 * - **401** is where GitLab diverges most: its merge endpoint documents 401, not
 *   403, for "this user does not have permission to accept this merge request".
 *   Both map to `policy-blocked`. Reading 401 as a dead credential would be wrong
 *   here — the recheck's two reads ran on this same token moments earlier, so the
 *   token is demonstrably live and a 401 from the merge itself is the documented
 *   permission refusal.
 *
 * Anything else (404, 5xx, a network failure) is an unexpected `provider-error`.
 *
 * Nothing maps to `unsupported`. GitLab's merge trains are the configuration that
 * would earn it — the case GitHub reserves it for, where a merge queue makes the
 * direct endpoint unusable outright — but they have no unsatisfiable path: a
 * train-configured project refuses the direct merge with 405 while its required
 * pipeline is unfinished and accepts it once the pipeline is green, so retrying is
 * the correct response rather than declaring the merge impossible.
 */
function classifyGitLabDirectMergeError(error: unknown): MergePullRequestOutcome {
	const message = errorMessage(error);
	const status = errorStatus(error);
	if (status === 409) return { status: 'not-eligible', message };
	if (status === 405 || status === 406 || status === 422) return { status: 'not-ready', message };
	if (status === 401 || status === 403) return { status: 'policy-blocked', message };
	return { status: 'provider-error', message };
}

/**
 * The token-scoped body of {@link GitLabSCMIntegration.mergePullRequest},
 * mirroring GitHub's `mergeReadyPullRequest` and Bitbucket's equivalent: re-read
 * the merge request's current state on every call, so a durable retry re-evaluates
 * eligibility from scratch rather than merging stale approval context.
 *
 * GitLab's endpoint *does* take an expected head (`sha`), so — unlike Bitbucket,
 * where this re-read is the whole protection — these checks are defence in depth
 * rather than the only line. They still earn their place: they turn refusals GitLab
 * would answer with one undifferentiated 405 into the specific terminal outcomes
 * the merge dispatch needs, and they distinguish "the approval no longer holds"
 * (never retry) from "not ready yet" (retry).
 *
 * Two reads of the same merge request (state, then standing approvals) rather than
 * one: they are the phase-3 reads the adapter already exposes, and a merge attempt
 * is not a hot path.
 */
async function mergeReadyGitLabMergeRequest(
	repo: string,
	iid: number,
	approvedHeadSha: string,
): Promise<MergePullRequestOutcome> {
	let state: Awaited<ReturnType<typeof getGitLabMergeRequestMergeState>>;
	try {
		state = await getGitLabMergeRequestMergeState(repo, iid);
	} catch (error) {
		return { status: 'provider-error', message: errorMessage(error) };
	}
	if (state.merged) return { status: 'merged', message: 'merge request already merged' };
	// The approval this attempt was requested for covers one exact commit. A push
	// since then (including a rebase that keeps the same diff) means nobody has
	// reviewed the merge request's *current* head, so merging would silently ship
	// unreviewed content — that needs a fresh review, not a retry. GitLab reports
	// full 40-character SHAs everywhere, so this is an exact comparison and needs no
	// prefix tolerance of the kind Bitbucket's abbreviated spelling forces.
	if (state.headSha !== approvedHeadSha)
		return {
			status: 'not-eligible',
			message: `merge request head changed since the reviewed commit (reviewed ${approvedHeadSha}, now ${state.headSha}); a fresh review is required before merge automation can proceed`,
		};
	if (state.draft)
		return {
			status: 'not-eligible',
			message: 'merge request was converted back to a draft after the review was approved',
		};
	if (state.state !== 'open')
		return { status: 'not-eligible', message: `merge request is ${state.state}` };
	// A reviewer's standing "request changes" is a decision, not a readiness
	// condition, so it is terminal here rather than the `not-ready` GitLab's own 405
	// would produce (see `GitLabMergeRequestMergeState.changesRequested`).
	if (state.changesRequested)
		return {
			status: 'not-eligible',
			message: 'the approving review is no longer in effect — changes have since been requested',
		};

	// The head is unchanged, but the approvals standing on it may no longer be.
	// GitLab records a *standing* approval rather than a review history, so
	// "dismissed" simply means the approval is no longer listed — there is no
	// GitHub-style `REVIEW_REQUIRED` propagation window to tolerate.
	let approvals: Awaited<ReturnType<typeof getGitLabMergeRequestApprovals>>;
	try {
		approvals = await getGitLabMergeRequestApprovals(repo, iid);
	} catch (error) {
		return { status: 'provider-error', message: errorMessage(error) };
	}
	if (!approvals.some((approval) => approval.commitId === approvedHeadSha))
		return {
			status: 'not-eligible',
			message: 'the approving review is no longer in effect — it has since been dismissed',
		};

	// The approval holds and the merge request is otherwise ready — but its
	// pipeline ran against a target branch that has since moved, so nothing has
	// verified the tree this merge would produce (issue #874). Last, after every
	// eligibility check above, for GitHub's reason: an approval that no longer
	// holds must report that rather than be brought up to date for nothing. A
	// `null` count is "GitLab did not say", which merges exactly as before.
	if (state.behindBase === true)
		return {
			status: 'stale-base',
			message: `merge request head ${state.headSha} is behind its target branch, so its pipeline did not build the tree this merge would produce`,
		};

	try {
		const merge = await mergeGitLabMergeRequestDirect(repo, iid, approvedHeadSha);
		return merge.merged
			? { status: 'merged', message: merge.message, sha: merge.sha }
			: { status: 'not-ready', message: merge.message };
	} catch (error) {
		return classifyGitLabDirectMergeError(error);
	}
}

export class GitLabSCMIntegration implements SCMProvider {
	readonly type = 'gitlab' as const;
	readonly category = 'scm' as const;

	/**
	 * Whether GitLab is usable for a project at all — true when at least one
	 * persona token resolves. Deliberately an OR, not an AND: some flows need only
	 * one of the personas (same rationale as the GitHub and Bitbucket classes).
	 */
	async hasIntegration(project: ProjectConfig): Promise<boolean> {
		const [implementer, reviewer] = await Promise.all([
			getGitLabTokenOrNull(project, 'implementer'),
			getGitLabTokenOrNull(project, 'reviewer'),
		]);
		return implementer !== null || reviewer !== null;
	}

	/** Whether a specific persona's token is configured for a project. */
	async hasPersonaToken(project: ProjectConfig, persona: ScmPersona): Promise<boolean> {
		return (await getGitLabTokenOrNull(project, persona)) !== null;
	}

	/**
	 * Resolve `persona`'s token for `project` and run `fn` within that token
	 * scope. Every GitLab request inside `fn` — via `getScopedToken()` —
	 * authenticates as that persona. Throws before running `fn` when the token
	 * isn't configured.
	 */
	async withPersonaCredentials<T>(
		project: ProjectConfig,
		persona: ScmPersona,
		fn: () => Promise<T>,
	): Promise<T> {
		const token = await getGitLabToken(project, persona);
		return withGitLabToken(token, fn);
	}

	/** {@link SCMProvider.resolvePersonaIdentities} — per-project TTL cache in `./personas.ts`. */
	async resolvePersonaIdentities(project: ProjectConfig): Promise<ScmPersonaIdentities> {
		return resolveGitLabPersonaIdentities(project);
	}

	/** {@link SCMProvider.personaForActor} — GitLab's case-insensitive username match. */
	personaForActor(login: string, identities: ScmPersonaIdentities): ScmPersona | null {
		return getGitLabPersonaForLogin(login, identities);
	}

	/** {@link SCMProvider.isSwarmActor} — matches either configured persona identity. */
	isSwarmActor(login: string, identities: ScmPersonaIdentities): boolean {
		return isSwarmGitLabActor(login, identities);
	}

	// ==========================================================================
	// Webhook ingress — phase 2/4
	// ==========================================================================

	/**
	 * {@link SCMProvider.verifyWebhookSignature} — a timing-safe comparison of the
	 * `X-Gitlab-Token` value against the project's secret, *not* an HMAC over the
	 * body: that is the mechanism GitLab itself provides. `./webhook.ts` records the
	 * GitLab 19.0 signing-token upgrade as a follow-up and why it needs the contract
	 * widened first.
	 */
	verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
		return verifyGitLabWebhookToken(rawBody, signature, secret);
	}

	/** {@link SCMProvider.readWebhookRequest} — GitLab's event / event-UUID / token headers. */
	readWebhookRequest(header: WebhookHeaderReader): ScmWebhookRequest {
		return readGitLabWebhookRequest(header);
	}

	/** {@link SCMProvider.parseWebhookEvent} — merge-request, note and pipeline hooks; `null` otherwise. */
	parseWebhookEvent(eventName: string, payload: unknown): ScmEvent | null {
		return parseGitLabWebhook(eventName, payload);
	}

	/** {@link SCMProvider.isSwarmGeneratedEvent} — the comment-scoped loop-prevention gate. */
	async isSwarmGeneratedEvent(event: ScmEvent, project: ProjectConfig): Promise<boolean> {
		return isSwarmGeneratedGitLabEvent(event, project);
	}

	// ==========================================================================
	// Merge-request reads — phase 3/4, in `./merge-requests.ts`
	// ==========================================================================

	/**
	 * {@link SCMProvider.getPullRequest}. `prNumber` is GitLab's `iid`, as the
	 * contract's doc allows. Reads under the **reviewer** persona by default, the
	 * persona GitHub's and Bitbucket's adapters read one as on the review path.
	 * Unlike Bitbucket, `mergeable` carries GitLab's real tri-state.
	 */
	async getPullRequest(
		project: ProjectConfig,
		prNumber: number,
		persona: ScmPersona = 'reviewer',
	): Promise<PullRequestDetails> {
		return this.withPersonaCredentials(project, persona, () =>
			getGitLabMergeRequest(project.repo, prNumber),
		);
	}

	/**
	 * {@link SCMProvider.getPullRequestTitle}. Defaults to the **implementer** — the
	 * merge request's author, whose credential is always configured for a project that
	 * opens them — matching the other two adapters' default for the same read.
	 */
	async getPullRequestTitle(
		project: ProjectConfig,
		prNumber: number,
		persona: ScmPersona = 'implementer',
	): Promise<string | null> {
		return this.withPersonaCredentials(project, persona, () =>
			getGitLabMergeRequestTitle(project.repo, prNumber),
		);
	}

	/**
	 * {@link SCMProvider.pullRequestUrl} — GitLab's `/-/merge_requests/<iid>` web
	 * path, not GitHub's `/pull/<n>`. Shares {@link gitLabMergeRequestUrl} with the
	 * merge-request reference derivation so there is one spelling of the grammar.
	 */
	pullRequestUrl(repo: string, prNumber: number | string): string {
		return gitLabMergeRequestUrl(repo, prNumber);
	}

	/**
	 * {@link SCMProvider.getBranchHead} — the branch's current head commit, from
	 * GitLab's repository-branches read. Defaults to the **implementer** persona
	 * for the reason GitHub's adapter states: it is a repository-level read, and
	 * its caller today is a router sweep holding only the operator's own
	 * credential.
	 */
	async getBranchHead(
		project: ProjectConfig,
		branch: string,
		persona: ScmPersona = 'implementer',
	): Promise<string | null> {
		return this.withPersonaCredentials(project, persona, () =>
			getGitLabBranchHead(project.repo, branch),
		);
	}

	/**
	 * {@link SCMProvider.getAggregateCheckStatus} — every commit status on `ref`,
	 * aggregated. Reads under the **reviewer** persona by default, the same scope the
	 * other two adapters use for the review handler's aggregate query.
	 */
	async getAggregateCheckStatus(
		project: ProjectConfig,
		ref: string,
		persona: ScmPersona = 'reviewer',
	): Promise<AggregateCheckStatus> {
		return this.withPersonaCredentials(project, persona, () =>
			getGitLabCommitStatuses(project.repo, ref),
		);
	}

	/**
	 * {@link SCMProvider.listPullRequestsForCommit} — the read a **branch** pipeline's
	 * `checks` event depends on, since GitLab includes `merge_request` only when the
	 * pipeline ran *for* one (issue #618). Reads under the **reviewer** persona by
	 * default, the same scope {@link GitLabSCMIntegration.getAggregateCheckStatus}
	 * uses for the query that follows it on the review path.
	 *
	 * GitLab's four-state vocabulary collapses to the contract's `open`/`closed`
	 * pair here, so a `merged`, `closed`, or `locked` merge request never reads as
	 * open.
	 */
	async listPullRequestsForCommit(
		project: ProjectConfig,
		sha: string,
		persona: ScmPersona = 'reviewer',
	): Promise<CommitPullRequest[]> {
		const mergeRequests = await this.withPersonaCredentials(project, persona, () =>
			listGitLabMergeRequestsForCommit(project.repo, sha),
		);
		return mergeRequests.map((mergeRequest) => ({
			number: mergeRequest.number,
			headBranch: mergeRequest.headBranch,
			state: mergeRequest.state === 'opened' ? ('open' as const) : ('closed' as const),
		}));
	}

	/**
	 * {@link SCMProvider.listConflictCandidates} — open same-project merge requests
	 * targeting `baseBranch`, read as the **implementer** (the persona that would push
	 * the resolution), same as GitHub's and Bitbucket's.
	 */
	async listConflictCandidates(
		project: ProjectConfig,
		baseBranch: string,
	): Promise<PullRequestDetails[]> {
		return this.withPersonaCredentials(project, 'implementer', () =>
			listOpenGitLabMergeRequestsForBase(project.repo, baseBranch),
		);
	}

	// ==========================================================================
	// Writes: notes, delivery, merge — phase 4/4, in `./writes.ts`
	// ==========================================================================

	/**
	 * {@link SCMProvider.commentOnPullRequest} — a note on the merge request as
	 * `persona`, returning the new note's id. The PR-driven phases normally comment
	 * from *inside* the agent run; this is the out-of-band path for the worker's
	 * stalled-job safety net, where the run was reclaimed before it could comment
	 * itself. Defaults to the **implementer** (the merge request's author, whose token
	 * is always configured for a project that opens them) for the same reason GitHub's
	 * and Bitbucket's do: a comment triggers no pipeline phase, so the persona choice
	 * is immaterial to loop prevention.
	 */
	async commentOnPullRequest(
		project: ProjectConfig,
		prNumber: number,
		body: string,
		persona: ScmPersona = 'implementer',
	): Promise<number> {
		return this.withPersonaCredentials(project, persona, () =>
			postGitLabMergeRequestNote(project.repo, prNumber, body),
		);
	}

	/**
	 * {@link ScmMergeProvider.mergePullRequest} for GitLab: merge an approved, ready
	 * merge request as the **implementer** through GitLab's direct merge endpoint,
	 * pinned to `approvedHeadSha`. Idempotent — a merge request found already merged
	 * reports `merged` without attempting anything — and re-reads current state on
	 * every call, so a durable retry re-checks eligibility rather than trusting stale
	 * approval context ({@link mergeReadyGitLabMergeRequest}). Never throws: every
	 * refusal or unexpected failure comes back as a terminal, non-`merged`
	 * {@link MergePullRequestOutcome}, so a completed, already-submitted Review can't
	 * be retroactively failed by this call.
	 */
	async mergePullRequest(
		project: ProjectConfig,
		prNumber: number,
		approvedHeadSha: string,
	): Promise<MergePullRequestOutcome> {
		try {
			return await this.withPersonaCredentials(project, 'implementer', () =>
				mergeReadyGitLabMergeRequest(project.repo, prNumber, approvedHeadSha),
			);
		} catch (error) {
			// Token resolution runs *outside* the recheck's own try/catch, so an
			// unconfigured implementer token would otherwise be the one way this
			// capability throws.
			return { status: 'provider-error', message: errorMessage(error) };
		}
	}

	/**
	 * {@link ScmMergeProvider.updatePullRequestBranch} for GitLab — a **declared**
	 * `unsupported`, not a gap (issue #874).
	 *
	 * GitLab has no equivalent of GitHub's update-branch endpoint. What it offers
	 * is `PUT .../rebase`, and a rebase is the wrong operation for this contract in
	 * two ways: it rewrites every commit on the source branch, so the head SWARM
	 * carries an approval onto would no longer contain the commit that was
	 * reviewed, and it takes no expected-head parameter, so nothing would stop it
	 * rewriting a head somebody else had just pushed. Answering `unsupported`
	 * makes the merge dispatch refuse a stale head visibly instead — the safe half
	 * of the guarantee — and leaves adopting rebase (with its own review
	 * implications) to a GitLab-specific decision rather than smuggling it in
	 * behind a provider-neutral method name.
	 */
	async updatePullRequestBranch(
		project: ProjectConfig,
		prNumber: number,
		_expectedHeadSha: string,
	): Promise<UpdatePullRequestBranchOutcome> {
		return {
			status: 'unsupported',
			message: `GitLab exposes no way to merge the target branch into merge request !${prNumber} of ${project.repo} while preserving its reviewed commits, so its head cannot be brought up to date automatically`,
		};
	}

	/**
	 * {@link SCMProvider.deliveryProvider} — the same-host, per-persona delivery seam.
	 * The persona's token is resolved once and bound to every operation, so a rotation
	 * mid-delivery can't leave one write authenticating as somebody else.
	 *
	 * `commitIdentity` comes from a single `GET /user`, where Bitbucket needs a second
	 * call for the address. A token whose scope doesn't expose an email — and a
	 * project/group access token's bot user, which has none — falls back to
	 * `<username>@users.noreply.gitlab.com` so delivery still commits. The cost is the
	 * same as Bitbucket's: GitLab links a commit to an account by matching a
	 * **verified** account email, so that placeholder keeps the right name but leaves
	 * the commit unlinked. Use a token whose scope exposes the email for attributed
	 * commits.
	 *
	 * `submitReview` resolves the head to pin the approval to by reading the merge
	 * request first. The contract's `submitReview` input carries no reviewed head
	 * (`ScmDeliveryProvider`, `src/scm/delivery.ts`), so this pins the approval to a
	 * commit the delivery itself observed one request earlier — enough that a push
	 * landing in that window fails the approve instead of silently approving a
	 * different commit. Pinning to the head the *Review phase* actually read would
	 * need that input widened for all three providers, which is a follow-up.
	 */
	async deliveryProvider(
		project: ProjectConfig,
		persona: ScmPersona,
	): Promise<ScmDeliveryProvider> {
		const repo = project.repo;
		const token = await getGitLabToken(project, persona);
		const scoped = <T>(fn: () => Promise<T>): Promise<T> => withGitLabToken(token, fn);
		const user = await scoped(getScopedGitLabUser);
		if (!user.username) throw new Error(`Could not resolve GitLab identity for ${persona} persona`);
		const email = user.email ?? `${user.username}@users.noreply.gitlab.com`;
		return {
			commitIdentity: { name: user.username, email },
			findPullRequest: (branch) => scoped(() => findOpenGitLabMergeRequest(repo, branch)),
			createPullRequest: (input) => scoped(() => createGitLabMergeRequest(repo, input)),
			pushBranch: async (cwd, branch, expectedSha) => {
				// The token travels in a git config value, never in argv — an `extraheader`
				// keeps it out of the process listing and any git error echoing the remote.
				// The refspec pushes the *exact* commit the caller verified rather than
				// whatever HEAD happens to be, which is what makes a resumed delivery safe.
				const authorization = Buffer.from(gitlabGitBasicCredential(token)).toString('base64');
				await promisify(execFile)(
					'git',
					[
						'push',
						'--no-verify',
						`${GITLAB_GIT_ORIGIN}${repo}.git`,
						`${expectedSha}:refs/heads/${branch}`,
					],
					{
						cwd,
						env: {
							...process.env,
							GIT_CONFIG_COUNT: '1',
							GIT_CONFIG_KEY_0: `http.${GITLAB_GIT_ORIGIN}.extraheader`,
							GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
						},
					},
				);
			},
			submitReview: (input) =>
				scoped(async () =>
					submitGitLabReview(repo, {
						iid: input.prNumber,
						verdict: input.verdict,
						body: input.body,
						deliveryId: input.deliveryId,
						headSha: (await getGitLabMergeRequestMergeState(repo, input.prNumber)).headSha,
					}),
				),
			postComment: (input) =>
				scoped(() =>
					postIdempotentGitLabMergeRequestNote(repo, {
						iid: input.prNumber,
						body: input.body,
						deliveryId: input.deliveryId,
					}),
				),
		};
	}

	/**
	 * {@link SCMProvider.operatorDeliveryProvider} — operator-credential delivery for
	 * DB-free workers. The worker supplies its own token, so no project secret-store
	 * lookup is involved.
	 */
	async operatorDeliveryProvider(repo: string, credential: string): Promise<ScmDeliveryProvider> {
		return createGitLabOperatorDeliveryProvider(repo, credential);
	}
}
