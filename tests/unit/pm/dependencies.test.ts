import { describe, expect, it } from 'vitest';

import {
	blockedRunMessage,
	dedupeBlockers,
	dependencyProse,
	findDependencyReferences,
	openBlockers,
} from '@/pm/dependencies.js';
import type { WorkItemBlocker } from '@/pm/types.js';

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
});
