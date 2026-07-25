/**
 * SCM Provider abstraction — the shared, provider-neutral contract that ingress,
 * trigger, pipeline, and worker code programs against, so none of them name a
 * concrete provider or speak a provider's own vocabulary (ai/RULES.md §2
 * "Source-control features must not hard-code GitHub").
 *
 * GitHub is the only implementation today (`GitHubSCMIntegration`,
 * `src/integrations/scm/github/scm-integration.ts`), registered through the SCM
 * manifest + registry (`src/integrations/scm/{manifest,registry}.ts`) exactly as
 * the PM side registers GitHub Projects. Bitbucket and GitLab are planned but
 * deliberately not built (ai/CODING_STANDARDS.md "don't build it
 * speculatively").
 *
 * This file defines **types only** — every importer uses `import type`, so the
 * module adds no runtime edge. That's what lets `src/config/provider.ts` (which
 * the GitHub integration itself depends on) name {@link ScmPersona} without
 * creating an import cycle.
 *
 * The contract *composes* the two provider-neutral seams that already exist
 * rather than restating them: it extends {@link ScmMergeProvider}
 * (`src/scm/merge.ts`) and returns {@link ScmDeliveryProvider}
 * (`src/scm/delivery.ts`), so PR creation, push, formal review submission, and
 * idempotent comments keep flowing through the already-tested delivery seam.
 *
 * Deliberately **not** here yet:
 *
 * - **Webhook event parsing.** A provider's parsed event is also SWARM's durable
 *   queue job payload (`src/queue/jobs.ts`), so neutralizing it means changing
 *   the serialized envelope and reading legacy dispatch rows — that is issue
 *   #385's job, which widens this interface with the parse/resolve methods once
 *   a provider-neutral event shape exists (ai/RULES.md §2 "widen the interface,
 *   don't special-case"). Only {@link SCMProvider.verifyWebhookSignature}, the
 *   one webhook concern that needs no event model, is declared now.
 * - **Provider selection, fallback, or per-provider config.** There is one
 *   provider, one `/github/webhook` route, and one HMAC secret; a project's SCM
 *   config is `repo` + `credentials` (`src/config/schema.ts`) with no
 *   per-provider block to declare.
 * - **`withCredentials`** — the implementer-persona convenience wrapper on the
 *   GitHub class. It is sugar over {@link SCMProvider.withPersonaCredentials};
 *   putting it in the contract would oblige a second provider to implement two
 *   spellings of one operation.
 */

import type { ProjectConfig } from '../config/schema.js';
import type { ScmDeliveryProvider } from './delivery.js';
import type { ScmMergeProvider } from './merge.js';

export type ScmType = 'github';

/**
 * SWARM's dual-persona role model — the provider-neutral name for what the
 * GitHub module spells `GitHubPersona`. The split is what breaks the automation
 * feedback loop: a persona never reacts to its own output
 * (ai/CODING_STANDARDS.md "Loop prevention").
 */
export type ScmPersona = 'implementer' | 'reviewer';

/**
 * The provider login each persona's credential authenticates as. Loop
 * prevention compares an inbound event's actor against these, so both must
 * resolve for it to hold.
 */
export type ScmPersonaIdentities = Record<ScmPersona, string>;

/**
 * A pull/merge request's read state — everything shared code needs to route a
 * PR-driven phase or judge a conflict candidate, with no provider-native fields.
 * `mergeable` is `null` while the provider is still computing it.
 */
export interface PullRequestDetails {
	number: number;
	headBranch: string;
	headSha: string;
	baseBranch: string;
	baseSha: string;
	mergeable: boolean | null;
	authorLogin: string | null;
}

/** One CI check on a commit. */
export interface CheckRunState {
	name: string;
	/** `queued` | `in_progress` | `completed` — anything but `completed` is still pending. */
	status: string;
	/** `success` | `failure` | `timed_out` | … — `null` while the check hasn't finished. */
	conclusion: string | null;
}

/**
 * Aggregate CI state across *every* check on a commit — the basis for the
 * review-vs-defer decision. Neutral name on purpose: `check_suite` is GitHub
 * vocabulary (ai/RULES.md §2).
 */
export interface AggregateCheckStatus {
	totalCount: number;
	checkRuns: CheckRunState[];
}

/**
 * The contract every SWARM SCM provider implements. The surface is exactly what
 * today's lifecycle needs — availability probing, persona credential scoping,
 * webhook signature verification, persona/actor resolution, the pull-request
 * reads the triggers perform, top-level comments, delivery, and merge — and
 * grows by widening rather than by special-casing a provider at a call site
 * (ai/RULES.md §2).
 *
 * Method names and signatures match the existing GitHub implementation, so
 * declaring conformance changed no call site.
 */
export interface SCMProvider extends ScmMergeProvider {
	readonly type: ScmType;
	readonly category: 'scm';

	/**
	 * Whether this provider is usable for a project at all — deliberately an OR
	 * over the personas, since some flows need only one of them.
	 */
	hasIntegration(project: ProjectConfig): Promise<boolean>;

