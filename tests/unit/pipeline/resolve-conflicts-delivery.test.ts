import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliResult } from '@/harness/agent-cli.js';
import { runResolveConflictsPhase } from '@/pipeline/resolve-conflicts.js';
import {
	DeliveryDeferredError,
	HANDOFF_FILENAMES,
	type ScmDeliveryProvider,
	UnretryableDeliveryError,
} from '@/scm/delivery.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

/**
 * Resolve-conflicts against **real** delivery (issue #839). The sibling
 * `resolve-conflicts.test.ts` mocks `commitPreparedTree`/`assertRemoteHead`, so it
 * cannot see which class a refusal is raised as; this file mirrors
 * `implementation-delivery.test.ts` instead — a real worktree, a real `origin`,
 * real `commitPreparedTree`, and only the SCM provider stubbed.
 */

const PR_NUMBER = '508';
const TASK_ID = 'task-508';
const PR_BRANCH = 'issue-503';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const testGitEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: testGitEnvironment });
}

function agentResult(): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 1,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
		sessionId: 'session-1',
	};
}

/** A migrations dir valid by construction, so the journal guard passes through. */
function writeCleanMigrations(worktreePath: string): void {
	const dir = join(worktreePath, 'src/db/migrations');
	mkdirSync(join(dir, 'meta'), { recursive: true });
	writeFileSync(join(dir, '0000_init.sql'), '-- 0\n');
	writeFileSync(join(dir, 'meta', '0000_snapshot.json'), '{}');
	writeFileSync(
		join(dir, 'meta', '_journal.json'),
		JSON.stringify({
			version: '7',
			dialect: 'postgresql',
			entries: [{ idx: 0, version: '7', when: 1_000, tag: '0000_init', breakpoints: true }],
		}),
	);
}

function writeHandoff(worktreePath: string): void {
	writeFileSync(
		join(worktreePath, HANDOFF_FILENAMES.resolveConflicts),
		JSON.stringify({
			status: 'resolved',
			body: 'Merged main; resolved every conflict.',
			verification: [{ command: 'npm test', outcome: 'passed' }],
		}),
	);
}

/**
 * A bare `origin`, a PR branch and a `main` that touch the same line, and a
 * checkout of the PR branch mid-merge with both sides in conflict. `headSha` is
 * the PR branch tip on `origin`, so the phase's real `assertRemoteHead` passes.
 */
function makeConflictedCheckout(): {
	worktreePath: string;
	seed: string;
	headSha: string;
	baseSha: string;
} {
	const root = mkdtempSync(join(tmpdir(), 'swarm-resolve-delivery-'));
	roots.push(root);
	const origin = join(root, 'origin.git');
	const seed = join(root, 'seed');
	const worktreePath = join(root, 'work');
	execFileSync('git', ['init', '--bare', '-b', 'main', origin], { env: testGitEnvironment });
	execFileSync('git', ['clone', '-q', origin, seed], { env: testGitEnvironment });
	git(seed, 'config', 'user.email', 'test@example.com');
	git(seed, 'config', 'user.name', 'Test');
	writeFileSync(join(seed, 'conflict.txt'), 'base\n');
	git(seed, 'add', '.');
	git(seed, 'commit', '-q', '--no-verify', '-m', 'base');
	git(seed, 'push', '-q', 'origin', 'main');
	git(seed, 'checkout', '-q', '-b', PR_BRANCH);
	writeFileSync(join(seed, 'conflict.txt'), 'the pull request\n');
	git(seed, 'commit', '-q', '--no-verify', '-am', 'pr change');
	git(seed, 'push', '-q', 'origin', PR_BRANCH);
	const headSha = git(seed, 'rev-parse', 'HEAD').trim();
	git(seed, 'checkout', '-q', 'main');
	writeFileSync(join(seed, 'conflict.txt'), 'main moved on\n');
	git(seed, 'commit', '-q', '--no-verify', '-am', 'main change');
	git(seed, 'push', '-q', 'origin', 'main');
	const baseSha = git(seed, 'rev-parse', 'HEAD').trim();

	execFileSync('git', ['clone', '-q', '-b', PR_BRANCH, origin, worktreePath], {
		env: testGitEnvironment,
	});
	git(worktreePath, 'config', 'user.email', 'test@example.com');
	git(worktreePath, 'config', 'user.name', 'Test');
	try {
		git(worktreePath, 'merge', '--no-verify', 'origin/main');
	} catch {
		// Expected: the merge conflicts, which is the state the phase then resolves.
	}
	writeCleanMigrations(worktreePath);
	writeHandoff(worktreePath);
	return { worktreePath, seed, headSha, baseSha };
}

