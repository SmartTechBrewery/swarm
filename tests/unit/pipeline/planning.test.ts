import { beforeEach, describe, expect, it, vi } from 'vitest';

// The plan, split, and scope files are read via node:fs; presence + contents are
// controlled per test, keyed on the filename so the files are independent.
let planExists: boolean;
let planContents: string;
let splitExists: boolean;
let splitContents: string;
let scopeExists: boolean;
let scopeContents: string;
function fsFor(path: unknown): { exists: boolean; contents: string } {
	const p = String(path);
	if (p.endsWith('proposed_split.json')) return { exists: splitExists, contents: splitContents };
	if (p.endsWith('proposed_scope.json')) return { exists: scopeExists, contents: scopeContents };
	return { exists: planExists, contents: planContents };
}
vi.mock('node:fs', () => ({
	existsSync: (path: unknown) => fsFor(path).exists,
	readFileSync: (path: unknown) => fsFor(path).contents,
}));

import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import {
	buildPlanningPrompt,
	PLANNED_LABEL,
	PREPLAN_COMMENT_MARKER_PREFIX,
	PROPOSED_PLAN_FILENAME,
	PROPOSED_SCOPE_FILENAME,
	PROPOSED_SPLIT_FILENAME,
	planCommentBody,
	preplanCommentBody,
	preplanCommentMarker,
	runPlanningPhase,
	SPLIT_CHILD_LABEL,
	splitChildCommentBody,
} from '@/pipeline/planning.js';
import {
	buildPreplanContract,
	embedPreplanMarker,
	evaluatePreplan,
	isPreplanSkip,
} from '@/pipeline/preplan.js';
import { parseSplitTitle } from '@/pipeline/split-naming.js';
import type { UpdateWorkItemPatch, WorkItem } from '@/pm/types.js';
import { isSwarmGeneratedBody } from '@/scm/swarm-origin.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { createMockProjectConfig, createMockWorkItem } from '../../helpers/factories.js';

/**
 * Build a split-child work item whose issue body carries a valid preplanned
 * marker (matching url + description hash) for the given plan. `overrides`
 * tweaks the item after the marker is embedded — e.g. to break the url binding
 * or drop the split-child label for the fallback tests.
 */
function preplannedChild(
	plan: string,
	humanDescription = 'The UI slice, self-contained.',
	overrides: Partial<WorkItem> = {},
): WorkItem {
	const url = 'https://github.com/o/r/issues/42';
	const contract = buildPreplanContract({
		splitId: 'split-abc',
		childIndex: 0,
		parentUrl: 'https://github.com/o/r/issues/18',
		itemUrl: url,
		humanDescription,
		plan,
		generatedAt: '2026-07-14T00:00:00.000Z',
	});
	return createMockWorkItem({
		id: 'PVTI_child',
		title: 'A spawned task',
		url,
		description: embedPreplanMarker(humanDescription, contract),
		labels: [{ id: SPLIT_CHILD_LABEL, name: SPLIT_CHILD_LABEL }],
		...overrides,
	});
}

/**
 * Decode the plan back out of an embedded marker by running it through the same
 * evaluatePreplan path a child would — `itemUrl` is the created sibling's url
 * (the createWorkItem mock uses the title as the url).
 */
function planFromMarker(description: string, itemUrl: string): string | undefined {
	const decision = evaluatePreplan(
		createMockWorkItem({
			url: itemUrl,
			description,
			labels: [{ id: SPLIT_CHILD_LABEL, name: SPLIT_CHILD_LABEL }],
		}),
	);
	return isPreplanSkip(decision) ? decision.contract.plan : undefined;
}

const WORKTREE_PATH = '/Users/dev/swarm/swarm/.swarm-workspaces/task-18';

/**
 * The shared task name the split fixtures below declare, and the board title SWARM
 * writes for one of their phases (issue #594) — every card of a split is titled
 * `<shared name> <phase>/<total>: <phase-specific task>`.
 */
const SHARED_NAME = 'Big task';
const splitTitle = (phase: number, totalPhases: number, task: string) =>
	`${SHARED_NAME} ${phase}/${totalPhases}: ${task}`;

function agentResult(overrides: Partial<AgentCliResult> = {}): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 42,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
		...overrides,
	};
}

function makeDeps() {
	const handle: WorktreeHandle = {
		taskId: '18',
		path: WORKTREE_PATH,
		branch: 'main',
		detached: true,
	};
	const worktrees = {
		provision: vi.fn(async () => handle),
		worktreePath: vi.fn(() => handle.path),
		reuse: vi.fn(async () => handle),
		cleanup: vi.fn(async () => {}),
	};
	const pm = {
		type: 'github-projects' as const,
		getWorkItem: vi.fn(),
		listWorkItems: vi.fn(),
		findWorkItemByUrlSuffix: vi.fn(async () => undefined),
		findWorkItemForArtifact: vi.fn(async () => undefined),
		findWorkItemByDescriptionMarker: vi.fn<(marker: string) => Promise<WorkItem | undefined>>(
			async () => undefined,
		),
		addComment: vi.fn<(id: string, text: string) => Promise<string>>(async () => 'comment-1'),
		findComment: vi.fn<(id: string, marker: string) => Promise<string | undefined>>(
			async () => undefined,
		),
		moveWorkItem: vi.fn(async () => {}),
		createWorkItem: vi.fn(async (input) => {
			// Key the fake id/url on the phase-specific half of the title, so a card
			// stays addressable as `PVTI_Second slice` now that SWARM prefixes every
			// split title with the split's shared name (issue #594).
			const { task } = parseSplitTitle(input.title);
			return createMockWorkItem({ id: `PVTI_${task}`, title: input.title, url: task });
		}),
		updateWorkItem: vi.fn<(id: string, patch: UpdateWorkItemPatch) => Promise<void>>(
			async () => {},
		),
		addLabel: vi.fn<(id: string, name: string) => Promise<void>>(async () => {}),
		supportsDependencies: true,
		supportsAssignees: true,
		listBlockers: vi.fn(async () => []),
		listDependents: vi.fn(async () => []),
		addBlockedBy: vi.fn<(id: string, blockerId: string) => Promise<void>>(async () => {}),
		resolveItemRepository: vi.fn(async () => ({ status: 'unrouted' }) as const),
	};
	return {
		project: createMockProjectConfig(),
		workItem: createMockWorkItem({ id: 'PVTI_item18', title: 'Add planning phase' }),
		taskId: '18',
		pm,
		worktrees: worktrees as unknown as GitWorktreeManager,
		runAgent: vi.fn<(opts: RunAgentCliOptions) => Promise<AgentCliResult>>(async () =>
			agentResult(),
		),
		graft: vi.fn(() => []),
	};
}

/**
 * The body of a comment posted on split child `itemId` — its published preplan
 * comment when `preplan` is true (issue #431), else its split-explanation comment.
 * A fully prepared child receives exactly those two, told apart by the preplan
 * comment's own idempotency marker.
 */
function childComment(
	deps: ReturnType<typeof makeDeps>,
	itemId: string,
	preplan: boolean,
): string | undefined {
	return deps.pm.addComment.mock.calls.find(
		(call) => call[0] === itemId && call[1].includes(PREPLAN_COMMENT_MARKER_PREFIX) === preplan,
	)?.[1];
}

