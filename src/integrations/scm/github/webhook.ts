/**
 * GitHub's webhook ingress — the one place raw GitHub webhook vocabulary lives:
 * which header names the event, which event names SWARM acts on, where each
 * lifecycle field sits in the payload, and how GitHub frames its HMAC signature.
 * Everything here is reached only through `GitHubSCMIntegration`'s
 * {@link SCMProvider} methods, so the router, the queue envelope, and the trigger
 * handlers speak nothing but the neutral {@link ScmEvent} (ai/RULES.md §2).
 *
 * Ported from Cascade's `src/router/adapters/github.ts`, which is also where this
 * lived in SWARM before issue #385 moved it under the provider it belongs to.
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

/** Header GitHub delivers the event type in (not carried in the body). */
const EVENT_TYPE_HEADER = 'x-github-event';
/** Header carrying the HMAC-SHA256 signature GitHub signs the raw body with. */
const SIGNATURE_HEADER = 'x-hub-signature-256';
/** Per-delivery id GitHub sends; carried through for idempotency/tracing. */
const DELIVERY_HEADER = 'x-github-delivery';

/** The GitHub webhook event types SWARM acts on. */
export const PROCESSABLE_EVENTS = [
	'pull_request',
	'pull_request_review',
	'issue_comment',
	'issues',
	'check_suite',
] as const;

export type ProcessableEvent = (typeof PROCESSABLE_EVENTS)[number];

/**
 * GitHub event name → neutral {@link ScmEventKind}. The single mapping table that
 * keeps `check_suite` and friends out of shared code; its key set *is*
 * {@link PROCESSABLE_EVENTS}.
 */
const EVENT_KINDS: Readonly<Record<ProcessableEvent, ScmEventKind>> = {
	pull_request: 'pull-request',
	pull_request_review: 'pull-request-review',
	issue_comment: 'work-item-comment',
	issues: 'work-item',
	check_suite: 'checks',
};

/**
 * GitHub action names that differ from the neutral vocabulary. Everything else
 * GitHub sends (`opened`, `closed`, `submitted`, `completed`, `created`, `edited`,
 * `labeled`, `unlabeled`) is already the neutral spelling, and an action SWARM
 * doesn't act on rides through verbatim (see {@link ScmEventAction}).
 */
const ACTION_ALIASES: Readonly<Record<string, ScmEventAction>> = {
	synchronize: 'updated',
};

