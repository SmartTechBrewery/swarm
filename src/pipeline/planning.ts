/**
 * Planning phase (PROJECT.md §5.1, ai/ARCHITECTURE.md "Pipeline phases" #1).
 *
 * An item moves to "Planning" on the board → the worker runs this: provision a
 * read-only worktree, spin up the planning agent (Antigravity per §5.1, though
 * `DEFAULT_PLANNING_CLI` below currently runs Claude Code instead — see that
 * constant's comment) to explore the code graph and write a step-by-step
 * `proposed_plan.md`, and post that plan as a comment on the linked Issue
 * (GitHub Projects items have no long-form body of their own). Whether the
 * item then moves itself to "ToDo" is a per-project setting
 * (`project.pipeline.planning.autoAdvance`, `src/config/schema.ts`) —
 * defaulting to `false`: a human reviews the plan, then moves the item
 * themselves to greenlight Implementation. The plan is a review artefact, not
 * code — it's delivered as a comment and the worktree is thrown away, so the
 * checkout is detached and never commits.
 *
 * This is the phase's orchestration only. It composes the building blocks that
 * already exist — `GitWorktreeManager` (SWARM-14), `graftEnvironment` (SWARM-15),
 * `runAgentCli` (SWARM-16), the `PMProvider` contract (SWARM-11) — and takes them
 * (plus the work item) as inputs rather than reaching for a queue or a concrete
 * GraphQL provider. The BullMQ consumer that dequeues a `TASK_TYPE_PLANNING` job
 * and calls this, and the concrete GitHub Projects `PMProvider` adapter, are
 * their own issues (SWARM-17/35 and the PM-adapter issue); this lands ahead of
 * them the same way the router's enqueue seam did, wired up when they arrive.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';
import type { ProjectConfig } from '@/config/schema.js';
import {
	type AgentCli,
	type AgentCliResult,
	describeAgent,
	runAgentCli,
} from '@/harness/agent-cli.js';
import { agentRunError } from '@/harness/agent-failure.js';
import type { ReasoningLevel } from '@/harness/models.js';
import { logger } from '@/lib/logger.js';
import {
	buildPreplanContract,
	embedPreplanMarker,
	evaluatePreplan,
	isPreplanSkip,
	type PreplanContract,
	SPLIT_CHILD_LABEL,
} from '@/pipeline/preplan.js';
import {
	buildPlanningPrompt,
	PROPOSED_PLAN_FILENAME,
	PROPOSED_SCOPE_FILENAME,
	PROPOSED_SPLIT_FILENAME,
} from '@/pipeline/prompts/planning.js';
import {
	acquireResumableWorktree,
	cleanupUnlessPreserved,
	sessionRunArgs,
	shouldPreserveForResume,
} from '@/pipeline/resume.js';
import { resolveAutomationLabel } from '@/pm/automation-label.js';
import type { PmStatusKey } from '@/pm/pipeline.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';
import {
	SWARM_GENERATED_FOOTER,
	SWARM_GENERATED_SIGNATURE,
	swarmMarker,
} from '@/scm/swarm-origin.js';
import { GitWorktreeManager, type WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

export { SPLIT_CHILD_LABEL } from '@/pipeline/preplan.js';
// The static planning prompt and the hand-off filenames it names now live in
// `src/pipeline/prompts/planning.ts` (issue #135); re-exported here so existing
// importers of `@/pipeline/planning.js` keep resolving them unchanged.
export {
	buildPlanningPrompt,
	PROPOSED_PLAN_FILENAME,
	PROPOSED_SCOPE_FILENAME,
	PROPOSED_SPLIT_FILENAME,
};

/** The re-scope/rename patch for the original item (the smaller first task). */
const MainTaskSchema = z.object({
	title: z.string().trim().min(1),
	description: z.string(),
});

/**
 * One sibling a split produces. Unlike the main task, each sibling carries its
 * own concise `plan` — written by the parent Planning run while its repository
 * context is live, so the sibling's own Planning run can reuse it instead of
 * launching a fresh agent (docs/OPTIMIZATION.md §3, issue #178). The plan is a
 * self-contained Markdown brief (scope + acceptance criteria, exclusions,
 * relevant files/symbols, dependencies on preceding siblings, an ordered
 * outline, and verification guidance — see {@link buildPlanningPrompt}).
 */
const SplitSubTaskSchema = z.object({
	title: z.string().trim().min(1),
	description: z.string(),
	plan: z.string().trim().min(1),
});

/**
 * Shape of {@link PROPOSED_SPLIT_FILENAME}. `mainTask` optionally re-scopes/renames
 * the original item into the smaller first task; `subTasks` are the siblings to
 * spawn (each carrying its own reusable plan). Zod is the source of truth for the
 * on-disk contract (ai/CODING_STANDARDS.md "Zod as source of truth").
 */
const ProposedSplitSchema = z.object({
	mainTask: MainTaskSchema.optional(),
	subTasks: z.array(SplitSubTaskSchema).default([]),
});

export type ProposedSplit = z.infer<typeof ProposedSplitSchema>;

/**
 * Shape of {@link PROPOSED_SCOPE_FILENAME} — the planner-declared scope gate for
 * the single task `proposed_plan.md` covers (the first task, when the item is
 * split). Zod is the source of truth for the on-disk contract
 * (ai/CODING_STANDARDS.md "Zod as source of truth"), so the deterministic
 * post-plan guard ({@link enforceSingleTaskBudget}) reads structured,
 * planner-declared metadata rather than parsing free text out of the plan
 * (issue #268).
 *
 * - `whyOneTask` — the single-task justification (also mirrored as prose in the
 *   plan's "## Scope gate" section for the human reviewing the posted plan).
 * - `independentConcerns` — every genuinely independent concern the task
 *   combines. This is the concrete split trigger: two or more entries with no
 *   `proposed_split.json` is an oversized single task. Defaults to an empty list
 *   (a single cohesive concern the planner didn't feel the need to enumerate),
 *   which the guard treats as within budget.
 * - `affectedAreas` — the areas/files the task changes (informational; the guard
 *   deliberately does NOT gate on their count, so a focused change touching
 *   several closely-related files is never rejected for that alone).
 * - `outOfScope` — what the plan deliberately excludes.
 */
const ProposedScopeSchema = z.object({
	whyOneTask: z.string().trim().min(1),
	independentConcerns: z.array(z.string().trim().min(1)).min(1),
	affectedAreas: z.array(z.string().trim().min(1)).min(1),
	outOfScope: z.array(z.string().trim().min(1)).default([]),
});

export type ProposedScope = z.infer<typeof ProposedScopeSchema>;

