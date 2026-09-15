import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/scm/delivery.js', async (importOriginal) => ({
	// `commitPreparedTree`/`assertRemoteHead` shell out to real git — stubbed so
	// this file exercises the migration-journal gate without a git fixture.
	// Everything else (readHandoff, delivery-progress, ConflictHandoffSchema, …)
	// stays real so the phase's actual file-based hand-off contract is exercised.
	...(await importOriginal<typeof import('@/scm/delivery.js')>()),
	commitPreparedTree: vi.fn(async () => 'deadbeefcafebabedeadbeefcafebabedeadbeef'),
	assertRemoteHead: vi.fn(async () => {}),
}));

// The phase's other deterministic backstop (issue #844) shells out to real git
// too, and these fixtures are bare temp directories that are never `git init`-ed
// — its real behaviour is under test in `merge-resolution.test.ts` and
// `resolve-conflicts-delivery.test.ts`, both of which use real repositories.
vi.mock('@/pipeline/merge-resolution.js', () => ({
	settleMergeResolution: vi.fn(async () => ({ staged: [], unresolved: [] })),
}));

import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import { AgentRunError } from '@/harness/agent-failure.js';
import { buildBaseAdvancedRemergePrompt } from '@/pipeline/prompts/resolve-conflicts.js';
import {
	buildResolveConflictsPrompt,
	runResolveConflictsPhase,
} from '@/pipeline/resolve-conflicts.js';
import {
	assertRemoteHead,
	CONFLICT_VERIFICATION_OUTCOMES,
	commitPreparedTree,
	HANDOFF_FILENAMES,
	type ScmDeliveryProvider,
} from '@/scm/delivery.js';
import { RETRY_BUFFER_MS, retryDelayForFailure } from '@/worker/consumer.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import {
	ANTIGRAVITY_QUOTA_FAILURE,
	ANTIGRAVITY_QUOTA_LOG_TEXT,
	ANTIGRAVITY_QUOTA_SELF_TIMEOUT,
} from '../../helpers/antigravity-quota.js';
import { readDeliveryId } from '../../helpers/delivery-sidecar.js';
import {
	createMockProjectConfig,
	createMockProjectRepositoryPair,
} from '../../helpers/factories.js';

const PR_NUMBER = '508';
const HEAD_SHA = 'f'.repeat(40);
const BASE_SHA = 'b'.repeat(40);

const roots: string[] = [];

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

/** A real temp worktree with a valid resolve-conflicts hand-off already written — the agent's "output". */
function makeWorktree(
	verification: unknown = [{ command: 'npm test', outcome: 'passed' }],
): string {
	const root = mkdtempSync(join(tmpdir(), 'swarm-resolve-conflicts-'));
	roots.push(root);
	writeFileSync(
		join(root, HANDOFF_FILENAMES.resolveConflicts),
		JSON.stringify({
			status: 'resolved',
			body: 'Merged main; resolved every conflict.',
			verification,
		}),
	);
	return root;
}

/** A migrations dir with `.sql`/journal/snapshot files for each tag — valid by construction. */
function writeCleanMigrations(worktreePath: string, tags: string[]): void {
	const dir = join(worktreePath, 'src/db/migrations');
	mkdirSync(join(dir, 'meta'), { recursive: true });
	tags.forEach((tag, idx) => {
		writeFileSync(join(dir, `${tag}.sql`), `-- ${idx}\n`);
		writeFileSync(join(dir, 'meta', `${tag.slice(0, 4)}_snapshot.json`), '{}');
	});
	writeFileSync(
		join(dir, 'meta', '_journal.json'),
		JSON.stringify({
			version: '7',
			dialect: 'postgresql',
			entries: tags.map((tag, idx) => ({
				idx,
				version: '7',
				when: 1_000 * (idx + 1),
				tag,
				breakpoints: true,
			})),
		}),
	);
}

/** Corrupt the journal exactly the way PR #508's merges did: a phantom trailing entry. */
function corruptMigrationsWithPhantomEntry(worktreePath: string): void {
	const journalPath = join(worktreePath, 'src/db/migrations/meta/_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
	journal.entries.push({
		idx: journal.entries.length,
		version: '7',
		when: 99_999,
		tag: '0099_phantom',
	});
	writeFileSync(journalPath, JSON.stringify(journal));
}

/**
 * Rewrite the hand-off the way `buildMigrationJournalRepairPrompt`'s last
 * paragraph tells the repair pass to when its fix changes `body` or
 * `verification`.
 */
function rewriteHandoff(worktreePath: string, patch: Record<string, unknown>): void {
	const path = join(worktreePath, HANDOFF_FILENAMES.resolveConflicts);
	writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...patch }));
}

