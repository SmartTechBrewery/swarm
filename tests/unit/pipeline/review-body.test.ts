import { describe, expect, it } from 'vitest';
import { REVIEW_VERDICT_CAP } from '@/db/repositories/reviewVerdictsRepository.js';
import { type ReviewBodyContext, renderReviewBody } from '@/pipeline/review-body.js';
import { type ReviewHandoff, ReviewHandoffSchema } from '@/scm/delivery.js';

const HEAD_SHA = 'd3022fc0ca3d';

/** A minimal valid hand-off, parsed so defaults are applied exactly as the phase sees them. */
function handoff(overrides: Record<string, unknown> = {}): ReviewHandoff {
	return ReviewHandoffSchema.parse({
		verdict: 'approve',
		summary: 'Adds Bitbucket webhook signature verification and event normalization.',
		verification: [{ command: 'npx vitest run tests/unit', outcome: 'passed' }],
		docsChecked: [{ path: 'README.md', status: 'accurate' }],
		...overrides,
	});
}

function context(overrides: Partial<ReviewBodyContext> = {}): ReviewBodyContext {
	return {
		handoff: handoff(),
		headSha: HEAD_SHA,
		ordinal: 1,
		cap: REVIEW_VERDICT_CAP,
		isReReview: false,
		minorsAnswered: false,
		...overrides,
	};
}

const blocker = {
	id: 'F1',
	title: 'headSha has two spellings per commit',
	severity: 'blocker',
	category: 'correctness',
	evidence: '`webhook.ts:245` sources a 12-char hash; `:337` sources the full 40.',
	failureScenario: 'Two events for one commit claim different dedup keys, so Review runs twice.',
	impact: 'Duplicate worktrees and a Respond-to-review path that never fires.',
	fixPlan: ['Abbreviate both spellings at the boundary.', 'Rewrite the module header.'],
	tests: ['Assert both event kinds yield an equal headSha.', 'Assert the dedup key is stable.'],
};

const nit = {
	id: 'F2',
	title: 'stale count in the module header',
	severity: 'nit',
	category: 'docs',
	evidence: '`webhook.ts:38` says "the eleven event keys".',
	suggestion: 'Name the map instead of counting, so phase 3 cannot make the sentence false.',
};