describe('runPlanningPhase', () => {
	beforeEach(() => {
		planExists = true;
		planContents =
			'## Scope gate\n- Why this is one task: cohesive change\n- Affected areas / files: planning.ts\n- Explicitly out of scope: none\n\n# Plan\n\n1. Do the thing.';
		// No split by default — most tests exercise the single-task path.
		splitExists = false;
		splitContents = '';
		// A valid, within-budget scope gate by default — autoSplit is on by default,
		// so the guard reads this on every agent-path run (issue #268).
		scopeExists = true;
		scopeContents = JSON.stringify({
			whyOneTask: 'One cohesive lifecycle change plus its tests.',
			independentConcerns: ['the planning phase'],
			affectedAreas: ['src/pipeline/planning.ts'],
			outOfScope: ['unrelated dashboard work'],
		});
	});

	it('provisions a detached worktree, runs the planning agent, posts the plan, and leaves the item in Planning by default (autoAdvance off)', async () => {
		const deps = makeDeps();
		const result = await runPlanningPhase(deps);

		// Read-only checkout: detached, so no task branch is created/held.
		expect(deps.worktrees.provision).toHaveBeenCalledWith('18', { detach: true });

		// The planning agent is run with the worktree as CWD and the planning
		// prompt. Defaults to Claude Code (see DEFAULT_PLANNING_CLI's comment) —
		// not Antigravity per PROJECT.md §5.1 — until Antigravity's setup path exists.
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.cli).toBe('claude');
		expect(runArgs.cwd).toBe(WORKTREE_PATH);
		expect(runArgs.args?.[0]).toContain('Add planning phase');

		// Env is grafted into the worktree before the agent runs.
		expect(deps.graft).toHaveBeenCalledWith(deps.project.repoRoot, WORKTREE_PATH);

		// The plan is posted on the linked item; the item itself stays in Planning —
		// `autoAdvance` is unset, which defaults to false, so a human moves it
		// to ToDo themselves after reviewing.
		expect(deps.pm.addComment).toHaveBeenCalledTimes(1);
		expect(deps.pm.addComment.mock.calls[0][0]).toBe('PVTI_item18');
		expect(deps.pm.addComment.mock.calls[0][1]).toContain('Do the thing.');
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();

		// The item is marked `planned` on successful completion (issue #384),
		// after the plan comment is posted, and independently of the
		// board-Status move autoAdvance is off here.
		expect(deps.pm.addLabel).toHaveBeenCalledTimes(1);
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_item18', 'planned');
		expect(deps.pm.addLabel.mock.invocationCallOrder[0]).toBeGreaterThan(
			deps.pm.addComment.mock.invocationCallOrder[0],
		);

		// Worktree is always cleaned up.
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');

		expect(result).toMatchObject({
			commentId: 'comment-1',
			plan: '## Scope gate\n- Why this is one task: cohesive change\n- Affected areas / files: planning.ts\n- Explicitly out of scope: none\n\n# Plan\n\n1. Do the thing.',
			movedTo: undefined,
			planningScope: {
				whyOneTask: 'One cohesive lifecycle change plus its tests.',
				independentConcerns: ['the planning phase'],
			},
		});
	});

	it('moves the item to todo when autoAdvance is on', async () => {
		const deps = makeDeps();
		const result = await runPlanningPhase({ ...deps, autoAdvance: true });

		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_item18', 'todo');
		expect(result).toMatchObject({ movedTo: 'todo' });
		// The label is applied regardless of whether autoAdvance moves the Status.
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_item18', 'planned');
	});

	it('splits a large task: marks each sibling before moving it to Planning, and re-scopes the original', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			sharedName: SHARED_NAME,
			mainTask: { title: 'First slice', description: 'Just the API' },
			subTasks: [
				{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Build it.' },
				{ title: 'Third slice', description: 'The docs', plan: '# Docs plan\n\n1. Write it.' },
			],
		});
		const deps = makeDeps();
		const result = await runPlanningPhase({ ...deps, autoAdvance: true });

		// Original re-scoped and renamed into the smaller first task — phase 1 of the
		// split's shared name, the same convention its children get (issue #594).
		expect(deps.pm.updateWorkItem).toHaveBeenCalledWith('PVTI_item18', {
			title: splitTitle(1, 3, 'First slice'),
			description: 'Just the API',
		});

		// Two siblings are first created in Backlog with the split-child label and
		// human description, so the marker can be embedded before Planning is observed.
		expect(deps.pm.createWorkItem).toHaveBeenCalledTimes(2);
		for (const call of deps.pm.createWorkItem.mock.calls) {
			expect(call[0]).toMatchObject({
				status: 'backlog',
				labels: ['swarm', SPLIT_CHILD_LABEL],
			});
		}
		expect(deps.pm.createWorkItem.mock.calls.map((c) => c[0].title)).toEqual([
			splitTitle(2, 3, 'Second slice'),
			splitTitle(3, 3, 'Third slice'),
		]);

		// Each sibling's body is updated to embed its parent-written plan as a
		// preplanned marker, so its own Planning run reuses it (issue #178). The
		// payload is base64 (see embedPreplanMarker), so assert the plan round-trips
		// back out via evaluatePreplan rather than looking for it as literal text.
		const secondMarker = deps.pm.updateWorkItem.mock.calls.find(
			(c) => c[0] === 'PVTI_Second slice',
		)?.[1];
		expect(secondMarker?.description).toContain('swarm-preplan:v1');
		expect(secondMarker?.description).toContain('The UI'); // human description preserved
		expect(planFromMarker(secondMarker?.description ?? '', 'Second slice')).toBe(
			'# UI plan\n\n1. Build it.',
		);
		const thirdMarker = deps.pm.updateWorkItem.mock.calls.find(
			(c) => c[0] === 'PVTI_Third slice',
		)?.[1];
		expect(planFromMarker(thirdMarker?.description ?? '', 'Third slice')).toBe(
			'# Docs plan\n\n1. Write it.',
		);

		// Each child enters Planning only after its marker was written and it was
		// labeled `planned` (issues #426, #436, #737) — planned by construction, and
		// carrying the label its own Planning dispatch is gated on before the move that
		// would dispatch it.
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_Second slice', 'planning');
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_Third slice', 'planning');
		const secondMarkerOrder = deps.pm.updateWorkItem.mock.invocationCallOrder[1];
		const secondPlanningOrder = deps.pm.moveWorkItem.mock.invocationCallOrder[0];
		expect(secondMarkerOrder).toBeLessThan(secondPlanningOrder);

		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_Second slice', PLANNED_LABEL);
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_Third slice', PLANNED_LABEL);

		// Each sibling gets an explanatory comment and its published preplan (issue
		// #431), plus the original's plan comment.
		const commentTargets = deps.pm.addComment.mock.calls.map((c) => c[0]);
		expect(commentTargets).toContain('PVTI_Second slice');
		expect(commentTargets).toContain('PVTI_Third slice');
		const secondComment = childComment(deps, 'PVTI_Second slice', false);
		// Phase 2 of 3, blocked by phase 1 (the re-scoped original) and no one else.
		expect(secondComment).toMatch(/Phase 2 of 3 — split from a larger task/);
		expect(secondComment).toMatch(/Blocked by/);
		expect(secondComment).toContain(`Phase 1: ${splitTitle(1, 3, 'First slice')}`);
		expect(secondComment).not.toContain('Phase 2: ');
		expect(secondComment).toContain('placed it in **Planning**');

		const thirdComment = childComment(deps, 'PVTI_Third slice', false);
		// Phase 3 of 3, cumulatively blocked by BOTH earlier phases.
		expect(thirdComment).toMatch(/Phase 3 of 3 — split from a larger task/);
		expect(thirdComment).toContain(`Phase 1: ${splitTitle(1, 3, 'First slice')}`);
		expect(thirdComment).toContain(`Phase 2: ${splitTitle(2, 3, 'Second slice')}`);

		// Guard 2 (issue #330): cumulative native blocked-by — phase N blocked by
		// every predecessor. Phase 2 ← [phase 1]; phase 3 ← [phase 1, phase 2].
		const blockedByPairs = deps.pm.addBlockedBy.mock.calls.map(([id, blockerId]) => [
			id,
			blockerId,
		]);
		expect(blockedByPairs).toEqual([
			['PVTI_Second slice', 'PVTI_item18'],
			['PVTI_Third slice', 'PVTI_item18'],
			['PVTI_Third slice', 'PVTI_Second slice'],
		]);

		// The first task still auto-advances (autoAdvance on, not a split-child).
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_item18', 'todo');
		expect(result.split).toEqual({
			subTaskItemIds: ['PVTI_Second slice', 'PVTI_Third slice'],
			mainTaskUpdated: true,
		});
	});

	it('labels split children with the project-configured automation label (issue #131)', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			sharedName: SHARED_NAME,
			subTasks: [{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Do it.' }],
		});
		const deps = makeDeps();
		deps.project = createMockProjectConfig({ pipeline: { automationLabel: 'automate' } });

		await runPlanningPhase(deps);

		// Without this the sibling SWARM just created would be gated out of SWARM's
		// own pipeline by the very label the project configured. The parent's own
		// labels come along too (issue #594), whatever this project gates on.
		expect(deps.pm.createWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({ labels: ['swarm', 'automate', SPLIT_CHILD_LABEL] }),
		);
	});

	it('gives every child the original task’s labels, deduplicated (issue #594)', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			sharedName: SHARED_NAME,
			subTasks: [{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Do it.' }],
		});
		const deps = makeDeps();
		deps.workItem = createMockWorkItem({
			id: 'PVTI_item18',
			title: 'Add planning phase',
			labels: [
				{ id: 'LA_bug', name: 'bug' },
				{ id: 'LA_swarm', name: 'swarm' },
				// A lifecycle claim about the *parent* card that would be false the moment
				// it was copied onto a child.
				{ id: 'LA_planned', name: PLANNED_LABEL },
			],
		});

		await runPlanningPhase(deps);

		// The type label rides along so the phase still reads as a bug on the board,
		// the automation label is not duplicated, and `planned` is not inherited — it is
		// earned once the child really holds its plan (issue #436), and inheriting it
		// would leave a child whose preparation failed permanently un-plannable now that
		// the label is the Planning gate (issue #737).
		expect(deps.pm.createWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({ labels: ['bug', 'swarm', SPLIT_CHILD_LABEL] }),
		);
	});

	it('labels a prepared split child `planned` before the Planning move (issues #426, #737)', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			sharedName: SHARED_NAME,
			subTasks: [{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Do it.' }],
		});
		const deps = makeDeps();

		await runPlanningPhase(deps);

		// The label is a follow-up write, not a creation label (issue #436), so a
		// failed preparation can't leave it behind...
		expect(deps.pm.createWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({ labels: ['swarm', SPLIT_CHILD_LABEL] }),
		);
		// ...but it lands after the marker write and *before* the Planning move, which
		// is the event `pm-status` dispatches on. Labelling after the move would race
		// every split child into the Planning dispatch the label exists to stop, which
		// is what "a split child still costs no Planning agent run" rules out.
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_Second slice', PLANNED_LABEL);
		const markerCall = deps.pm.updateWorkItem.mock.calls.findIndex(
			(call) => call[0] === 'PVTI_Second slice',
		);
		const markerOrder = deps.pm.updateWorkItem.mock.invocationCallOrder[markerCall];
		const childLabelOrder = deps.pm.addLabel.mock.invocationCallOrder[0];
		const childPlanningOrder = deps.pm.moveWorkItem.mock.invocationCallOrder[0];
		expect(childLabelOrder).toBeGreaterThan(markerOrder);
		expect(childLabelOrder).toBeLessThan(childPlanningOrder);
	});

	it('keeps splitting when labeling a prepared split child `planned` throws (issue #436)', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			sharedName: SHARED_NAME,
			subTasks: [
				{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Do it.' },
				{ title: 'Third slice', description: 'The docs', plan: '# Docs plan\n\n1. Write it.' },
			],
		});
		const deps = makeDeps();
		// Still best-effort now that the label is load-bearing (issue #737): a refused
		// label must never abort the split mid-loop. What it costs is bounded — the
		// child moves to Planning unlabeled, that dispatch finds its still-valid preplan
		// marker, reuses the plan without spending an agent, and re-applies the label as
		// a hard step.
		deps.pm.addLabel = vi.fn<(id: string, name: string) => Promise<void>>(async (id) => {
			if (id === 'PVTI_Second slice') throw new Error('board rejected the label');
		});

		const result = await runPlanningPhase(deps);

		expect(result.split).toMatchObject({
			subTaskItemIds: ['PVTI_Second slice', 'PVTI_Third slice'],
		});
		// The refused child is still moved and still prepared; the next sibling is
		// labeled as usual.
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_Second slice', 'planning');
		expect(childComment(deps, 'PVTI_Second slice', false)).toContain('placed it in **Planning**');
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_Third slice', PLANNED_LABEL);
	});

	it('labels split children with only the inherited and split-child labels when the gate is disabled', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			sharedName: SHARED_NAME,
			subTasks: [{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Do it.' }],
		});
		const deps = makeDeps();
		deps.project = createMockProjectConfig({ pipeline: { automationLabel: '' } });
		// An unlabeled parent, so nothing but the split-child label can appear: with the
		// gate disabled no automation label is added on top of what was inherited.
		deps.workItem = createMockWorkItem({
			id: 'PVTI_item18',
			title: 'Add planning phase',
			labels: [],
		});

		await runPlanningPhase(deps);

		expect(deps.pm.createWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({ labels: [SPLIT_CHILD_LABEL] }),
		);
	});

	it('does not split when autoSplit is off, even if a split file exists', async () => {
		splitExists = true;
		splitContents = JSON.stringify({ subTasks: [{ title: 'X', description: 'Y' }] });
		const deps = makeDeps();
		const result = await runPlanningPhase({ ...deps, autoSplit: false });
		expect(deps.pm.createWorkItem).not.toHaveBeenCalled();
		expect(deps.pm.updateWorkItem).not.toHaveBeenCalled();
		expect(result.split).toBeUndefined();
	});

	it('never auto-advances a split-child item even when autoAdvance is on', async () => {
		const deps = makeDeps();
		deps.workItem = createMockWorkItem({
			id: 'PVTI_child',
			title: 'A spawned task',
			labels: [{ id: SPLIT_CHILD_LABEL, name: SPLIT_CHILD_LABEL }],
		});
		await runPlanningPhase({ ...deps, autoAdvance: true });
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();
	});

	it('still renames the original when the split omits mainTask, keeping its description (issue #594)', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			sharedName: SHARED_NAME,
			subTasks: [{ title: 'Only sibling', description: 'Z', plan: '# plan\n\nDo Z.' }],
		});
		const deps = makeDeps();
		const result = await runPlanningPhase(deps);
		// A split never leaves the original card generic while its children are named:
		// it becomes phase 1 of the same shared name. Its description is untouched —
		// the agent asked for no re-scope.
		expect(deps.pm.updateWorkItem).toHaveBeenCalledWith('PVTI_item18', {
			title: splitTitle(1, 2, 'Add planning phase'),
		});
		// The sibling's body is still updated to carry its preplanned marker.
		expect(deps.pm.updateWorkItem).toHaveBeenCalledWith(
			'PVTI_Only sibling',
			expect.objectContaining({ description: expect.stringContaining('swarm-preplan:v1') }),
		);
		expect(deps.pm.createWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({ title: splitTitle(2, 2, 'Only sibling') }),
		);
		expect(deps.pm.createWorkItem).toHaveBeenCalledTimes(1);
		expect(result.split).toMatchObject({ mainTaskUpdated: true });
	});

	it('normalizes a phase-first response into the shared-name-first convention (issue #594)', async () => {
		splitExists = true;
		// The retired spelling the old prompt asked for, with no `sharedName` at all:
		// the board must still end up with cards a human can group at a glance.
		splitContents = JSON.stringify({
			mainTask: { title: 'Phase 1/2: The API', description: 'Just the API' },
			subTasks: [{ title: 'Phase 2/2: The UI', description: 'The UI', plan: '# plan\n\nDo it.' }],
		});
		const deps = makeDeps();
		await runPlanningPhase(deps);

		// The shared name is derived from the first task, so it names *this* split
		// rather than repeating the generic "Phase" every other split would carry.
		expect(deps.pm.updateWorkItem).toHaveBeenCalledWith('PVTI_item18', {
			title: 'The API 1/2: The API',
			description: 'Just the API',
		});
		expect(deps.pm.createWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'The API 2/2: The UI' }),
		);
	});

	it('treats an empty subTasks array as no split', async () => {
		splitExists = true;
		splitContents = JSON.stringify({ subTasks: [] });
		const deps = makeDeps();
		const result = await runPlanningPhase(deps);
		expect(deps.pm.createWorkItem).not.toHaveBeenCalled();
		expect(result.split).toBeUndefined();
	});

	it('leaves an unsplit item’s title and labels exactly as they were (issue #594)', async () => {
		// The naming convention is a property of a *split*, not of Planning: a
		// right-sized item is renamed by nothing and gains no label but `planned`.
		const deps = makeDeps();
		await runPlanningPhase(deps);
		expect(deps.pm.updateWorkItem).not.toHaveBeenCalled();
		expect(deps.pm.addLabel.mock.calls).toEqual([['PVTI_item18', PLANNED_LABEL]]);
	});

	it('throws on a malformed split file rather than silently skipping the split', async () => {
		splitExists = true;
		splitContents = '{ not valid json';
		const deps = makeDeps();
		await expect(runPlanningPhase(deps)).rejects.toThrow();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('leaves the sibling in Backlog when embedding its preplan marker throws', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			subTasks: [
				{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Build it.' },
			],
		});
		const deps = makeDeps();
		// The marker embed is a follow-up updateWorkItem carrying the marker in its
		// description; make only that call fail. The split itself (createWorkItem +
		// the split comment) must still succeed, but the child cannot safely enter
		// Planning without its marker.
		deps.pm.updateWorkItem = vi.fn<(id: string, patch: UpdateWorkItemPatch) => Promise<void>>(
			async (_id, patch) => {
				if (typeof patch.description === 'string' && patch.description.includes('swarm-preplan')) {
					throw new Error('board rejected the update');
				}
			},
		);
		const result = await runPlanningPhase({ ...deps, autoAdvance: true });

		expect(deps.pm.createWorkItem).toHaveBeenCalledTimes(1);
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalledWith('PVTI_Second slice', 'planning');
		const splitComment = childComment(deps, 'PVTI_Second slice', false);
		expect(splitComment).toContain('remains in **Backlog**');
		expect(splitComment).not.toContain('placed it in **Planning**');
		// The preplan comment is published before the marker write, so it really did
		// land here — the split comment reports that, while still being honest that
		// preparation did not finish (issue #431). It must not contradict that with a
		// "move it to ToDo" instruction: there is no saved plan to act on, and the move
		// would dispatch Implementation on a child that was never planned.
		const preplanComment = childComment(deps, 'PVTI_Second slice', true);
		expect(preplanComment).toContain('# UI plan');
		expect(preplanComment).not.toMatch(/move (the item|it) to \*\*ToDo\*\*/);
		expect(splitComment).toContain('**Preplan** comment');
		expect(result.split).toMatchObject({ subTaskItemIds: ['PVTI_Second slice'] });
		// Such a child is genuinely un-planned — its plan is lost with the unwritten
		// marker and a full Planning agent run still has to produce one — so it must
		// not be left labeled `planned` (issue #436). The parent's own run still is.
		expect(deps.pm.addLabel).not.toHaveBeenCalledWith('PVTI_Second slice', PLANNED_LABEL);
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_item18', PLANNED_LABEL);
		// Failure mode 1 of 2 (issue #737): unlabeled means a move to Planning really
		// does dispatch a Planning agent run, which is what this child owes. The note
		// says exactly that, with no saved plan to point at.
		expect(splitComment).toContain('with no saved plan');
		expect(splitComment).toContain('run a Planning agent on it normally');
	});

	it('posts a Backlog fallback comment when moving a prepared sibling to Planning throws', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			subTasks: [
				{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Build it.' },
			],
		});
		const deps = makeDeps();
		deps.pm.moveWorkItem = vi.fn<(id: string, status: string) => Promise<void>>(async (id) => {
			if (id === 'PVTI_Second slice') throw new Error('board rejected the move');
		});
		await runPlanningPhase({ ...deps, autoAdvance: true });

		// The marker write precedes the move, so this branch really does leave a valid
		// embedded plan behind — the observable state the docs' "keeps its plan" claim
		// rests on (issue #436).
		expect(deps.pm.updateWorkItem).toHaveBeenCalledWith(
			'PVTI_Second slice',
			expect.objectContaining({ description: expect.stringContaining('swarm-preplan:v1') }),
		);
		const splitComment = childComment(deps, 'PVTI_Second slice', false);
		expect(splitComment).toContain('remains in **Backlog**');
		expect(splitComment).not.toContain('placed it in **Planning**');
		// The preplan was already published before the move failed, so saying so is
		// accurate — the honesty rule is about not claiming what didn't happen. The
		// published plan itself stays silent on what to do next; the split comment,
		// which knows preparation failed, is the one place that says it.
		const preplanComment = childComment(deps, 'PVTI_Second slice', true);
		expect(preplanComment).toContain('# UI plan');
		expect(preplanComment).not.toMatch(/move (the item|it) to \*\*ToDo\*\*/);
		expect(splitComment).toContain('**Preplan** comment');
		// Failure mode 2 of 2 (issue #737), and the half that changed: the label is
		// written before the move, so this child is stranded in Backlog *carrying*
		// `planned`. That is what makes "keeps its plan and must not be re-planned" true
		// under a label gate — before, such a card stayed unlabeled forever because the
		// thing suppressing its dispatch was the marker rather than a label.
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_Second slice', PLANNED_LABEL);
		expect(splitComment).toContain('carrying the `planned` label');
		expect(splitComment).toContain('nothing will re-plan it');
		expect(splitComment).toContain('remove the `planned` label first');
	});

	it('short-circuits and labels a dispatched preplanned child whatever status its card is in', async () => {
		const deps = makeDeps();
		// A child carrying a valid marker while still sitting in Backlog — the state a
		// failed Planning move leaves behind. This pins the *phase*: the card's status
		// is not what the preplanned short-circuit keys on. Such a card is normally
		// labelled `planned` too, so `pm-status` never dispatches it at all (see
		// `tests/unit/triggers/handlers/pm-status.test.ts`); the unlabeled shape here is
		// the reachable one — a resumed run, or the swallowed label failure whose whole
		// recovery is this path reusing the plan and re-applying the label.
		deps.workItem = preplannedChild('# Reused plan\n\nImplement the UI slice.', undefined, {
			status: 'Backlog',
			labels: [{ id: SPLIT_CHILD_LABEL, name: SPLIT_CHILD_LABEL }],
		});

		const result = await runPlanningPhase({ ...deps });

		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_child', PLANNED_LABEL);
		expect(result).toMatchObject({ preplanned: true });
	});

	// Issue #431: the hidden `swarm-preplan:v1` marker is invisible in GitHub's
	// rendered issue, so each child also gets its complete plan as a normal comment.
	describe('published preplan comment', () => {
		beforeEach(() => {
			splitExists = true;
			splitContents = JSON.stringify({
				mainTask: { title: 'First slice', description: 'Just the API' },
				subTasks: [
					{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Build it.' },
					{ title: 'Third slice', description: 'The docs', plan: '# Docs plan\n\n1. Write it.' },
				],
			});
		});

		it("publishes each child's complete plan as a readable comment before its marker and Planning move", async () => {
			const deps = makeDeps();
			await runPlanningPhase({ ...deps, autoAdvance: true });

			const second = childComment(deps, 'PVTI_Second slice', true);
			expect(second).toContain('## 🗺️ Preplan — Phase 2 of 3');
			// The plan itself, verbatim and readable — not base64 inside an HTML comment.
			expect(second).toContain('# UI plan\n\n1. Build it.');
			expect(childComment(deps, 'PVTI_Third slice', true)).toContain('## 🗺️ Preplan — Phase 3 of 3');
			expect(childComment(deps, 'PVTI_Third slice', true)).toContain('# Docs plan\n\n1. Write it.');

			// Published before the marker is embedded and before the child leaves
			// Backlog: a failed publication must not leave a suppressing marker behind.
			const preplanPost = deps.pm.addComment.mock.invocationCallOrder[0];
			const markerWrite = deps.pm.updateWorkItem.mock.calls.findIndex(
				(call) => call[0] === 'PVTI_Second slice',
			);
			expect(preplanPost).toBeLessThan(
				deps.pm.updateWorkItem.mock.invocationCallOrder[markerWrite],
			);
			expect(preplanPost).toBeLessThan(deps.pm.moveWorkItem.mock.invocationCallOrder[0]);
			expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_Second slice', 'planning');

			// The split comment points the operator at it.
			expect(childComment(deps, 'PVTI_Second slice', false)).toContain('**Preplan** comment');
		});

		it('posts no duplicate preplan comment when the same delivery is retried', async () => {
			const deps = makeDeps();
			// The reachable replay path: the prior attempt of THIS delivery already
			// posted the parent's plan comment, so the phase short-circuits on that
			// delivery marker and never re-runs the split. That, not a per-child
			// lookup, is what stops a second preplan comment — the children of a
			// re-run split are freshly created issues with no comments at all.
			deps.pm.findComment.mockImplementation(async (_id, marker) =>
				marker.includes('run-A') ? 'existing-comment' : undefined,
			);

			await runPlanningPhase({ ...deps, runId: 'run-A', autoAdvance: true });

			expect(deps.pm.createWorkItem).not.toHaveBeenCalled();
			expect(deps.pm.addComment).not.toHaveBeenCalled();
			// No preplan-comment lookup is made at all — the guarantee lives upstream.
			expect(deps.pm.findComment).not.toHaveBeenCalledWith(
				expect.anything(),
				PREPLAN_COMMENT_MARKER_PREFIX,
			);
		});

		it('publishes the plan without a per-child lookup on a fresh split', async () => {
			const deps = makeDeps();
			await runPlanningPhase({ ...deps, autoAdvance: true });

			// Every child here was just created, so it cannot already carry a preplan
			// comment: the lookup could only ever miss, at the cost of a resolveItem +
			// a fully paginated listComments per child (issue #431 review).
			expect(deps.pm.findComment).not.toHaveBeenCalledWith(
				expect.anything(),
				PREPLAN_COMMENT_MARKER_PREFIX,
			);
			expect(childComment(deps, 'PVTI_Second slice', true)).toContain('# UI plan');
			expect(childComment(deps, 'PVTI_Third slice', true)).toContain('# Docs plan');
		});

		it('leaves the child in Backlog and claims no published preplan when publishing throws', async () => {
			const deps = makeDeps();
			deps.pm.addComment.mockImplementation(async (_id, text) => {
				if (text.includes(PREPLAN_COMMENT_MARKER_PREFIX)) throw new Error('board rejected it');
				return 'comment-1';
			});

			await runPlanningPhase({ ...deps, autoAdvance: true });

			// No marker was written, so the child falls back to a normal Planning run
			// that will post its own visible plan — rather than being suppressed by a
			// marker whose plan nobody can read.
			expect(deps.pm.updateWorkItem).not.toHaveBeenCalledWith(
				'PVTI_Second slice',
				expect.objectContaining({ description: expect.stringContaining('swarm-preplan:v1') }),
			);
			expect(deps.pm.moveWorkItem).not.toHaveBeenCalledWith('PVTI_Second slice', 'planning');
			const splitComment = childComment(deps, 'PVTI_Second slice', false);
			expect(splitComment).toContain('remains in **Backlog**');
			expect(splitComment).not.toContain('Preplan');
		});
	});

	it('reuses a preplanned split-child plan: skips the worktree and agent, posts the plan, never advances', async () => {
		const deps = makeDeps();
		deps.workItem = preplannedChild('# Reused plan\n\nImplement the UI slice.');
		const result = await runPlanningPhase({ ...deps, autoAdvance: true });

		// No worktree, no agent CLI — the whole point of the optimization.
		expect(deps.worktrees.provision).not.toHaveBeenCalled();
		expect(deps.worktrees.reuse).not.toHaveBeenCalled();
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.graft).not.toHaveBeenCalled();

		// The parent-written plan is posted as this child's plan comment...
		expect(deps.pm.addComment).toHaveBeenCalledTimes(1);
		expect(deps.pm.addComment.mock.calls[0][1]).toContain('Implement the UI slice.');
		// ...and a split child never auto-advances, even with autoAdvance on.
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();

		expect(result).toMatchObject({ preplanned: true, movedTo: undefined });
		expect(result.agent).toMatchObject({ exitCode: 0, durationMs: 0 });
		expect(result.agent.usage).toBeUndefined();

		// A preplanned split child is still marked `planned` through its own
		// completion — every issue that finishes a Planning run ends up labeled,
		// even though its agent was skipped (issue #384).
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_child', 'planned');
		expect(deps.pm.addLabel.mock.invocationCallOrder[0]).toBeGreaterThan(
			deps.pm.addComment.mock.invocationCallOrder[0],
		);
	});

	it('re-applies `planned` without failing when the split child already carries it (issue #426)', async () => {
		const deps = makeDeps();
		// Exactly the shape applySplit leaves behind: a prepared child is already
		// labeled `planned`, and its own preplanned run reaches applyPlannedLabel anyway.
		deps.workItem = preplannedChild('# Reused plan\n\nImplement the UI slice.', undefined, {
			labels: [
				{ id: SPLIT_CHILD_LABEL, name: SPLIT_CHILD_LABEL },
				{ id: PLANNED_LABEL, name: PLANNED_LABEL },
			],
		});

		const result = await runPlanningPhase(deps);

		expect(result).toMatchObject({ preplanned: true });
		// Applied once more, unconditionally — idempotence is the provider's job
		// (addLabels is additive), so the phase never has to check first.
		expect(deps.pm.addLabel).toHaveBeenCalledTimes(1);
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_child', PLANNED_LABEL);
	});

	it('falls back to a normal agent run when the preplan marker is malformed', async () => {
		const deps = makeDeps();
		deps.workItem = createMockWorkItem({
			id: 'PVTI_child',
			url: 'https://github.com/o/r/issues/42',
			description: 'The UI slice.\n\n<!-- swarm-preplan:v1\n{ not valid json\n-->',
			labels: [{ id: SPLIT_CHILD_LABEL, name: SPLIT_CHILD_LABEL }],
		});
		await runPlanningPhase(deps);
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		expect(deps.worktrees.provision).toHaveBeenCalledWith('18', { detach: true });
	});

	it("falls back to a normal run when the marker's itemUrl does not match the item", async () => {
		const deps = makeDeps();
		// Same marker, but the item's own url differs → the marker isn't ours.
		deps.workItem = preplannedChild('# plan', 'desc', {
			url: 'https://github.com/o/r/issues/999',
		});
		await runPlanningPhase(deps);
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
	});

	it('falls back to a normal run when the human description changed after the plan was generated', async () => {
		const deps = makeDeps();
		const child = preplannedChild('# plan', 'Original scope.');
		// A human edits the visible scope above the marker → hash no longer matches.
		deps.workItem = {
			...child,
			description: child.description.replace('Original scope.', 'Totally different scope now.'),
		};
		await runPlanningPhase(deps);
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
	});

	it('reuses the plan regardless of labels — the contract stopped being a gate (issue #737)', async () => {
		const deps = makeDeps();
		const child = preplannedChild('# plan');
		// `planned` on the card is the trigger's business, not this phase's: a run that
		// was dispatched anyway (a resume, or a card an operator moved while it was
		// still labelled) still reuses the plan rather than spending an agent. The
		// `swarm:replan` override that used to force a fresh run here is gone.
		deps.workItem = {
			...child,
			labels: [
				...child.labels,
				{ id: PLANNED_LABEL, name: PLANNED_LABEL },
				{ id: 'LA_replan', name: 'swarm:replan' },
			],
		};
		const result = await runPlanningPhase(deps);
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(result).toMatchObject({ preplanned: true });
	});

	it('does not skip on a valid marker when the split-child label has been removed (skip is gated on isSplitChild)', async () => {
		const deps = makeDeps();
		// A valid marker, but the item is no longer labelled a split child — a human
		// removed the label. The skip must not fire; it re-plans normally instead.
		deps.workItem = preplannedChild('# plan', 'desc', { labels: [] });
		await runPlanningPhase(deps);
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		expect(deps.worktrees.provision).toHaveBeenCalledWith('18', { detach: true });
	});

	it('accepts a focused single task that declares one concern and several affected files', async () => {
		// Touching several closely-related files (and having tests) is NOT a reason to
		// reject — the guard only looks at declared independent concerns (issue #268).
		scopeContents = JSON.stringify({
			whyOneTask: 'One policy change and its focused tests.',
			independentConcerns: ['the retry policy'],
			affectedAreas: [
				'src/pipeline/planning.ts',
				'src/config/schema.ts',
				'tests/unit/pipeline/planning.test.ts',
			],
			outOfScope: ['provider selection'],
		});
		const deps = makeDeps();
		const result = await runPlanningPhase({ ...deps, autoAdvance: true });
		expect(deps.pm.addComment).toHaveBeenCalledTimes(1);
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_item18', 'todo');
		expect(result).toMatchObject({ movedTo: 'todo' });
	});

	it('rejects an oversized single task that declares two independent concerns without splitting', async () => {
		scopeContents = JSON.stringify({
			whyOneTask: 'It all relates to stalled failures.',
			independentConcerns: ['retry policy', 'provider selection/configuration'],
			affectedAreas: ['src/pipeline/planning.ts', 'src/config/schema.ts'],
			outOfScope: [],
		});
		const deps = makeDeps();
		await expect(runPlanningPhase(deps)).rejects.toThrow(
			/oversized single task|independent concerns/i,
		);
		// Nothing is posted, labeled, or advanced when the guard rejects the plan.
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.pm.addLabel).not.toHaveBeenCalled();
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('allows a plan that declares two concerns when it also splits the work', async () => {
		// A split is the sanctioned way to carry multiple concerns — the budget check
		// is only applied to the no-split path.
		scopeContents = JSON.stringify({
			whyOneTask: 'First slice only.',
			independentConcerns: ['retry policy', 'provider selection'],
			affectedAreas: ['src/pipeline/planning.ts'],
			outOfScope: [],
		});
		splitExists = true;
		splitContents = JSON.stringify({
			subTasks: [
				{ title: 'Provider selection', description: 'Pick provider', plan: '# plan\n\nDo it.' },
			],
		});
		const deps = makeDeps();
		const result = await runPlanningPhase(deps);
		expect(deps.pm.createWorkItem).toHaveBeenCalledTimes(1);
		expect(result.split).toMatchObject({ subTaskItemIds: ['PVTI_Provider selection'] });
	});

	it('honours a raised maxConcerns budget', async () => {
		scopeContents = JSON.stringify({
			whyOneTask: 'Two tightly-coupled concerns this team treats as one task.',
			independentConcerns: ['retry policy', 'provider selection'],
			affectedAreas: ['src/pipeline/planning.ts'],
			outOfScope: [],
		});
		const deps = makeDeps();
		const result = await runPlanningPhase({ ...deps, maxConcerns: 2 });
		expect(deps.pm.addComment).toHaveBeenCalledTimes(1);
		expect(result.movedTo).toBeUndefined();
	});

	it('fails Planning when the scope file is missing under autoSplit', async () => {
		scopeExists = false;
		const deps = makeDeps();
		await expect(runPlanningPhase(deps)).rejects.toThrow(
			new RegExp(`did not write ${PROPOSED_SCOPE_FILENAME}`),
		);
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('fails Planning when the scope file is malformed under autoSplit', async () => {
		scopeContents = JSON.stringify({ affectedAreas: [] }); // missing whyOneTask, empty areas
		const deps = makeDeps();
		await expect(runPlanningPhase(deps)).rejects.toThrow();
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('does not require a scope file when autoSplit is off', async () => {
		planContents = '# Plan\n\n1. Do the thing.';
		scopeExists = false;
		const deps = makeDeps();
		const result = await runPlanningPhase({ ...deps, autoSplit: false });
		expect(deps.pm.addComment).toHaveBeenCalledTimes(1);
		expect(result.plan).toBe('# Plan\n\n1. Do the thing.');
	});

	it('fails Planning when the human-readable scope gate is missing in the plan under autoSplit', async () => {
		planContents = '# Plan\n\n1. Do the thing.'; // missing ## Scope gate
		const deps = makeDeps();
		await expect(runPlanningPhase(deps)).rejects.toThrow(
			/did not include the required "## Scope gate" section/i,
		);
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('fails Planning when the concern list is omitted in the scope file under autoSplit', async () => {
		scopeContents = JSON.stringify({
			whyOneTask: 'One cohesive change.',
			affectedAreas: ['src/pipeline/planning.ts'],
			outOfScope: [],
		}); // independentConcerns is omitted
		const deps = makeDeps();
		await expect(runPlanningPhase(deps)).rejects.toThrow();
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('forwards timeoutMs, signal, and maxOutputBytes to the agent runner', async () => {
		const deps = makeDeps();
		const signal = new AbortController().signal;
		await runPlanningPhase({ ...deps, timeoutMs: 60_000, signal });
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.timeoutMs).toBe(60_000);
		expect(runArgs.signal).toBe(signal);
		expect(runArgs.maxOutputBytes).toBeGreaterThan(0);
	});

	it('grafts the environment before running the agent', async () => {
		const deps = makeDeps();
		const order: string[] = [];
		deps.graft = vi.fn(() => {
			order.push('graft');
			return [];
		});
		deps.runAgent = vi.fn(async () => {
			order.push('agent');
			return agentResult();
		});
		await runPlanningPhase(deps);
		expect(order).toEqual(['graft', 'agent']);
	});

	it('cleans up the worktree and never runs the agent when graft throws', async () => {
		const deps = makeDeps();
		deps.graft = vi.fn(() => {
			throw new Error('graft failed: node_modules missing');
		});
		await expect(runPlanningPhase(deps)).rejects.toThrow(/graft failed/);
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('honours a cli override (e.g. claude)', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ cli: 'claude' }));
		await runPlanningPhase({ ...deps, cli: 'claude' });
		expect(deps.runAgent.mock.calls[0][0].cli).toBe('claude');
	});

	it('throws and still cleans up when the agent exits non-zero', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));
		await expect(runPlanningPhase(deps)).rejects.toThrow(/exited with code 1/);
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();
		// The `planned` label is never applied when the run fails (issue #384).
		expect(deps.pm.addLabel).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('notes the timeout in the error when the agent timed out', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: null, timedOut: true }));
		await expect(runPlanningPhase(deps)).rejects.toThrow(/timed out/);
	});

	it('throws and cleans up when the agent produced no plan file', async () => {
		planExists = false;
		const deps = makeDeps();
		await expect(runPlanningPhase(deps)).rejects.toThrow(
			new RegExp(`did not write ${PROPOSED_PLAN_FILENAME}`),
		);
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.pm.addLabel).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('throws and cleans up when the plan file is empty', async () => {
		planContents = '   \n  ';
		const deps = makeDeps();
		await expect(runPlanningPhase(deps)).rejects.toThrow(/empty/);
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('cleans up the worktree even when posting the comment throws', async () => {
		const deps = makeDeps();
		deps.pm.addComment.mockRejectedValue(new Error('GraphQL 502'));
		await expect(runPlanningPhase(deps)).rejects.toThrow(/GraphQL 502/);
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('does not let a cleanup failure mask a successful run', async () => {
		const deps = makeDeps();
		deps.worktrees.cleanup = vi.fn(async () => {
			throw new Error('rm -rf worktree failed');
		});
		// The agent exited 0 and the plan was posted, so the run succeeded — a
		// cleanup throw is swallowed-and-logged, not re-raised.
		const result = await runPlanningPhase(deps);
		expect(result).toMatchObject({ commentId: 'comment-1' });
	});

	it('threads sessionId (not resumeSessionId) and provisions a fresh detached checkout on a first run', async () => {
		const deps = makeDeps();
		await runPlanningPhase({ ...deps, sessionId: 'sess-18' });

		expect(deps.worktrees.reuse).not.toHaveBeenCalled();
		expect(deps.worktrees.provision).toHaveBeenCalledWith('18', { detach: true });
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.sessionId).toBe('sess-18');
		expect(runArgs.resumeSessionId).toBeUndefined();
	});

	it('resumes the Claude session in place: reuses the detached checkout and threads resumeSessionId, not sessionId', async () => {
		const deps = makeDeps();
		await runPlanningPhase({ ...deps, sessionId: 'sess-18', resumeSessionId: 'sess-18' });

		expect(deps.worktrees.reuse).toHaveBeenCalledWith('18', 'main', true);
		expect(deps.worktrees.provision).not.toHaveBeenCalled();
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.resumeSessionId).toBe('sess-18');
		expect(runArgs.sessionId).toBeUndefined();
	});

	it('falls back to a fresh detached provision when the session worktree is gone', async () => {
		const deps = makeDeps();
		vi.mocked(deps.worktrees.reuse).mockResolvedValueOnce(undefined);
		await runPlanningPhase({ ...deps, sessionId: 'sess-18', resumeSessionId: 'sess-18' });

		expect(deps.worktrees.reuse).toHaveBeenCalledWith('18', 'main', true);
		expect(deps.worktrees.provision).toHaveBeenCalledWith('18', { detach: true });
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.resumeSessionId).toBeUndefined();
		expect(runArgs.sessionId).toBe('sess-18');
	});

	it('preserves the worktree (skips cleanup) when a session run fails on a rate limit', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () =>
			agentResult({
				exitCode: 1,
				stdout: "You've hit your session limit · resets 1:40pm (Europe/Warsaw)\n",
				sessionId: 'sess-18',
			}),
		);
		await expect(runPlanningPhase({ ...deps, sessionId: 'sess-18' })).rejects.toThrow(
			/rate limited/,
		);
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('preserves the worktree (skips cleanup) when a session run times out', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () =>
			agentResult({ exitCode: null, timedOut: true, sessionId: 'sess-18' }),
		);
		await expect(runPlanningPhase({ ...deps, sessionId: 'sess-18' })).rejects.toThrow(/timed out/);
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('still cleans up a rate-limited failure that had no session to resume', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () =>
			agentResult({
				exitCode: 1,
				stdout: "You've hit your session limit · resets 1:40pm (Europe/Warsaw)\n",
			}),
		);
		await expect(runPlanningPhase(deps)).rejects.toThrow(/rate limited/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('18');
	});

	it('does not apply the planned label when addComment rejects', async () => {
		const deps = makeDeps();
		deps.pm.addComment.mockRejectedValue(new Error('addComment failed'));
		await expect(runPlanningPhase(deps)).rejects.toThrow('addComment failed');
		expect(deps.pm.addLabel).not.toHaveBeenCalled();
	});

	it('does not apply the planned label when applySplit (e.g. createWorkItem) rejects', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			mainTask: { title: 'First slice', description: 'Desc 1' },
			subTasks: [{ title: 'Second slice', description: 'Desc 2', plan: 'Plan 2' }],
		});
		const deps = makeDeps();
		deps.pm.createWorkItem.mockRejectedValue(new Error('createWorkItem failed'));
		await expect(runPlanningPhase({ ...deps, autoSplit: true })).rejects.toThrow(
			'createWorkItem failed',
		);
		expect(deps.pm.addLabel).not.toHaveBeenCalled();
	});

	it('does not apply the planned label when moveWorkItem rejects', async () => {
		const deps = makeDeps();
		deps.pm.moveWorkItem.mockRejectedValue(new Error('moveWorkItem failed'));
		await expect(runPlanningPhase({ ...deps, autoAdvance: true })).rejects.toThrow(
			'moveWorkItem failed',
		);
		expect(deps.pm.addLabel).not.toHaveBeenCalled();
	});

	it('does not apply the planned label when preplanned-child comment posting rejects', async () => {
		const deps = makeDeps();
		deps.workItem = preplannedChild('# Reused plan\n\nImplement the UI slice.');
		deps.pm.addComment.mockRejectedValue(new Error('preplanned comment failed'));
		await expect(runPlanningPhase({ ...deps, autoAdvance: true })).rejects.toThrow(
			'preplanned comment failed',
		);
		expect(deps.pm.addLabel).not.toHaveBeenCalled();
	});

	// Per-delivery idempotency marker (issue #384 re-review): the plan-comment
	// checkpoint keys on *this* run's marker, not the shared "Proposed implementation
	// plan" heading, so a retry of the same delivery reuses its own comment while a
	// later replan (a fresh run row) posts anew and re-runs its split.
	describe('plan-comment delivery marker', () => {
		it('a new delivery posts its own plan (with its marker) and runs its split, ignoring an older delivery comment', async () => {
			splitExists = true;
			splitContents = JSON.stringify({
				mainTask: { title: 'First slice', description: 'Just the API' },
				subTasks: [
					{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Build it.' },
				],
			});
			const deps = makeDeps();
			// An older delivery ('run-A') left a plan comment behind; this is a fresh
			// delivery ('run-B'). Only run-A's marker resolves — run-B's must not.
			deps.pm.findComment.mockImplementation(async (_id, marker) =>
				marker.includes('run-A') ? 'old-comment' : undefined,
			);

			await runPlanningPhase({ ...deps, runId: 'run-B', autoAdvance: true });

			// The lookup used *this* delivery's marker, not the generic heading.
			expect(deps.pm.findComment).toHaveBeenCalledWith(
				'PVTI_item18',
				'<!-- swarm-planning-delivery:run-B -->',
			);
			// The new plan is posted (not suppressed by the older comment) and carries run-B's marker.
			const planComment = deps.pm.addComment.mock.calls.find((c) => c[0] === 'PVTI_item18')?.[1];
			expect(planComment).toContain('<!-- swarm-planning-delivery:run-B -->');
			// And the split work still runs for the fresh delivery.
			expect(deps.pm.createWorkItem).toHaveBeenCalled();
			expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_item18', 'planned');
		});

		it('a retry of the same delivery reuses its prior comment: no duplicate post, no re-split, and the label is re-applied', async () => {
			splitExists = true;
			splitContents = JSON.stringify({
				mainTask: { title: 'First slice', description: 'Just the API' },
				subTasks: [
					{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Build it.' },
				],
			});
			const deps = makeDeps();
			// The prior attempt of THIS delivery already posted its comment (found by its
			// own marker); the retry re-applies the label after a first attempt failed at it.
			deps.pm.findComment.mockImplementation(async (_id, marker) =>
				marker.includes('run-A') ? 'existing-comment' : undefined,
			);

			const result = await runPlanningPhase({ ...deps, runId: 'run-A', autoAdvance: true });

			// The prior comment is reused verbatim — nothing is re-posted and the split is not re-run.
			expect(deps.pm.addComment).not.toHaveBeenCalled();
			expect(deps.pm.createWorkItem).not.toHaveBeenCalled();
			expect(result.commentId).toBe('existing-comment');
			// The status move and the previously-failed label are (idempotently) re-applied.
			expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_item18', 'todo');
			expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_item18', 'planned');
		});

		it('preplanned child: a retry reuses its prior comment while a fresh delivery posts anew', async () => {
			// Retry — this delivery's marker resolves to its prior comment.
			const retry = makeDeps();
			retry.workItem = preplannedChild('# Reused plan\n\nImplement the UI slice.');
			retry.pm.findComment.mockImplementation(async (_id, marker) =>
				marker.includes('run-A') ? 'existing-preplan-comment' : undefined,
			);
			const retryResult = await runPlanningPhase({ ...retry, runId: 'run-A' });
			expect(retry.pm.findComment).toHaveBeenCalledWith(
				'PVTI_child',
				'<!-- swarm-planning-delivery:run-A -->',
			);
			expect(retry.pm.addComment).not.toHaveBeenCalled();
			expect(retryResult.commentId).toBe('existing-preplan-comment');
			expect(retry.pm.addLabel).toHaveBeenCalledWith('PVTI_child', 'planned');

			// Fresh delivery ('run-B') — an older delivery's comment must not suppress it.
			const fresh = makeDeps();
			fresh.workItem = preplannedChild('# Reused plan\n\nImplement the UI slice.');
			fresh.pm.findComment.mockImplementation(async (_id, marker) =>
				marker.includes('run-A') ? 'old-preplan-comment' : undefined,
			);
			await runPlanningPhase({ ...fresh, runId: 'run-B' });
			const posted = fresh.pm.addComment.mock.calls.find((c) => c[0] === 'PVTI_child')?.[1];
			expect(posted).toContain('<!-- swarm-planning-delivery:run-B -->');
			expect(fresh.pm.addLabel).toHaveBeenCalledWith('PVTI_child', 'planned');
		});
	});

	/**
	 * Issue #543. The plan comment's marker only short-circuits a delivery that got
	 * as far as posting it, and `applySplit` runs first — so an interrupted split used
	 * to re-create every child the failed attempt had already made. These drive the
	 * real failure: two attempts of the *same* delivery against one board, with the
	 * provider throwing partway through the first.
	 */
	describe('an interrupted split resumes instead of duplicating', () => {
		const THREE_PHASES = JSON.stringify({
			sharedName: SHARED_NAME,
			mainTask: { title: 'First slice', description: 'The first slice' },
			subTasks: [
				{ title: 'Second slice', description: 'The second slice', plan: '# Plan 2\n\nBuild it.' },
				{ title: 'Third slice', description: 'The third slice', plan: '# Plan 3\n\nShip it.' },
			],
		});
		/** The two children's board titles, in phase order (issue #594). */
		const CHILD_TITLES = [splitTitle(2, 3, 'Second slice'), splitTitle(3, 3, 'Third slice')];

		/** The board both attempts write to, so the retry sees what the first one left. */
		interface Board {
			items: WorkItem[];
			comments: Array<{ itemId: string; body: string }>;
		}

		/**
		 * Point one attempt's provider at the shared board: cards are found by the
		 * marker in their description and comments by the marker in their body, which
		 * is exactly the state a real provider carries between two attempts.
		 */
		function onBoard(deps: ReturnType<typeof makeDeps>, board: Board) {
			deps.pm.createWorkItem.mockImplementation(async (input) => {
				const id = `PVTI_child${board.items.length + 1}`;
				const item = createMockWorkItem({
					id,
					title: input.title,
					description: input.description,
					url: `https://example.test/${id}`,
				});
				board.items.push(item);
				return item;
			});
			deps.pm.findWorkItemByDescriptionMarker.mockImplementation(async (marker) =>
				board.items.find((item) => item.description.includes(marker)),
			);
			deps.pm.updateWorkItem.mockImplementation(async (id, patch) => {
				const item = board.items.find((i) => i.id === id);
				if (item && patch.description !== undefined) item.description = patch.description;
			});
			deps.pm.addComment.mockImplementation(async (itemId, body) => {
				board.comments.push({ itemId, body });
				return `comment-${board.comments.length}`;
			});
			deps.pm.findComment.mockImplementation(async (itemId, marker) =>
				board.comments.some((c) => c.itemId === itemId && c.body.includes(marker))
					? 'existing-comment'
					: undefined,
			);
			return deps;
		}

		/** Make the nth (1-based) card creation of this attempt fail, as a 502 would. */
		function failCreateOnCall(deps: ReturnType<typeof makeDeps>, nth: number) {
			const create = deps.pm.createWorkItem.getMockImplementation();
			let calls = 0;
			deps.pm.createWorkItem.mockImplementation(async (input) => {
				calls += 1;
				if (calls === nth) throw new Error('create-item failed: 502');
				return create?.(input) as ReturnType<NonNullable<typeof create>>;
			});
		}

		const titlesOn = (board: Board) => board.items.map((item) => item.title);
		const commentsOn = (board: Board, itemId: string, marker: string) =>
			board.comments.filter((c) => c.itemId === itemId && c.body.includes(marker));

		let board: Board;

		beforeEach(() => {
			splitExists = true;
			splitContents = THREE_PHASES;
			board = { items: [], comments: [] };
		});

		it('creates each child exactly once when the first attempt died between children', async () => {
			const first = onBoard(makeDeps(), board);
			failCreateOnCall(first, 2);
			await expect(runPlanningPhase({ ...first, runId: 'run-A' })).rejects.toThrow(
				'create-item failed: 502',
			);
			expect(titlesOn(board)).toEqual([CHILD_TITLES[0]]);

			const retry = onBoard(makeDeps(), board);
			await runPlanningPhase({ ...retry, runId: 'run-A' });

			// One card per planned phase, not two for Phase 2 — and the retry created
			// only the child the first attempt never reached.
			expect(titlesOn(board)).toEqual(CHILD_TITLES);
			expect(retry.pm.createWorkItem).toHaveBeenCalledTimes(1);
			expect(retry.pm.createWorkItem).toHaveBeenCalledWith(
				expect.objectContaining({ title: CHILD_TITLES[1] }),
			);
			// The adopted child keeps a single copy of each of its two comments.
			expect(commentsOn(board, 'PVTI_child1', PREPLAN_COMMENT_MARKER_PREFIX)).toHaveLength(1);
			expect(commentsOn(board, 'PVTI_child1', '<!-- swarm-split-child-note:run-A:0')).toHaveLength(
				1,
			);
		});

		it('creates each child exactly once when the first attempt died on the very first one', async () => {
			const first = onBoard(makeDeps(), board);
			failCreateOnCall(first, 1);
			await expect(runPlanningPhase({ ...first, runId: 'run-A' })).rejects.toThrow(
				'create-item failed: 502',
			);
			expect(titlesOn(board)).toEqual([]);

			await runPlanningPhase({ ...onBoard(makeDeps(), board), runId: 'run-A' });

			expect(titlesOn(board)).toEqual(CHILD_TITLES);
		});

		it('creates no child at all when the first attempt died after the last one, before the plan comment', async () => {
			const first = onBoard(makeDeps(), board);
			// Every child lands; the parent's own plan comment — the very next write — is
			// what fails, so the delivery has no marker to be recognised by.
			first.pm.addComment.mockImplementation(async (itemId, body) => {
				if (itemId === 'PVTI_item18') throw new Error('plan comment failed: 502');
				board.comments.push({ itemId, body });
				return `comment-${board.comments.length}`;
			});
			await expect(runPlanningPhase({ ...first, runId: 'run-A' })).rejects.toThrow(
				'plan comment failed: 502',
			);
			expect(titlesOn(board)).toEqual(CHILD_TITLES);

			const retry = onBoard(makeDeps(), board);
			await runPlanningPhase({ ...retry, runId: 'run-A' });

			expect(titlesOn(board)).toEqual(CHILD_TITLES);
			expect(retry.pm.createWorkItem).not.toHaveBeenCalled();
			// Both adopted children keep exactly one preplan comment, not a second copy
			// of a plan a reader would have to reconcile.
			for (const itemId of ['PVTI_child1', 'PVTI_child2']) {
				expect(commentsOn(board, itemId, PREPLAN_COMMENT_MARKER_PREFIX)).toHaveLength(1);
			}
			// And the parent's plan comment, the write that failed, is posted this time.
			expect(
				commentsOn(board, 'PVTI_item18', '<!-- swarm-planning-delivery:run-A -->'),
			).toHaveLength(1);
		});

		it('still performs its own split for a genuine replan — a new run, hence a new identity', async () => {
			await runPlanningPhase({ ...onBoard(makeDeps(), board), runId: 'run-A' });
			expect(titlesOn(board)).toEqual(CHILD_TITLES);

			const replan = onBoard(makeDeps(), board);
			await runPlanningPhase({ ...replan, runId: 'run-B' });

			// A replan is a new decomposition, not a resumption of the old one.
			expect(replan.pm.createWorkItem).toHaveBeenCalledTimes(2);
			expect(titlesOn(board)).toEqual([...CHILD_TITLES, ...CHILD_TITLES]);
		});

		it("keeps the delivery's marker in the child's body through the preplan contract write", async () => {
			await runPlanningPhase({ ...onBoard(makeDeps(), board), runId: 'run-A' });

			// The marker has to survive the description rewrite that embeds the preplan,
			// or the next retry could not recognise the child — and it is inside the
			// human part the contract's hash is computed over, so the child still reads
			// as validly preplanned.
			const child = board.items[0] as WorkItem;
			expect(child.description).toContain('<!-- swarm-split-child:run-A:0 -->');
			expect(child.description).toContain('swarm-preplan:v1');
			expect(isPreplanSkip(evaluatePreplan({ ...child, url: child.url }))).toBe(true);
		});

		it('does not look a child up when the run has no delivery identity to key on', async () => {
			const deps = onBoard(makeDeps(), board);
			await runPlanningPhase(deps);

			expect(deps.pm.findWorkItemByDescriptionMarker).not.toHaveBeenCalled();
			expect(board.items[0]?.description).not.toContain('swarm-split-child:');
		});
	});
});

