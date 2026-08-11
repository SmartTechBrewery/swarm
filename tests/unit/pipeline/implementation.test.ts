import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The worktree's files are read via node:fs; presence + contents are controlled per
// test. `.swarm_delivery.json` is the sidecar deterministic delivery writes itself,
// so it is backed by whatever the phase wrote rather than by a per-test flag.
let handoffFileExists: boolean;
let handoffFileContents: string;
let blockedReasonFileExists: boolean;
let blockedReasonFileContents: string;
let checkpointFileExists: boolean;
let checkpointFileContents: string;
let progressFileContents: string | undefined;
vi.mock('node:fs', () => ({
	existsSync: (path: unknown) => {
		const name = String(path);
		if (name.endsWith('blocked_reason.md')) return blockedReasonFileExists;
		if (name.endsWith('swarm_checkpoint.json')) return checkpointFileExists;
		if (name.endsWith('.swarm_delivery.json')) return progressFileContents !== undefined;
		return handoffFileExists;
	},
	readFileSync: (path: unknown) => {
		const name = String(path);
		if (name.endsWith('blocked_reason.md')) return blockedReasonFileContents;
		if (name.endsWith('swarm_checkpoint.json')) return checkpointFileContents;
		if (name.endsWith('.swarm_delivery.json')) return progressFileContents;
		return handoffFileContents;
	},
	writeFileSync: (path: unknown, data: unknown) => {
		if (String(path).endsWith('.swarm_delivery.json')) progressFileContents = String(data);
	},
}));

// The one delivery step that shells out to real `git`. The worktree here is a
// fixture path, not a checkout, so the commit is stubbed; `implementation-delivery.test.ts`
// exercises commit/push/PR against real repositories.
const DELIVERED_SHA = 'c0ffee1234567890c0ffee1234567890c0ffee12';
vi.mock('@/scm/delivery.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/scm/delivery.js')>()),
	commitPreparedTree: vi.fn(async () => DELIVERED_SHA),
}));

// A checkpoint continuation's gate verdict. The gate itself (validation, lease
// release, blocked reasons) is covered in `resume.test.ts` against real fixtures;
// here it is stubbed so this file can assert what the *phase* does with it.
const { executeRecoveryGateMock } = vi.hoisted(() => ({ executeRecoveryGateMock: vi.fn() }));
vi.mock('@/pipeline/resume.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/pipeline/resume.js')>()),
	executeRecoveryGate: executeRecoveryGateMock,
}));

import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import { logger } from '@/lib/logger.js';
import type { Checkpoint } from '@/pipeline/checkpoint.js';
import {
	BLOCKED_REASON_FILENAME,
	buildImplementationPrompt,
	implementationCommentBody,
	runImplementationPhase,
} from '@/pipeline/implementation.js';
import type { WorkItemBlocker, WorkItemDependent } from '@/pm/types.js';
import { HANDOFF_FILENAMES, type ScmDeliveryProvider } from '@/scm/delivery.js';
import { isSwarmGeneratedBody } from '@/scm/swarm-origin.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { createMockProjectConfig, createMockWorkItem } from '../../helpers/factories.js';

const WORKTREE_PATH = '/Users/dev/swarm/swarm/.swarm-workspaces/task-19';
const PR_URL = 'https://github.com/SmartTechBrewery/swarm/pull/99';

/** The hand-off a successful implementation run leaves for SWARM to deliver. */
const HANDOFF = JSON.stringify({
	summary: 'Adds the implementation phase.',
	commitSubject: 'feat: add the implementation phase',
	verification: [{ command: 'npm test', outcome: 'passed' }],
	limitations: [],
	readyForDelivery: true,
});

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

/** What an involuntarily stopped implementation run left behind. */
const CONTINUATION: Checkpoint = {
	phase: 'implementation',
	completed: ['Added `ProjectConfigSchema.retryPolicy` and its validation tests'],
	remaining: ['Update the README table', 'Run lint, type-check, and the focused tests'],
	decisions: [],
	workingTree: { modified: ['src/config/schema.ts'], added: [], deleted: [] },
};

