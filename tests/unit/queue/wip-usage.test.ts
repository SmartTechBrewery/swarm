import { describe, expect, it } from 'vitest';
import type { ActiveDispatchTaskRef } from '@/db/repositories/dispatchesRepository.js';
import type { TaskActivityRow } from '@/db/repositories/runsRepository.js';
import type { WipSlotRow } from '@/db/repositories/wipSlotsRepository.js';
import { ITEM_STALL_AFTER_MS, type ItemLivenessPolicy } from '@/dispatch/item-liveness.js';
import { toWipUsage, type WipUsageInput } from '@/queue/wip-usage.js';

const NOW = new Date('2026-10-29T12:00:00.000Z');
/** Comfortably past the grace window, so a holder is judged on its hand-offs alone. */
const LONG_AGO = new Date(NOW.getTime() - 10 * ITEM_STALL_AFTER_MS);
const RECENTLY = new Date(NOW.getTime() - 60_000);
const REPO = 'acme/widgets';

function makeSlot(overrides: Partial<WipSlotRow> = {}): WipSlotRow {
	return {
		projectId: 'p1',
		repository: REPO,
		taskId: '103',
		workItemId: 'item-103',
		workItemTitle: 'Add widgets',
		workItemUrl: 'https://github.com/acme/widgets/issues/103',
		openedPhase: 'planning',
		openedAt: LONG_AGO,
		prNumber: null,
		...overrides,
	};
}

function makeActivity(overrides: Partial<TaskActivityRow> = {}): TaskActivityRow {
	return {
		projectId: 'p1',
		repository: REPO,
		taskId: '103',
		runId: 'run-1',
		phase: 'planning',
		status: 'completed',
		prNumber: null,
		prTitle: null,
		workItemId: null,
		workItemTitle: null,
		workItemUrl: null,
		producedPrUrl: null,
		reviewVerdict: null,
		reviewAutomationOutcome: null,
		reviewMergeOutcome: null,
		lastActivityAt: LONG_AGO,
		liveRunCount: 0,
		mergedRunCount: 0,
		...overrides,
	};
}

const NO_AUTOMATION: ItemLivenessPolicy = { planningAutoAdvance: false, autoMergeRepositories: [] };

function usage(overrides: Partial<WipUsageInput> = {}) {
	return toWipUsage({
		slots: [],
		waiters: [],
		limitFor: () => 2,
		activity: [],
		activeDispatches: [],
		policies: { p1: NO_AUTOMATION },
		now: NOW,
		...overrides,
	});
}

/** The single holder of a single-slot report. */
function holder(overrides: Partial<WipUsageInput> = {}) {
	const entries = usage({ slots: [makeSlot()], ...overrides });
	expect(entries).toHaveLength(1);
	expect(entries[0]?.tickets).toHaveLength(1);
	const ticket = entries[0]?.tickets[0];
	if (!ticket) throw new Error('unreachable');
	return ticket;
}

