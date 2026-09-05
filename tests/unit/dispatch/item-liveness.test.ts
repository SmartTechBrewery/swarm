import { describe, expect, it } from 'vitest';
import type { ActiveDispatchTaskRef } from '@/db/repositories/dispatchesRepository.js';
import type { TaskActivityRow } from '@/db/repositories/runsRepository.js';
import {
	classifyItemLiveness,
	foldLivenessUnits,
	ITEM_STALL_AFTER_MS,
	type ItemLivenessPolicy,
	livenessUnitKeyForRun,
	livenessUnitKeysForDispatch,
	StalledItemSchema,
	toStalledItems,
} from '@/dispatch/item-liveness.js';

const NOW = new Date('2026-08-31T12:00:00.000Z');
/** Comfortably past the grace window, so a row is judged on its hand-offs alone. */
const LONG_AGO = new Date(NOW.getTime() - 10 * ITEM_STALL_AFTER_MS);

/** An activity row, shaped like `listTaskActivitySince()` returns them. */
function makeActivity(overrides: Partial<TaskActivityRow> = {}): TaskActivityRow {
	return {
		projectId: 'p1',
		repository: 'acme/widgets',
		taskId: '103',
		runId: 'run-1',
		phase: 'implementation',
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

function makeDispatchRef(overrides: Partial<ActiveDispatchTaskRef> = {}): ActiveDispatchTaskRef {
	return { projectId: 'p1', taskId: '103', phase: 'implementation', ...overrides };
}

const NO_AUTOMATION: ItemLivenessPolicy = { planningAutoAdvance: false, autoMerge: false };

/** Classify one activity row on its own, with no active dispatch. */
function stateOf(
	row: Partial<TaskActivityRow>,
	policy: ItemLivenessPolicy = NO_AUTOMATION,
	dispatches: ActiveDispatchTaskRef[] = [],
) {
	const units = foldLivenessUnits([makeActivity(row)], dispatches);
	expect(units).toHaveLength(1);
	return classifyItemLiveness(units[0], policy, NOW);
}

/** Classify one unit folded from several activity rows, with no active dispatch. */
function stateOfUnit(rows: Partial<TaskActivityRow>[], policy: ItemLivenessPolicy = NO_AUTOMATION) {
	const units = foldLivenessUnits(
		rows.map((row) => makeActivity(row)),
		[],
	);
	expect(units).toHaveLength(1);
	return classifyItemLiveness(units[0], policy, NOW);
}

describe('liveness unit identity', () => {
	it('folds the four SCM-driven phases of one pull request onto one unit', () => {
		const keys = [
			makeActivity({ taskId: '92', phase: 'review', prNumber: '92' }),
			makeActivity({ taskId: '92-respond', phase: 'respond-to-review', prNumber: '92' }),
			makeActivity({ taskId: '92-ci', phase: 'respond-to-ci', prNumber: '92' }),
			makeActivity({ taskId: '92-conflicts', phase: 'resolve-conflicts', prNumber: '92' }),
		].map(livenessUnitKeyForRun);

		expect(new Set(keys).size).toBe(1);
	});

	it('keeps two board cards of one project apart', () => {
		expect(livenessUnitKeyForRun(makeActivity({ taskId: '103' }))).not.toBe(
			livenessUnitKeyForRun(makeActivity({ taskId: '104' })),
		);
	});

	it('keeps the same task id in two repositories of one project apart', () => {
		expect(livenessUnitKeyForRun(makeActivity({ repository: 'acme/widgets' }))).not.toBe(
			livenessUnitKeyForRun(makeActivity({ repository: 'acme/gadgets' })),
		);
	});

	it('folds a PR-phase run that recorded no pr_number by its task-id suffix', () => {
		expect(livenessUnitKeyForRun(makeActivity({ taskId: '92-ci', prNumber: null }))).toBe(
			livenessUnitKeyForRun(makeActivity({ taskId: '92', prNumber: '92' })),
		);
	});

	it('maps a suffixed dispatch task id back to its pull request', () => {
		for (const taskId of ['92-ci', '92-respond', '92-conflicts']) {
			expect(livenessUnitKeysForDispatch(makeDispatchRef({ taskId, phase: null }))).toEqual([
				expect.stringContaining('pull-request'),
			]);
		}
	});

	it('disambiguates a bare numeric dispatch task id by its resolved phase', () => {
		const review = livenessUnitKeysForDispatch(makeDispatchRef({ taskId: '92', phase: 'review' }));
		const merge = livenessUnitKeysForDispatch(
			makeDispatchRef({ taskId: '92', phase: 'merge-automation' }),
		);
		const implementation = livenessUnitKeysForDispatch(
			makeDispatchRef({ taskId: '92', phase: 'implementation' }),
		);

		expect(review).toEqual([expect.stringContaining('pull-request')]);
		expect(merge).toEqual(review);
		expect(implementation).toEqual([expect.stringContaining('work-item')]);
	});

	it('maps a never-claimed dispatch to both candidate units', () => {
		// Conservative in the safe direction: it can only suppress a stall report.
		expect(livenessUnitKeysForDispatch(makeDispatchRef({ taskId: '92', phase: null })).length).toBe(
			2,
		);
	});
});

describe('classifyItemLiveness', () => {
	describe('rule 1 — something is still due', () => {
		it('is active while any run in the unit is still running', () => {
			expect(stateOf({ liveRunCount: 1 })).toBe('active');
		});

		it.each([
			['a capacity-blocked dispatch', 'implementation'],
			['a dependency-gated dispatch', 'implementation'],
			['a bounded retry inside budget', 'implementation'],
		])('is active for %s, even when its own run finished days ago', (_label, phase) => {
			expect(stateOf({ taskId: '103' }, NO_AUTOMATION, [makeDispatchRef({ phase })])).toBe(
				'active',
			);
		});

		it('is active for a pull-request unit whose respond-to-ci dispatch is still queued', () => {
			const state = stateOf({ taskId: '92', phase: 'review', prNumber: '92' }, NO_AUTOMATION, [
				makeDispatchRef({ taskId: '92-ci', phase: 'respond-to-ci' }),
			]);
			expect(state).toBe('active');
		});
	});

	describe('rule 2 — Implementation handed off to a pull request', () => {
		it('is handed-off once the run recorded produced_pr_url', () => {
			const state = stateOf({
				phase: 'implementation',
				status: 'completed',
				producedPrUrl: 'https://github.com/acme/widgets/pull/92',
			});
			expect(state).toBe('handed-off');
		});

		it('is stalled when the same run produced no pull request', () => {
			expect(stateOf({ phase: 'implementation', status: 'completed' })).toBe('stalled');
		});
	});

	describe('rule 3 — a merge is terminal for the whole unit', () => {
		/** The Review run that recorded the merge, older than everything below it. */
		const mergedReview = {
			taskId: '92',
			phase: 'review',
			status: 'completed',
			prNumber: '92',
			runId: 'run-review',
			reviewVerdict: 'approve',
			reviewMergeOutcome: 'merged',
			mergedRunCount: 1,
			lastActivityAt: new Date(NOW.getTime() - 5 * ITEM_STALL_AFTER_MS),
		} as const;

		it('is merged once merge automation recorded it', () => {
			expect(
				stateOf({
					phase: 'review',
					status: 'completed',
					reviewMergeOutcome: 'merged',
					mergedRunCount: 1,
				}),
			).toBe('merged');
		});

		// PR #733's ordering (issue #879): the merge is on the Review row, and a
		// later Respond-to-CI run on `<pr>-ci` folds in as the unit's latest.
		it('stays merged when a later respond-to-ci run becomes the latest row', () => {
			const state = stateOfUnit([
				mergedReview,
				{
					taskId: '92-ci',
					phase: 'respond-to-ci',
					status: 'completed',
					prNumber: '92',
					runId: 'run-ci',
					lastActivityAt: new Date(NOW.getTime() - 3 * ITEM_STALL_AFTER_MS),
				},
			]);
			expect(state).toBe('merged');
		});

		// PR #768's ordering (issue #879): the later row is a `failed` Review
		// sharing the merged Review's own task id.
		it('stays merged when a later failed review becomes the latest row', () => {
			const state = stateOfUnit([
				mergedReview,
				{
					taskId: '92',
					phase: 'review',
					status: 'failed',
					prNumber: '92',
					runId: 'run-review-failed',
					lastActivityAt: new Date(NOW.getTime() - 3 * ITEM_STALL_AFTER_MS),
				},
			]);
			expect(state).toBe('merged');
		});

		// The aggregate counts `merged` alone: a terminal refusal is not a merge.
		it('does not sweep up a non-merged outcome recorded on an earlier row', () => {
			const blocked = {
				...mergedReview,
				reviewVerdict: 'request-changes',
				reviewMergeOutcome: 'policy-blocked',
				mergedRunCount: 0,
			};
			const state = stateOfUnit([
				blocked,
				{
					taskId: '92-ci',
					phase: 'respond-to-ci',
					status: 'completed',
					prNumber: '92',
					runId: 'run-ci',
					lastActivityAt: new Date(NOW.getTime() - 3 * ITEM_STALL_AFTER_MS),
				},
			]);
			expect(state).toBe('stalled');
		});
	});

	it('rule 4 — is awaiting-human at the review-cap stop', () => {
		const state = stateOf({
			phase: 'review',
			status: 'completed',
			reviewVerdict: 'request-changes',
			reviewAutomationOutcome: 'manual-intervention-required',
		});
		expect(state).toBe('awaiting-human');
	});

	describe('rule 5 — a plan awaiting a greenlight', () => {
		it('is awaiting-human on a project that does not auto-advance', () => {
			expect(stateOf({ phase: 'planning', status: 'completed' })).toBe('awaiting-human');
		});

		it('is not rested by that rule when auto-advance is on', () => {
			const state = stateOf(
				{ phase: 'planning', status: 'completed' },
				{
					...NO_AUTOMATION,
					planningAutoAdvance: true,
				},
			);
			expect(state).toBe('stalled');
		});
	});

	describe('rule 6 — an approval whose merge is accounted for', () => {
		const approved = { phase: 'review', status: 'completed', reviewVerdict: 'approve' } as const;

		it('is awaiting-human when merge was never automated', () => {
			expect(stateOf(approved)).toBe('awaiting-human');
		});

		it('is awaiting-human when auto-merge recorded a terminal refusal', () => {
			const state = stateOf(
				{ ...approved, reviewMergeOutcome: 'policy-blocked' },
				{
					...NO_AUTOMATION,
					autoMerge: true,
				},
			);
			expect(state).toBe('awaiting-human');
		});

		// The shape of the incidents this read model exists for: a merge dispatch
		// that should have written an outcome and did not.
		it('is stalled for an approval with no merge outcome while auto-merge is on', () => {
			expect(stateOf(approved, { ...NO_AUTOMATION, autoMerge: true })).toBe('stalled');
		});
	});

	describe('rule 7 — the grace window', () => {
		it('is settling one millisecond inside the window', () => {
			const lastActivityAt = new Date(NOW.getTime() - ITEM_STALL_AFTER_MS + 1);
			expect(stateOf({ lastActivityAt })).toBe('settling');
		});

		it('is stalled one millisecond outside it', () => {
			const lastActivityAt = new Date(NOW.getTime() - ITEM_STALL_AFTER_MS - 1);
			expect(stateOf({ lastActivityAt })).toBe('stalled');
		});
	});

	it('rule 8 — a deferred run with no active dispatch falls through to stalled', () => {
		expect(stateOf({ status: 'deferred' })).toBe('stalled');
	});
});

describe('toStalledItems', () => {
	it('reports the three incident shapes the issue names, and nothing else', () => {
		// #838: a Respond-to-CI run that completed having pushed nothing.
		const respondToCi = makeActivity({
			taskId: '92-ci',
			phase: 'respond-to-ci',
			status: 'completed',
			prNumber: '92',
			runId: 'run-ci',
			lastActivityAt: new Date(NOW.getTime() - 3 * ITEM_STALL_AFTER_MS),
		});
		// #839: a run that failed after its delivery budget was exhausted.
		const exhaustedDelivery = makeActivity({
			taskId: '95',
			phase: 'implementation',
			status: 'failed',
			runId: 'run-delivery',
			lastActivityAt: new Date(NOW.getTime() - 2 * ITEM_STALL_AFTER_MS),
		});
		// #836: a quiet PR unit whose last run completed normally.
		const quietPr = makeActivity({
			taskId: '98',
			phase: 'review',
			status: 'completed',
			prNumber: '98',
			reviewVerdict: 'request-changes',
			runId: 'run-review',
			lastActivityAt: new Date(NOW.getTime() - 4 * ITEM_STALL_AFTER_MS),
		});
		// Legitimate waiting: a board card whose Implementation is still queued.
		const waiting = makeActivity({ taskId: '99', runId: 'run-waiting' });

		const items = toStalledItems(
			[respondToCi, exhaustedDelivery, quietPr, waiting],
			[makeDispatchRef({ taskId: '99', phase: 'implementation' })],
			{ p1: NO_AUTOMATION },
			NOW,
		);

		// Longest-silent first.
		expect(items.map((item) => item.reference)).toEqual(['98', '92', '95']);
		for (const item of items) expect(() => StalledItemSchema.parse(item)).not.toThrow();
	});

	it('carries the latest run of a folded unit, not the first row seen', () => {
		const older = makeActivity({
			taskId: '92',
			phase: 'review',
			prNumber: '92',
			runId: 'run-review',
			reviewVerdict: 'request-changes',
			lastActivityAt: new Date(NOW.getTime() - 5 * ITEM_STALL_AFTER_MS),
		});
		const newer = makeActivity({
			taskId: '92-respond',
			phase: 'respond-to-review',
			prNumber: '92',
			prTitle: 'Fix the widget',
			runId: 'run-respond',
			lastActivityAt: new Date(NOW.getTime() - 3 * ITEM_STALL_AFTER_MS),
		});

		const items = toStalledItems([older, newer], [], { p1: NO_AUTOMATION }, NOW);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			unit: 'pull-request',
			reference: '92',
			taskId: '92-respond',
			phase: 'respond-to-review',
			runId: 'run-respond',
			prNumber: '92',
			prTitle: 'Fix the widget',
			lastActivityAt: newer.lastActivityAt.toISOString(),
			stalledForMs: NOW.getTime() - newer.lastActivityAt.getTime(),
		});
	});

	it('does not report a merged pull request whatever lands on it next', () => {
		// The merge, on a Review run older than both later rows below (issue #879).
		const mergedReview = (taskId: string, runId: string) =>
			makeActivity({
				taskId,
				phase: 'review',
				status: 'completed',
				prNumber: taskId,
				runId,
				reviewVerdict: 'approve',
				reviewMergeOutcome: 'merged',
				mergedRunCount: 1,
				lastActivityAt: new Date(NOW.getTime() - 5 * ITEM_STALL_AFTER_MS),
			});
		// PR #733: a later respond-to-ci on the unit's `-ci` task id.
		const laterRespondToCi = makeActivity({
			taskId: '92-ci',
			phase: 'respond-to-ci',
			status: 'completed',
			prNumber: '92',
			runId: 'run-733-ci',
			lastActivityAt: new Date(NOW.getTime() - 3 * ITEM_STALL_AFTER_MS),
		});
		// PR #768: a later failed review sharing the merged review's task id.
		const laterFailedReview = makeActivity({
			taskId: '93',
			phase: 'review',
			status: 'failed',
			prNumber: '93',
			runId: 'run-768-failed',
			lastActivityAt: new Date(NOW.getTime() - 3 * ITEM_STALL_AFTER_MS),
		});
		// A genuinely stalled unit, so the assertion is not vacuously empty.
		const stalled = makeActivity({
			taskId: '98',
			phase: 'review',
			status: 'completed',
			prNumber: '98',
			runId: 'run-quiet',
			reviewVerdict: 'request-changes',
			lastActivityAt: new Date(NOW.getTime() - 4 * ITEM_STALL_AFTER_MS),
		});

		const items = toStalledItems(
			[
				mergedReview('92', 'run-733'),
				laterRespondToCi,
				mergedReview('93', 'run-768'),
				laterFailedReview,
				stalled,
			],
			[],
			{ p1: NO_AUTOMATION },
			NOW,
		);

		expect(items.map((item) => item.reference)).toEqual(['98']);
	});

	it('sums live runs across a folded unit, so one running phase keeps it active', () => {
		const review = makeActivity({ taskId: '92', phase: 'review', prNumber: '92' });
		const respond = makeActivity({
			taskId: '92-respond',
			phase: 'respond-to-review',
			prNumber: '92',
			status: 'running',
			liveRunCount: 1,
			lastActivityAt: new Date(NOW.getTime() - 5 * ITEM_STALL_AFTER_MS),
		});

		expect(toStalledItems([review, respond], [], { p1: NO_AUTOMATION }, NOW)).toEqual([]);
	});

	it('falls back to the pipeline’s own defaults for a project with no policy entry', () => {
		// Neither auto-advance nor auto-merge: a completed plan rests as awaiting-human.
		const planning = makeActivity({ taskId: '103', phase: 'planning', status: 'completed' });

		expect(toStalledItems([planning], [], {}, NOW)).toEqual([]);
	});
});
