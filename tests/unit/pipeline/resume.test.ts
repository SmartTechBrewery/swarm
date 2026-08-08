import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isWorktreeLeasedMock, claimWorktreeLeaseMock, releaseWorktreeLeaseMock } = vi.hoisted(
	() => ({
		isWorktreeLeasedMock: vi.fn<(projectId: string, taskId: string) => Promise<boolean>>(
			async () => false,
		),
		claimWorktreeLeaseMock: vi.fn<(projectId: string, taskId: string) => Promise<void>>(
			async () => {},
		),
		releaseWorktreeLeaseMock: vi.fn<(projectId: string, taskId: string) => Promise<void>>(
			async () => {},
		),
	}),
);

vi.mock('@/worktree/worktree-lease.js', () => ({
	isWorktreeLeased: isWorktreeLeasedMock,
	claimWorktreeLease: claimWorktreeLeaseMock,
	releaseWorktreeLease: releaseWorktreeLeaseMock,
}));

/** The two levels this module's start-over signal is asserted on (issue #591). */
const { warn, info } = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/logger.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/logger.js')>();
	return { ...actual, logger: { ...actual.logger, warn, info } };
});

import type { AgentCliResult } from '@/harness/agent-cli.js';
import { AgentRunError } from '@/harness/agent-failure.js';
import { CHECKPOINT_FILENAME } from '@/pipeline/checkpoint.js';
import {
	acquireResumableWorktree,
	checkpointFallbackApplies,
	executeRecoveryGate,
	sessionRunArgs,
	shouldPreserveFailedCheckout,
	shouldPreserveForCheckpoint,
	shouldPreserveForResume,
} from '@/pipeline/resume.js';
import type { RecoveryMode } from '@/queue/jobs.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';

function mockAgentResult(sessionId?: string): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 1,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 100,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
		sessionId,
	};
}

describe('shouldPreserveForResume', () => {
	it('preserves the worktree for a stalled result with a session id', () => {
		const error = new AgentRunError(
			'stalled error',
			{ kind: 'stalled' },
			mockAgentResult('session-123'),
		);
		expect(shouldPreserveForResume(error)).toBe(true);
	});

	it('does not preserve the worktree for a stalled result without a session id', () => {
		const error = new AgentRunError(
			'stalled error',
			{ kind: 'stalled' },
			mockAgentResult(undefined),
		);
		expect(shouldPreserveForResume(error)).toBe(false);
	});

	it('preserves the worktree for a rate-limit result with a session id', () => {
		const error = new AgentRunError(
			'rate-limit error',
			{ kind: 'rate-limit' },
			mockAgentResult('session-123'),
		);
		expect(shouldPreserveForResume(error)).toBe(true);
	});

	it('does not preserve the worktree for a rate-limit result without a session id', () => {
		const error = new AgentRunError(
			'rate-limit error',
			{ kind: 'rate-limit' },
			mockAgentResult(undefined),
		);
		expect(shouldPreserveForResume(error)).toBe(false);
	});

	it('preserves the worktree for a timeout result with a session id', () => {
		const error = new AgentRunError(
			'timeout error',
			{ kind: 'timeout' },
			mockAgentResult('session-123'),
		);
		expect(shouldPreserveForResume(error)).toBe(true);
	});

	it('does not preserve the worktree for a timeout result without a session id', () => {
		const error = new AgentRunError(
			'timeout error',
			{ kind: 'timeout' },
			mockAgentResult(undefined),
		);
		expect(shouldPreserveForResume(error)).toBe(false);
	});

	it('does not preserve the worktree for generic errors even with a session id', () => {
		const error = new AgentRunError(
			'generic error',
			{ kind: 'error' },
			mockAgentResult('session-123'),
		);
		expect(shouldPreserveForResume(error)).toBe(false);
	});
});

/**
 * The recovery gate's Tier 2 branch (issue #502). The fixtures are real
 * directories and real repositories, because the branch's whole job is to compare
 * a checkpoint against the working tree actually on disk.
 */
const roots: string[] = [];
const fixtureGitEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function fixtureGit(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: fixtureGitEnvironment });
}

/** A checkpoint matching what {@link preservedCheckout} leaves dirty. */
const CHECKPOINT = {
	phase: 'implementation',
	completed: ['Added the schema'],
	remaining: ['Update the docs', 'Run the focused tests'],
	decisions: [],
	workingTree: { modified: ['a.ts'], added: [], deleted: [] },
};

