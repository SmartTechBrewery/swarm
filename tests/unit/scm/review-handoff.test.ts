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
	tests: ['Assert both kinds yield an equal headSha.'],
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
						[field]: field === 'fixPlan' || field === 'tests' ? ['do it'] : 'text',
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

	// Without this coupling the disposition table and the verdict are independent:
	// a re-review could render "F1 ❌ not addressed" above `approve`, clearing the
	// review gate and — with autoMerge on — merging a PR whose requested changes
	// were never made.
	describe('an unresolved carried item must be re-reported as a finding', () => {
		const carried = (status: string) => [
			{ id: 'F1', title: 'Two spellings per commit', status, detail: 'Traced again.' },
		];

		it.each([
			'outstanding',
			'regressed',
			'partial',
		])('rejects a %s carried item that appears in no finding', (status) => {
			const result = parse({ verdict: 'approve', carried: carried(status) });
			expect(result.success).toBe(false);
			expect(errorFor(result)).toContain('must also appear in findings under the same id');
		});

		it('accepts a resolved item that appears in no finding — that is the normal case', () => {
			expect(parse({ verdict: 'approve', carried: carried('resolved') }).success).toBe(true);
		});

		// Re-reported under the same id, the existing severity rule takes over: a
		// still-outstanding blocker forces request-changes…
		it('forces request-changes once the re-reported item is blocking', () => {
			expect(
				parse({ verdict: 'approve', carried: carried('outstanding'), findings: [finding()] })
					.success,
			).toBe(false);
			expect(
				parse({
					verdict: 'request-changes',
					carried: carried('outstanding'),
					findings: [finding()],
				}).success,
			).toBe(true);
		});

		// …while a nit an earlier pass raised and nobody fixed can still be approved,
		// which is why the rule routes through `findings` rather than the verdict.
		it('still allows approving an outstanding item the reviewer reports as a nit', () => {
			const result = parse({
				verdict: 'approve',
				carried: carried('outstanding'),
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
			expect(result.success).toBe(true);
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

	// Issue #861: the schema and the prompt disagreed about `tests`'s cardinality —
	// `fixPlan` said "an array" one clause earlier and `tests`'s only signal was an
	// incidental string in an example. A model that continued the array pattern had
	// its entire review discarded. Shape is now normalized; semantics are not.
	describe('a coercible shape mismatch is normalized, not fatal', () => {
		// The exact hand-off shape that failed live on SmartTechBrewery/swarm#860
		// (dispatch 6b8aa8f3-7498-432a-bd1a-55b8bd3fc195, settled `failed` at attempt
		// 0): a blocking finding whose `tests` is an array. It cost a complete review.
		it('accepts the array-valued tests that discarded the review on PR #860', () => {
			const result = parse({
				verdict: 'request-changes',
				findings: [finding({ tests: ['Assert the grace is measured from the latest drop.'] })],
			});
			expect(result.success).toBe(true);
			expect(result.success && result.data.findings[0].tests).toEqual([
				'Assert the grace is measured from the latest drop.',
			]);
		});

		it('reads a bare string in a list slot as a one-element list', () => {
			const result = parse({
				verdict: 'request-changes',
				preExisting: 'a pre-existing lint warning',
				findings: [finding({ fixPlan: 'One step.', tests: 'Assert equality.' })],
			});
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.preExisting).toEqual(['a pre-existing lint warning']);
			expect(result.data.findings[0].fixPlan).toEqual(['One step.']);
			expect(result.data.findings[0].tests).toEqual(['Assert equality.']);
		});

		// Joined with a space rather than a newline: `compactFinding` renders
		// `evidence` and `suggestion` inline in one Markdown line.
		it('reads a list in a text slot back as one line of prose', () => {
			const result = parse({
				summary: ['Adds a normalization helper.', 'No behavior change.'],
				findings: [
					{
						id: 'F1',
						title: 'naming',
						severity: 'nit',
						category: 'consistency',
						evidence: ['`a.ts:1`', 'and `b.ts:2`'],
						suggestion: 'Rename for symmetry.',
					},
				],
			});
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.summary).toBe('Adds a normalization helper. No behavior change.');
			expect(result.data.findings[0].evidence).toBe('`a.ts:1` and `b.ts:2`');
			expect(result.data.summary).not.toContain('\n');
		});

		it('wraps a single object written bare into the array its slot wants', () => {
			const result = parse({
				verification: { command: 'npm run typecheck', outcome: 'passed' },
				docsChecked: { path: 'README.md', status: 'accurate' },
			});
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.verification).toHaveLength(1);
			expect(result.data.docsChecked).toHaveLength(1);
		});

		it.each([
			['an empty list', { tests: [] }],
			['a blank entry', { tests: [''] }],
			['a non-string entry', { tests: [123] }],
			['an empty evidence list', { evidence: [] }],
			['a list of objects', { evidence: [{}] }],
		])('still fails closed on %s', (_label, overrides) => {
			expect(parse({ verdict: 'request-changes', findings: [finding(overrides)] }).success).toBe(
				false,
			);
		});

		// The rule that keeps normalization from becoming a loophole: the tier
		// refinement runs after field parsing, so it sees the normalized value and
		// judges it exactly as before.
		it('still forbids a normalized tests slot on a nit', () => {
			const result = parse({
				findings: [
					{
						id: 'F1',
						title: 'naming',
						severity: 'nit',
						category: 'consistency',
						evidence: '`webhook.ts:337`.',
						suggestion: 'Rename for symmetry.',
						tests: 'Assert equality.',
					},
				],
			});
			expect(result.success).toBe(false);
			expect(errorFor(result)).toContain('so tests must be omitted');
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
