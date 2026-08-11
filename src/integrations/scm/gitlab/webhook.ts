/**
 * GitLab's webhook ingress — the one place raw GitLab webhook vocabulary lives:
 * which header names the event, which `X-Gitlab-Event` values SWARM acts on,
 * where each lifecycle field sits under `object_kind` / `object_attributes`, and
 * how GitLab authenticates a delivery. Everything here is reached only through
 * `GitLabSCMIntegration`'s {@link SCMProvider} methods, so the router, the queue
 * envelope, and the trigger handlers keep speaking nothing but the neutral
 * {@link ScmEvent} (ai/RULES.md §2). Phase 2/4 of issue #295.
 *
 * Mirrors the extraction shape of `../bitbucket/webhook.ts` and
 * `../github/webhook.ts` — `asRecord`/`str` readers, a processable-event gate,
 * mapping tables, and per-kind `*Fields()` helpers feeding one
 * `extractLifecycleFields` switch — so the three adapters read as variations on
 * one structure rather than three inventions. Where GitLab cannot supply a field
 * it stays `undefined` rather than being guessed.
 *
 * **GitLab.com only**, matching `./client.ts`. Every `issue`, `push`, `tag`, and
 * `wiki` event is out of scope: SWARM's work items live on the PM board, not in
 * GitLab Issues.
 *
 * The pipeline vocabulary this shares with the REST reads — the status → neutral
 * conclusion table and the terminal-status set — lives in `./pipelines.ts`, since
 * an event and an API read of the same pipeline must not produce two spellings.
 *
 * ## Authentication is a shared token, not an HMAC over the body
 *
 * GitLab has two mechanisms. The long-standing one echoes an operator-chosen
 * **secret token** verbatim in `X-Gitlab-Token`; that is what
 * {@link verifyGitLabWebhookToken} compares, and it authenticates the *sender*
 * only — unlike GitHub's and Bitbucket's HMAC it says nothing about the body's
 * integrity in transit.
 *
 * GitLab 19.0 added Standard-Webhooks **signing tokens** (`webhook-signature:
 * v1,<base64>` over `${webhook-id}.${webhook-timestamp}.${body}`, keyed by a
 * GitLab-minted `whsec_…` value), which would close that gap. Adopting it is a
 * deliberate **follow-up**, not this phase: `SCMProvider.verifyWebhookSignature`
 * never sees the `webhook-id` / `webhook-timestamp` headers the signed message
 * needs, so it still needs the contract widened. Its *other* prerequisite is done —
 * a GitLab-minted key could not be the operator-chosen secret the same project's
 * GitHub Projects PM webhook shared, and issue #628 made that secret per provider
 * (`credentials.scm.gitlab.webhookSecret` is GitLab's alone).
 *
 * ## GitLab has no "request changes" merge-request action
 *
 * Its `object_attributes.action` vocabulary is `open`, `close`, `reopen`,
 * `update`, `approval`, `approved`, `unapproval`, `unapproved`, `merge` —
 * verified against GitLab 19.1's webhook-events reference. A reviewer who submits
 * a *changes requested* verdict therefore produces a plain `update` whose entry
 * in the top-level `reviewers[]` array now reads `state: 'requested_changes'`, so
 * that is what {@link reviewStateOf} derives the verdict from. The limitation
 * that buys: an `update` the same reviewer triggers *later*, while their state
 * still stands at `requested_changes`, reads as the same verdict again. The
 * synthesized {@link ScmEvent.reviewId} is identical in that case (same merge
 * request, verdict, reviewer, and head), so the review-verdict ledger's
 * two-verdict cap (issue #235) treats the repeat as already answered — but once
 * the head moves it is a genuinely new id, which is the honest reading anyway:
 * the standing verdict does apply to the new head.
 */

import { timingSafeEqual } from 'node:crypto';