/**
 * PROJECT.md §5.1 designs Antigravity as SWARM's planning agent, splitting the
 * planning and implementation roles across two different CLIs. Defaulting to
 * it here breaks Planning on any host that doesn't have `antigravity`
 * installed and authenticated — confirmed against a live run: `spawn
 * antigravity ENOENT`. Until Antigravity's setup path exists, Claude Code
 * covers Planning too (`RunPlanningPhaseOptions.cli` still overrides this per
 * call, for a project that does have Antigravity set up).
 */
export const DEFAULT_PLANNING_CLI: AgentCli = 'claude';

/**
 * Status the item moves to when `autoAdvance` is on — the board's "ToDo",
 * which is PROJECT.md §5.1's "Ready for Dev". Typed to {@link PmStatusKey} so
 * a typo fails to compile rather than silently sending the item to a status
 * the adapter can't resolve.
 */
const NEXT_STATUS: PmStatusKey = 'todo';

/** `autoAdvance` default when `project.pipeline.planning.autoAdvance` is unset. */
const DEFAULT_AUTO_ADVANCE = false;

/**
 * Label applied to an item's backing issue when its Planning phase completes
 * successfully (issue #384) — a lightweight, provider-visible marker that
 * distinguishes planned, ready-for-implementation work from un-planned backlog,
 * independent of the board Status move `autoAdvance` may make. A fixed constant,
 * not a config option: the smallest durable change, with no speculative setting.
 *
 * Also applied to every split child {@link applySplit} successfully prepares
 * (issue #426), since such a child is already planned by construction — it carries
 * the parent's validated plan in its body — and shouldn't read as un-planned while
 * it waits its turn (no Planning run of its own follows to label it; the marker
 * suppresses that dispatch). Applied right after that preparation rather than at
 * `createWorkItem`, so a child whose preparation failed is never labeled up front
 * (issue #436).
 *
 * On a split child the label therefore tracks *completed preparation* — marker
 * embedded **and** card moved to Planning — so either failure leaves it unlabeled,
 * with different consequences ({@link markSplitChildPlanned} owns the full
 * statement).
 */
export const PLANNED_LABEL = 'planned';

/**
 * `autoSplit` default when `project.pipeline.planning.autoSplit` is unset. On by
 * default: evaluating task size and splitting a too-large item is the phase's
 * new baseline behavior (a task that fits one PR is never split, so this is
 * inert for right-sized work).
 */
const DEFAULT_AUTO_SPLIT = true;

/**
 * `maxConcerns` default when `project.pipeline.planning.maxConcerns` is unset —
 * the largest number of independent concerns a single unsplit task may declare
 * before {@link enforceSingleTaskBudget} rejects it (issue #268). `1` encodes
 * the concrete rule "two or more independent concerns must split": a task
 * declaring one cohesive concern (or none) is within budget; two or more with
 * no `proposed_split.json` fails Planning. Configurable per project so a team
 * can loosen the budget, but the default is deliberately conservative.
 */
const DEFAULT_MAX_CONCERNS = 1;

/**
 * A sibling is first created in Backlog, so its validated preplan marker can be
 * written before its subsequent move to Planning emits a status event.
 */
const SIBLING_CREATION_STATUS: PmStatusKey = 'backlog';

/** Final board status for a preplanned split child. */
const SIBLING_START_STATUS: PmStatusKey = 'planning';

/**
 * Cap on captured agent output, so a chatty/runaway Antigravity run can't grow the
 * worker's memory without bound. The plan itself is read from `proposed_plan.md`,
 * not from stdout, so truncating the captured stream costs nothing here.
 */
const MAX_AGENT_OUTPUT_BYTES = 1_000_000;

export interface RunPlanningPhaseOptions {
	/** The SWARM project whose board the item lives on. */
	project: ProjectConfig;
	/**
	 * The Projects item that entered "Planning". Its `id` addresses the item for
	 * the PM provider; its `url`/`title`/`description` describe the work to plan.
	 */
	workItem: WorkItem;
	/**
	 * Task identifier for the worktree path (`task-<taskId>`) — usually the linked
	 * issue number. Passed explicitly rather than derived from `workItem` here: the
	 * item's `id` is an opaque node ID, and the worker that dequeues the job is the
	 * layer that knows the issue number, so it owns that mapping.
	 */
	taskId: string;
	/** PM provider used to post the plan comment and, if `autoAdvance`, move the item. */
	pm: PMProvider;
	/** Worktree manager for the project — provisions and cleans up the checkout. */
	worktrees?: GitWorktreeManager;
	/** Which agent CLI to run. Defaults to Antigravity. */
	cli?: AgentCli;
	/** Model for the agent's session (e.g. 'sonnet', 'opus'). Omit for the CLI's own default. */
	model?: string;
	/** Reasoning level for the agent's session. Omit for the CLI/model default (issue #180). */
	reasoning?: ReasoningLevel;
	/**
	 * Project's optional custom prompt for this phase (`agents.planning.prompt`,
	 * issue #135) — appended to the static SWARM prompt as a supplement-only
	 * section. Omit for today's prompt exactly.
	 */
	customPrompt?: string;
	/** Deterministic Claude session handle assigned by the run row. */
	sessionId?: string;
	/** Resume this Claude session when its preserved worktree still exists. */
	resumeSessionId?: string;
	/** The database run id. */
	runId?: string;
	/**
	 * Mode for recovering a cancelled preserved worktree. Deliberately narrower than
	 * {@link RecoveryMode}: this phase writes no checkpoint (`docs/CHECKPOINTS.md`),
	 * so there is never one to continue it from.
	 */
	recoveryMode?: 'resume' | 'fresh';
	/**
	 * Whether to move the item to "ToDo" once the plan is posted. Defaults to
	 * `false` — a human reviews the plan and moves the item themselves. Always
	 * forced off for a spawned split-child item (see {@link SPLIT_CHILD_LABEL}),
	 * regardless of this value.
	 */
	autoAdvance?: boolean;
	/**
	 * Whether the planning agent may split a too-large item into smaller sibling
	 * tasks. Defaults to `true`. When off, the agent plans the item as a single
	 * task (today's behavior) and any `proposed_split.json` it writes is ignored.
	 */
	autoSplit?: boolean;
	/**
	 * Largest number of independent concerns a single unsplit task may declare in
	 * {@link PROPOSED_SCOPE_FILENAME} before the post-plan guard rejects it and
	 * fails Planning (issue #268). Defaults to {@link DEFAULT_MAX_CONCERNS} (`1`).
	 * Only consulted when `autoSplit` is on.
	 */
	maxConcerns?: number;
	/** Kill the agent run after this many ms. Omit for no timeout. */
	timeoutMs?: number;
	/** External cancellation — aborting kills the agent run. */
	signal?: AbortSignal;
	/** Injectable agent runner — defaults to {@link runAgentCli}; overridden in tests. */
	runAgent?: (opts: Parameters<typeof runAgentCli>[0]) => Promise<AgentCliResult>;
	/** Injectable env-grafting step — defaults to {@link graftEnvironment}; overridden in tests. */
	graft?: typeof graftEnvironment;
}

