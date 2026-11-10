import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type CheckoutDiscardHandlerOptions,
	type CheckoutDiscardReport,
	type CheckoutDiscardResult,
	createCheckoutDiscardHandler,
	discardRunCheckout,
} from '@/transport/checkout-discard.js';
import { type CheckoutDiscard, ControlPlaneMessageSchema } from '@/transport/protocol.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { createHostLocalWorktreeRuntime } from '@/worktree/host-local-runtime.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

/**
 * The daemon side of a reset's checkout discard (issue #1402): the machine a reset
 * moved a run away from removes the checkout it still holds for that run — and only
 * that run's — so a later dispatch of the task there provisions cleanly.
 */

const REQUEST_ID = '14021402-1402-4402-8402-140214021402';
const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_RUN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TASK_ID = '2119-conflicts';
const WORKTREE_ROOT = '.swarm-workspaces';

function frame(overrides: Partial<CheckoutDiscard> = {}): CheckoutDiscard {
	return {
		type: 'checkout-discard',
		requestId: REQUEST_ID,
		runId: RUN_ID,
		projectId: 'p1',
		repository: 'SmartTechBrewery/swarm',
		taskId: TASK_ID,
		worktreeRoot: WORKTREE_ROOT,
		...overrides,
	};
}

describe('checkout-discard frame', () => {
	it('parses as a control-plane message', () => {
		expect(ControlPlaneMessageSchema.parse(frame())).toEqual(frame());
	});
});

describe('discardRunCheckout (real git)', () => {
	let root: string;
	let repoRoot: string;
	const isolatedGitEnv = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
	);
	function git(args: string[], cwd = repoRoot): void {
		execFileSync('git', args, { cwd, env: isolatedGitEnv, stdio: 'ignore' });
	}

	/** A runtime as an assignment of `runId` on this machine would build it. */
	function runtimeFor(runId: string, ownerId: string, inFlight = new Set<string>()) {
		return createHostLocalWorktreeRuntime({
			repoRoot,
			worktreeRoot: WORKTREE_ROOT,
			ownerId,
			runId,
			isOwnerLive: (id) => inFlight.has(id),
		});
	}

	/** The observed shape: a deferred attempt's checkout, dirty, pinned to its run. */
	async function preservedCheckout(runId = RUN_ID): Promise<string> {
		const path = join(repoRoot, WORKTREE_ROOT, `task-${TASK_ID}`);
		git(['worktree', 'add', '-b', 'issue-2113', path, 'main']);
		writeFileSync(join(path, 'staged.txt'), 'half-finished merge\n');
		git(['add', 'staged.txt'], path);
		await runtimeFor(runId, 'dispatch-a').preserve('p1', TASK_ID);
		return path;
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'swarm-checkout-discard-'));
		const remote = join(root, 'remote.git');
		repoRoot = join(root, 'checkout');
		execFileSync('git', ['init', '--bare', '-b', 'main', remote], {
			env: isolatedGitEnv,
			stdio: 'ignore',
		});
		execFileSync('git', ['clone', remote, repoRoot], { env: isolatedGitEnv, stdio: 'ignore' });
		git(['config', 'user.name', 'Test Worker']);
		git(['config', 'user.email', 'worker@example.com']);
		git(['checkout', '-b', 'main']);
		writeFileSync(join(repoRoot, 'README.md'), 'seed\n');
		git(['add', 'README.md']);
		git(['commit', '-m', 'seed']);
		git(['push', 'origin', 'main']);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("discards the reset run's dirty preserved checkout, and a later run provisions cleanly", async () => {
		const path = await preservedCheckout();

		const result = await discardRunCheckout(new Set())(frame(), repoRoot);

		expect(result.outcome).toBe('discarded');
		expect(existsSync(path)).toBe(false);
		// The pin went with it, so a different run of the same task is not blocked.
		const later = runtimeFor(OTHER_RUN_ID, 'dispatch-c');
		expect(await later.isResumablePinned('p1', TASK_ID)).toBe(false);
		expect(await later.isLeased('p1', TASK_ID)).toBe(false);

		const handle = await new GitWorktreeManager(
			createMockProjectConfig({ id: 'p1', repoRoot, worktreeRoot: WORKTREE_ROOT }),
			later,
		).provision(TASK_ID, { runId: OTHER_RUN_ID, branch: 'issue-2113-fresh' });
		expect(handle.path).toBe(path);
		expect(existsSync(join(path, 'staged.txt'))).toBe(false);
	});

	it("keeps a checkout another run's pin protects", async () => {
		const path = await preservedCheckout(OTHER_RUN_ID);

		const result = await discardRunCheckout(new Set())(frame(), repoRoot);

		expect(result.outcome).toBe('retained');
		expect(existsSync(path)).toBe(true);
	});

	it('keeps a checkout a live phase on this machine holds', async () => {
		const path = await preservedCheckout();
		// The restart landed back here and is running: its lease names the same run.
		const inFlight = new Set(['dispatch-live']);
		await runtimeFor(RUN_ID, 'dispatch-live', inFlight).claim('p1', TASK_ID);

		const result = await discardRunCheckout(inFlight)(frame(), repoRoot);

		expect(result.outcome).toBe('retained');
		expect(result.detail).toContain('leased by a live run');
		expect(existsSync(path)).toBe(true);
	});

	it('reports absent when there is no checkout for the task', async () => {
		const result = await discardRunCheckout(new Set())(frame(), repoRoot);

		expect(result.outcome).toBe('absent');
	});
});

