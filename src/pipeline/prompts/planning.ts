/**
 * Planning-phase prompt construction (issue #135). Holds only the phase's static
 * instruction text and the hand-off filenames the prompt names; the phase
 * orchestration (worktree, agent run, PM moves, splitting) stays in
 * `src/pipeline/planning.ts`, which re-exports these for its existing callers.
 */

import { pipelinePhaseGuard } from '@/pipeline/agent-scope.js';
import { projectInstructionsSection } from '@/pipeline/prompts/custom-prompt.js';
import type { WorkItem } from '@/pm/types.js';

/** The file the planning agent is instructed to write its plan to, at the worktree root. */
export const PROPOSED_PLAN_FILENAME = 'proposed_plan.md';

/**
 * The machine-readable scope declaration the planning agent writes alongside
 * `proposed_plan.md` when splitting is enabled (issue #268). It mirrors the
 * human-readable "Scope gate" section of the plan as a validated shape SWARM's
 * deterministic post-plan guard reads (`ProposedScopeSchema` / `readProposedScope`
 * in `src/pipeline/planning.ts`) — structured, planner-declared metadata rather
 * than a fragile free-text heuristic. Its `independentConcerns` list is the
 * concrete split trigger: two or more entries with no `proposed_split.json`
 * means an oversized single task, which fails Planning instead of silently
 * advancing to Implementation.
 */
export const PROPOSED_SCOPE_FILENAME = 'proposed_scope.json';

/**
 * The file the planning agent writes when it decides the task is too large for
 * a single PR and should be split (see {@link buildPlanningPrompt}). Absent (or
 * empty `subTasks`) means "no split — plan as a single task". Read-and-validated
 * by `readProposedSplit` (`src/pipeline/planning.ts`); `proposed_plan.md` still
 * carries the plan for the (now-smaller) first task the original item becomes.
 */
export const PROPOSED_SPLIT_FILENAME = 'proposed_split.json';

/**
 * Build the prompt handed to the planning agent. It's told to explore the repo
 * and write a step-by-step implementation plan to `proposed_plan.md` — and, since
 * this is a read-only phase, explicitly *not* to modify code or implement
 * anything (mirroring Cascade's planning agent, which is read/write-to-PM only).
 *
 * The prompt always carries a minimal-scope rule (plan the smallest change that
 * satisfies the item; no speculative generalization — issue #268).
 *
 * When `allowSplit` is on (the project's `pipeline.planning.autoSplit`), the
 * agent is additionally told concrete split criteria and to judge whether the
 * work is too large for a single focused PR and, if so, to split it:
 * `proposed_plan.md` then covers only the first (now-smaller) task, and
 * `proposed_split.json` lists the remaining sibling tasks (see
 * {@link PROPOSED_SPLIT_FILENAME}), named with one shared task name so every phase
 * of one issue is recognisable together on the board (issue #594 — SWARM enforces
 * that convention on the titles it writes, `src/pipeline/split-naming.ts`, so the
 * prompt asks for it rather than relying on it). A right-sized task is left whole. It is also
 * told to record a scope gate — a "## Scope gate" section in `proposed_plan.md`
 * and a machine-readable {@link PROPOSED_SCOPE_FILENAME} — that SWARM's
 * deterministic post-plan guard validates.
 *
 * `customPrompt` is the project's optional per-phase instructions (issue #135):
 * appended after the SWARM instructions and before the work-item context as a
 * clearly delimited, supplement-only section (empty when unset).
 */
