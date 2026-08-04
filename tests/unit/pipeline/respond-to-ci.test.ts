import { beforeEach, describe, expect, it, vi } from 'vitest';

// The outcome file is read via node:fs; presence + contents are controlled per test.
let outcomeFileExists: boolean;
let outcomeFileContents: string;
vi.mock('node:fs', () => ({
	existsSync: () => outcomeFileExists,
	readFileSync: () => outcomeFileContents,
}));

import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import {
	buildRespondToCiPrompt,
	RESPOND_CI_OUTCOME_FILENAME,
	runRespondToCiPhase,
} from '@/pipeline/respond-to-ci.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const WORKTREE_PATH = '/Users/dev/swarm/swarm/.swarm-workspaces/task-respond-ci-64';
const PR_BRANCH = 'issue-64';
const HEAD_SHA = 'deadbeef';

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
	// The PR's existing task branch — not detached, the agent pushes the fix here.
	const handle: WorktreeHandle = {
		taskId: 'respond-ci-64',
		path: WORKTREE_PATH,
		branch: PR_BRANCH,
		detached: false,
	};
	const worktrees = {
		provision: vi.fn(async () => handle),
		cleanup: vi.fn(async () => {}),
	};
	return {
		project: createMockProjectConfig(),
		prNumber: '99',
		prBranch: PR_BRANCH,
		headSha: HEAD_SHA,
		taskId: 'respond-ci-64',
		worktrees: worktrees as unknown as GitWorktreeManager,
		runAgent: vi.fn<(opts: RunAgentCliOptions) => Promise<AgentCliResult>>(async () =>
			agentResult(),
		),
		graft: vi.fn(() => []),
		getToken: vi.fn(async () => 'implementer-token'),
	};
}

describe('runRespondToCiPhase', () => {
	beforeEach(() => {
		outcomeFileExists = true;
		outcomeFileContents = 'fixed\n';
	});

	it('provisions a worktree on the PR branch, runs Claude Code as the implementer, and returns the outcome', async () => {
		const deps = makeDeps();
		const result = await runRespondToCiPhase(deps);

		// Implementer credentials, same reason as Implementation/Review.
		expect(deps.getToken).toHaveBeenCalledWith(deps.project, 'implementer');

		// The existing task branch, not a fresh cut and not detached — the agent
		// commits and pushes the build fix from here.
		expect(deps.worktrees.provision).toHaveBeenCalledWith('respond-ci-64', {
			createBranch: false,
			branch: PR_BRANCH,
		});

		// Claude Code runs with the worktree as CWD, the CI-fix prompt, and the
		// implementer token in GH_TOKEN so gh (incl. the PR comment) acts as that
		// persona rather than the worker host's own gh auth login.
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.cli).toBe('claude');
		expect(runArgs.cwd).toBe(WORKTREE_PATH);
		expect(runArgs.args?.[0]).toContain(HEAD_SHA);
		expect(runArgs.env).toEqual({ GH_TOKEN: 'implementer-token' });

		// Env is grafted into the worktree before the agent runs.
		expect(deps.graft).toHaveBeenCalledWith(deps.project.repoRoot, WORKTREE_PATH);

		// Worktree is always cleaned up.
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-ci-64');

		expect(result.outcome).toBe('fixed');
		expect(result.agent.exitCode).toBe(0);
	});

	it('forwards timeoutMs, signal, and maxOutputBytes to the agent runner', async () => {
		const deps = makeDeps();
		const signal = new AbortController().signal;
		await runRespondToCiPhase({ ...deps, timeoutMs: 60_000, signal });
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
		await runRespondToCiPhase(deps);
		expect(order).toEqual(['graft', 'agent']);
	});

	it('cleans up the worktree and never runs the agent when graft throws', async () => {
		const deps = makeDeps();
		deps.graft = vi.fn(() => {
			throw new Error('graft failed: node_modules missing');
		});
		await expect(runRespondToCiPhase(deps)).rejects.toThrow(/graft failed/);
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-ci-64');
	});

	it('does not clean up when provisioning itself fails (nothing to remove)', async () => {
		const deps = makeDeps();
		deps.worktrees.provision = vi.fn(async () => {
			throw new Error("git worktree add failed: invalid reference: 'issue-64'");
		});
		await expect(runRespondToCiPhase(deps)).rejects.toThrow(/invalid reference/);
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('fails before provisioning any worktree when the implementer token is missing', async () => {
		const deps = makeDeps();
		deps.getToken = vi.fn(async () => {
			throw new Error("No GitHub implementer token configured for project 'swarm'");
		});
		await expect(runRespondToCiPhase(deps)).rejects.toThrow(/No GitHub implementer token/);
		expect(deps.worktrees.provision).not.toHaveBeenCalled();
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('honours a cli override (e.g. antigravity)', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ cli: 'antigravity' }));
		await runRespondToCiPhase({ ...deps, cli: 'antigravity' });
		expect(deps.runAgent.mock.calls[0][0].cli).toBe('antigravity');
	});

	it('throws and still cleans up when the agent exits non-zero', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));
		await expect(runRespondToCiPhase(deps)).rejects.toThrow(/exited with code 1/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-ci-64');
	});

	it('notes the timeout in the error when the agent timed out', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: null, timedOut: true }));
		await expect(runRespondToCiPhase(deps)).rejects.toThrow(/timed out/);
	});

	it('throws and cleans up when the agent produced no outcome file', async () => {
		outcomeFileExists = false;
		const deps = makeDeps();
		await expect(runRespondToCiPhase(deps)).rejects.toThrow(
			new RegExp(`did not write ${RESPOND_CI_OUTCOME_FILENAME}`),
		);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-ci-64');
	});

	it('throws and cleans up when the outcome file is empty', async () => {
		outcomeFileContents = '   \n  ';
		const deps = makeDeps();
		await expect(runRespondToCiPhase(deps)).rejects.toThrow(/empty/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-ci-64');
	});

	it('throws and cleans up when the outcome is not one of the known two', async () => {
		outcomeFileContents = 'done!\n';
		const deps = makeDeps();
		await expect(runRespondToCiPhase(deps)).rejects.toThrow(/unrecognized outcome 'done!'/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-ci-64');
	});

	it.each([
		['fixed\n', 'fixed'],
		['Fixed', 'fixed'],
		['NO-FIX\n', 'no-fix'],
		['no-fix', 'no-fix'],
	])('normalizes outcome %j to %j', async (contents, expected) => {
		outcomeFileContents = contents;
		const deps = makeDeps();
		const result = await runRespondToCiPhase(deps);
		expect(result.outcome).toBe(expected);
	});
});