/** A preserved checkout with one committed-then-edited file, carrying `checkpoint` if given. */
function preservedCheckout(checkpoint?: unknown): string {
	const root = mkdtempSync(join(tmpdir(), 'swarm-recovery-gate-'));
	roots.push(root);
	fixtureGit(root, ['init']);
	fixtureGit(root, ['config', 'user.name', 'Fixture']);
	fixtureGit(root, ['config', 'user.email', 'fixture@example.com']);
	writeFileSync(join(root, 'a.ts'), 'base\n');
	fixtureGit(root, ['add', '--all']);
	fixtureGit(root, ['commit', '-m', 'base']);
	writeFileSync(join(root, 'a.ts'), 'edited\n');
	if (checkpoint !== undefined)
		writeFileSync(join(root, CHECKPOINT_FILENAME), JSON.stringify(checkpoint));
	return root;
}

/** The structural slice of `GitWorktreeManager` the gate uses, including its private `git`. */
function stubWorktrees(path: string) {
	return {
		worktreePath: vi.fn(() => path),
		git: vi.fn(
			async (args: string[]): Promise<string> =>
				args[0] === 'symbolic-ref' ? 'issue-19\n' : 'abc1234def\n',
		),
		isClean: vi.fn(async () => true),
		hasUnpushedWork: vi.fn(async () => false),
		isLeased: vi.fn(async (taskId: string) => isWorktreeLeasedMock('project-1', taskId)),
		claimLease: vi.fn(async (taskId: string) => claimWorktreeLeaseMock('project-1', taskId)),
		releaseLease: vi.fn(async (taskId: string) => releaseWorktreeLeaseMock('project-1', taskId)),
		cleanup: vi.fn(async () => {}),
	};
}

function gate(
	path: string,
	mode: RecoveryMode | undefined,
	sessionId: string | undefined,
	phase: 'implementation' | 'respond-to-ci' = 'implementation',
) {
	return executeRecoveryGate(
		stubWorktrees(path) as unknown as GitWorktreeManager,
		'19',
		mode,
		sessionId,
		phase,
		'issue-19',
	);
}

/**
 * The Tier 2 *selection* predicates (issue #503) — which failures may fall back to a
 * checkpoint, and whether the checkout must therefore survive. The matrix that
 * matters is kind × captured-session × was-this-attempt-a-resume × checkpoint
 * present, and the first row of it is the regression that keeps Tier 1 in front.
 */
