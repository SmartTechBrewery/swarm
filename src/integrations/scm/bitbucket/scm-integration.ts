/**
 * BitbucketSCMIntegration — Bitbucket Cloud's implementation of the
 * provider-neutral {@link SCMProvider} contract (`src/scm/types.ts`), built out
 * over four phases (issue #296). Landed so far: availability probing, persona
 * credential scoping, and persona identity / actor resolution (phase 1/4);
 * webhook signature verification, header reading, event normalization, and the
 * comment loop-prevention gate (phase 2/4, delegated to `./webhook.ts`); and the
 * pull-request / build-status reads (phase 3/4, delegated to
 * `./pull-requests.ts`).
 *
 * Its core job is the same as the GitHub class's: run a block of Bitbucket
 * operations under the correct persona's credential. Callers hand it a project +
 * persona and a function; it resolves that persona's credential and binds it to
 * the async context (`withBitbucketCredential`) for the duration of the call.
 * Because resolution happens per invocation, one pipeline can review as the
 * reviewer and push as the implementer without either credential appearing in a
 * signature (ai/CODING_STANDARDS.md "Scope credentials with AsyncLocalStorage").
 *
 * **Every method a later phase owns throws** — loudly, naming the method and the
 * phase that fills it in — rather than returning `null`, `[]`, or
 * a no-op that would read as a real answer. Nothing selects this provider at
 * runtime yet (its manifest registers with `runtimeReady: false`,
 * `./index.ts`), so a throw here means a premature call, which is a wiring bug
 * worth surfacing.
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
import { withBitbucketCredential } from './client.js';
import { getBitbucketCredential, getBitbucketCredentialOrNull } from './credentials.js';
import {
	getBitbucketPersonaForLogin,
	isSwarmBitbucketActor,
	resolveBitbucketPersonaIdentities,
} from './personas.js';
import {
	getBitbucketCommitBuildStatus,
	getBitbucketPullRequest,
	getBitbucketPullRequestTitle,
	listOpenBitbucketPullRequestsForBase,
} from './pull-requests.js';
import {
	isSwarmGeneratedBitbucketEvent,
	parseBitbucketWebhook,
	readBitbucketWebhookRequest,
	verifyBitbucketSignature,
} from './webhook.js';

/**
 * The single exit for every contract method a later phase owns. `phase`
 * names the follow-up that implements it, so the error tells a caller what to
 * wait for rather than just that something is missing.
 */
function notImplementedYet(method: string, phase: string): never {
	throw new Error(
		`Bitbucket SCM: ${method}() is not implemented yet — it lands in ${phase} of issue #296`,
	);
}

const WRITE_PHASE = 'phase 4/4 (comments, delivery, merge)';

/**
 * Bitbucket's `workspace` / `repo_slug` pair, which a project's `owner/repo`
 * doubles as — see `./credentials.ts` for why that let the provider land without
 * a config-schema field.
 */
function repoCoordinates(project: ProjectConfig): [workspace: string, slug: string] {
	const [workspace, slug] = project.repo.split('/');
	return [workspace, slug];
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
