/**
 * Azure DevOps's webhook ingress — the one place raw Azure DevOps service-hook
 * vocabulary lives: which body fields name the event and the delivery, which
 * `eventType` values SWARM acts on, where each lifecycle field sits under
 * `resource`, and how a service-hook delivery is authenticated. Everything here is
 * reached only through `AzureDevOpsSCMIntegration`'s {@link SCMProvider} methods,
 * so the router, the queue envelope, and the trigger handlers keep speaking nothing
 * but the neutral {@link ScmEvent} (ai/RULES.md §2). Phase 3/6 of issue #1089.
 *
 * Mirrors the extraction shape of `../gitlab/webhook.ts` — `asRecord`/`str`
 * readers, a processable-event gate, mapping tables, and per-kind `*Fields()`
 * helpers feeding one `extractLifecycleFields` switch. Where Azure DevOps cannot
 * supply a field it stays `undefined` rather than being guessed.
 *
 * Payload shapes follow the samples in Microsoft's service-hook event reference
 * (learn.microsoft.com/azure/devops/service-hooks/events). They have not yet been
 * checked against live deliveries — no route serves this provider until phase 6/6.
 *
 * ## The event and the delivery are named in the body, not a header
 *
 * A service-hook delivery is a JSON envelope — `{ id, eventType, publisherId,
 * resource, resourceContainers, … }` — and Azure sends no header naming either the
 * event or the delivery. So {@link readAzureDevOpsWebhookRequest} reads both from
 * the parsed body, which is why `SCMProvider.readWebhookRequest` receives it. The
 * dedup id is the envelope's `id`: one GUID per event, kept across Azure's retries
 * of it — never `notificationId` or `subscriptionId`, which identify a
 * *subscription's* delivery stream, so a dedup on either would merge unrelated
 * events. Neither field is authenticated when it is read, exactly as a header is
 * not on every other provider.
 *
 * ## Authentication is HTTP Basic, not an HMAC over the body
 *
 * Azure DevOps service hooks do not sign their deliveries. The Web Hooks consumer
 * offers *basic authentication*: the operator types a username and password into
 * the subscription and Azure sends `Authorization: Basic base64(user:password)` on
 * every delivery. {@link verifyAzureDevOpsWebhookAuth} compares the password with
 * the project's webhook secret; the username is free text the operator chooses and
 * is ignored. Like GitLab's token, that authenticates the *sender* only — it says
 * nothing about the body's integrity in transit. Azure refuses basic auth over
 * plain HTTP, so the credential at least never crosses the wire unencrypted.
 *
 * ## `repoFullName` is `organization/project/repository`, in Azure's own casing
 *
 * The receiver resolves a project by exact match on `ProjectConfig.repo`
 * (`findProjectByRepoFromDb`), so the three segments are emitted exactly as Azure
 * spells them — the operator must state `repo` with Azure's casing, as on GitHub.
 * The organization comes from the repository's URLs (an organization on a legacy
 * `*.visualstudio.com` host reads lower-case, since a hostname has none), the
 * project and repository from their `name`s. A payload that does not carry all
 * three normalizes to `null` rather than a guessed repository.
 *
 * ## Known gaps
 *
 * - **Human reviewer votes are not review events.** A vote reaches a service hook as
 *   a `git.pullrequest.updated` with no structured field saying what changed (the
 *   subscription's notification-type filter is not echoed in the payload), so it
 *   normalizes to `pull-request` / `updated`. SWARM's own changes-requested verdict
 *   is carried by its findings comment instead (`./review-marker.ts`).
 * - **`git.pullrequest.merged` is ignored.** It means "merge *attempted*", not
 *   completion; a completed pull request arrives as `git.pullrequest.updated` with
 *   `status: 'completed'`, which is what wakes resolve-conflicts.
 * - **`git.push` is ignored**, as on every provider: a base-branch advance is read
 *   off the completed pull request.
 */

import { timingSafeEqual } from 'node:crypto';

