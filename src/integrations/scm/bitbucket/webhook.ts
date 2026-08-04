/**
 * Bitbucket Cloud's webhook ingress — the one place raw Bitbucket webhook
 * vocabulary lives: which header names the event, which `X-Event-Key` values
 * SWARM acts on, where each lifecycle field sits in the payload, and how
 * Bitbucket frames its HMAC signature. Everything here is reached only through
 * `BitbucketSCMIntegration`'s {@link SCMProvider} methods, so the router, the
 * queue envelope, and the trigger handlers keep speaking nothing but the neutral
 * {@link ScmEvent} (ai/RULES.md §2). Phase 2/4 of issue #296.
 *
 * Mirrors the extraction shape of `../github/webhook.ts` — `asRecord`, a
 * processable-event gate, `extractWorkItemId`, and per-event `*Fields()` helpers
 * feeding one `extractLifecycleFields` switch — so the two adapters read as
 * variations on one structure rather than two inventions. Field semantics are
 * the ones the {@link ScmEvent} field docs pin down; where Bitbucket cannot
 * supply a field, it stays `undefined` rather than being guessed.
 *
 * **Bitbucket Cloud only** (`X-Event-Key`, `X-Hub-Signature`); Server / Data
 * Center is out of scope, as is every `issue:*` event — SWARM's work items live
 * on the PM board, not in Bitbucket Issues.
 *
 * ## The abbreviated-hash invariant
 *
 * Bitbucket abbreviates a pull request's `source.commit.hash` to **12
 * characters** (Atlassian's own event-payload reference shows
 * `"hash": "d3022fc0ca3d"`), while a build status identifies its commit through
 * `links.commit.href`, whose last path segment is the full SHA. The adapter
 * therefore emits Bitbucket's 12-character spelling for every `headSha`.
 * Shared consumers use this value as an exact database or deduplication key, so
 * they must never see two spellings for the same commit. A later API read that
 * returns a full SHA must likewise be abbreviated before comparison with an
 * event `headSha`.
 */

import type { ProjectConfig } from '../../../config/schema.js';
import type {
	ScmEvent,
	ScmEventAction,
	ScmEventKind,
	ScmReviewState,
} from '../../../scm/events.js';
import { isSwarmGeneratedBody } from '../../../scm/swarm-origin.js';
import type { ScmWebhookRequest, WebhookHeaderReader } from '../../../scm/types.js';
import { verifyHmac } from '../../../webhook/signature-verification.js';

/** Header Bitbucket delivers the event key in (not carried in the body). */
const EVENT_KEY_HEADER = 'x-event-key';
/**
 * Per-request id, carried through for idempotency/tracing — the dispatch's dedup
 * identity. Deliberately `X-Request-UUID` and not `X-Hook-UUID`: the latter
 * identifies the *webhook configuration*, so every delivery from one hook would
 * share it and the queue would dedup unrelated events into one job.
 */
const REQUEST_UUID_HEADER = 'x-request-uuid';
/**
 * Header carrying the HMAC-SHA256 signature Bitbucket signs the raw body with.
 * Note the un-suffixed name: Bitbucket's header is `X-Hub-Signature`, where
 * GitHub's SHA-256 header is `X-Hub-Signature-256`.
 */
const SIGNATURE_HEADER = 'x-hub-signature';

/** The Bitbucket event keys SWARM acts on. */
export const PROCESSABLE_EVENT_KEYS = [
	'pullrequest:created',
	'pullrequest:updated',
	'pullrequest:fulfilled',
	'pullrequest:rejected',
	'pullrequest:approved',
	'pullrequest:unapproved',
	'pullrequest:changes_request_created',
	'pullrequest:changes_request_removed',
	'pullrequest:comment_created',
	'repo:commit_status_created',
	'repo:commit_status_updated',
] as const;

export type ProcessableEventKey = (typeof PROCESSABLE_EVENT_KEYS)[number];

