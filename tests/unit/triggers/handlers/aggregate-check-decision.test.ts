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
		expect(decision).toEqual({ action: 'review', basis: 'checks-passed' });
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
			basis: 'no-checks',
		});
	});

	it('reports checks-passed, not no-checks, for passing checks under the if-present policy', () => {
		// Only a truly empty aggregate is `no-checks` — the basis the `updated`
		// event acts on (issue #1107).
		const decision = decideAggregateCheckOutcome(
			status([['build', 'completed', 'success']]),
			'9',
			'if-present',
		);
		expect(decision).toEqual({ action: 'review', basis: 'checks-passed' });
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
		expect(decision).toEqual({
			action: 'respond-to-ci',
			failedChecks: ['test'],
			failedCheckDetails: ['test (failure)'],
		});
	});

	it('reviews when a completed check is skipped/neutral (not a failure)', () => {
		const decision = decideAggregateCheckOutcome(
			status([
				['build', 'completed', 'success'],
				['optional', 'completed', 'skipped'],
			]),
			'9',
		);
		expect(decision).toEqual({ action: 'review', basis: 'checks-passed' });
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
		expect(decision).toEqual({
			action: 'respond-to-ci',
			failedChecks: ['test'],
			failedCheckDetails: ['test (failure)'],
		});
	});

	// Issue #1429: an allow-list of passing conclusions, so a cancelled check (a job
	// that hit its `timeout-minutes`) and any conclusion added later is red, never green.
	it.each([
		'failure',
		'timed_out',
		'action_required',
		'cancelled',
		'stale',
		'startup_failure',
		'something_new',
	])('treats a %s conclusion as a failure → respond-to-ci', (conclusion) => {
		expect(decideAggregateCheckOutcome(status([['test', 'completed', conclusion]]), '9')).toEqual({
			action: 'respond-to-ci',
			failedChecks: ['test'],
			failedCheckDetails: [`test (${conclusion})`],
		});
	});

	it('treats a cancelled check as red under the if-present policy too', () => {
		expect(
			decideAggregateCheckOutcome(
				status([['Lint, typecheck, and test', 'completed', 'cancelled']]),
				'9',
				'if-present',
			),
		).toEqual({
			action: 'respond-to-ci',
			failedChecks: ['Lint, typecheck, and test'],
			failedCheckDetails: ['Lint, typecheck, and test (cancelled)'],
		});
	});

	it('treats a completed check with no conclusion as a failure', () => {
		expect(decideAggregateCheckOutcome(status([['test', 'completed', null]]), '9')).toEqual({
			action: 'respond-to-ci',
			failedChecks: ['test'],
			failedCheckDetails: ['test (no conclusion)'],
		});
	});

	it('reviews when every check passed with success, neutral or skipped', () => {
		expect(
			decideAggregateCheckOutcome(
				status([
					['build', 'completed', 'success'],
					['lint', 'completed', 'neutral'],
					['optional', 'completed', 'skipped'],
				]),
				'9',
			),
		).toEqual({ action: 'review', basis: 'checks-passed' });
	});
});
