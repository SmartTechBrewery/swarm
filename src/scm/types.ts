/**
 * SCM Provider abstraction — the shared, provider-neutral contract that ingress,
 * trigger, pipeline, and worker code programs against, so none of them name a
 * concrete provider or speak a provider's own vocabulary (ai/RULES.md §2
 * "Source-control features must not hard-code GitHub").
 *
 * All three implementations carry runtime traffic: `GitHubSCMIntegration`
 * (`src/integrations/scm/github/scm-integration.ts`), `BitbucketSCMIntegration`
 * (`src/integrations/scm/bitbucket/scm-integration.ts`, since issue #618), and
 * `GitLabSCMIntegration` (`src/integrations/scm/gitlab/scm-integration.ts`, since
 * issue #619) — each registered through the SCM manifest + registry
 * (`src/integrations/scm/{manifest,registry}.ts`) exactly as the PM side
 * registers GitHub Projects, and each project routing to the one it names
 * (`ProjectConfig.scm`, issue #478).
 *
 * This file defines **types plus one closed value vocabulary**
 * ({@link SCM_CREDENTIAL_ROLES}) and imports nothing at runtime, so importing it
 * still adds no dependency edge of its own. That's what lets
 * `src/config/provider.ts` (which the GitHub integration itself depends on) name
 * {@link ScmPersona} without creating an import cycle.
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
 * - **Per-provider config.** A project's SCM config is `repo` + `credentials`
 *   (`src/config/schema.ts`) with no per-provider block to declare, so the
 *   manifest carries no `configSchema` and the `ProjectConfig.scm` discriminator
 *   (issue #478) is a bare provider id rather than a discriminated union's `type`.
 *   Selection itself is no longer missing: `requireProjectSCMProvider`
 *   (`src/integrations/scm/registry.ts`) resolves the manifest a project names,
 *   which is what lets GitHub, Bitbucket, and GitLab serve one installation side
 *   by side.
 * - **`withCredentials`** — the implementer-persona convenience wrapper on the
 *   GitHub class. It is sugar over {@link SCMProvider.withPersonaCredentials};
 *   putting it in the contract would oblige a second provider to implement two
 *   spellings of one operation.
 */

import type { ProjectConfig } from '../config/schema.js';
import type { ScmDeliveryProvider } from './delivery.js';
import type { ScmEvent } from './events.js';
import type { ScmMergeProvider } from './merge.js';

/**
 * Every SCM provider id, as values — the closed vocabulary {@link ScmType} is derived
 * from, so the type and the list cannot drift. Needed as a runtime list by the config
 * schema's `credentials.scm` key check (`src/config/schema.ts`), which validates a
 * provider *id* without depending on which provider modules a process imported.
 */
export const SCM_TYPES = ['github', 'bitbucket', 'gitlab'] as const;
export type ScmType = (typeof SCM_TYPES)[number];

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
 * The project-scoped credentials every SCM provider needs, as a **closed** pair
 * (issue #628) — a project supplies one reference per role, per provider, under
 * `credentials.scm[<providerId>]` (`src/config/schema.ts`).
 *
 * Closed, unlike the PM side's open `credentialRoles` vocabulary, because these two
 * are named by the *contract* rather than by a provider: `reviewer` is
 * {@link ScmPersona}'s project-scoped half (the implementer is the worker
 * operator's own env-var credential and is deliberately not a project credential —
 * issue #396), and `webhookSecret` is what
 * {@link SCMProvider.verifyWebhookSignature} authenticates a delivery with. A PM
 * provider's roles genuinely differ per provider (Jira an email + token, Trello a
 * key + token + secret); an SCM provider's do not. What *is* per provider is the
 * reference name each role conventionally uses, which the manifest declares
 * (`SCMProviderManifest.credentialRoles`).
 */
export const SCM_CREDENTIAL_ROLES = ['reviewer', 'webhookSecret'] as const;
export type ScmCredentialRole = (typeof SCM_CREDENTIAL_ROLES)[number];

/**
 * A pull/merge request's read state — everything shared code needs to route a
 * PR-driven phase or judge a conflict candidate, with no provider-native fields.
 * `mergeable` is `null` while the provider is still computing it — and stays
 * `null` once the pull request closes, which is what `state` is for.
 */
