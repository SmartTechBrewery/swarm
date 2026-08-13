/**
 * Preplanned split-child contract (docs/OPTIMIZATION.md §3), plus the two board
 * labels Planning writes.
 *
 * When Planning splits a large item, the parent run has already explored the
 * repository and decided how the work decomposes — so it writes a concise plan
 * for every child while that context is live, instead of making each child
 * launch its own full Planning agent run and repeat the discovery. This module
 * owns the durable, structured artifact that carries that decision to the child:
 * a validated contract embedded as a hidden marker in the child's issue body
 * (the work item's `description`, which round-trips through the PM provider's
 * `createWorkItem`/`getWorkItem`/`updateWorkItem` → issue `body`). The child's
 * own Planning run reads and validates it and skips the agent CLI when it holds
 * up (see {@link evaluatePreplan}, consumed by `runPlanningPhase`).
 *
 * **The contract is content, not a gate** (issue #737). It answers "can this
 * Planning run reuse a plan instead of spending an agent?" — and nothing else.
 * Whether a card entering Planning is dispatched at all is decided one level up,
 * by {@link PLANNED_LABEL} alone (`src/triggers/handlers/pm-status.ts`). The two
 * questions were previously entangled: the trigger evaluated this contract, an
 * operator invalidated it with a `swarm:replan` label, and a third handler
 * existed to observe that label edit — on a webhook event the repository never
 * subscribed to, so it could not fire. One label replaces all three.
 *
 * The labels live here rather than in `src/pipeline/planning.ts` (which
 * re-exports both) so trigger code can read them without pulling the Planning
 * phase's worktree/agent-CLI module graph into the router process.
 *
 * The contract is deliberately *structured and validated* rather than inferred
 * from the `swarm:split-child` label or a free-form comment (issue #178): Zod is
 * the source of truth for the on-marker shape (ai/CODING_STANDARDS.md), and a
 * malformed/stale/mismatched marker fails closed to a normal Planning run rather
 * than being trusted. It is embedded in the body — not written to the worktree
 * like `proposed_split.json` — because a split child is created by SWARM and
 * planned later from a fresh checkout that no longer has the parent's worktree;
 * the issue body is the only state that durably travels with the child to its
 * own Planning run.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';
import type { WorkItem } from '@/pm/types.js';

/** Label that identifies a sibling created by Planning's automatic split. */
export const SPLIT_CHILD_LABEL = 'swarm:split-child';

/**
 * Label a card carries once it holds a plan — **the single gate on the Planning
 * phase** (issue #737).
 *
 * Written by every successful Planning run (`applyPlannedLabel`) and by the
 * split that hands a child its parent's plan (`markSplitChildPlanned`), both in
 * `src/pipeline/planning.ts`. Read by exactly one place: the PM status trigger
 * (`src/triggers/handlers/pm-status.ts`), which dispatches Planning for a card
 * entering that status **unless** the card already carries this label.
 *
 * So the operator-facing rule is one sentence: *to re-plan a card, remove
 * `planned` and move it Backlog → Planning.* That replaces the three concepts it
 * took before — this contract as a dispatch gate, a `swarm:replan` label to
 * invalidate it, and a `preplan-invalidated` trigger to notice the label edit —
 * one of which could never fire, because a label or body edit arrives on the
 * `issues` webhook event the repository does not subscribe to.
 *
 * A fixed constant, not a config option: the smallest durable change, with no
 * speculative setting.
 */
export const PLANNED_LABEL = 'planned';

/**
 * Delimiters of the hidden HTML-comment block the contract is embedded in. An
 * HTML comment is invisible in GitHub's rendered issue body, so the marker adds
 * no visible clutter for a human reading the child issue. (This invisibility is
 * a cosmetic GitHub-flavored-markdown assumption — Jira/Trello would render the
 * comment literally; the contract still round-trips correctly via `description`
 * on any provider.) The `:v1` suffix is part of the open token so a future
 * format revision uses a distinct token an older reader simply won't match
 * (falling back to a normal run).
 *
 * The payload between the delimiters is base64-encoded (not raw JSON) so the
 * plan's own content can never collide with the frame: a plan containing `-->`
 * (a mermaid `A --> B` arrow) or the literal open token would otherwise truncate
 * or shadow the marker and defeat the optimization on plausible inputs.
 */
const PREPLAN_MARKER_OPEN = '<!-- swarm-preplan:v1';
const PREPLAN_MARKER_CLOSE = '-->';

/**
 * The preplanned contract embedded in a split child's issue body. `.strict()`
 * so an unexpected field fails validation (fail-closed to a normal run) rather
 * than being silently ignored.
 *
 * - `itemUrl` binds the marker to its own child (verified against the work
 *   item's `url`) so a marker copied onto a different issue is rejected — this
 *   is the checkable "does this belong to the current child" test.
 * - `descriptionHash` pins the human-authored description the plan was written
 *   against, so a later material edit to the child's scope stops the plan from
 *   being *reused* and the dispatched run plans from scratch instead.
 *   Deterministic on purpose — no classifier model is spent to decide whether to
 *   spend a model (docs/OPTIMIZATION.md governing principle). Kept when the
 *   label became the gate (issue #737), because it answers a different question:
 *   the label says whether to dispatch, the hash says whether the plan this
 *   dispatch found is still about the same work. A card an operator wants
 *   re-planned outright is re-planned the one documented way — remove `planned`,
 *   move it Backlog → Planning.
 * - `splitId`/`childIndex`/`parentUrl`/`generatedAt` are provenance for logging
 *   and debugging the split operation a child came from.
 */
