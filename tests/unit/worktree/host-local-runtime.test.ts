import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHostLocalWorktreeRuntime } from '@/worktree/host-local-runtime.js';

describe('host-local worktree runtime', () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	function runtime(ownerId: string, live: Set<string>, runId = ownerId) {
		root ??= mkdtempSync(join(tmpdir(), 'swarm-local-worktree-'));
		return createHostLocalWorktreeRuntime({
			repoRoot: root,
			worktreeRoot: '.swarm-workspaces',
			ownerId,
			runId,
			isOwnerLive: (candidate) => live.has(candidate),
		});
	}

	it('allows only one live provisioner to claim a task on this host', async () => {
		const live = new Set(['dispatch-a', 'dispatch-b']);
		const first = runtime('dispatch-a', live);
		const second = runtime('dispatch-b', live);

		expect(await first.tryClaim('swarm', '535', 'token-a')).toBe(true);
		expect(await second.tryClaim('swarm', '535', 'token-b')).toBe(false);
		expect(await second.hasLiveOwner('swarm', '535')).toBe(true);

		await first.release('swarm', '535', 'token-a');
		expect(await second.tryClaim('swarm', '535', 'token-b')).toBe(true);
	});

	it('takes over an orphaned local lease with compare-and-replace serialization', async () => {
		const live = new Set(['dispatch-a', 'dispatch-b']);
		const first = runtime('dispatch-a', live);
		const second = runtime('dispatch-b', live);
		await first.claim('swarm', '535', 'token-a');

		live.delete('dispatch-a');
		expect(await second.hasLiveOwner('swarm', '535')).toBe(false);
		expect(await second.takeOver('swarm', '535', 'token-a', 'token-b')).toBe(true);
		expect(await second.read('swarm', '535')).toBe('token-b');
	});

	it('pins a preserved checkout against other runs while allowing its own retry', async () => {
		const live = new Set(['dispatch-a']);
		const first = runtime('dispatch-a', live, 'run-a');
		await first.claim('swarm', '535', 'token-a');
		await first.preserve('swarm', '535', 'run-a');

		expect(await runtime('dispatch-b', live, 'run-b').isResumablePinned('swarm', '535')).toBe(true);
		expect(await runtime('dispatch-c', live, 'run-a').isResumablePinned('swarm', '535')).toBe(
			false,
		);
		expect(await first.isLeased('swarm', '535')).toBe(false);
	});
});
