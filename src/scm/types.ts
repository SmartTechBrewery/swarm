/**
 * SCM Provider abstraction — the shared, provider-neutral contract that ingress,
 * trigger, pipeline, and worker code programs against, so none of them name a
 * concrete provider or speak a provider's own vocabulary (ai/RULES.md §2
 * "Source-control features must not hard-code GitHub").
 *
 * GitHub is the only implementation that carries runtime traffic today
 * (`GitHubSCMIntegration`, `src/integrations/scm/github/scm-integration.ts`),
 * registered through the SCM manifest + registry
 * (`src/integrations/scm/{manifest,registry}.ts`) exactly as the PM side
 * registers GitHub Projects. Bitbucket is being built out phase by phase (issue
 * #296) and registers with `runtimeReady: false` until it satisfies the whole
 * contract; GitLab is still planned and deliberately not built
 * (ai/CODING_STANDARDS.md "don't build it speculatively").
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
 * Webhook ingress joined the contract with issue #385: the receiver now reads
 * headers, parses, and applies loop prevention entirely through the provider, so
 * `src/router/webhook-receiver.ts` names no provider and knows no raw event name.
 *
 * Deliberately **not** here yet:
 *
 * - **Provider selection, fallback, or per-provider config.** There is one
 *   runtime-ready provider, one served webhook route, and one HMAC secret; a
 *   project's SCM config is `repo` + `credentials` (`src/config/schema.ts`) with
 *   no per-provider block to declare. Issue #386 pinned that as an assertion
 *   rather than a guess: the project-scoped lookup every outbound call site uses
 *   (`requireProjectSCMProvider`, `src/integrations/scm/registry.ts`) throws
 *   unless exactly one *runtime-ready* provider is registered, so selection gets
 *   designed with the second one that claims runtime readiness.
 * - **`withCredentials`** — the implementer-persona convenience wrapper on the
 *   GitHub class. It is sugar over {@link SCMProvider.withPersonaCredentials};
 *   putting it in the contract would oblige a second provider to implement two
 *   spellings of one operation.
 */

import type { ProjectConfig } from '../config/schema.js';
import type { ScmDeliveryProvider } from './delivery.js';
import type { ScmEvent } from './events.js';
import type { ScmMergeProvider } from './merge.js';

export type ScmType = 'github' | 'bitbucket';

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
 * Case-insensitive reader over an inbound request's headers — the only thing a
 * provider gets to see of the HTTP request besides the raw body, so the receiver
 * stays free of any provider's header names.
 */
export type WebhookHeaderReader = (name: string) => string | undefined;

/**
 * What a provider reads out of an inbound webhook's headers.
 *
 * `eventName` stays the provider's *own* event name (GitHub's `pull_request`,
 * `projects_v2_item`, …), deliberately opaque to the receiver: it is only ever
 * handed straight back to {@link SCMProvider.parseWebhookEvent} — which owns the
 * mapping onto {@link ScmEvent}'s neutral kinds — and logged.
 */
export interface ScmWebhookRequest {
	/** The provider's own event name, or `'unknown'` when the request carries none. */
	eventName: string;
	/** Per-delivery id, when the provider sends one — the dispatch's dedup identity. */
	deliveryId?: string;
	/** The signature to verify the raw body against; `''` when the request carries none. */
	signature: string;
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
	 * Whether an actor login matches one of SWARM's configured persona identities.
	 * Used by the PM board's status-change gate and the conflict-candidate filter.
	 *
	 * Note: this is NOT SWARM's loop-prevention drop gate for events. Under the
	 * federated model (ADR-004 §3), an implementer identity is the worker operator's
	 * own account, so actor login alone cannot distinguish SWARM's output from human
	 * actions. Event drop gates use SWARM-origin markers (`src/scm/swarm-origin.ts`,
	 * issue #443) for comments and work-item origin (`src/triggers/swarm-managed-pr.ts`,
	 * issue #397) for PR review ownership.
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
	 * Interpret an inbound webhook's headers — which one names the event, which
	 * carries the per-delivery id, which carries the signature. Pure header
	 * reading, so it runs before the body is authenticated.
	 */
	readWebhookRequest(header: WebhookHeaderReader): ScmWebhookRequest;

	/**
	 * Normalize a raw webhook body into an {@link ScmEvent}. `eventName` is the
	 * value this provider itself reported from
	 * {@link SCMProvider.readWebhookRequest}. Returns `null` for events SWARM
	 * doesn't act on, so the receiver acknowledges them without branching on any
	 * provider's event vocabulary.
	 */
	parseWebhookEvent(eventName: string, payload: unknown): ScmEvent | null;

	/**
	 * Loop prevention's drop gate: whether SWARM itself generated this event, so
	 * ingress can drop it instead of reacting to its own output.
	 *
	 * Deliberately narrow — it is scoped to *comment* events, which are what create
	 * the runaway reply loop. PR/review/check lifecycle events must flow through
	 * even when SWARM produced them, because the *other* persona has to act on
	 * them (the implementer opens a PR → the reviewer reviews it; the reviewer
	 * requests changes → the implementer responds).
	 *
	 * It asks about the event, not its author (issue #443): under the federated
	 * model an implementer identity is the worker operator's own account (ADR-004
	 * §3), so an actor login cannot distinguish SWARM's output from that human's.
	 */
	isSwarmGeneratedEvent(event: ScmEvent, project: ProjectConfig): Promise<boolean>;

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
