import { describe, expect, it } from 'vitest';

import {
	blockedRunMessage,
	dedupeBlockers,
	dependencyProse,
	findDependencyReferences,
	openBlockers,
	partitionBlockersBySource,
	proseAdvisoryCommentBody,
	proseAdvisoryMarker,
} from '@/pm/dependencies.js';
import type { WorkItemBlocker } from '@/pm/types.js';
import { isSwarmGeneratedBody } from '@/scm/swarm-origin.js';

function blocker(overrides: Partial<WorkItemBlocker> = {}): WorkItemBlocker {
	return {
		reference: '#319',
		url: 'https://github.com/o/r/issues/319',
		title: 'Session auth',
		open: true,
		source: 'dependency',
		...overrides,
	};
}

describe('findDependencyReferences', () => {
	it('finds a "blocked by #N" reference', () => {
		expect(findDependencyReferences('This is blocked by #319 for now.')).toEqual(['319']);
	});

	it('finds "depends on", "requires", and "must be done first" phrasings', () => {
		expect(findDependencyReferences('Depends on #12.')).toEqual(['12']);
		expect(findDependencyReferences('Requires #7 first.')).toEqual(['7']);
		expect(findDependencyReferences('#42 must be merged first.')).toEqual(['42']);
	});

	it('resolves an issues/ URL reference near a keyword', () => {
		expect(
			findDependencyReferences('Blocked by https://github.com/o/r/issues/281 — wait for it.'),
		).toEqual(['281']);
	});

	it('resolves an issues/ URL even when the dot ending the sentence follows it', () => {
		// The dot in `github.com` must not split the URL away from its keyword; only a
		// sentence-ending dot (followed by whitespace/end) is a clause boundary.
		expect(findDependencyReferences('Blocked by https://github.com/o/r/issues/281.')).toEqual([
			'281',
		]);
	});

	it('collects multiple distinct references and de-duplicates', () => {
		expect(findDependencyReferences('Blocked by #1 and #2.\nAlso depends on #2 and #3.')).toEqual([
			'1',
			'2',
			'3',
		]);
	});

	it('ignores issue references with no dependency keyword nearby (conservative)', () => {
		// A plain mention on its own clause is not a dependency — no false positives.
		expect(findDependencyReferences('See #100 for context. Fixes #101.')).toEqual([]);
	});

	it('does not sweep a reference from a neighbouring clause', () => {
		// "#200" is in a separate sentence from the "blocked by" clause.
		expect(findDependencyReferences('This is blocked by #10. Unrelated note about #200.')).toEqual([
			'10',
		]);
	});

	it('returns [] for empty text', () => {
		expect(findDependencyReferences('')).toEqual([]);
	});

	it('does not read work that depends ON this item as a prerequisite (issue #636)', () => {
		// The clause that deadlocked run bdd362d7-c059-4e40-b7d7-fcd60ac502ba: one
		// sentence on item 633 carried "Depends on" (whose object is the prose
		// "phase 1", no issue number) and, ~190 characters later, a reference to
		// work that depends *on* 633 — so the referenced issue could never close
		// first and the gate re-checked until the wait budget ran out. Keep the
		// fixture here rather than in the issue prose: written out, it declares the
		// very dependency it describes.
		const clause =
			'Depends on phase 1 ("PM tab presentation 1/2") having landed: the two phases touch disjoint files, but the tab’s credential copy must already be correct before a provider section is placed above it — and #631, the dashboard-side provider switch, builds on the section this phase creates.';
		expect(findDependencyReferences(clause)).toEqual([]);
	});

	it('does not bind a later dependent through an earlier prerequisite phrase', () => {
		expect(findDependencyReferences('Depends on #12, but #631 is blocked by this task.')).toEqual([
			'12',
		]);
		expect(
			findDependencyReferences('#12 must be done first, but #631 is blocked by this task.'),
		).toEqual(['12']);
	});

	it('drops a dependency phrase whose object is this item', () => {
		// The keyword leads, yet the relation runs the other way — the reference is
		// the dependent side, not a prerequisite.
		expect(findDependencyReferences('Blocked by this phase, #631 will follow.')).toEqual([]);
		expect(findDependencyReferences('Issue #631 is blocked by this phase.')).toEqual([]);
		expect(
			findDependencyReferences('This phase must be merged first, then #631 can start.'),
		).toEqual([]);
	});

	it('binds an object-side phrase forwards and a subject-side phrase backwards', () => {
		// "#631 depends on X" states what #631 needs, not what this item needs.
		expect(
			findDependencyReferences('#631 depends on the provider section this phase adds.'),
		).toEqual([]);
		expect(findDependencyReferences('This work is a prerequisite for #631.')).toEqual([]);
		// …while the mirror phrasings still resolve their prerequisite.
		expect(findDependencyReferences('#42 needs to land first.')).toEqual(['42']);
		expect(findDependencyReferences('#12 is a prerequisite for this work.')).toEqual(['12']);
		expect(findDependencyReferences('Waiting for #12 to close before this can start.')).toEqual([
			'12',
		]);
		expect(findDependencyReferences('Prerequisite: #630, #633.')).toEqual(['630', '633']);
	});

	it('reads "needs to land" from either side, but only with the reference as its object', () => {
		expect(findDependencyReferences('Also needs to land #11 first.')).toEqual(['11']);
		expect(findDependencyReferences('#11 needs to land first.')).toEqual(['11']);
		// The elided subject is this item, so the reference after "before" is what
		// waits on *us* — the direction that deadlocked run bdd362d7.
		expect(findDependencyReferences('This needs to land before #631 can start.')).toEqual([]);
	});

	it('requires the reference to sit near the phrase that binds it', () => {
		// Inside the window: a short noun phrase between the two.
		expect(findDependencyReferences('Blocked by the session-auth groundwork in #319.')).toEqual([
			'319',
		]);
		// Far outside it: the sentence has moved on to other subject matter.
		expect(
			findDependencyReferences(
				'Depends on phase 1, which is the bulk of the credentials work and touches a dozen files across the dashboard and the API router, so #631 stays open until then.',
			),
		).toEqual([]);
	});

	it('measures the window to the reference token, so a long issue URL still binds', () => {
		// The gap is charged from the token start, not the `/issues/N` match index,
		// so the org/repo path's own length never pushes a URL out of the window.
		expect(
			findDependencyReferences(
				'Blocked by https://github.com/SmartTechBrewery/swarm/issues/636 for now.',
			),
		).toEqual(['636']);
	});
});