import type { ProjectConfig } from '../../../config/schema.js';
import type { ScmEvent, ScmEventAction, ScmReviewState } from '../../../scm/events.js';
import { isSwarmGeneratedBody } from '../../../scm/swarm-origin.js';
import type { ScmWebhookRequest, WebhookHeaderReader } from '../../../scm/types.js';
import { isTerminalPipelineStatus, pipelineConclusion } from './pipelines.js';
import { isGitLabRequestChangesMarker } from './review-marker.js';

/** Header GitLab delivers the event name in (not carried in the body). */
const EVENT_HEADER = 'x-gitlab-event';
/**
 * Per-**delivery** id, carried through for idempotency/tracing — the dispatch's
 * dedup identity. Deliberately `X-Gitlab-Event-UUID` and not
 * `X-Gitlab-Webhook-UUID`: the latter identifies the *webhook configuration*, so
 * every delivery from one hook would share it and the durable queue would dedup
 * unrelated events into a single job. Same trap `../bitbucket/webhook.ts`
 * documents for `X-Hook-UUID`.
 */
const EVENT_UUID_HEADER = 'x-gitlab-event-uuid';
/** Header carrying the secret token GitLab echoes verbatim (see the module header). */
const TOKEN_HEADER = 'x-gitlab-token';

/** The GitLab webhook event names SWARM acts on. */
export const PROCESSABLE_EVENT_NAMES = [
	'Merge Request Hook',
	'Note Hook',
	'Pipeline Hook',
] as const;

export type ProcessableEventName = (typeof PROCESSABLE_EVENT_NAMES)[number];

/**
 * The `object_kind` each processable event's body must carry. The header names
 * the event, but it is caller-supplied and the body's own discriminator is free
 * — cross-checking the two before reading a payload path means a mismatched
 * delivery is dropped rather than parsed against the wrong shape.
 */
const EVENT_OBJECT_KINDS: Readonly<Record<ProcessableEventName, string>> = {
	'Merge Request Hook': 'merge_request',
	'Note Hook': 'note',
	'Pipeline Hook': 'pipeline',
};

/**
 * Merge-request action → the neutral {@link ScmEventAction} it means, for the
 * *lifecycle* half. `reopen` collapses onto `opened` and `merge` onto `closed`
 * (with `merged: true`, see {@link mergeRequestFields}), because the neutral
 * vocabulary names the state a handler acts on rather than every way of reaching
 * it. An action outside this table and {@link REVIEW_STATES} — GitLab sends none
 * today — normalizes to nothing at all, so it is dropped rather than enqueued
 * under a guessed kind.
 */
const LIFECYCLE_ACTIONS: Readonly<Record<string, ScmEventAction>> = {
	open: 'opened',
	reopen: 'opened',
	update: 'updated',
	close: 'closed',
	merge: 'closed',
};

/**
 * Merge-request action → neutral {@link ScmReviewState}. GitLab fires a pair for
 * each direction: `approval`/`unapproval` when *one* user acts, and
 * `approved`/`unapproved` when the merge request crosses (or falls below) its
 * required-approvals threshold. Both spellings map the same way — a removal to
 * `dismissed`, the neutral name for "a previously submitted verdict no longer
 * stands", whose `dismissed` action keeps it out of the Respond-to-review trigger
 * unconditionally.
 */
const REVIEW_STATES: Readonly<Record<string, ScmReviewState>> = {
	approval: 'approved',
	approved: 'approved',
	unapproval: 'dismissed',
	unapproved: 'dismissed',
};

/** The `reviewers[].state` GitLab records for a changes-requested verdict. */
const REQUESTED_CHANGES_STATE = 'requested_changes';

/** The only `noteable_type` SWARM acts on — a comment on a merge request. */
const MERGE_REQUEST_NOTEABLE = 'MergeRequest';

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

function isProcessable(eventName: string): eventName is ProcessableEventName {
	return (PROCESSABLE_EVENT_NAMES as readonly string[]).includes(eventName);
}

