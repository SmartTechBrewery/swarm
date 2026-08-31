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
function makeConflictedCheckout(): { worktreePath: string; headSha: string; baseSha: string } {
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
	return { worktreePath, headSha, baseSha };
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