describe('toWipUsage', () => {
	it('is empty when no repository holds a slot or a waiter', () => {
		expect(usage()).toEqual([]);
	});

	it('counts in-flight tickets against the limit and the waiters per repository', () => {
		const entries = usage({
			slots: [
				makeSlot({ taskId: '2', openedAt: RECENTLY }),
				makeSlot({ taskId: '1' }),
				makeSlot({ repository: 'acme/other', taskId: '9' }),
			],
			waiters: [{ projectId: 'p1', repository: REPO, count: 3 }],
			limitFor: (_projectId, repository) => (repository === REPO ? 2 : 5),
		});

		expect(
			entries.map(({ repository, inFlight, limit, waiting }) => ({
				repository,
				inFlight,
				limit,
				waiting,
			})),
		).toEqual([
			{ repository: 'acme/other', inFlight: 1, limit: 5, waiting: 0 },
			{ repository: REPO, inFlight: 2, limit: 2, waiting: 3 },
		]);
		// Oldest slot first.
		expect(entries[1]?.tickets.map((ticket) => ticket.taskId)).toEqual(['1', '2']);
	});

	it('reports a repository with waiters but no holders', () => {
		expect(usage({ waiters: [{ projectId: 'p1', repository: REPO, count: 1 }] })).toEqual([
			{ projectId: 'p1', repository: REPO, limit: 2, inFlight: 0, waiting: 1, tickets: [] },
		]);
	});

	it('names the holder and when it took its slot', () => {
		expect(holder({ activity: [makeActivity({ liveRunCount: 1, status: 'running' })] })).toEqual({
			taskId: '103',
			workItemId: 'item-103',
			workItemTitle: 'Add widgets',
			workItemUrl: 'https://github.com/acme/widgets/issues/103',
			openedPhase: 'planning',
			openedAt: LONG_AGO.toISOString(),
			state: 'running',
			phase: 'planning',
			lastActivityAt: LONG_AGO.toISOString(),
		});
	});

	it('reads a holder whose pull request has a live run as running', () => {
		const ticket = holder({
			slots: [makeSlot({ prNumber: '120' })],
			activity: [
				makeActivity({ phase: 'implementation', producedPrUrl: 'https://x/pull/120' }),
				makeActivity({
					taskId: '120',
					prNumber: '120',
					phase: 'review',
					status: 'running',
					liveRunCount: 1,
					lastActivityAt: RECENTLY,
				}),
			],
		});
		expect(ticket).toMatchObject({ state: 'running', phase: 'review', prNumber: '120' });
	});

	it('reads a holder whose pull request waits on CI as waiting on the pipeline', () => {
		// Implementation handed the work to its pull request; no pull request number
		// recorded yet, so the card unit decides — and a recorded hand-off is no stall.
		const ticket = holder({
			activity: [makeActivity({ phase: 'implementation', producedPrUrl: 'https://x/pull/120' })],
		});
		expect(ticket.state).toBe('waiting-on-pipeline');
		expect(ticket.operatorReason).toBeUndefined();
	});

	it('reads a queued dispatch as waiting on the pipeline, but never its own wip-limit wait', () => {
		const queued: ActiveDispatchTaskRef = {
			projectId: 'p1',
			taskId: '103',
			phase: 'implementation',
			waitReason: 'project-capacity',
		};
		expect(holder({ activity: [makeActivity()], activeDispatches: [queued] }).state).toBe(
			'waiting-on-pipeline',
		);
		expect(
			holder({
				activity: [makeActivity()],
				activeDispatches: [{ ...queued, waitReason: 'wip-limit' }],
			}),
		).toMatchObject({ state: 'waiting-on-operator', operatorReason: 'plan-awaiting-greenlight' });
	});

	it('reads a plan awaiting its greenlight as waiting on the operator', () => {
		expect(holder({ activity: [makeActivity()] })).toMatchObject({
			state: 'waiting-on-operator',
			operatorReason: 'plan-awaiting-greenlight',
		});
	});

	it('reads an approval awaiting a manual merge as waiting on the operator', () => {
		const ticket = holder({
			slots: [makeSlot({ prNumber: '120' })],
			activity: [
				makeActivity({ phase: 'implementation', producedPrUrl: 'https://x/pull/120' }),
				makeActivity({
					taskId: '120',
					prNumber: '120',
					phase: 'review',
					reviewVerdict: 'approve',
					lastActivityAt: RECENTLY,
				}),
			],
		});
		expect(ticket).toMatchObject({
			state: 'waiting-on-operator',
			operatorReason: 'approved-awaiting-merge',
		});
	});

	it('reads a reached review cap as waiting on the operator', () => {
		const ticket = holder({
			slots: [makeSlot({ prNumber: '120' })],
			activity: [
				makeActivity({
					taskId: '120',
					prNumber: '120',
					phase: 'review',
					reviewVerdict: 'request-changes',
					reviewAutomationOutcome: 'manual-intervention-required',
					lastActivityAt: RECENTLY,
				}),
			],
		});
		expect(ticket).toMatchObject({
			state: 'waiting-on-operator',
			operatorReason: 'review-cap-reached',
		});
	});

	it('reads a stalled holder as waiting on the operator', () => {
		const ticket = holder({
			policies: { p1: { ...NO_AUTOMATION, planningAutoAdvance: true } },
			activity: [makeActivity()],
		});
		expect(ticket).toMatchObject({ state: 'waiting-on-operator', operatorReason: 'stalled' });
	});

	it('reads a recent silent holder as still settling, so waiting on the pipeline', () => {
		const ticket = holder({
			policies: { p1: { ...NO_AUTOMATION, planningAutoAdvance: true } },
			activity: [makeActivity({ lastActivityAt: RECENTLY })],
		});
		expect(ticket.state).toBe('waiting-on-pipeline');
	});

	it('reads a failed latest run with nothing queued as waiting on the operator', () => {
		const ticket = holder({
			activity: [makeActivity({ status: 'failed', lastActivityAt: RECENTLY })],
		});
		expect(ticket).toMatchObject({ state: 'waiting-on-operator', operatorReason: 'failed' });
	});

	it('reads a failed run with its retry queued as waiting on the pipeline', () => {
		const ticket = holder({
			activity: [makeActivity({ status: 'failed' })],
			activeDispatches: [{ projectId: 'p1', taskId: '103', phase: 'planning', waitReason: null }],
		});
		expect(ticket.state).toBe('waiting-on-pipeline');
	});

	it('classifies a holder without a pull request number from its card alone', () => {
		// A pull-request unit exists, but the slot never recorded it, so it is not folded.
		const ticket = holder({
			activity: [
				makeActivity({ status: 'failed' }),
				makeActivity({ taskId: '120', prNumber: '120', phase: 'review', liveRunCount: 1 }),
			],
		});
		expect(ticket).toMatchObject({ state: 'waiting-on-operator', operatorReason: 'failed' });
		expect(ticket.prNumber).toBeUndefined();
	});

	it('reads a holder with no run yet by how long its slot has been open', () => {
		expect(holder({ slots: [makeSlot({ openedAt: RECENTLY })] }).state).toBe('waiting-on-pipeline');
		expect(holder()).toMatchObject({ state: 'waiting-on-operator', operatorReason: 'stalled' });
	});

	it('does not fold another repository’s activity onto a holder', () => {
		const ticket = holder({
			activity: [makeActivity({ repository: 'acme/other', liveRunCount: 1 })],
		});
		expect(ticket.state).not.toBe('running');
	});
});
