import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliResult } from '@/harness/agent-cli.js';
import type { FollowUpReviewInput } from '@/pipeline/follow-up-review.js';
import { runRespondToReviewPhase } from '@/pipeline/respond-to-review.js';
import { DeliveryDeferredError, type ScmDeliveryProvider } from '@/scm/delivery.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const REVIEWED_HEAD_SHA = 'reviewed0000000000000000000000000000000';

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

const testGitEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

/**
 * A minimal real git repo — `commitPreparedTree` shells out to `git`
 * (`src/scm/delivery.ts`), so a `fixed` outcome needs an actual checkout to
 * commit into, not just a mocked worktree handle.
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
}

/** A real, uncommitted working-tree change for `commitPreparedTree` to pick up. */
function writeFixChange(path: string): void {
	writeFileSync(join(path, 'fix.txt'), 'addressed the review\n');
}

function writeHandoff(path: string, overrides: Record<string, unknown> = {}): void {
	writeFileSync(
		join(path, 'respond_to_review_handoff.json'),
		JSON.stringify({
			outcome: 'fixed',
			body: 'Addressed the review',
			commitSubject: 'fix: address review feedback',
			verification: [{ command: 'npm test', outcome: 'passed' }],
			...overrides,
		}),
	);
}

function makeOptions(path: string, handle: WorktreeHandle) {
	const cleanup = vi.fn(async () => undefined);
	const worktrees = {
		provision: vi.fn(async () => handle),
		worktreePath: vi.fn(() => handle.path),
		reuse: vi.fn(async () => handle),
		cleanup,
	} as unknown as GitWorktreeManager;
	const runAgent = vi.fn(async () => {
		writeFixChange(path);
		writeHandoff(path);
		return agentResult();
	});
	const pushBranch = vi.fn(async () => undefined);
	const postComment = vi.fn(async () => 1);
	const delivery = {
		commitIdentity: { name: 'implementer', email: 'implementer@users.noreply.github.com' },
		findPullRequest: vi.fn(),
		createPullRequest: vi.fn(),
		pushBranch,
		submitReview: vi.fn(),
		postComment,
	} as unknown as ScmDeliveryProvider;
	const scheduleFollowUpReview = vi.fn<(input: FollowUpReviewInput) => Promise<void>>(
		async () => undefined,
	);
	return {
		project: createMockProjectConfig(),
		prNumber: '42',
		prBranch: 'issue-42',
		reviewId: '9001',
		headSha: REVIEWED_HEAD_SHA,
		taskId: 'respond-42',
		worktrees,
		runAgent,
		graft: vi.fn(() => []),
		getToken: vi.fn(async () => 'implementer-token'),
		delivery,
		scheduleFollowUpReview,
		cleanup,
		pushBranch,
		postComment,
	};
}

describe('respond-to-review production delivery', () => {
	it('schedules exactly one follow-up Review for a fixed response that pushed a new head', async () => {
		const path = mkdtempSync(join(tmpdir(), 'swarm-respond-delivery-'));
		roots.push(path);
		initGitRepo(path);
		const handle: WorktreeHandle = {
			taskId: 'respond-42',
			path,
			branch: 'issue-42',
			detached: false,
		};
		const options = makeOptions(path, handle);

		const result = await runRespondToReviewPhase(options);

		expect(result.outcome).toBe('fixed');
		expect(result.pushedHeadSha).toBeDefined();
		expect(result.pushedHeadSha).not.toBe(REVIEWED_HEAD_SHA);
		expect(options.scheduleFollowUpReview).toHaveBeenCalledExactlyOnceWith({
			project: options.project,
			prNumber: '42',
			prBranch: 'issue-42',
			headSha: result.pushedHeadSha,
		});
	});

	it.each([
		'pushed-back',
		'no-findings',
	])('never schedules a follow-up Review for a %s outcome', async (outcome) => {
		const path = mkdtempSync(join(tmpdir(), 'swarm-respond-delivery-'));
		roots.push(path);
		const handle: WorktreeHandle = {
			taskId: 'respond-42',
			path,
			branch: 'issue-42',
			detached: false,
		};
		const options = makeOptions(path, handle);
		options.runAgent = vi.fn(async () => {
			writeHandoff(path, { outcome, commitSubject: undefined, verification: [] });
			return agentResult();
		});

		const result = await runRespondToReviewPhase(options);

		expect(result.outcome).toBe(outcome);
		expect(result.pushedHeadSha).toBeUndefined();
		expect(options.scheduleFollowUpReview).not.toHaveBeenCalled();
		expect(options.pushBranch).not.toHaveBeenCalled();
	});

	it('preserves progress and resumes the follow-up schedule after a queueing failure, without re-running the agent or duplicating delivery', async () => {
		const path = mkdtempSync(join(tmpdir(), 'swarm-respond-delivery-'));
		roots.push(path);
		initGitRepo(path);
		const handle: WorktreeHandle = {
			taskId: 'respond-42',
			path,
			branch: 'issue-42',
			detached: false,
		};
		const options = makeOptions(path, handle);
		options.scheduleFollowUpReview = vi
			.fn<(input: FollowUpReviewInput) => Promise<void>>()
			.mockRejectedValueOnce(new Error('redis down'))
			.mockResolvedValue(undefined);

		await expect(runRespondToReviewPhase(options)).rejects.toBeInstanceOf(DeliveryDeferredError);
		expect(options.cleanup).not.toHaveBeenCalled();
		expect(options.runAgent).toHaveBeenCalledTimes(1);
		// Push and comment delivery already completed before the failure — a
		// resumed retry must not repeat them.
		expect(options.pushBranch).toHaveBeenCalledTimes(1);
		expect(options.postComment).toHaveBeenCalledTimes(1);

		const result = await runRespondToReviewPhase({ ...options, resumeDelivery: true });

		expect(result.outcome).toBe('fixed');
		expect(result.pushedHeadSha).toBeDefined();
		expect(options.runAgent).toHaveBeenCalledTimes(1);
		expect(options.pushBranch).toHaveBeenCalledTimes(1);
		expect(options.postComment).toHaveBeenCalledTimes(1);
		expect(options.scheduleFollowUpReview).toHaveBeenCalledTimes(2);
		expect(options.cleanup).toHaveBeenCalledTimes(1);
	});

	it('does not re-schedule a follow-up Review once the checkpoint is already saved', async () => {
		const path = mkdtempSync(join(tmpdir(), 'swarm-respond-delivery-'));
		roots.push(path);
		initGitRepo(path);
		const handle: WorktreeHandle = {
			taskId: 'respond-42',
			path,
			branch: 'issue-42',
			detached: false,
		};
		const options = makeOptions(path, handle);

		const first = await runRespondToReviewPhase(options);
		expect(options.scheduleFollowUpReview).toHaveBeenCalledTimes(1);

		// A duplicate delivery for the very same (preserved) worktree — e.g. a
		// redelivered webhook resuming the same run — must not re-enqueue: the
		// on-disk checkpoint from the first pass already marks it done.
		const second = await runRespondToReviewPhase({ ...options, resumeDelivery: true });

		expect(second.outcome).toBe('fixed');
		expect(second.pushedHeadSha).toBe(first.pushedHeadSha);
		expect(options.scheduleFollowUpReview).toHaveBeenCalledTimes(1);
	});
});
