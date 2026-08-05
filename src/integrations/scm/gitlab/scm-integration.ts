/**
 * GitLabSCMIntegration — GitLab.com's implementation of the provider-neutral
 * {@link SCMProvider} contract (`src/scm/types.ts`), built out over four phases
 * (issue #295) along the same seams Bitbucket used. Built so far: availability
 * probing, persona credential scoping, and persona identity / actor resolution
 * (phase 1/4); the whole inbound half — header interpretation, delivery
 * authentication, event normalization, and the comment loop-prevention gate,
 * which all delegate to `./webhook.ts` (phase 2/4); and the merge-request /
 * commit-status reads, which delegate to `./merge-requests.ts` (phase 3/4).
 *
 * Its core job is the same as the GitHub and Bitbucket classes': run a block of
 * GitLab operations under the correct persona's token. Callers hand it a project
 * + persona and a function; it resolves that persona's token and binds it to the
 * async context (`withGitLabToken`) for the duration of the call. Because
 * resolution happens per invocation, one pipeline can review as the reviewer and
 * push as the implementer without either token appearing in a signature
 * (ai/CODING_STANDARDS.md "Scope credentials with AsyncLocalStorage").
 *
 * **Every method a later phase owns throws** — loudly, naming the method and the
 * phase that fills it in — rather than returning `null`, `[]`, or a no-op that
 * would read as a real answer. What is left is the comments/delivery/merge writes
 * (phase 4/4), all of them `async` in the contract, so those stubs reject rather
 * than throwing synchronously.
 *
 * Unlike Bitbucket's phase 1, **nothing registers this provider yet**: the
 * multi-provider conformance suite (`tests/unit/integrations/scm/scm-conformance.test.ts`)
 * asserts that no *registered* manifest stubs a contract method, and
 * `ai/TESTING.md` frames that assertion as the gate on the third provider — so
 * the manifest lands in phase 4/4 together with the last stub's removal, and
 * nothing can resolve `GitLabSCMIntegration` by id until then. A throw here
 * therefore means a caller constructed the class directly and called too early.
 */

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
import { withGitLabToken } from './client.js';
import { getGitLabToken, getGitLabTokenOrNull } from './credentials.js';
import {
	getGitLabCommitStatuses,
	getGitLabMergeRequest,
	getGitLabMergeRequestTitle,
	listOpenGitLabMergeRequestsForBase,
} from './merge-requests.js';
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

/**
 * The single exit for every contract method this phase leaves unbuilt. `phase`
 * names the follow-up that implements it, so the error tells a caller what to
 * wait for rather than just that something is missing.
 */
function notImplementedYet(method: string, phase: string): never {
	throw new Error(
		`GitLab SCM: ${method}() is not implemented yet — it lands in ${phase} of issue #295`,
	);
}

const WRITE_PHASE = 'phase 4/4 (comments, delivery, merge)';

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
	// Deferred: comments, delivery, merge — phase 4/4
	// ==========================================================================

	async commentOnPullRequest(): Promise<number> {
		notImplementedYet('commentOnPullRequest', WRITE_PHASE);
	}

	async deliveryProvider(): Promise<ScmDeliveryProvider> {
		notImplementedYet('deliveryProvider', WRITE_PHASE);
	}

	async operatorDeliveryProvider(): Promise<ScmDeliveryProvider> {
		notImplementedYet('operatorDeliveryProvider', WRITE_PHASE);
	}

	async mergePullRequest(): Promise<MergePullRequestOutcome> {
		notImplementedYet('mergePullRequest', WRITE_PHASE);
	}
}
