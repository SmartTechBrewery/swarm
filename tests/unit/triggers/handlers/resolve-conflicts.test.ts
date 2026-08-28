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
} = vi.hoisted(() => ({
	listConflictCandidates: vi.fn(),
	commentOnPullRequest: vi.fn(),
	scheduleCoalescedJob: vi.fn(),
	claimConflictResolution: vi.fn(),
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
const scm = createFakeScmProvider({
	listConflictCandidates,
	commentOnPullRequest,
	resolvePersonaIdentities: async () => ({ implementer: 'swarm-impl', reviewer: 'swarm-rev' }),
	isSwarmActor: (login: string) => login.startsWith('swarm-'),
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
	authorLogin: 'swarm-impl',
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
});
