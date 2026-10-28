import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliResult } from '@/harness/agent-cli.js';
import {
	runResolveConflictsCatchUp,
	runResolveConflictsPhase,
} from '@/pipeline/resolve-conflicts.js';
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

	// PR #1156's later attempts: the checkout already held an earlier attempt's merge
	// commit that never reached the remote, so merging the current base — advanced
	// only by a commit and its revert — left a pending merge with an unchanged tree.
	// That merge commit is still the update, so the first commit must not refuse it.
	it('commits a first-pass merge that leaves the tree unchanged', async () => {
		const { worktreePath, seed, headSha, baseSha } = makeConflictedCheckout();
		const options = makeOptions(worktreePath, headSha, baseSha);
		let advancedTo = '';
		options.runAgent = vi.fn(async () => {
			stageResolution(worktreePath, 'resolved by hand\n');
			git(worktreePath, 'add', '--', 'src/db/migrations');
			git(worktreePath, 'commit', '-q', '--no-verify', '-m', 'an earlier attempt, never pushed');
			advanceBase(seed, 'main moved on again\n');
			git(seed, 'revert', '--no-edit', 'HEAD');
			git(seed, 'push', '-q', 'origin', 'main');
			advancedTo = git(seed, 'rev-parse', 'HEAD').trim();
			git(worktreePath, 'fetch', '-q', 'origin');
			git(worktreePath, 'merge', '--no-verify', '--no-commit', 'origin/main');
			return agentResult();
		});

		const { outcome } = await runResolveConflictsPhase(options);

		expect(outcome.status).toBe('resolved');
		expect(options.runAgent).toHaveBeenCalledTimes(1);
		expect(options.pushBranch).toHaveBeenCalledTimes(1);
		expect(options.pushBranch).toHaveBeenCalledWith(
			worktreePath,
			PR_BRANCH,
			outcome.mergeCommitSha,
		);
		expect(() =>
			git(worktreePath, 'merge-base', '--is-ancestor', advancedTo, outcome.mergeCommitSha),
		).not.toThrow();
		expect(git(worktreePath, 'rev-parse', `${outcome.mergeCommitSha}^{tree}`).trim()).toBe(
			git(worktreePath, 'rev-parse', `${outcome.mergeCommitSha}^1^{tree}`).trim(),
		);
	});

	// The relaxation covers a pending merge only: a first pass that leaves nothing to
	// commit and no merge in progress is still refused.
	it('still refuses a first pass that left no merge pending', async () => {
		const { worktreePath, headSha, baseSha } = makeConflictedCheckout();
		const options = makeOptions(worktreePath, headSha, baseSha);
		options.runAgent = vi.fn(async () => {
			stageResolution(worktreePath, 'resolved by hand\n');
			git(worktreePath, 'add', '--', 'src/db/migrations');
			git(worktreePath, 'commit', '-q', '--no-verify', '-m', 'committed by the agent');
			return agentResult();
		});

		const error = await runResolveConflictsPhase(options).catch((e) => e);

		expect(error).toBeInstanceOf(UnretryableDeliveryError);
		expect(error.message).toContain('Unsafe delivery: ');
		expect(error.message).toContain('nothing to deliver');
		expect(options.pushBranch).not.toHaveBeenCalled();
		expect(options.postComment).not.toHaveBeenCalled();
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

	// PR #1156's run: the base advanced only by what the branch already held, so the
	// catch-up merge was clean, pending, and left the tree exactly as it was. That
	// merge commit is still the update — refusing it as "no changes at all" failed a
	// correct resolution.
	it(
		'commits a catch-up merge that leaves the tree unchanged',
		async () => {
			const { worktreePath, seed, headSha, baseSha } = makeConflictedCheckout();
			const options = makeOptions(worktreePath, headSha, baseSha);
			let advancedTo = '';
			let passes = 0;
			options.runAgent = vi.fn(async () => {
				passes += 1;
				if (passes === 1) {
					stageResolution(worktreePath, 'resolved by hand\n');
					advanceBase(seed, 'main moved on again\n');
					git(seed, 'revert', '--no-edit', 'HEAD');
					git(seed, 'push', '-q', 'origin', 'main');
					advancedTo = git(seed, 'rev-parse', 'HEAD').trim();
				} else {
					git(worktreePath, 'fetch', '-q', 'origin');
					git(worktreePath, 'merge', '--no-verify', '--no-commit', 'origin/main');
				}
				return agentResult();
			});

			const { outcome } = await runResolveConflictsPhase(options);

			expect(outcome.status).toBe('resolved');
			expect(options.runAgent).toHaveBeenCalledTimes(2);
			expect(options.pushBranch).toHaveBeenCalledTimes(1);
			expect(options.pushBranch).toHaveBeenCalledWith(
				worktreePath,
				PR_BRANCH,
				outcome.mergeCommitSha,
			);
			expect(() =>
				git(worktreePath, 'merge-base', '--is-ancestor', advancedTo, outcome.mergeCommitSha),
			).not.toThrow();
			expect(git(worktreePath, 'rev-parse', `${outcome.mergeCommitSha}^{tree}`).trim()).toBe(
				git(worktreePath, 'rev-parse', `${outcome.mergeCommitSha}^1^{tree}`).trim(),
			);
		},
		RACE_CASE_TIMEOUT_MS,
	);

	// The relaxation covers a pending merge only: a catch-up pass that merged nothing
	// is still refused rather than pushed as if it had caught up.
	it(
		'still refuses a catch-up pass that left no merge pending',
		async () => {
			const { worktreePath, seed, headSha, baseSha } = makeConflictedCheckout();
			const options = makeOptions(worktreePath, headSha, baseSha);
			let passes = 0;
			options.runAgent = vi.fn(async () => {
				passes += 1;
				if (passes === 1) {
					stageResolution(worktreePath, 'resolved by hand\n');
					advanceBase(seed, 'main moved on again\n');
				}
				return agentResult();
			});

			const error = await runResolveConflictsPhase(options).catch((e) => e);

			expect(error).toBeInstanceOf(UnretryableDeliveryError);
			expect(error.message).toContain('Unsafe delivery: ');
			expect(error.message).toContain('nothing to deliver');
			expect(options.pushBranch).not.toHaveBeenCalled();
			expect(options.postComment).not.toHaveBeenCalled();
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

/**
 * A bare `origin` with a PR branch one commit ahead of an older `main`, a `main`
 * that has since moved on, and a clean checkout of the PR branch at its tip — the
 * state merge automation hands a worker when the provider cannot update a branch
 * itself (issue #1117). `conflicting` makes both sides touch the same line.
 */
function makeStaleCheckout(conflicting = false): {
	worktreePath: string;
	seed: string;
	origin: string;
	headSha: string;
	baseSha: string;
} {
	const root = mkdtempSync(join(tmpdir(), 'swarm-catch-up-'));
	roots.push(root);
	const origin = join(root, 'origin.git');
	const seed = join(root, 'seed');
	const worktreePath = join(root, 'work');
	execFileSync('git', ['init', '--bare', '-b', 'main', origin], { env: testGitEnvironment });
	execFileSync('git', ['clone', '-q', origin, seed], { env: testGitEnvironment });
	git(seed, 'config', 'user.email', 'test@example.com');
	git(seed, 'config', 'user.name', 'Test');
	writeFileSync(join(seed, 'shared.txt'), 'base\n');
	git(seed, 'add', '.');
	git(seed, 'commit', '-q', '--no-verify', '-m', 'base');
	git(seed, 'push', '-q', 'origin', 'main');
	git(seed, 'checkout', '-q', '-b', PR_BRANCH);
	writeFileSync(join(seed, conflicting ? 'shared.txt' : 'feature.txt'), 'the pull request\n');
	git(seed, 'add', '.');
	git(seed, 'commit', '-q', '--no-verify', '-m', 'pr change');
	git(seed, 'push', '-q', 'origin', PR_BRANCH);
	const headSha = git(seed, 'rev-parse', 'HEAD').trim();
	const baseSha = advanceBaseFile(seed, conflicting ? 'shared.txt' : 'base-only.txt');
	execFileSync('git', ['clone', '-q', '-b', PR_BRANCH, origin, worktreePath], {
		env: testGitEnvironment,
	});
	git(worktreePath, 'config', 'user.email', 'test@example.com');
	git(worktreePath, 'config', 'user.name', 'Test');
	return { worktreePath, seed, origin, headSha, baseSha };
}

/** Another pull request landing on `main`. */
function advanceBaseFile(seed: string, file: string): string {
	git(seed, 'checkout', '-q', 'main');
	writeFileSync(join(seed, file), 'main moved on\n');
	git(seed, 'add', '.');
	git(seed, 'commit', '-q', '--no-verify', '-m', `main change to ${file}`);
	git(seed, 'push', '-q', 'origin', 'main');
	return git(seed, 'rev-parse', 'HEAD').trim();
}

/** Somebody pushing to the pull request's branch. */
function pushToPrBranch(seed: string): string {
	git(seed, 'checkout', '-q', PR_BRANCH);
	git(seed, 'pull', '-q', '--ff-only', 'origin', PR_BRANCH);
	writeFileSync(join(seed, 'pushed.txt'), 'a human pushed\n');
	git(seed, 'add', '.');
	git(seed, 'commit', '-q', '--no-verify', '-m', 'pushed by a human');
	git(seed, 'push', '-q', 'origin', PR_BRANCH);
	return git(seed, 'rev-parse', 'HEAD').trim();
}

/** The catch-up's options, delivering through a real fast-forward-only push. */
function makeCatchUpOptions(worktreePath: string, headSha: string, baseSha: string) {
	const options = makeOptions(worktreePath, headSha, baseSha);
	const pushBranch = vi.fn(async (cwd: string, branch: string, sha: string) => {
		execFileSync('git', ['push', '-q', 'origin', `${sha}:refs/heads/${branch}`], {
			cwd,
			env: testGitEnvironment,
			stdio: 'pipe',
		});
	});
	options.delivery = { ...options.delivery, pushBranch } as unknown as ScmDeliveryProvider;
	return { ...options, pushBranch };
}

describe('resolve-conflicts catch-up (merge automation’s worker-side update, issue #1117)', () => {
	it('merges the base cleanly with no agent and pushes the merge pinned to the head', async () => {
		const { worktreePath, origin, headSha, baseSha } = makeStaleCheckout();
		const options = makeCatchUpOptions(worktreePath, headSha, baseSha);

		const { catchUp } = await runResolveConflictsCatchUp(options);

		expect(catchUp.status).toBe('updated');
		const produced = catchUp.status === 'updated' ? catchUp.headSha : '';
		expect(options.runAgent).not.toHaveBeenCalled();
		expect(options.postComment).not.toHaveBeenCalled();
		expect(options.pushBranch).toHaveBeenCalledExactlyOnceWith(worktreePath, PR_BRANCH, produced);
		expect(git(origin, 'rev-parse', `refs/heads/${PR_BRANCH}`).trim()).toBe(produced);
		// First parent the reviewed head, second the base head read at merge time.
		expect(
			git(worktreePath, 'rev-parse', `${produced}^1`, `${produced}^2`).trim().split('\n'),
		).toEqual([headSha, baseSha]);
		expect(git(worktreePath, 'show', '-s', '--format=%an', produced).trim()).toBe('implementer');
		expect(options.cleanup).toHaveBeenCalledTimes(1);
	});

	it("treats an abbreviated (Bitbucket 12-char) approved head as the checkout's own head and merges", async () => {
		const { worktreePath, origin, headSha, baseSha } = makeStaleCheckout();
		const abbreviated = headSha.slice(0, 12);
		const options = makeCatchUpOptions(worktreePath, abbreviated, baseSha);

		const { catchUp } = await runResolveConflictsCatchUp(options);

		expect(catchUp.status).toBe('updated');
		const reported = catchUp.status === 'updated' ? catchUp.headSha : '';
		const pushed = git(origin, 'rev-parse', `refs/heads/${PR_BRANCH}`).trim();
		// Reported in the spelling it was dispatched in, naming the commit pushed.
		expect(reported).toBe(pushed.slice(0, 12));
		expect(git(worktreePath, 'rev-parse', `${pushed}^1`).trim()).toBe(headSha);
	});

	it('commits and pushes a clean merge whose tree is unchanged (base advanced by a commit and its revert)', async () => {
		const { worktreePath, seed, origin, headSha } = makeStaleCheckout();
		git(seed, 'revert', '--no-edit', 'HEAD');
		git(seed, 'push', '-q', 'origin', 'main');
		const baseSha = git(seed, 'rev-parse', 'HEAD').trim();
		const options = makeCatchUpOptions(worktreePath, headSha, baseSha);

		const { catchUp } = await runResolveConflictsCatchUp(options);

		expect(catchUp.status).toBe('updated');
		const produced = catchUp.status === 'updated' ? catchUp.headSha : '';
		expect(git(origin, 'rev-parse', `refs/heads/${PR_BRANCH}`).trim()).toBe(produced);
		expect(
			git(worktreePath, 'rev-parse', `${produced}^1`, `${produced}^2`).trim().split('\n'),
		).toEqual([headSha, baseSha]);
		expect(git(worktreePath, 'rev-parse', `${produced}^{tree}`).trim()).toBe(
			git(worktreePath, 'rev-parse', `${headSha}^{tree}`).trim(),
		);
	});

	it('aborts and reports a conflicting merge without pushing anything', async () => {
		const { worktreePath, origin, headSha, baseSha } = makeStaleCheckout(true);
		const options = makeCatchUpOptions(worktreePath, headSha, baseSha);

		const { catchUp } = await runResolveConflictsCatchUp(options);

		expect(catchUp).toEqual({
			status: 'conflict',
			message: expect.stringContaining('conflicts in shared.txt'),
		});
		expect(options.runAgent).not.toHaveBeenCalled();
		expect(options.pushBranch).not.toHaveBeenCalled();
		expect(git(origin, 'rev-parse', `refs/heads/${PR_BRANCH}`).trim()).toBe(headSha);
		// Aborted, not left mid-merge.
		expect(git(worktreePath, 'status', '--porcelain').trim()).toBe('');
	});

	it('reports head-moved when the branch moved before the merge was committed', async () => {
		const { worktreePath, seed, origin, headSha, baseSha } = makeStaleCheckout();
		const pushed = pushToPrBranch(seed);
		const options = makeCatchUpOptions(worktreePath, headSha, baseSha);

		const { catchUp } = await runResolveConflictsCatchUp(options);

		expect(catchUp).toEqual({ status: 'head-moved', message: expect.stringContaining(pushed) });
		expect(options.pushBranch).not.toHaveBeenCalled();
		expect(git(origin, 'rev-parse', `refs/heads/${PR_BRANCH}`).trim()).toBe(pushed);
	});

	it('reports head-moved when the pinned push is refused because the branch moved', async () => {
		const { worktreePath, seed, origin, headSha, baseSha } = makeStaleCheckout();
		const options = makeCatchUpOptions(worktreePath, headSha, baseSha);
		let pushed = '';
		const realPush = options.pushBranch.getMockImplementation();
		options.pushBranch.mockImplementation(async (cwd, branch, sha) => {
			// Somebody lands a commit between the remote re-read and the push.
			pushed = pushToPrBranch(seed);
			await realPush?.(cwd, branch, sha);
		});

		const { catchUp } = await runResolveConflictsCatchUp(options);

		expect(catchUp).toEqual({ status: 'head-moved', message: expect.stringContaining('diverged') });
		expect(git(origin, 'rev-parse', `refs/heads/${PR_BRANCH}`).trim()).toBe(pushed);
	});

	it('reports head-moved when the checkout is not at the approved head', async () => {
		const { worktreePath, headSha, baseSha } = makeStaleCheckout();
		const parent = git(worktreePath, 'rev-parse', `${headSha}^`).trim();
		const options = makeCatchUpOptions(worktreePath, parent, baseSha);

		const { catchUp } = await runResolveConflictsCatchUp(options);

		expect(catchUp).toEqual({ status: 'head-moved', message: expect.stringContaining(headSha) });
		expect(options.pushBranch).not.toHaveBeenCalled();
	});

	it('reports up-to-date for a head that already contains the base', async () => {
		const { worktreePath, seed, headSha, baseSha } = makeStaleCheckout();
		// Bring the PR branch up to date on the remote first, then check it out afresh.
		git(seed, 'checkout', '-q', PR_BRANCH);
		git(seed, 'merge', '-q', '--no-verify', '--no-edit', 'main');
		git(seed, 'push', '-q', 'origin', PR_BRANCH);
		const current = git(seed, 'rev-parse', 'HEAD').trim();
		git(worktreePath, 'pull', '-q', '--ff-only', 'origin', PR_BRANCH);
		const options = makeCatchUpOptions(worktreePath, current, baseSha);

		const { catchUp } = await runResolveConflictsCatchUp(options);

		expect(catchUp).toEqual({ status: 'up-to-date' });
		expect(options.pushBranch).not.toHaveBeenCalled();
		expect(headSha).not.toBe(current);
	});
});