describe('dependencyProse', () => {
	it('combines description and human comments while filtering out SWARM-generated comments', () => {
		const preplanComment = `## 🗺️ Preplan — Phase 1 of 2\n\nRequires #100.\n<!-- swarm-preplan-comment:abc:0 -->\n---\n<!-- swarm-footer -->`;
		const planComment = `SWARM plan for task...\nRequires #101.\n---\n<!-- swarm-footer -->`;
		const humanComment = `Human note: this is blocked by #102.`;

		const prose = dependencyProse('Parent issue description: requires #99.', [
			preplanComment,
			humanComment,
			planComment,
		]);

		expect(prose).toContain('Parent issue description: requires #99.');
		expect(prose).toContain('Human note: this is blocked by #102.');
		expect(prose).not.toContain('Requires #100.');
		expect(prose).not.toContain('Requires #101.');
	});
});

describe('openBlockers', () => {
	it('keeps only the still-open blockers', () => {
		const list = [blocker({ open: true }), blocker({ open: false, reference: '#5' })];
		expect(openBlockers(list).map((b) => b.reference)).toEqual(['#319']);
	});
});

// Issue #643: `source` decides a blocker's authority, not just its wording.
describe('partitionBlockersBySource', () => {
	it('gates on a native relationship and only advises on a prose mention', () => {
		const { gating, advisory } = partitionBlockersBySource([
			blocker({ reference: '#319', source: 'dependency' }),
			blocker({ reference: '#631', source: 'mention' }),
		]);
		expect(gating.map((b) => b.reference)).toEqual(['#319']);
		expect(advisory.map((b) => b.reference)).toEqual(['#631']);
	});

	it('returns two empty lists for no blockers', () => {
		expect(partitionBlockersBySource([])).toEqual({ gating: [], advisory: [] });
	});
});