/**
 * What one delivery normalizes to, before its per-kind fields are read. A
 * discriminated union rather than a flat record so `reviewState` exists exactly
 * where it is meaningful: GitLab's merge-request hook fans out onto two neutral
 * kinds, which the header alone cannot decide.
 */
type EventClassification =
	| { kind: 'pull-request'; action: ScmEventAction }
	| { kind: 'pull-request-review'; action: ScmEventAction; reviewState: ScmReviewState }
	| { kind: 'work-item-comment'; action: ScmEventAction }
	| { kind: 'checks'; action: ScmEventAction };

/**
 * Whether the user who triggered this event is a reviewer standing at
 * `requested_changes` — how a changes-requested verdict reaches us, since GitLab
 * has no action for it (see the module header).
 *
 * Keyed on the *acting* user's own entry, never on "any reviewer requested
 * changes": otherwise the implementer's push (an `update` too) would re-emit the
 * reviewer's standing verdict as if they had just cast it.
 */
function actingReviewerRequestedChanges(p: Record<string, unknown>): boolean {
	const actorId = asRecord(p.user)?.id;
	if (actorId == null) return false;
	if (!Array.isArray(p.reviewers)) return false;
	return p.reviewers.some((entry) => {
		const reviewer = asRecord(entry);
		return reviewer?.id === actorId && str(reviewer.state) === REQUESTED_CHANGES_STATE;
	});
}

/** The neutral verdict a merge-request action carries, or `undefined` for a lifecycle action. */
function reviewStateOf(action: string, p: Record<string, unknown>): ScmReviewState | undefined {
	const mapped = REVIEW_STATES[action];
	if (mapped !== undefined) return mapped;
	return action === 'update' && actingReviewerRequestedChanges(p) ? 'changes-requested' : undefined;
}

function classifyMergeRequest(p: Record<string, unknown>): EventClassification | null {
	const action = str(asRecord(p.object_attributes)?.action);
	if (action === undefined) return null;

	const reviewState = reviewStateOf(action, p);
	if (reviewState !== undefined) {
		return {
			kind: 'pull-request-review',
			action: reviewState === 'dismissed' ? 'dismissed' : 'submitted',
			reviewState,
		};
	}

	const lifecycle = LIFECYCLE_ACTIONS[action];
	return lifecycle === undefined ? null : { kind: 'pull-request', action: lifecycle };
}

function classifyNote(p: Record<string, unknown>): EventClassification | null {
	const note = asRecord(p.object_attributes);
	// GitLab's own bookkeeping notes ("assigned to @x", "approved this merge
	// request") arrive as `system: true`. They are not human input, and several of
	// them narrate actions SWARM itself just took.
	if (note?.system === true) return null;
	if (str(note?.noteable_type) !== MERGE_REQUEST_NOTEABLE) return null;
	// GitLab has no REST endpoint for a requested-changes reviewer state. Its review
	// delivery writes this marker-bearing note instead, which must bypass the normal
	// comment loop gate so Respond-to-review receives the reviewer verdict.
	if (isGitLabRequestChangesMarker(str(note?.note))) {
		return {
			kind: 'pull-request-review',
			action: 'submitted',
			reviewState: 'changes-requested',
		};
	}
	return { kind: 'work-item-comment', action: 'created' };
}

function classifyPipeline(p: Record<string, unknown>): EventClassification {
	const status = str(asRecord(p.object_attributes)?.status);
	return {
		kind: 'checks',
		// `kind === 'checks' && action === 'completed'` is the Review handler's gate
		// (`src/triggers/handlers/review.ts`), so a still-`running` pipeline normalizes
		// and enqueues but matches no trigger instead of waking a review of unfinished
		// CI — the same shape Bitbucket's `extractAction` uses for a non-terminal build.
		action: status !== undefined && isTerminalPipelineStatus(status) ? 'completed' : 'updated',
	};
}