describe('buildPlanningPrompt', () => {
	it('instructs writing the plan to proposed_plan.md and forbids code changes', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem({ title: 'T', description: 'D' }));
		expect(prompt).toContain(PROPOSED_PLAN_FILENAME);
		expect(prompt).toMatch(/PLANNING ONLY/);
		expect(prompt).toContain('Do NOT invoke the `solve-issue` skill');
		expect(prompt).toContain('T');
		expect(prompt).toContain('D');
	});

	it('falls back to a placeholder when the work item has no description', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem({ description: '' }));
		expect(prompt).toContain('(no description provided)');
	});

	it('always states the minimal-scope rule (smallest change, no speculative generalization)', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem());
		expect(prompt).toMatch(/SCOPE DISCIPLINE/);
		expect(prompt).toMatch(/smallest change/i);
		expect(prompt).toMatch(/speculative extensibility/i);
		expect(prompt).toMatch(/upper bound of scope/i);
	});

	it('omits split instructions by default', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem());
		expect(prompt).not.toContain(PROPOSED_SPLIT_FILENAME);
		expect(prompt).not.toContain(PROPOSED_SCOPE_FILENAME);
	});

	it('invites splitting when allowSplit is on', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem(), true);
		expect(prompt).toContain(PROPOSED_SPLIT_FILENAME);
		expect(prompt).toMatch(/too large/i);
	});

	it('gives concrete split criteria and requires the scope gate when allowSplit is on', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem(), true);
		expect(prompt).toMatch(/more than 1 INDEPENDENT concern/i);
		expect(prompt).toContain(PROPOSED_SCOPE_FILENAME);
		expect(prompt).toMatch(/## Scope gate/);
		expect(prompt).toMatch(/Why this is one task/);
		expect(prompt).toMatch(/Affected areas/);
		expect(prompt).toMatch(/Explicitly out of scope/);
		expect(prompt).toContain('independentConcerns');
	});

	it('adapts the prompt instructions dynamically to a raised maxConcerns budget', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem(), true, undefined, 2);
		expect(prompt).toMatch(/more than 2 INDEPENDENT concerns/i);
		expect(prompt).toMatch(/more than 2 entries you MUST split/i);
		expect(prompt).toMatch(/at most 2 entries/i);
	});

	it('asks for one shared task name and the shared-name-first title format (issue #594)', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem(), true);
		expect(prompt).toContain('"sharedName"');
		expect(prompt).toMatch(/CHOOSE ONE SHARED TASK NAME/);
		expect(prompt).toContain(
			'TITLE EVERY\n    TASK "<shared task name> <phase>/<total>: <this phase\'s task>"',
		);
		// The retired phase-first spelling is not offered as an example any more — it
		// is what made every split's cards read alike in the Planning column.
		expect(prompt).toMatch(/never a\n {4}bare "Phase 2\/3: …"/);
		expect(prompt).not.toContain('"Phase 1/3: <title>"');
	});

	it('asks for a reusable per-child plan when splitting', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem(), true);
		expect(prompt).toContain('"plan"');
		expect(prompt).toMatch(/plan for EVERY other task/i);
		expect(prompt).toMatch(/acceptance criteria/i);
		expect(prompt).toMatch(/verification/i);
	});
});

