/**
 * BitbucketSCMIntegration — Bitbucket Cloud's implementation of the
 * provider-neutral {@link SCMProvider} contract (`src/scm/types.ts`), built out
 * over four phases (issue #296) and now complete: availability probing, persona
 * credential scoping, and persona identity / actor resolution (phase 1/4);
 * webhook signature verification, header reading, event normalization, and the
 * comment loop-prevention gate (phase 2/4, delegated to `./webhook.ts`); the
 * pull-request / build-status reads (phase 3/4, delegated to
 * `./pull-requests.ts`); and comments, the delivery seam, and the direct merge
 * (phase 4/4, delegated to `./writes.ts` / `./operator-delivery.ts`). No contract
 * method is stubbed — the multi-provider conformance suite
 * (`tests/unit/integrations/scm/scm-conformance.test.ts`) asserts that.
 *
 * Its core job is the same as the GitHub class's: run a block of Bitbucket
 * operations under the correct persona's credential. Callers hand it a project +
 * persona and a function; it resolves that persona's credential and binds it to
 * the async context (`withBitbucketCredential`) for the duration of the call.
 * Because resolution happens per invocation, one pipeline can review as the
 * reviewer and push as the implementer without either credential appearing in a
 * signature (ai/CODING_STANDARDS.md "Scope credentials with AsyncLocalStorage").
 *
 * **Reachable since issue #618.** The manifest declares `runtimeReady: true`
 * (`./index.ts`), so the receiver serves `/bitbucket/webhook` and a project setting
 * `"scm": "bitbucket"` resolves here. One ingress detail is this provider's alone:
 * a `commit_status` payload names no pull request, so the receiver completes a
 * `checks` event through {@link BitbucketSCMIntegration.listPullRequestsForCommit}
 * — the contract method that closes that seam neutrally rather than making shared
 * code call a Bitbucket-specific lookup (ai/RULES.md §2).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectConfig } from '../../../config/schema.js';
import type { ScmDeliveryProvider } from '../../../scm/delivery.js';
import type { ScmEvent } from '../../../scm/events.js';
import type { MergePullRequestOutcome } from '../../../scm/merge.js';
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
	bitbucketGitBasicCredential,
	getBitbucketUserForCredential,
	getScopedBitbucketUserEmail,
	withBitbucketCredential,
} from './client.js';
import { sameBitbucketCommit } from './commits.js';
import { getBitbucketCredential, getBitbucketCredentialOrNull } from './credentials.js';
import { createBitbucketOperatorDeliveryProvider } from './operator-delivery.js';
import {
	getBitbucketPersonaForLogin,
	isSwarmBitbucketActor,
	resolveBitbucketPersonaIdentities,
} from './personas.js';
import {
	bitbucketPullRequestUrl,
	findOpenBitbucketPullRequest,
	getBitbucketCommitBuildStatus,
	getBitbucketPullRequest,
	getBitbucketPullRequestApprovals,
	getBitbucketPullRequestMergeState,
	getBitbucketPullRequestTitle,
	listBitbucketPullRequestsForCommit,
	listOpenBitbucketPullRequestsForBase,
} from './pull-requests.js';
import {
	isSwarmGeneratedBitbucketEvent,
	parseBitbucketWebhook,
	readBitbucketWebhookRequest,
	verifyBitbucketSignature,
} from './webhook.js';
import {
	createBitbucketPullRequest,
	mergeBitbucketPullRequestDirect,
	postBitbucketPullRequestComment,
	postIdempotentBitbucketPullRequestComment,
	submitBitbucketReview,
} from './writes.js';

/**
 * Bitbucket's `workspace` / `repo_slug` pair, which a project's `owner/repo`
 * doubles as — see `./credentials.ts` for why that let the provider land without
 * a config-schema field.
 */
function repoCoordinates(project: ProjectConfig): [workspace: string, slug: string] {
	const [workspace, slug] = project.repo.split('/');
	return [workspace, slug];
}