/** GitHub review states that differ from the neutral vocabulary. */
const REVIEW_STATE_ALIASES: Readonly<Record<string, ScmReviewState>> = {
	changes_requested: 'changes-requested',
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function isProcessable(eventType: string): eventType is ProcessableEvent {
	return (PROCESSABLE_EVENTS as readonly string[]).includes(eventType);
}

function extractWorkItemId(
	eventType: ProcessableEvent,
	p: Record<string, unknown>,
): string | undefined {
	const pr = asRecord(p.pull_request);
	if (pr?.number != null) return String(pr.number);

	if (eventType === 'issue_comment' || eventType === 'issues') {
		const issue = asRecord(p.issue);
		if (issue?.number != null) return String(issue.number);
	}

	if (eventType === 'check_suite') {
		const suite = asRecord(p.check_suite);
		const prs = suite?.pull_requests as Array<Record<string, unknown>> | undefined;
		if (prs && prs.length > 0 && prs[0].number != null) return String(prs[0].number);
	}

	return undefined;
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
	workItemBodyChanged?: boolean;
	labelName?: string;
}

function issueFields(p: Record<string, unknown>): LifecycleFields {
	const changes = asRecord(p.changes);
	return {
		workItemBodyChanged: changes ? Object.hasOwn(changes, 'body') : false,
		labelName: (asRecord(p.label)?.name as string) ?? undefined,
	};
}

function pullRequestFields(p: Record<string, unknown>): LifecycleFields {
	const pr = asRecord(p.pull_request);
	const head = asRecord(pr?.head);
	const headRepo = asRecord(head?.repo)?.full_name as string | undefined;
	const baseRepo = asRecord(asRecord(pr?.base)?.repo)?.full_name as string | undefined;
	return {
		headSha: (head?.sha as string) ?? undefined,
		prBranch: (head?.ref as string) ?? undefined,
		// A fork PR: head and base live in different repos. Undefined (rather than a
		// guessed `false`) when either repo is missing from the payload.
		isCrossRepo: headRepo != null && baseRepo != null ? headRepo !== baseRepo : undefined,
		isDraft: typeof pr?.draft === 'boolean' ? pr.draft : undefined,
		prAuthorLogin: (asRecord(pr?.user)?.login as string) ?? undefined,
		baseBranch: (asRecord(pr?.base)?.ref as string) ?? undefined,
		merged: typeof pr?.merged === 'boolean' ? pr.merged : undefined,
	};
}

function reviewFields(p: Record<string, unknown>): LifecycleFields {
	const review = asRecord(p.review);
	const head = asRecord(asRecord(p.pull_request)?.head);
	const state = (review?.state as string) ?? undefined;
	return {
		headSha: (head?.sha as string) ?? (review?.commit_id as string) ?? undefined,
		prBranch: (head?.ref as string) ?? undefined,
		reviewState: state === undefined ? undefined : (REVIEW_STATE_ALIASES[state] ?? state),
		reviewId: review?.id != null ? String(review.id) : undefined,
	};
}

function checkSuiteFields(p: Record<string, unknown>): LifecycleFields {
	const suite = asRecord(p.check_suite);
	// `check_suite.pull_requests[0]` is the PR the suite ran for — same array
	// `extractWorkItemId` reads the number from. Its `head.ref` is the branch the
	// Respond-to-CI phase checks out to push a build fix (`src/pipeline/respond-to-ci.ts`);
	// a passing suite routes to Review, which pins to the SHA and never needs it.
	const prs = suite?.pull_requests as Array<Record<string, unknown>> | undefined;
	const prBranch = prs && prs.length > 0 ? (asRecord(prs[0]?.head)?.ref as string) : undefined;
	return {
		headSha: (suite?.head_sha as string) ?? undefined,
		checkConclusion: (suite?.conclusion as string) ?? undefined,
		prBranch: prBranch ?? undefined,
	};
}

/**
 * Pull the phase-relevant lifecycle fields out of a raw webhook body. Each is
 * present only on the event type that carries it (see the {@link ScmEvent} field
 * docs); everything else stays `undefined`. Kept separate from
 * {@link extractWorkItemId} so the "which fields does which event carry" mapping
 * lives in one readable place rather than being smeared across
 * {@link parseGitHubWebhook}.
 */
function extractLifecycleFields(
	eventType: ProcessableEvent,
	p: Record<string, unknown>,
): LifecycleFields {
	switch (eventType) {
		case 'pull_request':
			return pullRequestFields(p);
		case 'pull_request_review':
			return reviewFields(p);
		case 'check_suite':
			return checkSuiteFields(p);
		case 'issues':
			return issueFields(p);
		default:
			return {};
	}
}

/**
 * Which header carries what, for GitHub. `'unknown'` for a request with no event
 * header, so an unrecognized POST is acknowledged as an unhandled event type
 * rather than crashing the receiver.
 */
export function readGitHubWebhookRequest(header: WebhookHeaderReader): ScmWebhookRequest {
	const deliveryId = header(DELIVERY_HEADER);
	return {
		eventName: header(EVENT_TYPE_HEADER) ?? 'unknown',
		...(deliveryId ? { deliveryId } : {}),
		signature: header(SIGNATURE_HEADER) ?? '',
	};
}

/**
 * Normalize a raw GitHub webhook body into an {@link ScmEvent}. `eventType` comes
 * from the `X-GitHub-Event` header, not the body. Returns `null` for event types
 * SWARM doesn't act on, so the caller can drop them without branching.
 */
export function parseGitHubWebhook(eventType: string, payload: unknown): ScmEvent | null {
	if (!isProcessable(eventType)) return null;

	const p = asRecord(payload) ?? {};
	const repo = asRecord(p.repository);
	const repoFullName = (repo?.full_name as string) ?? 'unknown';
	const actorLogin = (asRecord(p.sender)?.login as string) ?? undefined;
	const issue = asRecord(p.issue);
	const pullRequest = asRecord(p.pull_request);
	const action = (p.action as string) ?? undefined;

	return {
		kind: EVENT_KINDS[eventType],
		action: action === undefined ? undefined : (ACTION_ALIASES[action] ?? action),
		repoFullName,
		workItemId: extractWorkItemId(eventType, p),
		workItemUrl: ((issue?.html_url as string) ?? (pullRequest?.html_url as string)) || undefined,
		actorLogin,
		isCommentEvent: eventType === 'issue_comment',
		commentBody:
			eventType === 'issue_comment'
				? ((asRecord(p.comment)?.body as string) ?? undefined)
				: undefined,
		...extractLifecycleFields(eventType, p),
	};
}

/**
 * Loop prevention for the *comment* reply loop — GitHub's implementation of
 * {@link SCMProvider.isSwarmGeneratedEvent}, which documents why the gate is
 * scoped to comment events and asks about the comment rather than its author
 * (issue #443).
 *
 * `async` only to match the contract's shape, which the PM adapter's
 * still-identity-based gate shares.
 */
export async function isSwarmGeneratedGitHubEvent(
	event: ScmEvent,
	_project: ProjectConfig,
): Promise<boolean> {
	if (!event.isCommentEvent) return false;
	return isSwarmGeneratedBody(event.commentBody);
}

/**
 * Verify a GitHub webhook signature. GitHub signs the raw payload with
 * HMAC-SHA256 and sends `sha256=<hex>` in the `X-Hub-Signature-256` header. The
 * framing is GitHub's, so it lives here; the timing-safe compare itself stays the
 * provider-neutral `verifyHmac` (`src/webhook/signature-verification.ts`).
 *
 * @param rawBody - The raw request body, byte-for-byte as received (re-serializing
 *   parsed JSON would change the bytes and break the signature).
 * @param signature - The `X-Hub-Signature-256` header value.
 * @param secret - The webhook secret configured on the GitHub side.
 */
export function verifyGitHubSignature(rawBody: string, signature: string, secret: string): boolean {
	return verifyHmac({
		algorithm: 'sha256',
		data: rawBody,
		secret,
		signature,
		encoding: 'hex',
		prefix: 'sha256=',
	});
}