/**
 * The deterministic delivery seam. Production resolves the project's registered
 * SCM provider here; every phase run goes through it, so a test that does not
 * inject one would reach the registry.
 */
function makeDelivery() {
	return {
		commitIdentity: { name: 'swarm-implementer', email: 'implementer@users.noreply.github.com' },
		findPullRequest: vi.fn(
			async (_branch: string) => undefined as { number: number; url: string } | undefined,
		),
		createPullRequest: vi.fn(async () => ({ number: 99, url: PR_URL })),
		pushBranch: vi.fn(async (_cwd: string, _branch: string, _expectedSha: string) => {}),
		submitReview: vi.fn(async () => 0),
		postComment: vi.fn(async () => 0),
	} satisfies ScmDeliveryProvider;
}

function makeDeps() {
	const handle: WorktreeHandle = {
		taskId: '19',
		path: WORKTREE_PATH,
		branch: 'issue-19',
		detached: false,
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
		findWorkItemByDescriptionMarker: vi.fn(async () => undefined),
		addComment: vi.fn<(id: string, text: string) => Promise<string>>(async () => 'comment-1'),
		findComment: vi.fn(async () => undefined),
		moveWorkItem: vi.fn(async () => {}),
		createWorkItem: vi.fn(async () => createMockWorkItem({ id: 'PVTI_sibling' })),
		updateWorkItem: vi.fn(async () => {}),
		addLabel: vi.fn(async () => {}),
		supportsDependencies: true,
		supportsAssignees: true,
		listBlockers: vi.fn<() => Promise<WorkItemBlocker[]>>(async () => []),
		listDependents: vi.fn<() => Promise<WorkItemDependent[]>>(async () => []),
		addBlockedBy: vi.fn<(id: string, blockerId: string) => Promise<void>>(async () => {}),
	};
	return {
		project: createMockProjectConfig(),
		workItem: createMockWorkItem({ id: 'PVTI_item19', title: 'Add implementation phase' }),
		taskId: '19',
		pm,
		worktrees: worktrees as unknown as GitWorktreeManager,
		runAgent: vi.fn<(opts: RunAgentCliOptions) => Promise<AgentCliResult>>(async () =>
			agentResult(),
		),
		graft: vi.fn(() => []),
		getToken: vi.fn(async () => 'implementer-token'),
		delivery: makeDelivery(),
	};
}

