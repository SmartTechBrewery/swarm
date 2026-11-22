import { describe, expect, it, vi } from 'vitest';

import type { ProjectConfig, ProjectRecord } from '@/config/schema.js';
import type { ActiveDispatchTaskRef } from '@/db/repositories/dispatchesRepository.js';
import type { RunRow, TaskActivityRow } from '@/db/repositories/runsRepository.js';
import {
	RERUN_SETTLE_MS,
	RERUN_SETTLE_RECHECK_DELAY_MS,
} from '@/dispatch/approved-head-checks-rerun.js';
import type { ItemLivenessPolicy } from '@/dispatch/item-liveness.js';
import type { ResolveProblemRedHeadCandidate } from '@/dispatch/resolve-problem.js';
import { resolveProblemRedHeadDedupKey } from '@/dispatch/resolve-problem-keys.js';
import {
	probeRedHead,
	RED_HEAD_LOOKBACK_MS,
	RED_HEAD_QUIET_MS,
	RED_HEAD_SWEEP_INTERVAL_MS,
	type RedHeadHandledReads,
	type RedHeadProbe,
	redHeadCandidates,
	redHeadHandled,
} from '@/dispatch/resolve-problem-red-head.js';
import {
	dispatchResolveProblemForRedHeads,
	RESOLVE_PROBLEM_DELAY_MS,
	RESOLVE_PROBLEM_LOOKBACK_MS,
} from '@/dispatch/resolve-problem-trigger.js';
import { SHARED_CHECK_EPISODE_MAX_AGE_MS } from '@/dispatch/shared-check-failure.js';
import type { AggregateCheckStatus, PullRequestDetails } from '@/scm/types.js';
import { operatorHandoffDiagnosis } from '@/worker/failure-diagnosis.js';
import { createMockProjectRecord } from '../../helpers/factories.js';

const REPO = 'SmartTechBrewery/under-control-platform';
const PROJECT = 'under-control-platform';
const PR = '2401';
const UPDATED_HEAD = '372520d3';

/** 2026-11-15, the incident's day. */
const at = (hhmm: string): Date => new Date(`2026-11-15T${hhmm}:00.000Z`);

function activity(overrides: Partial<TaskActivityRow>): TaskActivityRow {
	return {
		projectId: PROJECT,
		repository: REPO,
		taskId: PR,
		runId: 'run',
		phase: 'review',
		status: 'completed',
		prNumber: PR,
		prTitle: null,
		workItemId: null,
		workItemTitle: null,
		workItemUrl: null,
		producedPrUrl: null,
		reviewVerdict: null,
		reviewAutomationOutcome: null,
		reviewMergeOutcome: null,
		failureDiagnosisKind: null,
		lastActivityAt: at('12:03'),
		liveRunCount: 0,
		mergedRunCount: 0,
		...overrides,
	};
}

/**
 * The incident (issue #1459, `under-control-platform#2401`): Implementation opened
 * the pull request, Review approved head `5392bdf1`, merge automation brought it up
 * to date onto a head whose CI went red and refused the merge (`not-eligible`), and
 * Respond-to-CI settled `no-fix` at 12:03 — then nothing.
 */
const INCIDENT: TaskActivityRow[] = [
	activity({
		taskId: '2386',
		runId: 'run-impl',
		phase: 'implementation',
		prNumber: null,
		producedPrUrl: `https://github.com/${REPO}/pull/${PR}`,
		workItemId: 'card-2386',
		lastActivityAt: at('10:00'),
	}),
	activity({
		runId: 'run-review',
		phase: 'review',
		reviewVerdict: 'approve',
		reviewMergeOutcome: 'not-eligible',
		workItemId: 'card-2386',
		lastActivityAt: at('11:53'),
	}),
	activity({
		taskId: `${PR}-ci`,
		runId: 'run-ci',
		phase: 'respond-to-ci',
		workItemId: 'card-2386',
		lastActivityAt: at('12:03'),
	}),
];

const AUTO_MERGE: Record<string, ItemLivenessPolicy> = {
	[PROJECT]: { planningAutoAdvance: false, autoMergeRepositories: [REPO] },
};
const NO_AUTO_MERGE: Record<string, ItemLivenessPolicy> = {
	[PROJECT]: { planningAutoAdvance: false, autoMergeRepositories: [] },
};

