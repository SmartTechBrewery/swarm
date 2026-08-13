/**
 * Implementation's deterministic delivery against real git (issue #558).
 *
 * The unit file next door (`implementation.test.ts`) mocks `node:fs` and runs the
 * legacy PR-URL path; this one runs the *production* delivery path — commit,
 * push, PR — over actual repositories, because the behaviour under test is what
 * happens when an attempt is interrupted after it already pushed and the retry
 * lands on a machine holding none of its state.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliResult } from '@/harness/agent-cli.js';
import { runImplementationPhase } from '@/pipeline/implementation.js';
import type { WorkItemBlocker, WorkItemDependent } from '@/pm/types.js';
import {
	DeliveryDivergedError,
	deliveryIdentity,
	type ScmDeliveryProvider,
} from '@/scm/delivery.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { readDeliveryId } from '../../helpers/delivery-sidecar.js';
import {
	createMockProjectConfig,
	createMockProjectRepositoryPair,
	createMockWorkItem,
} from '../../helpers/factories.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const gitEnv = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv, stdio: 'pipe' });
}

/** A bare origin seeded with one commit on `main`. */
function makeOrigin(): string {
	const root = mkdtempSync(join(tmpdir(), 'swarm-impl-delivery-'));
	roots.push(root);
	const origin = join(root, 'origin.git');
	const seed = join(root, 'seed');
	execFileSync('git', ['init', '--bare', '-b', 'main', origin], { env: gitEnv });
	execFileSync('git', ['clone', origin, seed], { env: gitEnv });
	writeFileSync(join(seed, 'README.md'), 'seed\n');
	git(seed, ['add', '.']);
	git(seed, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', 'seed']);
	git(seed, ['push', 'origin', 'main']);
	return origin;
}

/** One worker's checkout of `origin`, on the task branch. */
function makeWorkerCheckout(origin: string, branch: string): string {
	const path = mkdtempSync(join(tmpdir(), 'swarm-impl-worker-'));
	roots.push(path);
	execFileSync('git', ['clone', origin, path], { env: gitEnv });
	git(path, ['checkout', '-q', '-B', branch, 'origin/main']);
	return path;
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
	};
}

/** What the implementer agent leaves behind: an edit plus its hand-off. */
function writeAgentOutput(path: string, note: string): void {
	writeFileSync(join(path, 'feature.txt'), `${note}\n`);
	writeFileSync(
		join(path, 'implementation_handoff.json'),
		JSON.stringify({
			summary: 'Implemented the feature',
			commitSubject: `feat: ${note}`,
			verification: [{ command: 'npm test', outcome: 'passed' }],
			limitations: [],
			readyForDelivery: true,
		}),
	);
}

function makePm() {
	return {
		type: 'github-projects' as const,
		getWorkItem: vi.fn(),
		listWorkItems: vi.fn(),
		findWorkItemByUrlSuffix: vi.fn(async () => undefined),
		findWorkItemForArtifact: vi.fn(async () => undefined),
		findWorkItemByDescriptionMarker: vi.fn(async () => undefined),
		addComment: vi.fn<(id: string, text: string) => Promise<string>>(async () => 'comment-1'),
		findComment: vi.fn<(id: string, marker: string) => Promise<string | undefined>>(
			async () => undefined,
		),
		moveWorkItem: vi.fn<(id: string, status: string) => Promise<void>>(async () => {}),
		createWorkItem: vi.fn(async () => createMockWorkItem()),
		updateWorkItem: vi.fn(async () => {}),
		addLabel: vi.fn(async () => {}),
		supportsDependencies: true,
		supportsAssignees: true,
		listBlockers: vi.fn<() => Promise<WorkItemBlocker[]>>(async () => []),
		listDependents: vi.fn<() => Promise<WorkItemDependent[]>>(async () => []),
		addBlockedBy: vi.fn(async () => {}),
		resolveItemRepository: vi.fn(async () => ({ status: 'unrouted' }) as const),
	};
}

/**
 * A delivery provider backed by the real `origin`: it pushes for real and keeps
 * one PR per branch, so "did a second attempt open a second PR?" is answered by
 * the fixture rather than asserted against a mock's call log alone.
 */