describe('planCommentBody', () => {
	it('wraps the plan with a header and, by default, a move-it-yourself hint', () => {
		const body = planCommentBody('step one');
		expect(body).toContain('Proposed implementation plan');
		expect(body).toContain('step one');
		expect(body).toContain('ToDo');
		expect(body).toMatch(/Move this item/);
	});

	it('says the item is moving automatically when autoAdvance is on', () => {
		const body = planCommentBody('step one', true);
		expect(body).toMatch(/moving to \*\*ToDo\*\* automatically/);
	});

	it('appends a per-delivery marker when a delivery id is given, and omits it otherwise', () => {
		expect(planCommentBody('step one', false, 'run-42')).toContain(
			'<!-- swarm-planning-delivery:run-42 -->',
		);
		expect(planCommentBody('step one')).not.toContain('swarm-planning-delivery');
	});

	it('is recognizable as SWARM-generated even without a delivery id (issue #443)', () => {
		// Comment loop prevention keys on this marker; the `_Generated by SWARM…_`
		// footer covers the direct/test invocation that has no delivery marker.
		expect(isSwarmGeneratedBody(planCommentBody('step one'))).toBe(true);
		expect(isSwarmGeneratedBody(planCommentBody('step one', true))).toBe(true);
	});
});

describe('splitChildCommentBody', () => {
	// The only SWARM comment with no per-delivery marker of its own, so the footer
	// is the whole of its loop-prevention coverage (issue #443).
	it('is recognizable as SWARM-generated', () => {
		const parent = createMockWorkItem({ title: 'Big task', url: 'https://x/issues/1' });
		expect(
			isSwarmGeneratedBody(
				splitChildCommentBody(parent, [], 2, 3, {
					preplanPublished: true,
					planned: true,
					prepared: true,
				}),
			),
		).toBe(true);
		expect(
			isSwarmGeneratedBody(
				splitChildCommentBody(parent, [parent], 2, 3, {
					preplanPublished: false,
					planned: false,
					prepared: false,
				}),
			),
		).toBe(true);
	});

	// Three branches since issue #737, because a child stranded in Backlog now
	// behaves differently depending on which step stranded it — and "move it to
	// Planning and SWARM will plan it" is true of only one of them.
	it('tells a prepared child how to re-plan: remove `planned`, move Backlog → Planning', () => {
		const parent = createMockWorkItem({ title: 'Big task', url: 'https://x/issues/1' });
		const preparedBody = splitChildCommentBody(parent, [], 2, 3, {
			preplanPublished: true,
			planned: true,
			prepared: true,
		});
		expect(preparedBody).toMatch(/move (the item|it) to \*\*ToDo\*\*/);
		expect(preparedBody).toContain('remove the `planned` label');
		expect(preparedBody).toContain('**Backlog → Planning**');
		expect(preparedBody).not.toContain('swarm:replan');
		expect(preparedBody).not.toContain('remains in **Backlog**');
	});

	it('says a plan-saved child stranded in Backlog will not be re-planned', () => {
		const parent = createMockWorkItem({ title: 'Big task', url: 'https://x/issues/1' });
		// The Planning move failed after the marker and the label landed.
		const body = splitChildCommentBody(parent, [parent], 2, 3, {
			preplanPublished: true,
			planned: true,
			prepared: false,
		});
		expect(body).toContain('remains in **Backlog** carrying the `planned` label');
		expect(body).toContain('nothing will re-plan it');
		expect(body).toContain('remove the `planned` label first');
		expect(body).not.toMatch(/move (the item|it) to \*\*ToDo\*\*/);
	});

	it('says a plan-less child stranded in Backlog gets a normal Planning run', () => {
		const parent = createMockWorkItem({ title: 'Big task', url: 'https://x/issues/1' });
		const body = splitChildCommentBody(parent, [parent], 2, 3, {
			preplanPublished: false,
			planned: false,
			prepared: false,
		});
		expect(body).toContain('remains in **Backlog**');
		expect(body).toContain('with no saved plan');
		expect(body).toContain('run a Planning agent on it normally');
		expect(body).not.toContain('swarm:replan');
		expect(body).not.toMatch(/move (the item|it) to \*\*ToDo\*\*/);
	});
});

