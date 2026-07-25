/**
 * GitHubRouterAdapter — the router-side GitHub logic, ported (and trimmed to
 * SWARM's MVP) from Cascade's `src/router/adapters/github.ts`.
 *
 * Its job for the five inbound event types (`pull_request`,
 * `pull_request_review`, `issue_comment`, `issues`, `check_suite`) is: parse the
 * raw webhook into a normalized event, resolve which SWARM project owns the repo,
 * decide whether the event was one SWARM produced itself (loop prevention), and
 * run a handler under the right persona's credentials. The actual trigger →
 * agent-type routing that decides *what* to do with an event lands with the
 * trigger registry (a later phase); this adapter owns everything up to and
 * including "which persona acts, and never on our own output".
 */

import { z } from 'zod';
import { findProjectByRepo } from '../../config/provider.js';
import type { ProjectConfig } from '../../config/schema.js';
import {
	type GitHubPersona,
	getPersonaForLogin,
	type PersonaIdentities,
} from '../../integrations/scm/github/personas.js';
import { GitHubSCMIntegration } from '../../integrations/scm/github/scm-integration.js';
import { isSwarmGeneratedBody } from '../../scm/swarm-origin.js';

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
 * A raw webhook parsed into the fields the router pipeline needs. A Zod schema
 * (not a hand-written interface) because the parsed event rides inside a queue
 * job across the router→Redis→worker boundary (`src/queue/jobs.ts`), and shapes
 * that cross a boundary keep schema and type in one place
 * (ai/CODING_STANDARDS.md "Zod is the source of truth").
 */
export const GitHubParsedEventSchema = z.object({
	eventType: z.enum(PROCESSABLE_EVENTS),
	/** The webhook `action` (e.g. `opened`, `submitted`, `completed`), if present. */
	action: z.string().optional(),
	/** Repository as `owner/repo`. */
	repoFullName: z.string(),
	/** PR/issue number as a string, when the event carries one. */
	workItemId: z.string().optional(),
	/** Web URL of the backing issue/PR, when the event carries one. */
	workItemUrl: z.string().optional(),
	/** Login of the account that produced the event (`sender.login`). */
	actorLogin: z.string().optional(),
	/** Comment-carrying events (`issue_comment`) — the ones a persona can author in reply. */
	isCommentEvent: z.boolean(),
	/**
	 * The comment's raw markdown body, populated for `issue_comment` events only.
	 * It exists solely for loop prevention ({@link GitHubRouterAdapter.isSelfAuthored}),
	 * which asks whether SWARM generated this comment rather than who posted it —
	 * no trigger handler reads comment text, so don't grow handler logic on it.
	 */
	commentBody: z.string().optional(),

	// --- Fields the pipeline-phase trigger handlers (SWARM-53) read. All
	// optional and populated per event type: the Review handler needs the head
	// SHA and the fork gate; the Respond-to-review handler needs the PR branch,
	// the submitted review's state, and its ID. They ride in the parsed event
	// (rather than a re-fetch in the handler) because the raw webhook already
	// carries them and the event is the queue job's payload — a re-fetch would
	// be a second GitHub round-trip for data we just discarded.

	/**
	 * The PR head commit SHA — `pull_request.head.sha` on a `pull_request` event,
	 * `pull_request.head.sha` (falling back to the review's pinned `commit_id`) on a
	 * `pull_request_review` event, and `check_suite.head_sha` on a `check_suite`
	 * event. What the Review phase pins its detached checkout to
	 * (`src/pipeline/review.ts`), and what the Respond-to-review trigger's
	 * review-verdict cap lookup falls back to when a submitted review's id isn't
	 * yet in the ledger (issue #235).
	 */
	headSha: z.string().optional(),
	/**
	 * The PR head branch — the existing task branch the Respond-to-review phase
	 * (`src/pipeline/respond-to-review.ts`) and the Respond-to-CI phase
	 * (`src/pipeline/respond-to-ci.ts`) check out and push fixes to. Read from
	 * `pull_request.head.ref` on a `pull_request`/`pull_request_review` event and
	 * from `check_suite.pull_requests[0].head.ref` on a `check_suite` event.
	 */
	prBranch: z.string().optional(),
	/**
	 * True when the PR's head repo differs from its base repo — a fork PR. The
	 * Review handler drops these: `provision`'s `git fetch origin` only fetches
	 * the base repo's refs, so a fork's head SHA is unreachable and the detached
	 * checkout would fail the job (see `src/pipeline/review.ts`'s header). Only
	 * populated for `pull_request` events, where both repos are in the payload.
	 */
	isCrossRepo: z.boolean().optional(),
	/**
	 * A submitted review's state (`approved` | `changes_requested` | `commented`
	 * | `dismissed`) on a `pull_request_review` event. The Respond-to-review
	 * handler acts on everything except `approved`.
	 */
	reviewState: z.string().optional(),
	/**
	 * A submitted review's numeric ID as a string (`review.id`) — pins the
	 * Respond-to-review phase to the one batched review it must answer.
	 */
	reviewId: z.string().optional(),
	/**
	 * A `check_suite` event's own aggregate conclusion (`success` | `failure` |
	 * …) — carried for tracing. The Review handler does *not* gate on it: because
	 * GitHub fires one event per workflow, a single suite's conclusion isn't the
	 * whole picture, so the handler re-queries every check on the head SHA
	 * instead (`getCheckSuiteStatus` + `check-suite-decision.ts`).
	 */
	checkConclusion: z.string().optional(),
	/**
	 * Whether a `pull_request` is a draft (`pull_request.draft`). The Review
	 * handler skips drafts — they aren't ready for review yet.
	 */
	isDraft: z.boolean().optional(),
	/**
	 * The login that opened the PR (`pull_request.user.login`), populated only for
	 * `pull_request` events — the `check_suite` payload carries no author.
	 * Tracing/log data only: the Review handler's ownership gate keys on the PR's
	 * work-item origin (head branch + Implementation run history), not on the
	 * author, since a federated PR is opened by the worker operator's own account
	 * (issue #397).
	 */
	prAuthorLogin: z.string().optional(),
	/** Base branch of a pull request, used by the conflict-resolution side-car. */
	baseBranch: z.string().optional(),
	/** Whether a closed pull request was actually merged. */
	merged: z.boolean().optional(),
	/** Whether an `issues.edited` event changed the issue body. */
	workItemBodyChanged: z.boolean().optional(),
	/** Label added/removed by an `issues` event, when present. */
	labelName: z.string().optional(),
	/** Candidate PR number on a synthetic conflict-mergeability recheck job. */
	conflictPrNumber: z.string().optional(),
});