/**
 * Which neutral kind + action a delivery means, or `null` when SWARM doesn't act
 * on it — an unmapped merge-request action, a note on anything but a merge
 * request, a system note, or a body whose `object_kind` contradicts the header.
 */
function classify(
	eventName: ProcessableEventName,
	p: Record<string, unknown>,
): EventClassification | null {
	if (str(p.object_kind) !== EVENT_OBJECT_KINDS[eventName]) return null;
	switch (eventName) {
		case 'Merge Request Hook':
			return classifyMergeRequest(p);
		case 'Note Hook':
			return classifyNote(p);
		default:
			return classifyPipeline(p);
	}
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

/**
 * `draft` is GitLab's current field; `work_in_progress` is the deprecated
 * spelling its own docs still list for backward compatibility. Undefined when
 * neither is present, rather than a guessed `false`.
 */
function draftOf(mr: Record<string, unknown> | undefined): boolean | undefined {
	if (typeof mr?.draft === 'boolean') return mr.draft;
	return typeof mr?.work_in_progress === 'boolean' ? mr.work_in_progress : undefined;
}

/** A merge request's head commit — always a full 40-character SHA (see `./pipelines.ts`). */
function headShaOf(mr: Record<string, unknown> | undefined): string | undefined {
	return str(asRecord(mr?.last_commit)?.id);
}

function mergeRequestFields(p: Record<string, unknown>): LifecycleFields {
	const mr = asRecord(p.object_attributes);
	const sourceProject = mr?.source_project_id;
	const targetProject = mr?.target_project_id;
	return {
		headSha: headShaOf(mr),
		prBranch: str(mr?.source_branch),
		baseBranch: str(mr?.target_branch),
		// A fork merge request: source and target live in different projects.
		// Undefined (rather than a guessed `false`) when either id is missing.
		isCrossRepo:
			sourceProject != null && targetProject != null ? sourceProject !== targetProject : undefined,
		isDraft: draftOf(mr),
		// `merge` is the action GitLab fires when a merge request is actually merged
		// (`close` is a decline); `state` is the same answer from the other direction,
		// for a payload that carries no action. An open merge request is definitionally
		// not merged.
		merged: str(mr?.action) === 'merge' || str(mr?.state) === 'merged',
		// `prAuthorLogin` stays unset: GitLab's merge-request hook names the author only
		// as a numeric `author_id`, and the field is tracing-only — the Review handler's
		// ownership gate keys on work-item origin (issue #397) — so resolving it would
		// mean an API round-trip inside a pure parse.
	};
}

/**
 * GitLab exposes **no review object** with a durable id: an approval is an action
 * on the merge request, not an addressable resource. So the review id is
 * synthesized from the four things that identify one verdict — the merge request,
 * the verdict, who cast it, and the commit it was cast against.
 *
 * **This format must stay stable across deliveries.** The review-verdict ledger
 * and its two-verdict cap (issue #235,
 * `src/triggers/handlers/respond-to-review.ts`) key on `reviewId`, so changing
 * the composition would make already-answered verdicts look new and re-run the
 * Respond-to-review phase on them.
 *
 * The account component prefers the numeric `user.id` over the renameable
 * `username`, precisely because renaming an account must not mint a new id for a
 * verdict already in the ledger.
 */
function synthesizeReviewId(
	iid: unknown,
	reviewState: string,
	user: Record<string, unknown> | undefined,
	headSha: string | undefined,
): string {
	const account = user?.id != null ? String(user.id) : (str(user?.username) ?? UNKNOWN_ID_PART);
	return [
		iid != null ? String(iid) : UNKNOWN_ID_PART,
		reviewState,
		account,
		headSha ?? UNKNOWN_ID_PART,
	].join(':');
}

function reviewFields(p: Record<string, unknown>, reviewState: ScmReviewState): LifecycleFields {
	const attributes = asRecord(p.object_attributes);
	// A merge-request hook puts MR fields in `object_attributes`; a Note Hook puts
	// them in `merge_request`. The latter is the request-changes delivery path.
	const mr = attributes?.iid == null ? asRecord(p.merge_request) : attributes;
	const headSha = headShaOf(mr);
	return {
		headSha,
		prBranch: str(mr?.source_branch),
		reviewState,
		reviewId: synthesizeReviewId(mr?.iid, reviewState, asRecord(p.user), headSha),
	};
}

/**
 * A note hook nests the merge request it was posted on under `merge_request`
 * rather than `object_attributes` (which holds the note itself).
 */
function noteFields(p: Record<string, unknown>): LifecycleFields {
	const mr = asRecord(p.merge_request);
	return { headSha: headShaOf(mr), prBranch: str(mr?.source_branch) };
}

function pipelineFields(p: Record<string, unknown>): LifecycleFields {
	const pipeline = asRecord(p.object_attributes);
	const status = str(pipeline?.status);
	return {
		// The pipeline hook names its commit directly, not through `last_commit`.
		headSha: str(pipeline?.sha),
		// Present for a merge-request pipeline, absent for a branch one — same hole as
		// `workItemOf`'s.
		prBranch: str(asRecord(p.merge_request)?.source_branch),
		checkConclusion: status === undefined ? undefined : pipelineConclusion(status),
	};
}

/**
 * Pull the phase-relevant lifecycle fields out of a raw webhook body. Each is
 * present only on the event kind that carries it (see the {@link ScmEvent} field
 * docs); everything else stays `undefined`. Kept separate from {@link workItemOf}
 * so the "which fields does which event carry" mapping lives in one readable
 * place rather than being smeared across {@link parseGitLabWebhook}.
 */
function extractLifecycleFields(
	classification: EventClassification,
	p: Record<string, unknown>,
): LifecycleFields {
	switch (classification.kind) {
		case 'pull-request':
			return mergeRequestFields(p);
		case 'pull-request-review':
			return reviewFields(p, classification.reviewState);
		case 'checks':
			return pipelineFields(p);
		default:
			return noteFields(p);
	}
}

/**
 * The merge request an event belongs to — GitLab's per-project `iid` (never the
 * instance-wide `id`, which no URL or API path SWARM uses accepts) and its web
 * URL. A merge-request hook carries them on `object_attributes`; a note and a
 * pipeline hook carry a nested `merge_request` object instead.
 *
 * Both stay `undefined` for a **branch** pipeline: GitLab includes
 * `merge_request` only when the pipeline ran *for* a merge request. Resolving a
 * branch pipeline's merge request takes the commit→merge-request REST lookup
 * landing in phase 3/4, which is credential-scoped and therefore belongs to
 * whichever ingress layer serves this provider's route, not to this pure parse.
 * Bitbucket's `extractWorkItemId` documents the same hole for its commit
 * statuses.
 */
function workItemOf(
	eventName: ProcessableEventName,
	p: Record<string, unknown>,
): { id?: string; url?: string } {
	const mr =
		eventName === 'Merge Request Hook' ? asRecord(p.object_attributes) : asRecord(p.merge_request);
	return { id: mr?.iid != null ? String(mr.iid) : undefined, url: str(mr?.url) };
}

/**
 * Which header carries what, for GitLab. `'unknown'` for a request with no event
 * header, so an unrecognized POST is acknowledged as an unhandled event type
 * rather than crashing the receiver.
 */
export function readGitLabWebhookRequest(header: WebhookHeaderReader): ScmWebhookRequest {
	const deliveryId = header(EVENT_UUID_HEADER);
	return {
		eventName: header(EVENT_HEADER) ?? 'unknown',
		...(deliveryId ? { deliveryId } : {}),
		signature: header(TOKEN_HEADER) ?? '',
	};
}

/**
 * Normalize a raw GitLab webhook body into an {@link ScmEvent}. `eventName` comes
 * from the `X-Gitlab-Event` header, not the body. Returns `null` for everything
 * SWARM doesn't act on — every issue, push, tag and wiki hook, an unmapped
 * merge-request action, a system note, and a note on anything but a merge request
 * — so the caller acknowledges and drops them without branching.
 */
export function parseGitLabWebhook(eventName: string, payload: unknown): ScmEvent | null {
	if (!isProcessable(eventName)) return null;

	const p = asRecord(payload) ?? {};
	const classification = classify(eventName, p);
	if (classification === null) return null;

	const workItem = workItemOf(eventName, p);
	const isCommentEvent = classification.kind === 'work-item-comment';
	return {
		kind: classification.kind,
		action: classification.action,
		// `path_with_namespace` is GitLab's `namespace/project`, which is what
		// `findProjectByRepo` matches `ProjectConfig.repo` against.
		repoFullName: str(asRecord(p.project)?.path_with_namespace) ?? 'unknown',
		workItemId: workItem.id,
		workItemUrl: workItem.url,
		// Always `username`, never `id` or `name`: persona identities resolve as
		// usernames (`./personas.ts`), and loop prevention compares the two.
		actorLogin: str(asRecord(p.user)?.username),
		isCommentEvent,
		// The note's markdown. Carried for loop prevention only — see the field doc.
		commentBody: isCommentEvent ? str(asRecord(p.object_attributes)?.note) : undefined,
		...extractLifecycleFields(classification, p),
	};
}

/**
 * Loop prevention for the *comment* reply loop — GitLab's implementation of
 * {@link SCMProvider.isSwarmGeneratedEvent}, which documents why the gate is
 * scoped to comment events and asks about the comment rather than its author
 * (issue #443). The origin test itself is provider-neutral
 * (`src/scm/swarm-origin.ts`): SWARM's own markers travel in the comment body, so
 * they read the same whichever provider delivered it.
 *
 * `async` only to match the contract's shape.
 */
export async function isSwarmGeneratedGitLabEvent(
	event: ScmEvent,
	_project: ProjectConfig,
): Promise<boolean> {
	if (!event.isCommentEvent) return false;
	return isSwarmGeneratedBody(event.commentBody);
}

/**
 * Authenticate an inbound GitLab delivery. GitLab does not sign the body: it
 * echoes the operator-chosen secret token verbatim in `X-Gitlab-Token`, so the
 * check is a comparison of that value against the project's configured secret
 * rather than a digest (see the module header for why the Standard-Webhooks
 * signing-token scheme is a follow-up instead). `verifyHmac`
 * (`src/webhook/signature-verification.ts`) is therefore not reusable here —
 * there is nothing to compute — but the timing-safe compare is reproduced for the
 * same reason it exists there: a naive `===` leaks, through response-time
 * differences, how many leading bytes of a guessed token were correct.
 *
 * **Fails closed.** GitLab omits the header entirely for a hook configured
 * without a secret token, and an empty configured secret can never match, so an
 * unauthenticated delivery is rejected rather than trusted — a hook whose token
 * was never set is indistinguishable from an attacker POSTing to the route.
 *
 * @param _rawBody - Unused: unlike GitHub's and Bitbucket's HMAC, GitLab's token
 *   authenticates the *sender* only and says nothing about the body's integrity
 *   in transit. Kept in the signature because {@link SCMProvider.verifyWebhookSignature}
 *   passes it, and dropping it would hide the difference at the seam that matters.
 * @param signature - The `X-Gitlab-Token` header value.
 * @param secret - The webhook secret token configured on the GitLab side.
 */
export function verifyGitLabWebhookToken(
	_rawBody: string,
	signature: string,
	secret: string,
): boolean {
	if (signature === '' || secret === '') return false;

	const received = Buffer.from(signature, 'utf8');
	const expected = Buffer.from(secret, 'utf8');
	// timingSafeEqual throws on differing lengths, so gate on length first — a
	// length difference is not secret-dependent, so returning here leaks nothing.
	if (received.length !== expected.length) return false;

	return timingSafeEqual(received, expected);
}
