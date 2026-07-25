import { beforeEach, describe, expect, it, vi } from 'vitest';

// The verdict file is read via node:fs; presence + contents are controlled per test.
let verdictFileExists: boolean;
let verdictFileContents: string;
vi.mock('node:fs', () => ({
	existsSync: () => verdictFileExists,
	readFileSync: () => verdictFileContents,
}));

import {
	REVIEW_VERDICT_CAP,
	type ReviewVerdictRecord,
} from '@/db/repositories/reviewVerdictsRepository.js';
import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import { buildReviewPrompt, REVIEW_VERDICT_FILENAME, runReviewPhase } from '@/pipeline/review.js';
import { ReviewHandoffSchema } from '@/scm/delivery.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const WORKTREE_PATH = '/Users/dev/swarm/swarm/.swarm-workspaces/task-review-20';
const HEAD_SHA = 'abc1234def5678abc1234def5678abc1234def56';

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
	// Detached checkout at the PR head SHA — no branch, matching the review flow.
	const handle: WorktreeHandle = {
		taskId: 'review-20',
		path: WORKTREE_PATH,
		branch: HEAD_SHA,
		detached: true,
	};
	const worktrees = {
		provision: vi.fn(async () => handle),
		cleanup: vi.fn(async () => {}),
	};
	return {
		project: createMockProjectConfig(),
		prNumber: '99',
		headSha: HEAD_SHA,
		taskId: 'review-20',
		worktrees: worktrees as unknown as GitWorktreeManager,
		runAgent: vi.fn<(opts: RunAgentCliOptions) => Promise<AgentCliResult>>(async () =>
			agentResult(),
		),
		graft: vi.fn(() => []),
		getToken: vi.fn(async () => 'reviewer-token'),
		// Ledger writers default to a first-verdict reservation so existing tests
		// exercise the common case without a live database (issue #235).
		markReviewVerdictSubmitted: vi.fn(async () => ({ id: 'verdict-1', ordinal: 1 })),
		abandonReviewVerdict: vi.fn(async () => {}),
		// No prior submitted review by default → this is the PR's first review (issue #328).
		getPriorSubmittedReview: vi.fn<() => Promise<ReviewVerdictRecord | undefined>>(
			async () => undefined,
		),
	};
}

