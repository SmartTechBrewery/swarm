/**
 * AzureDevOpsSCMIntegration — Azure DevOps Services' implementation of the
 * provider-neutral {@link SCMProvider} contract (`src/scm/types.ts`), built out over
 * six phases (issue #1089) along the same seams GitLab used, and now complete:
 * availability probing, persona credential scoping, and persona identity / actor
 * resolution (phase 2/6), webhook ingress (phase 3/6, `./webhook.ts`), the
 * pull-request and CI reads (phase 4/6, `./pull-requests.ts`), and comment threads,
 * review votes, the delivery seam, and pull-request completion (phase 5/6,
 * `./writes.ts` / `./operator-delivery.ts`). No contract method is stubbed — the
 * multi-provider conformance suite (`tests/unit/integrations/scm/scm-conformance.test.ts`)
 * asserts that for every registered manifest, which is why the manifest
 * (`./index.ts`) could only land with phase 5/6.
 *
 * Its core job is the same as the other providers' classes: run a block of Azure
 * DevOps operations under the correct persona's PAT. Callers hand it a project +
 * persona and a function; it resolves that persona's token and binds it to the async
 * context (`withAzureDevOpsToken`) for the duration of the call, so one pipeline can
 * review as the reviewer and push as the implementer without either token appearing
 * in a signature (ai/CODING_STANDARDS.md "Scope credentials with AsyncLocalStorage").
 *
 * **Implemented is still not reachable.** The manifest keeps `runtimeReady: false`
 * (`./index.ts`): no project routes here and no `/azure-devops/webhook` route is
 * served until phase 6/6 flips it.
 */

import { setTimeout as sleep } from 'node:timers/promises';
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
import { azureRepoCoordinates, withAzureDevOpsToken } from './client.js';
import { getAzureDevOpsToken, getAzureDevOpsTokenOrNull } from './credentials.js';
import {
	createAzureDevOpsDeliveryProvider,
	createAzureDevOpsOperatorDeliveryProvider,
} from './operator-delivery.js';
import {
	getAzureDevOpsPersonaForLogin,
	isSwarmAzureDevOpsActor,
	resolveAzureDevOpsPersonaIdentities,
} from './personas.js';
import {
	type AzureDevOpsPullRequestMergeState,
	getAzureDevOpsBranchHead,
	getAzureDevOpsCommitChecks,
	getAzureDevOpsPullRequest,
	getAzureDevOpsPullRequestMergeState,
	getAzureDevOpsPullRequestTitle,
	listActiveAzureDevOpsPullRequestsForBase,
	listAzureDevOpsPullRequestsForCommit,
} from './pull-requests.js';
import {
	isSwarmGeneratedAzureDevOpsEvent,
	parseAzureDevOpsWebhook,
	pullRequestWebUrl,
	readAzureDevOpsWebhookRequest,
	verifyAzureDevOpsWebhookAuth,
} from './webhook.js';
import { completeAzureDevOpsPullRequest, postAzureDevOpsPullRequestThread } from './writes.js';

/** The lowest vote that approves: `5` is "approved with suggestions", `10` "approved". */
const APPROVING_VOTE = 5;

/** The "rejected" vote — a standing veto, whoever cast it. */
const REJECTED_VOTE = -10;

/**
 * How many times, and how far apart, {@link mergeReadyAzureDevOpsPullRequest} reads
 * the pull request back after asking for its completion. Azure completes a pull
 * request in the background, so the PATCH's answer is not the outcome; the bound
 * keeps one merge attempt to roughly ten seconds, and a completion still running
 * after it is reported `not-ready`, which the durable merge dispatch retries — at
 * which point the recheck finds it `completed`.
 */