function makeDelivery() {
	const pulls = new Map<string, { number: number; url: string }>();
	const createPullRequest = vi.fn(async (input: { branch: string }) => {
		const pull = {
			number: 555,
			url: `https://github.com/SmartTechBrewery/swarm/pull/555?head=${input.branch}`,
		};
		pulls.set(input.branch, pull);
		return pull;
	});
	const pushBranch = vi.fn(async (cwd: string, branch: string, expectedSha: string) => {
		execFileSync('git', ['push', 'origin', `${expectedSha}:refs/heads/${branch}`], {
			cwd,
			env: gitEnv,
			stdio: 'pipe',
		});
	});
	const delivery = {
		commitIdentity: { name: 'swarm-implementer', email: 'implementer@users.noreply.github.com' },
		findPullRequest: vi.fn(async (branch: string) => pulls.get(branch)),
		createPullRequest,
		pushBranch,
		submitReview: vi.fn(),
		postComment: vi.fn(),
	} as unknown as ScmDeliveryProvider;
	return { delivery, pulls, createPullRequest, pushBranch };
}

/**
 * The phase options one worker runs with, over its own checkout. `project` defaults
 * to the single-repository fixture; the cross-repository case below passes a project
 * scoped to one of two repositories instead.
 */
function makeOptions(
	path: string,
	branch: string,
	delivery: ScmDeliveryProvider,
	project = createMockProjectConfig(),
) {
	const handle: WorktreeHandle = { taskId: '544', path, branch, detached: false };
	const worktrees = {
		provision: vi.fn(async () => handle),
		worktreePath: vi.fn(() => handle.path),
		reuse: vi.fn(async () => undefined),
		cleanup: vi.fn(async () => {}),
	} as unknown as GitWorktreeManager;
	const runAgent = vi.fn(async () => {
		writeAgentOutput(path, 'the implementation');
		return agentResult();
	});
	return {
		project,
		workItem: createMockWorkItem({ id: 'PVTI_item544', title: 'Add the feature' }),
		taskId: '544',
		pm: makePm(),
		worktrees,
		runAgent,
		graft: vi.fn(() => []),
		getToken: vi.fn(async () => 'implementer-token'),
		delivery,
	};
}

/** How many commits the branch on `origin` carries beyond the seed. */
function remoteCommitCount(origin: string, branch: string): number {
	return Number(git(origin, ['rev-list', '--count', branch]).trim());
}

