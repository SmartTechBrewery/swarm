import { describe, expect, it } from 'vitest';
import { DEFAULT_REVIEW_REPORT } from '@/config/review-report.js';
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

	/**
	 * The fold-in declaration's human-facing record (issue #953): a human audits the
	 * decision on the pull request, at the moment it is taken, rather than in a
	 * database column nobody reads.
	 */
	describe('absorbed scope', () => {
		const absorbed = [
			{
				url: 'https://github.com/SmartTechBrewery/swarm/issues/947',
				reference: '#947',
				evidence: 'Its criteria 1-3 are met by `src/pipeline/review-body.ts`.',
			},
		];

		// The overwhelmingly common body must be exactly what it was before this
		// section existed.
		it('renders nothing when the reviewer declared none', () => {
			expect(renderReviewBody(context())).not.toContain('Scope absorbed from another task');
			expect(renderReviewBody(context({ handoff: handoff({ absorbed: [] }) }))).toEqual(
				renderReviewBody(context()),
			);
		});

		it('links each declared task and states the evidence beside it', () => {
			const body = renderReviewBody(context({ handoff: handoff({ absorbed }) }));
			expect(body).toContain('## Scope absorbed from another task');
			expect(body).toContain(
				'| [#947](https://github.com/SmartTechBrewery/swarm/issues/947) | Its criteria 1-3 are met by `src/pipeline/review-body.ts`. |',
			);
		});

		// The section is carried on either verdict, because a re-review is scoped to
		// the previously requested changes and would never restate the declaration.
		it('is rendered on a request-changes review too', () => {
			const body = renderReviewBody(
				context({
					handoff: handoff({ verdict: 'request-changes', findings: [blocker], absorbed }),
				}),
			);
			expect(body).toContain('## Scope absorbed from another task');
		});

		// `evidence` is agent-authored prose; a raw `|` would open a third column and
		// a newline would end the row.
		it('escapes a pipe and a newline in the agent-authored evidence', () => {
			const body = renderReviewBody(
				context({
					handoff: handoff({
						absorbed: [
							{
								...absorbed[0],
								evidence: 'Criterion 2:\n`a.ts` | `b.ts` both land here.',
							},
						],
					}),
				}),
			);
			expect(body).toContain(
				'| [#947](https://github.com/SmartTechBrewery/swarm/issues/947) | Criterion 2: `a.ts` \\| `b.ts` both land here. |',
			);
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

/**
 * A project's own review report layout (issue #1288). The default must stay the
 * report SWARM always posted; a custom one may rearrange and reword it, but can
 * never drop content SWARM and the later phases rely on.
 */
describe('renderReviewBody with a review report layout', () => {
	/** A re-review exercising every slot at once. */
	const fullHandoff = () =>
		handoff({
			verdict: 'request-changes',
			summary: 'Adds the slot-based report.',
			verification: [
				{ command: 'npx vitest run | tail -5', outcome: 'passed' },
				{ command: 'npm run lint', outcome: 'failed' },
			],
			docsChecked: [
				{ path: 'README.md', status: 'accurate' },
				{ path: 'docs/x.md', status: 'stale', note: 'names the old flag' },
			],
			preExisting: ['a lint warning in foo.ts'],
			findings: [
				{
					id: 'F3',
					title: 'stale count',
					severity: 'nit',
					category: 'docs',
					evidence: '`a.ts:1`',
					suggestion: 'Name the map.',
				},
				{
					id: 'F1',
					title: 'wrong key',
					severity: 'blocker',
					category: 'correctness',
					evidence: '`b.ts:2`',
					failureScenario: 'Two events.',
					impact: 'Duplicate runs.',
					fixPlan: ['Abbreviate.', 'Rewrite.'],
					tests: ['Assert equal.'],
				},
				{
					id: 'F2',
					title: 'unclear',
					severity: 'minor',
					category: 'consistency',
					evidence: '`c.ts:3`',
					suggestion: 'Rename.',
					downgradeRationale: 'No behavior change.',
				},
			],
			carried: [
				{ id: 'F1', title: 'wrong key', status: 'outstanding', detail: 'Still two spellings.' },
				{ id: 'F0', title: 'old', status: 'resolved', detail: 'Fixed.' },
			],
			absorbed: [
				{
					url: 'https://github.com/o/r/issues/7',
					reference: '#7',
					evidence: 'Delivers both criteria.',
				},
			],
		});
	const fullContext = (overrides: Partial<ReviewBodyContext> = {}) =>
		context({ ordinal: 2, isReReview: true, handoff: fullHandoff(), ...overrides });

	// Captured from the renderer as it was before layouts existed: with no layout
	// configured the report must not change by a single byte.
	const REPORT_BEFORE_LAYOUTS = `> **First re-review** · pass 2 of 3 · \`request-changes\` · head \`d3022fc0ca3d\`
> **Carried: 1 resolved · 1 outstanding** — **3 new** (1 blocker · 0 major · 1 minor · 1 nit)

## Scope

Adds the slot-based report.

## Disposition

| ID | Finding | Status |
| --- | --- | --- |
| F1 | wrong key | ❌ not addressed |
| F0 | old | ✅ resolved |

### F1 · ❌ not addressed

Still two spellings.

### F0 · ✅ resolved

Fixed.

## Verification

| Command | Result |
| --- | --- |
| \`npx vitest run \\| tail -5\` | passed |
| \`npm run lint\` | **failed** |

**Docs checked** — \`README.md\` ✅ accurate · \`docs/x.md\` ❌ stale (names the old flag)

**Pre-existing, not from this PR** — a lint warning in foo.ts

## Scope absorbed from another task

The reviewer traced the whole scope of the task(s) below through this diff, so this pull
request delivers them too. Nothing is closed by this review: the declaration is recorded
here and on the run, for the merge that settles them.

| Task | What this PR delivers for it |
| --- | --- |
| [#7](https://github.com/o/r/issues/7) | Delivers both criteria. |

---

## F1 · blocker · correctness — wrong key

**Evidence.** \`b.ts:2\`

**Failure scenario.** Two events.

**Impact.** Duplicate runs.

**Fix plan.**

1. Abbreviate.
2. Rewrite.

**Tests.**

- Assert equal.

## Minor & nits

### Minor

**F2** · minor · consistency · \`c.ts:3\` — Rename.
*Why it is minor, not major:* No behavior change.

### Nits

**F3** · nit · docs · \`a.ts:1\` — Name the map.`;

	it('renders the pre-layout report byte for byte when no layout is set', () => {
		expect(renderReviewBody(fullContext())).toBe(REPORT_BEFORE_LAYOUTS);
	});

	it('renders the same report from the default layout written out', () => {
		expect(renderReviewBody(fullContext({ layout: DEFAULT_REVIEW_REPORT }))).toBe(
			REPORT_BEFORE_LAYOUTS,
		);
	});

	// The agent is only asked for labels beside a custom layout; any it writes on
	// the default must not leak into the English report.
	it('ignores reportLabels on the default layout', () => {
		const labelled = fullHandoff();
		labelled.reportLabels = { review: 'Przegląd', firstReReview: 'Pierwsza ponowna recenzja' };
		expect(renderReviewBody(fullContext({ handoff: labelled }))).toBe(REPORT_BEFORE_LAYOUTS);
	});

	const POLISH_LAYOUT = [
		'> {pass} · `{verdict}` · commit `{head}`',
		'> {findings_summary}',
		'',
		'## Zakres',
		'',
		'{summary}',
		'',
		'{disposition}',
		'',
		'## Weryfikacja',
		'',
		'{verification}',
		'',
		'**Sprawdzone dokumenty** — {docs_checked}',
		'',
		'{pre_existing}',
		'',
		'{absorbed}',
		'',
		'{blocking_findings}',
		'',
		'{other_findings}',
	].join('\n');

	const POLISH_LABELS = {
		firstReReview: 'Pierwsza ponowna recenzja',
		passOf: 'przebieg {ordinal} z {cap}',
		verdictRequestChanges: 'prośba o zmiany',
		carriedCounts: 'Przeniesione: rozwiązane {resolved} · otwarte {outstanding}',
		newFindings: 'nowe: {count}',
		countBlocker: 'blokujące: {count}',
		severityBlocker: 'blokujące',
		severityMinor: 'drobne',
		categoryCorrectness: 'poprawność',
		dispositionHeading: 'Rozstrzygnięcie',
		carriedOutstanding: 'nierozwiązane',
		columnCommand: 'Polecenie',
		outcomeFailed: 'niepowodzenie',
		docStale: 'nieaktualny',
		evidence: 'Dowody',
		fixPlan: 'Plan naprawy',
		minorAndNitsHeading: 'Drobne uwagi',
		downgradeRationale: 'Dlaczego {severity}, a nie poważne:',
	};

	it('renders a custom layout in the wording the agent translated', () => {
		const labelled = fullHandoff();
		labelled.reportLabels = POLISH_LABELS;
		const body = renderReviewBody(fullContext({ handoff: labelled, layout: POLISH_LAYOUT }));
		expect(body).toContain(
			'> **Pierwsza ponowna recenzja** · przebieg 2 z 3 · `prośba o zmiany` · commit `d3022fc0ca3d`',
		);
		expect(body).toContain(
			'**Przeniesione: rozwiązane 1 · otwarte 1** — **nowe: 3** (blokujące: 1 · ',
		);
		expect(body).toContain('## Zakres');
		expect(body).toContain('## Rozstrzygnięcie');
		expect(body).toContain('| F1 | wrong key | ❌ nierozwiązane |');
		expect(body).toContain('| Polecenie | Result |');
		expect(body).toContain('| `npm run lint` | **niepowodzenie** |');
		expect(body).toContain(
			'**Sprawdzone dokumenty** — `README.md` ✅ accurate · `docs/x.md` ❌ nieaktualny',
		);
		expect(body).toContain('## F1 · blokujące · poprawność — wrong key');
		expect(body).toContain('**Dowody.** `b.ts:2`');
		expect(body).toContain('**Plan naprawy.**');
		expect(body).toContain('## Drobne uwagi');
		expect(body).toContain('**F2** · drobne · consistency · `c.ts:3` — Rename.');
		expect(body).toContain('*Dlaczego drobne, a nie poważne:* No behavior change.');
		expect(body).not.toContain('## Scope\n');
	});

	// A label that would drop a count (or name a placeholder SWARM does not fill)
	// is not a translation SWARM can use.
	it('keeps English for a label whose placeholders differ, or that is blank or not a string', () => {
		const labelled = fullHandoff();
		labelled.reportLabels = {
			passOf: 'przebieg',
			newFindings: '{n} nowe',
			review: '  ',
			columnId: 7,
		};
		const body = renderReviewBody(fullContext({ handoff: labelled, layout: POLISH_LAYOUT }));
		expect(body).toContain('pass 2 of 3');
		expect(body).toContain('**3 new**');
		expect(body).toContain('| ID | Finding | Status |');
	});

	it('keeps a translated label on one line and out of the table structure', () => {
		const labelled = fullHandoff();
		labelled.reportLabels = { columnCommand: 'Polecenie |\nwiersz' };
		const body = renderReviewBody(fullContext({ handoff: labelled, layout: POLISH_LAYOUT }));
		expect(body).toContain('| Polecenie \\| wiersz | Result |');
	});

	// The acceptance criterion: a custom layout can never hide a blocking finding.
	it('appends the content of every slot the layout leaves out, in slot order', () => {
		const body = renderReviewBody(fullContext({ layout: '# Raport\n\n{summary}' }));
		expect(
			body.startsWith(
				'# Raport\n\nAdds the slot-based report.\n\n**First re-review** · pass 2 of 3',
			),
		).toBe(true);
		for (const text of [
			'request-changes',
			'd3022fc0ca3d',
			'## Disposition',
			'`npm run lint`',
			'## F1 · blocker',
			'**F2** · minor',
			'**F3** · nit',
			'[#7]',
		]) {
			expect(body).toContain(text);
		}
		expect(body.indexOf('## F1 · blocker')).toBeLessThan(body.indexOf('**F2** · minor'));
	});

	it('appends nothing for an empty slot the layout leaves out', () => {
		const body = renderReviewBody(
			context({
				layout:
					'{pass} {verdict} {head} {findings_summary}\n\n{summary}\n\n{verification}\n\n{docs_checked}\n\n{other_findings}',
			}),
		);
		expect(body).not.toContain('Disposition');
		expect(body).not.toContain('Pre-existing');
		expect(body).not.toContain('Scope absorbed');
		expect(body).not.toMatch(/\n{3}/);
	});

	// Substitution is a single pass, so agent text that happens to contain a slot
	// name — or a `$&` replacement pattern — is posted as written.
	it('never substitutes slots inside agent-written text, and leaves unknown braces alone', () => {
		const body = renderReviewBody(
			context({
				layout: '{summary}\n\n{unknown}',
				handoff: handoff({ summary: 'Mentions {verdict} and $& literally.' }),
			}),
		);
		expect(body.startsWith('Mentions {verdict} and $& literally.\n\n{unknown}')).toBe(true);
	});

	// Wording, never semantics: an unusable `reportLabels` must not fail a review.
	it('drops a malformed reportLabels instead of rejecting the hand-off', () => {
		expect(handoff({ reportLabels: 'nie' }).reportLabels).toBeUndefined();
		expect(handoff({ reportLabels: { review: 'Przegląd' } }).reportLabels).toEqual({
			review: 'Przegląd',
		});
	});
});
