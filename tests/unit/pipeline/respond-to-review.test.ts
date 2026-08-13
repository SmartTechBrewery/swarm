import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A checkpoint continuation's gate verdict. The gate itself (validation, lease
// release, blocked reasons) is covered in `resume.test.ts` against real fixtures;
// here it is stubbed so this file can assert what the *phase* does with it.
const { acquireResumableWorktreeMock } = vi.hoisted(() => ({
	acquireResumableWorktreeMock: vi.fn(),
}));
vi.mock('@/pipeline/resume.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/pipeline/resume.js')>();
	// Delegates by default, so every existing test keeps the real acquisition path.
	acquireResumableWorktreeMock.mockImplementation(actual.acquireResumableWorktree);
	return { ...actual, acquireResumableWorktree: acquireResumableWorktreeMock };
});

import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import type { Checkpoint } from '@/pipeline/checkpoint.js';
import type { FollowUpReviewInput } from '@/pipeline/follow-up-review.js';
import {
	buildRespondToReviewPrompt,
	issueNumberFromBranch,
	RESPOND_OUTCOME_FILENAME,
	resolvePushedHeadSha,
	runRespondToReviewPhase,
} from '@/pipeline/respond-to-review.js';
import type { DeliveryProgress, ScmDeliveryProvider } from '@/scm/delivery.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { createMockProjectConfig, createMockWorkItem } from '../../helpers/factories.js';

const PR_BRANCH = 'issue-21';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const testGitEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

/**
 * A minimal real git repo — deterministic delivery's `commitPreparedTree` shells
 * out to `git` (`src/scm/delivery.ts`), so a `fixed` outcome needs an actual
 * checkout with an uncommitted change to deliver.
 */
function initGitRepo(path: string): void {
	const git = (...args: string[]) =>
		execFileSync('git', args, { cwd: path, env: testGitEnvironment });
	git('init', '-q');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'Test');
	writeFileSync(join(path, 'README.md'), 'initial\n');
	git('add', '.');
	git('commit', '-q', '--no-verify', '-m', 'initial commit');
	writeFileSync(join(path, 'fix.txt'), 'addressed the review\n');
}

/** The hand-off a response run leaves behind; `overrides` merge over a `fixed` default. */
function responseHandoff(overrides: Record<string, unknown> = {}) {
	return {
		outcome: 'fixed',
		body: 'Addressed the review point by point.',
		commitSubject: 'fix: address review feedback',
		verification: [{ command: 'npm test', outcome: 'passed' }],
		...overrides,
	};
}

/**
 * The hand-off for any of the three outcomes: only `fixed` carries a commit, so
 * the other two must report neither a subject nor verification.
 */
function nonFixedHandoff(outcome: string) {
	return outcome === 'fixed'
		? responseHandoff()
		: responseHandoff({ outcome, commitSubject: undefined, verification: [] });
}