	/** Whether a specific persona's credential is configured for a project. */
	hasPersonaToken(project: ProjectConfig, persona: ScmPersona): Promise<boolean>;

	/**
	 * Resolve `persona`'s credential for `project` and run `fn` inside that
	 * credential scope. The credential is bound to the async context, never
	 * passed through `fn`'s signature (ai/CODING_STANDARDS.md "Scope credentials
	 * with AsyncLocalStorage"), which is what lets one pipeline review as the
	 * reviewer and push as the implementer without either token leaking into the
	 * other's calls. Throws — before running `fn` — when the credential is
	 * missing.
	 */
	withPersonaCredentials<T>(
		project: ProjectConfig,
		persona: ScmPersona,
		fn: () => Promise<T>,
	): Promise<T>;

	/**
	 * Resolve both persona logins for a project. Throws when either can't be
	 * resolved: without both, loop prevention can't tell SWARM's own events from
	 * a human's, so proceeding would be unsafe.
	 */
	resolvePersonaIdentities(project: ProjectConfig): Promise<ScmPersonaIdentities>;

	/** Which persona an actor login belongs to, or `null` when it isn't one of SWARM's. */
	personaForActor(login: string, identities: ScmPersonaIdentities): ScmPersona | null;

	/**
	 * Whether an actor login is one of SWARM's own personas — the loop-prevention
	 * drop gate. Named in SWARM's vocabulary rather than a provider's bot
	 * conventions; recognizing a provider's app/bot spellings is the adapter's job.
	 */
	isSwarmActor(login: string, identities: ScmPersonaIdentities): boolean;

	/**
	 * Verify an inbound webhook's signature against the project's shared secret.
	 * `rawBody` must be the request body byte-for-byte as received — re-serializing
	 * parsed JSON changes the bytes and breaks the signature. The provider owns its
	 * own scheme (algorithm, header prefix, encoding) and must compare in constant
	 * time. Returns `false` for an absent, malformed, or forged signature rather
	 * than throwing: an unverifiable webhook is an ordinary rejection, not a bug.
	 */
	verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean;

	/**
	 * Read one pull request's state. `prNumber` is deliberately generic — GitLab
	 * calls it an IID — and the adapter resolves whatever identifier its own API
	 * needs from `project` + `prNumber`. Omitting `persona` uses the provider's
	 * documented default for the read.
	 */
	getPullRequest(
		project: ProjectConfig,
		prNumber: number,
		persona?: ScmPersona,
	): Promise<PullRequestDetails>;

	/** A pull request's title, or `null` when the provider reports none. */
	getPullRequestTitle(
		project: ProjectConfig,
		prNumber: number,
		persona?: ScmPersona,
	): Promise<string | null>;

	/**
	 * The login that opened a pull request, or `null` when it has no author (e.g.
	 * a deleted account). Throws on an API failure, so a caller can distinguish
	 * "couldn't determine authorship" (worth a bounded recheck) from a
	 * resolved-but-not-ours author (a definitive skip).
	 */
	getPullRequestAuthor(
		project: ProjectConfig,
		prNumber: number,
		persona?: ScmPersona,
	): Promise<string | null>;

	/**
	 * Aggregate the state of every check on `ref` (a commit SHA), so a caller
	 * decides whether CI is finished from the whole picture rather than trusting
	 * one webhook's own conclusion.
	 */
	getAggregateCheckStatus(
		project: ProjectConfig,
		ref: string,
		persona?: ScmPersona,
	): Promise<AggregateCheckStatus>;

	/** Open pull requests targeting `baseBranch` — the conflict-detection seam after a base advances. */
	listConflictCandidates(project: ProjectConfig, baseBranch: string): Promise<PullRequestDetails[]>;

	/** Post a top-level comment on a pull request, returning the new comment's id. */
	commentOnPullRequest(
		project: ProjectConfig,
		prNumber: number,
		body: string,
		persona?: ScmPersona,
	): Promise<number>;

	/**
	 * Build **one way** to obtain the deterministic delivery seam
	 * ({@link ScmDeliveryProvider}) for a project + persona: the provider's own
	 * same-host implementation, resolving that persona's credential here.
	 *
	 * Deliberately not asserted to be the *only* source of a delivery provider,
	 * nor that a delivery provider does all its work in-process. SWARM already
	 * composes three producers (ADR-002/ADR-003/ADR-004): this method, the
	 * operator-token provider a DB-free worker uses
	 * (`src/integrations/scm/github/operator-delivery.ts`), and the
	 * transport-backed composite (`src/scm/transport-delivery.ts`) whose
	 * metadata-only ops POST to the control plane while source-carrying ops
	 * delegate locally. A caller that has a delivery provider must therefore not
	 * assume it came from here.
	 */
	deliveryProvider(project: ProjectConfig, persona: ScmPersona): Promise<ScmDeliveryProvider>;
}
