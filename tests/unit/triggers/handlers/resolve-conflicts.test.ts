import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createFakeScmProvider,
	createMockProjectConfig,
	createMockScmTriggerContext,
} from '../../../helpers/factories.js';

const {
	listConflictCandidates,
	commentOnPullRequest,
	scheduleCoalescedJob,
	claimConflictResolution,
	hasRunForTask,
} = vi.hoisted(() => ({
	listConflictCandidates: vi.fn(),
	commentOnPullRequest: vi.fn(),
	scheduleCoalescedJob: vi.fn(),
	claimConflictResolution: vi.fn(),
	hasRunForTask: vi.fn(),
}));

// The work-item origin gate (issue #836) reads run history; mock just that read,
// keeping the real `isSwarmManagedPullRequest` so a candidate's head branch
// genuinely has to decode under the project's `branchPrefix`. Defaults to "SWARM
// ran Implementation for this item" — the common path.
vi.mock('@/db/repositories/runsRepository.js', async (importActual) => ({
	...(await importActual<typeof import('@/db/repositories/runsRepository.js')>()),
	hasRunForTask,
}));

vi.mock('@/dispatch/dispatcher.js', () => ({ scheduleCoalescedDispatch: scheduleCoalescedJob }));
vi.mock('@/triggers/resolve-conflicts-dedup.js', () => ({
	claimConflictResolution,
	buildConflictResolutionKey: (repo: string, prNumber: string, headSha: string, baseSha: string) =>
		`${repo}:${prNumber}:${headSha}:${baseSha}`,
}));

import { createResolveConflictsTrigger } from '@/triggers/handlers/resolve-conflicts.js';

const project = createMockProjectConfig({ repo: 'acme/widgets' });

// Every source-control read/write the handler performs goes through the injected
// `SCMProvider`, so the fake *is* the seam under test — no GitHub module is mocked.
// `createFakeScmProvider` throws on any unstubbed method, so leaving
// `resolvePersonaIdentities` / `isSwarmActor` unstubbed asserts the handler no
// longer consults persona identity at all (issue #836).
const scm = createFakeScmProvider({
	listConflictCandidates,
	commentOnPullRequest,
});

const mergedEvent = createMockScmTriggerContext({
	project,
	scm,
	event: {
		kind: 'pull-request',
		action: 'closed',
		repoFullName: project.repo,
		isCommentEvent: false,
		merged: true,
		baseBranch: 'main',
	},
});
const candidate = {
	number: 42,
	headBranch: 'issue-42',
	headSha: 'head123',
	baseBranch: 'main',
	baseSha: 'base456',
	mergeable: false,
	// A federated SWARM PR is authored by the worker operator's own account
	// (ADR-004 §3), which is neither persona — the reported failure (issue #836).
	authorLogin: 'Karolina90',
	// `listConflictCandidates` lists only open pull requests, which is why this
	// trigger needs no closed-PR guard of its own (issue #772): a candidate that
	// closes simply drops out of the list on the next recheck.
	state: 'open' as const,
};