/**
 * Bitbucket event key → neutral {@link ScmEventKind}. The single mapping table
 * that keeps `pullrequest:fulfilled` and `repo:commit_status_updated` out of
 * shared code; its key set *is* {@link PROCESSABLE_EVENT_KEYS}.
 *
 * Bitbucket splits into distinct event keys what GitHub expresses as one event
 * plus an `action`, so this table is where that fan-in happens: four keys
 * collapse onto `pull-request`, four onto `pull-request-review`, two onto
 * `checks`.
 */
const EVENT_KINDS: Readonly<Record<ProcessableEventKey, ScmEventKind>> = {
	'pullrequest:created': 'pull-request',
	'pullrequest:updated': 'pull-request',
	'pullrequest:fulfilled': 'pull-request',
	'pullrequest:rejected': 'pull-request',
	'pullrequest:approved': 'pull-request-review',
	'pullrequest:unapproved': 'pull-request-review',
	'pullrequest:changes_request_created': 'pull-request-review',
	'pullrequest:changes_request_removed': 'pull-request-review',
	'pullrequest:comment_created': 'work-item-comment',
	'repo:commit_status_created': 'checks',
	'repo:commit_status_updated': 'checks',
};

/**
 * The neutral {@link ScmEventAction} each event key means. Bitbucket carries no
 * `action` field in the body — the key *is* the action — so unlike GitHub's
 * alias table this is a total mapping rather than a list of exceptions.
 *
 * Submitted verdicts use `submitted`; verdict removals use `dismissed` so they
 * cannot pass the Respond-to-review trigger's submitted-review gate. A build
 * status's entry is overridden to `completed` once its state is terminal — see
 * {@link extractAction}.
 */
const EVENT_ACTIONS: Readonly<Record<ProcessableEventKey, ScmEventAction>> = {
	'pullrequest:created': 'opened',
	'pullrequest:updated': 'updated',
	'pullrequest:fulfilled': 'closed',
	'pullrequest:rejected': 'closed',
	'pullrequest:approved': 'submitted',
	'pullrequest:unapproved': 'dismissed',
	'pullrequest:changes_request_created': 'submitted',
	'pullrequest:changes_request_removed': 'dismissed',
	'pullrequest:comment_created': 'created',
	'repo:commit_status_created': 'created',
	'repo:commit_status_updated': 'updated',
};

/**
 * Review-verdict event key → neutral {@link ScmReviewState}. Both *removal*
 * events map to `dismissed`, which is the neutral vocabulary's name for "a
 * previously submitted verdict no longer stands". Their `dismissed` action
 * keeps them out of the Respond-to-review trigger unconditionally, including
 * when a project opts into responding to minor verdicts.
 */
const REVIEW_STATES: Readonly<Record<string, ScmReviewState>> = {
	'pullrequest:approved': 'approved',
	'pullrequest:unapproved': 'dismissed',
	'pullrequest:changes_request_created': 'changes-requested',
	'pullrequest:changes_request_removed': 'dismissed',
};

/**
 * Bitbucket build-status state → the neutral conclusion vocabulary the queue read
 * model reads (`src/queue/queued-runs.ts` keys on `failure`) and
 * `aggregate-check-decision.ts` classifies. An unrecognized state rides through
 * verbatim, same as an unmapped action.
 */
const CHECK_CONCLUSIONS: Readonly<Record<string, string>> = {
	SUCCESSFUL: 'success',
	FAILED: 'failure',
	INPROGRESS: 'pending',
	STOPPED: 'cancelled',
};

/** Build-status states that mean CI is finished, not still progressing. */
const TERMINAL_COMMIT_STATUS_STATES: ReadonlySet<string> = new Set([
	'SUCCESSFUL',
	'FAILED',
	'STOPPED',
]);

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

function isProcessable(eventKey: string): eventKey is ProcessableEventKey {
	return (PROCESSABLE_EVENT_KEYS as readonly string[]).includes(eventKey);
}

function isCommitStatusEvent(eventKey: ProcessableEventKey): boolean {
	return eventKey === 'repo:commit_status_created' || eventKey === 'repo:commit_status_updated';
}