describe('checkpointFallbackApplies / shouldPreserveForCheckpoint (issue #503)', () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	const stopped = (kind: 'rate-limit' | 'timeout' | 'stalled', sessionId?: string): AgentRunError =>
		new AgentRunError(`${kind} error`, { kind }, mockAgentResult(sessionId));

	it.each([
		'rate-limit',
		'timeout',
		'stalled',
	] as const)('applies to a sessionless %s stop', (kind) => {
		expect(checkpointFallbackApplies(stopped(kind), false)).toBe(true);
	});

	// Tier 1 keeps absolute priority: a first stop that captured a resumable session is
	// still resumed, and never diverted to the degraded checkpoint hand-off.
	it.each([
		'rate-limit',
		'timeout',
		'stalled',
	] as const)('does not apply to a %s stop that captured a session id on a non-resume attempt', (kind) => {
		expect(checkpointFallbackApplies(stopped(kind, 'session-123'), false)).toBe(false);
	});

	// …but once that resume has itself failed, the id it echoes back is no longer
	// evidence the session can be re-entered, so Tier 2 takes over.
	it('applies when the failed attempt was itself a session resume', () => {
		expect(checkpointFallbackApplies(stopped('rate-limit', 'session-123'), true)).toBe(true);
	});

	it.each([
		'error',
		'auth',
		'capacity',
		'aborted',
	] as const)('never applies to a %s failure, resume or not', (kind) => {
		const error = new AgentRunError(`${kind} error`, { kind }, mockAgentResult(undefined));
		expect(checkpointFallbackApplies(error, false)).toBe(false);
		expect(checkpointFallbackApplies(error, true)).toBe(false);
	});

	it('preserves the checkout when the fallback applies and a checkpoint is there', () => {
		const path = preservedCheckout(CHECKPOINT);
		expect(shouldPreserveForCheckpoint(stopped('rate-limit'), path, 'implementation')).toBe(true);
	});

	it('does not preserve the checkout when no checkpoint was written', () => {
		const path = preservedCheckout();
		expect(shouldPreserveForCheckpoint(stopped('rate-limit'), path, 'implementation')).toBe(false);
	});

	it('does not preserve the checkout for an unparseable checkpoint', () => {
		const path = preservedCheckout({ nonsense: true });
		expect(shouldPreserveForCheckpoint(stopped('timeout'), path, 'implementation')).toBe(false);
	});

	it('does not preserve the checkout for a checkpoint another phase wrote', () => {
		const path = preservedCheckout({ ...CHECKPOINT, phase: 'respond-to-ci' });
		expect(shouldPreserveForCheckpoint(stopped('timeout'), path, 'implementation')).toBe(false);
	});

	it('does not preserve the checkout when Tier 1 can serve the stop', () => {
		const path = preservedCheckout(CHECKPOINT);
		expect(
			shouldPreserveForCheckpoint(
				stopped('rate-limit', 'session-123'),
				path,
				'implementation',
				false,
			),
		).toBe(false);
	});

	it('keeps either tier able to claim the checkout', () => {
		const path = preservedCheckout(CHECKPOINT);
		// Tier 1's own case — no checkpoint needed.
		expect(
			shouldPreserveFailedCheckout(
				stopped('timeout', 'session-123'),
				'/nonexistent',
				'implementation',
				false,
			),
		).toBe(true);
		// Tier 2's — no session, but a checkpoint.
		expect(shouldPreserveFailedCheckout(stopped('timeout'), path, 'implementation', false)).toBe(
			true,
		);
		// Neither.
		expect(
			shouldPreserveFailedCheckout(stopped('timeout'), '/nonexistent', 'implementation', false),
		).toBe(false);
	});
});

describe("executeRecoveryGate — the 'checkpoint' continuation branch (issue #502)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		isWorktreeLeasedMock.mockResolvedValue(false);
	});

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it('adopts the preserved checkout and returns the validated checkpoint', async () => {
		const path = preservedCheckout(CHECKPOINT);
		const result = await gate(path, 'checkpoint', undefined);
		expect(result.reuseHandle).toEqual({ taskId: '19', path, branch: 'issue-19', detached: false });
		expect(result.checkpoint?.remaining).toEqual(CHECKPOINT.remaining);
		// The adopted checkout stays leased for the continuation that is about to run.
		expect(claimWorktreeLeaseMock).toHaveBeenCalledWith('project-1', '19');
		expect(releaseWorktreeLeaseMock).not.toHaveBeenCalled();
	});

	// A checkout provisioned since #558 may be detached at `origin/<branch>` while
	// still targeting that branch. The handle has to keep the branch it targets:
	// delivery pushes `<sha>:refs/heads/<handle.branch>`, so a git-derived label
	// would push a branch named after a commit.
	it('keeps the targeted branch on a detached checkout, not the head sha', async () => {
		const path = preservedCheckout(CHECKPOINT);
		const worktrees = stubWorktrees(path);
		worktrees.git.mockImplementation(async (args: string[]): Promise<string> => {
			// `symbolic-ref -q` exits non-zero on a detached HEAD.
			if (args[0] === 'symbolic-ref') throw new Error('exit 1');
			return 'abc1234def\n';
		});
		const result = await executeRecoveryGate(
			worktrees as unknown as GitWorktreeManager,
			'19',
			'checkpoint',
			undefined,
			'implementation',
			'issue-19',
		);
		expect(result.reuseHandle).toEqual({ taskId: '19', path, branch: 'issue-19', detached: true });
	});

	it('needs no session id — the continuation resumes none', async () => {
		const path = preservedCheckout(CHECKPOINT);
		await expect(gate(path, 'checkpoint', undefined)).resolves.toMatchObject({
			checkpoint: { phase: 'implementation' },
		});
	});

	it('blocks with missing-validation when the checkout is gone', async () => {
		const path = join(tmpdir(), 'swarm-recovery-gate-absent-19');
		await expect(gate(path, 'checkpoint', undefined)).rejects.toMatchObject({
			name: 'BlockedRecoveryError',
			reason: 'missing-validation',
		});
	});

	it.each([
		{ case: 'no checkpoint at all', body: undefined, reason: 'missing-validation' },
		{ case: 'a malformed checkpoint', body: 'not json', reason: 'checkpoint-divergent' },
		{
			case: 'a schema-violating checkpoint',
			body: JSON.stringify({ ...CHECKPOINT, remaining: [] }),
			reason: 'checkpoint-divergent',
		},
		{
			case: 'a divergent working tree',
			body: JSON.stringify({
				...CHECKPOINT,
				workingTree: { modified: ['src/never-touched.ts'], added: [], deleted: [] },
			}),
			reason: 'checkpoint-divergent',
		},
	])('blocks on $case and releases the lease first', async ({ body, reason }) => {
		const path = preservedCheckout();
		if (body !== undefined) writeFileSync(join(path, CHECKPOINT_FILENAME), body);
		await expect(gate(path, 'checkpoint', undefined)).rejects.toMatchObject({
			name: 'BlockedRecoveryError',
			reason,
		});
		expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('project-1', '19');
	});

	it("refuses another phase's checkpoint left in the reused checkout", async () => {
		const path = preservedCheckout(CHECKPOINT);
		await expect(gate(path, 'checkpoint', undefined, 'respond-to-ci')).rejects.toMatchObject({
			name: 'BlockedRecoveryError',
			reason: 'checkpoint-divergent',
		});
		expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('project-1', '19');
	});
});