/** Another pull request merging into the base while this run is working — issue #1001. */
function advanceBase(seed: string, content: string): string {
	git(seed, 'checkout', '-q', 'main');
	writeFileSync(join(seed, 'conflict.txt'), content);
	git(seed, 'commit', '-q', '--no-verify', '-am', content.trim());
	git(seed, 'push', '-q', 'origin', 'main');
	return git(seed, 'rev-parse', 'HEAD').trim();
}

/** What the agent leaves behind for the merge already in progress: a staged resolution. */
function stageResolution(worktreePath: string, content: string): void {
	writeFileSync(join(worktreePath, 'conflict.txt'), content);
	git(worktreePath, 'add', '--', 'conflict.txt');
}

/** What a catch-up pass does: take the advanced base in on top of the merge already committed. */
function mergeAdvancedBase(worktreePath: string, content: string): void {
	git(worktreePath, 'fetch', '-q', 'origin');
	try {
		git(worktreePath, 'merge', '--no-verify', '--no-commit', 'origin/main');
	} catch {
		// Expected: both sides moved the same line again.
	}
	stageResolution(worktreePath, content);
}

function makeOptions(worktreePath: string, headSha: string, baseSha: string) {
	const handle: WorktreeHandle = {
		taskId: TASK_ID,
		path: worktreePath,
		branch: PR_BRANCH,
		detached: false,
	};
	const cleanup = vi.fn(async () => undefined);
	const preserve = vi.fn(async () => undefined);
	const worktrees = {
		provision: vi.fn(async () => handle),
		worktreePath: vi.fn(() => handle.path),
		reuse: vi.fn(async () => handle),
		preserve,
		cleanup,
	} as unknown as GitWorktreeManager;
	const postComment = vi.fn(async () => 1);
	const pushBranch = vi.fn(async () => undefined);
	const delivery = {
		commitIdentity: { name: 'implementer', email: 'implementer@users.noreply.github.com' },
		findPullRequest: vi.fn(),
		createPullRequest: vi.fn(),
		pushBranch,
		submitReview: vi.fn(),
		postComment,
	} as unknown as ScmDeliveryProvider;
	return {
		project: createMockProjectConfig(),
		prNumber: PR_NUMBER,
		prBranch: PR_BRANCH,
		headSha,
		baseBranch: 'main',
		baseSha,
		taskId: TASK_ID,
		worktrees,
		runAgent: vi.fn(async () => agentResult()),
		graft: vi.fn(() => []),
		delivery,
		cleanup,
		preserve,
		pushBranch,
		postComment,
	};
}