import type { ProjectConfig } from '../../../config/schema.js';
import type { ScmEvent, ScmEventAction, ScmReviewState } from '../../../scm/events.js';
import { azureDevOpsOrganizationFromUrl } from '../../../scm/repo-slug.js';
import { isSwarmGeneratedBody } from '../../../scm/swarm-origin.js';
import type { ScmWebhookRequest, WebhookHeaderReader } from '../../../scm/types.js';
import { buildResultConclusion } from './builds.js';
import { isAzureDevOpsRequestChangesMarker } from './review-marker.js';

/**
 * Where an Azure DevOps Services pull request's web page lives. Equal to the REST
 * base in `./client.ts`, but not imported from it: this module is a pure parse and
 * stays free of the credential-scoped client.
 */
const AZURE_DEVOPS_WEB_BASE = 'https://dev.azure.com';

/** Header carrying the HTTP Basic credential the subscription was configured with. */
const AUTHORIZATION_HEADER = 'authorization';

/** The only authentication scheme a service-hook delivery uses. */
const BASIC_SCHEME = /^Basic\s+(\S+)$/i;

/** The Azure DevOps service-hook event types SWARM acts on. */
export const PROCESSABLE_EVENT_TYPES = [
	'git.pullrequest.created',
	'git.pullrequest.updated',
	'ms.vss-code.git-pullrequest-comment-event',
	'build.complete',
] as const;

export type ProcessableEventType = (typeof PROCESSABLE_EVENT_TYPES)[number];

/** A pull request's `status` once it is completed (merged). */
const COMPLETED_STATUS = 'completed';
/** A pull request's `status` once it is abandoned (closed without merging). */
const ABANDONED_STATUS = 'abandoned';

/**
 * Azure's own bookkeeping comments ("updated the pull request status", vote
 * notices) carry this `commentType`. They are not human input, and several narrate
 * actions SWARM itself just took — the twin of GitLab's `system` notes.
 */
const SYSTEM_COMMENT_TYPE = 'system';

/** The repository type a build of an Azure Repos Git repository names. */
const AZURE_REPOS_GIT = 'TfsGit';

/** Prefix a branch ref carries in `sourceRefName` / `targetRefName` / `sourceBranch`. */
const BRANCH_REF_PREFIX = 'refs/heads/';

/** A pull-request build's `sourceBranch` — the merge ref Azure builds a PR on. */
const PULL_REQUEST_MERGE_REF = /^refs\/pull\/(\d+)\/merge$/;

/** Stand-in for a missing component of the synthetic review id (see {@link synthesizeReviewId}). */
const UNKNOWN_ID_PART = 'unknown';

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

/** Read a string field, treating a non-string (or absent) value as absent. */
function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A numeric (or numeric-string) id as a string, or `undefined`. */
function idOf(value: unknown): string | undefined {
	if (typeof value === 'number' && Number.isInteger(value)) return String(value);
	return str(value);
}

function isProcessable(eventType: string): eventType is ProcessableEventType {
	return (PROCESSABLE_EVENT_TYPES as readonly string[]).includes(eventType);
}

/** `refs/heads/feature` → `feature`; any other ref (or none) stays as it is. */
function branchOf(ref: unknown): string | undefined {
	const value = str(ref);
	return value?.startsWith(BRANCH_REF_PREFIX) ? value.slice(BRANCH_REF_PREFIX.length) : value;
}

/**
 * What one delivery normalizes to, before its per-kind fields are read. A
 * discriminated union so `reviewState` exists exactly where it is meaningful: a
 * comment event fans out onto two neutral kinds, which the event type alone cannot
 * decide.
 */
type EventClassification =
	| { kind: 'pull-request'; action: ScmEventAction }
	| { kind: 'pull-request-review'; action: ScmEventAction; reviewState: ScmReviewState }
	| { kind: 'work-item-comment'; action: ScmEventAction }
	| { kind: 'checks'; action: ScmEventAction };