/**
 * The PR number every `pullrequest:*` event carries as `pullrequest.id`.
 *
 * `undefined` for a build status: a Bitbucket `commit_status` payload carries
 * **no pull-request association at all** (unlike GitHub's
 * `check_suite.pull_requests`), only the commit. Resolving the PR needs a REST
 * lookup — phase 3/4's `listBitbucketPullRequestsForCommit`, called by the
 * ingress layer — so this is a known gap of this phase, not an oversight.
 */
function extractWorkItemId(p: Record<string, unknown>): string | undefined {
	const pr = asRecord(p.pullrequest);
	return pr?.id != null ? String(pr.id) : undefined;
}

/**
 * The login that produced the event. On a review-verdict event the verdict
 * object (`approval` / `changes_request`) names *whose* verdict it is, so it is
 * the authoritative source and `actor` is only the fallback; every other event
 * carries `actor` alone.
 *
 * Always Bitbucket's `nickname`, never `account_id` or `uuid`: persona identities
 * are resolved as nicknames (`./personas.ts`), and loop prevention compares the
 * two, so a value from a different namespace could never match.
 */
function extractActorLogin(p: Record<string, unknown>): string | undefined {
	const verdict = asRecord(p.approval) ?? asRecord(p.changes_request);
	return str(asRecord(verdict?.user)?.nickname) ?? str(asRecord(p.actor)?.nickname);
}

/**
 * What happened, in the neutral vocabulary. A pass-through of
 * {@link EVENT_ACTIONS} except for a build status, which reports `completed`
 * only once its state is terminal — that is the exact pair the Review handler
 * gates on (`kind === 'checks' && action === 'completed'`,
 * `src/triggers/handlers/review.ts`), so an `INPROGRESS` status normalizes and
 * enqueues but matches no trigger instead of waking a review of an unfinished
 * build.
 */
