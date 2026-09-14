import { describe, expect, it, vi } from 'vitest';

// The gate's default lookups reach these modules; mock at the boundary so the
// suite stays hermetic even though every test below injects its own deps.
vi.mock('@/db/repositories/runsRepository.js', () => ({
	hasResumableDeferredRun: vi.fn(async () => false),
}));
vi.mock('@/worktree/worktree-lease.js', () => ({
	isWorktreeLeased: vi.fn(async () => false),
}));

import {
	evaluateWorktreeLiveness,
	evaluateWorktreeReclaim,
	type WorktreeSafetyChecker,
} from '@/worktree/reclaim.js';

const yes = async () => true;
const no = async () => false;

function checker(isClean: boolean, hasUnpushed: boolean): WorktreeSafetyChecker {
	return {
		isClean: async () => isClean,
		hasUnpushedWork: async () => hasUnpushed,
	};
}

describe('evaluateWorktreeReclaim', () => {
	it('reclaims a free, unpinned, clean, fully-pushed checkout', async () => {
		const decision = await evaluateWorktreeReclaim(checker(true, false), 'p', 't', {
			isLeased: no,
			isResumablePinned: no,
		});
		expect(decision).toEqual({ safe: true });
	});

	it('blocks live-leased ahead of every other protection', async () => {
		const decision = await evaluateWorktreeReclaim(checker(false, true), 'p', 't', {
			isLeased: yes,
			isResumablePinned: yes,
		});
		expect(decision).toMatchObject({ safe: false, reason: 'live-leased' });
	});

	it('blocks resumable-owner when unleased but still pinned', async () => {
		const decision = await evaluateWorktreeReclaim(checker(false, true), 'p', 't', {
			isLeased: no,
			isResumablePinned: yes,
		});
		expect(decision).toMatchObject({ safe: false, reason: 'resumable-owner' });
	});

	it('blocks dirty when free and unpinned but not clean', async () => {
		const decision = await evaluateWorktreeReclaim(checker(false, false), 'p', 't', {
			isLeased: no,
			isResumablePinned: no,
		});
		expect(decision).toMatchObject({ safe: false, reason: 'dirty' });
	});

	it('blocks unpushed when clean but carrying unpushed commits', async () => {
		const decision = await evaluateWorktreeReclaim(checker(true, true), 'p', 't', {
			isLeased: no,
			isResumablePinned: no,
		});
		expect(decision).toMatchObject({ safe: false, reason: 'unpushed' });
	});

	it('short-circuits before the content checks when the checkout is leased', async () => {
		let cleanChecked = false;
		const worktrees: WorktreeSafetyChecker = {
			isClean: async () => {
				cleanChecked = true;
				return true;
			},
			hasUnpushedWork: async () => false,
		};
		await evaluateWorktreeReclaim(worktrees, 'p', 't', { isLeased: yes, isResumablePinned: no });
		expect(cleanChecked).toBe(false);
	});
});

// The two liveness checks were extracted so the age-based abandoned sweep
// (`src/worktree/abandoned.ts`, issue #951) and the reclaim gate cannot form two
// opinions about what "live" means. These guard that they stay one.
describe('evaluateWorktreeLiveness', () => {
	it('clears a checkout that is neither leased nor pinned', async () => {
		const decision = await evaluateWorktreeLiveness('p', 't', {
			isLeased: no,
			isResumablePinned: no,
		});
		expect(decision).toEqual({ safe: true });
	});

	it('reports live-leased ahead of resumable-owner', async () => {
		const decision = await evaluateWorktreeLiveness('p', 't', {
			isLeased: yes,
			isResumablePinned: yes,
		});
		expect(decision).toMatchObject({ safe: false, reason: 'live-leased' });
	});

	it('reports resumable-owner when unleased but still pinned', async () => {
		const decision = await evaluateWorktreeLiveness('p', 't', {
			isLeased: no,
			isResumablePinned: yes,
		});
		expect(decision).toMatchObject({ safe: false, reason: 'resumable-owner' });
	});

	it('answers exactly what the full gate reports for the same state', async () => {
		for (const [isLeased, isResumablePinned] of [
			[no, no],
			[yes, no],
			[no, yes],
			[yes, yes],
		] as const) {
			const deps = { isLeased, isResumablePinned };
			const liveness = await evaluateWorktreeLiveness('p', 't', deps);
			if (liveness.safe) continue;
			// Clean and fully pushed, so the gate can only be stopped by liveness.
			expect(await evaluateWorktreeReclaim(checker(true, false), 'p', 't', deps)).toEqual(liveness);
		}
	});
});
