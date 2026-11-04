import { describe, expect, it } from 'vitest';
import { reviewReportProblem } from '@/pipeline/review-report.js';
import { type ReviewHandoff, ReviewHandoffSchema } from '@/scm/delivery.js';

function handoff(overrides: Record<string, unknown> = {}): ReviewHandoff {
	return ReviewHandoffSchema.parse({
		verdict: 'request-changes',
		summary: 'Adds the review phase.',
		verification: [{ command: 'npm test', outcome: 'passed' }],
		docsChecked: [{ path: 'README.md', status: 'accurate' }],
		findings: [
			{
				id: 'F1',
				title: 'wrong key',
				severity: 'blocker',
				category: 'correctness',
				evidence: '`a.ts:1`',
				failureScenario: 'Two events.',
				impact: 'Duplicate runs.',
				fixPlan: ['Fix it.'],
				tests: ['Assert it.'],
			},
			{
				id: 'F2',
				title: 'naming',
				severity: 'nit',
				category: 'consistency',
				evidence: '`b.ts:2`',
				suggestion: 'Rename.',
			},
		],
		...overrides,
	});
}

describe('reviewReportProblem (issue #1321)', () => {
	it('accepts a report in any language that states the verdict and every blocking id', () => {
		const report = '> **Przegląd** · przebieg 1 z 3 · `request-changes`\n\n## F1 · blokujące';
		expect(reviewReportProblem(report, handoff())).toBeUndefined();
	});

	it('does not require the ids of non-blocking findings', () => {
		expect(reviewReportProblem('`request-changes` — F1', handoff())).toBeUndefined();
	});

	it('rejects a report that states no verdict, or a different one', () => {
		expect(reviewReportProblem('## F1 · prośba o zmiany', handoff())).toMatch(/states no verdict/);
		expect(reviewReportProblem('> `approve` · F1', handoff())).toMatch(
			/states `approve` but the hand-off's verdict is `request-changes`/,
		);
	});

	// The header comes first; a verdict value quoted later in prose does not count.
	it('reads the verdict the report states first', () => {
		expect(reviewReportProblem('> `approve`\n\nF1 — not `request-changes`', handoff())).toMatch(
			/states `approve`/,
		);
	});

	it('rejects a report that omits a blocking finding’s id, matching whole ids only', () => {
		expect(reviewReportProblem('`request-changes` — F10, F2', handoff())).toBe(
			'it omits blocking finding F1',
		);
		expect(reviewReportProblem('`request-changes` — xF1', handoff())).toBe(
			'it omits blocking finding F1',
		);
	});

	it('checks an approval with no findings on its verdict alone', () => {
		const approval = handoff({ verdict: 'approve', findings: [] });
		expect(reviewReportProblem('> `approve`', approval)).toBeUndefined();
	});
});

describe('ReviewHandoffSchema `report`', () => {
	it('trims the report, and drops a blank or mis-typed one rather than failing the review', () => {
		expect(handoff({ report: '  > `approve`  ' }).report).toBe('> `approve`');
		expect(handoff({ report: '  ' }).report).toBeUndefined();
		expect(handoff({ report: ['not', 'a', 'string'] }).report).toBeUndefined();
		expect(handoff().report).toBeUndefined();
	});
});