/** Bitbucket's git-over-HTTPS host — the push remote and the `extraheader` scope. */
const BITBUCKET_GIT_ORIGIN = 'https://bitbucket.org/';

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `BitbucketApiError#status`, if `error` carries one (it mirrors Octokit's field name). */
function errorStatus(error: unknown): number | undefined {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === 'number' ? status : undefined;
}

/**
 * Classify a thrown Bitbucket error from the direct-merge endpoint into the
 * provider-neutral outcome — the Bitbucket twin of GitHub's
 * `classifyDirectMergeError`.
 *
 * 409 is Bitbucket's merge conflict and **555** its own non-standard "the merge took
 * too long, it may still complete" status; both are transient, so `not-ready` and
 * the merge dispatch retries. 403 means the repository's branch restrictions refuse
 * the merge for this account outright — `policy-blocked`. Bitbucket also refuses with
 * a 400 when a **merge check** (approvals, resolved tasks, passing builds) is
 * unsatisfied, naming it in the error body; that is a policy the merge dispatch
 * cannot retry its way past either, so it is `policy-blocked` too. Anything else
 * (401, 404, other 5xx, a network failure) is an unexpected `provider-error`.
 *
 * Nothing maps to `unsupported`: that status is for a repository configuration the
 * adapter has no way to satisfy, and Bitbucket Cloud has no merge-queue analogue —
 * the case GitHub's classifier reserves it for.
 */
function classifyBitbucketDirectMergeError(error: unknown): MergePullRequestOutcome {
	const message = errorMessage(error);
	const status = errorStatus(error);
	if (status === 409 || status === 555) return { status: 'not-ready', message };
	if (status === 403) return { status: 'policy-blocked', message };
	if (/merge check/i.test(message)) return { status: 'policy-blocked', message };
	return { status: 'provider-error', message };
}

/**
 * The credential-scoped body of {@link BitbucketSCMIntegration.mergePullRequest},
 * mirroring GitHub's `mergeReadyPullRequest`: re-read the pull request's current
 * state on every call, so a durable retry re-evaluates eligibility from scratch
 * rather than merging stale approval context.
 *
 * The re-read carries more weight here than on GitHub, because Bitbucket's merge
 * endpoint takes **no expected-head parameter** — GitHub pins its merge to the
 * approved SHA and gets a stale-head refusal for free. These checks are the whole of
 * Bitbucket's protection against merging a commit nobody reviewed.
 *
 * Two reads of the same pull request (state, then participant verdicts) rather than
 * one: they are the phase-3 reads the adapter already exposes, and a merge attempt is
 * not a hot path.
 */
async function mergeReadyBitbucketPullRequest(
	workspace: string,
	slug: string,
	prNumber: number,
	approvedHeadSha: string,
): Promise<MergePullRequestOutcome> {
	let state: Awaited<ReturnType<typeof getBitbucketPullRequestMergeState>>;
	try {
		state = await getBitbucketPullRequestMergeState(workspace, slug, prNumber);
	} catch (error) {
		return { status: 'provider-error', message: errorMessage(error) };
	}
	if (state.merged) return { status: 'merged', message: 'pull request already merged' };
	// The approval this attempt was requested for covers one exact commit. A push
	// since then (including a rebase that keeps the same diff) means nobody has
	// reviewed the pull request's *current* head, so merging would silently ship
	// unreviewed content — that needs a fresh review, not a retry.
	if (!sameBitbucketCommit(state.headSha, approvedHeadSha))
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

	// The head is unchanged, but the verdicts on it may no longer be. Bitbucket
	// records a *standing* participant state rather than a review history, so
	// "dismissed" simply means the approval is no longer in the list — there is no
	// GitHub-style `REVIEW_REQUIRED` propagation window to tolerate.
	let approvals: Awaited<ReturnType<typeof getBitbucketPullRequestApprovals>>;
	try {
		approvals = await getBitbucketPullRequestApprovals(workspace, slug, prNumber);
	} catch (error) {
		return { status: 'provider-error', message: errorMessage(error) };
	}
	if (approvals.some((approval) => approval.state === 'CHANGES_REQUESTED'))
		return {
			status: 'not-eligible',
			message: 'the approving review is no longer in effect — changes have since been requested',
		};
	if (
		!approvals.some(
			(approval) =>
				approval.state === 'APPROVED' && sameBitbucketCommit(approval.commitId, approvedHeadSha),
		)
	)
		return {
			status: 'not-eligible',
			message: 'the approving review is no longer in effect — it has since been dismissed',
		};

	try {
		const merge = await mergeBitbucketPullRequestDirect(
			workspace,
			slug,
			prNumber,
			`Merge pull request #${prNumber}`,
		);
		return merge.merged
			? { status: 'merged', message: merge.message, sha: merge.sha }
			: { status: 'not-ready', message: merge.message };
	} catch (error) {
		return classifyBitbucketDirectMergeError(error);
	}
}

export class BitbucketSCMIntegration implements SCMProvider {
	readonly type = 'bitbucket' as const;
	readonly category = 'scm' as const;

	/**
	 * Whether Bitbucket is usable for a project at all — true when at least one
	 * persona credential resolves. Deliberately an OR, not an AND: some flows need
	 * only one of the personas (same rationale as the GitHub class).
	 */
	async hasIntegration(project: ProjectConfig): Promise<boolean> {
		const [implementer, reviewer] = await Promise.all([
			getBitbucketCredentialOrNull(project, 'implementer'),
			getBitbucketCredentialOrNull(project, 'reviewer'),
		]);
		return implementer !== null || reviewer !== null;
	}

	/** Whether a specific persona's credential is configured for a project. */
	async hasPersonaToken(project: ProjectConfig, persona: ScmPersona): Promise<boolean> {
		return (await getBitbucketCredentialOrNull(project, persona)) !== null;
	}

	/**
	 * Resolve `persona`'s credential for `project` and run `fn` within that
	 * credential scope. Every Bitbucket request inside `fn` — via
	 * `getScopedCredential()` — authenticates as that persona. Throws before
	 * running `fn` when the credential isn't configured.
	 */
	async withPersonaCredentials<T>(
		project: ProjectConfig,
		persona: ScmPersona,
		fn: () => Promise<T>,
	): Promise<T> {
		const credential = await getBitbucketCredential(project, persona);
		return withBitbucketCredential(credential, fn);
	}

	/** {@link SCMProvider.resolvePersonaIdentities} — per-project TTL cache in `./personas.ts`. */
	async resolvePersonaIdentities(project: ProjectConfig): Promise<ScmPersonaIdentities> {
		return resolveBitbucketPersonaIdentities(project);
	}

	/** {@link SCMProvider.personaForActor} — Bitbucket's case-insensitive login match. */
	personaForActor(login: string, identities: ScmPersonaIdentities): ScmPersona | null {
		return getBitbucketPersonaForLogin(login, identities);
	}

	/** {@link SCMProvider.isSwarmActor} — matches either configured persona identity. */
	isSwarmActor(login: string, identities: ScmPersonaIdentities): boolean {
		return isSwarmBitbucketActor(login, identities);
	}

	// ==========================================================================
	// Webhook ingress — phase 2/4, in `./webhook.ts`
	// ==========================================================================

	/** {@link SCMProvider.verifyWebhookSignature} — `X-Hub-Signature`'s `sha256=<hex>` framing. */
	verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
		return verifyBitbucketSignature(rawBody, signature, secret);
	}

	/** {@link SCMProvider.readWebhookRequest} — Bitbucket's event-key/request-uuid/signature headers. */
	readWebhookRequest(header: WebhookHeaderReader): ScmWebhookRequest {
		return readBitbucketWebhookRequest(header);
	}

	/** {@link SCMProvider.parseWebhookEvent} — `X-Event-Key` → the neutral {@link ScmEvent}. */
	parseWebhookEvent(eventName: string, payload: unknown): ScmEvent | null {
		return parseBitbucketWebhook(eventName, payload);
	}

	/** {@link SCMProvider.isSwarmGeneratedEvent} — comment-scoped SWARM-origin gate. */
	async isSwarmGeneratedEvent(event: ScmEvent, project: ProjectConfig): Promise<boolean> {
		return isSwarmGeneratedBitbucketEvent(event, project);
	}

	// ==========================================================================
	// Pull-request reads — phase 3/4, in `./pull-requests.ts`
	// ==========================================================================

	/**
	 * {@link SCMProvider.getPullRequest}. Reads under the **reviewer** persona by
	 * default, the persona GitHub's adapter reads a PR as on the review path.
	 * `mergeable` always comes back `null` — Bitbucket Cloud exposes no
	 * mergeability flag (see `./pull-requests.ts`).
	 */
	async getPullRequest(
		project: ProjectConfig,
		prNumber: number,
		persona: ScmPersona = 'reviewer',
	): Promise<PullRequestDetails> {
		const [workspace, slug] = repoCoordinates(project);
		return this.withPersonaCredentials(project, persona, () =>
			getBitbucketPullRequest(workspace, slug, prNumber),
		);
	}

	/**
	 * {@link SCMProvider.getPullRequestTitle}. Defaults to the **implementer** — the
	 * PR's author, whose credential is always configured for a project that opens
	 * PRs — matching GitHub's default for the same read.
	 */
	async getPullRequestTitle(
		project: ProjectConfig,
		prNumber: number,
		persona: ScmPersona = 'implementer',
	): Promise<string | null> {
		const [workspace, slug] = repoCoordinates(project);
		return this.withPersonaCredentials(project, persona, () =>
			getBitbucketPullRequestTitle(workspace, slug, prNumber),
		);
	}

	/**
	 * {@link SCMProvider.pullRequestUrl} — Bitbucket's `/pull-requests/<id>` web
	 * path, not GitHub's `/pull/<n>`. Shares {@link bitbucketPullRequestUrl} with
	 * the pull-request reference derivation so there is one spelling of the grammar.
	 */
	pullRequestUrl(repo: string, prNumber: number | string): string {
		return bitbucketPullRequestUrl(repo, prNumber);
	}

	/**
	 * {@link SCMProvider.getAggregateCheckStatus} — every build status on `ref`,
	 * aggregated. Reads under the **reviewer** persona by default, the same scope
	 * GitHub's adapter uses for the review handler's aggregate query.
	 */
	async getAggregateCheckStatus(
		project: ProjectConfig,
		ref: string,
		persona: ScmPersona = 'reviewer',
	): Promise<AggregateCheckStatus> {
		const [workspace, slug] = repoCoordinates(project);
		return this.withPersonaCredentials(project, persona, () =>
			getBitbucketCommitBuildStatus(workspace, slug, ref),
		);
	}

	/**
	 * {@link SCMProvider.listPullRequestsForCommit} — the read a Bitbucket `checks`
	 * event depends on, since a `commit_status` payload carries no pull-request
	 * association at all (issue #618). Reads under the **reviewer** persona by
	 * default, the same scope {@link BitbucketSCMIntegration.getAggregateCheckStatus}
	 * uses for the query that follows it on the review path.
	 *
	 * Bitbucket's four-state vocabulary collapses to the contract's `open`/`closed`
	 * pair here — the same mapping `getBitbucketPullRequestMergeState` applies, so a
	 * `MERGED`, `DECLINED`, or `SUPERSEDED` pull request never reads as open.
	 */
	async listPullRequestsForCommit(
		project: ProjectConfig,
		sha: string,
		persona: ScmPersona = 'reviewer',
	): Promise<CommitPullRequest[]> {
		const [workspace, slug] = repoCoordinates(project);
		const pulls = await this.withPersonaCredentials(project, persona, () =>
			listBitbucketPullRequestsForCommit(workspace, slug, sha),
		);
		return pulls.map((pull) => ({
			number: pull.number,
			headBranch: pull.headBranch,
			state: pull.state === 'OPEN' ? ('open' as const) : ('closed' as const),
		}));
	}

	/**
	 * {@link SCMProvider.listConflictCandidates} — open same-repository PRs
	 * targeting `baseBranch`, read as the **implementer** (the persona that would
	 * push the resolution), same as GitHub's.
	 */
	async listConflictCandidates(
		project: ProjectConfig,
		baseBranch: string,
	): Promise<PullRequestDetails[]> {
		const [workspace, slug] = repoCoordinates(project);
		return this.withPersonaCredentials(project, 'implementer', () =>
			listOpenBitbucketPullRequestsForBase(workspace, slug, baseBranch),
		);
	}

	// ==========================================================================
	// Writes: comments, delivery, merge — phase 4/4, in `./writes.ts`
	// ==========================================================================

	/**
	 * {@link SCMProvider.commentOnPullRequest} — a top-level comment as `persona`,
	 * returning the new comment's id. The PR-driven phases normally comment from
	 * *inside* the agent run; this is the out-of-band path for the worker's
	 * stalled-job safety net, where the run was reclaimed before it could comment
	 * itself. Defaults to the **implementer** (the PR's author, whose credential is
	 * always configured for a project that opens PRs) for the same reason GitHub's
	 * does: a comment triggers no pipeline phase, so the persona choice is immaterial
	 * to loop prevention.
	 */
	async commentOnPullRequest(
		project: ProjectConfig,
		prNumber: number,
		body: string,
		persona: ScmPersona = 'implementer',
	): Promise<number> {
		const [workspace, slug] = repoCoordinates(project);
		return this.withPersonaCredentials(project, persona, () =>
			postBitbucketPullRequestComment(workspace, slug, prNumber, body),
		);
	}

	/**
	 * {@link ScmMergeProvider.mergePullRequest} for Bitbucket: merge an approved,
	 * ready pull request as the **implementer** through Bitbucket's direct merge
	 * endpoint. Idempotent — a pull request found already merged reports `merged`
	 * without attempting anything — and re-reads current state on every call, so a
	 * durable retry re-checks eligibility rather than trusting stale approval context
	 * ({@link mergeReadyBitbucketPullRequest}). Never throws: every refusal or
	 * unexpected failure comes back as a terminal, non-`merged`
	 * {@link MergePullRequestOutcome}, so a completed, already-submitted Review can't
	 * be retroactively failed by this call.
	 */
	async mergePullRequest(
		project: ProjectConfig,
		prNumber: number,
		approvedHeadSha: string,
	): Promise<MergePullRequestOutcome> {
		const [workspace, slug] = repoCoordinates(project);
		try {
			return await this.withPersonaCredentials(project, 'implementer', () =>
				mergeReadyBitbucketPullRequest(workspace, slug, prNumber, approvedHeadSha),
			);
		} catch (error) {
			// Credential resolution runs *outside* the recheck's own try/catch, so an
			// unconfigured implementer credential would otherwise be the one way this
			// capability throws.
			return { status: 'provider-error', message: errorMessage(error) };
		}
	}

	/**
	 * {@link SCMProvider.deliveryProvider} — the same-host, per-persona delivery seam.
	 * The persona's credential is resolved once and bound to every operation, so a
	 * rotation mid-delivery can't leave one write authenticating as somebody else.
	 *
	 * `commitIdentity` is where Bitbucket differs from GitHub. The name is the
	 * account's `nickname` (Bitbucket exposes no `username`). Delivery requires an
	 * app password: workspace/repository access tokens cannot resolve `GET /2.0/user`
	 * and fail before the email lookup. An app password without the `email` scope
	 * falls back to `<nickname>@users.noreply.bitbucket.org` so delivery still
	 * commits. Bitbucket attributes a commit by matching a **confirmed** account
	 * email, so that placeholder keeps the name but leaves the commit unlinked. Grant
	 * the app password the `email` scope for attributed commits.
	 */
	async deliveryProvider(
		project: ProjectConfig,
		persona: ScmPersona,
	): Promise<ScmDeliveryProvider> {
		const [workspace, slug] = repoCoordinates(project);
		const credential = await getBitbucketCredential(project, persona);
		const nickname = await getBitbucketUserForCredential(credential);
		if (!nickname) throw new Error(`Could not resolve Bitbucket identity for ${persona} persona`);
		const scoped = <T>(fn: () => Promise<T>): Promise<T> => withBitbucketCredential(credential, fn);
		const email =
			(await scoped(getScopedBitbucketUserEmail)) ?? `${nickname}@users.noreply.bitbucket.org`;
		return {
			commitIdentity: { name: nickname, email },
			findPullRequest: (branch) =>
				scoped(() => findOpenBitbucketPullRequest(workspace, slug, branch)),
			createPullRequest: (input) =>
				scoped(() => createBitbucketPullRequest(workspace, slug, input)),
			pushBranch: async (cwd, branch, expectedSha) => {
				// The credential travels in a git config value, never in argv — an
				// `extraheader` keeps it out of the process listing and any git error
				// echoing the remote. The refspec pushes the *exact* commit the caller
				// verified rather than whatever HEAD happens to be, which is what makes a
				// resumed delivery safe.
				const authorization = Buffer.from(bitbucketGitBasicCredential(credential)).toString(
					'base64',
				);
				await promisify(execFile)(
					'git',
					[
						'push',
						'--no-verify',
						`${BITBUCKET_GIT_ORIGIN}${workspace}/${slug}.git`,
						`${expectedSha}:refs/heads/${branch}`,
					],
					{
						cwd,
						env: {
							...process.env,
							GIT_CONFIG_COUNT: '1',
							GIT_CONFIG_KEY_0: `http.${BITBUCKET_GIT_ORIGIN}.extraheader`,
							GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
						},
					},
				);
			},
			submitReview: (input) => scoped(() => submitBitbucketReview(workspace, slug, input)),
			postComment: (input) =>
				scoped(() => postIdempotentBitbucketPullRequestComment(workspace, slug, input)),
		};
	}

	/**
	 * {@link SCMProvider.operatorDeliveryProvider} — operator-credential delivery
	 * for DB-free workers. The worker supplies its own credential, so no project
	 * secret-store lookup is involved.
	 */
	async operatorDeliveryProvider(repo: string, credential: string): Promise<ScmDeliveryProvider> {
		return createBitbucketOperatorDeliveryProvider(repo, credential);
	}
}