/**
 * A pull-request event's lifecycle action. `updated` fires for every change to a
 * pull request — a push, a vote, a reviewer, a status — so the *status* is what
 * tells completion (`closed`, merged) and abandonment (`closed`, not merged) apart
 * from everything else.
 */
function classifyPullRequest(
	eventType: ProcessableEventType,
	pr: Record<string, unknown>,
): EventClassification | null {
	if (pr.pullRequestId == null) return null;
	if (eventType === 'git.pullrequest.created') return { kind: 'pull-request', action: 'opened' };
	const status = str(pr.status);
	const closed = status === COMPLETED_STATUS || status === ABANDONED_STATUS;
	return { kind: 'pull-request', action: closed ? 'closed' : 'updated' };
}

function classifyComment(resource: Record<string, unknown>): EventClassification | null {
	const comment = asRecord(resource.comment);
	if (comment === undefined || asRecord(resource.pullRequest)?.pullRequestId == null) return null;
	if (str(comment.commentType) === SYSTEM_COMMENT_TYPE) return null;
	// Azure has no API that records a changes-requested verdict SWARM can observe as
	// an event, so its review delivery writes this marker-bearing comment instead,
	// which must bypass the normal comment loop gate so Respond-to-review receives it.
	if (isAzureDevOpsRequestChangesMarker(str(comment.content))) {
		return {
			kind: 'pull-request-review',
			action: 'submitted',
			reviewState: 'changes-requested',
		};
	}
	return { kind: 'work-item-comment', action: 'created' };
}

/**
 * Which neutral kind + action a delivery means, or `null` when SWARM doesn't act on
 * it — a resource missing the object its event type promises, or a system comment.
 * `build.complete` fires only for a finished build, so it is always `completed`.
 */
function classify(
	eventType: ProcessableEventType,
	resource: Record<string, unknown>,
): EventClassification | null {
	switch (eventType) {
		case 'git.pullrequest.created':
		case 'git.pullrequest.updated':
			return classifyPullRequest(eventType, resource);
		case 'ms.vss-code.git-pullrequest-comment-event':
			return classifyComment(resource);
		default:
			return resource.id == null ? null : { kind: 'checks', action: 'completed' };
	}
}

/**
 * The pull request an event is about: the resource itself for a pull-request
 * event, the nested `pullRequest` for a comment event, nothing for a build.
 */
function pullRequestOf(
	eventType: ProcessableEventType,
	resource: Record<string, unknown>,
): Record<string, unknown> | undefined {
	switch (eventType) {
		case 'git.pullrequest.created':
		case 'git.pullrequest.updated':
			return resource;
		case 'ms.vss-code.git-pullrequest-comment-event':
			return asRecord(resource.pullRequest);
		default:
			return undefined;
	}
}

/**
 * The organization the delivery's repository lives in: from the repository's clone
 * or REST URL first, then the envelope's collection/account base URLs, which every
 * delivery carries (see the module header for the casing caveat).
 */
function organizationOf(
	p: Record<string, unknown>,
	repository: Record<string, unknown> | undefined,
): string | undefined {
	const containers = asRecord(p.resourceContainers);
	const candidates = [
		repository?.remoteUrl,
		repository?.url,
		asRecord(containers?.collection)?.baseUrl,
		asRecord(containers?.account)?.baseUrl,
	];
	for (const candidate of candidates) {
		const url = str(candidate);
		const organization = url ? azureDevOpsOrganizationFromUrl(url) : null;
		if (organization) return organization;
	}
	return undefined;
}

/**
 * `organization/project/repository` for the delivery, or `undefined` when any of
 * the three is missing. A build names its repository by `name` alone and its
 * project on the build itself; a pull request nests the project in the repository.
 */
function repoFullNameOf(
	eventType: ProcessableEventType,
	p: Record<string, unknown>,
	resource: Record<string, unknown>,
): string | undefined {
	const isBuild = eventType === 'build.complete';
	const repository = isBuild
		? asRecord(resource.repository)
		: asRecord(pullRequestOf(eventType, resource)?.repository);
	// A build of a GitHub or Bitbucket repository is not an Azure Repos event.
	if (isBuild && str(repository?.type) !== AZURE_REPOS_GIT) return undefined;

	const organization = organizationOf(p, repository);
	const project = str(asRecord(isBuild ? resource.project : repository?.project)?.name);
	const name = str(repository?.name);
	return organization && project && name ? `${organization}/${project}/${name}` : undefined;
}