describe('runImplementationPhase', () => {
	beforeEach(() => {
		handoffFileExists = true;
		handoffFileContents = HANDOFF;
		blockedReasonFileExists = false;
		blockedReasonFileContents = '';
		checkpointFileExists = false;
		checkpointFileContents = '';
		progressFileContents = undefined;
	});

	it('defers (throws DependencyBlockedError) when the item is blocked by an open prerequisite', async () => {
		const deps = makeDeps();
		deps.pm.listBlockers.mockResolvedValueOnce([
			{
				reference: '#319',
				url: 'https://github.com/o/r/issues/319',
				title: 'Session auth',
				open: true,
				source: 'dependency',
			},
		]);

		await expect(runImplementationPhase(deps)).rejects.toMatchObject({
			name: 'DependencyBlockedError',
		});

		// Nothing was started: no "In progress" move, no worktree, no credentials, no agent —
		// so the deferral spends zero model tokens.
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();
		expect(deps.worktrees.provision).not.toHaveBeenCalled();
		expect(deps.getToken).not.toHaveBeenCalled();
		expect(deps.runAgent).not.toHaveBeenCalled();
	});

	it('proceeds normally when the item has only closed (satisfied) blockers', async () => {
		const deps = makeDeps();
		deps.pm.listBlockers.mockResolvedValueOnce([
			{
				reference: '#319',
				url: 'https://github.com/o/r/issues/319',
				title: 'Session auth',
				open: false,
				source: 'dependency',
			},
		]);
		await expect(runImplementationPhase(deps)).resolves.toBeDefined();
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
	});

	it('moves the item to inReview after successful delivery when Review is enabled', async () => {
		const deps = makeDeps();
		const result = await runImplementationPhase(deps);

		// Implementer credentials are the point of the persona split.
		expect(deps.getToken).toHaveBeenCalledWith(deps.project, 'implementer');

		// Reports pickup by moving to In progress before doing any other work.
		expect(deps.pm.moveWorkItem).toHaveBeenNthCalledWith(1, 'PVTI_item19', 'inProgress');

		// Task-branch checkout: provisioned with defaults (createBranch), NOT detached.
		expect(deps.worktrees.provision).toHaveBeenCalledWith('19', { runId: undefined });

		// Claude Code is run with the worktree as CWD, the implementation prompt,
		// and the implementer token in GH_TOKEN so gh (incl. `gh pr create`) acts
		// as the implementer persona, not the worker host's own gh auth login.
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.cli).toBe('claude');
		expect(runArgs.cwd).toBe(WORKTREE_PATH);
		expect(runArgs.args?.[0]).toContain('Add implementation phase');
		expect(runArgs.env).toEqual({ GH_TOKEN: 'implementer-token' });

		// Env is grafted into the worktree before the agent runs.
		expect(deps.graft).toHaveBeenCalledWith(deps.project.repoRoot, WORKTREE_PATH);

		// SWARM — not the agent — pushes the delivered commit and opens the PR.
		expect(deps.delivery.pushBranch).toHaveBeenCalledWith(WORKTREE_PATH, 'issue-19', DELIVERED_SHA);
		expect(deps.delivery.createPullRequest).toHaveBeenCalledTimes(1);

		// The PR link is posted on the linked item, then the item advances to inReview.
		expect(deps.pm.addComment).toHaveBeenCalledTimes(1);
		expect(deps.pm.addComment.mock.calls[0][0]).toBe('PVTI_item19');
		expect(deps.pm.addComment.mock.calls[0][1]).toContain(PR_URL);
		expect(deps.pm.moveWorkItem).toHaveBeenNthCalledWith(2, 'PVTI_item19', 'inReview');
		expect(deps.pm.moveWorkItem).toHaveBeenCalledTimes(2);

		// Worktree is always cleaned up.
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');

		expect(result).toMatchObject({
			prUrl: PR_URL,
			branch: 'issue-19',
			commentId: 'comment-1',
			movedTo: 'inReview',
		});
	});

	it('names the worktree path in the prompt for Antigravity but not for Claude (issue #226)', async () => {
		// agy --print runs from its own scratch dir, not the worktree cwd, so the
		// Antigravity prompt must name the absolute path; Claude inherits cwd and
		// keeps the "current working directory" phrasing.
		const claudeDeps = makeDeps();
		await runImplementationPhase(claudeDeps);
		const claudePrompt = claudeDeps.runAgent.mock.calls[0][0].args?.[0] ?? '';
		expect(claudePrompt).toContain('worktree whose root is your current working directory');
		expect(claudePrompt).not.toContain(WORKTREE_PATH);

		const agyDeps = makeDeps();
		await runImplementationPhase({ ...agyDeps, cli: 'antigravity' });
		const agyPrompt = agyDeps.runAgent.mock.calls[0][0].args?.[0] ?? '';
		expect(agyPrompt).toContain(`worktree at the absolute path ${WORKTREE_PATH}`);
		expect(agyPrompt).not.toContain('worktree whose root is your current working directory');
	});

	it('keeps the item in progress after successful delivery when Review is disabled', async () => {
		const deps = makeDeps();
		deps.project = createMockProjectConfig({
			pipeline: { review: { enabled: false }, respondToReview: { enabled: false } },
		});
		const result = await runImplementationPhase(deps);

		expect(deps.pm.moveWorkItem).toHaveBeenCalledTimes(1);
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_item19', 'inProgress');
		expect(deps.pm.addComment.mock.calls[0][1]).toContain('Automated Review is disabled');
		expect(result).toMatchObject({ movedTo: undefined });
	});

	it('provisions the existing task branch when its preserved worktree is gone', async () => {
		const deps = makeDeps();
		vi.mocked(deps.worktrees.reuse).mockResolvedValueOnce(undefined);
		await runImplementationPhase({ ...deps, resumeExistingBranch: true });

		expect(deps.worktrees.reuse).toHaveBeenCalledWith('19', 'issue-19', false);
		expect(deps.worktrees.provision).toHaveBeenCalledWith('19', {
			createBranch: false,
			branch: 'issue-19',
			runId: undefined,
		});
	});

	// The collision gate needs the run's own id to tell a foreign live lease from
	// its own dead attempt's orphan (issue #427).
	it('threads the run id into provisioning', async () => {
		const deps = makeDeps();
		await runImplementationPhase({ ...deps, runId: 'run-19' });

		expect(deps.worktrees.provision).toHaveBeenCalledWith('19', { runId: 'run-19' });
	});

	it('reuses a preserved task worktree for a fresh-session implementation retry', async () => {
		const deps = makeDeps();
		await runImplementationPhase({
			...deps,
			resumeExistingBranch: true,
			sessionId: '11111111-1111-4111-8111-111111111111',
		});

		expect(deps.worktrees.reuse).toHaveBeenCalledWith('19', 'issue-19', false);
		expect(deps.worktrees.provision).not.toHaveBeenCalled();
		expect(deps.runAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: '11111111-1111-4111-8111-111111111111',
				resumeSessionId: undefined,
			}),
		);
	});

	it('creates the task branch for a fresh retry deferred before provisioning', async () => {
		const deps = makeDeps();
		await runImplementationPhase({ ...deps, resumeExistingBranch: false });

		expect(deps.worktrees.provision).toHaveBeenCalledWith('19', { runId: undefined });
	});

	it('records branch provisioning only after worktree acquisition succeeds', async () => {
		const deps = makeDeps();
		const onBranchProvisioned = vi.fn(async () => {});

		await runImplementationPhase({ ...deps, onBranchProvisioned });

		expect(onBranchProvisioned).toHaveBeenCalledOnce();
		expect(vi.mocked(deps.worktrees.provision).mock.invocationCallOrder[0]).toBeLessThan(
			onBranchProvisioned.mock.invocationCallOrder[0],
		);
	});

	it('forwards timeoutMs, signal, and maxOutputBytes to the agent runner', async () => {
		const deps = makeDeps();
		const signal = new AbortController().signal;
		await runImplementationPhase({ ...deps, timeoutMs: 60_000, signal });
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
		await runImplementationPhase(deps);
		expect(order).toEqual(['graft', 'agent']);
	});

	it('fails before provisioning any worktree when the implementer token is missing', async () => {
		const deps = makeDeps();
		deps.getToken = vi.fn(async () => {
			throw new Error("No GitHub implementer token configured for project 'swarm'");
		});
		await expect(runImplementationPhase(deps)).rejects.toThrow(/No GitHub implementer token/);
		expect(deps.pm.moveWorkItem).not.toHaveBeenCalled();
		expect(deps.worktrees.provision).not.toHaveBeenCalled();
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('cleans up the worktree and never runs the agent when graft throws', async () => {
		const deps = makeDeps();
		deps.graft = vi.fn(() => {
			throw new Error('graft failed: node_modules missing');
		});
		await expect(runImplementationPhase(deps)).rejects.toThrow(/graft failed/);
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');
	});

	it('honours a cli override (e.g. antigravity)', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ cli: 'antigravity' }));
		await runImplementationPhase({ ...deps, cli: 'antigravity' });
		expect(deps.runAgent.mock.calls[0][0].cli).toBe('antigravity');
	});

	it('posts and moves in order: pickup move, then comment, then the final status move', async () => {
		const deps = makeDeps();
		const order: string[] = [];
		deps.pm.addComment.mockImplementation(async () => {
			order.push('comment');
			return 'comment-1';
		});
		deps.pm.moveWorkItem.mockImplementation(async () => {
			order.push('move');
		});
		await runImplementationPhase(deps);
		expect(order).toEqual(['move', 'comment', 'move']);
	});

	it('throws and still cleans up when the agent exits non-zero', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));
		await expect(runImplementationPhase(deps)).rejects.toThrow(/exited with code 1/);
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		// The pickup move already happened before the agent ran; only the final
		// (In review) move never fires.
		expect(deps.pm.moveWorkItem).toHaveBeenCalledTimes(1);
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_item19', 'inProgress');
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');
	});

	it('notes the timeout in the error when the agent timed out', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: null, timedOut: true }));
		await expect(runImplementationPhase(deps)).rejects.toThrow(/timed out/);
	});

	it('throws and cleans up when the agent wrote no hand-off', async () => {
		handoffFileExists = false;
		const deps = makeDeps();
		await expect(runImplementationPhase(deps)).rejects.toThrow(
			new RegExp(`did not write required hand-off ${HANDOFF_FILENAMES.implementation}`),
		);
		// Nothing was delivered, so nothing is reported and the checkout is released.
		expect(deps.delivery.pushBranch).not.toHaveBeenCalled();
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');
	});

	it('surfaces an agent-written blocker instead of a generic missing-hand-off error', async () => {
		handoffFileExists = false;
		blockedReasonFileExists = true;
		blockedReasonFileContents = 'Wait for PR #147 to merge, then retry this task.';
		const deps = makeDeps();

		await expect(runImplementationPhase(deps)).rejects.toThrow(
			"Implementation blocked for task '19': Wait for PR #147 to merge, then retry this task.",
		);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');
	});

	it('throws and cleans up when the hand-off is not valid JSON', async () => {
		handoffFileContents = '   \n  ';
		const deps = makeDeps();
		await expect(runImplementationPhase(deps)).rejects.toThrow(
			new RegExp(`Invalid hand-off ${HANDOFF_FILENAMES.implementation}`),
		);
		expect(deps.delivery.pushBranch).not.toHaveBeenCalled();
		expect(deps.pm.addComment).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');
	});

	// The hand-off *is* the delivery contract: a run that reports no verification, or
	// that never declared itself ready, must not be committed and pushed.
	it.each([
		['no verification', { verification: [] }],
		['no commit subject', { commitSubject: '' }],
		['readyForDelivery unset', { readyForDelivery: false }],
	])('throws and cleans up when the hand-off has %s', async (_label, override) => {
		handoffFileContents = JSON.stringify({ ...JSON.parse(HANDOFF), ...override });
		const deps = makeDeps();
		await expect(runImplementationPhase(deps)).rejects.toThrow(
			new RegExp(`Invalid hand-off ${HANDOFF_FILENAMES.implementation}`),
		);
		expect(deps.delivery.pushBranch).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');
	});

	// Once the PR is open the delivery is half-done, so the failure is deferred and
	// the checkout preserved — the retry finishes the reporting instead of
	// re-implementing (and re-pushing) the task.
	it('defers and keeps the worktree when posting the comment throws after the PR is open', async () => {
		const deps = makeDeps();
		deps.pm.addComment.mockRejectedValue(new Error('GraphQL 502'));
		await expect(runImplementationPhase(deps)).rejects.toMatchObject({
			name: 'DeliveryDeferredError',
		});
		// The pickup move already happened; only the final (In review) move never fires.
		expect(deps.pm.moveWorkItem).toHaveBeenCalledTimes(1);
		expect(deps.pm.moveWorkItem).toHaveBeenCalledWith('PVTI_item19', 'inProgress');
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('threads sessionId (not resumeSessionId) and provisions fresh on a first run', async () => {
		const deps = makeDeps();
		await runImplementationPhase({ ...deps, sessionId: 'sess-19' });

		expect(deps.worktrees.reuse).not.toHaveBeenCalled();
		expect(deps.worktrees.provision).toHaveBeenCalledWith('19', { runId: undefined });
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.sessionId).toBe('sess-19');
		expect(runArgs.resumeSessionId).toBeUndefined();
	});

	it('resumes the Claude session in place: reuses the worktree and threads resumeSessionId, not sessionId', async () => {
		const deps = makeDeps();
		await runImplementationPhase({ ...deps, sessionId: 'sess-19', resumeSessionId: 'sess-19' });

		expect(deps.worktrees.reuse).toHaveBeenCalledWith('19', 'issue-19', false);
		expect(deps.worktrees.provision).not.toHaveBeenCalled();
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.resumeSessionId).toBe('sess-19');
		expect(runArgs.sessionId).toBeUndefined();
	});

	it('falls back to a fresh provision when the session worktree is gone', async () => {
		const deps = makeDeps();
		vi.mocked(deps.worktrees.reuse).mockResolvedValueOnce(undefined);
		await runImplementationPhase({ ...deps, sessionId: 'sess-19', resumeSessionId: 'sess-19' });

		expect(deps.worktrees.reuse).toHaveBeenCalledWith('19', 'issue-19', false);
		expect(deps.worktrees.provision).toHaveBeenCalledWith('19', { runId: undefined });
		// Nothing to resume: the fresh checkout gets the first-run sessionId instead.
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.resumeSessionId).toBeUndefined();
		expect(runArgs.sessionId).toBe('sess-19');
	});

	/**
	 * Acceptance criterion 5 of issue #591, on the call site where a lost
	 * continuation costs the most: Implementation is the only phase that *writes*
	 * checkpoints, and it acquires its worktree through its own
	 * `acquireImplementationWorktree` rather than the shared
	 * `acquireResumableWorktree` the other five use — so the warning covering them
	 * covers nothing here. Task #553 lost a checkpointed session exactly this way,
	 * with no log line tying the restart to the checkout still on disk.
	 */
	describe('starting over is never silent (issue #591)', () => {
		let warn: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		});

		afterEach(() => {
			warn.mockRestore();
		});

		it('warns — naming task, phase and run — when a checkpointed checkout is abandoned', async () => {
			const deps = makeDeps();
			// The checkout survived and still holds this phase's hand-off, but nothing
			// asked to recover it: no recovery mode, no resume id, no branch flag — so
			// acquisition skips reuse entirely and falls through to provisioning.
			checkpointFileExists = true;
			checkpointFileContents = JSON.stringify(CONTINUATION);

			await runImplementationPhase({ ...deps, runId: 'run-19' });

			const startingOver = warn.mock.calls.filter(([message]) =>
				/starting over/i.test(String(message)),
			);
			expect(startingOver).toHaveLength(1);
			expect(startingOver[0][1]).toMatchObject({
				taskId: '19',
				phase: 'implementation',
				runId: 'run-19',
				worktreePath: WORKTREE_PATH,
				hasCheckpoint: true,
				checkpointPhase: 'implementation',
			});
		});

		it('stays quiet at warn for an ordinary first run, whose task has no checkout at all', async () => {
			const deps = makeDeps();
			// `existsSync` is mocked per-test; the worktree path falls to this flag.
			handoffFileExists = false;

			await runImplementationPhase({ ...deps, runId: 'run-19' }).catch(() => {});

			expect(
				warn.mock.calls.filter(([message]) => /starting over/i.test(String(message))),
			).toHaveLength(0);
		});
	});

	it('continues from a checkpoint on a fresh session, on a different CLI (issue #502)', async () => {
		const deps = makeDeps();
		executeRecoveryGateMock.mockResolvedValueOnce({
			reuseHandle: { taskId: '19', path: WORKTREE_PATH, branch: 'issue-19', detached: false },
			checkpoint: CONTINUATION,
		});

		await runImplementationPhase({
			...deps,
			// The stopped run was a `claude` one that captured `prior-19`; this
			// continuation carries no session, so it may run on any engine.
			cli: 'codex',
			sessionId: 'fresh-19',
			resumeSessionId: 'prior-19',
			recoveryMode: 'checkpoint',
		});

		// The gate validated the checkpoint against *this* phase.
		expect(executeRecoveryGateMock).toHaveBeenCalledWith(
			expect.anything(),
			'19',
			'checkpoint',
			'prior-19',
			'implementation',
			'issue-19',
		);
		// The adopted checkout is used as-is.
		expect(deps.worktrees.provision).not.toHaveBeenCalled();
		expect(deps.worktrees.reuse).not.toHaveBeenCalled();

		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.cwd).toBe(WORKTREE_PATH);
		// A fresh session and no resume id, despite `resumeSessionId` being known.
		expect(runArgs.sessionId).toBe('fresh-19');
		expect(runArgs.resumeSessionId).toBeUndefined();
		// The prompt carries the recorded remainder instead of the CLI's own context.
		expect(runArgs.args?.[0]).toContain('--- CONTINUING FROM A CHECKPOINT ---');
		expect(runArgs.args?.[0]).toContain('Update the README table');
		expect(runArgs.args?.[0]).toContain('Complete only the remainder');
	});

	it('leaves the prompt and session threading alone without a checkpoint continuation', async () => {
		const deps = makeDeps();
		await runImplementationPhase({ ...deps, sessionId: 'sess-19' });
		expect(executeRecoveryGateMock).not.toHaveBeenCalled();
		expect(deps.runAgent.mock.calls[0][0].args?.[0]).not.toContain('CONTINUING FROM A CHECKPOINT');
	});

	it('preserves the worktree (skips cleanup) when a session run fails on a rate limit', async () => {
		const deps = makeDeps();
		// A rate-limited run that captured a session id (any CLI) — the resumable case.
		deps.runAgent = vi.fn(async () =>
			agentResult({
				exitCode: 1,
				stdout: "You've hit your session limit · resets 1:40pm (Europe/Warsaw)\n",
				sessionId: 'sess-19',
			}),
		);
		await expect(runImplementationPhase({ ...deps, sessionId: 'sess-19' })).rejects.toThrow(
			/rate limited/,
		);
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('preserves the worktree (skips cleanup) when a session run times out', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () =>
			agentResult({ exitCode: null, timedOut: true, sessionId: 'sess-19' }),
		);
		await expect(runImplementationPhase({ ...deps, sessionId: 'sess-19' })).rejects.toThrow(
			/timed out/,
		);
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
		await expect(runImplementationPhase(deps)).rejects.toThrow(/rate limited/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');
	});

	it('preserves the worktree for a checkpoint continuation when a sessionless stop left one', async () => {
		checkpointFileExists = true;
		checkpointFileContents = JSON.stringify(CONTINUATION);
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () =>
			agentResult({
				exitCode: 1,
				stdout: "You've hit your session limit · resets 1:40pm (Europe/Warsaw)\n",
			}),
		);
		await expect(runImplementationPhase(deps)).rejects.toThrow(/rate limited/);
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('cleans up when a sessionless stop left an invalid checkpoint', async () => {
		checkpointFileExists = true;
		checkpointFileContents = JSON.stringify({ nonsense: true });
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () =>
			agentResult({
				exitCode: 1,
				stdout: "You've hit your session limit · resets 1:40pm (Europe/Warsaw)\n",
			}),
		);
		await expect(runImplementationPhase(deps)).rejects.toThrow(/rate limited/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('19');
	});
});