export interface PlanningPhaseResult {
	/** The plan text read from `proposed_plan.md`. */
	plan: string;
	/** ID of the comment the plan was posted as. */
	commentId: string;
	/** The canonical status the item was moved to, or `undefined` when `autoAdvance` was off. */
	movedTo?: PmStatusKey;
	/** The agent run's result (exit code, duration, captured output). */
	agent: AgentCliResult;
	/**
	 * Present when the agent split the task: the work-item IDs of the spawned
	 * siblings (in order) and whether the original item was re-scoped/renamed.
	 * Absent when the item was planned as a single task.
	 */
	split?: {
		subTaskItemIds: string[];
		mainTaskUpdated: boolean;
	};
	/**
	 * True when this run reused a preplanned split-child plan and skipped the
	 * agent CLI entirely (docs/OPTIMIZATION.md §3). The `agent` result is then a
	 * synthetic zero-usage record — no worktree was provisioned and no model was
	 * spent.
	 */
	preplanned?: boolean;
	/**
	 * Validated structured scope metadata from a normal planning run. A
	 * preplanned split child has no local scope artifact, so it leaves this absent.
	 */
	planningScope?: ProposedScope;
}

/**
 * Read and validate {@link PROPOSED_SPLIT_FILENAME} from the worktree, or return
 * `undefined` when the agent chose not to split (file absent, or present with no
 * `subTasks`). A malformed file throws — the agent was asked for an exact shape,
 * so a broken one is a failed run, not a silent "no split" (ai/CODING_STANDARDS.md
 * "Error handling").
 */
export function readProposedSplit(worktreePath: string): ProposedSplit | undefined {
	const splitPath = join(worktreePath, PROPOSED_SPLIT_FILENAME);
	if (!existsSync(splitPath)) return undefined;
	const raw = readFileSync(splitPath, 'utf8').trim();
	if (raw.length === 0) return undefined;
	const parsed = ProposedSplitSchema.parse(JSON.parse(raw));
	if (parsed.subTasks.length === 0) return undefined;
	return parsed;
}

/**
 * Read and validate {@link PROPOSED_SCOPE_FILENAME} — the planner's scope gate
 * for the single task it planned. Throws an actionable error when the file is
 * missing, empty, unparseable, or violates {@link ProposedScopeSchema}: with
 * splitting enabled the planner is explicitly told to write it, so its absence
 * or a broken shape is a failed Planning run (the scope gate never got recorded),
 * not a soft miss (ai/CODING_STANDARDS.md "Error handling"). Only called on the
 * agent path when `autoSplit` is on.
 */
export function readProposedScope(worktreePath: string): ProposedScope {
	const scopePath = join(worktreePath, PROPOSED_SCOPE_FILENAME);
	if (!existsSync(scopePath)) {
		throw new Error(
			`Planning agent did not write ${PROPOSED_SCOPE_FILENAME}. Record the scope gate ` +
				`(whyOneTask, independentConcerns, affectedAreas, outOfScope) so the plan's scope is explicit.`,
		);
	}
	const raw = readFileSync(scopePath, 'utf8').trim();
	if (raw.length === 0) {
		throw new Error(
			`Planning agent wrote an empty ${PROPOSED_SCOPE_FILENAME}. Record the scope gate ` +
				`(whyOneTask, independentConcerns, affectedAreas, outOfScope).`,
		);
	}
	return ProposedScopeSchema.parse(JSON.parse(raw));
}

/**
 * Deterministic post-plan guard (issue #268). Rejects an unsplit single task
 * whose declared `independentConcerns` exceed `maxConcerns` — the objective
 * "two or more independent concerns must split" rule, driven by structured,
 * planner-declared metadata rather than a fragile free-text size heuristic.
 * Only reached on the no-split path (when a split is proposed the item is
 * already being decomposed), so it never blocks a legitimate split. It also
 * never inspects file or test counts, so a focused change touching several
 * closely-related files or carrying several tests is left alone. The throw
 * fails Planning with an actionable message rather than auto-advancing an
 * oversized plan to Implementation.
 */
function enforceSingleTaskBudget(
	scope: ProposedScope,
	maxConcerns: number,
	taskId: string,
	workItem: WorkItem,
): void {
	if (scope.independentConcerns.length <= maxConcerns) return;
	logger.warn('Planning — rejecting oversized single-task plan (declared concerns over budget)', {
		taskId,
		workItemId: workItem.id,
		declaredConcerns: scope.independentConcerns,
		maxConcerns,
	});
	throw new Error(
		`Planning produced an oversized single task: ${PROPOSED_SCOPE_FILENAME} declares ` +
			`${scope.independentConcerns.length} independent concerns ` +
			`(${scope.independentConcerns.map((c) => `"${c}"`).join(', ')}) but the single-task budget ` +
			`is ${maxConcerns}. Narrow the plan to one cohesive concern, or split the work by emitting ` +
			`${PROPOSED_SPLIT_FILENAME} with one child per concern.`,
	);
}

/**
 * What automatic preparation of a split child actually achieved, so its split
 * comment reports the real state rather than a hopeful one (issue #431). Two
 * independent facts: whether the child's plan was published as a visible comment,
 * and whether preparation got all the way to Planning. A struct rather than two
 * positional booleans so the call site stays readable.
 */
interface ChildPreparation {
	/** The preplan was posted as a human-readable comment on the child. */
	preplanPublished: boolean;
	/** The marker was embedded and the child reached Planning. */
	prepared: boolean;
}

/**
 * Comment posted on a spawned sibling so the board shows what happened: which
 * ordered phase it is, that it came from splitting the parent, whether its plan
 * was published as a readable comment, whether automatic preparation reached
 * Planning or left it in Backlog, and — the first of the two dependency guards
 * (issue #330) — the exact earlier phases that block it. The second guard is the
 * native `blocked by` relationship {@link applySplit} records; this human-readable
 * list stands in for it on a provider that can't.
 *
 * `predecessors` are every phase that must land before this one, in order (phase 1
 * first) — for phase N that is phases 1..N-1. Empty only for the first task, which
 * is the re-scoped parent, not a spawned sibling.
 *
 * `preparation` is reported honestly (issue #431): the preplan comment is only
 * pointed at when it was really posted, so a failed publication never leaves the
 * operator hunting for a comment that doesn't exist.
 *
 * Carries the {@link SWARM_GENERATED_FOOTER} like every other SWARM comment: this
 * is the one body that has no per-delivery marker to identify it, so without the
 * footer comment loop prevention would read it back as human input.
 */