describe('createCheckoutDiscardHandler', () => {
	function silentLogger() {
		return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	}

	function harness(overrides: Partial<CheckoutDiscardHandlerOptions> = {}) {
		const discard = vi.fn(
			async (): Promise<CheckoutDiscardResult> => ({ outcome: 'discarded', detail: 'gone' }),
		);
		const report = vi.fn(async (_body: CheckoutDiscardReport) => ({ recorded: true }));
		const inFlight = new Set<string>();
		const shutdown = new AbortController();
		const options: CheckoutDiscardHandlerOptions = {
			checkouts: [{ repoRoot: '/home/ada/swarm', repository: 'SmartTechBrewery/swarm' }],
			controlPlaneUrl: 'http://control-plane.test',
			workerCredential: 'cred',
			inFlight,
			shutdownSignal: shutdown.signal,
			discard,
			report,
			logger: silentLogger(),
			...overrides,
		};
		return { handle: createCheckoutDiscardHandler(options), discard, report, inFlight, shutdown };
	}

	it('discards under the checkout of the frame’s repository and reports the outcome', async () => {
		const { handle, discard, report, inFlight } = harness();
		let ownedDuringDiscard = false;
		discard.mockImplementation(async () => {
			ownedDuringDiscard = inFlight.size === 1;
			return { outcome: 'discarded', detail: 'gone' };
		});

		handle(frame());

		await vi.waitFor(() => expect(report).toHaveBeenCalled());
		expect(discard).toHaveBeenCalledWith(frame(), '/home/ada/swarm');
		expect(report).toHaveBeenCalledWith({
			requestId: REQUEST_ID,
			outcome: 'discarded',
			detail: 'gone',
		});
		// The discard joins the in-flight set while it runs, and leaves it after.
		expect(ownedDuringDiscard).toBe(true);
		expect(inFlight.size).toBe(0);
	});

	it('reports absent for a repository this worker holds no checkout of', async () => {
		const { handle, discard, report } = harness();

		handle(frame({ repository: 'SmartTechBrewery/elsewhere' }));

		await vi.waitFor(() => expect(report).toHaveBeenCalled());
		expect(discard).not.toHaveBeenCalled();
		expect(report.mock.calls[0]?.[0]).toMatchObject({ outcome: 'absent' });
	});

	it('never redoes a handled request, but re-sends a report that did not land', async () => {
		const { handle, discard, report } = harness();
		report.mockRejectedValueOnce(new Error('control plane down'));

		handle(frame());
		await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
		handle(frame());
		await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
		// Let the re-sent report's settlement land before the next re-push.
		await new Promise((resolve) => setTimeout(resolve, 10));
		handle(frame());
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(discard).toHaveBeenCalledTimes(1);
		expect(report).toHaveBeenCalledTimes(2);
	});

	it('abandons a request to a shutdown without reporting it', async () => {
		const { handle, discard, report, shutdown } = harness();
		shutdown.abort();

		handle(frame());
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(discard).not.toHaveBeenCalled();
		expect(report).not.toHaveBeenCalled();
	});
});