describe('renderReviewBody', () => {
	describe('pass label', () => {
		it.each([
			[1, '**Review** · pass 1 of 3'],
			[2, '**First re-review** · pass 2 of 3'],
			[3, '**Second re-review** · pass 3 of 3 — final permitted verdict'],
		])('names pass %i as %s', (ordinal, expected) => {
			const body = renderReviewBody(context({ ordinal, isReReview: ordinal > 1 }));
			expect(body).toContain(expected);
		});

		// The cap-reaching pass is where automation stops; today that is visible only
		// in a log field, so the rendered header states it.
		it('marks the final permitted pass', () => {
			expect(renderReviewBody(context({ ordinal: REVIEW_VERDICT_CAP }))).toContain(
				'final permitted verdict',
			);
			expect(renderReviewBody(context({ ordinal: 1 }))).not.toContain('final permitted verdict');
		});

		// A pass after an approval that didn't merge is a full initial review sitting
		// at ordinal 2 — naming it a re-review would claim it verified earlier
		// findings it was never shown.
		it('names a non-re-review pass "Review" whatever its ordinal', () => {
			const body = renderReviewBody(context({ ordinal: 2, isReReview: false }));
			expect(body).toContain('**Review** · pass 2 of 3');
			expect(body).not.toContain('re-review');
		});

		it('falls back to an unnumbered label when the ledger had no reservation', () => {
			expect(renderReviewBody(context({ ordinal: undefined }))).toContain('**Review** · `approve`');
			expect(renderReviewBody(context({ ordinal: undefined, isReReview: true }))).toContain(
				'**Re-review** · `approve`',
			);
		});
	});

	it('states the verdict, head SHA, and severity histogram in the header', () => {
		const body = renderReviewBody(
			context({
				handoff: handoff({ verdict: 'request-changes', findings: [blocker, nit] }),
			}),
		);
		expect(body).toContain('`request-changes`');
		expect(body).toContain(`head \`${HEAD_SHA}\``);
		expect(body).toContain('**2 findings** — 1 blocker · 0 major · 0 minor · 1 nit');
	});

	it('flags an all-non-blocking review as none blocking', () => {
		const body = renderReviewBody(context({ handoff: handoff({ findings: [nit] }) }));
		expect(body).toContain('**none blocking**');
	});

	describe('rendering tiers', () => {
		it('gives a blocker the full slots', () => {
			const body = renderReviewBody(
				context({ handoff: handoff({ verdict: 'request-changes', findings: [blocker] }) }),
			);
			expect(body).toContain(
				'## F1 · blocker · correctness — headSha has two spellings per commit',
			);
			expect(body).toContain('**Evidence.**');
			expect(body).toContain('**Failure scenario.**');
			expect(body).toContain('**Impact.**');
			expect(body).toContain('1. Abbreviate both spellings at the boundary.');
			expect(body).toContain('2. Rewrite the module header.');
			expect(body).toContain('**Tests.**');
			// Bulleted rather than numbered (issue #861): tests are a set, not steps.
			expect(body).toContain('- Assert both event kinds yield an equal headSha.');
			expect(body).toContain('- Assert the dedup key is stable.');
		});

		// A naming nit run through five slots turns one line into 200 words, so the
		// compact tier is one paragraph and carries no fix-plan scaffolding.
		it('gives a nit one compact paragraph and no blocking slots', () => {
			const body = renderReviewBody(context({ handoff: handoff({ findings: [nit] }) }));
			expect(body).toContain('**F2** · nit · docs · `webhook.ts:38` says "the eleven event keys".');
			expect(body).not.toContain('**Failure scenario.**');
			expect(body).not.toContain('**Fix plan.**');
		});

		it('renders a downgrade rationale when the reviewer justified one', () => {
			const body = renderReviewBody(
				context({
					handoff: handoff({
						findings: [
							{
								...nit,
								severity: 'minor',
								downgradeRationale: 'Both maps are exhaustively covered by current tests.',
							},
						],
					}),
				}),
			);
			expect(body).toContain(
				'*Why it is minor, not major:* Both maps are exhaustively covered by current tests.',
			);
		});

		it('orders findings blocker → major → minor → nit', () => {
			const body = renderReviewBody(
				context({
					handoff: handoff({
						verdict: 'request-changes',
						findings: [nit, { ...blocker, id: 'F3', severity: 'major' }, blocker],
					}),
				}),
			);
			expect(body.indexOf('## F1 · blocker')).toBeLessThan(body.indexOf('## F3 · major'));
			expect(body.indexOf('## F3 · major')).toBeLessThan(body.indexOf('**F2** · nit'));
		});
	});

	describe('verification', () => {
		it('tabulates commands and marks a failing one', () => {
			const body = renderReviewBody(
				context({
					handoff: handoff({
						verification: [
							{ command: 'npm run typecheck', outcome: 'passed' },
							{ command: 'npx vitest run tests/unit', outcome: 'failed' },
						],
					}),
				}),
			);
			expect(body).toContain('| `npm run typecheck` | passed |');
			expect(body).toContain('| `npx vitest run tests/unit` | **failed** |');
		});

		it('reports a per-doc verdict, including a stale one', () => {
			const body = renderReviewBody(
				context({
					handoff: handoff({
						docsChecked: [
							{ path: 'README.md', status: 'not-applicable' },
							{ path: 'ai/ARCHITECTURE.md', status: 'stale', note: 'documents the old invariant' },
						],
					}),
				}),
			);
			expect(body).toContain('`README.md` ✅ correctly untouched');
			expect(body).toContain('`ai/ARCHITECTURE.md` ❌ stale (documents the old invariant)');
		});

		// A piped command is ordinary, and a raw `|` would open a third column and
		// break every row after it.
		it('escapes a pipe in a command so the table survives it', () => {
			const body = renderReviewBody(
				context({
					handoff: handoff({
						verification: [{ command: 'npx vitest run 2>&1 | tail -20', outcome: 'passed' }],
					}),
				}),
			);
			expect(body).toContain('| `npx vitest run 2>&1 \\| tail -20` | passed |');
		});

		it('separates pre-existing conditions from this PR, and omits the line when there are none', () => {
			expect(
				renderReviewBody(
					context({ handoff: handoff({ preExisting: ['48 lint warnings in unrelated files'] }) }),
				),
			).toContain('**Pre-existing, not from this PR** — 48 lint warnings in unrelated files');
			expect(renderReviewBody(context())).not.toContain('Pre-existing');
		});
	});

	describe('re-review disposition', () => {
		// An unresolved carried item is re-reported as a finding under the same id
		// (the schema rejects a hand-off where it isn't), so `F1` appears in both
		// lists here exactly as a real re-review would send it.
		const carried = [
			{ id: 'F1', title: 'headSha spellings', status: 'outstanding', detail: 'Still two.' },
			{
				id: 'F2',
				title: 'verdict removals',
				status: 'resolved',
				detail: 'Both call sites narrowed.',
			},
		];

		it('tabulates every carried finding with its status', () => {
			const body = renderReviewBody(
				context({
					ordinal: 2,
					isReReview: true,
					handoff: handoff({ carried, verdict: 'request-changes', findings: [blocker] }),
				}),
			);
			expect(body).toContain('## Disposition');
			expect(body).toContain('| F1 | headSha spellings | ❌ not addressed |');
			expect(body).toContain('| F2 | verdict removals | ✅ resolved |');
			expect(body).toContain('### F2 · ✅ resolved');
			expect(body).toContain('Both call sites narrowed.');
		});

		it('summarizes carried counts, and the histogram of anything new', () => {
			const body = renderReviewBody(
				context({
					ordinal: 2,
					isReReview: true,
					handoff: handoff({ carried, verdict: 'request-changes', findings: [blocker] }),
				}),
			);
			expect(body).toContain(
				'**Carried: 1 resolved · 1 outstanding** — **1 new** (1 blocker · 0 major · 0 minor · 0 nits)',
			);
		});

		it('reports a fully resolved re-review as zero new findings', () => {
			const body = renderReviewBody(
				context({
					ordinal: 2,
					isReReview: true,
					handoff: handoff({ carried: carried.map((c) => ({ ...c, status: 'resolved' })) }),
				}),
			);
			expect(body).toContain('**Carried: 2 resolved · 0 outstanding** — **0 new findings**');
		});

		it('omits the disposition entirely on an initial review', () => {
			expect(renderReviewBody(context())).not.toContain('## Disposition');
		});

		it('escapes a pipe in a carried title so the disposition table survives it', () => {
			const body = renderReviewBody(
				context({
					ordinal: 2,
					isReReview: true,
					handoff: handoff({
						carried: [
							{ id: 'F1', title: 'the `a | b` union', status: 'resolved', detail: 'Narrowed.' },
						],
					}),
				}),
			);
			expect(body).toContain('| F1 | the `a \\| b` union | ✅ resolved |');
		});
	});

	describe('non-blocking findings nobody will act on', () => {
		// An approval is skipped by the Respond-to-review trigger under the default
		// skipOnMinors, so its minor findings are notes for a human. Saying so is the
		// difference between a note and an apparent work item.
		it('says so when an approval carries them and minors are skipped', () => {
			const body = renderReviewBody(
				context({ minorsAnswered: false, handoff: handoff({ findings: [nit] }) }),
			);
			expect(body).toContain('**no agent will act on them**');
		});

		it('stays silent when the project answers every verdict', () => {
			const body = renderReviewBody(
				context({ minorsAnswered: true, handoff: handoff({ findings: [nit] }) }),
			);
			expect(body).not.toContain('no agent will act on them');
		});

		// A request-changes dispatches Respond-to-review, whose prompt addresses every
		// point including minors — so the note would be false there.
		it('stays silent on a request-changes', () => {
			const body = renderReviewBody(
				context({
					minorsAnswered: false,
					handoff: handoff({ verdict: 'request-changes', findings: [blocker, nit] }),
				}),
			);
			expect(body).not.toContain('no agent will act on them');
		});
	});

	// Every verdict reads as one format, so a human and the respond-to-review agent
	// meet the same skeleton whether the review approved or requested changes.
	it('keeps the findings section on a clean approval', () => {
		const body = renderReviewBody(context());
		expect(body).toContain('## Scope');
		expect(body).toContain('## Verification');
		expect(body).toContain('## Findings');
		expect(body).toContain('None.');
	});

	it('never emits three consecutive newlines', () => {
		const body = renderReviewBody(
			context({
				ordinal: 2,
				isReReview: true,
				handoff: handoff({
					verdict: 'request-changes',
					findings: [blocker, nit],
					preExisting: ['pre-existing warnings'],
					carried: [{ id: 'F1', title: 'x', status: 'regressed', detail: 'y' }],
				}),
			}),
		);
		expect(body).not.toMatch(/\n{3}/);
	});
});