export function splitChildCommentBody(
	parent: WorkItem,
	predecessors: readonly WorkItem[],
	phaseNumber: number,
	totalPhases: number,
	preparation: ChildPreparation,
): string {
	const lines = [
		`## 🧩 Phase ${phaseNumber} of ${totalPhases} — split from a larger task`,
		'',
		`This task was split off from **${parent.title}** (${parent.url}) during planning,`,
		'because that work item was too large to implement well in a single pull request.',
		'',
	];
	if (predecessors.length > 0) {
		lines.push(
			'**Blocked by** — these earlier phases must be completed first, in order:',
			...predecessors.map((p, i) => `- Phase ${i + 1}: ${p.title} (${p.url})`),
			'',
		);
	}
	if (preparation.preplanPublished) {
		lines.push(
			'📋 The complete plan prepared for this task is published in the **Preplan** comment on',
			'this issue — review it there before you start this phase.',
			'',
		);
	}
	if (preparation.prepared) {
		lines.push(
			"SWARM has already prepared this task's plan and placed it in **Planning**. Its valid",
			'preplan marker prevents a second Planning-agent run, and it will **not** move to',
			'**ToDo** on its own. Its implementation stays blocked until the phases above are done —',
			'move it to **ToDo** when you are ready and its prerequisites have landed. Editing this',
			"issue's description, or adding the `swarm:replan` label, discards that saved plan and",
			'makes SWARM run Planning normally.',
		);
	} else {
		lines.push(
			'SWARM could not finish preparing this task automatically, so it remains in **Backlog**.',
			'Move it to **Planning** when you are ready; SWARM will validate any saved preplan and',
			'run a Planning agent normally if that preplan is missing or invalid.',
		);
	}
	lines.push('', '---', SWARM_GENERATED_FOOTER);
	return lines.join('\n');
}

/**
 * Prefix of the provenance marker on a split child's visible preplan comment
 * (issue #431). Stamps the comment with the split run that produced it
 * ({@link preplanCommentMarker}), and — being a `<!-- swarm-… -->` marker —
 * is what makes the comment recognisably SWARM's own to `isSwarmGeneratedBody`,
 * so comment loop prevention drops the resulting webhook and the dependency-mention
 * scan ignores the plan's prose.
 *
 * A distinct token from the hidden `swarm-preplan:v1` contract marker: the two
 * diverge right after `preplan`, so `extractPreplanBlock`
 * (`src/pipeline/preplan.ts`) can never match this one — and it only ever reads
 * the issue *description*, never comments. The hidden marker stays the single
 * authoritative source for preplan validation and dispatch suppression; this
 * comment is a human-readable copy of the same plan.
 */
export const PREPLAN_COMMENT_MARKER_PREFIX = '<!-- swarm-preplan-comment:';

/** The full idempotency marker for one split child's published preplan comment. */
export function preplanCommentMarker(splitId: string, childIndex: number): string {
	return `${PREPLAN_COMMENT_MARKER_PREFIX}${splitId}:${childIndex} -->`;
}

/**
 * Render a split child's parent-written plan as a normal, human-readable comment
 * (issue #431). GitHub does not render the hidden `swarm-preplan:v1` marker that
 * carries the same plan, so without this the operator asked to sequence the child
 * has no way to review its plan short of decoding an HTML comment. The plan is
 * emitted verbatim and untruncated — this comment is meant to be the plan, not a
 * summary of it.
 *
 * Deliberately carries **no lifecycle advice**. It is published first, before the
 * marker write and the Planning move, so at the point it is composed nothing here
 * knows whether either will succeed — a "move this to ToDo" instruction would be
 * wrong in exactly the Backlog fallback this ordering exists to produce (there is
 * no saved plan to act on, and the move would dispatch Implementation on a child
 * that was never planned). {@link splitChildCommentBody} is posted afterwards with
 * the real {@link ChildPreparation} in hand, so it is the single place that tells
 * the operator what to do next.
 */
export function preplanCommentBody(
	contract: PreplanContract,
	phaseNumber: number,
	totalPhases: number,
): string {
	return [
		`## 🗺️ Preplan — Phase ${phaseNumber} of ${totalPhases}`,
		'',
		"This is the complete plan SWARM prepared for **this** task during the parent task's",
		'Planning run. A separate comment on this issue reports where this task stands and what to do next.',
		'',
		contract.plan.trim(),
		'',
		preplanCommentMarker(contract.splitId, contract.childIndex),
	].join('\n');
}

/**
 * Per-delivery idempotency marker embedded at the tail of a plan comment (issue
 * #384). Unlike the human-visible "## 🗺️ Proposed implementation plan" heading —
 * which *every* Planning run shares, so it cannot tell a retry of *this* delivery
 * apart from an older run's leftover plan — this marker is unique to one Planning
 * delivery: `deliveryId` is the run-row id, stable across a retry of the same job
 * (the row is reused, `src/worker/consumer.ts` `reuseRunRow`) but fresh for a later
 * human replan (a new row). {@link findComment} looks this marker up to decide
 * whether *this* delivery already posted its plan comment, so a retry after a
 * later step failed reuses exactly its own comment while a genuine replan still
 * posts a new one and re-runs its split. Mirrors the SCM idempotent-comment marker
 * (`swarm-delivery`, `src/integrations/scm/github/client.ts`), and shares its
 * `<!-- swarm-… -->` frame so comment loop prevention recognises both
 * (`isSwarmGeneratedBody`, `src/scm/swarm-origin.ts`).
 */
export function planDeliveryMarker(deliveryId: string): string {
	return swarmMarker('planning-delivery', deliveryId);
}

/**
 * Wrap the raw plan in a comment body that marks it as SWARM's proposed plan.
 * The trailing hint depends on `autoAdvance`: when off (the default), it
 * tells the human to move the item to "ToDo" themselves to start
 * Implementation; when on, it says the item is moving there on its own, so a
 * human doesn't sit waiting for an action the phase already took.
 *
 * `deliveryId` (the run-row id, when known) appends a {@link planDeliveryMarker}
 * so a retry of the same delivery can find *this* comment again; omitted when no
 * run row is available (direct/test invocations), which simply forgoes the
 * idempotency checkpoint and always posts.
 */
export function planCommentBody(
	plan: string,
	autoAdvance = DEFAULT_AUTO_ADVANCE,
	deliveryId?: string,
): string {
	const hint = autoAdvance
		? `${SWARM_GENERATED_SIGNATURE} (Planning phase). This item is moving to **ToDo** automatically to begin implementation._`
		: `${SWARM_GENERATED_SIGNATURE} (Planning phase). Move this item to **ToDo** to begin implementation._`;
	const lines = ['## 🗺️ Proposed implementation plan', '', plan.trim(), '', '---', hint];
	if (deliveryId) lines.push('', planDeliveryMarker(deliveryId));
	return lines.join('\n');
}

/**
 * The patch to apply to the original item so it becomes the split's smaller
 * first task, containing only the fields the agent actually changed — or
 * `undefined` when title and description both match, so no needless write is
 * made.
 */