/**
 * A pull request's web URL. Service-hook pull-request resources carry only REST
 * URLs, so it is built from the repository's coordinates — the `dev.azure.com`
 * form, which also serves an organization still on a legacy host. Exported as the
 * one spelling of the grammar, which `AzureDevOpsSCMIntegration.pullRequestUrl`
 * (phase 4/6) shares, so an event's `workItemUrl` and a read's URL cannot drift.
 */
export function pullRequestWebUrl(repoFullName: string, pullRequestId: number | string): string {
	const segments = repoFullName.split('/').map(encodeURIComponent);
	const [organization, project, repository] = segments;
	return `${AZURE_DEVOPS_WEB_BASE}/${organization}/${project}/_git/${repository}/pullrequest/${pullRequestId}`;
}

/** The phase-relevant lifecycle fields a handler may read off a normalized event. */
interface LifecycleFields {
	headSha?: string;
	prBranch?: string;
	isCrossRepo?: boolean;
	reviewState?: string;
	reviewId?: string;
	checkConclusion?: string;
	isDraft?: boolean;
	prAuthorLogin?: string;
	baseBranch?: string;
	merged?: boolean;
}

/** A pull request's head commit — `lastMergeSourceCommit` is the source branch's tip. */
function headShaOf(pr: Record<string, unknown> | undefined): string | undefined {
	return str(asRecord(pr?.lastMergeSourceCommit)?.commitId);
}

function pullRequestFields(pr: Record<string, unknown>): LifecycleFields {
	return {
		headSha: headShaOf(pr),
		prBranch: branchOf(pr.sourceRefName),
		baseBranch: branchOf(pr.targetRefName),
		// Azure attaches `forkSource` only to a pull request opened from a fork, so its
		// absence is a definite "same repository", not a missing field.
		isCrossRepo: asRecord(pr.forkSource) !== undefined,
		isDraft: typeof pr.isDraft === 'boolean' ? pr.isDraft : undefined,
		prAuthorLogin: str(asRecord(pr.createdBy)?.id),
		merged: str(pr.status) === COMPLETED_STATUS,
	};
}

/**
 * Azure DevOps exposes **no review object** SWARM's verdict maps onto: the verdict
 * is a findings comment (`./review-marker.ts`). So the review id is synthesized
 * from the four things that identify one verdict — the pull request, the verdict,
 * who cast it, and the commit it was cast against — exactly as GitLab's is.
 *
 * **This format must stay stable across deliveries.** The review-verdict ledger and
 * its two-verdict cap (issue #235, `src/triggers/handlers/respond-to-review.ts`)
 * key on `reviewId`, so changing the composition would make already-answered
 * verdicts look new and re-run the Respond-to-review phase on them. The account
 * component is the identity id, never the renameable display or unique name.
 */
function synthesizeReviewId(
	pullRequestId: string | undefined,
	reviewState: string,
	authorId: string | undefined,
	headSha: string | undefined,
): string {
	return [
		pullRequestId ?? UNKNOWN_ID_PART,
		reviewState,
		authorId ?? UNKNOWN_ID_PART,
		headSha ?? UNKNOWN_ID_PART,
	].join(':');
}

function reviewFields(
	resource: Record<string, unknown>,
	reviewState: ScmReviewState,
): LifecycleFields {
	const pr = asRecord(resource.pullRequest);
	const headSha = headShaOf(pr);
	return {
		headSha,
		prBranch: branchOf(pr?.sourceRefName),
		reviewState,
		reviewId: synthesizeReviewId(
			idOf(pr?.pullRequestId),
			reviewState,
			str(asRecord(asRecord(resource.comment)?.author)?.id),
			headSha,
		),
	};
}