describe('buildRespondToCiPrompt', () => {
	const context = {
		repo: 'SmartTechBrewery/swarm',
		prNumber: '99',
		prBranch: PR_BRANCH,
		headSha: HEAD_SHA,
	};

	it('instructs syncing the branch, inspecting the failing checks pinned to the SHA, and recording the outcome', () => {
		const prompt = buildRespondToCiPrompt(context);
		expect(prompt).toContain(`git pull --ff-only origin ${PR_BRANCH}`);
		// Explicit remote/branch on the push — the checkout may have no upstream
		// configured (e.g. a human-created PR branch), so a bare `git push` could fail.
		expect(prompt).toContain(`git push origin ${PR_BRANCH}`);
		expect(prompt).toContain('gh pr checks 99 --repo SmartTechBrewery/swarm');
		expect(prompt).toContain(`gh run list --repo SmartTechBrewery/swarm --commit ${HEAD_SHA}`);
		expect(prompt).toContain('gh pr comment 99 --repo SmartTechBrewery/swarm');
		expect(prompt).toContain(RESPOND_CI_OUTCOME_FILENAME);
	});

	it('offers both outcomes — fix the build or make no change — and forbids merging or self-review', () => {
		const prompt = buildRespondToCiPrompt(context);
		expect(prompt).toContain('Do NOT invoke the `solve-issue` skill');
		expect(prompt).toContain('`fixed`');
		expect(prompt).toContain('`no-fix`');
		expect(prompt).toMatch(/keep the fix surgical|Keep the fix surgical/i);
		expect(prompt).toMatch(/Do NOT `git add`\/commit/);
		expect(prompt).toContain('Do not merge the PR');
		expect(prompt).toContain('do not review it');
	});

	it('carries the GH identity guard so the implementer persona token is not overridden', () => {
		const prompt = buildRespondToCiPrompt(context);
		expect(prompt).toContain('GH_TOKEN');
		expect(prompt).toContain('gh auth switch');
	});
});