describe('resolve-conflicts production delivery', () => {
	// The incident (issue #844's half of it): the agent overwrote both sides with
	// clean text and never staged it. The index is still unmerged, and no retry
	// re-runs the agent — but the content really is resolved, so the phase's own
	// index-settling backstop stages it and the delivery goes through.
	it('delivers a resolved merge the agent left unstaged', async () => {
		const { worktreePath, headSha, baseSha } = makeConflictedCheckout();
		writeFileSync(join(worktreePath, 'conflict.txt'), 'resolved by hand\n');
		const options = makeOptions(worktreePath, headSha, baseSha);

		const { outcome } = await runResolveConflictsPhase(options);

		expect(outcome.status).toBe('resolved');
		// A base that stayed put costs no catch-up pass at all (issue #1001).
		expect(options.runAgent).toHaveBeenCalledTimes(1);
		expect(options.pushBranch).toHaveBeenCalledTimes(1);
		expect(options.postComment).toHaveBeenCalledTimes(1);
		expect(options.cleanup).toHaveBeenCalledTimes(1);
		expect(options.preserve).not.toHaveBeenCalled();
		// One commit, and it really is the merge — both parents are recorded.
		expect(git(worktreePath, 'rev-parse', 'HEAD^@').trim().split('\n')).toHaveLength(2);
		expect(git(worktreePath, 'show', '-s', '--format=%s', 'HEAD').trim()).toBe(
			`chore: merge main into ${PR_BRANCH}`,
		);
	});

	// The residual failure mode, which phase 1/2 settles terminally: a conflict
	// the agent did not actually resolve. The backstop leaves it unmerged on
	// purpose rather than committing the markers.
	it('settles a genuinely unresolved conflict terminally and releases the checkout', async () => {
		// `conflict.txt` is left exactly as the failed merge wrote it — markers and all.
		const { worktreePath, headSha, baseSha } = makeConflictedCheckout();
		const options = makeOptions(worktreePath, headSha, baseSha);

		const error = await runResolveConflictsPhase(options).catch((e) => e);

		expect(error).toBeInstanceOf(UnretryableDeliveryError);
		expect(error).not.toBeInstanceOf(DeliveryDeferredError);
		expect(error.message).toContain('Unsafe delivery: ');
		expect(error.message).toContain('unresolved conflicts in conflict.txt');
		// Released, not preserved for a retry nothing would make succeed.
		expect(options.cleanup).toHaveBeenCalledTimes(1);
		expect(options.preserve).not.toHaveBeenCalled();
		// Refused before anything was delivered.
		expect(options.pushBranch).not.toHaveBeenCalled();
		expect(options.postComment).not.toHaveBeenCalled();
	});

	// The other half of the rule: a genuinely transient failure still defers and
	// still keeps the checkout for a resume that skips the agent.
	it('still defers a transient delivery failure and preserves the checkout', async () => {
		const { worktreePath, headSha, baseSha } = makeConflictedCheckout();
		writeFileSync(join(worktreePath, 'conflict.txt'), 'resolved by hand\n');
		git(worktreePath, 'add', '--', 'conflict.txt');
		const options = makeOptions(worktreePath, headSha, baseSha);
		options.postComment = vi.fn(async () => {
			throw new Error('502 Bad Gateway from the SCM API');
		});
		(options.delivery as { postComment: unknown }).postComment = options.postComment;

		const error = await runResolveConflictsPhase(options).catch((e) => e);

		expect(error).toBeInstanceOf(DeliveryDeferredError);
		expect(error).not.toBeInstanceOf(UnretryableDeliveryError);
		// The commit and push really happened — this failed at the comment, which is
		// what a resumed delivery would pick up from.
		expect(options.pushBranch).toHaveBeenCalledTimes(1);
		expect(options.preserve).toHaveBeenCalledTimes(1);
		expect(options.cleanup).not.toHaveBeenCalled();
	});
});

/**
 * Issue #1001. The window between reading the base and pushing is the phase's own
 * runtime, so on a repository SWARM itself merges into, a merge landing inside it
 * is the expected case: the run pushed a merge of a base that no longer existed
 * and settled `phase-succeeded` over a pull request GitHub had already recomputed
 * as `CONFLICTING`. Real git, so the assertions are about what the pushed commit
 * actually contains rather than about a mocked SHA comparison.
 *
 * Each case drives two or three full merge/commit rounds through real git
 * subprocesses, which outruns the 5s default once the whole unit suite is
 * competing for threads — hence the explicit per-case budget.
 */
const RACE_CASE_TIMEOUT_MS = 30_000;

