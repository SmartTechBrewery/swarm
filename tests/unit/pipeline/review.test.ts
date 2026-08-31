import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	REVIEW_VERDICT_CAP,
	type ReviewVerdictRecord,
} from '@/db/repositories/reviewVerdictsRepository.js';
import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import { buildReviewHandoffRepairPrompt } from '@/pipeline/prompts/review.js';
import { buildReviewPrompt, REVIEW_VERDICT_FILENAME, runReviewPhase } from '@/pipeline/review.js';
import {
	ReviewFindingSchema,
	ReviewHandoffSchema,
	type ScmDeliveryProvider,
} from '@/scm/delivery.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const HEAD_SHA = 'abc1234def5678abc1234def5678abc1234def56';

/**
 * The repository the run recorded (issue #692) — distinct from
 * `createMockProjectConfig()`'s own `repo`, so an assertion on it fails if the
 * phase falls back to reading the project config.
 */
const RUN_REPOSITORY = 'SmartTechBrewery/run-repo';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The one blocking finding a `request-changes` hand-off must carry (issue #470). */
const BLOCKING_FINDING = {
	id: 'F1',
	title: 'Unhandled rejection',
	severity: 'blocker',
	category: 'correctness',
	evidence: '`review.ts:210`.',
	failureScenario: 'A rejected promise crashes the worker mid-phase.',
	impact: 'The run never settles.',
	fixPlan: ['Await the promise.'],
	tests: ['Assert the rejection is handled.'],
};

/** A valid structured hand-off; `overrides` merge over a `request-changes` default. */
function handoff(overrides: Record<string, unknown> = {}) {
	return {
		verdict: 'request-changes',
		summary: 'Adds the review phase.',
		verification: [{ command: 'npm run typecheck', outcome: 'passed' }],
		docsChecked: [{ path: 'README.md', status: 'not-applicable' }],
		findings: [BLOCKING_FINDING],
		...overrides,
	};
}

/** The `approve` counterpart — no findings, so the verdict rule is satisfied. */
function approval(overrides: Record<string, unknown> = {}) {
	return handoff({ verdict: 'approve', findings: [], ...overrides });
}

function writeHandoff(path: string, contents: unknown): void {
	writeFileSync(
		join(path, REVIEW_VERDICT_FILENAME),
		typeof contents === 'string' ? contents : JSON.stringify(contents),
	);
}

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
	// A real checkout directory: the phase reads the agent's hand-off and writes its
	// own delivery-progress sidecar there.
	const path = mkdtempSync(join(tmpdir(), 'swarm-review-'));
	roots.push(path);
	writeHandoff(path, handoff());
	// Detached checkout at the PR head SHA — no branch, matching the review flow.
	const handle: WorktreeHandle = {
		taskId: 'review-20',
		path,
		branch: HEAD_SHA,
		detached: true,
	};
	const worktrees = {
		provision: vi.fn(async () => handle),
		worktreePath: vi.fn(() => handle.path),
		cleanup: vi.fn(async () => {}),
	};
	return {
		path,
		project: createMockProjectConfig(),
		// Deliberately *not* `project.repo`: the phase is fed the repository its run
		// recorded, so every assertion below expecting this value is what proves the
		// ledger key and the prompt are no longer project-derived (issue #692).
		repository: RUN_REPOSITORY,
		prNumber: '99',
		headSha: HEAD_SHA,
		taskId: 'review-20',
		worktrees: worktrees as unknown as GitWorktreeManager,
		runAgent: vi.fn<(opts: RunAgentCliOptions) => Promise<AgentCliResult>>(async () =>
			agentResult(),
		),
		graft: vi.fn(() => []),
		getToken: vi.fn(async () => 'reviewer-token'),
		// SWARM submits the review itself; production resolves the project's own
		// registered provider here.
		delivery: {
			commitIdentity: { name: 'reviewer', email: 'reviewer@users.noreply.github.com' },
			findPullRequest: vi.fn(async () => undefined),
			createPullRequest: vi.fn(async () => ({ number: 99, url: 'https://x/pull/99' })),
			pushBranch: vi.fn(async () => {}),
			submitReview: vi.fn(
				async (_input: {
					prNumber: number;
					verdict: 'approve' | 'request-changes';
					body: string;
					deliveryId: string;
				}) => 77,
			),
			postComment: vi.fn(async () => 1),
		} satisfies ScmDeliveryProvider,
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
	it('provisions a detached worktree at the head SHA, runs Claude Code as the reviewer, and submits the verdict', async () => {
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
		expect(runArgs.cwd).toBe(deps.path);
		// The prompt names the repository the run recorded, not the project's own.
		expect(runArgs.args?.[0]).toContain(`gh pr diff 99 --repo ${RUN_REPOSITORY}`);
		expect(runArgs.env).toEqual({ GH_TOKEN: 'reviewer-token' });

		// Env is grafted into the worktree before the agent runs.
		expect(deps.graft).toHaveBeenCalledWith(deps.project.repoRoot, deps.path);

		// SWARM — not the agent — submits the review, under the hand-off's verdict.
		expect(deps.delivery.submitReview).toHaveBeenCalledTimes(1);
		expect(deps.delivery.submitReview.mock.calls[0][0]).toMatchObject({
			prNumber: 99,
			verdict: 'request-changes',
		});

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

	it('throws and cleans up when the agent wrote no hand-off', async () => {
		const deps = makeDeps();
		rmSync(join(deps.path, REVIEW_VERDICT_FILENAME));
		await expect(runReviewPhase(deps)).rejects.toThrow(
			new RegExp(`did not write required hand-off ${REVIEW_VERDICT_FILENAME}`),
		);
		expect(deps.delivery.submitReview).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	it('throws and cleans up when the hand-off is not valid JSON', async () => {
		const deps = makeDeps();
		writeHandoff(deps.path, '   \n  ');
		await expect(runReviewPhase(deps)).rejects.toThrow(
			new RegExp(`Invalid hand-off ${REVIEW_VERDICT_FILENAME}`),
		);
		expect(deps.delivery.submitReview).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	it('throws and cleans up when the verdict is not one of the known two', async () => {
		const deps = makeDeps();
		writeHandoff(deps.path, handoff({ verdict: 'LGTM!' }));
		await expect(runReviewPhase(deps)).rejects.toThrow(
			new RegExp(`Invalid hand-off ${REVIEW_VERDICT_FILENAME}`),
		);
		expect(deps.delivery.submitReview).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	// `comment` was removed as a verdict (issue #470): it cleared no review gate and
	// dispatched no follow-up, so a PR that received one was silently terminal. It
	// must now fail the run — which retries — rather than be accepted.
	it('rejects the removed comment verdict instead of submitting it', async () => {
		const deps = makeDeps();
		writeHandoff(deps.path, handoff({ verdict: 'comment' }));
		await expect(runReviewPhase(deps)).rejects.toThrow(
			new RegExp(`Invalid hand-off ${REVIEW_VERDICT_FILENAME}`),
		);
		expect(deps.delivery.submitReview).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('review-20');
	});

	// The verdict is a function of the severity histogram, enforced rather than
	// instructed (issue #470) — an approval that still reports a blocker is rejected.
	it('rejects an approval whose findings include a blocker', async () => {
		const deps = makeDeps();
		writeHandoff(deps.path, handoff({ verdict: 'approve' }));
		await expect(runReviewPhase(deps)).rejects.toThrow(
			new RegExp(`Invalid hand-off ${REVIEW_VERDICT_FILENAME}`),
		);
		expect(deps.delivery.submitReview).not.toHaveBeenCalled();
	});

	it.each([
		['approve', approval()],
		['request-changes', handoff()],
	])('returns and submits the %j verdict the hand-off carries', async (expected, contents) => {
		const deps = makeDeps();
		writeHandoff(deps.path, contents);
		const result = await runReviewPhase(deps);
		expect(result.verdict).toBe(expected);
		expect(deps.delivery.submitReview.mock.calls[0][0].verdict).toBe(expected);
	});

	describe('review-verdict safety-cap ledger (issue #235)', () => {
		it('marks the reserved head submitted with the verdict, by natural key', async () => {
			const deps = makeDeps();
			writeHandoff(deps.path, approval());
			await runReviewPhase(deps);

			expect(deps.markReviewVerdictSubmitted).toHaveBeenCalledWith(
				{
					projectId: deps.project.id,
					// The run's own repository, not the project's (issue #692).
					repository: RUN_REPOSITORY,
					prNumber: '99',
					headSha: HEAD_SHA,
				},
				// Marked only after delivery confirmed the review id.
				{ verdict: 'approve', reviewId: '77' },
			);
			expect(deps.abandonReviewVerdict).not.toHaveBeenCalled();
		});

		it('surfaces the ledger ordinal on the result', async () => {
			const deps = makeDeps();
			deps.markReviewVerdictSubmitted = vi.fn(async () => ({ id: 'verdict-1', ordinal: 1 }));

			const result = await runReviewPhase(deps);

			expect(result.reviewOrdinal).toBe(1);
			expect(result.automationOutcome).toBeUndefined();
		});

		it('leaves an intermediate request-changes verdict on the automatic cycle', async () => {
			const deps = makeDeps();
			deps.markReviewVerdictSubmitted = vi.fn(async () => ({ id: 'verdict-2', ordinal: 2 }));

			const result = await runReviewPhase(deps);

			expect(result.reviewOrdinal).toBe(2);
			expect(result.automationOutcome).toBeUndefined();
		});

		it('records manual-intervention-required when the cap-reaching verdict is request-changes', async () => {
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
			const deps = makeDeps();
			writeHandoff(deps.path, approval());
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
				repository: RUN_REPOSITORY,
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

		it('looks up the prior submitted review by PR at the current head, in the run’s repository', async () => {
			const deps = makeDeps();
			await runReviewPhase(deps);
			expect(deps.getPriorSubmittedReview).toHaveBeenCalledWith(
				deps.project.id,
				RUN_REPOSITORY,
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
		expect(prompt).toContain('one per document THIS repository requires to stay current');
		expect(prompt).toContain('its own contributor/agent guide');
		for (const path of ['docs/configuration.md', 'docs/status.md', 'ai/*.md'])
			expect(prompt).not.toContain(path);
	});

	it('offers no comment-only verdict and tells the agent to fail instead', () => {
		const prompt = buildReviewPrompt(context);
		expect(prompt).toContain(
			'`verdict`: a string, `approve` or `request-changes`. Those are the only two.',
		);
		expect(prompt).toContain('There is no comment-only or no-opinion verdict');
		expect(prompt).toContain('stop and fail rather than submitting a verdict you cannot support');
	});

	// Issue #861: `fixPlan` said "an array" and `tests`, one clause later and in the
	// same tier, said nothing but showed a bare string in its example — so a model
	// continued the array pattern and the whole review was discarded. The two now
	// agree, and the example points the same way as the type.
	it('states `tests` as an array, like the `fixPlan` beside it', () => {
		const prompt = buildReviewPrompt(context);
		expect(prompt).toContain('`fixPlan` (an array of strings, one per step');
		expect(prompt).toContain('`tests` (an array of strings, one per test to add or change');
		expect(prompt).toContain('`["None — doc-only."]` is a valid answer');
		expect(prompt).not.toContain('`"None — doc-only."` is a valid answer');
		// The general rule the per-slot types hang off.
		expect(prompt).toContain('Every field below states its JSON type');
	});

	// `title` was named in the finding's field list and described nowhere.
	it('describes `title`, which the field list only ever named', () => {
		expect(buildReviewPrompt(context)).toContain(
			'`title`: a single string — one short line naming the defect',
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

	/**
	 * Issue #861 as a standing rule rather than a one-off audit: a slot whose type
	 * the prompt leaves implicit is a slot a model guesses at, and `tests` cost a
	 * complete review that way. The names come from the schemas, so a slot added
	 * there fails this until the prompt says what shape it wants.
	 */
	describe('every hand-off slot’s JSON type is stated', () => {
		/** From the severity rubric to the end: the rubric plus the field contract. */
		function contractRegion(prompt: string): string {
			const at = prompt.indexOf('SEVERITY —');
			expect(at).toBeGreaterThan(-1);
			return prompt.slice(at);
		}

		/**
		 * Whether a JSON type is named in a clause that *introduces* the slot —
		 * ``​`slot`: …``, ``​`slot` (…``, ``​`slot` — …`` or ``​`slot`, …`` — and on that
		 * same line. A bare mention in another slot's prose (`docsChecked` ends by
		 * pointing at `findings`) must not count, or the audit passes on a type the
		 * neighbouring bullet happened to state.
		 */
		function statesType(region: string, slot: string): boolean {
			const introduces = new RegExp(`\`${slot}\`(: | \\(| — |, )`);
			return region.split('\n').some((line) => {
				const at = line.search(introduces);
				return (
					at !== -1 &&
					/\ba (single )?string\b|\bare strings\b|\ban array\b/.test(line.slice(at, at + 80))
				);
			});
		}

		// `severity` has no bullet in the field contract at all — its whole
		// description is the rubric, which the next test holds to the same standard.
		// Everything else must state its type where it is introduced.
		const DESCRIBED_ELSEWHERE = new Set(['severity']);
		const SLOTS = [
			...Object.keys(ReviewHandoffSchema.innerType().shape),
			...Object.keys(ReviewFindingSchema.shape),
		].filter((slot) => !DESCRIBED_ELSEWHERE.has(slot));

		it.each(SLOTS)('states the JSON type of `%s`', (slot) => {
			expect(statesType(contractRegion(buildReviewPrompt(context, undefined, true)), slot)).toBe(
				true,
			);
		});

		it('states `severity`’s type in the rubric that actually describes it', () => {
			expect(buildReviewPrompt(context)).toContain(
				'`severity` is a string, exactly one of these four',
			);
		});

		// An initial pass has nothing to carry, so `carried` is deliberately absent
		// from it — every other slot is still typed. This is also what pins the
		// finding's own `id`/`title` bullets: in the re-review prompt above, the
		// `carried` bullet types those two names as well.
		it('covers every slot but `carried` on an initial review', () => {
			const region = contractRegion(buildReviewPrompt(context));
			for (const slot of SLOTS)
				expect({ slot, typed: statesType(region, slot) }).toEqual({
					slot,
					typed: slot !== 'carried',
				});
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
		expect(prompt).toContain('SEVERITY — `severity` is a string, exactly one of these four');
		expect(prompt).toContain('`verdict`: a string, `approve` or `request-changes`');
	});

	// A repair that quietly re-judged the PR to satisfy a slot rule would be worse
	// than the failure it replaces.
	it('scopes itself to reformatting, and keeps the read-only guard', () => {
		const prompt = buildReviewHandoffRepairPrompt('verification: Array must contain at least 1');
		expect(prompt).toContain('this is a formatting repair, not a re-review');
		expect(prompt).toContain(
			'Keep the findings, the severities, and the verdict it already records as they are',
		);
		expect(prompt).toContain('REVIEW ONLY');
		expect(prompt).toContain('do not submit a review or perform any GitHub mutation');
	});

	// Issue #865 made the pass reachable in a *fresh* session on a self-minting CLI,
	// so this prompt can no longer lean on the review prompt having been said first:
	// it must carry both guards, and point at the hand-off on disk rather than at
	// what the agent remembers.
	it('stands alone for a fresh session: both guards, and the hand-off read off disk', () => {
		const prompt = buildReviewHandoffRepairPrompt('summary: Required');
		expect(prompt).toContain('You are a SWARM pipeline agent assigned to exactly one phase');
		expect(prompt).toContain('Do NOT run `gh auth login`, `gh auth switch`, or `gh auth logout`');
		expect(prompt).toContain(
			`Read "${REVIEW_VERDICT_FILENAME}" first — it holds the findings, severities and verdict this pass must preserve`,
		);
		expect(prompt).not.toContain('as before');
	});

	it('asks a re-review to repair its `carried` list too', () => {
		expect(buildReviewHandoffRepairPrompt('x', true)).toContain('`carried`');
		expect(buildReviewHandoffRepairPrompt('x')).not.toContain('`carried`');
	});
});
