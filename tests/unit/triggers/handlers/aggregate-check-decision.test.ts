import { describe, expect, it } from 'vitest';
import type { AggregateCheckStatus } from '@/scm/types.js';
import { decideAggregateCheckOutcome } from '@/triggers/handlers/aggregate-check-decision.js';

/** Build an `AggregateCheckStatus` from `[name, status, conclusion]` triples. */
function status(runs: Array<[string, string, string | null]>): AggregateCheckStatus {
	return {
		totalCount: runs.length,
		checkRuns: runs.map(([name, s, conclusion]) => ({ name, status: s, conclusion })),
	};
}

describe('decideAggregateCheckOutcome', () => {
	it('reviews when every check completed and none failed', () => {
		const decision = decideAggregateCheckOutcome(
			status([
				['build', 'completed', 'success'],
				['test', 'completed', 'success'],
			]),
			'9',
		);
		expect(decision).toEqual({ action: 'review' });
	});

	it('defers when no checks are registered yet', () => {
		expect(decideAggregateCheckOutcome(status([]), '9')).toEqual({
			action: 'defer',
			incompleteChecks: [],
			message: 'PR #9: no checks are registered yet',
		});
	});

	it('defers on zero checks under the explicit required policy — same as the default', () => {
		expect(decideAggregateCheckOutcome(status([]), '9', 'required')).toEqual({
			action: 'defer',
			incompleteChecks: [],
			message: 'PR #9: no checks are registered yet',
		});
	});

	it('reviews on zero checks under the if-present policy (issue #274)', () => {
		expect(decideAggregateCheckOutcome(status([]), '9', 'if-present')).toEqual({
			action: 'review',
		});
	});

	it('still defers present-but-incomplete checks under the if-present policy', () => {
		const decision = decideAggregateCheckOutcome(
			status([['test', 'in_progress', null]]),
			'9',
			'if-present',
		);
		expect(decision).toMatchObject({ action: 'defer', incompleteChecks: ['test'] });
	});

	it('still routes a present failed check to respond-to-ci under the if-present policy', () => {
		const decision = decideAggregateCheckOutcome(
			status([['test', 'completed', 'failure']]),
			'9',
			'if-present',
		);
		expect(decision).toEqual({ action: 'respond-to-ci', failedChecks: ['test'] });
	});

	it('reviews when a completed check is skipped/neutral (not a failure)', () => {
		const decision = decideAggregateCheckOutcome(
			status([
				['build', 'completed', 'success'],
				['optional', 'completed', 'skipped'],
			]),
			'9',
		);
		expect(decision).toEqual({ action: 'review' });
	});

	it('defers, listing the incomplete checks, when a check is still running', () => {
		const decision = decideAggregateCheckOutcome(
			status([
				['build', 'completed', 'success'],
				['test', 'in_progress', null],
				['lint', 'queued', null],
			]),
			'9',
		);
		expect(decision).toMatchObject({ action: 'defer', incompleteChecks: ['test', 'lint'] });
	});

	it('defers even when an already-completed check failed (completion wins first)', () => {
		const decision = decideAggregateCheckOutcome(
			status([
				['test', 'completed', 'failure'],
				['build', 'in_progress', null],
			]),
			'9',
		);
		expect(decision).toMatchObject({ action: 'defer' });
	});

	it('routes to respond-to-ci, naming the failed checks, when all completed and one failed', () => {
		const decision = decideAggregateCheckOutcome(
			status([
				['build', 'completed', 'success'],
				['test', 'completed', 'failure'],
			]),
			'9',
		);
		expect(decision).toEqual({ action: 'respond-to-ci', failedChecks: ['test'] });
	});

	it.each([
		'failure',
		'timed_out',
		'action_required',
	])('treats a %s conclusion as a failure → respond-to-ci', (conclusion) => {
		expect(decideAggregateCheckOutcome(status([['test', 'completed', conclusion]]), '9')).toEqual({
			action: 'respond-to-ci',
			failedChecks: ['test'],
		});
	});
});