describe('proseAdvisoryMarker', () => {
	it('is stable for the same reference set whatever the order', () => {
		const a = proseAdvisoryMarker([blocker({ reference: '#12' }), blocker({ reference: '#7' })]);
		const b = proseAdvisoryMarker([blocker({ reference: '#7' }), blocker({ reference: '#12' })]);
		expect(a).toBe(b);
	});

	it('differs for a different reference set, so a later prerequisite gets its own notice', () => {
		expect(proseAdvisoryMarker([blocker({ reference: '#7' })])).not.toBe(
			proseAdvisoryMarker([blocker({ reference: '#8' })]),
		);
	});
});

describe('proseAdvisoryCommentBody', () => {
	const body = proseAdvisoryCommentBody([
		blocker({ reference: '#631', title: 'Hold PM credentials', url: 'https://x/631' }),
	]);

	it('names the reference, its title and its URL', () => {
		expect(body).toContain('#631');
		expect(body).toContain('Hold PM credentials');
		expect(body).toContain('https://x/631');
	});

	it('says the run was not held back and asks for a recorded relationship', () => {
		expect(body).toMatch(/did not hold the run back/i);
		expect(body).toMatch(/record it on the board/i);
	});

	it('carries its own marker so the notice is idempotent', () => {
		expect(body).toContain(proseAdvisoryMarker([blocker({ reference: '#631' })]));
	});

	// The notice names issue references beside the words "prerequisite" and "blocked
	// by". It is recognisable as SWARM's own writing, so the scan skips it — a notice
	// that gated the next run on the issue it asks about would be this bug wearing a hat.
	it('is recognised as SWARM-generated, so the prose scan never reads it back', () => {
		expect(isSwarmGeneratedBody(body)).toBe(true);
		expect(findDependencyReferences(dependencyProse(undefined, [body]))).toEqual([]);
	});
});

describe('dedupeBlockers', () => {
	it('collapses the same URL and prefers the native dependency over a bare mention', () => {
		const url = 'https://github.com/o/r/issues/9';
		const merged = dedupeBlockers([
			blocker({ url, reference: '#9', source: 'mention' }),
			blocker({ url, reference: '#9', source: 'dependency' }),
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0].source).toBe('dependency');
	});

	it('keeps distinct URLs', () => {
		const merged = dedupeBlockers([
			blocker({ url: 'a', reference: '#1' }),
			blocker({ url: 'b', reference: '#2' }),
		]);
		expect(merged).toHaveLength(2);
	});
});

describe('blockedRunMessage', () => {
	it('names the single blocker in a "must be done first" message', () => {
		expect(blockedRunMessage([blocker()])).toContain('#319');
		expect(blockedRunMessage([blocker()])).toMatch(/must be done first/i);
	});

	it('lists every blocker when there is more than one', () => {
		const msg = blockedRunMessage([blocker(), blocker({ reference: '#5', title: 'DB' })]);
		expect(msg).toContain('#319');
		expect(msg).toContain('#5');
	});

	// Issue #636: the message is where a human learns whether the gate rests on a
	// recorded relationship or on the prose scan's reading of a sentence. The gate only
	// passes native blockers since #643, but the formatter still labels either source —
	// the `mention` case below is what keeps that vocabulary honest.
	it('names a native relationship as the source of a single blocker', () => {
		const msg = blockedRunMessage([blocker({ source: 'dependency' })]);
		expect(msg).toContain('native blocked-by relationship');
		expect(msg).not.toContain('prose mention');
		expect(msg).toMatch(/must be done first/i);
	});

	it('names a prose mention as the source of a single blocker', () => {
		const msg = blockedRunMessage([blocker({ source: 'mention' })]);
		expect(msg).toContain('prose mention in the item description or comments');
		expect(msg).not.toContain('native blocked-by relationship');
		expect(msg).toMatch(/must be done first/i);
	});

	it('annotates each blocker with its own source when the sources differ', () => {
		const msg = blockedRunMessage([
			blocker({ source: 'dependency' }),
			blocker({ reference: '#5', title: 'DB', source: 'mention' }),
		]);
		expect(msg).toContain(
			'#319 (“Session auth”, https://github.com/o/r/issues/319) — native blocked-by relationship',
		);
		expect(msg).toContain(
			'#5 (“DB”, https://github.com/o/r/issues/319) — prose mention in the item description or comments',
		);
	});
});
