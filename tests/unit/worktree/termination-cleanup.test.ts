import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { reconcileTerminatedWorktree } from '@/worktree/termination-cleanup.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs')>();
	return { ...original, existsSync: existsSyncMock };
});

const { isWorktreeLeasedMock, releaseWorktreeLeaseMock } = vi.hoisted(() => ({
	isWorktreeLeasedMock: vi.fn(),
	releaseWorktreeLeaseMock: vi.fn(),
}));
vi.mock('@/worktree/worktree-lease.js', () => ({
	isWorktreeLeased: isWorktreeLeasedMock,
	releaseWorktreeLease: releaseWorktreeLeaseMock,
	claimWorktreeLease: vi.fn(),
}));

// A small fake standing in for the real git-backed manager: each safety gate is
// driven directly so the settlement decision is exercised without a real repo.
class FakeGitWorktreeManager extends GitWorktreeManager {
	clean = true;
	unpushed = false;
	cleanedUpTasks: string[] = [];

	override async isClean(): Promise<boolean> {
		return this.clean;
	}
	override async hasUnpushedWork(): Promise<boolean> {
		return this.unpushed;
	}
	override async cleanup(taskId: string): Promise<void> {
		this.cleanedUpTasks.push(taskId);
	}
}

const PROJECT = createMockProjectConfig({ id: 'p1', repoRoot: '/repo', worktreeRoot: '.wt' });

function makeManager(): FakeGitWorktreeManager {
	return new FakeGitWorktreeManager(PROJECT);
}