function buildMainTaskPatch(
	workItem: WorkItem,
	mainTask: ProposedSplit['mainTask'],
): { title?: string; description?: string } | undefined {
	if (!mainTask) return undefined;
	const patch: { title?: string; description?: string } = {};
	if (mainTask.title !== workItem.title) patch.title = mainTask.title;
	if (mainTask.description !== workItem.description) patch.description = mainTask.description;
	return patch.title === undefined && patch.description === undefined ? undefined : patch;
}

/**
 * Log a failed planning run's captured output before the phase throws, so the
 * worker (SWARM-17) that marks the job failed has the agent's own stdout/stderr
 * to diagnose *why* — the thrown Error carries only a message. Output is already
 * bounded by {@link MAX_AGENT_OUTPUT_BYTES}, so this can't blow up the log.
 */
function logAgentFailure(taskId: string, workItemId: string, agent: AgentCliResult): void {
	logger.error('Phase failed - Planning — agent output', {
		taskId,
		workItemId,
		cli: agent.cli,
		exitCode: agent.exitCode,
		timedOut: agent.timedOut,
		durationMs: agent.durationMs,
		outputTruncated: agent.outputTruncated,
		stdout: agent.stdout,
		stderr: agent.stderr,
	});
}

/**
 * Read and validate the plan the agent was told to write. Throws (after logging
 * the agent's captured output) when the file is missing or empty — a planning
 * run that didn't yield a plan is a failed job, not a soft miss
 * (ai/CODING_STANDARDS.md "Error handling"). Split out of {@link runPlanningPhase}
 * to keep that function's branching within the complexity budget.
 */
function readPlanOrThrow(
	worktreePath: string,
	cli: AgentCli,
	taskId: string,
	workItem: WorkItem,
	agent: AgentCliResult,
): string {
	const planPath = join(worktreePath, PROPOSED_PLAN_FILENAME);
	if (!existsSync(planPath)) {
		logAgentFailure(taskId, workItem.id, agent);
		throw new Error(
			`Planning agent (${cli}) did not write ${PROPOSED_PLAN_FILENAME} for task '${taskId}'`,
		);
	}
	const plan = readFileSync(planPath, 'utf8').trim();
	if (plan.length === 0) {
		logAgentFailure(taskId, workItem.id, agent);
		throw new Error(
			`Planning agent (${cli}) wrote an empty ${PROPOSED_PLAN_FILENAME} for task '${taskId}'`,
		);
	}
	return plan;
}

/**
 * Apply a split: re-scope/rename the original item into the smaller first task
 * (when the agent asked), then spawn each sibling task in Planning — tagged as a
 * split child and with the project's `automationLabel` (issue #131) so SWARM's own
 * siblings pass the dispatch gate, with a comment explaining the split, and with the parent-written
 * plan embedded as a validated preplanned marker in its issue body
 * ({@link embedPreplanMarker}) before it enters Planning. It is created in Backlog
 * solely for that ordering: the marker exists before either its Planning move or
 * delayed creation webhook is handled, so the trigger can safely skip a redundant
 * Planning dispatch (docs/OPTIMIZATION.md §3).
 * Returns the spawned siblings' IDs (in order) and whether the original was
 * patched. Split out of {@link runPlanningPhase} for the same complexity-budget
 * reason as {@link readPlanOrThrow}.
 *
 * The marker is embedded via a follow-up `updateWorkItem` (not at creation)
 * because it binds the sibling's own backing-issue URL, which only exists once
 * the item is created. Publishing the visible preplan comment, marker
 * creation/update and the subsequent Planning move are wrapped in a try/catch: a
 * failure is logged and swallowed so the sibling is still created, remains in
 * Backlog, and receives an honest fallback comment, rather than failing the whole
 * parent run mid-loop (which a retry would then duplicate it). The
 * `createWorkItem` and split comment are deliberately outside the catch — those
 * are the split itself, not the optimization, so their failures must still surface.
 *
 * Ordering inside the try is deliberate (issue #431): the plan is published as a
 * readable comment *before* the marker is written, so a failed publication leaves
 * no marker — the child stays in Backlog and a later human move to Planning runs a
 * normal Planning agent that posts its own visible plan. Writing the marker first
 * would instead leave a child whose valid marker permanently suppresses Planning
 * and whose plan nobody can read. The marker still lands before the Planning move,
 * so the Backlog-first ordering guarantee is untouched: the extra call happens
 * while the child sits in `backlog`, a status that starts no phase.
 *
 * {@link PLANNED_LABEL} is attached right after that preparation succeeds
 * ({@link markSplitChildPlanned}), not in the `createWorkItem` labels: a child
 * whose preparation failed has not finished being placed as planned, so the label
 * would say the inverse of the board's truth (issue #436).
 */
