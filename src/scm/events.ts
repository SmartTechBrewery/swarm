/**
 * ScmEvent — the provider-neutral normalized inbound SCM event, and the runtime
 * (Zod) half of the SCM contract whose type-only half is `src/scm/types.ts`
 * (issue #385).
 *
 * A provider's adapter turns its own raw webhook — GitHub's `pull_request` /
 * `check_suite` bodies, GitLab's merge-request hooks — into one of these, and
 * every downstream consumer (the enqueue seam, the durable queue envelope, the
 * trigger registry, the queue read model) speaks only this shape. That's what
 * keeps raw provider event names, headers, and payload paths inside the adapter
 * (ai/RULES.md §2 "Source-control features must not hard-code GitHub").
 *
 * A Zod schema rather than a hand-written interface because a normalized event
 * *is* SWARM's durable queue payload (`src/queue/jobs.ts`) — it crosses the
 * router→Postgres/Redis→worker boundary, and shapes that cross a boundary keep
 * schema and type in one place (ai/CODING_STANDARDS.md "Zod is the source of
 * truth").
 *
 * Kept separate from `src/scm/types.ts` on purpose: that module is types-only so
 * it adds no runtime import edge (`src/config/provider.ts` depends on it), while
 * this one carries Zod.
 */

import { z } from 'zod';
import type { ScmType } from './types.js';

/**
 * The Zod mirror of the contract's {@link ScmType}. Annotated with the contract
 * type so the two can't drift: adding a provider to one without the other stops
 * type-checking.
 */
export const ScmProviderIdSchema: z.ZodType<ScmType> = z.enum(['github', 'bitbucket', 'gitlab']);

/**
 * The inbound event kinds SWARM acts on, named for the domain concept rather
 * than any provider's own event name (ai/RULES.md §2). Each provider maps its
 * own vocabulary onto these in its adapter — GitHub's `pull_request` →
 * `pull-request`, `check_suite` → `checks`, `issues` → `work-item`.
 *
 * `checks` is deliberately the aggregate concept: a provider fires one event per
 * CI workflow, so a single event's own conclusion is never the whole picture and
 * the trigger re-reads {@link import('./types.js').AggregateCheckStatus}.
 */
export const SCM_EVENT_KINDS = [
	'pull-request',
	'pull-request-review',
	'work-item',
	'work-item-comment',
	'checks',
] as const;

export const ScmEventKindSchema = z.enum(SCM_EVENT_KINDS);
export type ScmEventKind = z.infer<typeof ScmEventKindSchema>;

/**
 * The neutral action vocabulary an adapter maps its provider's action names
 * onto. Deliberately *not* a closed enum on {@link ScmEventSchema}: a provider
 * emits many actions SWARM doesn't act on (`reopened`, `assigned`,
 * `review_requested`, …), and those must still normalize, enqueue, and complete
 * as `no-trigger` rather than fail the durable envelope's validation. An action
 * outside this list rides through verbatim as an opaque tracing value that
 * matches no trigger.
 */
export type ScmEventAction =
	| 'opened'
	| 'updated'
	| 'closed'
	| 'submitted'
	| 'dismissed'
	| 'completed'
	| 'created'
	| 'edited'
	| 'labeled'
	| 'unlabeled';

/** The neutral verdict vocabulary for a submitted review ({@link ScmEvent.reviewState}). */
export type ScmReviewState = 'approved' | 'changes-requested' | 'commented' | 'dismissed';