export type GitHubParsedEvent = z.infer<typeof GitHubParsedEventSchema>;

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

/** The phase-relevant lifecycle fields a handler may read off a parsed event. */
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
	return {
		headSha: (head?.sha as string) ?? (review?.commit_id as string) ?? undefined,
		prBranch: (head?.ref as string) ?? undefined,
		reviewState: (review?.state as string) ?? undefined,
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
 * present only on the event type that carries it (see the schema field docs);
 * everything else stays `undefined`. Kept separate from {@link extractWorkItemId}
 * so the "which fields does which event carry" mapping lives in one readable
 * place rather than being smeared across `parseWebhook`.
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

export class GitHubRouterAdapter {
	readonly type = 'github' as const;

	private readonly scm = new GitHubSCMIntegration();

	/**
	 * Normalize a raw webhook body into a `GitHubParsedEvent`. `eventType` comes
	 * from the `X-GitHub-Event` header, not the body. Returns `null` for event
	 * types SWARM doesn't act on, so the caller can drop them without branching.
	 */
	parseWebhook(eventType: string, payload: unknown): GitHubParsedEvent | null {
		if (!isProcessable(eventType)) return null;

		const p = asRecord(payload) ?? {};
		const repo = asRecord(p.repository);
		const repoFullName = (repo?.full_name as string) ?? 'unknown';
		const actorLogin = (asRecord(p.sender)?.login as string) ?? undefined;
		const issue = asRecord(p.issue);
		const pullRequest = asRecord(p.pull_request);

		return {
			eventType,
			action: (p.action as string) ?? undefined,
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

	/** Resolve the SWARM project that owns the event's repo, or `null` if untracked. */
	async resolveProject(event: GitHubParsedEvent): Promise<ProjectConfig | null> {
		return (await findProjectByRepo(event.repoFullName)) ?? null;
	}

	/**
	 * Loop prevention for the *comment* reply loop: whether SWARM itself generated
	 * this comment, so the router can drop it instead of treating it as new human
	 * input. This is a **drop gate**, and it is deliberately scoped to comment
	 * events (mirroring Cascade) — SWARM's own ack/reply comments are what create
	 * the runaway feedback loop.
	 *
	 * **It asks about the comment, not its author** (issue #443). It used to match
	 * `event.actorLogin` against the project's persona logins, which stopped
	 * working once the implementer credential became the worker operator's own
	 * GitHub token (ADR-004 §2, issue #396): the operator's *hand-written* comments
	 * were dropped as SWARM's, and comments SWARM delivered through another
	 * operator's account were not recognised at all. Instead the gate reads the
	 * comment's own SWARM-origin marker (`isSwarmGeneratedBody`,
	 * `src/scm/swarm-origin.ts`), so it holds for any posting account — and needs no
	 * credential, so there is no identity resolution left to fail.
	 *
	 * It intentionally does *not* fire for `pull_request` / `pull_request_review`
	 * / `check_suite` events even when SWARM produced them: those must flow
	 * through so the *other* persona can act (the implementer opens a PR → the
	 * reviewer reviews it; the reviewer requests changes → the implementer
	 * responds). That cross-persona routing is `personaForEvent`'s job, not this
	 * gate's — using `isSelfAuthored` as a blanket drop for lifecycle events
	 * would suppress exactly the events the pipeline depends on.
	 *
	 * `async` only to keep the shape the webhook receiver shares with the PM
	 * adapter's still-identity-based gate (`WebhookReceiverDeps`).
	 */
	async isSelfAuthored(event: GitHubParsedEvent, _project: ProjectConfig): Promise<boolean> {
		if (!event.isCommentEvent) return false;
		return isSwarmGeneratedBody(event.commentBody);
	}

	/**
	 * Which SWARM persona, if any, authored the event — the routing primitive
	 * behind "the reviewer's changes_requested goes back to the implementer".
	 * Returns `null` for human-authored events (and events with no actor).
	 */
	personaForEvent(event: GitHubParsedEvent, identities: PersonaIdentities): GitHubPersona | null {
		if (!event.actorLogin) return null;
		return getPersonaForLogin(event.actorLogin, identities);
	}

	/**
	 * Run `fn` under `persona`'s GitHub credentials for the event's project.
	 * This is the dispatch seam: whatever handles the event does its GitHub work
	 * inside here, so every call authenticates as the acting persona.
	 */
	async dispatchWithPersona<T>(
		project: ProjectConfig,
		persona: GitHubPersona,
		fn: () => Promise<T>,
	): Promise<T> {
		return this.scm.withPersonaCredentials(project, persona, fn);
	}
}