async function applySplit(
	pm: PMProvider,
	parent: WorkItem,
	split: ProposedSplit,
	automationLabel: string | undefined,
): Promise<{ subTaskItemIds: string[]; mainTaskUpdated: boolean }> {
	const mainPatch = split.mainTask ? buildMainTaskPatch(parent, split.mainTask) : undefined;
	if (mainPatch) {
		await pm.updateWorkItem(parent.id, mainPatch);
	}
	// One id/timestamp for the whole split, so every child's marker is stamped
	// with the operation it came from (provenance; see PreplanContract).
	const splitId = randomUUID();
	const generatedAt = new Date().toISOString();
	const subTaskItemIds: string[] = [];
	// Phase 1 is the re-scoped original (with whatever rename patch just applied);
	// each sibling is the next phase. `predecessors` accumulates them so phase N is
	// chained behind phases 1..N-1 — the cumulative blocked-by the issue requires.
	const firstTask: WorkItem = mainPatch ? { ...parent, ...mainPatch } : parent;
	const totalPhases = split.subTasks.length + 1;
	const predecessors: WorkItem[] = [firstTask];
	for (const [childIndex, sub] of split.subTasks.entries()) {
		const sibling = await pm.createWorkItem({
			title: sub.title,
			description: sub.description,
			status: SIBLING_CREATION_STATUS,
			// The configured automation label, not a hard-coded `swarm` (issue #131):
			// a sibling SWARM created must be opted into SWARM's own pipeline, whatever
			// label this project gates on. Omitted entirely when the gate is disabled.
			// PLANNED_LABEL is deliberately *not* here — it is applied below, once the
			// preparation that makes the child planned actually succeeded (issue #436).
			labels: [...(automationLabel ? [automationLabel] : []), SPLIT_CHILD_LABEL],
		});
		let prepared = false;
		let preplanPublished = false;
		try {
			const contract = buildPreplanContract({
				splitId,
				childIndex,
				parentUrl: parent.url,
				itemUrl: sibling.url,
				humanDescription: sub.description,
				plan: sub.plan,
				generatedAt,
			});
			await publishPreplanComment(pm, sibling, contract, childIndex + 2, totalPhases);
			preplanPublished = true;
			await pm.updateWorkItem(sibling.id, {
				description: embedPreplanMarker(sub.description, contract),
			});
			await pm.moveWorkItem(sibling.id, SIBLING_START_STATUS);
			prepared = true;
		} catch (error) {
			logger.warn('Planning — failed to prepare split child; leaving it in Backlog', {
				parentId: parent.id,
				siblingId: sibling.id,
				splitId,
				childIndex,
				preplanPublished,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		// Only a child that really was prepared is planned (issue #436): the label
		// must not outlive a failed preparation, which leaves the child in Backlog
		// without having completed its placement as planned (see
		// `markSplitChildPlanned` for what each failure branch actually costs).
		if (prepared) await markSplitChildPlanned(pm, sibling, splitId, childIndex);
		// Guard 2 (issue #330): record the native blocked-by relationship for every
		// preceding phase, so the worker defers this phase's Implementation until they
		// all close. Best-effort — a provider that can't model dependencies, or a
		// transient API failure, must not fail the whole split; the comment below (guard
		// 1) still names the blockers.
		await linkBlockedBy(pm, sibling, predecessors, splitId, childIndex);
		await pm.addComment(
			sibling.id,
			splitChildCommentBody(firstTask, predecessors, childIndex + 2, totalPhases, {
				prepared,
				preplanPublished,
			}),
		);
		subTaskItemIds.push(sibling.id);
		predecessors.push(sibling);
	}
	return { subTaskItemIds, mainTaskUpdated: mainPatch !== undefined };
}

/**
 * Mark a *successfully prepared* split child {@link PLANNED_LABEL} (issues #426,
 * #436). Such a child is planned by construction — its parent-written plan is
 * embedded as a validated preplan marker and its card sits in Planning — so the
 * provider-visible marker is accurate as soon as the child holds that plan.
 *
 * This write is the one that counts: a prepared child's own Planning dispatch is
 * suppressed by `shouldSkipPreplanned` (`src/triggers/handlers/pm-status.ts`), so
 * no preplanned reuse run normally follows to label it. Should a dispatch reach it
 * anyway — a resumed run, or the fallback an operator forces — that run calls
 * {@link applyPlannedLabel} and the provider makes the repeat a no-op.
 *
 * Called only when the preparation above succeeded — marker embedded **and** card
 * moved to Planning. Either failure leaves the child unlabeled in Backlog (issue
 * #436), but the two are not equivalent, and this is the canonical statement of
 * the difference:
 *
 * - **Marker embed failed** — the parent's plan is lost with the unwritten marker.
 *   The child really is un-planned and owes a full Planning agent run, which a
 *   later move to Planning dispatches normally.
 * - **Planning move failed** — the embedded marker is valid, so the child keeps its
 *   plan, and `shouldSkipPreplanned` (`src/triggers/handlers/pm-status.ts`) then
 *   suppresses the Planning dispatch when someone moves the card to Planning. No
 *   agent is ever spent on it — but nothing applies `PLANNED_LABEL` later either,
 *   so the card stays unlabeled until an operator forces a fallback run by getting
 *   the card into Planning and invalidating the preplan (adding `swarm:replan` or
 *   removing {@link SPLIT_CHILD_LABEL}); either order works, but a label change alone
 *   does nothing while the card is in Backlog, because `preplan-invalidated` only
 *   considers cards already in Planning.
 *
 * Best-effort, exactly like {@link linkBlockedBy}: a failure is logged and
 * swallowed so a refused label can never abort the split mid-loop (a retry would
 * duplicate the siblings). Nothing reads the label — Planning is its only consumer
 * — so a swallowed failure costs the marker's accuracy, nothing more.
 */
async function markSplitChildPlanned(
	pm: PMProvider,
	item: WorkItem,
	splitId: string,
	childIndex: number,
): Promise<void> {
	try {
		await pm.addLabel(item.id, PLANNED_LABEL);
	} catch (error) {
		logger.warn('Planning — failed to label a prepared split child planned', {
			itemId: item.id,
			splitId,
			childIndex,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Publish a split child's parent-written plan as a normal, human-readable comment
 * (issue #431). The hidden `swarm-preplan:v1` marker that carries the same plan is
 * invisible in GitHub's rendered issue, so an operator asked to sequence the child
 * could not review its plan at the point the workflow asks them to act on it. This
 * publishes a rendered copy; the marker remains authoritative for validation and
 * for suppressing the child's redundant Planning-agent run.
 *
 * **No duplicate check of its own, deliberately.** The replay guarantee lives one
 * level up: a retry of the same delivery finds its plan comment by
 * {@link planDeliveryMarker} and skips {@link applySplit} entirely, so this never
 * runs twice for the same child. Every child it does see was just created by
 * `pm.createWorkItem` and therefore has no comments at all — a lookup here could
 * only ever miss, at the cost of a `resolveItem` + a fully paginated
 * `listComments` per child, and a *failed* lookup would strand the child in
 * Backlog over a duplicate that cannot happen.
 *
 * Throws on a provider failure — the caller's catch turns that into the honest
 * Backlog fallback rather than a marker whose plan nobody can read.
 */
async function publishPreplanComment(
	pm: PMProvider,
	child: WorkItem,
	contract: PreplanContract,
	phaseNumber: number,
	totalPhases: number,
): Promise<void> {
	await pm.addComment(child.id, preplanCommentBody(contract, phaseNumber, totalPhases));
}

/**
 * Record `item` as blocked by every one of its preceding phases (issue #330),
 * behind the provider-agnostic PMProvider dependency capability. No-op when the
 * provider can't model dependencies; per-link failures are logged and swallowed
 * so one bad link never aborts the split mid-loop (a retry would duplicate the
 * siblings) — the split comment still lists the blockers.
 */
async function linkBlockedBy(
	pm: PMProvider,
	item: WorkItem,
	blockers: readonly WorkItem[],
	splitId: string,
	childIndex: number,
): Promise<void> {
	if (!pm.supportsDependencies) return;
	for (const blocker of blockers) {
		try {
			await pm.addBlockedBy(item.id, blocker.id);
		} catch (error) {
			logger.warn('Planning — failed to record blocked-by dependency; comment still lists it', {
				itemId: item.id,
				blockerId: blocker.id,
				splitId,
				childIndex,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/**
 * Run the Planning phase for one work item. Provisions a detached worktree, runs
 * the planning agent to produce `proposed_plan.md`, and posts it as a comment on
 * the linked Issue. Whether the item then moves to "ToDo" is `autoAdvance`
 * (default `false`) — a human moves it themselves after reviewing the plan
 * unless the project opted into automatic advancement.
 *
 * When `autoSplit` (default `true`) is on and the agent judged the item too large,
 * it also writes `proposed_split.json`: the original item is re-scoped into the
 * smaller first task (`proposed_plan.md` is that task's plan) and the remaining
 * work is spawned as sibling items. Each sibling enters Planning only after its
 * validated preplan marker is written, is tagged with {@link SPLIT_CHILD_LABEL}
 * (and, once that preparation succeeded, {@link PLANNED_LABEL}),
 * and gets a comment explaining the split. Its marker suppresses a second Planning
 * agent run; the human then starts implementation by moving it to ToDo in order. The original
 * (first task) still honors `autoAdvance` as usual, unless it is itself a
 * split-child.
 *
 * With `autoSplit` on, the run also enforces a deterministic scope gate (issue
 * #268): the agent must write a validated {@link PROPOSED_SCOPE_FILENAME}, and an
 * unsplit single task declaring more than `maxConcerns` (default `1`) independent
 * concerns fails Planning with an actionable request to narrow or split, rather
 * than auto-advancing an oversized plan to Implementation.
 *
 * Throws if the agent exits non-zero, produces no plan, or fails the scope gate —
 * a planning run that didn't yield a usable, right-sized plan is a failed job,
 * not a soft miss (ai/CODING_STANDARDS.md "Error handling"), and the throw lets
 * the worker mark the job failed. The worktree is always removed, success or
 * failure.
 */
/**
 * Acquire the read-only (detached-HEAD) checkout for the planning run. When
 * resuming a Claude session (`resumeSessionId`) it reuses the existing worktree
 * so the agent can `--resume` in place; if that worktree is gone (`reuse`
 * returns undefined) it falls through to a fresh detached provision. `resumed`
 * reports whether a session worktree was actually reused, so the caller only
 * threads the resume session id through when its checkout is really in place.
 */
async function acquirePlanningWorktree(
	worktrees: GitWorktreeManager,
	taskId: string,
	baseBranch: string,
	resumeSessionId: string | undefined,
	recoveryMode?: 'resume' | 'fresh',
	runId?: string,
): Promise<{ handle: WorktreeHandle; resumed: boolean }> {
	const res = await acquireResumableWorktree(
		worktrees,
		taskId,
		'planning',
		baseBranch,
		true,
		resumeSessionId,
		() => worktrees.provision(taskId, { detach: true, runId }),
		false,
		recoveryMode,
	);
	return { handle: res.handle, resumed: res.resumed };
}

/**
 * Synthetic agent result for a preplanned run that skipped the CLI entirely:
 * exit 0, no output, no usage, zero duration. The worker records it as a
 * completed run that consumed no model quota (`src/worker/consumer.ts`), which
 * is exactly the saving docs/OPTIMIZATION.md §3 is after.
 */
function skippedAgentResult(cli: AgentCli): AgentCliResult {
	return {
		cli,
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 0,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
	};
}

/**
 * Mark the item `planned` — the enforced completion step of a successful Planning
 * run (issue #384). Applied on every successful completion (the normal agent run
 * and the preplanned split-child reuse alike), so every issue that finishes
 * planning ends up labeled through its own run. Never reached on a failed or
 * incomplete run, since every failure path throws before this. Not gated on
 * `autoAdvance`: planning *completion* is the trigger, not the Status move. A
 * hard step, not best-effort — the criteria require labeling to be enforced, so
 * a failure propagates (the run is marked failed) rather than being swallowed.
 * Idempotent at the provider, so re-running Planning on an already-labeled issue
 * is safe.
 */
async function applyPlannedLabel(
	pm: PMProvider,
	workItem: WorkItem,
	taskId: string,
): Promise<void> {
	await pm.addLabel(workItem.id, PLANNED_LABEL);
	logger.debug('Planning — applied planned label', {
		taskId,
		workItemId: workItem.id,
		label: PLANNED_LABEL,
	});
}

/**
 * Complete a Planning run for a split child that already carries a valid
 * preplanned plan — post that plan as the plan comment (exactly what a normal
 * run would post) and honor the status behavior, without provisioning a worktree
 * or launching the agent. `effectiveAutoAdvance` is already forced off for a
 * split child, so this never moves the child to "ToDo" (issue #178: the child
 * remains in Planning and never auto-advances).
 */
async function completePreplannedRun(
	pm: PMProvider,
	workItem: WorkItem,
	plan: string,
	effectiveAutoAdvance: boolean,
	cli: AgentCli,
	taskId: string,
	deliveryId: string | undefined,
): Promise<PlanningPhaseResult> {
	// Look up *this* delivery's own comment (by its unique marker), not any comment
	// under the shared heading, so a retry reuses its comment while a replan posts
	// afresh. Skipped when no run row is available — then we always post.
	let commentId = deliveryId
		? await pm.findComment(workItem.id, planDeliveryMarker(deliveryId))
		: undefined;
	if (!commentId) {
		commentId = await pm.addComment(
			workItem.id,
			planCommentBody(plan, effectiveAutoAdvance, deliveryId),
		);
	}
	const movedTo = effectiveAutoAdvance ? NEXT_STATUS : undefined;
	if (movedTo) {
		await pm.moveWorkItem(workItem.id, movedTo);
	}
	// Make labeling the final required success action (issue #384):
	// if labeling throws, the comment and status move have already occurred, but the phase
	// remains marked as failed, and subsequent retries find this delivery's comment via its marker.
	await applyPlannedLabel(pm, workItem, taskId);
	logger.info('Phase finished - Planning (preplanned — agent skipped)', {
		taskId,
		workItemId: workItem.id,
		commentId,
		movedTo,
	});
	return { plan, commentId, agent: skippedAgentResult(cli), movedTo, preplanned: true };
}

/**
 * Try to reuse a preplanned plan for split children, skipping the agent run.
 */
async function tryPreplannedPlanning(
	workItem: WorkItem,
	isSplitChild: boolean,
	effectiveAutoAdvance: boolean,
	pm: PMProvider,
	cli: AgentCli,
	taskId: string,
	deliveryId: string | undefined,
): Promise<PlanningPhaseResult | undefined> {
	const preplan = evaluatePreplan(workItem);
	if (isPreplanSkip(preplan)) {
		if (isSplitChild) {
			logger.info('Phase started - Planning — reusing preplanned split-child plan', {
				taskId,
				workItemId: workItem.id,
				splitId: preplan.contract.splitId,
			});
			return completePreplannedRun(
				pm,
				workItem,
				preplan.contract.plan,
				effectiveAutoAdvance,
				cli,
				taskId,
				deliveryId,
			);
		}
		logger.warn('Planning — valid preplan marker on a non-split-child item; ignoring', {
			taskId,
			workItemId: workItem.id,
			splitId: preplan.contract.splitId,
		});
	} else if (preplan.fallbackReason) {
		logger.info('Planning — preplanned marker rejected, running agent normally', {
			taskId,
			workItemId: workItem.id,
			reason: preplan.fallbackReason,
		});
	}
	return undefined;
}

interface VerifyAndApplyPlanningResultOptions {
	project: ProjectConfig;
	workItem: WorkItem;
	taskId: string;
	pm: PMProvider;
	autoSplit: boolean;
	maxConcerns: number;
	effectiveAutoAdvance: boolean;
	plan: string;
	agent: AgentCliResult;
	handlePath: string;
	cli: AgentCli;
	/** Run-row id used as this delivery's idempotency marker; undefined when no run row. */
	deliveryId: string | undefined;
}

/**
 * Verify scope, process splits, post comments, advance status, and apply the planned label.
 */
async function verifyAndApplyPlanningResult(options: VerifyAndApplyPlanningResultOptions) {
	const {
		project,
		workItem,
		taskId,
		pm,
		autoSplit,
		maxConcerns,
		effectiveAutoAdvance,
		plan,
		agent,
		handlePath,
		cli,
		deliveryId,
	} = options;

	// Validate human-readable scope gate exists in the plan (issue #268)
	if (autoSplit) {
		if (!/##\s*scope\s*gate/i.test(plan)) {
			logAgentFailure(taskId, workItem.id, agent);
			throw new Error(
				`Planning agent (${cli}) did not include the required "## Scope gate" section in ${PROPOSED_PLAN_FILENAME}. ` +
					`Ensure the plan opens with this section describing the scope.`,
			);
		}
	}

	// The agent may have decided to split (only honored when autoSplit is on).
	// The re-scope/rename and sibling spawns happen before the first task is
	// greenlit below, so autoAdvance never fires ahead of the siblings existing.
	const split = autoSplit ? readProposedSplit(handlePath) : undefined;

	// Deterministic scope gate (issue #268), only when splitting is enabled: the
	// planner must have recorded a validated scope declaration, and an unsplit
	// single task that declares too many independent concerns is rejected here —
	// before anything is posted or advanced — rather than reaching Implementation.
	const planningScope = autoSplit ? readProposedScope(handlePath) : undefined;
	if (planningScope && !split) {
		enforceSingleTaskBudget(planningScope, maxConcerns, taskId, workItem);
	}

	// Look up *this* delivery's own comment by its unique marker (not any comment
	// under the shared heading), so a retry of this delivery reuses its comment and
	// skips the split it already performed, while a genuine replan — a fresh run row,
	// hence a new marker — posts its new plan and runs its split. Skipped when no run
	// row is available (direct/test invocations): then we always post.
	let commentId = deliveryId
		? await pm.findComment(workItem.id, planDeliveryMarker(deliveryId))
		: undefined;
	let splitResult: Awaited<ReturnType<typeof applySplit>> | undefined;

	if (!commentId) {
		splitResult = split
			? await applySplit(pm, workItem, split, resolveAutomationLabel(project.pipeline))
			: undefined;
		commentId = await pm.addComment(
			workItem.id,
			planCommentBody(plan, effectiveAutoAdvance, deliveryId),
		);
	}

	const movedTo = effectiveAutoAdvance ? NEXT_STATUS : undefined;
	if (movedTo) {
		await pm.moveWorkItem(workItem.id, movedTo);
	}

	// Make labeling the final required success action (issue #384):
	// if labeling throws, the comment and status move have already occurred, but the phase
	// remains marked as failed, and subsequent retries find this delivery's comment via its marker.
	await applyPlannedLabel(pm, workItem, taskId);

	return { commentId, movedTo, split: splitResult, planningScope };
}

export async function runPlanningPhase(
	options: RunPlanningPhaseOptions,
): Promise<PlanningPhaseResult> {
	const {
		project,
		workItem,
		taskId,
		pm,
		cli = DEFAULT_PLANNING_CLI,
		model,
		reasoning,
		customPrompt,
		sessionId,
		resumeSessionId,
		runId,
		recoveryMode,
		autoAdvance = DEFAULT_AUTO_ADVANCE,
		autoSplit = DEFAULT_AUTO_SPLIT,
		maxConcerns = DEFAULT_MAX_CONCERNS,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
	} = options;
	// A spawned split-child never auto-advances to "ToDo" on its own — the human
	// sequences the siblings — so its own Planning run forces autoAdvance off,
	// whatever the project config says (see SPLIT_CHILD_LABEL).
	const isSplitChild = workItem.labels.some((l) => l.name === SPLIT_CHILD_LABEL);
	const effectiveAutoAdvance = autoAdvance && !isSplitChild;

	const preplannedResult = await tryPreplannedPlanning(
		workItem,
		isSplitChild,
		effectiveAutoAdvance,
		pm,
		cli,
		taskId,
		runId,
	);
	if (preplannedResult) {
		return preplannedResult;
	}

	const worktrees = options.worktrees ?? new GitWorktreeManager(project);

	logger.info(`Phase started - Planning — running ${describeAgent(cli, model, reasoning)}`, {
		taskId,
		workItemId: workItem.id,
		cli,
		model,
		reasoning,
	});

	// Read-only checkout: detached HEAD, no task branch (see ProvisionOptions.detach).
	// Claude 2.1.207 also reattaches after recreating this exact path, but a missing
	// checkout intentionally takes the safer from-scratch path requested by #155.
	const { handle, resumed } = await acquirePlanningWorktree(
		worktrees,
		taskId,
		project.baseBranch,
		resumeSessionId,
		recoveryMode,
		runId,
	);
	let preserveForResume = false;
	try {
		graft(project.repoRoot, handle.path);

		const agent = await runAgent({
			cli,
			model,
			reasoning,
			...sessionRunArgs({ sessionId, resumeSessionId }, resumed),
			cwd: handle.path,
			args: [buildPlanningPrompt(workItem, autoSplit, customPrompt, maxConcerns)],
			maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
			logContext: { taskId, phase: 'planning', workItemId: workItem.id },
			timeoutMs,
			signal,
		});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, workItem.id, agent);
			const error = agentRunError(
				agent,
				`Planning agent (${cli}) exited with code ${agent.exitCode}`,
				` for task '${taskId}'`,
			);
			preserveForResume = shouldPreserveForResume(error);
			throw error;
		}

		const plan = readPlanOrThrow(handle.path, cli, taskId, workItem, agent);

		const result = await verifyAndApplyPlanningResult({
			project,
			workItem,
			taskId,
			pm,
			autoSplit,
			maxConcerns,
			effectiveAutoAdvance,
			plan,
			agent,
			handlePath: handle.path,
			cli,
			deliveryId: runId,
		});

		logger.info('Phase finished - Planning', {
			taskId,
			workItemId: workItem.id,
			commentId: result.commentId,
			movedTo: result.movedTo,
			splitInto: result.split?.subTaskItemIds.length,
		});

		return {
			plan,
			commentId: result.commentId,
			agent,
			movedTo: result.movedTo,
			split: result.split,
			planningScope: result.planningScope,
		};
	} finally {
		await cleanupUnlessPreserved(worktrees, taskId, preserveForResume, 'planning phase', runId);
	}
}