describe('resolve-conflicts trigger', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listConflictCandidates.mockResolvedValue([candidate]);
		claimConflictResolution.mockResolvedValue(true);
		scheduleCoalescedJob.mockResolvedValue(undefined);
		hasRunForTask.mockResolvedValue(true);
	});

	it('matches only a merged pull-request `closed` event', () => {
		const trigger = createResolveConflictsTrigger();
		expect(trigger.matches(mergedEvent)).toBe(true);
		expect(
			trigger.matches({ ...mergedEvent, event: { ...mergedEvent.event, merged: false } }),
		).toBe(false);
	});

	it('fans out candidate checks without dispatching speculatively', async () => {
		const result = await createResolveConflictsTrigger().handle(mergedEvent);
		expect(result).toBeNull();
		expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
	});

	it('dispatches only a confirmed conflict and claims its head/base state', async () => {
		const result = await createResolveConflictsTrigger().handle({
			...mergedEvent,
			event: { ...mergedEvent.event, conflictPrNumber: '42' },
		});
		expect(claimConflictResolution).toHaveBeenCalledWith('acme/widgets:42:head123:base456');
		expect(hasRunForTask).toHaveBeenCalledWith(project.id, '42', 'implementation');
		expect(result).toMatchObject({
			phase: 'resolve-conflicts',
			prNumber: '42',
			taskId: '42-conflicts',
		});
	});

	it('does not dispatch a clean or merely behind PR', async () => {
		listConflictCandidates.mockResolvedValue([{ ...candidate, mergeable: true }]);
		const result = await createResolveConflictsTrigger().handle({
			...mergedEvent,
			event: { ...mergedEvent.event, conflictPrNumber: '42' },
		});
		expect(result).toBeNull();
		expect(claimConflictResolution).not.toHaveBeenCalled();
	});

	it('coalesces a delayed retry while mergeability is unknown', async () => {
		listConflictCandidates.mockResolvedValue([{ ...candidate, mergeable: null }]);
		const result = await createResolveConflictsTrigger().handle({
			...mergedEvent,
			event: { ...mergedEvent.event, conflictPrNumber: '42' },
		});
		expect(result).toBeNull();
		expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
	});

	it('bypasses conflict resolution claim on retry (when runId is present)', async () => {
		const result = await createResolveConflictsTrigger().handle({
			...mergedEvent,
			runId: 'existing-run-id',
			event: { ...mergedEvent.event, conflictPrNumber: '42' },
		});
		expect(claimConflictResolution).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			phase: 'resolve-conflicts',
			prNumber: '42',
			taskId: '42-conflicts',
		});
	});

	it('reuses the held conflict claim on a prioritized continuation retry', async () => {
		const result = await createResolveConflictsTrigger().handle({
			...mergedEvent,
			continuationDispatchClaimed: true,
			event: { ...mergedEvent.event, conflictPrNumber: '42' },
		});
		expect(claimConflictResolution).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			phase: 'resolve-conflicts',
			prNumber: '42',
			taskId: '42-conflicts',
		});
	});

	describe('work-item origin gate (issue #836)', () => {
		it('does not pick up a hand-written PR by the same operator account', async () => {
			listConflictCandidates.mockResolvedValue([{ ...candidate, headBranch: 'hotfix-login' }]);
			const result = await createResolveConflictsTrigger().handle({
				...mergedEvent,
				event: { ...mergedEvent.event, conflictPrNumber: '42' },
			});
			expect(result).toBeNull();
			expect(claimConflictResolution).not.toHaveBeenCalled();
			// A branch outside the project's prefix is a definitive no and costs no query.
			expect(hasRunForTask).not.toHaveBeenCalled();
		});

		it('does not pick up a task-shaped branch SWARM never ran Implementation for', async () => {
			hasRunForTask.mockResolvedValue(false);
			const result = await createResolveConflictsTrigger().handle({
				...mergedEvent,
				event: { ...mergedEvent.event, conflictPrNumber: '42' },
			});
			expect(result).toBeNull();
			expect(claimConflictResolution).not.toHaveBeenCalled();
		});

		it('skips a non-managed candidate before it can spend the mergeability budget', async () => {
			hasRunForTask.mockResolvedValue(false);
			listConflictCandidates.mockResolvedValue([{ ...candidate, mergeable: null }]);
			const result = await createResolveConflictsTrigger().handle({
				...mergedEvent,
				event: { ...mergedEvent.event, conflictPrNumber: '42' },
			});
			expect(result).toBeNull();
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		});

		it('fans out only to candidates SWARM manages', async () => {
			listConflictCandidates.mockResolvedValue([
				candidate,
				{ ...candidate, number: 79, headBranch: 'contributor-patch' },
			]);
			await createResolveConflictsTrigger().handle(mergedEvent);
			expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
			expect(scheduleCoalescedJob).toHaveBeenCalledWith(
				expect.objectContaining({
					event: expect.objectContaining({ conflictPrNumber: '42' }),
				}),
				'resolve-conflicts:acme/widgets:42:main',
				0,
			);
		});

		it('keeps a candidate whose ownership lookup failed rather than dropping it', async () => {
			hasRunForTask.mockRejectedValue(new Error('connection reset'));
			await createResolveConflictsTrigger().handle(mergedEvent);
			expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
		});

		it('costs one ownership lookup on the per-PR path, whatever else is open', async () => {
			listConflictCandidates.mockResolvedValue([
				candidate,
				{ ...candidate, number: 79, headBranch: 'issue-79' },
			]);
			await createResolveConflictsTrigger().handle({
				...mergedEvent,
				event: { ...mergedEvent.event, conflictPrNumber: '42' },
			});
			expect(hasRunForTask).toHaveBeenCalledOnce();
		});

		it('defers the per-PR path while ownership stays unresolved', async () => {
			hasRunForTask.mockRejectedValue(new Error('connection reset'));
			const result = await createResolveConflictsTrigger().handle({
				...mergedEvent,
				event: { ...mergedEvent.event, conflictPrNumber: '42' },
			});
			expect(result).toBeNull();
			expect(scheduleCoalescedJob).toHaveBeenCalledWith(
				expect.anything(),
				'resolve-conflicts:acme/widgets:42:main',
				30_000,
			);
			expect(claimConflictResolution).not.toHaveBeenCalled();
		});

		it('stops at the recheck cap without dispatching or commenting', async () => {
			hasRunForTask.mockRejectedValue(new Error('connection reset'));
			const result = await createResolveConflictsTrigger().handle({
				...mergedEvent,
				recheckAttempt: 20,
				event: { ...mergedEvent.event, conflictPrNumber: '42' },
			});
			expect(result).toBeNull();
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
			expect(claimConflictResolution).not.toHaveBeenCalled();
			expect(commentOnPullRequest).not.toHaveBeenCalled();
		});
	});
});