function extractAction(eventKey: ProcessableEventKey, p: Record<string, unknown>): ScmEventAction {
	if (!isCommitStatusEvent(eventKey)) return EVENT_ACTIONS[eventKey];
	const state = str(asRecord(p.commit_status)?.state);
	return state !== undefined && TERMINAL_COMMIT_STATUS_STATES.has(state)
		? 'completed'
		: EVENT_ACTIONS[eventKey];
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

/** Bitbucket's canonical 12-character commit spelling for normalized events. */
function abbreviateSha(sha: string | undefined): string | undefined {
	return sha?.slice(0, 12);
}

/** A PR's head commit hash, normalized to Bitbucket's canonical 12-character spelling. */
function headShaOf(pr: Record<string, unknown> | undefined): string | undefined {
	return abbreviateSha(str(asRecord(asRecord(pr?.source)?.commit)?.hash));
}

function headBranchOf(pr: Record<string, unknown> | undefined): string | undefined {
	return str(asRecord(asRecord(pr?.source)?.branch)?.name);
}

function pullRequestFields(
	eventKey: ProcessableEventKey,
	p: Record<string, unknown>,
): LifecycleFields {
	const pr = asRecord(p.pullrequest);
	const headRepo = str(asRecord(asRecord(pr?.source)?.repository)?.full_name);
	const baseRepo = str(asRecord(asRecord(pr?.destination)?.repository)?.full_name);
	return {
		headSha: headShaOf(pr),
		prBranch: headBranchOf(pr),
		baseBranch: str(asRecord(asRecord(pr?.destination)?.branch)?.name),
		// A fork PR: source and destination live in different repos. Undefined
		// (rather than a guessed `false`) when either repo is missing, same as GitHub's.
		isCrossRepo: headRepo != null && baseRepo != null ? headRepo !== baseRepo : undefined,
		isDraft: typeof pr?.draft === 'boolean' ? pr.draft : undefined,
		prAuthorLogin: str(asRecord(pr?.author)?.nickname),
		// Derived from the event key, not from `pullrequest.state`: Bitbucket splits
		// the two ways a PR closes into distinct keys — `fulfilled` is merged,
		// `rejected` is declined — which is the authoritative signal. An open PR
		// (`created`/`updated`) is definitionally not merged.
		merged: eventKey === 'pullrequest:fulfilled',
	};
}

/**
 * Bitbucket has **no review object**: an approval or change request is an event
 * with a `{ date, user }` verdict, carrying no provider-side identifier. So the
 * review id is synthesized from the four things that identify one verdict — the
 * PR, the verdict, who cast it, and the commit it was cast against.
 *
 * **This format must stay stable across deliveries.** The review-verdict ledger
 * and its two-verdict cap (issue #235,
 * `src/triggers/handlers/respond-to-review.ts`) key on `reviewId`, so changing
 * the composition would make already-answered verdicts look new and re-run the
 * Respond-to-review phase on them.
 *
 * The account component prefers `uuid` (Bitbucket's stable account identifier)
 * over the user-editable `nickname`, precisely because renaming an account must
 * not mint a new id for a verdict already in the ledger.
 */
function synthesizeReviewId(
	prId: string | undefined,
	reviewState: string | undefined,
	user: Record<string, unknown> | undefined,
	headSha: string | undefined,
): string {
	const account =
		str(user?.uuid) ?? str(user?.account_id) ?? str(user?.nickname) ?? UNKNOWN_ID_PART;
	return [
		prId ?? UNKNOWN_ID_PART,
		reviewState ?? UNKNOWN_ID_PART,
		account,
		headSha ?? UNKNOWN_ID_PART,
	].join(':');
}

function reviewFields(eventKey: ProcessableEventKey, p: Record<string, unknown>): LifecycleFields {
	const pr = asRecord(p.pullrequest);
	const headSha = headShaOf(pr);
	const reviewState = REVIEW_STATES[eventKey];
	const verdict = asRecord(p.approval) ?? asRecord(p.changes_request);
	const user = asRecord(verdict?.user) ?? asRecord(p.actor);
	return {
		headSha,
		prBranch: headBranchOf(pr),
		reviewState,
		reviewId: synthesizeReviewId(
			pr?.id != null ? String(pr.id) : undefined,
			reviewState,
			user,
			headSha,
		),
	};
}

/**
 * The commit a build status belongs to. Bitbucket's documented `commit_status`
 * object exposes it only through `links.commit.href` (`…/commit/<sha>`), whose
 * last path segment is the full SHA. It is narrowed to Bitbucket's canonical
 * 12-character event spelling. A `commit.hash` is preferred when a payload does
 * carry one, since it needs no URL parsing.
 */
function commitStatusSha(status: Record<string, unknown> | undefined): string | undefined {
	const hash = str(asRecord(status?.commit)?.hash);
	if (hash !== undefined) return abbreviateSha(hash);
	const href = str(asRecord(asRecord(status?.links)?.commit)?.href);
	if (href === undefined) return undefined;
	const path = href.split(/[?#]/)[0].replace(/\/+$/, '');
	return abbreviateSha(str(path.slice(path.lastIndexOf('/') + 1)));
}

/**
 * A build status carries the commit and its state — and no PR. `prBranch` and
 * `workItemId` therefore stay unset (see {@link extractWorkItemId}), which the
 * ingress layer resolves via phase 3/4's commit→PR lookup.
 */
function commitStatusFields(p: Record<string, unknown>): LifecycleFields {
	const status = asRecord(p.commit_status);
	const state = str(status?.state);
	return {
		headSha: commitStatusSha(status),
		checkConclusion: state === undefined ? undefined : (CHECK_CONCLUSIONS[state] ?? state),
	};
}

/**
 * Pull the phase-relevant lifecycle fields out of a raw webhook body. Each is
 * present only on the event kind that carries it (see the {@link ScmEvent} field
 * docs); everything else stays `undefined`. Kept separate from
 * {@link extractWorkItemId} so the "which fields does which event carry" mapping
 * lives in one readable place rather than being smeared across
 * {@link parseBitbucketWebhook}.
 */
function extractLifecycleFields(
	eventKey: ProcessableEventKey,
	p: Record<string, unknown>,
): LifecycleFields {
	switch (EVENT_KINDS[eventKey]) {
		case 'pull-request':
			return pullRequestFields(eventKey, p);
		case 'pull-request-review':
			return reviewFields(eventKey, p);
		case 'checks':
			return commitStatusFields(p);
		default:
			return {};
	}
}

/**
 * Which header carries what, for Bitbucket. `'unknown'` for a request with no
 * event header, so an unrecognized POST is acknowledged as an unhandled event
 * type rather than crashing the receiver.
 */
export function readBitbucketWebhookRequest(header: WebhookHeaderReader): ScmWebhookRequest {
	const deliveryId = header(REQUEST_UUID_HEADER);
	return {
		eventName: header(EVENT_KEY_HEADER) ?? 'unknown',
		...(deliveryId ? { deliveryId } : {}),
		signature: header(SIGNATURE_HEADER) ?? '',
	};
}

/**
 * Normalize a raw Bitbucket webhook body into an {@link ScmEvent}. `eventKey`
 * comes from the `X-Event-Key` header, not the body. Returns `null` for event
 * keys SWARM doesn't act on — every `issue:*`, `repo:push`, branch, and fork
 * event included — so the caller acknowledges and drops them without branching.
 */
export function parseBitbucketWebhook(eventKey: string, payload: unknown): ScmEvent | null {
	if (!isProcessable(eventKey)) return null;

	const p = asRecord(payload) ?? {};
	const isCommentEvent = eventKey === 'pullrequest:comment_created';
	return {
		kind: EVENT_KINDS[eventKey],
		action: extractAction(eventKey, p),
		repoFullName: str(asRecord(p.repository)?.full_name) ?? 'unknown',
		workItemId: extractWorkItemId(p),
		workItemUrl: str(asRecord(asRecord(asRecord(p.pullrequest)?.links)?.html)?.href),
		actorLogin: extractActorLogin(p),
		isCommentEvent,
		// Bitbucket nests a comment's markdown under `content.raw` (`content.html` is
		// the rendered copy). Carried for loop prevention only — see the field doc.
		commentBody: isCommentEvent ? str(asRecord(asRecord(p.comment)?.content)?.raw) : undefined,
		...extractLifecycleFields(eventKey, p),
	};
}

/**
 * Loop prevention for the *comment* reply loop — Bitbucket's implementation of
 * {@link SCMProvider.isSwarmGeneratedEvent}, which documents why the gate is
 * scoped to comment events and asks about the comment rather than its author
 * (issue #443). The origin test itself is provider-neutral
 * (`src/scm/swarm-origin.ts`): SWARM's own markers travel in the comment body,
 * so they read the same whichever provider delivered it.
 *
 * `async` only to match the contract's shape.
 */
export async function isSwarmGeneratedBitbucketEvent(
	event: ScmEvent,
	_project: ProjectConfig,
): Promise<boolean> {
	if (!event.isCommentEvent) return false;
	return isSwarmGeneratedBody(event.commentBody);
}

/**
 * Verify a Bitbucket webhook signature. Bitbucket signs the raw payload with
 * HMAC-SHA256 and sends `sha256=<hex>` in the `X-Hub-Signature` header (note:
 * un-suffixed, where GitHub's SHA-256 header is `X-Hub-Signature-256`). The
 * framing is Bitbucket's, so it lives here; the timing-safe compare itself stays
 * the provider-neutral `verifyHmac` (`src/webhook/signature-verification.ts`).
 *
 * **Fails closed.** Bitbucket omits the header entirely for a hook configured
 * without a secret, and `verifyHmac` rejects an empty signature — so an unsigned
 * delivery is rejected rather than trusted. That is deliberate: a hook whose
 * secret was never set is indistinguishable from an attacker POSTing to the
 * route.
 *
 * @param rawBody - The raw request body, byte-for-byte as received (re-serializing
 *   parsed JSON would change the bytes and break the signature).
 * @param signature - The `X-Hub-Signature` header value.
 * @param secret - The webhook secret configured on the Bitbucket side.
 */
export function verifyBitbucketSignature(
	rawBody: string,
	signature: string,
	secret: string,
): boolean {
	return verifyHmac({
		algorithm: 'sha256',
		data: rawBody,
		secret,
		signature,
		encoding: 'hex',
		prefix: 'sha256=',
	});
}
