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
	PROPOSED_PLAN_FILENAME,
	PROPOSED_SCOPE_FILENAME,
	PROPOSED_SPLIT_FILENAME,
	planCommentBody,
	runPlanningPhase,
	SPLIT_CHILD_LABEL,
} from '@/pipeline/planning.js';
import {
	buildPreplanContract,
	embedPreplanMarker,
	evaluatePreplan,
	isPreplanSkip,
	REPLAN_LABEL,
} from '@/pipeline/preplan.js';
import type { UpdateWorkItemPatch, WorkItem } from '@/pm/types.js';
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
		reuse: vi.fn(async () => handle),
		cleanup: vi.fn(async () => {}),
	};
	const pm = {
		type: 'github-projects' as const,
		getWorkItem: vi.fn(),
		listWorkItems: vi.fn(),
		findWorkItemByUrlSuffix: vi.fn(async () => undefined),
		addComment: vi.fn<(id: string, text: string) => Promise<string>>(async () => 'comment-1'),
		findComment: vi.fn<(id: string, marker: string) => Promise<string | undefined>>(
			async () => undefined,
		),
		moveWorkItem: vi.fn(async () => {}),
		createWorkItem: vi.fn(async (input) =>
			createMockWorkItem({ id: `PVTI_${input.title}`, title: input.title, url: input.title }),
		),
		updateWorkItem: vi.fn<(id: string, patch: UpdateWorkItemPatch) => Promise<void>>(
			async () => {},
		),
		addLabel: vi.fn<(id: string, name: string) => Promise<void>>(async () => {}),
		supportsDependencies: true,
		supportsAssignees: true,
		listBlockers: vi.fn(async () => []),
		addBlockedBy: vi.fn<(id: string, blockerId: string) => Promise<void>>(async () => {}),
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
			mainTask: { title: 'First slice', description: 'Just the API' },
			subTasks: [
				{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Build it.' },
				{ title: 'Third slice', description: 'The docs', plan: '# Docs plan\n\n1. Write it.' },
			],
		});
		const deps = makeDeps();
		const result = await runPlanningPhase({ ...deps, autoAdvance: true });

		// Original re-scoped/renamed into the smaller first task.
		expect(deps.pm.updateWorkItem).toHaveBeenCalledWith('PVTI_item18', {
			title: 'First slice',
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
			'Second slice',
			'Third slice',
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

		// Each child enters Planning only after its marker was written, avoiding a
		// Planning event that could launch another agent before the trigger can skip it.
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_Second slice', 'planning');
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_Third slice', 'planning');
		const secondMarkerOrder = deps.pm.updateWorkItem.mock.invocationCallOrder[1];
		const secondPlanningOrder = deps.pm.moveWorkItem.mock.invocationCallOrder[0];
		expect(secondMarkerOrder).toBeLessThan(secondPlanningOrder);

		// Each prepared child is then labeled `planned` (issues #426, #436) — planned
		// by construction, so the marker is accurate before its own Planning run.
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_Second slice', PLANNED_LABEL);
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_Third slice', PLANNED_LABEL);

		// Each sibling gets an explanatory comment (plus the original's plan comment).
		const commentTargets = deps.pm.addComment.mock.calls.map((c) => c[0]);
		expect(commentTargets).toContain('PVTI_Second slice');
		expect(commentTargets).toContain('PVTI_Third slice');
		const secondComment = deps.pm.addComment.mock.calls.find(
			(c) => c[0] === 'PVTI_Second slice',
		)?.[1];
		// Phase 2 of 3, blocked by phase 1 (the re-scoped original) and no one else.
		expect(secondComment).toMatch(/Phase 2 of 3 — split from a larger task/);
		expect(secondComment).toMatch(/Blocked by/);
		expect(secondComment).toContain('Phase 1: First slice');
		expect(secondComment).not.toContain('Phase 2: Second slice');
		expect(secondComment).toContain('placed it in **Planning**');

		const thirdComment = deps.pm.addComment.mock.calls.find(
			(c) => c[0] === 'PVTI_Third slice',
		)?.[1];
		// Phase 3 of 3, cumulatively blocked by BOTH earlier phases.
		expect(thirdComment).toMatch(/Phase 3 of 3 — split from a larger task/);
		expect(thirdComment).toContain('Phase 1: First slice');
		expect(thirdComment).toContain('Phase 2: Second slice');

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
			subTasks: [{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Do it.' }],
		});
		const deps = makeDeps();
		deps.project = createMockProjectConfig({ pipeline: { automationLabel: 'automate' } });

		await runPlanningPhase(deps);

		// Without this the sibling SWARM just created would be gated out of SWARM's
		// own pipeline by the very label the project configured.
		expect(deps.pm.createWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({ labels: ['automate', SPLIT_CHILD_LABEL] }),
		);
	});

	it('labels a prepared split child `planned` before its own Planning run (issue #426)', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			subTasks: [{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Do it.' }],
		});
		const deps = makeDeps();

		await runPlanningPhase(deps);

		// The label is a follow-up write, not a creation label (issue #436), so a
		// failed preparation can't leave it behind...
		expect(deps.pm.createWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({ labels: ['swarm', SPLIT_CHILD_LABEL] }),
		);
		// ...but a child that really was prepared still carries it long before its own
		// preplanned Planning run — right after its marker and Planning move landed.
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_Second slice', PLANNED_LABEL);
		const childLabelOrder = deps.pm.addLabel.mock.invocationCallOrder[0];
		const childPlanningOrder = deps.pm.moveWorkItem.mock.invocationCallOrder[0];
		expect(childLabelOrder).toBeGreaterThan(childPlanningOrder);
	});

	it('keeps splitting when labeling a prepared split child `planned` throws (issue #436)', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			subTasks: [
				{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Do it.' },
				{ title: 'Third slice', description: 'The docs', plan: '# Docs plan\n\n1. Write it.' },
			],
		});
		const deps = makeDeps();
		// Best-effort, like the blocked-by link: a refused label must never abort the
		// split mid-loop, or a retry would duplicate the siblings.
		deps.pm.addLabel = vi.fn<(id: string, name: string) => Promise<void>>(async (id) => {
			if (id === 'PVTI_Second slice') throw new Error('board rejected the label');
		});

		const result = await runPlanningPhase(deps);

		expect(result.split).toMatchObject({
			subTaskItemIds: ['PVTI_Second slice', 'PVTI_Third slice'],
		});
		// The refused child was still prepared, so it keeps its Planning placement and
		// the prepared comment; the next sibling is labeled as usual.
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_Second slice', 'planning');
		expect(
			deps.pm.addComment.mock.calls.find((call) => call[0] === 'PVTI_Second slice')?.[1],
		).toContain('placed it in **Planning**');
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_Third slice', PLANNED_LABEL);
	});

	it('labels split children with only the split-child label when the gate is disabled', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			subTasks: [{ title: 'Second slice', description: 'The UI', plan: '# UI plan\n\n1. Do it.' }],
		});
		const deps = makeDeps();
		deps.project = createMockProjectConfig({ pipeline: { automationLabel: '' } });

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

	it('leaves the original untouched when the split omits mainTask (but still marks the sibling)', async () => {
		splitExists = true;
		splitContents = JSON.stringify({
			subTasks: [{ title: 'Only sibling', description: 'Z', plan: '# plan\n\nDo Z.' }],
		});
		const deps = makeDeps();
		const result = await runPlanningPhase(deps);
		// The original item's fields are not patched...
		expect(deps.pm.updateWorkItem).not.toHaveBeenCalledWith('PVTI_item18', expect.anything());
		// ...but the sibling's body is still updated to carry its preplanned marker.
		expect(deps.pm.updateWorkItem).toHaveBeenCalledWith(
			'PVTI_Only sibling',
			expect.objectContaining({ description: expect.stringContaining('swarm-preplan:v1') }),
		);
		expect(deps.pm.createWorkItem).toHaveBeenCalledTimes(1);
		expect(result.split).toMatchObject({ mainTaskUpdated: false });
	});

	it('treats an empty subTasks array as no split', async () => {
		splitExists = true;
		splitContents = JSON.stringify({ subTasks: [] });
		const deps = makeDeps();
		const result = await runPlanningPhase(deps);
		expect(deps.pm.createWorkItem).not.toHaveBeenCalled();
		expect(result.split).toBeUndefined();
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
		expect(deps.pm.addComment).toHaveBeenCalledWith(
			'PVTI_Second slice',
			expect.stringContaining('remains in **Backlog**'),
		);
		expect(
			deps.pm.addComment.mock.calls.find((call) => call[0] === 'PVTI_Second slice')?.[1],
		).not.toContain('placed it in **Planning**');
		expect(result.split).toMatchObject({ subTaskItemIds: ['PVTI_Second slice'] });
		// Such a child is genuinely un-planned — its plan is lost with the unwritten
		// marker and a full Planning agent run still has to produce one — so it must
		// not be left labeled `planned` (issue #436). The parent's own run still is.
		expect(deps.pm.addLabel).not.toHaveBeenCalledWith('PVTI_Second slice', PLANNED_LABEL);
		expect(deps.pm.addLabel).toHaveBeenCalledWith('PVTI_item18', PLANNED_LABEL);
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

		expect(deps.pm.addComment).toHaveBeenCalledWith(
			'PVTI_Second slice',
			expect.stringContaining('remains in **Backlog**'),
		);
		expect(
			deps.pm.addComment.mock.calls.find((call) => call[0] === 'PVTI_Second slice')?.[1],
		).not.toContain('placed it in **Planning**');
		// The other half of the preparation block, same conclusion (issue #436): a
		// child stranded in Backlog is not `planned`, whichever step stranded it.
		expect(deps.pm.addLabel).not.toHaveBeenCalledWith('PVTI_Second slice', PLANNED_LABEL);
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

	it('falls back to a normal run when an operator applies the replan label', async () => {
		const deps = makeDeps();
		const child = preplannedChild('# plan');
		deps.workItem = {
			...child,
			labels: [...child.labels, { id: REPLAN_LABEL, name: REPLAN_LABEL }],
		};
		await runPlanningPhase(deps);
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
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
});