export const PreplanContractSchema = z
	.object({
		version: z.literal(1),
		splitId: z.string().min(1),
		childIndex: z.number().int().nonnegative(),
		parentUrl: z.string().min(1),
		itemUrl: z.string().min(1),
		descriptionHash: z.string().min(1),
		plan: z.string().trim().min(1),
		generatedAt: z.string().min(1),
	})
	.strict();
export type PreplanContract = z.infer<typeof PreplanContractSchema>;

/**
 * Stable hash of a child's human-authored description, normalized so trivial
 * whitespace/line-ending churn doesn't spuriously invalidate a plan. Any
 * material edit still changes the hash and forces a re-plan — over-triggering a
 * (safe) fresh Planning run is preferable to trusting a plan written against
 * different scope.
 */
export function hashDescription(text: string): string {
	const normalized = text.replace(/\r\n/g, '\n').trim();
	return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Build (and validate) a preplanned contract for one split child. `splitId` and
 * `generatedAt` are passed in rather than generated here so the caller controls
 * the clock/id source and the function stays pure/testable.
 */
export function buildPreplanContract(input: {
	splitId: string;
	childIndex: number;
	parentUrl: string;
	itemUrl: string;
	humanDescription: string;
	plan: string;
	generatedAt: string;
}): PreplanContract {
	return PreplanContractSchema.parse({
		version: 1,
		splitId: input.splitId,
		childIndex: input.childIndex,
		parentUrl: input.parentUrl,
		itemUrl: input.itemUrl,
		descriptionHash: hashDescription(input.humanDescription),
		plan: input.plan,
		generatedAt: input.generatedAt,
	});
}

/**
 * Return the child's issue body with the contract appended as a hidden marker,
 * preserving the human-authored description above it. The `descriptionHash` in
 * the contract must have been computed over this same `humanDescription`.
 */
export function embedPreplanMarker(humanDescription: string, contract: PreplanContract): string {
	const payload = Buffer.from(JSON.stringify(contract), 'utf8').toString('base64');
	const block = `${PREPLAN_MARKER_OPEN}\n${payload}\n${PREPLAN_MARKER_CLOSE}`;
	const human = humanDescription.trimEnd();
	return human.length === 0 ? block : `${human}\n\n${block}`;
}

/**
 * Split a body into its human-authored part and the decoded marker JSON, or
 * `null` when no marker is present. The payload is base64 between the delimiters
 * (see {@link embedPreplanMarker}), so it's decoded here before the caller
 * parses it — the base64 alphabet can't contain the close delimiter, so the
 * plan's own content never truncates the frame. Tolerant of trailing content
 * after the close delimiter; uses the last open delimiter so an embedded example
 * in the human text can't shadow the real (appended) marker.
 */
function extractPreplanBlock(description: string): { human: string; json: string } | null {
	const openAt = description.lastIndexOf(PREPLAN_MARKER_OPEN);
	if (openAt === -1) return null;
	const afterOpen = description.slice(openAt + PREPLAN_MARKER_OPEN.length);
	const closeAt = afterOpen.indexOf(PREPLAN_MARKER_CLOSE);
	if (closeAt === -1) return null;
	const payload = afterOpen.slice(0, closeAt).trim();
	return {
		human: description.slice(0, openAt).trimEnd(),
		json: Buffer.from(payload, 'base64').toString('utf8'),
	};
}

/** A valid marker → skip the Planning agent and reuse this plan. */
export interface PreplanSkip {
	contract: PreplanContract;
}
/** No usable marker → run Planning normally; `reason` is null when there was nothing to reject. */
export interface PreplanFallback {
	fallbackReason: string | null;
}
export type PreplanDecision = PreplanSkip | PreplanFallback;

/** Narrow a {@link PreplanDecision} to the skip case. */
export function isPreplanSkip(decision: PreplanDecision): decision is PreplanSkip {
	return 'contract' in decision;
}

/**
 * Decide whether a work item **whose Planning run has already been dispatched**
 * carries a plan that run can reuse (skip the agent) or must be planned from
 * scratch (fall back). Every rejection path falls back to a normal run — a bad
 * marker is never a hard failure (issue #178: "Missing, malformed, stale, or
 * mismatched plans fall back to a normal Planning run").
 *
 * Not a dispatch gate: since issue #737 the trigger decides that on
 * {@link PLANNED_LABEL} alone and never calls this. Consequently there is no
 * label-based invalidation here any more — an operator who wants a fresh plan
 * removes `planned` and moves the card Backlog → Planning, which dispatches a
 * run that this function then lets fall through to the agent.
 */
export function evaluatePreplan(workItem: WorkItem): PreplanDecision {
	const block = extractPreplanBlock(workItem.description);
	// No marker → nothing to reject, so no "rejected" log line either.
	if (!block) return { fallbackReason: null };

	let contract: PreplanContract;
	try {
		contract = PreplanContractSchema.parse(JSON.parse(block.json));
	} catch {
		return { fallbackReason: 'preplan marker is malformed' };
	}
	if (contract.itemUrl !== workItem.url) {
		return { fallbackReason: 'preplan marker does not belong to this item' };
	}
	if (contract.descriptionHash !== hashDescription(block.human)) {
		return { fallbackReason: 'child scope changed since the preplan was generated' };
	}
	return { contract };
}