const scmEventShape = z.object({
	/** Which domain event this is — see {@link SCM_EVENT_KINDS}. */
	kind: ScmEventKindSchema,
	/**
	 * What happened to it, in the neutral vocabulary ({@link ScmEventAction}) when
	 * the provider's action maps onto one, and verbatim otherwise.
	 */
	action: z.string().optional(),
	/** Repository as `owner/repo` (a provider's namespaced project path). */
	repoFullName: z.string(),
	/** PR/issue number as a string, when the event carries one. */
	workItemId: z.string().optional(),
	/** Web URL of the backing issue/PR, when the event carries one. */
	workItemUrl: z.string().optional(),
	/** Login of the account that produced the event. */
	actorLogin: z.string().optional(),
	/** Comment-carrying events — the ones a persona can author in reply. */
	isCommentEvent: z.boolean(),
	/**
	 * The comment's raw markdown body, populated for `work-item-comment` events
	 * only. It exists solely for loop prevention
	 * ({@link import('./types.js').SCMProvider.isSwarmGeneratedEvent}), which asks
	 * whether SWARM generated this comment rather than who posted it — no trigger
	 * handler reads comment text, so don't grow handler logic on it.
	 */
	commentBody: z.string().optional(),

	// --- Fields the pipeline-phase trigger handlers read. All optional and
	// populated per event kind: the Review handler needs the head SHA and the fork
	// gate; the Respond-to-review handler needs the PR branch, the submitted
	// review's state, and its ID. They ride in the normalized event (rather than a
	// re-fetch in the handler) because the raw webhook already carries them and the
	// event is the queue job's payload — a re-fetch would be a second provider
	// round-trip for data we just discarded.

	/**
	 * The PR head commit SHA. What the Review phase pins its detached checkout to
	 * (`src/pipeline/review.ts`), and what the Respond-to-review trigger's
	 * review-verdict cap lookup falls back to when a submitted review's id isn't
	 * yet in the ledger (issue #235).
	 */
	headSha: z.string().optional(),
	/**
	 * The PR head branch — the existing task branch the Respond-to-review phase
	 * (`src/pipeline/respond-to-review.ts`) and the Respond-to-CI phase
	 * (`src/pipeline/respond-to-ci.ts`) check out and push fixes to.
	 */
	prBranch: z.string().optional(),
	/**
	 * True when the PR's head repo differs from its base repo — a fork PR. The
	 * Review handler drops these: `provision`'s fetch only covers the base repo's
	 * refs, so a fork's head SHA is unreachable and the detached checkout would
	 * fail the job (see `src/pipeline/review.ts`'s header). Only populated when the
	 * payload names both repos.
	 */
	isCrossRepo: z.boolean().optional(),
	/**
	 * A submitted review's verdict — {@link ScmReviewState} when the provider's own
	 * state maps onto one, verbatim otherwise. The Respond-to-review handler acts
	 * on everything except `approved`.
	 */
	reviewState: z.string().optional(),
	/**
	 * A submitted review's id as a string — pins the Respond-to-review phase to the
	 * one batched review it must answer.
	 */
	reviewId: z.string().optional(),
	/**
	 * A `checks` event's own reported conclusion (`success` | `failure` | …) —
	 * carried for tracing. The Review handler does *not* gate on it: because a
	 * provider fires one event per workflow, a single event's conclusion isn't the
	 * whole picture, so the handler re-queries every check on the head SHA
	 * (`getAggregateCheckStatus` + `aggregate-check-decision.ts`) instead.
	 */
	checkConclusion: z.string().optional(),
	/** Whether a pull request is a draft. The Review handler skips drafts. */
	isDraft: z.boolean().optional(),
	/**
	 * The login that opened the PR, populated only for `pull-request` events.
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
	/** Whether a `work-item` `edited` event changed the item's body. */
	workItemBodyChanged: z.boolean().optional(),
	/** Label added/removed by a `work-item` event, when present. */
	labelName: z.string().optional(),
	/** Candidate PR number on a synthetic conflict-mergeability recheck job. */
	conflictPrNumber: z.string().optional(),
});

// ============================================================================
// Legacy durable envelope
// ============================================================================

/**
 * SWARM's pre-#385 wire encoding of a normalized event, when GitHub was the only
 * provider and its raw event names *were* the wire format (`eventType:
 * 'pull_request'`). Durable dispatch rows and historical `runs.jobPayload`
 * snapshots still carry it — a dependency recheck can wait days, and a "Retry
 * now" re-parses a run's stored payload indefinitely — so the schema reads it and
 * upgrades in place rather than failing a deploy's in-flight work.
 *
 * These tables are the *queue's own* frozen serialization history, not provider
 * logic: do not extend them. A second provider maps its vocabulary in its own
 * adapter ({@link import('./types.js').SCMProvider.parseWebhookEvent}).
 */
const LEGACY_EVENT_KIND_BY_NAME: Readonly<Record<string, ScmEventKind>> = {
	pull_request: 'pull-request',
	pull_request_review: 'pull-request-review',
	issues: 'work-item',
	issue_comment: 'work-item-comment',
	check_suite: 'checks',
};

/** Legacy action names that were GitHub's own spelling rather than the neutral one. */
const LEGACY_ACTION_BY_NAME: Readonly<Record<string, ScmEventAction>> = {
	synchronize: 'updated',
};

/** Legacy review states that were GitHub's own spelling rather than the neutral one. */
const LEGACY_REVIEW_STATE_BY_NAME: Readonly<Record<string, ScmReviewState>> = {
	changes_requested: 'changes-requested',
};

/**
 * Translate one legacy value through its alias table, passing an unaliased string
 * through verbatim. `undefined` for a non-string, so the caller can tell "nothing
 * to rewrite" from "rewrote to this" and leave a malformed value for the schema to
 * reject.
 */
function remap(value: unknown, table: Readonly<Record<string, string>>): string | undefined {
	return typeof value === 'string' ? (table[value] ?? value) : undefined;
}

/**
 * Upgrade a legacy-encoded event to the neutral shape. Recognized by the legacy
 * `eventType` key in the absence of `kind`; anything already neutral (and any
 * non-object) passes through untouched. An unrecognized legacy event name is left
 * alone so the enum rejects it loudly rather than silently mapping to a wrong kind.
 */
export function upgradeLegacyScmEvent(value: unknown): unknown {
	if (typeof value !== 'object' || value === null) return value;
	const raw = value as Record<string, unknown>;
	if (!('eventType' in raw) || 'kind' in raw) return value;

	const { eventType, ...rest } = raw;
	const action = remap(rest.action, LEGACY_ACTION_BY_NAME);
	const reviewState = remap(rest.reviewState, LEGACY_REVIEW_STATE_BY_NAME);
	return {
		...rest,
		kind: remap(eventType, LEGACY_EVENT_KIND_BY_NAME) ?? eventType,
		...(action === undefined ? {} : { action }),
		...(reviewState === undefined ? {} : { reviewState }),
	};
}

/**
 * The normalized event, accepting either the neutral encoding or the legacy
 * durable one (see {@link upgradeLegacyScmEvent}).
 */
export const ScmEventSchema = z.preprocess(upgradeLegacyScmEvent, scmEventShape);

export type ScmEvent = z.infer<typeof scmEventShape>;
