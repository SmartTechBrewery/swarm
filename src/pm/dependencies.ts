/**
 * Provider-neutral helpers for cross-item "blocked by" dependencies.
 *
 * The dependency *capability* lives behind {@link PMProvider} (`src/pm/types.ts`):
 * `supportsDependencies` / `listBlockers` / `addBlockedBy`. This module holds the
 * parts that are the same for every provider — the heuristic that finds
 * dependency references in free-text (an item's description/comments) and the
 * human-readable formatting of blockers for comments and deferral messages — so
 * each adapter resolves the same mentions and phrases the same messages without
 * reinventing them (ai/RULES.md §2). The provider-specific half — turning a
 * reference into a live open/closed state — stays inside each adapter.
 */

import { isSwarmGeneratedBody } from '../scm/swarm-origin.js';
import type { WorkItemBlocker } from './types.js';

/**
 * Assemble the free-text prose to scan for dependency references — joining the
 * item's description and non-SWARM-generated comments. SWARM's own comments
 * (preplan comments, split comments, plan comments) are excluded so published
 * plans carrying dependency bullet points never invent self-referential or
 * circular blockers (issue #431).
 */
export function dependencyProse(
	description: string | undefined,
	commentBodies: readonly (string | undefined)[],
): string {
	const humanComments = commentBodies.filter(
		(b): b is string => typeof b === 'string' && !isSwarmGeneratedBody(b),
	);
	return [description ?? '', ...humanComments].join('\n');
}

/**
 * Phrases that, in the same clause as an issue reference, signal that the
 * reference is a *blocking prerequisite* (not just an incidental mention).
 * Deliberately conservative — a false negative just misses a prose-only
 * dependency (the native relationship and the human still catch it), while a
 * false positive would gate real work. Even a false positive is bounded: the
 * caller only defers when the referenced issue is actually still open.
 */
const DEPENDENCY_KEYWORDS =
	/\b(?:blocked\s+by|depends?\s+(?:on|upon)|dependent\s+on|requires?|prerequisite|must\s+(?:be\s+)?(?:done|closed|merged|landed|finished|completed)|needs?\s+to\s+(?:land|merge|ship)|wait(?:s|ing)?\s+for)\b/i;

/** Extract issue numbers from a text segment — both `#123` and `.../issues/123` forms. */
const REFERENCE_PATTERN = /#(\d+)\b|\/issues\/(\d+)\b/g;

/**
 * Clause boundaries: newlines, semicolons, and *sentence-ending* `.`/`?`/`!`
 * (one followed by whitespace or end-of-text). A bare period is deliberately
 * NOT a boundary — an issue URL (`github.com/o/r/issues/281`) and a decimal
 * ("v1.2") both carry a dot mid-token, and splitting on it would strand the
 * `/issues/281` ref in a different clause from its "blocked by" keyword
 * (`#281` is unaffected, but the URL form would be silently missed).
 */
const CLAUSE_BOUNDARY = /[\n\r;]+|[.?!]+(?=\s|$)/;

/**
 * Find the issue references a work item's prose declares as blocking
 * prerequisites. Splits the text into clauses (newlines / sentence punctuation),
 * keeps only clauses that carry a {@link DEPENDENCY_KEYWORDS} phrase, and returns
 * the unique issue numbers referenced in those clauses — as plain numeric strings
 * (`"319"`), provider-agnostic. The adapter resolves each to a live state.
 */
export function findDependencyReferences(text: string): string[] {
	if (!text) return [];
	const found = new Set<string>();
	// A dependency phrase and its issue ref sit in the same clause, so splitting
	// on clause boundaries keeps an unrelated ref on a neighbouring sentence from
	// being swept up by a keyword elsewhere.
	for (const clause of text.split(CLAUSE_BOUNDARY)) {
		if (!DEPENDENCY_KEYWORDS.test(clause)) continue;
		for (const match of clause.matchAll(REFERENCE_PATTERN)) {
			const num = match[1] ?? match[2];
			if (num) found.add(num);
		}
	}
	return [...found];
}

/** Only the blockers that still gate work — the still-open prerequisites. */
export function openBlockers(blockers: readonly WorkItemBlocker[]): WorkItemBlocker[] {
	return blockers.filter((b) => b.open);
}

/**
 * The message posted/logged when a run is gated on unfinished prerequisites —
 * the "issue X must be done first" the pipeline surfaces. Lists every open
 * blocker so a human sees exactly what to finish (and in a Markdown-friendly form
 * for the board comment).
 */
export function blockedRunMessage(openBlockers: readonly WorkItemBlocker[]): string {
	if (openBlockers.length === 1) {
		const b = openBlockers[0];
		return `Blocked: ${b.reference} (“${b.title}”, ${b.url}) must be done first.`;
	}
	const list = openBlockers.map((b) => `${b.reference} (“${b.title}”, ${b.url})`).join(', ');
	return `Blocked: these must be done first — ${list}.`;
}

/**
 * Merge native + mentioned blockers, deduplicated by URL (the stable identity
 * across both sources — a `mention` and a native `dependency` can point at the
 * same issue). A native relationship wins over a bare mention when both exist,
 * since it carries the provider-confirmed id.
 */
export function dedupeBlockers(blockers: readonly WorkItemBlocker[]): WorkItemBlocker[] {
	const byUrl = new Map<string, WorkItemBlocker>();
	for (const b of blockers) {
		const key = b.url || b.reference;
		const existing = byUrl.get(key);
		if (!existing || (existing.source === 'mention' && b.source === 'dependency')) {
			byUrl.set(key, b);
		}
	}
	return [...byUrl.values()];
}