describe('red-head bounds (issue #1459)', () => {
	it('match the failed-run leg, not the 2 h stall window', () => {
		expect(RED_HEAD_QUIET_MS).toBe(RESOLVE_PROBLEM_DELAY_MS);
		expect(RED_HEAD_LOOKBACK_MS).toBe(RESOLVE_PROBLEM_LOOKBACK_MS);
		expect(RED_HEAD_QUIET_MS + RED_HEAD_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(30 * 60 * 1000);
	});
});

describe('resolveProblemRedHeadDedupKey (issue #1459)', () => {
	it('is one key per (project, repository, pull request, head) — a new head is a new key', () => {
		const head = { projectId: PROJECT, repository: REPO, prNumber: PR, headSha: UPDATED_HEAD };
		expect(resolveProblemRedHeadDedupKey(head)).toBe(
			`resolve-problem:red-head:${PROJECT}:${REPO}:${PR}:${UPDATED_HEAD}`,
		);
		expect(resolveProblemRedHeadDedupKey({ ...head, headSha: 'f00' })).not.toBe(
			resolveProblemRedHeadDedupKey(head),
		);
	});
});

describe('redHeadCandidates (issue #1459)', () => {
	it('takes the incident’s pull request once it has been quiet for the bound', () => {
		expect(redHeadCandidates(INCIDENT, [], AUTO_MERGE, at('12:10'))).toEqual([]);
		expect(redHeadCandidates(INCIDENT, [], AUTO_MERGE, at('12:14'))).toEqual([
			{
				projectId: PROJECT,
				repository: REPO,
				prNumber: PR,
				latestRunId: 'run-ci',
				taskId: `${PR}-ci`,
				workItemId: 'card-2386',
				autoMerge: true,
			},
		]);
	});

	it('leaves a pull request with a live run, a queued dispatch or a merge alone', () => {
		const now = at('12:30');
		const live = INCIDENT.map((row) =>
			row.runId === 'run-ci' ? { ...row, liveRunCount: 1 } : row,
		);
		const queued: ActiveDispatchTaskRef[] = [
			{ projectId: PROJECT, taskId: `${PR}-ci`, phase: 'respond-to-ci' },
		];
		const merged = INCIDENT.map((row) =>
			row.runId === 'run-review' ? { ...row, mergedRunCount: 1 } : row,
		);
		expect(redHeadCandidates(live, [], AUTO_MERGE, now)).toEqual([]);
		expect(redHeadCandidates(INCIDENT, queued, AUTO_MERGE, now)).toEqual([]);
		expect(redHeadCandidates(merged, [], AUTO_MERGE, now)).toEqual([]);
	});

	it('ignores Resolve problem’s own dispatches when deciding nothing is queued', () => {
		const own: ActiveDispatchTaskRef[] = [
			{ projectId: PROJECT, taskId: `${PR}-ci`, phase: 'resolve-problem' },
		];
		expect(redHeadCandidates(INCIDENT, own, AUTO_MERGE, at('12:30'))).toHaveLength(1);
	});

	it('leaves a failed latest run to the other legs, and a review-cap stop to the operator', () => {
		const now = at('12:30');
		const failed = INCIDENT.map((row) =>
			row.runId === 'run-ci' ? { ...row, status: 'failed' } : row,
		);
		const capped = [
			activity({
				runId: 'run-review',
				reviewVerdict: 'request-changes',
				reviewAutomationOutcome: 'manual-intervention-required',
			}),
		];
		expect(redHeadCandidates(failed, [], AUTO_MERGE, now)).toEqual([]);
		expect(redHeadCandidates(capped, [], AUTO_MERGE, now)).toEqual([]);
	});

	it('takes an approval with merge automation on, and leaves one waiting for a person to merge', () => {
		const approved = [activity({ runId: 'run-review', reviewVerdict: 'approve' })];
		const now = at('12:30');
		expect(redHeadCandidates(approved, [], AUTO_MERGE, now)).toHaveLength(1);
		expect(redHeadCandidates(approved, [], NO_AUTO_MERGE, now)).toEqual([]);
	});

	it('takes a not-yet-approved pull request whether or not merge automation is on', () => {
		const now = at('12:30');
		expect(redHeadCandidates(INCIDENT, [], NO_AUTO_MERGE, now)).toEqual([
			expect.objectContaining({ prNumber: PR, autoMerge: false }),
		]);
	});

	it('never takes a board card', () => {
		expect(redHeadCandidates([INCIDENT[0]], [], AUTO_MERGE, at('12:30'))).toEqual([]);
	});
});

function provider(
	pr: Partial<PullRequestDetails>,
	checks: AggregateCheckStatus,
): NonNullable<Parameters<typeof probeRedHead>[2]> {
	return {
		getPullRequest: vi.fn(async () => ({ state: 'open', headSha: UPDATED_HEAD, ...pr }) as never),
		getAggregateCheckStatus: vi.fn(async () => checks),
	};
}

const RED: AggregateCheckStatus = {
	totalCount: 2,
	checkRuns: [
		{ name: 'build', status: 'completed', conclusion: 'success' },
		{ name: 'integration', status: 'completed', conclusion: 'failure' },
	],
};
const CANCELLED: AggregateCheckStatus = {
	totalCount: 1,
	checkRuns: [{ name: 'integration', status: 'completed', conclusion: 'cancelled' }],
};
const RUNNING: AggregateCheckStatus = {
	totalCount: 1,
	checkRuns: [{ name: 'integration', status: 'in_progress', conclusion: null }],
};
const GREEN: AggregateCheckStatus = {
	totalCount: 1,
	checkRuns: [{ name: 'integration', status: 'completed', conclusion: 'success' }],
};

describe('probeRedHead (issue #1459)', () => {
	const project = { id: PROJECT, repo: REPO } as ProjectConfig;

	it('reports a failed or cancelled check on the open head as red, naming it', async () => {
		await expect(probeRedHead(project, PR, provider({}, RED))).resolves.toEqual({
			state: 'red',
			headSha: UPDATED_HEAD,
			failedChecks: ['integration'],
		});
		await expect(probeRedHead(project, PR, provider({}, CANCELLED))).resolves.toMatchObject({
			state: 'red',
		});
	});

	it('does not report a running (a re-run in progress) or green head as red', async () => {
		await expect(probeRedHead(project, PR, provider({}, RUNNING))).resolves.toEqual({
			state: 'not-red',
			headSha: UPDATED_HEAD,
			checks: 'defer',
		});
		await expect(probeRedHead(project, PR, provider({}, GREEN))).resolves.toMatchObject({
			state: 'not-red',
			checks: 'review',
		});
	});

	it('reports a closed or merged pull request without reading its checks', async () => {
		const scm = provider({ state: 'closed' }, RED);
		await expect(probeRedHead(project, PR, scm)).resolves.toEqual({ state: 'not-open' });
		expect(scm.getAggregateCheckStatus).not.toHaveBeenCalled();
	});
});

describe('redHeadHandled (issue #1459)', () => {
	const key = { projectId: PROJECT, repository: REPO, prNumber: PR, headSha: UPDATED_HEAD };
	const now = at('12:30');
	const reads = (
		slot: Awaited<ReturnType<RedHeadHandledReads['getApprovedHeadSlot']>>,
		updated?: Awaited<ReturnType<RedHeadHandledReads['findUpdatedHeadReviewRun']>>,
		sharedCheck?: string,
	): RedHeadHandledReads => ({
		getApprovedHeadSlot: vi.fn(async () => slot),
		findUpdatedHeadReviewRun: vi.fn(async () => updated),
		findStandingEpisodeCheckForHead: vi.fn(async () => sharedCheck),
	});

	it('is nothing for the incident’s head: no approval at it, no re-run, no hand-off', async () => {
		await expect(redHeadHandled(key, true, now, reads(undefined))).resolves.toBeUndefined();
	});

	it('is a recorded "Approved head needs the operator" hand-off', async () => {
		const handed = reads({
			checksRerunAt: at('12:00'),
			checksRerunAttempts: 1,
			operatorNotifiedAt: at('12:05'),
			adjudicatedFailure: null,
			failureChangeRoutedAt: null,
		});
		await expect(redHeadHandled(key, true, now, handed)).resolves.toMatch(/handed .* operator/);
	});

	const approvedSlot = (checksRerunAttempts: number, agoMs: number) => ({
		checksRerunAt: new Date(now.getTime() - agoMs),
		checksRerunAttempts,
		operatorNotifiedAt: null,
		adjudicatedFailure: null,
		failureChangeRoutedAt: null,
	});

	it('is an approved head’s last re-run still settling, and not one past its window', async () => {
		await expect(
			redHeadHandled(key, true, now, reads(approvedSlot(3, RERUN_SETTLE_MS - 1000))),
		).resolves.toMatch(/re-run 3 of 3 of approved head/);
		// Every re-run spent and settled with no notice yet: left to the policy's hand-off.
		await expect(
			redHeadHandled(key, true, now, reads(approvedSlot(3, RERUN_SETTLE_MS + 1000))),
		).resolves.toBeUndefined();
	});

	it('is an approved head whose next spaced re-run is still to come (issue #1463)', async () => {
		const dueAt = new Date(now.getTime() + 10 * 60_000).toISOString();
		await expect(redHeadHandled(key, true, now, reads(approvedSlot(1, 5 * 60_000)))).resolves.toBe(
			`SWARM has re-run 1 of 3 of approved head ${UPDATED_HEAD}'s checks; the next is due at ${dueAt}`,
		);
	});

	it('stops counting a waiting approved head once its re-run is past due and past the grace', async () => {
		const pastGrace = 15 * 60_000 + RERUN_SETTLE_RECHECK_DELAY_MS + 1000;
		await expect(
			redHeadHandled(key, true, now, reads(approvedSlot(1, pastGrace))),
		).resolves.toBeUndefined();
	});

	it('is an updated head’s re-run still settling, on this head only', async () => {
		const fresh = new Date(now.getTime() - 1000);
		await expect(
			redHeadHandled(
				key,
				true,
				now,
				reads(undefined, { id: 'r', checksRerunHeadSha: UPDATED_HEAD, checksRerunAt: fresh }),
			),
		).resolves.toMatch(/updated head .* settling/);
		await expect(
			redHeadHandled(
				key,
				true,
				now,
				reads(undefined, { id: 'r', checksRerunHeadSha: 'older', checksRerunAt: fresh }),
			),
		).resolves.toBeUndefined();
	});

	it('is an approved head on a repository without auto-merge — a person’s merge gate', async () => {
		const approved = reads({
			checksRerunAt: null,
			checksRerunAttempts: 0,
			operatorNotifiedAt: null,
			adjudicatedFailure: null,
			failureChangeRoutedAt: null,
		});
		await expect(redHeadHandled(key, false, now, approved)).resolves.toMatch(/person to merge/);
		await expect(redHeadHandled(key, true, now, approved)).resolves.toBeUndefined();
	});

	it('is a head a standing shared check failure covers, read within the episode age (issue #1464)', async () => {
		const approved = {
			checksRerunAt: null,
			checksRerunAttempts: 0,
			operatorNotifiedAt: null,
			adjudicatedFailure: null,
			failureChangeRoutedAt: null,
		};
		const shared = reads(approved, undefined, 'integration');
		await expect(redHeadHandled(key, true, now, shared)).resolves.toMatch(
			/Check integration is failing on several pull requests/,
		);
		expect(shared.findStandingEpisodeCheckForHead).toHaveBeenCalledWith(
			key,
			new Date(now.getTime() - SHARED_CHECK_EPISODE_MAX_AGE_MS),
		);
		// A head no standing episode covers is unchanged.
		await expect(redHeadHandled(key, true, now, reads(approved))).resolves.toBeUndefined();
	});
});

describe('dispatchResolveProblemForRedHeads (issue #1459)', () => {
	const RECORD = createMockProjectRecord({
		id: PROJECT,
		name: PROJECT,
		pipeline: { resolveProblem: { enabled: true } },
		repositories: [{ repo: REPO, autoMerge: true }],
	}) as ProjectRecord;
	const OFF = createMockProjectRecord({ id: 'off', name: 'off' }) as ProjectRecord;
	const ANCHOR = { id: 'run-ci', projectId: PROJECT } as RunRow;
	const RED_PROBE: RedHeadProbe = {
		state: 'red',
		headSha: UPDATED_HEAD,
		failedChecks: ['integration'],
	};

	function deps(
		now: Date,
		overrides: Partial<Parameters<typeof dispatchResolveProblemForRedHeads>[0]> = {},
	) {
		return {
			listProjects: async () => [RECORD, OFF],
			listActivity: vi.fn(async () => INCIDENT),
			listActiveDispatches: vi.fn(async () => []),
			loadCapped: vi.fn(async () => []),
			probe: vi.fn(async () => RED_PROBE),
			handled: vi.fn(async () => undefined),
			readRun: vi.fn(async () => ANCHOR),
			schedule: vi.fn(async (_head: ResolveProblemRedHeadCandidate) => ({ created: true })),
			now: () => now,
			...overrides,
		};
	}

	it('reproduces the incident: nothing at 12:10, exactly one attempt for the red head at 12:14', async () => {
		const early = deps(at('12:10'));
		expect(await dispatchResolveProblemForRedHeads(early)).toEqual([]);
		expect(early.probe).not.toHaveBeenCalled();

		const due = deps(at('12:14'));
		const created = await dispatchResolveProblemForRedHeads(due);

		expect(due.listActivity).toHaveBeenCalledWith({
			since: new Date(at('12:14').getTime() - RED_HEAD_LOOKBACK_MS),
			projectIds: [PROJECT],
		});
		expect(due.probe).toHaveBeenCalledWith(expect.objectContaining({ repo: REPO }), PR);
		expect(due.handled).toHaveBeenCalledWith(
			{ projectId: PROJECT, repository: REPO, prNumber: PR, headSha: UPDATED_HEAD },
			true,
			at('12:14'),
		);
		expect(due.schedule).toHaveBeenCalledTimes(1);
		expect(due.schedule).toHaveBeenCalledWith({
			projectId: PROJECT,
			repository: REPO,
			prNumber: PR,
			latestRunId: 'run-ci',
			taskId: `${PR}-ci`,
			workItemId: 'card-2386',
			headSha: UPDATED_HEAD,
			failedChecks: ['integration'],
		});
		expect(created).toEqual([`${PROJECT}/${REPO}#${PR}@${UPDATED_HEAD}`]);
	});

	it('reads nothing at all while no project turned the phase on', async () => {
		const off = deps(at('12:30'), { listProjects: async () => [OFF] });
		expect(await dispatchResolveProblemForRedHeads(off)).toEqual([]);
		expect(off.listActivity).not.toHaveBeenCalled();
		expect(off.probe).not.toHaveBeenCalled();
	});

	it('schedules nothing for a head that is not red, is being handled, or whose run is held or handed off', async () => {
		const now = at('12:30');
		const notRed = deps(now, {
			probe: vi.fn(
				async (): Promise<RedHeadProbe> => ({
					state: 'not-red',
					headSha: UPDATED_HEAD,
					checks: 'defer',
				}),
			),
		});
		const handled = deps(now, { handled: vi.fn(async () => 'handed to the operator') });
		const reset = deps(now, {
			readRun: vi.fn(async () => ({ ...ANCHOR, resetStartedAt: now }) as RunRow),
		});
		const cancelled = deps(now, {
			readRun: vi.fn(
				async () => ({ ...ANCHOR, cancellation: { source: 'dashboard' } }) as unknown as RunRow,
			),
		});
		// A deliberate hand-off to a person is never attempted (issue #1462).
		const handedOff = deps(now, {
			readRun: vi.fn(
				async () =>
					({
						...ANCHOR,
						failureDiagnosis: operatorHandoffDiagnosis({
							kind: 'ci-fix-attempts-exhausted',
							prNumber: '2401',
							attempt: 4,
							maxAttempts: 3,
						}),
					}) as unknown as RunRow,
			),
		});
		for (const pass of [notRed, handled, reset, cancelled, handedOff]) {
			expect(await dispatchResolveProblemForRedHeads(pass)).toEqual([]);
			expect(pass.schedule).not.toHaveBeenCalled();
		}
	});

	it('leaves a pull request the review cap stopped on a refused approval to the operator', async () => {
		const capped = deps(at('12:30'), {
			loadCapped: vi.fn(async () => [
				{ projectId: PROJECT, repository: REPO, prNumber: PR, runId: 'run-review' },
			]),
		});
		expect(await dispatchResolveProblemForRedHeads(capped)).toEqual([]);
		expect(capped.probe).not.toHaveBeenCalled();
	});

	it('does not report a head another pass already dispatched', async () => {
		const repeat = deps(at('12:30'), { schedule: vi.fn(async () => ({ created: false })) });
		expect(await dispatchResolveProblemForRedHeads(repeat)).toEqual([]);
		expect(repeat.schedule).toHaveBeenCalledTimes(1);
	});

	it('keeps going past an unreadable pull request, and never throws', async () => {
		const other = activity({
			prNumber: '9',
			taskId: '9-ci',
			runId: 'run-9',
			phase: 'respond-to-ci',
		});
		const pass = deps(at('12:30'), {
			listActivity: vi.fn(async () => [...INCIDENT, other]),
			probe: vi.fn(async (_project: ProjectConfig, prNumber: string) => {
				if (prNumber === PR) throw new Error('provider down');
				return RED_PROBE;
			}),
		});
		expect(await dispatchResolveProblemForRedHeads(pass)).toEqual([
			`${PROJECT}/${REPO}#9@${UPDATED_HEAD}`,
		]);

		const broken = deps(at('12:30'), {
			listActivity: vi.fn(async () => {
				throw new Error('db down');
			}),
		});
		await expect(dispatchResolveProblemForRedHeads(broken)).resolves.toEqual([]);
	});
});