export function buildPlanningPrompt(
	workItem: WorkItem,
	allowSplit = false,
	customPrompt?: string,
	maxConcerns = 1,
): string {
	const lines = [
		'You are a senior software architect creating a detailed implementation plan.',
		'',
		...pipelinePhaseGuard(),
		'',
		'PLANNING ONLY. Do NOT implement, edit, or create any source files, and do NOT',
		'run any command that changes the repository. Your sole deliverable is a plan',
		`(the file(s) named below at the root of this worktree — nothing else).`,
		'',
		'Explore this repository to understand its existing patterns and conventions,',
		'then write a concrete, step-by-step implementation plan for the work item below.',
		'The plan must cover: the files to add/change, the approach, the testing strategy,',
		'and anything intentionally left out of scope.',
		'',
		'SCOPE DISCIPLINE — plan the SMALLEST change that fully satisfies the work item:',
		'  - Prefer existing mechanisms, patterns, and call sites over new configuration,',
		'    abstractions, or generalized frameworks.',
		'  - Do NOT add fallback providers, new settings, cross-cutting lifecycle changes,',
		'    or speculative extensibility unless the work item explicitly requires them.',
		'  - Treat the acceptance criteria as the UPPER BOUND of scope, not a starting',
		'    point for adjacent improvements or refactors.',
	];

	if (allowSplit) {
		lines.push(
			'',
			'SPLIT DECISION — concrete criteria, not a subjective call:',
			`  - A task MUST be split when it combines more than ${maxConcerns} INDEPENDENT ${maxConcerns === 1 ? 'concern' : 'concerns'} —`,
			'    e.g. retry policy + provider selection/configuration; worker scheduling +',
			'    worktree lifecycle; backend behavior + unrelated dashboard/configuration work.',
			'  - A task that changes ONE existing lifecycle or policy together with its',
			'    focused tests normally stays a SINGLE task. Several tests, or several',
			'    closely-related files, are NOT by themselves a reason to split.',
			'  - Each split child must be independently shippable with a narrow acceptance',
			'    boundary.',
			'',
			'FIRST, judge the size of this work item. If it is too large to implement well',
			'in a single focused pull request, SPLIT it into smaller, independently-shippable',
			'tasks ordered so each builds on the last:',
			`  - Write "${PROPOSED_PLAN_FILENAME}" as the plan for ONLY the FIRST task — the`,
			'    smaller piece this item should become. It may be a re-scoped, renamed version',
			'    of the original.',
			'  - You have already explored the repository to plan the first task. REUSE that',
			'    analysis: write a concise implementation plan for EVERY other task now, while',
			'    that context is fresh, so each one does not have to re-explore the repo later.',
			`  - Write "${PROPOSED_SPLIT_FILENAME}" as JSON of this exact shape:`,
			'      {',
			'        "sharedName": "<concise name every phase of this split shares>",',
			'        "mainTask": { "title": "<first task\'s title>", "description": "<its scope>" },',
			'        "subTasks": [',
			'          {',
			'            "title": "<next task>",',
			'            "description": "<what it covers, self-contained>",',
			'            "plan": "<concise Markdown implementation plan for this task>"',
			'          }',
			'        ]',
			'      }',
			'    "mainTask" is OPTIONAL — include it only to re-scope the original item;',
			'    omit it to keep the original description. Either way SWARM renames the',
			'    original card to phase 1 of the naming convention below.',
			'    CHOOSE ONE SHARED TASK NAME for this split — two to five words naming the',
			'    overall effort (e.g. "Trello PM", "Split card naming") — put it in',
			'    "sharedName", and use that exact name, unchanged, for the original task and',
			'    for every child. It is what makes all phases of one issue recognisable',
			"    together in the board's Planning column, so it must distinguish this split",
			'    from other issues that happen to have the same number of phases.',
			'    ORDER THE TITLES BY PHASE. The first task (mainTask, or the original item if',
			'    you omit it) is phase 1, each "subTasks" entry the next phase. TITLE EVERY',
			'    TASK "<shared task name> <phase>/<total>: <this phase\'s task>", e.g.',
			'    "Trello PM 1/3: Board reads", "Trello PM 2/3: Board writes",',
			'    "Trello PM 3/3: The dependency opt-out" — the shared name FIRST, never a',
			'    bare "Phase 2/3: …". A later phase must never be startable before its',
			'    predecessors — SWARM also records this as a blocked-by relationship and',
			'    defers a phase whose predecessors are still open, so make each',
			'    "description" state which earlier phases it needs.',
			'    Each "subTasks" entry is a task planned separately later. Write its "description"',
			'    complete enough to stand on its own, and its "plan" (concise GitHub-flavored',
			'    Markdown) covering:',
			'      * self-contained scope and acceptance criteria;',
			'      * anything intentionally left out of scope;',
			'      * the relevant files, symbols, and existing patterns to follow;',
			'      * dependencies on the preceding split tasks (what must land first);',
			'      * an ordered implementation outline;',
			'      * focused verification guidance (the checks/tests to run).',
			`  - Do NOT write "${PROPOSED_SPLIT_FILENAME}" (or write it with an empty`,
			'    "subTasks" array) when the item is already right-sized — then just write the',
			`    single "${PROPOSED_PLAN_FILENAME}" as usual.`,
			'',
			'SCOPE GATE — required whether or not you split, describing the SINGLE task you',
			`plan in "${PROPOSED_PLAN_FILENAME}" (the FIRST task, if you split). Open the plan`,
			'with a "## Scope gate" section carrying three short bullet lists:',
			'  - "Why this is one task" — the single-task justification;',
			'  - "Affected areas / files" — the areas and files this task changes;',
			'  - "Explicitly out of scope" — what you are deliberately NOT doing.',
			`Also write "${PROPOSED_SCOPE_FILENAME}" at the worktree root — the machine-readable`,
			'mirror SWARM validates — of this exact shape:',
			'  {',
			'    "whyOneTask": "<one or two sentences: why this is a single cohesive task>",',
			'    "independentConcerns": ["<each genuinely independent concern this task combines>"],',
			'    "affectedAreas": ["<area or file>", "..."],',
			'    "outOfScope": ["<thing deliberately excluded>", "..."]',
			'  }',
			'List EVERY genuinely independent concern in "independentConcerns". If that list',
			`has more than ${maxConcerns} ${maxConcerns === 1 ? 'entry' : 'entries'} you MUST split (emit the split file above) — an`,
			`unsplit oversized plan is REJECTED. A single cohesive task leaves at most ${maxConcerns} ${maxConcerns === 1 ? 'entry' : 'entries'}.`,
		);
	}

	lines.push(
		'',
		`Write the plan to a file named "${PROPOSED_PLAN_FILENAME}" at the root of this`,
		'worktree, as GitHub-flavored Markdown.',
		...projectInstructionsSection(customPrompt),
		'',
		'--- WORK ITEM ---',
		`Title: ${workItem.title}`,
		`URL: ${workItem.url}`,
		'',
		'Description:',
		workItem.description || '(no description provided)',
	);
	return lines.join('\n');
}