describe('buildImplementationPrompt', () => {
	const context = {
		repo: 'SmartTechBrewery/swarm',
		taskId: '19',
		branch: 'issue-19',
		baseBranch: 'main',
	};

	it('instructs implementing, committing, pushing, opening a PR that closes the issue, and recording the URL', () => {
		const prompt = buildImplementationPrompt(
			createMockWorkItem({ title: 'T', description: 'D' }),
			context,
		);
		expect(prompt).toContain(HANDOFF_FILENAMES.implementation);
		expect(prompt).toContain(BLOCKED_REASON_FILENAME);
		expect(prompt).toContain('Closes #19');
		expect(prompt).toContain('git push -u origin issue-19');
		expect(prompt).toContain('gh pr create');
		expect(prompt).toContain('main');
		expect(prompt).toContain('T');
		expect(prompt).toContain('D');
	});

	it('tells the agent to read the linked issue and its posted plan first', () => {
		const prompt = buildImplementationPrompt(createMockWorkItem(), context);
		expect(prompt).toContain('gh issue view 19');
	});

	it('specifies non-interactive gh pr create flags and keeps the PR-URL file uncommitted', () => {
		const prompt = buildImplementationPrompt(createMockWorkItem(), context);
		expect(prompt).toContain('--base main');
		expect(prompt).toContain('--head issue-19');
		expect(prompt).toMatch(/Do NOT `git add`\/commit/);
		expect(prompt).toContain('Do NOT invoke the `solve-issue` skill');
		expect(prompt).toContain('After step 7, STOP immediately and exit');
		expect(prompt).toContain('Do not wait for a review');
	});

	it('defines a focused completion bar instead of demanding speculative coverage', () => {
		const prompt = buildImplementationPrompt(createMockWorkItem(), context);
		expect(prompt).toContain('Definition of enough');
		expect(prompt).toContain('smallest durable change');
		expect(prompt).toContain('Do not add speculative features, broad refactors');
		expect(prompt).toContain('focused tests for changed stable behavior');
	});

	it('falls back to a placeholder when the work item has no description', () => {
		const prompt = buildImplementationPrompt(createMockWorkItem({ description: '' }), context);
		expect(prompt).toContain('(no description provided)');
	});

	it('carries the GH identity guard so the implementer persona token is not overridden', () => {
		const prompt = buildImplementationPrompt(createMockWorkItem(), context);
		expect(prompt).toContain('GH_TOKEN');
		expect(prompt).toContain('gh auth switch');
	});

	it('describes the worktree as the current working directory when no path is named', () => {
		// Claude/Codex inherit `cwd`, so the default phrasing stays true and no
		// absolute path is named (issue #226).
		const prompt = buildImplementationPrompt(createMockWorkItem(), context);
		expect(prompt).toContain('worktree whose root is your current working directory');
	});

	it('names the exact absolute worktree path and requires all writes there when one is given', () => {
		// Antigravity's `agy --print` runs from its own scratch dir, not `cwd`
		// (issue #226): the prompt must name the worktree path and point every edit
		// and hand-off file at it, so SWARM's delivery validation finds the hand-off.
		const worktreePath = '/Users/dev/swarm/swarm/.swarm-workspaces/task-19';
		const prompt = buildImplementationPrompt(createMockWorkItem(), { ...context, worktreePath });
		expect(prompt).toContain(`worktree at the absolute path ${worktreePath}`);
		expect(prompt).toContain(`inside\n${worktreePath}. SWARM only reads files from there.`);
		expect(prompt).toContain(HANDOFF_FILENAMES.implementation);
		expect(prompt).toContain(BLOCKED_REASON_FILENAME);
		// The "current working directory" claim would be false there, so it's dropped.
		expect(prompt).not.toContain('worktree whose root is your current working directory');
	});
});

describe('implementationCommentBody', () => {
	it('wraps the PR URL with a header and, by default, an already-moved note', () => {
		const body = implementationCommentBody('https://github.com/SmartTechBrewery/swarm/pull/99');
		expect(body).toContain('Implementation complete');
		expect(body).toContain('https://github.com/SmartTechBrewery/swarm/pull/99');
		expect(body).toContain('In review');
		expect(body).toMatch(/has moved to/);
	});

	it('reports that the item remains in progress when Review is disabled', () => {
		const body = implementationCommentBody(
			'https://github.com/SmartTechBrewery/swarm/pull/99',
			false,
		);
		expect(body).toContain('Automated Review is disabled');
		expect(body).toContain('remains **In progress**');
	});

	it('is recognizable as SWARM-generated in both variants (issue #443)', () => {
		// Comment loop prevention keys on this marker, so an unmarked body would come
		// back through the webhook as human input.
		expect(isSwarmGeneratedBody(implementationCommentBody('https://x/pull/9'))).toBe(true);
		expect(isSwarmGeneratedBody(implementationCommentBody('https://x/pull/9', false))).toBe(true);
	});
});