describe('preplanCommentBody', () => {
	const contract = buildPreplanContract({
		splitId: 'split-abc',
		childIndex: 1,
		parentUrl: 'https://github.com/o/r/issues/18',
		itemUrl: 'https://github.com/o/r/issues/42',
		humanDescription: 'The UI slice.',
		plan: '# UI plan\n\n1. Build it.',
		generatedAt: '2026-07-14T00:00:00.000Z',
	});

	it('identifies itself as this phase’s preplan and carries the plan verbatim', () => {
		const body = preplanCommentBody(contract, 3, 4);
		expect(body).toContain('## 🗺️ Preplan — Phase 3 of 4');
		expect(body).toContain('# UI plan\n\n1. Build it.');
		expect(body).toContain(
			'A separate comment on this issue reports where this task stands and what to do next.',
		);
		expect(body).not.toContain('comment below');
	});

	it('gives no lifecycle instruction — it is composed before preparation is known to succeed', () => {
		const body = preplanCommentBody(contract, 3, 4);
		// It is published before the marker write and the Planning move, so it cannot
		// honestly tell the operator to move the item on: in the Backlog fallback there
		// is no saved plan, and a move to ToDo would dispatch Implementation on a child
		// that was never planned. The split comment, posted afterwards with the real
		// preparation state, owns that advice.
		expect(body).not.toMatch(/move (the item|it) to \*\*ToDo\*\*/);
		expect(body).not.toContain('swarm:replan');
	});

	it('ends with the split-provenance marker its own prefix identifies', () => {
		const marker = preplanCommentMarker('split-abc', 1);
		expect(marker).toBe('<!-- swarm-preplan-comment:split-abc:1 -->');
		expect(marker.startsWith(PREPLAN_COMMENT_MARKER_PREFIX)).toBe(true);
		expect(preplanCommentBody(contract, 3, 4)).toContain(marker);
		// Distinct token from the authoritative hidden contract marker, so neither
		// can ever be mistaken for the other.
		expect(preplanCommentBody(contract, 3, 4)).not.toContain('<!-- swarm-preplan:v1');
	});
});
