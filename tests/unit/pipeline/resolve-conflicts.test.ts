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

import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import { runResolveConflictsPhase } from '@/pipeline/resolve-conflicts.js';
import {
	assertRemoteHead,
	commitPreparedTree,
	HANDOFF_FILENAMES,
	type ScmDeliveryProvider,
} from '@/scm/delivery.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
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
function makeWorktree(): string {
	const root = mkdtempSync(join(tmpdir(), 'swarm-resolve-conflicts-'));
	roots.push(root);
	writeFileSync(
		join(root, HANDOFF_FILENAMES.resolveConflicts),
		JSON.stringify({
			status: 'resolved',
			body: 'Merged main; resolved every conflict.',
			verification: [{ command: 'npm test', outcome: 'passed' }],
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
