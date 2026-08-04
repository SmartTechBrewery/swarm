/**
 * GitLabSCMIntegration — GitLab.com's implementation of the provider-neutral
 * {@link SCMProvider} contract (`src/scm/types.ts`), built out over four phases
 * (issue #295) along the same seams Bitbucket used. This is phase 1/4:
 * availability probing, persona credential scoping, and persona identity / actor
 * resolution.
 *
 * Its core job is the same as the GitHub and Bitbucket classes': run a block of
 * GitLab operations under the correct persona's token. Callers hand it a project
 * + persona and a function; it resolves that persona's token and binds it to the
 * async context (`withGitLabToken`) for the duration of the call. Because
 * resolution happens per invocation, one pipeline can review as the reviewer and
 * push as the implementer without either token appearing in a signature
 * (ai/CODING_STANDARDS.md "Scope credentials with AsyncLocalStorage").
 *
 * **Every method this phase does not implement throws** — loudly, naming the
 * method and the phase that fills it in — rather than returning `null`, `[]`, or
 * a no-op that would read as a real answer. `verifyWebhookSignature`,
 * `readWebhookRequest`, `personaForActor` and `isSwarmActor` are synchronous in
 * the contract, so their stubs throw synchronously rather than rejecting.
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
} from '../../../scm/types.js';
import { withGitLabToken } from './client.js';
import { getGitLabToken, getGitLabTokenOrNull } from './credentials.js';
import {
	getGitLabPersonaForLogin,
	isSwarmGitLabActor,
	resolveGitLabPersonaIdentities,
} from './personas.js';

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

const WEBHOOK_PHASE = 'phase 2/4 (webhook ingress)';
const READ_PHASE = 'phase 3/4 (merge-request reads)';
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
	// Deferred: webhook ingress — phase 2/4
	// ==========================================================================

	verifyWebhookSignature(): boolean {
		notImplementedYet('verifyWebhookSignature', WEBHOOK_PHASE);
	}

	readWebhookRequest(): ScmWebhookRequest {
		notImplementedYet('readWebhookRequest', WEBHOOK_PHASE);
	}

	parseWebhookEvent(): ScmEvent | null {
		notImplementedYet('parseWebhookEvent', WEBHOOK_PHASE);
	}

	async isSwarmGeneratedEvent(): Promise<boolean> {
		notImplementedYet('isSwarmGeneratedEvent', WEBHOOK_PHASE);
	}

	// ==========================================================================
	// Deferred: merge-request reads — phase 3/4
	// ==========================================================================

	async getPullRequest(): Promise<PullRequestDetails> {
		notImplementedYet('getPullRequest', READ_PHASE);
	}

	async getPullRequestTitle(): Promise<string | null> {
		notImplementedYet('getPullRequestTitle', READ_PHASE);
	}

	async getAggregateCheckStatus(): Promise<AggregateCheckStatus> {
		notImplementedYet('getAggregateCheckStatus', READ_PHASE);
	}

	async listConflictCandidates(): Promise<PullRequestDetails[]> {
		notImplementedYet('listConflictCandidates', READ_PHASE);
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