describe('executeRecoveryGate — Tier 1 behaviour is unchanged (regression)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		isWorktreeLeasedMock.mockResolvedValue(false);
	});

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("'resume' adopts the checkout on a session id and never consults the checkpoint", async () => {
		// A checkpoint that would be rejected as divergent must not affect Tier 1.
		const path = preservedCheckout({
			...CHECKPOINT,
			workingTree: { modified: ['src/never-touched.ts'], added: [], deleted: [] },
		});
		await expect(gate(path, 'resume', 'session-19')).resolves.toEqual({
			reuseHandle: { taskId: '19', path, branch: 'issue-19', detached: false },
		});
		expect(releaseWorktreeLeaseMock).not.toHaveBeenCalled();
	});

	// Acceptance criterion 3 of issue #591: an operator who explicitly asked to
	// *resume* must be told the checkout is gone, never quietly handed a run that
	// started over. Pinned here because restoring the hand-off is what finally makes
	// this branch reachable — until then no gate ran at all.
	it("'resume' fails terminally when the checkout is gone rather than starting over", async () => {
		await expect(
			gate(join(tmpdir(), 'swarm-no-such-checkout'), 'resume', 'session-19'),
		).rejects.toMatchObject({
			name: 'BlockedRecoveryError',
			reason: 'missing-validation',
			message: expect.stringContaining('worktree checkout does not exist'),
		});
	});

	it("'resume' still blocks with missing-validation when no session id is known", async () => {
		const path = preservedCheckout();
		await expect(gate(path, 'resume', undefined)).rejects.toMatchObject({
			name: 'BlockedRecoveryError',
			reason: 'missing-validation',
		});
		expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('project-1', '19');
	});

	it("'fresh' still removes a clean checkout and returns no handle", async () => {
		const path = preservedCheckout();
		const worktrees = stubWorktrees(path);
		const result = await executeRecoveryGate(
			worktrees as unknown as GitWorktreeManager,
			'19',
			'fresh',
			undefined,
			'implementation',
			'issue-19',
		);
		expect(result).toEqual({ reuseHandle: null });
		expect(worktrees.cleanup).toHaveBeenCalledWith('19');
	});

	it('still blocks a live-leased checkout when no recovery was requested', async () => {
		isWorktreeLeasedMock.mockResolvedValue(true);
		const path = preservedCheckout();
		await expect(gate(path, undefined, undefined)).rejects.toMatchObject({
			name: 'BlockedRecoveryError',
			reason: 'live-leased',
		});
	});

	// The regression the `'discard'` branch must not cause: `'fresh'` is still the
	// mode that refuses to destroy work, so an automatic retry can never acquire
	// force-reset semantics by accident.
	it("'fresh' still blocks on a dirty checkout rather than removing it", async () => {
		const path = preservedCheckout();
		const worktrees = { ...stubWorktrees(path), isClean: vi.fn(async () => false) };
		await expect(
			executeRecoveryGate(
				worktrees as unknown as GitWorktreeManager,
				'19',
				'fresh',
				undefined,
				'implementation',
				'issue-19',
			),
		).rejects.toMatchObject({ name: 'BlockedRecoveryError', reason: 'dirty' });
		expect(worktrees.cleanup).not.toHaveBeenCalled();
		expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('project-1', '19');
	});

	it("'fresh' still blocks on unpushed commits rather than removing them", async () => {
		const path = preservedCheckout();
		const worktrees = { ...stubWorktrees(path), hasUnpushedWork: vi.fn(async () => true) };
		await expect(
			executeRecoveryGate(
				worktrees as unknown as GitWorktreeManager,
				'19',
				'fresh',
				undefined,
				'implementation',
				'issue-19',
			),
		).rejects.toMatchObject({ name: 'BlockedRecoveryError', reason: 'unpushed' });
		expect(worktrees.cleanup).not.toHaveBeenCalled();
	});
});