function commentFields(resource: Record<string, unknown>): LifecycleFields {
	const pr = asRecord(resource.pullRequest);
	return { headSha: headShaOf(pr), prBranch: branchOf(pr?.sourceRefName) };
}

/**
 * A build's fields. A pull-request build runs on Azure's merge commit, so
 * `sourceVersion` is *that* commit and the pull request's real head is
 * `triggerInfo['pr.sourceSha']`; a branch build has no `triggerInfo` and its
 * `sourceVersion` is the head.
 */
function buildFields(resource: Record<string, unknown>): LifecycleFields {
	const triggerInfo = asRecord(resource.triggerInfo);
	const result = str(resource.result);
	return {
		headSha: str(triggerInfo?.['pr.sourceSha']) ?? str(resource.sourceVersion),
		// Present for a pull-request build only. A branch build's pull request — and
		// its branch — is completed by the receiver's commit→pull-request lookup.
		prBranch: branchOf(triggerInfo?.['pr.sourceBranch']),
		// One spelling with the aggregate read (`./builds.ts`); the conclusion is tracing
		// only, since the Review handler re-reads every check on the head (see
		// {@link ScmEvent.checkConclusion}).
		checkConclusion: result === undefined ? undefined : buildResultConclusion(result),
	};
}

/**
 * Pull the phase-relevant lifecycle fields out of a delivery's `resource`. Each is
 * present only on the event kind that carries it (see the {@link ScmEvent} field
 * docs); everything else stays `undefined`.
 */
function extractLifecycleFields(
	classification: EventClassification,
	resource: Record<string, unknown>,
): LifecycleFields {
	switch (classification.kind) {
		case 'pull-request':
			return pullRequestFields(resource);
		case 'pull-request-review':
			return reviewFields(resource, classification.reviewState);
		case 'checks':
			return buildFields(resource);
		default:
			return commentFields(resource);
	}
}

/**
 * The pull request number an event belongs to. A build names it only through its
 * merge ref (`refs/pull/{n}/merge`); a branch build leaves it unset, so the
 * receiver's `resolveChecksPullRequest` completes it through
 * `listPullRequestsForCommit` (phase 4/6).
 */
function workItemIdOf(
	eventType: ProcessableEventType,
	resource: Record<string, unknown>,
): string | undefined {
	if (eventType !== 'build.complete') {
		return idOf(pullRequestOf(eventType, resource)?.pullRequestId);
	}
	return str(resource.sourceBranch)?.match(PULL_REQUEST_MERGE_REF)?.[1];
}

/**
 * Who produced the event, as an Azure DevOps identity id (`./personas.ts`): a
 * comment's author, a pull request's creator when it is opened. An `updated`
 * pull-request delivery names no actor, and a build's `requestedFor` is whoever
 * pushed, not an actor in the persona sense — both stay unset.
 */
function actorOf(
	eventType: ProcessableEventType,
	resource: Record<string, unknown>,
): string | undefined {
	if (eventType === 'ms.vss-code.git-pullrequest-comment-event') {
		return str(asRecord(asRecord(resource.comment)?.author)?.id);
	}
	if (eventType === 'git.pullrequest.created') return str(asRecord(resource.createdBy)?.id);
	return undefined;
}

/**
 * Which part of the request carries what, for Azure DevOps: the event type and the
 * per-event id from the body (see the module header), the Basic credential from the
 * `Authorization` header. `'unknown'` for a body with no `eventType`, so an
 * unrecognized POST is acknowledged as an unhandled event type rather than crashing
 * the receiver.
 */
export function readAzureDevOpsWebhookRequest(
	header: WebhookHeaderReader,
	payload: unknown,
): ScmWebhookRequest {
	const body = asRecord(payload);
	const deliveryId = str(body?.id);
	return {
		eventName: str(body?.eventType) ?? 'unknown',
		...(deliveryId ? { deliveryId } : {}),
		signature: header(AUTHORIZATION_HEADER) ?? '',
	};
}

