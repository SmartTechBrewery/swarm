import { describe, expect, it } from 'vitest';
import { LegacyReviewHandoffSchema, ReviewHandoffSchema } from '@/scm/delivery.js';

/**
 * The review hand-off's refinement is where the review *format* becomes
 * enforceable rather than merely requested (issue #470): the prompt can ask a
 * model for a severity rubric, but only the schema can reject a hand-off that
 * disagrees with it. These tests pin the rules a prompt cannot guarantee.
 */

const BASE = {
	verdict: 'approve',
	summary: 'Adds a normalization helper.',
	verification: [{ command: 'npm run typecheck', outcome: 'passed' }],
	docsChecked: [{ path: 'README.md', status: 'accurate' }],
};

const BLOCKING_SLOTS = {
	failureScenario: 'Two events for one commit claim different keys, so Review runs twice.',
	impact: 'A duplicate reviewer run per commit.',
	fixPlan: ['Abbreviate at the boundary.'],
	tests: 'Assert both kinds yield an equal headSha.',
};

function finding(overrides: Record<string, unknown> = {}) {
	return {
		id: 'F1',
		title: 'Two spellings per commit',
		severity: 'blocker',
		category: 'correctness',
		evidence: '`webhook.ts:245` vs `:337`.',
		...BLOCKING_SLOTS,
		...overrides,
	};
}

function parse(overrides: Record<string, unknown>) {
	return ReviewHandoffSchema.safeParse({ ...BASE, ...overrides });
}

function errorFor(result: ReturnType<typeof parse>): string {
	return result.success ? '' : result.error.issues.map((i) => i.message).join(' | ');
}

describe('ReviewHandoffSchema', () => {
	it('accepts a clean approval with no findings', () => {
		expect(parse({}).success).toBe(true);
	});

	it('requires the fields the renderer has no way to invent', () => {
		for (const field of ['summary', 'verification', 'docsChecked'] as const) {
			const { [field]: _omitted, ...rest } = BASE;
			expect(ReviewHandoffSchema.safeParse(rest).success).toBe(false);
		}
	});

	// `comment` cleared no review gate and dispatched no follow-up, so a PR that
	// received one was silently terminal — it is no longer a verdict at all.
	it('rejects the removed comment verdict', () => {
		expect(parse({ verdict: 'comment' }).success).toBe(false);
	});

	describe('verdict follows from the severity histogram', () => {
		it('rejects an approval that carries a blocking finding', () => {
			const result = parse({ verdict: 'approve', findings: [finding()] });
			expect(result.success).toBe(false);
			expect(errorFor(result)).toContain('the verdict must be request-changes');
		});

		it('rejects request-changes with nothing blocking', () => {
			const result = parse({
				verdict: 'request-changes',
				findings: [
					{
						id: 'F1',
						title: 'naming',
						severity: 'nit',
						category: 'consistency',
						evidence: '`webhook.ts:337`.',
						suggestion: 'Rename for symmetry.',
					},
				],
			});
			expect(result.success).toBe(false);
			expect(errorFor(result)).toContain('request-changes requires at least one blocker/major');
		});

		it.each([
			['blocker', 'request-changes', true],
			['major', 'request-changes', true],
			['minor', 'approve', true],
			['nit', 'approve', true],
		])('%s pairs with %s', (severity, verdict, ok) => {
			const blocking = severity === 'blocker' || severity === 'major';
			const result = parse({
				verdict,
				findings: [
					finding(
						blocking
							? { severity }
							: {
									severity,
									suggestion: 'One paragraph.',
									failureScenario: undefined,
									impact: undefined,
									fixPlan: undefined,
									tests: undefined,
								},
					),
				],
			});
			expect(result.success).toBe(ok);
		});
	});

	describe('rendering tiers', () => {
		it.each([
			'failureScenario',
			'impact',
			'fixPlan',
			'tests',
		] as const)('requires %s on a blocking finding', (field) => {
			const result = parse({
				verdict: 'request-changes',
				findings: [finding({ [field]: undefined })],
			});
			expect(result.success).toBe(false);
			expect(errorFor(result)).toContain(`so ${field} is required`);
		});

		// Padding a naming nit into five slots is exactly what makes reviews unreadable
		// across models, so the compact tier's shape is enforced, not suggested.
		it.each([
			'failureScenario',
			'impact',
			'fixPlan',
			'tests',
		] as const)('forbids %s on a nit', (field) => {
			const result = parse({
				findings: [
					{
						id: 'F1',
						title: 'naming',
						severity: 'nit',
						category: 'consistency',
						evidence: '`webhook.ts:337`.',
						suggestion: 'Rename for symmetry.',
						[field]: field === 'fixPlan' ? ['do it'] : 'text',
					},
				],
			});
			expect(result.success).toBe(false);
			expect(errorFor(result)).toContain(`so ${field} must be omitted`);
		});

		it('requires a suggestion on a non-blocking finding', () => {
			const result = parse({
				findings: [
					{
						id: 'F1',
						title: 'naming',
						severity: 'nit',
						category: 'consistency',
						evidence: '`webhook.ts:337`.',
					},
				],
			});
			expect(result.success).toBe(false);
			expect(errorFor(result)).toContain('so suggestion is required');
		});

		it('forbids a downgrade rationale on a blocking finding', () => {
			const result = parse({
				verdict: 'request-changes',
				findings: [finding({ downgradeRationale: 'it is fine really' })],
			});
			expect(result.success).toBe(false);
			expect(errorFor(result)).toContain('so downgradeRationale must be omitted');
		});
	});

	describe('finding ids', () => {
		it.each(['1', 'f1', 'F', 'F1a', 'finding-1'])('rejects %j as an id', (id) => {
			expect(parse({ verdict: 'request-changes', findings: [finding({ id })] }).success).toBe(
				false,
			);
		});

		// Ids are how a re-review's disposition and the respond-to-review flow track
		// one item across passes, so a collision would silently merge two problems.
		it('rejects a duplicate id', () => {
			const result = parse({
				verdict: 'request-changes',
				findings: [finding(), finding({ title: 'A different problem' })],
			});
			expect(result.success).toBe(false);
			expect(errorFor(result)).toContain('duplicate finding id F1');
		});
	});

	it('accepts a failing verification command as evidence', () => {
		const result = parse({
			verdict: 'request-changes',
			verification: [{ command: 'npx vitest run tests/unit', outcome: 'failed' }],
			findings: [finding()],
		});
		expect(result.success).toBe(true);
	});
});

describe('LegacyReviewHandoffSchema', () => {
	// Accepted only when resuming a delivery whose worktree an older agent wrote;
	// without it a half-delivered review would fail validation on every retry
	// instead of finishing the submission it had already started.
	it('accepts the pre-#470 authored-body shape', () => {
		expect(
			LegacyReviewHandoffSchema.safeParse({
				verdict: 'approve',
				body: 'Looks good',
				findings: [],
			}).success,
		).toBe(true);
	});

	it('still parses a legacy comment verdict so the phase can reject it by name', () => {
		const result = LegacyReviewHandoffSchema.safeParse({ verdict: 'comment', body: 'notes' });
		expect(result.success).toBe(true);
	});

	it('rejects the new structured shape, so the two cannot be confused', () => {
		expect(LegacyReviewHandoffSchema.safeParse(BASE).success).toBe(false);
	});
});