function writeHandoff(path: string, contents: unknown): void {
	writeFileSync(
		join(path, RESPOND_OUTCOME_FILENAME),
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

/** What an involuntarily stopped run of this phase left behind. */
const CONTINUATION: Checkpoint = {
	phase: 'respond-to-review',
	completed: ['Read the review and fixed the first finding'],
	remaining: ['Address the second finding', 'Re-run the focused tests'],
	decisions: [],
	workingTree: { modified: ['src/pipeline/review.ts'], added: [], deleted: [] },
};

function makeDeps() {
	const path = mkdtempSync(join(tmpdir(), 'swarm-respond-review-'));
	roots.push(path);
	initGitRepo(path);
	writeHandoff(path, responseHandoff());
	// The PR's existing task branch — not detached, SWARM pushes fixes here.
	const handle: WorktreeHandle = {
		taskId: 'respond-21',
		path,
		branch: PR_BRANCH,
		detached: false,
	};
	const worktrees = {
		provision: vi.fn(async () => handle),
		worktreePath: vi.fn(() => handle.path),
		cleanup: vi.fn(async () => {}),
	};
	return {
		path,
		project: createMockProjectConfig(),
		prNumber: '99',
		prBranch: PR_BRANCH,
		reviewId: '4242',
		headSha: 'reviewedsha0000000000000000000000000000',
		taskId: 'respond-21',
		worktrees: worktrees as unknown as GitWorktreeManager,
		runAgent: vi.fn<(opts: RunAgentCliOptions) => Promise<AgentCliResult>>(async () =>
			agentResult(),
		),
		graft: vi.fn(() => []),
		getToken: vi.fn(async () => 'implementer-token'),
		// SWARM pushes the fix and posts the reply; production resolves the project's
		// own registered provider here.
		delivery: {
			commitIdentity: { name: 'implementer', email: 'implementer@users.noreply.github.com' },
			findPullRequest: vi.fn(async () => undefined),
			createPullRequest: vi.fn(async () => ({ number: 99, url: 'https://x/pull/99' })),
			pushBranch: vi.fn(async (_cwd: string, _branch: string, _expectedSha: string) => {}),
			submitReview: vi.fn(async () => 0),
			postComment: vi.fn(
				async (_input: { prNumber: number; body: string; deliveryId: string }) => 7,
			),
		} satisfies ScmDeliveryProvider,
		// The follow-up Review a pushed fix owes (issue #241). Injected so no test
		// reaches the real dispatch-row write and queue enqueue.
		scheduleFollowUpReview: vi.fn<(input: FollowUpReviewInput) => Promise<void>>(
			async () => undefined,
		),
	};
}

describe('runRespondToReviewPhase', () => {
	it('provisions a worktree on the PR branch, runs Claude Code as the implementer, and delivers the response', async () => {
		const deps = makeDeps();
		const result = await runRespondToReviewPhase(deps);

		// Implementer credentials, same reason as Implementation/Review.
		expect(deps.getToken).toHaveBeenCalledWith(deps.project, 'implementer');

		// The existing task branch, not a fresh cut and not detached — SWARM commits
		// and pushes to the PR from here.
		expect(deps.worktrees.provision).toHaveBeenCalledWith('respond-21', {
			createBranch: false,
			branch: PR_BRANCH,
		});

		// Claude Code runs with the worktree as CWD, the respond prompt, and the
		// implementer token in GH_TOKEN so its gh reads act as that persona rather
		// than the worker host's own gh auth login.
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		const runArgs = deps.runAgent.mock.calls[0][0];
		expect(runArgs.cli).toBe('claude');
		expect(runArgs.cwd).toBe(deps.path);
		expect(runArgs.args?.[0]).toContain('reviews/4242');
		expect(runArgs.env).toEqual({ GH_TOKEN: 'implementer-token' });

		// Env is grafted into the worktree before the agent runs.
		expect(deps.graft).toHaveBeenCalledWith(deps.project.repoRoot, deps.path);

		// SWARM — not the agent — pushes the fix commit and posts the reply.
		expect(deps.delivery.pushBranch).toHaveBeenCalledTimes(1);
		expect(deps.delivery.pushBranch.mock.calls[0][1]).toBe(PR_BRANCH);
		expect(deps.delivery.postComment).toHaveBeenCalledTimes(1);
		expect(deps.delivery.postComment.mock.calls[0][0]).toMatchObject({
			prNumber: 99,
			body: 'Addressed the review point by point.',
		});

		// Worktree is always cleaned up.
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-21');

		expect(result.outcome).toBe('fixed');
		expect(result.agent.exitCode).toBe(0);
	});

	it('continues from a checkpoint on a fresh session, on a different CLI (issue #502)', async () => {
		const deps = makeDeps();
		acquireResumableWorktreeMock.mockResolvedValueOnce({
			handle: { taskId: 'respond-21', path: deps.path, branch: PR_BRANCH, detached: false },
			resumed: false,
			deliveryResumed: false,
			checkpoint: CONTINUATION,
		});

		await runRespondToReviewPhase({
			...deps,
			// The stopped run captured 'prior-21' on claude; this continuation carries
			// no session, so it may run on any engine.
			cli: 'codex',
			sessionId: 'fresh-21',
			resumeSessionId: 'prior-21',
			recoveryMode: 'checkpoint',
		});

		// The mode and this phase's own name reached the recovery gate.
		expect(acquireResumableWorktreeMock).toHaveBeenCalledWith(
			expect.anything(),
			'respond-21',
			'respond-to-review',
			PR_BRANCH,
			false,
			'prior-21',
			expect.any(Function),
			false,
			'checkpoint',
			// The run id the start-over warning names when a continuation is lost
			// (issue #591); this case has none.
			undefined,
		);

		const runArgs = deps.runAgent.mock.calls[0][0];
		// A fresh session and no resume id, despite `resumeSessionId` being known.
		expect(runArgs.sessionId).toBe('fresh-21');
		expect(runArgs.resumeSessionId).toBeUndefined();
		// The prompt carries the recorded remainder instead of the CLI's own context.
		expect(runArgs.args?.[0]).toContain('--- CONTINUING FROM A CHECKPOINT ---');
		expect(runArgs.args?.[0]).toContain('Address the second finding');
		expect(runArgs.args?.[0]).toContain('Complete only the remainder');
	});

	it('forwards timeoutMs, signal, and maxOutputBytes to the agent runner', async () => {
		const deps = makeDeps();
		const signal = new AbortController().signal;
		await runRespondToReviewPhase({ ...deps, timeoutMs: 60_000, signal });
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
		await runRespondToReviewPhase(deps);
		expect(order).toEqual(['graft', 'agent']);
	});

	it('cleans up the worktree and never runs the agent when graft throws', async () => {
		const deps = makeDeps();
		deps.graft = vi.fn(() => {
			throw new Error('graft failed: node_modules missing');
		});
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(/graft failed/);
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-21');
	});

	it('does not clean up when provisioning itself fails (nothing to remove)', async () => {
		const deps = makeDeps();
		deps.worktrees.provision = vi.fn(async () => {
			throw new Error("git worktree add failed: invalid reference: 'issue-21'");
		});
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(/invalid reference/);
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('fails before provisioning any worktree when the implementer token is missing', async () => {
		const deps = makeDeps();
		deps.getToken = vi.fn(async () => {
			throw new Error("No GitHub implementer token configured for project 'swarm'");
		});
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(/No GitHub implementer token/);
		expect(deps.worktrees.provision).not.toHaveBeenCalled();
		expect(deps.runAgent).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('honours a cli override (e.g. antigravity)', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ cli: 'antigravity' }));
		await runRespondToReviewPhase({ ...deps, cli: 'antigravity' });
		expect(deps.runAgent.mock.calls[0][0].cli).toBe('antigravity');
	});

	describe('merge automation is Review-only (issue #235, provider-neutral since issue #253)', () => {
		it.each([
			'fixed',
			'pushed-back',
			'no-findings',
		])('never surfaces mergeOutcome for a %s outcome, even when the setting is on', async (outcome) => {
			const deps = makeDeps();
			deps.project = createMockProjectConfig({
				pipeline: { respondToReview: { autoMerge: true } },
			});
			writeHandoff(deps.path, nonFixedHandoff(outcome));

			const result = await runRespondToReviewPhase(deps);

			expect(result.outcome).toBe(outcome);
			expect(result).not.toHaveProperty('mergeOutcome');
		});
	});

	it('throws and still cleans up when the agent exits non-zero', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(/exited with code 1/);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-21');
	});

	it('notes the timeout in the error when the agent timed out', async () => {
		const deps = makeDeps();
		deps.runAgent = vi.fn(async () => agentResult({ exitCode: null, timedOut: true }));
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(/timed out/);
	});

	it('throws and cleans up when the agent wrote no hand-off', async () => {
		const deps = makeDeps();
		rmSync(join(deps.path, RESPOND_OUTCOME_FILENAME));
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(
			new RegExp(`did not write required hand-off ${RESPOND_OUTCOME_FILENAME}`),
		);
		expect(deps.delivery.pushBranch).not.toHaveBeenCalled();
		expect(deps.delivery.postComment).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-21');
	});

	it('throws and cleans up when the hand-off is not valid JSON', async () => {
		const deps = makeDeps();
		writeHandoff(deps.path, '   \n  ');
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(
			new RegExp(`Invalid hand-off ${RESPOND_OUTCOME_FILENAME}`),
		);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-21');
	});

	it('throws and cleans up when the outcome is not recognized', async () => {
		const deps = makeDeps();
		writeHandoff(deps.path, responseHandoff({ outcome: 'done!' }));
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(
			new RegExp(`Invalid hand-off ${RESPOND_OUTCOME_FILENAME}`),
		);
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-21');
	});

	// A `fixed` outcome is a promise that a verified change is waiting in the tree.
	// Delivering one that names neither a commit subject nor a passing command would
	// push an unattributed, unverified commit to the PR.
	it.each([
		['no commit subject', { commitSubject: undefined }],
		['no verification', { verification: [] }],
	])('refuses a fixed hand-off with %s', async (_label, override) => {
		const deps = makeDeps();
		writeHandoff(deps.path, responseHandoff(override));
		await expect(runRespondToReviewPhase(deps)).rejects.toThrow(
			/fixed requires commitSubject and verification/,
		);
		expect(deps.delivery.pushBranch).not.toHaveBeenCalled();
		expect(deps.worktrees.cleanup).toHaveBeenCalledWith('respond-21');
	});

	it.each([
		'fixed',
		'pushed-back',
		'no-findings',
	])('returns the %j outcome the hand-off carries and posts its reply', async (outcome) => {
		const deps = makeDeps();
		writeHandoff(deps.path, nonFixedHandoff(outcome));

		const result = await runRespondToReviewPhase(deps);

		expect(result.outcome).toBe(outcome);
		// Only a fix has anything to push; the reply is posted either way.
		expect(deps.delivery.pushBranch).toHaveBeenCalledTimes(outcome === 'fixed' ? 1 : 0);
		expect(deps.delivery.postComment).toHaveBeenCalledTimes(1);
	});

	describe('board status reports', () => {
		// PR_BRANCH is `issue-21`, and the mock project's branchPrefix is `issue-`,
		// so the phase resolves the backing issue as #21 and matches this card.
		function makePm(
			items: Array<{ id: string; url: string }> = [
				{ id: 'ITEM_21', url: 'https://github.com/SmartTechBrewery/swarm/issues/21' },
			],
		) {
			const workItems = items.map(({ id, url }) => createMockWorkItem({ id, url }));
			return {
				type: 'github-projects' as const,
				getWorkItem: vi.fn(),
				listWorkItems: vi.fn(async () => workItems),
				// The narrow lookup the phase actually calls — the same suffix match the
				// real adapter runs, so a DB-free worker can serve it as one board read.
				findWorkItemByUrlSuffix: vi.fn(async (urlSuffix: string) =>
					workItems.find((item) => item.url.endsWith(urlSuffix)),
				),
				findWorkItemForArtifact: vi.fn(async () => undefined),
				findWorkItemByDescriptionMarker: vi.fn(async () => undefined),
				moveWorkItem: vi.fn(async (_id: string, _status: string) => {}),
				addComment: vi.fn(async () => 'c1'),
				findComment: vi.fn(async () => undefined),
				createWorkItem: vi.fn(async () => createMockWorkItem({ id: 'PVTI_sibling' })),
				updateWorkItem: vi.fn(async () => {}),
				addLabel: vi.fn(async () => {}),
				supportsDependencies: false,
				supportsAssignees: false,
				listBlockers: vi.fn(async () => []),
				listDependents: vi.fn(async () => []),
				addBlockedBy: vi.fn(async () => {}),
				resolveItemRepository: vi.fn(async () => ({ status: 'unrouted' }) as const),
			};
		}

		it('reports In progress before the agent runs and In review after a successful response', async () => {
			const deps = makeDeps();
			const pm = makePm();
			const order: string[] = [];
			pm.moveWorkItem.mockImplementation(async (_id: string, status: string) => {
				order.push(`move:${status}`);
			});
			deps.runAgent = vi.fn(async () => {
				order.push('agent');
				return agentResult();
			});

			const result = await runRespondToReviewPhase({ ...deps, pm });

			expect(pm.moveWorkItem).toHaveBeenNthCalledWith(1, 'ITEM_21', 'inProgress');
			expect(pm.moveWorkItem).toHaveBeenNthCalledWith(2, 'ITEM_21', 'inReview');
			// In progress before the agent, In review after — a real status report.
			expect(order).toEqual(['move:inProgress', 'agent', 'move:inReview']);
			expect(result.movedTo).toBe('inReview');
		});

		it('does not report to the board when no pm provider is injected', async () => {
			const deps = makeDeps();
			const result = await runRespondToReviewPhase(deps);
			expect(result.movedTo).toBeUndefined();
		});

		it('skips reports (best-effort) when the board has no item for the PR issue', async () => {
			const deps = makeDeps();
			const pm = makePm([
				{ id: 'ITEM_OTHER', url: 'https://github.com/SmartTechBrewery/swarm/issues/7' },
			]);

			const result = await runRespondToReviewPhase({ ...deps, pm });

			expect(pm.moveWorkItem).not.toHaveBeenCalled();
			expect(result.movedTo).toBeUndefined();
			// The response itself still succeeded.
			expect(result.outcome).toBe('fixed');
		});

		it('never fails the response when a board move throws (best-effort)', async () => {
			const deps = makeDeps();
			const pm = makePm();
			pm.moveWorkItem.mockRejectedValue(new Error('board unreachable'));

			const result = await runRespondToReviewPhase({ ...deps, pm });

			expect(result.outcome).toBe('fixed');
			expect(result.movedTo).toBeUndefined();
			expect(deps.runAgent).toHaveBeenCalledTimes(1);
		});

		it('never fails the response when resolving the card throws (best-effort)', async () => {
			const deps = makeDeps();
			const pm = makePm();
			// The same skip applies whether the provider is the in-process adapter or a
			// DB-free worker's transport delegate answering over the delivery API.
			pm.findWorkItemByUrlSuffix.mockRejectedValue(new Error('graphql 502'));

			const result = await runRespondToReviewPhase({ ...deps, pm });

			expect(result.outcome).toBe('fixed');
			expect(pm.moveWorkItem).not.toHaveBeenCalled();
			expect(result.movedTo).toBeUndefined();
		});

		// The card↔task link is durable and provider-neutral (issue #498): the control
		// plane resolves it from `runs.work_item_id` and injects it, so the phase never
		// has to guess a provider-shaped URL for a board that isn't GitHub Projects.
		it('uses the injected board item id without consulting the URL-suffix lookup', async () => {
			const deps = makeDeps();
			// A board whose cards carry no GitHub URL at all — the URL-suffix fallback
			// could never resolve this card.
			const pm = makePm([{ id: 'ITEM_JIRA', url: 'https://swarm.example.test/browse/PROJ-7' }]);

			const result = await runRespondToReviewPhase({ ...deps, pm, boardItemId: 'ITEM_JIRA' });

			expect(pm.findWorkItemByUrlSuffix).not.toHaveBeenCalled();
			expect(pm.moveWorkItem).toHaveBeenNthCalledWith(1, 'ITEM_JIRA', 'inProgress');
			expect(pm.moveWorkItem).toHaveBeenNthCalledWith(2, 'ITEM_JIRA', 'inReview');
			expect(result.movedTo).toBe('inReview');
		});

		it('falls back to the legacy URL-suffix lookup when no board item id is injected', async () => {
			const deps = makeDeps();
			const pm = makePm();

			const result = await runRespondToReviewPhase({ ...deps, pm, boardItemId: undefined });

			expect(pm.findWorkItemByUrlSuffix).toHaveBeenCalledWith('/issues/21');
			expect(pm.moveWorkItem).toHaveBeenNthCalledWith(1, 'ITEM_21', 'inProgress');
			expect(result.movedTo).toBe('inReview');
		});

		it('leaves the card at In progress (no In review move) when the agent fails', async () => {
			const deps = makeDeps();
			const pm = makePm();
			deps.runAgent = vi.fn(async () => agentResult({ exitCode: 1 }));

			await expect(runRespondToReviewPhase({ ...deps, pm })).rejects.toThrow(/exited with code 1/);

			// Picked up (In progress) but never returned to In review — mirrors
			// Implementation's leave-in-progress-on-failure behavior.
			expect(pm.moveWorkItem).toHaveBeenCalledExactlyOnceWith('ITEM_21', 'inProgress');
		});
	});
});

describe('buildRespondToReviewPrompt', () => {
	const context = {
		repo: 'SmartTechBrewery/swarm',
		prNumber: '99',
		prBranch: PR_BRANCH,
		reviewId: '4242',
	};

	it('instructs syncing the branch, reading the pinned review, replying point by point, and recording the outcome', () => {
		const prompt = buildRespondToReviewPrompt(context);
		expect(prompt).toContain(`git pull --ff-only origin ${PR_BRANCH}`);
		// Explicit remote/branch on the push — the checkout may have no upstream
		// configured (e.g. a human-created PR branch), so a bare `git push` could fail.
		expect(prompt).toContain(`git push origin ${PR_BRANCH}`);
		expect(prompt).toContain('gh api repos/SmartTechBrewery/swarm/pulls/99/reviews/4242');
		expect(prompt).toContain('gh api repos/SmartTechBrewery/swarm/pulls/99/reviews/4242/comments');
		expect(prompt).toContain('gh pr view 99 --repo SmartTechBrewery/swarm --comments');
		expect(prompt).toContain('gh pr comment 99 --repo SmartTechBrewery/swarm');
		expect(prompt).toContain(RESPOND_OUTCOME_FILENAME);
	});

	it('offers both paths — fix the code or push back with rationale — and forbids merging or self-review', () => {
		const prompt = buildRespondToReviewPrompt(context);
		expect(prompt).toContain('Do NOT invoke the `solve-issue` skill');
		expect(prompt).toContain('fix the code');
		expect(prompt).toContain('push back');
		expect(prompt).toContain('`fixed`');
		expect(prompt).toContain('`pushed-back`');
		expect(prompt).toContain('`no-findings`');
		expect(prompt).toMatch(/Do NOT `git add`\/commit/);
		expect(prompt).toContain('Do not merge the PR');
		expect(prompt).toContain('do not submit a review of your own');
	});

	it('instructs fixing valid nits and always replying, even on an approval with nothing to fix', () => {
		const prompt = buildRespondToReviewPrompt(context);
		expect(prompt).toMatch(/minor\/nit suggestions/);
		expect(prompt).toMatch(/ALWAYS reply on the PR/);
		expect(prompt).toMatch(/post a short comment thanking the reviewer/);
		expect(prompt).toMatch(/never skip this step, even when there is nothing to fix/);
	});

	it('carries the GH identity guard so the implementer persona token is not overridden', () => {
		const prompt = buildRespondToReviewPrompt(context);
		expect(prompt).toContain('GH_TOKEN');
		expect(prompt).toContain('gh auth switch');
	});
});

describe('issueNumberFromBranch', () => {
	it('extracts the issue number from the bare convention branch', () => {
		expect(issueNumberFromBranch('issue-100', 'issue-')).toBe('100');
	});

	it('extracts the issue number when a slug follows', () => {
		expect(issueNumberFromBranch('issue-100-runs-list-screen', 'issue-')).toBe('100');
	});

	it('honours a custom branch prefix', () => {
		expect(issueNumberFromBranch('task/42-fix', 'task/')).toBe('42');
	});

	it('returns undefined for a branch that does not start with the prefix', () => {
		expect(issueNumberFromBranch('feature/login', 'issue-')).toBeUndefined();
	});

	it('returns undefined when the prefix is not followed by digits', () => {
		expect(issueNumberFromBranch('issue-fix-login', 'issue-')).toBeUndefined();
	});
});

describe('resolvePushedHeadSha (issue #241)', () => {
	const REVIEWED_HEAD_SHA = 'reviewed0000000000000000000000000000000';

	function progress(overrides: Partial<DeliveryProgress> = {}): DeliveryProgress {
		return { deliveryId: 'd1', pushed: false, followUpEnqueued: false, ...overrides };
	}

	it('returns the pushed commit for a fixed outcome whose head advanced', () => {
		const result = resolvePushedHeadSha(
			'fixed',
			progress({ commitSha: 'newsha1', pushed: true }),
			REVIEWED_HEAD_SHA,
		);
		expect(result).toBe('newsha1');
	});

	it.each([
		'pushed-back',
		'no-findings',
	] as const)('returns undefined for a %s outcome even if a commit were somehow recorded', (outcome) => {
		expect(
			resolvePushedHeadSha(
				outcome,
				progress({ commitSha: 'newsha1', pushed: true }),
				REVIEWED_HEAD_SHA,
			),
		).toBeUndefined();
	});

	it('returns undefined when the fix commit was never pushed (failed delivery)', () => {
		expect(
			resolvePushedHeadSha(
				'fixed',
				progress({ commitSha: 'newsha1', pushed: false }),
				REVIEWED_HEAD_SHA,
			),
		).toBeUndefined();
	});

	it('returns undefined when no commit was recorded at all', () => {
		expect(resolvePushedHeadSha('fixed', progress(), REVIEWED_HEAD_SHA)).toBeUndefined();
	});

	it('returns undefined for an unchanged head (the pushed commit matches what was reviewed)', () => {
		expect(
			resolvePushedHeadSha(
				'fixed',
				progress({ commitSha: REVIEWED_HEAD_SHA, pushed: true }),
				REVIEWED_HEAD_SHA,
			),
		).toBeUndefined();
	});
});