describe('reconcileTerminatedWorktree', () => {
	beforeEach(() => {
		existsSyncMock.mockReset().mockReturnValue(true);
		isWorktreeLeasedMock.mockReset().mockResolvedValue(false);
		releaseWorktreeLeaseMock.mockReset().mockResolvedValue(undefined);
	});

	it('treats a missing checkout as already settled and clears any stale lease', async () => {
		existsSyncMock.mockReturnValue(false);
		const manager = makeManager();

		const result = await reconcileTerminatedWorktree(manager, 'p1', '10', null, true);

		expect(result).toEqual({ outcome: 'absent' });
		expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('p1', '10');
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	it('preserves the checkout for a resumable session and releases the live lease', async () => {
		const manager = makeManager();

		const result = await reconcileTerminatedWorktree(manager, 'p1', '10', 'sess-1', true);

		expect(result).toEqual({ outcome: 'preserved', agentSessionId: 'sess-1' });
		// The DB recovery record pins the checkout for retention; the lease is released.
		expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('p1', '10');
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	it('removes a clean, pushed, unleased checkout when there is no session', async () => {
		const manager = makeManager();
		manager.clean = true;
		manager.unpushed = false;

		const result = await reconcileTerminatedWorktree(manager, 'p1', '10', null, true);

		expect(result).toEqual({ outcome: 'removed' });
		expect(manager.cleanedUpTasks).toEqual(['10']);
	});

	it('retains a dirty checkout with a blocked reason rather than removing it', async () => {
		const manager = makeManager();
		manager.clean = false;

		const result = await reconcileTerminatedWorktree(manager, 'p1', '10', null, true);

		expect(result).toEqual({ outcome: 'blocked', blockedReason: 'dirty' });
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	it('retains a checkout with unpushed commits with a blocked reason', async () => {
		const manager = makeManager();
		manager.clean = true;
		manager.unpushed = true;

		const result = await reconcileTerminatedWorktree(manager, 'p1', '10', null, true);

		expect(result).toEqual({ outcome: 'blocked', blockedReason: 'unpushed' });
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	it('retains a checkout owned by a different live run (live-leased) when the stopped run held no lease', async () => {
		isWorktreeLeasedMock.mockResolvedValue(true);
		const manager = makeManager();

		// A deferred run that never took the lease itself: a present lease is foreign.
		const result = await reconcileTerminatedWorktree(manager, 'p1', '10', null, false);

		expect(result).toEqual({ outcome: 'blocked', blockedReason: 'live-leased' });
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	it('ignores the stopped run’s own lease when it held one (no false live-leased block)', async () => {
		isWorktreeLeasedMock.mockResolvedValue(true);
		const manager = makeManager();

		// The running run owns its own lease, so a present lease never blocks removal.
		const result = await reconcileTerminatedWorktree(manager, 'p1', '10', null, true);

		expect(result).toEqual({ outcome: 'removed' });
		expect(isWorktreeLeasedMock).not.toHaveBeenCalled();
		expect(manager.cleanedUpTasks).toEqual(['10']);
	});

	it('fails closed to a blocked reason when git cleanliness validation errors', async () => {
		const manager = makeManager();
		// The real manager's isClean() returns false on any git error; emulate that.
		vi.spyOn(manager, 'isClean').mockResolvedValue(false);

		const result = await reconcileTerminatedWorktree(manager, 'p1', '10', null, true);

		expect(result).toEqual({ outcome: 'blocked', blockedReason: 'dirty' });
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	// The reset path's opt-in capabilities (issue #424). Every case above passes
	// no options and must keep behaving exactly as before.
	describe('reset options', () => {
		it('reclaims a stale lease no live run owns and removes the checkout', async () => {
			isWorktreeLeasedMock.mockResolvedValue(true);
			const manager = makeManager();

			const result = await reconcileTerminatedWorktree(manager, 'p1', '10', null, false, {
				hasLiveOwner: async () => false,
			});

			expect(result).toEqual({ outcome: 'removed', staleLeaseReleased: true });
			expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('p1', '10');
			expect(manager.cleanedUpTasks).toEqual(['10']);
		});

		it('honours a lease a live run still owns', async () => {
			isWorktreeLeasedMock.mockResolvedValue(true);
			const manager = makeManager();

			const result = await reconcileTerminatedWorktree(manager, 'p1', '10', null, false, {
				hasLiveOwner: async () => true,
			});

			expect(result).toEqual({ outcome: 'blocked', blockedReason: 'live-leased' });
			expect(manager.cleanedUpTasks).toEqual([]);
		});

		it('still honours a lease when a live-leased checkout is force-reset', async () => {
			// `force` covers this run's own wedged state, not yanking a live agent's checkout.
			isWorktreeLeasedMock.mockResolvedValue(true);
			const manager = makeManager();

			const result = await reconcileTerminatedWorktree(manager, 'p1', '10', null, false, {
				hasLiveOwner: async () => true,
				discardProtectedWork: true,
			});

			expect(result).toEqual({ outcome: 'blocked', blockedReason: 'live-leased' });
			expect(manager.cleanedUpTasks).toEqual([]);
		});

		it('discards a dirty checkout when the operator forced it', async () => {
			const manager = makeManager();
			manager.clean = false;

			const result = await reconcileTerminatedWorktree(manager, 'p1', '10', null, true, {
				discardProtectedWork: true,
			});

			expect(result).toEqual({ outcome: 'removed', discarded: 'dirty' });
			expect(manager.cleanedUpTasks).toEqual(['10']);
		});

		it('discards unpushed commits when the operator forced it', async () => {
			const manager = makeManager();
			manager.unpushed = true;

			const result = await reconcileTerminatedWorktree(manager, 'p1', '10', null, true, {
				discardProtectedWork: true,
			});

			expect(result).toEqual({ outcome: 'removed', discarded: 'unpushed' });
			expect(manager.cleanedUpTasks).toEqual(['10']);
		});

		it('reclaims a stale lease and retains protected work when the reset was not forced', async () => {
			isWorktreeLeasedMock.mockResolvedValue(true);
			const manager = makeManager();
			manager.clean = false;

			const result = await reconcileTerminatedWorktree(manager, 'p1', '10', null, false, {
				hasLiveOwner: async () => false,
			});

			expect(result).toEqual({ outcome: 'blocked', blockedReason: 'dirty' });
			expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('p1', '10');
			expect(manager.cleanedUpTasks).toEqual([]);
		});

		it('reports the first blocked reason it discarded when both gates fail', async () => {
			const manager = makeManager();
			manager.clean = false;
			manager.unpushed = true;

			const result = await reconcileTerminatedWorktree(manager, 'p1', '10', null, true, {
				discardProtectedWork: true,
			});

			expect(result).toEqual({ outcome: 'removed', discarded: 'dirty' });
			expect(manager.cleanedUpTasks).toEqual(['10']);
		});
	});
});