describe('implementation delivery resumption (issue #558)', () => {
	it('re-dispatched onto a different worker after the push, it delivers one commit and one PR', async () => {
		const origin = makeOrigin();
		const branch = 'issue-544';

		// Worker A runs the agent, commits, pushes, opens the PR — then the run is cut
		// short before it finishes reporting (the board write fails), exactly as a
		// control-plane restart mid-phase leaves it.
		const { delivery, createPullRequest, pushBranch } = makeDelivery();
		const workerA = makeWorkerCheckout(origin, branch);
		const optionsA = makeOptions(workerA, branch, delivery);
		optionsA.pm.addComment.mockRejectedValueOnce(new Error('control plane restarted'));
		await expect(runImplementationPhase(optionsA)).rejects.toMatchObject({
			name: 'DeliveryDeferredError',
		});
		const deliveredSha = git(origin, ['rev-parse', branch]).trim();

		// Worker B picks the re-dispatch up. It holds none of A's state: a fresh
		// checkout, no delivery-progress sidecar, no session to resume.
		const workerB = makeWorkerCheckout(origin, branch);
		expect(existsSync(join(workerB, '.swarm_delivery.json'))).toBe(false);
		const optionsB = makeOptions(workerB, branch, delivery);

		const result = await runImplementationPhase(optionsB);

		// The agent never ran a second time, so there is no second implementation to
		// push — which is what produced the unpushable divergent branch.
		expect(optionsB.runAgent).not.toHaveBeenCalled();
		expect(pushBranch).toHaveBeenCalledTimes(1);
		expect(createPullRequest).toHaveBeenCalledTimes(1);
		expect(remoteCommitCount(origin, branch)).toBe(2); // seed + one delivery
		expect(git(origin, ['rev-parse', branch]).trim()).toBe(deliveredSha);

		// And the phase still finishes its remaining work: the PR link on the board
		// and the move to In review.
		expect(result.prUrl).toContain('/pull/555');
		expect(optionsB.pm.addComment).toHaveBeenCalledTimes(1);
		expect(optionsB.pm.moveWorkItem).toHaveBeenLastCalledWith('PVTI_item544', 'inReview');
	});

	it('reuses the PR-link comment an earlier attempt already posted', async () => {
		const origin = makeOrigin();
		const branch = 'issue-544';
		const { delivery } = makeDelivery();
		const workerA = makeWorkerCheckout(origin, branch);
		const optionsA = makeOptions(workerA, branch, delivery);
		// Fails on the closing move, after the PR-link comment has been posted.
		optionsA.pm.moveWorkItem.mockImplementation(async (_id, status) => {
			if (status === 'inReview') throw new Error('board write failed');
		});
		await expect(runImplementationPhase(optionsA)).rejects.toMatchObject({
			name: 'DeliveryDeferredError',
		});
		const posted = optionsA.pm.addComment.mock.calls[0][1];

		// The marker is per-delivery, so the retry recognises its own earlier comment.
		const workerB = makeWorkerCheckout(origin, branch);
		const optionsB = makeOptions(workerB, branch, delivery);
		optionsB.pm.findComment.mockImplementation(async (_id, marker) =>
			posted.includes(marker) ? 'comment-1' : undefined,
		);

		const result = await runImplementationPhase(optionsB);

		expect(result.commentId).toBe('comment-1');
		expect(optionsB.pm.addComment).not.toHaveBeenCalled();
	});

	it('fails terminally, naming the divergence, instead of retrying an unpushable push', async () => {
		const origin = makeOrigin();
		const branch = 'issue-544';
		const { delivery } = makeDelivery();

		// The remote already carries another attempt's commit on this branch.
		const other = makeWorkerCheckout(origin, branch);
		writeFileSync(join(other, 'feature.txt'), 'delivered by the first attempt\n');
		git(other, ['add', '.']);
		git(other, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', 'first']);
		git(other, ['push', 'origin', branch]);
		const remoteSha = git(origin, ['rev-parse', branch]).trim();

		// This worker resumes a delivery whose own commit is not on that history — the
		// state the incident wedged in. `reuse` adopts its checkout, so the agent is
		// skipped and the recorded commit is what gets pushed.
		const worker = makeWorkerCheckout(origin, branch);
		writeFileSync(join(worker, 'feature.txt'), 'a second, divergent implementation\n');
		git(worker, ['add', '.']);
		git(worker, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', 'second']);
		const localSha = git(worker, ['rev-parse', 'HEAD']).trim();
		writeAgentOutput(worker, 'a second, divergent implementation');
		const options = makeOptions(worker, branch, delivery);
		writeFileSync(
			join(worker, '.swarm_delivery.json'),
			JSON.stringify({
				deliveryId: deliveryIdentity([
					'implementation',
					options.project.repo,
					options.taskId,
					branch,
				]),
				commitSha: localSha,
				pushed: false,
			}),
		);
		// A PR is already open on the branch, so nothing here reaches the adoption
		// probe: the resumed delivery owns the attempt.
		await delivery.createPullRequest({ baseBranch: 'main', branch, title: 't', body: 'b' });
		vi.mocked(options.worktrees.reuse).mockResolvedValue({
			taskId: '544',
			path: worker,
			branch,
			detached: false,
		});

		const error = await runImplementationPhase({ ...options, resumeDelivery: true }).catch(
			(e) => e,
		);

		expect(error).toBeInstanceOf(DeliveryDivergedError);
		expect(error.message).toContain(remoteSha);
		expect(error.message).toContain(localSha);
		// Not a deferral: the run settles rather than spending its budget repeating
		// the identical rejection, and the checkout is released rather than preserved.
		expect(error.name).not.toBe('DeliveryDeferredError');
		expect(options.worktrees.cleanup).toHaveBeenCalledWith('544');
		expect(options.runAgent).not.toHaveBeenCalled();
	});
});

/**
 * The same task id and branch in two repositories of one project (issue #685).
 *
 * Implementation's delivery identity is its resume key: an interrupted attempt is
 * re-dispatched and adopts the sidecar it finds. A project-wide identity would let
 * an attempt in repository B adopt repository A's recorded commit and push it to
 * the wrong remote — the failure mode the whole suite above is about, one repository
 * over.
 *
 * *Which* repository a board-driven Implementation runs in is issue #686's decision
 * (a board card names none, so it resolves to the project's default entry today);
 * what is asserted here is only that the key names whichever one the run acted on.
 */
describe('implementation delivery across two repositories of one project (issue #685)', () => {
	it('keys its delivery sidecar on the repository it ran in', async () => {
		const [ANDROID, BACKEND] = createMockProjectRepositoryPair();
		const branch = 'issue-544';

		// A real origin per repository, and a delivery fixture per origin: two
		// repositories share neither a git remote nor a PR namespace.
		const paths: string[] = [];
		for (const project of [ANDROID, BACKEND]) {
			const worker = makeWorkerCheckout(makeOrigin(), branch);
			await runImplementationPhase(makeOptions(worker, branch, makeDelivery().delivery, project));
			paths.push(worker);
		}

		expect(readDeliveryId(paths[1])).not.toBe(readDeliveryId(paths[0]));
	});
});
