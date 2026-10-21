/**
 * AzureDevOpsSCMIntegration — Azure DevOps Services' implementation of the
 * provider-neutral {@link SCMProvider} contract (`src/scm/types.ts`), built out over
 * six phases (issue #1089) along the same seams GitLab used. Built so far:
 * availability probing, persona credential scoping, and persona identity / actor
 * resolution (phase 2/6), webhook ingress (phase 3/6, `./webhook.ts`), and the
 * pull-request and CI reads (phase 4/6, `./pull-requests.ts`).
 *
 * Its core job is the same as the other providers' classes: run a block of Azure
 * DevOps operations under the correct persona's PAT. Callers hand it a project +
 * persona and a function; it resolves that persona's token and binds it to the async
 * context (`withAzureDevOpsToken`) for the duration of the call, so one pipeline can
 * review as the reviewer and push as the implementer without either token appearing
 * in a signature (ai/CODING_STANDARDS.md "Scope credentials with AsyncLocalStorage").
 *
 * **Every method not yet implemented throws** — loudly, naming the method and the
 * phase that fills it in — rather than returning `null`, `[]`, or a no-op that
 * would read as a real answer.
 *
 * Like GitLab's build-out, **nothing registers this provider yet**: the
 * multi-provider conformance suite (`tests/unit/integrations/scm/scm-conformance.test.ts`)
 * asserts that no *registered* manifest stubs a contract method, so the manifest
 * lands in phase 6/6 together with the last stub's removal. A throw here therefore
 * means a caller constructed the class directly and called too early.
 */

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
	getAzureDevOpsPersonaForLogin,
	isSwarmAzureDevOpsActor,
	resolveAzureDevOpsPersonaIdentities,
} from './personas.js';
import {
	getAzureDevOpsBranchHead,
	getAzureDevOpsCommitChecks,
	getAzureDevOpsPullRequest,
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

/**
 * The single exit for every contract method this phase leaves unbuilt. `phase`
 * names the follow-up that implements it, so the error tells a caller what to wait
 * for rather than just that something is missing.
 */
function notImplementedYet(method: string, phase: string): never {
	throw new Error(
		`Azure DevOps SCM: ${method}() is not implemented yet — it lands in ${phase} of issue #1089`,
	);
}

const WRITE_PHASE = 'phase 5/6 (comments, delivery, merge)';

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
	// Deferred: comments, delivery, merge — phase 5/6
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

	async updatePullRequestBranch(): Promise<UpdatePullRequestBranchOutcome> {
		notImplementedYet('updatePullRequestBranch', WRITE_PHASE);
	}
}