/**
 * The `'discard'` branch (issue #592) — the operator's forced reset, honoured by
 * whichever worker holds the checkout. It is the one mode that destroys protected
 * work, which is exactly why the assertions below are about a *dirty, unpushed*
 * checkout going anyway.
 */
describe("executeRecoveryGate — the 'discard' branch (issue #592)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		isWorktreeLeasedMock.mockResolvedValue(false);
	});

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it('removes a dirty, unpushed checkout and provisions fresh', async () => {
		const path = preservedCheckout();
		const worktrees = {
			...stubWorktrees(path),
			isClean: vi.fn(async () => false),
			hasUnpushedWork: vi.fn(async () => true),
		};

		const result = await executeRecoveryGate(
			worktrees as unknown as GitWorktreeManager,
			'19',
			'discard',
			undefined,
			'implementation',
			'issue-19',
		);

		expect(result).toEqual({ reuseHandle: null });
		expect(worktrees.cleanup).toHaveBeenCalledWith('19');
		// The protections `'fresh'` applies are deliberately not consulted here.
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('discarding the preserved checkout'),
			expect.objectContaining({ taskId: '19', path }),
		);
	});

	it('takes over a checkout another run still leases — a wedged lease is what it clears', async () => {
		isWorktreeLeasedMock.mockResolvedValue(true);
		const path = preservedCheckout();
		const worktrees = stubWorktrees(path);

		await expect(
			executeRecoveryGate(
				worktrees as unknown as GitWorktreeManager,
				'19',
				'discard',
				undefined,
				'implementation',
				'issue-19',
			),
		).resolves.toEqual({ reuseHandle: null });
		expect(worktrees.cleanup).toHaveBeenCalledWith('19');
	});

	it('provisions fresh without throwing when the checkout is genuinely gone', async () => {
		const path = join(tmpdir(), 'swarm-no-such-checkout');
		const worktrees = stubWorktrees(path);

		await expect(
			executeRecoveryGate(
				worktrees as unknown as GitWorktreeManager,
				'19',
				'discard',
				undefined,
				'implementation',
				'issue-19',
			),
		).resolves.toEqual({ reuseHandle: null });
		expect(worktrees.cleanup).not.toHaveBeenCalled();
	});
});

describe('acquireResumableWorktree — a checkpoint continuation resumes no session', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		isWorktreeLeasedMock.mockResolvedValue(false);
	});

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	async function acquire(mode: 'resume' | 'checkpoint', path: string) {
		const worktrees = {
			...stubWorktrees(path),
			reuse: vi.fn(async () => undefined),
		};
		return acquireResumableWorktree(
			worktrees as unknown as GitWorktreeManager,
			'19',
			'implementation',
			'issue-19',
			false,
			'session-19',
			async (): Promise<WorktreeHandle> => {
				throw new Error('must not provision a fresh checkout');
			},
			false,
			mode,
		);
	}

	it('reports resumed: false and hands the checkpoint back for the prompt', async () => {
		const path = preservedCheckout(CHECKPOINT);
		const result = await acquire('checkpoint', path);
		expect(result.handle.path).toBe(path);
		expect(result.resumed).toBe(false);
		expect(result.deliveryResumed).toBe(false);
		expect(result.checkpoint?.remaining).toEqual(CHECKPOINT.remaining);
	});

	it("still reports resumed: true with no checkpoint for 'resume' (regression)", async () => {
		const path = preservedCheckout();
		const result = await acquire('resume', path);
		expect(result.resumed).toBe(true);
		expect(result.checkpoint).toBeUndefined();
	});
});