/** Fix the phantom entry the way the repair pass is instructed to (drop it). */
function repairPhantomEntry(worktreePath: string): void {
	const journalPath = join(worktreePath, 'src/db/migrations/meta/_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
	journal.entries = journal.entries.filter((e: { tag: string }) => e.tag !== '0099_phantom');
	writeFileSync(journalPath, JSON.stringify(journal));
}

/**
 * The phase's dependencies over `worktreePath`. `project` defaults to the
 * single-repository fixture; the cross-repository case below passes a project scoped
 * to one of two repositories instead.
 */
function makeDeps(worktreePath: string, project = createMockProjectConfig()) {
	const handle: WorktreeHandle = {
		taskId: 'task-508',
		path: worktreePath,
		branch: 'issue-503',
		detached: false,
	};
	const worktrees = {
		provision: vi.fn(async () => handle),
		worktreePath: vi.fn(() => handle.path),
		cleanup: vi.fn(async () => {}),
		// The failure path retains the checkout for a session resume, so the fixture
		// has to answer it — otherwise a resumable failure only looks clean here
		// because the swallowed cleanup error hid it.
		preserve: vi.fn(async () => {}),
	};
	return {
		project,
		prNumber: PR_NUMBER,
		prBranch: 'issue-503',
		headSha: HEAD_SHA,
		baseBranch: 'main',
		baseSha: BASE_SHA,
		taskId: 'task-508',
		worktrees: worktrees as unknown as GitWorktreeManager,
		runAgent: vi.fn<(opts: RunAgentCliOptions) => Promise<AgentCliResult>>(async () =>
			agentResult(),
		),
		graft: vi.fn(() => []),
		delivery: {
			commitIdentity: { name: 'swarm', email: 'swarm@example.com' },
			pushBranch: vi.fn(async () => {}),
			postComment: vi.fn(async () => 'comment-1'),
		} as unknown as ScmDeliveryProvider,
	};
}

afterEach(() => {
	while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe('runResolveConflictsPhase — migration-journal gate (issue #503/#508)', () => {
	it('delivers normally when the merged migrations folder is already clean', async () => {
		const worktreePath = makeWorktree();
		writeCleanMigrations(worktreePath, ['0000_first', '0001_second']);
		const deps = makeDeps(worktreePath);

		const { outcome } = await runResolveConflictsPhase(deps);

		expect(outcome.status).toBe('resolved');
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		expect(commitPreparedTree).toHaveBeenCalledTimes(1);
		expect(deps.delivery.pushBranch).toHaveBeenCalledTimes(1);
	});

	// Issue #907: a repository that does not carry SWARM's own drizzle layout at
	// all. The phase has to complete, and the guard must not spend its repair
	// pass on a repository with nothing to validate — hence exactly one agent run.
	it('delivers without a repair pass when the repository has no migrations directory', async () => {
		const worktreePath = makeWorktree();
		const deps = makeDeps(worktreePath);

		const { outcome } = await runResolveConflictsPhase(deps);

		expect(outcome.status).toBe('resolved');
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
		expect(commitPreparedTree).toHaveBeenCalledTimes(1);
		expect(deps.delivery.pushBranch).toHaveBeenCalledTimes(1);
	});

	it('runs one repair pass and delivers once the repair fixes the journal', async () => {
		const worktreePath = makeWorktree();
		writeCleanMigrations(worktreePath, ['0000_first', '0001_second']);
		corruptMigrationsWithPhantomEntry(worktreePath);
		const deps = makeDeps(worktreePath);
		deps.runAgent.mockImplementationOnce(async () => agentResult({ sessionId: 'session-1' }));
		deps.runAgent.mockImplementationOnce(async () => {
			repairPhantomEntry(worktreePath);
			return agentResult({ sessionId: 'session-1' });
		});

		const { outcome } = await runResolveConflictsPhase(deps);

		expect(outcome.status).toBe('resolved');
		expect(deps.runAgent).toHaveBeenCalledTimes(2);
		// The repair pass resumes the same session the merge just ran.
		const repairCall = deps.runAgent.mock.calls[1]?.[0];
		expect(repairCall).toMatchObject({ resumeSessionId: 'session-1' });
		expect(repairCall?.args?.[0]).toContain("failed SWARM's deterministic post-merge check");
		expect(commitPreparedTree).toHaveBeenCalledTimes(1);
	});

	// The repair prompt tells the agent which side's migrations to leave alone, so on a
	// project whose base branch is not `main` it has to name the real one (issue #885).
	it("names the run's own base branch in the repair prompt", async () => {
		const worktreePath = makeWorktree();
		writeCleanMigrations(worktreePath, ['0000_first', '0001_second']);
		corruptMigrationsWithPhantomEntry(worktreePath);
		const deps = makeDeps(worktreePath);
		deps.runAgent.mockImplementationOnce(async () => agentResult({ sessionId: 'session-1' }));
		deps.runAgent.mockImplementationOnce(async () => {
			repairPhantomEntry(worktreePath);
			return agentResult({ sessionId: 'session-1' });
		});

		await runResolveConflictsPhase({ ...deps, baseBranch: 'develop' });

		const repairPrompt = deps.runAgent.mock.calls[1]?.[0]?.args?.[0];
		expect(repairPrompt).toContain(
			"keep `develop`'s existing migrations exactly as `develop` has them",
		);
		expect(repairPrompt).toContain('beyond `develop`');
		expect(repairPrompt).not.toContain('`main`');
	});

	// The other half of the same rule (issue #865). `codex`/`agy` mint their own
	// thread id, so SWARM's assigned one names a session harness never created and
	// `codex exec resume <assigned>` would exit 1 without reaching the model — the
	// pass has to run fresh instead. This is the migration-journal call site's guard
	// against someone reverting it to the old inline `?? sessionId` expression.
	it('runs the repair pass fresh on a self-minting CLI whose merge reported no session id', async () => {
		const worktreePath = makeWorktree();
		writeCleanMigrations(worktreePath, ['0000_first', '0001_second']);
		corruptMigrationsWithPhantomEntry(worktreePath);
		const deps = makeDeps(worktreePath);
		deps.runAgent.mockImplementationOnce(async () => agentResult({ cli: 'codex' }));
		deps.runAgent.mockImplementationOnce(async () => {
			repairPhantomEntry(worktreePath);
			return agentResult({ cli: 'codex' });
		});

		const { outcome } = await runResolveConflictsPhase({
			...deps,
			cli: 'codex',
			sessionId: 'assigned-run-id',
		});

		expect(outcome.status).toBe('resolved');
		expect(deps.runAgent).toHaveBeenCalledTimes(2);
		const repairCall = deps.runAgent.mock.calls[1]?.[0];
		expect(repairCall).toBeDefined();
		expect('resumeSessionId' in (repairCall as object)).toBe(true);
		expect(repairCall?.resumeSessionId).toBeUndefined();
		// A fresh turn is a first turn, so the repair prompt has to carry the phase
		// guard itself rather than inheriting it from the merge prompt.
		expect(repairCall?.args?.[0]).toContain(
			'You are a SWARM pipeline agent assigned to exactly one phase',
		);
		expect(repairCall?.args?.[0]).toContain(HANDOFF_FILENAMES.resolveConflicts);
		expect(commitPreparedTree).toHaveBeenCalledTimes(1);
	});

	it('fails the phase without delivering anything when the repair pass does not fix it', async () => {
		const worktreePath = makeWorktree();
		writeCleanMigrations(worktreePath, ['0000_first', '0001_second']);
		corruptMigrationsWithPhantomEntry(worktreePath);
		const deps = makeDeps(worktreePath);

		await expect(runResolveConflictsPhase(deps)).rejects.toThrow(
			/still fails validation after one repair pass/,
		);
		expect(deps.runAgent).toHaveBeenCalledTimes(2);
		expect(commitPreparedTree).not.toHaveBeenCalled();
		expect(assertRemoteHead).not.toHaveBeenCalled();
		expect(deps.delivery.pushBranch).not.toHaveBeenCalled();
	});

	it('still fails cleanly when the repair pass itself cannot run', async () => {
		const worktreePath = makeWorktree();
		writeCleanMigrations(worktreePath, ['0000_first', '0001_second']);
		corruptMigrationsWithPhantomEntry(worktreePath);
		const deps = makeDeps(worktreePath);
		deps.runAgent.mockImplementationOnce(async () => agentResult());
		deps.runAgent.mockImplementationOnce(async () => {
			throw new Error('agent CLI crashed');
		});

		await expect(runResolveConflictsPhase(deps)).rejects.toThrow(
			/still fails validation after one repair pass/,
		);
		expect(deps.runAgent).toHaveBeenCalledTimes(2);
		expect(commitPreparedTree).not.toHaveBeenCalled();
	});

	// Two repositories of one project (issue #685), same PR number and the same
	// head/base SHAs. The merge this phase delivers is a resume key like every other
	// phase's, so it has to name the repository whose PR actually conflicted.
	it('keys its delivery sidecar on the repository it ran in', async () => {
		const runs = createMockProjectRepositoryPair().map((project) => {
			const worktreePath = makeWorktree();
			writeCleanMigrations(worktreePath, ['0000_first', '0001_second']);
			return { worktreePath, deps: makeDeps(worktreePath, project) };
		});
		for (const { deps } of runs) await runResolveConflictsPhase(deps);

		expect(readDeliveryId(runs[1].worktreePath)).not.toBe(readDeliveryId(runs[0].worktreePath));
	});
});

/**
 * Issue #924. The schema now lets the agent say a command failed; this is the
 * half that decides what SWARM does about it — deliver a merge whose failures
 * predate it, refuse one it broke.
 */
describe('runResolveConflictsPhase — verification outcomes (issue #924)', () => {
	const preExisting = [
		{ command: 'npm run lint', outcome: 'passed' },
		{
			command: 'npm test',
			outcome: 'pre-existing-failure',
			detail: 'reproduced identically on the unmerged pristine head in a separate scratch clone',
		},
	];

	it('delivers a merge whose only failures the agent proved are pre-existing', async () => {
		const worktreePath = makeWorktree(preExisting);
		writeCleanMigrations(worktreePath, ['0000_first', '0001_second']);
		const deps = makeDeps(worktreePath);

		const { outcome } = await runResolveConflictsPhase(deps);

		expect(outcome.status).toBe('resolved');
		expect(commitPreparedTree).toHaveBeenCalledTimes(1);
		expect(deps.delivery.pushBranch).toHaveBeenCalledTimes(1);
		expect(deps.delivery.postComment).toHaveBeenCalledTimes(1);
	});

	it('refuses a merge the agent reports it broke, delivering nothing', async () => {
		const worktreePath = makeWorktree([
			{ command: 'npm run build', outcome: 'failed', detail: 'the merged tree does not compile' },
		]);
		writeCleanMigrations(worktreePath, ['0000_first', '0001_second']);
		const deps = makeDeps(worktreePath);

		await expect(runResolveConflictsPhase(deps)).rejects.toThrow(
			/fails verification the agent attributes to the merge itself — `npm run build`: the merged tree does not compile/,
		);
		expect(assertRemoteHead).not.toHaveBeenCalled();
		expect(commitPreparedTree).not.toHaveBeenCalled();
		expect(deps.delivery.pushBranch).not.toHaveBeenCalled();
		expect(deps.delivery.postComment).not.toHaveBeenCalled();
	});

	// The only reason the gate's placement is observable: a refused merge must not
	// spend the migration-journal guard's one repair pass either.
	it('refuses it before the migration repair pass gets an agent run', async () => {
		const worktreePath = makeWorktree([
			{ command: 'npm test', outcome: 'failed', detail: 'four suites the merge broke' },
		]);
		writeCleanMigrations(worktreePath, ['0000_first', '0001_second']);
		corruptMigrationsWithPhantomEntry(worktreePath);
		const deps = makeDeps(worktreePath);

		await expect(runResolveConflictsPhase(deps)).rejects.toThrow(
			/fails verification the agent attributes to the merge itself/,
		);
		expect(deps.runAgent).toHaveBeenCalledTimes(1);
	});

	// …and the other half of that placement: the repair pass runs *after* the gate
	// and its own prompt lets it rewrite the hand-off, so the merge agent's
	// `passed` cannot be the last word on a merge the repair pass then re-tested.
	it('refuses a merge the migration repair pass rewrites as broken', async () => {
		const worktreePath = makeWorktree();
		writeCleanMigrations(worktreePath, ['0000_first', '0001_second']);
		corruptMigrationsWithPhantomEntry(worktreePath);
		const deps = makeDeps(worktreePath);
		deps.runAgent.mockImplementationOnce(async () => agentResult({ sessionId: 'session-1' }));
		deps.runAgent.mockImplementationOnce(async () => {
			repairPhantomEntry(worktreePath);
			rewriteHandoff(worktreePath, {
				verification: [
					{ command: 'npm test', outcome: 'failed', detail: 'four suites the merge broke' },
				],
			});
			return agentResult({ sessionId: 'session-1' });
		});

		await expect(runResolveConflictsPhase(deps)).rejects.toThrow(
			/fails verification the agent attributes to the merge itself — `npm test`: four suites the merge broke/,
		);
		expect(deps.runAgent).toHaveBeenCalledTimes(2);
		expect(assertRemoteHead).not.toHaveBeenCalled();
		expect(commitPreparedTree).not.toHaveBeenCalled();
		expect(deps.delivery.pushBranch).not.toHaveBeenCalled();
		expect(deps.delivery.postComment).not.toHaveBeenCalled();
	});

	// The mirror: the re-read is what delivery uses, so a repair pass that only
	// corrected the result comment gets that comment posted rather than the stale one.
	it('posts the body the migration repair pass left behind', async () => {
		const worktreePath = makeWorktree();
		writeCleanMigrations(worktreePath, ['0000_first', '0001_second']);
		corruptMigrationsWithPhantomEntry(worktreePath);
		const deps = makeDeps(worktreePath);
		deps.runAgent.mockImplementationOnce(async () => agentResult({ sessionId: 'session-1' }));
		deps.runAgent.mockImplementationOnce(async () => {
			repairPhantomEntry(worktreePath);
			rewriteHandoff(worktreePath, { body: 'Merged main; regenerated the migration.' });
			return agentResult({ sessionId: 'session-1' });
		});

		const { outcome } = await runResolveConflictsPhase(deps);

		expect(outcome.status).toBe('resolved');
		expect(deps.delivery.postComment).toHaveBeenCalledWith(
			expect.objectContaining({ body: 'Merged main; regenerated the migration.' }),
		);
	});
});

describe('runResolveConflictsPhase — a CLI that timed itself out (issue #1000)', () => {
	// The live incident, on the phase it was observed on: agy caps its own print
	// mode, writes its notice on stderr, and exits **0**. The exit code alone read
	// as a finished run, so the phase walked on to `readHandoff` and reported
	// `Agent did not write required hand-off resolve_conflicts_handoff.json` —
	// naming the consequence while the cause stayed in `run_output_events`, and
	// settling terminally with no retry.
	const AGY_PRINT_TIMEOUT =
		'[agy] print timeout after 5m0s with turn in progress; returning partial output';
	const selfTimedOut = () =>
		agentResult({
			cli: 'antigravity',
			exitCode: 0,
			stderr: `${AGY_PRINT_TIMEOUT}\n`,
			cliSelfTimeout: AGY_PRINT_TIMEOUT,
			sessionId: 'conversation-1',
		});

	/** A worktree the agent never got to write its hand-off into. */
	function makeEmptyWorktree(): string {
		const root = mkdtempSync(join(tmpdir(), 'swarm-resolve-conflicts-timeout-'));
		roots.push(root);
		return root;
	}

	it('reports the timeout rather than the hand-off the agent never got to write', async () => {
		const deps = makeDeps(makeEmptyWorktree());
		deps.runAgent.mockImplementation(async () => selfTimedOut());

		const error = await runResolveConflictsPhase(deps).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(AgentRunError);
		expect((error as AgentRunError).failure).toEqual({
			kind: 'timeout',
			cliSelfTimeout: AGY_PRINT_TIMEOUT,
		});
		expect((error as AgentRunError).message).toContain(AGY_PRINT_TIMEOUT);
		expect((error as AgentRunError).message).not.toMatch(/did not write required hand-off/);
		// The disposition the timeout kind already carries: the checkout is kept so the
		// deferred retry resumes the CLI's own session rather than starting over.
		expect(deps.worktrees.preserve).toHaveBeenCalled();
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('still reports the timeout when the CLI self-terminated after writing its hand-off', async () => {
		// The detection must not depend on a hand-off being absent: the gate fires at
		// the post-run statement, before any hand-off is read, so a run cut short
		// after writing one is reported just as honestly — and delivers nothing, since
		// the turn demonstrably did not finish.
		const deps = makeDeps(makeWorktree());
		writeCleanMigrations(deps.worktrees.worktreePath('task-508') as string, ['0000_first']);
		deps.runAgent.mockImplementation(async () => selfTimedOut());

		const error = await runResolveConflictsPhase(deps).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(AgentRunError);
		expect((error as AgentRunError).failure.kind).toBe('timeout');
		expect((error as AgentRunError).message).toContain(AGY_PRINT_TIMEOUT);
		expect(commitPreparedTree).not.toHaveBeenCalled();
		expect(deps.delivery.pushBranch).not.toHaveBeenCalled();
	});
});

describe('runResolveConflictsPhase — an exhausted account quota (issue #1013)', () => {
	// Run `8656fb88-9049-46a2-ab3b-f2ebfa393f2d`, on the phase it was observed on:
	// agy hit a 429, retried it internally, was cut by its own print timeout
	// mid-retry, and exited **0** with the quota verdict in its terminal `result`
	// event. SWARM recorded `Agent did not write required hand-off
	// resolve_conflicts_handoff.json`, settled terminally at attempt 0, threw away
	// the reset agy named, and wrote no CLI cool-down — so routing kept sending
	// Antigravity work to an account with none left.
	const quotaExhausted = () =>
		agentResult({
			cli: 'antigravity',
			exitCode: 0,
			stdout: ANTIGRAVITY_QUOTA_LOG_TEXT,
			stderr: `${ANTIGRAVITY_QUOTA_SELF_TIMEOUT}\n`,
			cliSelfTimeout: ANTIGRAVITY_QUOTA_SELF_TIMEOUT,
			antigravityFailure: ANTIGRAVITY_QUOTA_FAILURE,
			sessionId: 'conversation-1',
		});

	/** A worktree the agent never got to write its hand-off into. */
	function makeEmptyWorktree(): string {
		const root = mkdtempSync(join(tmpdir(), 'swarm-resolve-conflicts-quota-'));
		roots.push(root);
		return root;
	}

	it('reports the quota rather than the hand-off the agent never got to write', async () => {
		const deps = makeDeps(makeEmptyWorktree());
		deps.runAgent.mockImplementation(async () => quotaExhausted());

		const error = await runResolveConflictsPhase(deps).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(AgentRunError);
		const failure = (error as AgentRunError).failure;
		// A `rate-limit`, not the `timeout` the same run's self-timeout notice would
		// otherwise have produced: only this kind carries a reset instant and makes the
		// control plane record the machine's cool-down for that CLI.
		expect(failure.kind).toBe('rate-limit');
		expect(failure.resetHint).toContain('in 16h39m20s');
		expect(failure.retryAfter).toBeInstanceOf(Date);
		expect((error as AgentRunError).message).toContain('(rate limited)');
		expect((error as AgentRunError).message).not.toMatch(/did not write required hand-off/);
		// The reset agy named survives into the shared deferral policy rather than
		// being clamped back under it: the retry — and the `(worker, CLI)` cool-down
		// derived from the same answer — lands after the account actually refills.
		const observed = 16 * 60 * 60 * 1000 + 39 * 60 * 1000 + 20 * 1000;
		const now = Date.now();
		expect((failure.retryAfter as Date).getTime() - now).toBeGreaterThan(observed - 5_000);
		const delay = retryDelayForFailure(failure, now);
		expect(delay).toBeGreaterThan(observed - 5_000);
		expect(delay).toBeLessThanOrEqual(observed + RETRY_BUFFER_MS);
		// Deferred and resumable, like every other rate limit: keep the checkout.
		expect(deps.worktrees.preserve).toHaveBeenCalled();
		expect(deps.worktrees.cleanup).not.toHaveBeenCalled();
	});

	it('delivers nothing even when the quota hit landed after a hand-off was written', async () => {
		// The gate fires at the post-run statement, before any hand-off is read, so a
		// run that ran out of quota after writing one is reported just as honestly —
		// and delivers nothing, since the turn demonstrably did not finish.
		const deps = makeDeps(makeWorktree());
		writeCleanMigrations(deps.worktrees.worktreePath('task-508') as string, ['0000_first']);
		deps.runAgent.mockImplementation(async () => quotaExhausted());

		const error = await runResolveConflictsPhase(deps).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(AgentRunError);
		expect((error as AgentRunError).failure.kind).toBe('rate-limit');
		expect(commitPreparedTree).not.toHaveBeenCalled();
		expect(deps.delivery.pushBranch).not.toHaveBeenCalled();
	});
});

describe('buildResolveConflictsPrompt — migration guidance (issue #885)', () => {
	// The phase already interpolates the run's base branch two paragraphs earlier, so the
	// migration paragraph's literal `main` was wrong copy on any project based elsewhere.
	it("names the run's own base branch instead of `main`", () => {
		const prompt = buildResolveConflictsPrompt({
			project: { repo: 'o/r' },
			prNumber: '7',
			prBranch: 'issue-7',
			headSha: 'abc123',
			baseBranch: 'develop',
			baseSha: 'def456',
		});

		expect(prompt).toContain("keep `develop`'s migrations exactly as `develop` has them");
		expect(prompt).toContain('do not renumber or edit any migration `develop` already has');
		expect(prompt).toContain('beyond what `develop` already has');
		expect(prompt).not.toContain('`main`');
	});
});

/**
 * The trap issue #861 named, held as a standing rule: a prompt that states a
 * narrower shape than the schema accepts is what invites the violation. Derived
 * from the schema's own constant, so an outcome added there fails this until the
 * prompt names it.
 */
describe('buildResolveConflictsPrompt — verification contract (issue #924)', () => {
	const prompt = buildResolveConflictsPrompt({
		project: { repo: 'o/r' },
		prNumber: '7',
		prBranch: 'issue-7',
		headSha: 'abc123',
		baseBranch: 'develop',
		baseSha: 'def456',
	});

	it.each(CONFLICT_VERIFICATION_OUTCOMES)('names `%s` as an outcome the agent may report', (o) => {
		expect(prompt).toContain(`\`${o}\``);
	});

	it('sends the explanation to `detail` and no longer asks for outcome:"passed"', () => {
		expect(prompt).toContain(
			'`detail` is a single string and is required for anything that is not',
		);
		expect(prompt).toContain('Never put an explanation in `outcome`');
		expect(prompt).not.toContain('outcome:"passed"');
	});
});

/**
 * The catch-up pass (issue #1001). It runs against a checkout whose merge SWARM
 * has already committed locally and not pushed, so the prompt has to say that —
 * an agent that "cleaned up" with a reset would destroy work existing nowhere
 * else — and it has to restate the same floor and hand-off contract as the first
 * pass, since the phase gates both through the identical code.
 */
describe('buildBaseAdvancedRemergePrompt (issue #1001)', () => {
	const prompt = buildBaseAdvancedRemergePrompt({
		prNumber: '162',
		prBranch: 'issue-90',
		baseBranch: 'develop',
		baseSha: 'e117b52',
		deliveredSha: 'db50b71',
	});

	it('names what moved, and the local commit that must survive the pass', () => {
		expect(prompt).toContain('`origin/develop` advanced to e117b52');
		expect(prompt).toContain('committed your resolved merge locally on "issue-90" as db50b71');
		expect(prompt).toContain('never reset, rebase, amend or force-push it away');
		expect(prompt).toContain('merge `origin/develop` into the checked-out branch again');
	});

	it('restates the first pass’s floor, hand-off contract and phase guard', () => {
		expect(prompt).toContain('You are a SWARM pipeline agent assigned to exactly one phase');
		expect(prompt).toContain('Do not commit, push, comment, or perform any GitHub mutation');
		expect(prompt).toContain(HANDOFF_FILENAMES.resolveConflicts);
		expect(prompt).toContain("keep `develop`'s migrations exactly as `develop` has them");
	});

	it.each(CONFLICT_VERIFICATION_OUTCOMES)('names `%s` as an outcome the agent may report', (o) => {
		expect(prompt).toContain(`\`${o}\``);
	});
});