describe('runReviewPhase', () => {
	beforeEach(() => {
		verdictFileExists = true;
		verdictFileContents = 'request-changes\n';
	});

	it('provisions a detached worktree at the head SHA, runs Claude Code as the reviewer, and returns the verdict', async () => {
		const deps = makeDeps();
		const result = await runReviewPhase(deps);

		// Reviewer credentials are the point of the persona split.
		expect(deps.getToken).toHaveBeenCalledWith(deps.project, 'reviewer');

		// Read-only checkout: detached at the reviewed commit, no task branch.
		expect(deps.worktrees.provision).toHaveBeenCalledWith('review-20', {
			detach: true,
			baseBranch: HEAD_SHA,
		});

		// Claude Code runs with the worktree as CWD, the review prompt, and the
		// reviewer token in GH_TOKEN so gh acts as the reviewer persona.
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.cli).toBe('claude');
		expect(runArgs.cwd).toBe(WORKTREE_PATH);
		expect(runArgs.args?.[0]).toContain('gh pr diff 99');
		expect(runArgs.env).toEqual({ GH_TOKEN: 'reviewer-token' });

		// Env is grafted into the worktree before the agent runs.
		expect(deps.graft).toHaveBeenCalledWith(deps.project.repoRoot, WORKTREE_PATH);

		// Worktree is always cleaned up.
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');

		expect(result.verdict).toBe('request-changes');
		expect(result.agent.exitCode).toBe(0);
	});

	it('forwards timeoutMs, signal, and maxOutputBytes to the agent runner', async () => {
		const deps = makeDeps();
		const signal = new AbortController().signal;
		await runReviewPhase({ ...deps, timeoutMs: 60_000, signal });
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
		await runReviewPhase(deps);
		expect(order).toEqual(['graft', 'agent']);
	});

	it('fails before provisioning any worktree when the reviewer token is missing', async () => {
		const deps = makeDeps();
		deps.getToken = vi.fn(async () => {
			throw new Error("No GitHub reviewer token configured for project 'swarm'");
		});
		await expect(runReviewPhase(deps)).rejects.toThrow(/No GitHub reviewer token/);
		expect(deps.worktrees.provision).not.toHaveBeenCalled();
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('cleans up the worktree and never runs the agent when graft throws', async () => {
		const deps = makeDeps();
		deps.graft = vi.fn(() => {
			throw new Error('graft failed: node_modules missing');
		});
		await expect(runReviewPhase(deps)).rejects.toThrow(/graft failed/);
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	it('honours a cli override (e.g. antigravity)', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ cli: 'antigravity' }));
		await runReviewPhase({ ...deps, cli: 'antigravity' });
		expect(deps.runAgent.mock.calls[0][0].cli).toBe('antigravity');
	});

	it('throws and still cleans up when the agent exits non-zero', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));
		await expect(runReviewPhase(deps)).rejects.toThrow(/exited with code 1/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	it('notes the timeout in the error when the agent timed out', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: null, timedOut: true }));
		await expect(runReviewPhase(deps)).rejects.toThrow(/timed out/);
	});

	it('throws and cleans up when the agent produced no verdict file', async () => {
		verdictFileExists = false;
		const deps = makeDeps();
		await expect(runReviewPhase(deps)).rejects.toThrow(
			new RegExp(`did not write ${REVIEW_VERDICT_FILENAME}`),
		);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	it('throws and cleans up when the verdict file is empty', async () => {
		verdictFileContents = '   \n  ';
		const deps = makeDeps();
		await expect(runReviewPhase(deps)).rejects.toThrow(/empty/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	it('throws and cleans up when the verdict is not one of the known three', async () => {
		verdictFileContents = 'LGTM!\n';
		const deps = makeDeps();
		await expect(runReviewPhase(deps)).rejects.toThrow(/unrecognized verdict 'LGTM!'/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	it.each([
		['approve\n', 'approve'],
		['Approve', 'approve'],
		['REQUEST-CHANGES\n', 'request-changes'],
		['comment', 'comment'],
	])('normalizes verdict %j to %j', async (contents, expected) => {
		verdictFileContents = contents;
		const deps = makeDeps();
		const result = await runReviewPhase(deps);
		expect(result.verdict).toBe(expected);
	});

	describe('review-verdict safety-cap ledger (issue #235)', () => {
		it('marks the reserved head submitted with the verdict, by natural key', async () => {
			verdictFileContents = 'approve\n';
			const deps = makeDeps();
			await runReviewPhase(deps);

			expect(deps.markReviewVerdictSubmitted).toHaveBeenCalledWith(
				{
					projectId: deps.project.id,
					repository: deps.project.repo,
					prNumber: '99',
					headSha: HEAD_SHA,
				},
				{ verdict: 'approve' },
			);
			expect(deps.abandonReviewVerdict).not.toHaveBeenCalled();
		});

		it('surfaces the ledger ordinal on the result', async () => {
			verdictFileContents = 'request-changes\n';
			const deps = makeDeps();
			deps.markReviewVerdictSubmitted = vi.fn(async () => ({ id: 'verdict-1', ordinal: 1 }));

			const result = await runReviewPhase(deps);

			expect(result.reviewOrdinal).toBe(1);
			expect(result.automationOutcome).toBeUndefined();
		});

		it('leaves an intermediate request-changes verdict on the automatic cycle', async () => {
			verdictFileContents = 'request-changes\n';
			const deps = makeDeps();
			deps.markReviewVerdictSubmitted = vi.fn(async () => ({ id: 'verdict-2', ordinal: 2 }));

			const result = await runReviewPhase(deps);

			expect(result.reviewOrdinal).toBe(2);
			expect(result.automationOutcome).toBeUndefined();
		});

		it('records manual-intervention-required when the cap-reaching verdict is request-changes', async () => {
			verdictFileContents = 'request-changes\n';
			const deps = makeDeps();
			deps.markReviewVerdictSubmitted = vi.fn(async () => ({
				id: 'verdict-last',
				ordinal: REVIEW_VERDICT_CAP,
			}));

			const result = await runReviewPhase(deps);

			expect(result.reviewOrdinal).toBe(REVIEW_VERDICT_CAP);
			expect(result.automationOutcome).toBe('manual-intervention-required');
		});

		it('does not record manual-intervention-required for a cap-reaching approval', async () => {
			verdictFileContents = 'approve\n';
			const deps = makeDeps();
			deps.markReviewVerdictSubmitted = vi.fn(async () => ({
				id: 'verdict-last',
				ordinal: REVIEW_VERDICT_CAP,
			}));

			const result = await runReviewPhase(deps);

			expect(result.automationOutcome).toBeUndefined();
		});

		it('abandons the reservation when the agent fails before any review was submitted', async () => {
			const deps = makeDeps();
			deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));

			await expect(runReviewPhase(deps)).rejects.toThrow(/exited with code 1/);

			expect(deps.abandonReviewVerdict).toHaveBeenCalledWith({
				projectId: deps.project.id,
				repository: deps.project.repo,
				prNumber: '99',
				headSha: HEAD_SHA,
			});
			expect(deps.markReviewVerdictSubmitted).not.toHaveBeenCalled();
		});

		it('does not fail the run when abandoning the reservation itself throws', async () => {
			const deps = makeDeps();
			deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));
			deps.abandonReviewVerdict = vi.fn(async () => {
				throw new Error('connection reset');
			});

			await expect(runReviewPhase(deps)).rejects.toThrow(/exited with code 1/);
		});
	});

	describe('re-review scoping (issue #328)', () => {
		const priorRequestChanges: ReviewVerdictRecord = {
			ordinal: 1,
			state: 'submitted',
			verdict: 'request-changes',
			headSha: 'oldsha0000000000000000000000000000000000',
		};

		it('looks up the prior submitted review by PR at the current head', async () => {
			const deps = makeDeps();
			await runReviewPhase(deps);
			expect(deps.getPriorSubmittedReview).toHaveBeenCalledWith(
				deps.project.id,
				deps.project.repo,
				'99',
				HEAD_SHA,
			);
		});

		it('gives the agent the scoped re-review prompt after a prior request-changes verdict', async () => {
			const deps = makeDeps();
			deps.getPriorSubmittedReview = vi.fn(async () => priorRequestChanges);

			await runReviewPhase(deps);

			const prompt = deps.runAgent.mock.calls[0][0].args?.[0] ?? '';
			expect(prompt).toContain('This is a RE-REVIEW');
			expect(prompt).toContain('STAY IN SCOPE');
			// The full-review-only instruction must not appear on a re-review.
			expect(prompt).not.toContain('Review ALL changed files');
		});

		it('gives the agent the full-review prompt when there is no prior review', async () => {
			const deps = makeDeps();
			// makeDeps() defaults getPriorSubmittedReview to undefined (first review).
			await runReviewPhase(deps);

			const prompt = deps.runAgent.mock.calls[0][0].args?.[0] ?? '';
			expect(prompt).toContain('Review ALL changed files');
			expect(prompt).not.toContain('This is a RE-REVIEW');
		});

		it('treats a prior approval/comment as not-a-re-review (full-review prompt)', async () => {
			const deps = makeDeps();
			deps.getPriorSubmittedReview = vi.fn(async () => ({
				...priorRequestChanges,
				verdict: 'comment',
			}));

			await runReviewPhase(deps);

			const prompt = deps.runAgent.mock.calls[0][0].args?.[0] ?? '';
			expect(prompt).toContain('Review ALL changed files');
			expect(prompt).not.toContain('This is a RE-REVIEW');
		});
	});
});

describe('buildReviewPrompt', () => {
	const context = { repo: 'jkwiecien/swarm', prNumber: '99', headSha: HEAD_SHA };

	it('instructs reading the PR, the full diff, submitting one formal review, and recording the verdict', () => {
		const prompt = buildReviewPrompt(context);
		expect(prompt).toContain('gh pr view 99 --repo jkwiecien/swarm --comments');
		expect(prompt).toContain('gh pr diff 99 --repo jkwiecien/swarm');
		expect(prompt).toContain('gh pr review 99 --repo jkwiecien/swarm');
		expect(prompt).toContain('--approve');
		expect(prompt).toContain('--request-changes');
		expect(prompt).toContain('--comment');
		expect(prompt).toContain(REVIEW_VERDICT_FILENAME);
		expect(prompt).toContain('Confirm README.md remains accurate for the changes in this PR.');
		expect(prompt).toContain('report the missing README update as a review finding');
		expect(prompt).toContain('For every notable issue, provide an actionable proposed fix plan.');
		expect(prompt).toContain('findings [{title,body,fixPlan}]');
		expect(prompt).toContain(
			"The final review body must also include each finding's evidence, impact, and proposed fix plan",
		);
	});

	it('pins the review to the head SHA and forbids modifying the repository', () => {
		const prompt = buildReviewPrompt(context);
		expect(prompt).toContain(HEAD_SHA);
		expect(prompt).toContain('REVIEW ONLY');
		expect(prompt).toContain('Do NOT invoke the `solve-issue` skill');
		expect(prompt).toMatch(/Do NOT `git add`\/commit/);
		expect(prompt).toContain('Do not merge the PR');
	});

	it('keeps blocked optional experiments from aborting the review hand-off', () => {
		const prompt = buildReviewPrompt(context);
		expect(prompt).toContain('Do not create disposable repositories');
		expect(prompt).toContain('never run destructive cleanup commands such as `rm -rf`');
		expect(prompt).toContain('still write the required hand-off file');
	});

	it('carries the GH identity guard so the reviewer persona token is not overridden', () => {
		const prompt = buildReviewPrompt(context);
		expect(prompt).toContain('GH_TOKEN');
		expect(prompt).toContain('gh auth switch');
	});

	it('requires a proposed fix plan on every structured finding', () => {
		const withoutPlan = ReviewHandoffSchema.safeParse({
			verdict: 'request-changes',
			body: 'A notable issue exists.',
			findings: [{ title: 'Issue', body: 'Evidence and impact.' }],
		});
		const withPlan = ReviewHandoffSchema.safeParse({
			verdict: 'request-changes',
			body: 'A notable issue exists. Proposed fix plan: update the handler and add a regression test.',
			findings: [
				{
					title: 'Issue',
					body: 'Evidence and impact.',
					fixPlan: 'Update the handler and add a regression test.',
				},
			],
		});

		expect(withoutPlan.success).toBe(false);
		expect(withPlan.success).toBe(true);
	});

	describe('re-review variant (issue #328)', () => {
		it('scopes the re-review to verifying previously requested changes and forbids new findings', () => {
			const prompt = buildReviewPrompt(context, undefined, true);
			expect(prompt).toContain('This is a RE-REVIEW');
			expect(prompt).toContain('verify that the previously requested changes were');
			expect(prompt).toContain('STAY IN SCOPE');
			expect(prompt).toContain('Do NOT raise new findings for pre-existing issues');
			// Approve-when-fixed / otherwise-request-changes-with-a-strong-fix framing.
			expect(prompt).toContain('use verdict approve');
			expect(prompt).toContain('strong, specific, actionable instruction on exactly how to fix it');
		});

		it('keeps the shared review contract (read-only, no gh mutation, hand-off, no merge)', () => {
			const prompt = buildReviewPrompt(context, undefined, true);
			expect(prompt).toContain('REVIEW ONLY');
			expect(prompt).toContain(HEAD_SHA);
			expect(prompt).toContain(`gh pr view 99 --repo jkwiecien/swarm --comments`);
			expect(prompt).toContain(`gh pr review 99 --repo jkwiecien/swarm`);
			expect(prompt).toContain(REVIEW_VERDICT_FILENAME);
			expect(prompt).toContain('Do not merge the PR');
			expect(prompt).toContain('GH_TOKEN');
		});

		it('omits the full-review-only instructions a re-review must not follow', () => {
			const prompt = buildReviewPrompt(context, undefined, true);
			expect(prompt).not.toContain('Review ALL changed files');
			expect(prompt).not.toContain('Include every notable issue in findings');
		});

		it('defaults to the full initial-review prompt when isReReview is unset', () => {
			expect(buildReviewPrompt(context)).not.toContain('This is a RE-REVIEW');
			expect(buildReviewPrompt(context, undefined, false)).not.toContain('This is a RE-REVIEW');
		});
	});
});
