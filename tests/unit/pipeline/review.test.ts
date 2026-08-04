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
import { buildReviewHandoffRepairPrompt } from '@/pipeline/prompts/review.js';
import { buildReviewPrompt, REVIEW_VERDICT_FILENAME, runReviewPhase } from '@/pipeline/review.js';
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

	it('throws and cleans up when the verdict is not one of the known two', async () => {
		verdictFileContents = 'LGTM!\n';
		const deps = makeDeps();
		await expect(runReviewPhase(deps)).rejects.toThrow(/unrecognized verdict 'LGTM!'/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	// `comment` was removed as a verdict (issue #470): it cleared no review gate and
	// dispatched no follow-up, so a PR that received one was silently terminal. It
	// must now fail the run — which retries — rather than be accepted.
	it('rejects the removed comment verdict instead of submitting it', async () => {
		verdictFileContents = 'comment\n';
		const deps = makeDeps();
		await expect(runReviewPhase(deps)).rejects.toThrow(/unrecognized verdict 'comment'/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	it.each([
		['approve\n', 'approve'],
		['Approve', 'approve'],
		['REQUEST-CHANGES\n', 'request-changes'],
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
	const context = { repo: 'SmartTechBrewery/swarm', prNumber: '99', headSha: HEAD_SHA };

	it('instructs reading the PR, the full diff, and recording the verdict in the hand-off', () => {
		const prompt = buildReviewPrompt(context);
		expect(prompt).toContain('gh pr view 99 --repo SmartTechBrewery/swarm --comments');
		expect(prompt).toContain('gh pr diff 99 --repo SmartTechBrewery/swarm');
		expect(prompt).toContain('gh pr review 99 --repo SmartTechBrewery/swarm');
		expect(prompt).toContain('--approve');
		expect(prompt).toContain('--request-changes');
		expect(prompt).toContain('--comment');
		expect(prompt).toContain(REVIEW_VERDICT_FILENAME);
		expect(prompt).toContain('Judge every documentation file this repo requires to stay current');
		expect(prompt).toContain('`docsChecked`');
	});

	// The prompt specifies content, not layout (issue #470): SWARM renders the body
	// from the hand-off's fields, so an instruction describing the review's *shape*
	// is a second source of truth that will drift from the renderer.
	it('asks for hand-off fields and never for an authored review body', () => {
		const prompt = buildReviewPrompt(context);
		expect(prompt).toContain('SWARM renders the review from them');
		expect(prompt).toContain('anything you format yourself is discarded');
		expect(prompt).not.toContain('The final review body');
		expect(prompt).not.toContain('findings [{title,body,fixPlan}]');
	});

	it('states the severity rubric and that the verdict follows from it', () => {
		const prompt = buildReviewPrompt(context);
		for (const severity of ['`blocker`', '`major`', '`minor`', '`nit`'])
			expect(prompt).toContain(severity);
		expect(prompt).toContain('`blocker` and `major` block the PR');
		expect(prompt).toContain('any `blocker`/`major` means `request-changes`');
	});

	// The Review phase runs against every project SWARM manages, so the prompt must
	// ask for documentation by its role in the repository rather than naming this
	// one's layout — `docs/status.md` does not exist in someone else's repo.
	it('asks for docs by role, never by SWARM’s own paths', () => {
		const prompt = buildReviewPrompt(context);
		expect(prompt).toContain('one entry per document THIS repository requires to stay current');
		expect(prompt).toContain('its own contributor/agent guide');
		for (const path of ['docs/configuration.md', 'docs/status.md', 'ai/*.md'])
			expect(prompt).not.toContain(path);
	});

	it('offers no comment-only verdict and tells the agent to fail instead', () => {
		const prompt = buildReviewPrompt(context);
		expect(prompt).toContain('`verdict`: `approve` or `request-changes`. Those are the only two.');
		expect(prompt).toContain('There is no comment-only or no-opinion verdict');
		expect(prompt).toContain('stop and fail rather than submitting a verdict you cannot support');
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

	describe('re-review variant (issue #328)', () => {
		it('scopes the re-review to verifying previously requested changes and forbids new findings', () => {
			const prompt = buildReviewPrompt(context, undefined, true);
			expect(prompt).toContain('This is a RE-REVIEW');
			expect(prompt).toContain('verify that the previously requested changes were');
			expect(prompt).toContain('STAY IN SCOPE');
			expect(prompt).toContain('Do NOT raise new findings for pre-existing issues');
		});

		// Finding ids are how a re-review's disposition table, and the
		// respond-to-review flow, track one item across passes (issue #470).
		it('requires the previous pass’s finding ids to be reused in `carried`', () => {
			const prompt = buildReviewPrompt(context, undefined, true);
			expect(prompt).toContain('`carried`');
			expect(prompt).toContain("Reuse the previous review's finding ids");
			// A re-reported item keeps its id rather than being minted a new one —
			// otherwise the disposition table and the findings section name the same
			// defect twice, and the id stops tracking anything across passes.
			expect(prompt).toContain("Re-reporting an item from `carried` KEEPS that item's original id");
			expect(prompt).toContain('continuing past the highest id the previous review used');
			// The schema enforces the other half: an unresolved item must be there.
			expect(prompt).toContain('Every entry that is NOT `resolved` must also appear in `findings`');
			// The initial pass has nothing to carry, so it must not be asked to.
			expect(buildReviewPrompt(context)).not.toContain('`carried`');
		});

		it('keeps the shared review contract (read-only, no gh mutation, hand-off, no merge)', () => {
			const prompt = buildReviewPrompt(context, undefined, true);
			expect(prompt).toContain('REVIEW ONLY');
			expect(prompt).toContain(HEAD_SHA);
			expect(prompt).toContain(`gh pr view 99 --repo SmartTechBrewery/swarm --comments`);
			expect(prompt).toContain(`gh pr review 99 --repo SmartTechBrewery/swarm`);
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

/**
 * The repair prompt is the only feedback path the hand-off schema's enforcement
 * has — the agent otherwise never learns why its hand-off was rejected.
 */
describe('buildReviewHandoffRepairPrompt', () => {
	it('carries the validator’s complaint and the contract to satisfy', () => {
		const prompt = buildReviewHandoffRepairPrompt('F1 is nit, so fixPlan must be omitted');
		expect(prompt).toContain('F1 is nit, so fixPlan must be omitted');
		expect(prompt).toContain(REVIEW_VERDICT_FILENAME);
		expect(prompt).toContain('SEVERITY — pick from exactly these four');
		expect(prompt).toContain('`verdict`: `approve` or `request-changes`');
	});

	// A repair that quietly re-judged the PR to satisfy a slot rule would be worse
	// than the failure it replaces.
	it('scopes itself to reformatting, and keeps the read-only guard', () => {
		const prompt = buildReviewHandoffRepairPrompt('verification: Array must contain at least 1');
		expect(prompt).toContain('this is a formatting repair, not a re-review');
		expect(prompt).toContain('Keep your findings, your severities, and your verdict as they are');
		expect(prompt).toContain('REVIEW ONLY');
		expect(prompt).toContain('do not submit a review or perform any GitHub mutation');
	});

	it('asks a re-review to repair its `carried` list too', () => {
		expect(buildReviewHandoffRepairPrompt('x', true)).toContain('`carried`');
		expect(buildReviewHandoffRepairPrompt('x')).not.toContain('`carried`');
	});
});