export interface PullRequestDetails {
	number: number;
	headBranch: string;
	headSha: string;
	baseBranch: string;
	baseSha: string;
	mergeable: boolean | null;
	authorLogin: string | null;
	/**
	 * The same neutral `open`/`closed` pair {@link CommitPullRequest.state} carries,
	 * normalized by each provider from its own vocabulary so a *merged* pull request
	 * — which GitHub, Bitbucket and GitLab all report as a flavour of closed — can
	 * never read as open. Load-bearing because `mergeable` never becomes final on a
	 * closed pull request: this is what tells a mergeability recheck it is polling
	 * something that is already done (issue #772).
	 */
	state: 'open' | 'closed';
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
 * A pull request a commit belongs to — just enough to tie a CI event back to the
 * pull request it ran for (see {@link SCMProvider.listPullRequestsForCommit}).
 *
 * `state` is the neutral `open`/`closed` pair, not a provider's own vocabulary:
 * Bitbucket says `OPEN`/`MERGED`/`DECLINED`/`SUPERSEDED` and GitLab
 * `opened`/`closed`/`locked`/`merged`, and shared code only ever asks whether the
 * pull request is still open.
 */
export interface CommitPullRequest {
	number: number;
	headBranch: string;
	state: 'open' | 'closed';
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
	 *
	 * Note: this is NOT SWARM's loop-prevention drop gate for events. Under the
	 * federated model (ADR-004 §3), an implementer identity is the worker operator's
	 * own account, so actor login alone cannot distinguish SWARM's output from human
	 * actions. Event drop gates use SWARM-origin markers (`src/scm/swarm-origin.ts`,
	 * issue #443) for comments and work-item origin (`src/triggers/swarm-managed-pr.ts`)
	 * for PR ownership on both `pr-review` (issue #397) and `resolve-conflicts`
	 * (issue #836) — which is why no production call site is left, though the
	 * contract still requires the method of every provider.
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

	/**
	 * The pull requests commit `sha` belongs to — the ingress path's commit→pull
	 * request resolution, for providers whose CI payload names no pull request
	 * (issue #618).
	 *
	 * GitHub's `check_suite` carries `pull_requests`, so its `checks` events arrive
	 * already resolved; Bitbucket's `commit_status` and a GitLab **branch** pipeline
	 * carry no association at all, leaving `workItemId`/`prBranch` unset. The
	 * receiver closes that gap through this method rather than reaching for a
	 * provider-local lookup (ai/RULES.md §2 "widen the interface"), so no shared code
	 * names `listBitbucketPullRequestsForCommit` or its GitLab twin.
	 *
	 * A credential-scoped read, unlike {@link SCMProvider.parseWebhookEvent}, which
	 * is why it is a contract method and not part of the parse. Ordering is the
	 * provider's own; the caller picks the first **open** pull request. An empty
	 * array is an ordinary answer — Bitbucket serves this through its Pull Request
	 * Commit Links app, which may not have indexed the commit yet — and must not be
	 * read as proof the commit has no pull request. Omitting `persona` uses the
	 * provider's documented default for the read.
	 */
	listPullRequestsForCommit(
		project: ProjectConfig,
		sha: string,
		persona?: ScmPersona,
	): Promise<CommitPullRequest[]>;

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
	 * composes three producers (ADR-002/ADR-003/ADR-004): this method,
	 * {@link SCMProvider.operatorDeliveryProvider} (the neutral name for the
	 * operator-credential producer a DB-free worker uses), and the
	 * transport-backed composite (`src/scm/transport-delivery.ts`) whose
	 * metadata-only ops POST to the control plane while source-carrying ops
	 * delegate locally. A caller that has a delivery provider must therefore not
	 * assume it came from here.
	 */
	deliveryProvider(project: ProjectConfig, persona: ScmPersona): Promise<ScmDeliveryProvider>;

	/**
	 * Build a delivery provider authenticated as the worker *operator's own*
	 * account rather than a per-project persona credential — the producer a DB-free
	 * federated worker uses (ADR-003 §2 / ADR-004 §3), which holds no secret store
	 * to resolve a persona credential from.
	 *
	 * `repo` is the provider-neutral `owner/repo` from {@link ProjectConfig}, and
	 * `credential` the operator's own account token, resolved from the worker's
	 * environment by its entry point (`src/transport/connect-entry.ts`) rather than
	 * behind this contract — the credential is the operator's, not the project's,
	 * so no project config names it.
	 *
	 * Metadata-only writes the server owns (a reviewer verdict) may be
	 * *unavailable* on the returned provider; the caller composes them over the
	 * transport instead (`src/scm/transport-delivery.ts`).
	 */
	operatorDeliveryProvider(repo: string, credential: string): Promise<ScmDeliveryProvider>;
}