describe('resolve-conflicts when the base advances mid-run', () => {
	it(
		'merges the advanced base again and delivers a commit that contains it',
		async () => {
			const { worktreePath, seed, headSha, baseSha } = makeConflictedCheckout();
			const options = makeOptions(worktreePath, headSha, baseSha);
			let advancedTo = '';
			let passes = 0;
			options.runAgent = vi.fn(async () => {
				passes += 1;
				if (passes === 1) {
					stageResolution(worktreePath, 'resolved by hand\n');
					// The merge the incident describes: 15 seconds into the run.
					advancedTo = advanceBase(seed, 'main moved on again\n');
				} else {
					mergeAdvancedBase(worktreePath, 'resolved against the newer main\n');
				}
				return agentResult();
			});

			const { outcome } = await runResolveConflictsPhase(options);

			expect(outcome.status).toBe('resolved');
			expect(options.runAgent).toHaveBeenCalledTimes(2);
			// The catch-up pass is a second merge on top of the first, not a redo.
			expect(options.pushBranch).toHaveBeenCalledTimes(1);
			expect(options.pushBranch).toHaveBeenCalledWith(
				worktreePath,
				PR_BRANCH,
				outcome.mergeCommitSha,
			);
			expect(options.postComment).toHaveBeenCalledTimes(1);
			// The whole point: what was pushed contains the base as it stood at push time.
			expect(() =>
				git(worktreePath, 'merge-base', '--is-ancestor', advancedTo, outcome.mergeCommitSha),
			).not.toThrow();
		},
		RACE_CASE_TIMEOUT_MS,
	);

	// The other half of the race, and the one no pre-push check can reach: nothing
	// constrains `origin/main` while the *pull request's* branch is being updated,
	// so a merge landing in the push's own window leaves the branch stale again. The
	// run must not comment or report `resolved` until a base read taken with the
	// commit already on the remote finds it contained.
	it(
		'merges again when the base advances during the push, and comments only after',
		async () => {
			const { worktreePath, seed, headSha, baseSha } = makeConflictedCheckout();
			const options = makeOptions(worktreePath, headSha, baseSha);
			let advancedTo = '';
			const pushed: string[] = [];
			// The push is where the window is: `main` moves while this very call runs.
			(options.delivery as { pushBranch: unknown }).pushBranch = vi.fn(
				async (_cwd: string, _branch: string, sha: string) => {
					pushed.push(sha);
					if (pushed.length === 1) advancedTo = advanceBase(seed, 'main moved on again\n');
				},
			);
			let passes = 0;
			options.runAgent = vi.fn(async () => {
				passes += 1;
				if (passes === 1) stageResolution(worktreePath, 'resolved by hand\n');
				else mergeAdvancedBase(worktreePath, 'resolved against the newer main\n');
				// Nothing has been commented yet — the first push's merge is already stale.
				expect(options.postComment).not.toHaveBeenCalled();
				return agentResult();
			});

			const { outcome } = await runResolveConflictsPhase(options);

			expect(outcome.status).toBe('resolved');
			// One resolution, one catch-up pass for the advance the first push raced.
			expect(options.runAgent).toHaveBeenCalledTimes(2);
			// Two pushes: the stale one, then the merge that caught up with it.
			expect(pushed).toHaveLength(2);
			expect(pushed[1]).toBe(outcome.mergeCommitSha);
			expect(pushed[0]).not.toBe(outcome.mergeCommitSha);
			expect(options.postComment).toHaveBeenCalledTimes(1);
			// The claim the comment makes: the commit on the branch contains the base as
			// it stood once that commit was already there.
			expect(() =>
				git(worktreePath, 'merge-base', '--is-ancestor', advancedTo, outcome.mergeCommitSha),
			).not.toThrow();
			// ...which the commit the first push delivered did not.
			expect(() =>
				git(worktreePath, 'merge-base', '--is-ancestor', advancedTo, pushed[0]),
			).toThrow();
		},
		RACE_CASE_TIMEOUT_MS,
	);

	// A base merging continuously must not spin forever, and must not report success
	// either: the run says what happened and delivers nothing.
	it(
		'stops after a bounded number of catch-up passes and reports the race',
		async () => {
			const { worktreePath, seed, headSha, baseSha } = makeConflictedCheckout();
			const options = makeOptions(worktreePath, headSha, baseSha);
			let passes = 0;
			options.runAgent = vi.fn(async () => {
				passes += 1;
				if (passes === 1) stageResolution(worktreePath, `resolved on pass ${passes}\n`);
				else mergeAdvancedBase(worktreePath, `resolved on pass ${passes}\n`);
				advanceBase(seed, `main moved on again (${passes})\n`);
				return agentResult();
			});

			const error = await runResolveConflictsPhase(options).catch((e) => e);

			// One resolution plus the two catch-up passes, and then it stops.
			expect(options.runAgent).toHaveBeenCalledTimes(3);
			expect(error).toBeInstanceOf(UnretryableDeliveryError);
			expect(error).not.toBeInstanceOf(DeliveryDeferredError);
			expect(error.message).toContain('Stale merge: ');
			expect(error.message).toContain("base branch 'main' advanced to");
			expect(error.message).toContain('Nothing was pushed or commented');
			// Nothing delivered, so no `phase-succeeded` over a still-conflicting PR.
			expect(options.pushBranch).not.toHaveBeenCalled();
			expect(options.postComment).not.toHaveBeenCalled();
			// Terminal, not deferred: a resumed delivery skips the agent, so it would push
			// exactly the stale merge this refused.
			expect(options.cleanup).toHaveBeenCalledTimes(1);
			expect(options.preserve).not.toHaveBeenCalled();
		},
		RACE_CASE_TIMEOUT_MS,
	);
});