/**
 * Normalize a raw service-hook delivery into an {@link ScmEvent}. `eventName` is
 * the body's own `eventType` as {@link readAzureDevOpsWebhookRequest} reported it,
 * and is cross-checked against the body so a mismatched call parses nothing.
 * Returns `null` for everything SWARM doesn't act on — every other event type
 * (including `git.push` and `git.pullrequest.merged`), a system comment, a resource
 * missing what its event type promises, a build of a non-Azure-Repos repository,
 * and a delivery whose repository cannot be named — so the caller acknowledges and
 * drops them without branching.
 */
export function parseAzureDevOpsWebhook(eventName: string, payload: unknown): ScmEvent | null {
	if (!isProcessable(eventName)) return null;

	const p = asRecord(payload) ?? {};
	if (str(p.eventType) !== eventName) return null;
	const resource = asRecord(p.resource);
	if (resource === undefined) return null;

	const classification = classify(eventName, resource);
	if (classification === null) return null;

	const repoFullName = repoFullNameOf(eventName, p, resource);
	if (repoFullName === undefined) return null;

	const workItemId = workItemIdOf(eventName, resource);
	const isCommentEvent = classification.kind === 'work-item-comment';
	return {
		kind: classification.kind,
		action: classification.action,
		repoFullName,
		workItemId,
		workItemUrl: workItemId ? pullRequestWebUrl(repoFullName, workItemId) : undefined,
		actorLogin: actorOf(eventName, resource),
		isCommentEvent,
		// The comment's markdown. Carried for loop prevention only — see the field doc.
		commentBody: isCommentEvent ? str(asRecord(resource.comment)?.content) : undefined,
		...extractLifecycleFields(classification, resource),
	};
}

/**
 * Loop prevention for the *comment* reply loop — Azure DevOps's implementation of
 * {@link SCMProvider.isSwarmGeneratedEvent}, which documents why the gate is scoped
 * to comment events and asks about the comment rather than its author (issue #443).
 * The origin test itself is provider-neutral (`src/scm/swarm-origin.ts`).
 *
 * `async` only to match the contract's shape.
 */
export async function isSwarmGeneratedAzureDevOpsEvent(
	event: ScmEvent,
	_project: ProjectConfig,
): Promise<boolean> {
	if (!event.isCommentEvent) return false;
	return isSwarmGeneratedBody(event.commentBody);
}

/**
 * Authenticate an inbound service-hook delivery: decode its `Authorization: Basic`
 * credential and compare the **password** — everything after the first `:`; the
 * username before it is free text the operator chose and is ignored — with the
 * project's webhook secret, in constant time (see the module header for
 * why this authenticates the sender rather than the body).
 *
 * **Fails closed.** An absent, empty, non-Basic or undecodable credential, one with
 * no `:`, and an empty configured secret all return `false`, so a subscription
 * configured without basic auth is rejected rather than trusted.
 *
 * @param _rawBody - Unused: Basic auth says nothing about the body. Kept because
 *   {@link SCMProvider.verifyWebhookSignature} passes it.
 * @param signature - The `Authorization` header value.
 * @param secret - The webhook secret configured as the subscription's password.
 */
export function verifyAzureDevOpsWebhookAuth(
	_rawBody: string,
	signature: string,
	secret: string,
): boolean {
	if (signature === '' || secret === '') return false;

	const encoded = signature.trim().match(BASIC_SCHEME)?.[1];
	if (encoded === undefined) return false;
	const credential = Buffer.from(encoded, 'base64').toString('utf8');
	const separator = credential.indexOf(':');
	if (separator === -1) return false;

	const received = Buffer.from(credential.slice(separator + 1), 'utf8');
	const expected = Buffer.from(secret, 'utf8');
	// timingSafeEqual throws on differing lengths, so gate on length first — a
	// length difference is not secret-dependent, so returning here leaks nothing.
	if (received.length !== expected.length) return false;

	return timingSafeEqual(received, expected);
}