export const MERGE_COMPLETION_POLL = { attempts: 5, intervalMs: 2_000 } as const;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `AzureDevOpsApiError#status`, if `error` carries one (it mirrors Octokit's field name). */
function errorStatus(error: unknown): number | undefined {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === 'number' ? status : undefined;
}

/**
 * Classify a thrown error from the completion request into the provider-neutral
 * outcome — the Azure DevOps twin of `classifyGitLabDirectMergeError`. The error's
 * message carries Azure's own `message (typeKey)` (`./client.ts`), so a refusal is
 * read off both the status and that text:
 *
 * - **409**, or any refusal naming `lastMergeSourceCommit`, is Azure's "the expected
 *   head no longer matches the source branch". The recheck just verified that head
 *   against the reviewed commit, so the branch moved inside that window and nobody
 *   has reviewed the current head — `not-eligible`, a fresh review.
 * - **403**, or a **400** naming a policy (a branch policy's `TF…` refusal, or a
 *   `…Policy…` type key), is a repository policy or permission refusing the
 *   completion outright — `policy-blocked`, a human's call. SWARM never sends
 *   `bypassPolicy`.
 *
 * Anything else (another 400, 404, 5xx, a transport failure) is an unexpected
 * `provider-error`. These codes are read from Azure's REST reference, not yet
 * observed live — the outcome a misread one costs is a terminal refusal reported
 * under the wrong reason, never a merge.
 */
function classifyAzureDevOpsCompletionError(error: unknown): MergePullRequestOutcome {
	const message = errorMessage(error);
	const status = errorStatus(error);
	if (status === 409 || /lastMergeSourceCommit/i.test(message))
		return { status: 'not-eligible', message };
	if (status === 403 || (status === 400 && /polic/i.test(message)))
		return { status: 'policy-blocked', message };
	return { status: 'provider-error', message };
}

/**
 * Whether the approval this merge was requested for still stands: the reviewer
 * persona's own vote approves, and nobody — the reviewer or any other account —
 * holds a "rejected" veto. A reason string when it does not.
 */
function voteRefusal(state: AzureDevOpsPullRequestMergeState, reviewerId: string): string | null {
	if (state.reviewers.some((reviewer) => reviewer.vote <= REJECTED_VOTE))
		return 'a reviewer has rejected the pull request since it was approved';
	const own = state.reviewers.find(
		(reviewer) => reviewer.id.toLowerCase() === reviewerId.toLowerCase(),
	);
	if ((own?.vote ?? 0) < APPROVING_VOTE)
		return 'the approving review is no longer in effect — the reviewer’s vote no longer approves';
	return null;
}

/**
 * Read the pull request back until Azure reports the completion's result, at most
 * {@link MERGE_COMPLETION_POLL} times. A read that fails here is `not-ready`, not a
 * `provider-error`: the completion was already accepted, so the retry's recheck is
 * the place to learn how it ended.
 */
async function awaitAzureDevOpsCompletion(
	repo: string,
	pullRequestId: number,
): Promise<MergePullRequestOutcome> {
	for (let attempt = 0; attempt < MERGE_COMPLETION_POLL.attempts; attempt++) {
		await sleep(MERGE_COMPLETION_POLL.intervalMs);
		let state: AzureDevOpsPullRequestMergeState;
		try {
			state = await getAzureDevOpsPullRequestMergeState(repo, pullRequestId);
		} catch (error) {
			return {
				status: 'not-ready',
				message: `Azure DevOps accepted the completion, but reading its result failed: ${errorMessage(error)}`,
			};
		}
		if (state.merged)
			return {
				status: 'merged',
				message: 'pull request completed',
				sha: state.mergeCommitSha ?? undefined,
			};
		if (state.state !== 'open')
			return { status: 'not-eligible', message: 'pull request was abandoned during completion' };
		if (state.mergeStatus === 'rejectedByPolicy')
			return { status: 'policy-blocked', message: 'a branch policy rejected the merge' };
		if (state.mergeStatus === 'conflicts')
			return { status: 'not-ready', message: 'pull request has merge conflicts' };
	}
	return {
		status: 'not-ready',
		message: 'Azure DevOps accepted the completion but has not finished merging yet',
	};
}

/**
 * The token-scoped body of {@link AzureDevOpsSCMIntegration.mergePullRequest},
 * mirroring GitLab's `mergeReadyGitLabMergeRequest`: re-read the pull request's
 * current state on every call, so a durable retry re-evaluates eligibility from
 * scratch rather than merging on stale approval context.
 *
 * Azure's completion takes an expected head (`lastMergeSourceCommit`), so these
 * checks are defence in depth rather than the only line; they turn refusals Azure
 * would answer with one opaque error into the specific outcomes the merge dispatch
 * needs, and distinguish "the approval no longer holds" (never retry) from "not
 * ready yet" (retry).
 *
 * There is no `stale-base` check: Azure reports no "behind its target" count on the
 * pull request, so — like Bitbucket — a head behind its base merges as before.
 */
async function mergeReadyAzureDevOpsPullRequest(
	repo: string,
	pullRequestId: number,
	approvedHeadSha: string,
	reviewerId: string,
): Promise<MergePullRequestOutcome> {
	let state: AzureDevOpsPullRequestMergeState;
	try {
		state = await getAzureDevOpsPullRequestMergeState(repo, pullRequestId);
	} catch (error) {
		return { status: 'provider-error', message: errorMessage(error) };
	}
	if (state.merged)
		return {
			status: 'merged',
			message: 'pull request already completed',
			sha: state.mergeCommitSha ?? undefined,
		};
	// The approval covers one exact commit; a push since then means nobody has
	// reviewed the current head. Azure spells the same commit in either case
	// depending on the API, so the comparison ignores case.
	if (state.headSha.toLowerCase() !== approvedHeadSha.toLowerCase())
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
		return { status: 'not-eligible', message: 'pull request is abandoned' };
	const refusal = voteRefusal(state, reviewerId);
	if (refusal) return { status: 'not-eligible', message: refusal };
	if (state.mergeStatus === 'conflicts')
		return { status: 'not-ready', message: 'pull request has merge conflicts' };

	try {
		await completeAzureDevOpsPullRequest(repo, pullRequestId, approvedHeadSha);
	} catch (error) {
		return classifyAzureDevOpsCompletionError(error);
	}
	return awaitAzureDevOpsCompletion(repo, pullRequestId);
}

export class AzureDevOpsSCMIntegration implements SCMProvider {
	readonly type = 'azure-devops' as const;
	readonly category = 'scm' as const;

	/**
	 * Whether Azure DevOps is usable for a project at all — true when at least one
	 * persona token resolves. Deliberately an OR, not an AND: some flows need only one
	 * of the personas (same rationale as the other providers' classes).
	 */
	async hasIntegration(project: ProjectConfig): Promise<boolean> {
		const [implementer, reviewer] = await Promise.all([
			getAzureDevOpsTokenOrNull(project, 'implementer'),
			getAzureDevOpsTokenOrNull(project, 'reviewer'),
		]);
		return implementer !== null || reviewer !== null;
	}

	/** Whether a specific persona's token is configured for a project. */
	async hasPersonaToken(project: ProjectConfig, persona: ScmPersona): Promise<boolean> {
		return (await getAzureDevOpsTokenOrNull(project, persona)) !== null;
	}

	/**
	 * Resolve `persona`'s PAT for `project` and run `fn` within that token scope.
	 * Every Azure DevOps request inside `fn` — via `getScopedToken()` — authenticates
	 * as that persona. Throws before running `fn` when the token isn't configured.
	 */
	async withPersonaCredentials<T>(
		project: ProjectConfig,
		persona: ScmPersona,
		fn: () => Promise<T>,
	): Promise<T> {
		const token = await getAzureDevOpsToken(project, persona);
		return withAzureDevOpsToken(token, fn);
	}

	/** {@link SCMProvider.resolvePersonaIdentities} — per-project TTL cache in `./personas.ts`. */
	async resolvePersonaIdentities(project: ProjectConfig): Promise<ScmPersonaIdentities> {
		return resolveAzureDevOpsPersonaIdentities(project);
	}

	/** {@link SCMProvider.personaForActor} — a case-insensitive identity-id match. */
	personaForActor(login: string, identities: ScmPersonaIdentities): ScmPersona | null {
		return getAzureDevOpsPersonaForLogin(login, identities);
	}

	/** {@link SCMProvider.isSwarmActor} — matches either configured persona identity. */
	isSwarmActor(login: string, identities: ScmPersonaIdentities): boolean {
		return isSwarmAzureDevOpsActor(login, identities);
	}

	// ==========================================================================
	// Webhook ingress — phase 3/6, in `./webhook.ts`
	// ==========================================================================

	/**
	 * {@link SCMProvider.verifyWebhookSignature} — a timing-safe comparison of the
	 * `Authorization: Basic` password against the project's secret, *not* an HMAC
	 * over the body: service hooks sign nothing, and basic auth is what they offer.
	 */
	verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
		return verifyAzureDevOpsWebhookAuth(rawBody, signature, secret);
	}

	/**
	 * {@link SCMProvider.readWebhookRequest} — the event type and per-event id from
	 * the body (Azure sends neither in a header), the credential from `Authorization`.
	 */
	readWebhookRequest(header: WebhookHeaderReader, payload: unknown): ScmWebhookRequest {
		return readAzureDevOpsWebhookRequest(header, payload);
	}

	/** {@link SCMProvider.parseWebhookEvent} — pull-request, comment and build events; `null` otherwise. */
	parseWebhookEvent(eventName: string, payload: unknown): ScmEvent | null {
		return parseAzureDevOpsWebhook(eventName, payload);
	}

	/** {@link SCMProvider.isSwarmGeneratedEvent} — the comment-scoped loop-prevention gate. */
	async isSwarmGeneratedEvent(event: ScmEvent, project: ProjectConfig): Promise<boolean> {
		return isSwarmGeneratedAzureDevOpsEvent(event, project);
	}

	// ==========================================================================
	// Pull-request and CI reads — phase 4/6, in `./pull-requests.ts`
	// ==========================================================================

	/**
	 * {@link SCMProvider.getPullRequest}. Reads under the **reviewer** persona by
	 * default, the persona the other adapters read one as on the review path.
	 * `mergeable` carries Azure's git-only merge evaluation; `baseSha` is the target
	 * tip Azure last evaluated against, not a merge base (`./pull-requests.ts`).
	 */
	async getPullRequest(
		project: ProjectConfig,
		prNumber: number,
		persona: ScmPersona = 'reviewer',
	): Promise<PullRequestDetails> {
		return this.withPersonaCredentials(project, persona, () =>
			getAzureDevOpsPullRequest(project.repo, prNumber),
		);
	}

	/**
	 * {@link SCMProvider.getPullRequestTitle}. Defaults to the **implementer** — the
	 * pull request's author, whose credential is always configured for a project that
	 * opens them — matching the other adapters' default for the same read.
	 */
	async getPullRequestTitle(
		project: ProjectConfig,
		prNumber: number,
		persona: ScmPersona = 'implementer',
	): Promise<string | null> {
		return this.withPersonaCredentials(project, persona, () =>
			getAzureDevOpsPullRequestTitle(project.repo, prNumber),
		);
	}

	/**
	 * {@link SCMProvider.pullRequestUrl} — `dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{n}`,
	 * every segment encoded. Pure: shares the webhook's grammar, needs no credential.
	 */
	pullRequestUrl(repo: string, prNumber: number | string): string {
		// Throws on a repo not in `organization/project/repository` form rather than
		// building a URL that addresses the wrong repository.
		azureRepoCoordinates(repo);
		return pullRequestWebUrl(repo, prNumber);
	}

	/**
	 * {@link SCMProvider.getBranchHead}. Defaults to the **implementer** persona for
	 * the reason the other adapters state: it is a repository-level read, and its
	 * caller today is a router sweep holding only the operator's own credential.
	 */
	async getBranchHead(
		project: ProjectConfig,
		branch: string,
		persona: ScmPersona = 'implementer',
	): Promise<string | null> {
		return this.withPersonaCredentials(project, persona, () =>
			getAzureDevOpsBranchHead(project.repo, branch),
		);
	}

	/**
	 * {@link SCMProvider.getAggregateCheckStatus} — Git commit statuses plus Azure
	 * Pipelines builds on `ref`. Reads under the **reviewer** persona by default, the
	 * scope the other adapters use for the review handler's aggregate query.
	 */
	async getAggregateCheckStatus(
		project: ProjectConfig,
		ref: string,
		persona: ScmPersona = 'reviewer',
	): Promise<AggregateCheckStatus> {
		return this.withPersonaCredentials(project, persona, () =>
			getAzureDevOpsCommitChecks(project.repo, ref),
		);
	}

	/**
	 * {@link SCMProvider.listPullRequestsForCommit} — the read a **branch** build's
	 * `checks` event depends on, since only a pull-request build names its pull
	 * request. Reads under the **reviewer** persona by default, the same scope
	 * {@link AzureDevOpsSCMIntegration.getAggregateCheckStatus} uses for the query
	 * that follows it on the review path.
	 */
	async listPullRequestsForCommit(
		project: ProjectConfig,
		sha: string,
		persona: ScmPersona = 'reviewer',
	): Promise<CommitPullRequest[]> {
		return this.withPersonaCredentials(project, persona, () =>
			listAzureDevOpsPullRequestsForCommit(project.repo, sha),
		);
	}

	/**
	 * {@link SCMProvider.listConflictCandidates} — active same-repository pull
	 * requests targeting `baseBranch`, read as the **implementer** (the persona that
	 * would push the resolution), same as the other adapters.
	 */
	async listConflictCandidates(
		project: ProjectConfig,
		baseBranch: string,
	): Promise<PullRequestDetails[]> {
		return this.withPersonaCredentials(project, 'implementer', () =>
			listActiveAzureDevOpsPullRequestsForBase(project.repo, baseBranch),
		);
	}

	// ==========================================================================
	// Writes: threads, delivery, merge — phase 5/6, in `./writes.ts`
	// ==========================================================================

	/**
	 * {@link SCMProvider.commentOnPullRequest} — a new comment thread on the pull
	 * request as `persona`, returning the thread id (Azure's comment ids are
	 * thread-scoped, `./writes.ts`). The out-of-band path for the worker's
	 * stalled-job safety net. Defaults to the **implementer** for the same reason the
	 * other adapters do: a comment triggers no pipeline phase, so the persona choice
	 * is immaterial to loop prevention.
	 */
	async commentOnPullRequest(
		project: ProjectConfig,
		prNumber: number,
		body: string,
		persona: ScmPersona = 'implementer',
	): Promise<number> {
		return this.withPersonaCredentials(project, persona, () =>
			postAzureDevOpsPullRequestThread(project.repo, prNumber, body),
		);
	}

	/**
	 * {@link ScmMergeProvider.mergePullRequest} for Azure DevOps: complete an
	 * approved, ready pull request as the **implementer**, pinned to
	 * `approvedHeadSha` ({@link mergeReadyAzureDevOpsPullRequest}). Whether the
	 * approval still stands is read off the **reviewer persona's** own vote, so its
	 * identity is resolved first. Never throws: every refusal or unexpected failure
	 * comes back as a non-`merged` {@link MergePullRequestOutcome}, so a completed,
	 * already-submitted Review can't be retroactively failed by this call.
	 */
	async mergePullRequest(
		project: ProjectConfig,
		prNumber: number,
		approvedHeadSha: string,
	): Promise<MergePullRequestOutcome> {
		try {
			const { reviewer } = await resolveAzureDevOpsPersonaIdentities(project);
			return await this.withPersonaCredentials(project, 'implementer', () =>
				mergeReadyAzureDevOpsPullRequest(project.repo, prNumber, approvedHeadSha, reviewer),
			);
		} catch (error) {
			// Identity and token resolution run *outside* the recheck's own try/catch,
			// so an unconfigured persona would otherwise be the one way this throws.
			return { status: 'provider-error', message: errorMessage(error) };
		}
	}

	/**
	 * {@link ScmMergeProvider.updatePullRequestBranch} for Azure DevOps — a
	 * **declared** `unsupported`, not a gap, on Bitbucket's rationale: Azure's REST
	 * API has no operation that merges the target branch into a pull request's source
	 * branch pinned to an expected head. Doing it through a git push would make SWARM
	 * the author of an unreviewed merge commit with nothing to prove it was built from
	 * the reviewed head. Answering `unsupported` makes the merge dispatch refuse a
	 * stale head visibly instead — the safe half of the guarantee.
	 */
	async updatePullRequestBranch(
		project: ProjectConfig,
		prNumber: number,
		_expectedHeadSha: string,
	): Promise<UpdatePullRequestBranchOutcome> {
		return {
			status: 'unsupported',
			message: `Azure DevOps exposes no way to merge the target branch into pull request !${prNumber} of ${project.repo} pinned to its reviewed head, so its head cannot be brought up to date automatically`,
		};
	}

	/**
	 * {@link SCMProvider.deliveryProvider} — the same-host, per-persona delivery seam.
	 * The persona's PAT is resolved once and bound to every operation; the account it
	 * authenticates as is the commit identity and the identity a verdict's vote is
	 * cast as (`./operator-delivery.ts`).
	 */
	async deliveryProvider(
		project: ProjectConfig,
		persona: ScmPersona,
	): Promise<ScmDeliveryProvider> {
		const token = await getAzureDevOpsToken(project, persona);
		return createAzureDevOpsDeliveryProvider(project.repo, token, { reviews: true });
	}

	/**
	 * {@link SCMProvider.operatorDeliveryProvider} — operator-credential delivery for
	 * DB-free workers. The worker supplies its own PAT, so no project secret-store
	 * lookup is involved.
	 */
	async operatorDeliveryProvider(repo: string, credential: string): Promise<ScmDeliveryProvider> {
		return createAzureDevOpsOperatorDeliveryProvider(repo, credential);
	}
}