/**
 * Acceptance criterion 5 of issue #591. Losing a continuation used to be
 * *completely* silent: the phase fell through to `provisionFresh()`, re-did work
 * it had already done, and nothing in the logs tied that to the checkout still
 * sitting on disk. Task #553 lost a checkpointed session exactly this way.
 */
describe('acquireResumableWorktree — starting over is never silent', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		isWorktreeLeasedMock.mockResolvedValue(false);
	});

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		warn.mockClear();
		info.mockClear();
	});

	/** No recovery mode and no resume id — the fall-through the warning guards. */
	async function acquireFresh(path: string, provisionedPath = path) {
		const worktrees = {
			...stubWorktrees(path),
			reuse: vi.fn(async () => undefined),
		};
		return acquireResumableWorktree(
			worktrees as unknown as GitWorktreeManager,
			'19',
			'implementation',
			'issue-19',
			false,
			undefined,
			async (): Promise<WorktreeHandle> => ({
				taskId: '19',
				path: provisionedPath,
				branch: 'issue-19',
				detached: false,
			}),
			false,
			undefined,
			'run-19',
		);
	}

	it('warns — naming task, phase and run — when a checkpointed checkout is abandoned', async () => {
		const path = preservedCheckout(CHECKPOINT);
		await acquireFresh(path);

		// A recorded hand-off was definitively lost, so this is the loud case.
		expect(warn).toHaveBeenCalledTimes(1);
		const [message, context] = warn.mock.calls[0];
		expect(message).toMatch(/starting over/i);
		expect(context).toMatchObject({
			taskId: '19',
			phase: 'implementation',
			runId: 'run-19',
			worktreePath: path,
			// The loud half: a checkpoint present here means a hand-off was lost.
			hasCheckpoint: true,
			checkpointPhase: 'implementation',
		});
	});

	it('records a checkout with no hand-off at info, not warn', async () => {
		// A bare directory is also what a plain stale leftover looks like, so warning
		// on it would dilute the signal the checkpointed case above carries.
		const path = preservedCheckout();
		await acquireFresh(path);

		expect(warn).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalledTimes(1);
		expect(info.mock.calls[0][0]).toMatch(/starting over/i);
		expect(info.mock.calls[0][1]).toMatchObject({ hasCheckpoint: false });
	});

	it('stays quiet for an ordinary first run, whose task has no checkout at all', async () => {
		// The common case by far — a warning here would be pure noise.
		await acquireFresh(join(tmpdir(), 'swarm-no-such-checkout'), '/tmp/provisioned');
		expect(warn).not.toHaveBeenCalled();
		expect(info).not.toHaveBeenCalled();
	});
});

describe('sessionRunArgs', () => {
	const session = { sessionId: 'fresh-19', resumeSessionId: 'prior-19' };

	it('resumes the prior session when a checkout was reused', () => {
		expect(sessionRunArgs(session, true)).toEqual({
			sessionId: undefined,
			resumeSessionId: 'prior-19',
		});
	});

	it('assigns a fresh id on a first run', () => {
		expect(sessionRunArgs(session, false)).toEqual({
			sessionId: 'fresh-19',
			resumeSessionId: undefined,
		});
	});

	it('forces a fresh, sessionless run for a checkpoint continuation', () => {
		// Unconditional: even a caller that (wrongly) claimed a resume gets no resume id,
		// which is what makes the continuation runnable on a different CLI.
		for (const resumed of [false, true])
			expect(sessionRunArgs(session, resumed, 'checkpoint')).toEqual({
				sessionId: 'fresh-19',
				resumeSessionId: undefined,
			});
	});

	it("leaves the 'resume' and 'fresh' modes exactly as before (regression)", () => {
		expect(sessionRunArgs(session, true, 'resume')).toEqual({
			sessionId: undefined,
			resumeSessionId: 'prior-19',
		});
		expect(sessionRunArgs(session, false, 'fresh')).toEqual({
			sessionId: 'fresh-19',
			resumeSessionId: undefined,
		});
	});
});
