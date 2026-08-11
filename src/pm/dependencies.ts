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
 * reference is a *blocking prerequisite* (not just an incidental mention) —
 * the half whose **object** is the prerequisite, so the reference follows the
 * phrase ("blocked by #319", "Prerequisites: #12").
 *
 * Deliberately conservative — a false negative just misses a prose-only
 * dependency (the native relationship and the human still catch it), while a
 * false positive gates real work.
 *
 * **A false positive is not bounded** (issue #636). The note that used to sit
 * here claimed the caller's "defer only while the referenced issue is still
 * open" check bounded the damage. It does not: when the reference names work
 * that depends *on* this item, that issue cannot close until this item lands,
 * so the gate defers, re-checks until `SWARM_DEPENDENCY_MAX_WAIT_MS` is
 * exhausted, and settles the run failed — a deadlock, not a near miss (run
 * `bdd362d7-c059-4e40-b7d7-fcd60ac502ba`, Implementation of item 633, deferred
 * on the issue that was itself waiting for 633). The scan is therefore
 * direction-aware: the keyword list is split by which side of the phrase the
 * prerequisite sits on, and a reference on the wrong side binds nothing.
 * (Direction alone is not the structural guarantee that no cycle ever gates a
 * run — that belongs on the gate side; this only stops the heuristic from
 * inventing one.)
 *
 * Two alternatives are deliberately narrower than the rest. `prerequisites?\s*:`
 * is the one list form that reads object-side ("Prerequisite: #12"); the bare
 * word is subject-side, in {@link LEADING_OBJECT_KEYWORDS}. And "needs to land"
 * reads *both* ways — "#7 needs to land first" and "needs to land #7 first" both
 * make 7 the prerequisite — so it appears in both lists, but here only with the
 * reference as its literal direct object (the lookahead). Without that, "this
 * needs to land before #631 can start" would bind the dependent side again,
 * which is the whole defect above.
 *
 * Both patterns are global so `matchAll` can report match positions — use them
 * *only* with `matchAll`, never `test`/`exec`, whose `lastIndex` is stateful.
 */
const TRAILING_OBJECT_KEYWORDS =
	/\b(?:blocked\s+by|depends?\s+(?:on|upon)|dependent\s+on|requires?|wait(?:s|ing)?\s+for)\b|\bprerequisites?\s*:|\bneeds?\s+to\s+(?:land|merge|ship)\s+(?=#\d|\S*\/issues\/\d)/gi;

/**
 * The mirror half of {@link TRAILING_OBJECT_KEYWORDS}: phrases whose **subject**
 * is the prerequisite, so the reference precedes the phrase ("#42 must be merged
 * first", "#7 is a prerequisite"). Every alternative of the single list this
 * replaced is present in one of the two — no keyword was dropped.
 */
const LEADING_OBJECT_KEYWORDS =
	/\b(?:must\s+(?:be\s+)?(?:done|closed|merged|landed|finished|completed)|needs?\s+to\s+(?:land|merge|ship)|prerequisite)\b/gi;

/**
 * A dependency phrase whose object is *this* item ("blocked by this phase, #631
 * will follow") states what depends **on** the item being scanned, so it binds
 * nothing — the reference beside it is the dependent, not the prerequisite. One
 * noun list, anchored to whichever side of the phrase the object sits on. The
 * leading `\W*` / trailing `\W*` cannot skip a real object: `\W` matches no digit
 * or word character, so it stops at the first token.
 */
const SELF_OBJECT = String.raw`(?:this|the\s+(?:current|present))\s+(?:phase|item|issue|task|card|work(?:\s+item)?|change|pull\s+request|pr)`;
const SELF_OBJECT_AFTER = new RegExp(String.raw`^\W*${SELF_OBJECT}\b`, 'i');
const SELF_OBJECT_BEFORE = new RegExp(String.raw`${SELF_OBJECT}\W*$`, 'i');

/**
 * How far a reference may sit from the phrase that binds it. A clause is a
 * generous container — the deadlock above put "Depends on" and an unrelated
 * reference ~190 characters apart inside one sentence — so binding needs
 * proximity as well as direction. Wide enough for an enumeration ("Blocked by
 * #1, #2, and #3") and for a short noun phrase before the reference ("blocked by
 * the session-auth work in #319"), narrow enough that a sentence which has moved
 * on to other subject matter no longer binds. A module constant, not a setting.
 */
const BINDING_WINDOW_CHARS = 80;

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

/** One issue reference plus the bounds of the whitespace-delimited token carrying it. */
interface ClauseReference {
	readonly number: string;
	readonly tokenStart: number;
	readonly tokenEnd: number;
}

/** Non-global, so it is safe to `test` repeatedly (no `lastIndex` to carry). */
const WHITESPACE = /\s/;

/**
 * Every issue reference in a clause, each widened to its surrounding
 * whitespace-delimited token so the binding window is measured to where the
 * reference's *token* starts rather than to its digits: `/issues/281` matches
 * mid-URL, and charging `https://github.com/<org>/<repo>` against the window
 * would make a long repo path miss.
 */
function clauseReferences(clause: string): ClauseReference[] {
	const refs: ClauseReference[] = [];
	for (const match of clause.matchAll(REFERENCE_PATTERN)) {
		const number = match[1] ?? match[2];
		if (!number) continue;
		let tokenStart = match.index;
		while (tokenStart > 0 && !WHITESPACE.test(clause[tokenStart - 1])) tokenStart--;
		let tokenEnd = match.index + match[0].length;
		while (tokenEnd < clause.length && !WHITESPACE.test(clause[tokenEnd])) tokenEnd++;
		refs.push({ number, tokenStart, tokenEnd });
	}
	return refs;
}

/**
 * The first token of a relation: its phrase unless a nearby reference is its
 * subject ("#631 is blocked by this task"). Treating the subject as the start
 * keeps an earlier relation from absorbing it as a later object.
 */
function relationStart(
	clause: string,
	phraseStart: number,
	refs: readonly ClauseReference[],
): number {
	for (let index = refs.length - 1; index >= 0; index--) {
		const ref = refs[index];
		const gap = phraseStart - ref.tokenEnd;
		if (gap < 0) continue;
		const between = clause.slice(ref.tokenEnd, phraseStart);
		if (
			gap <= BINDING_WINDOW_CHARS &&
			/^\s*(?:(?:is|was|will\s+be|remains?|becomes?)\s+)?(?:an?\s+)?$/.test(between)
		) {
			return ref.tokenStart;
		}
		break;
	}
	return phraseStart;
}

/** Starts of every relation in a clause, including the reference subject where present. */
function relationStarts(clause: string, refs: readonly ClauseReference[]): number[] {
	return [...clause.matchAll(TRAILING_OBJECT_KEYWORDS), ...clause.matchAll(LEADING_OBJECT_KEYWORDS)]
		.map((keyword) => relationStart(clause, keyword.index, refs))
		.sort((left, right) => left - right);
}

/** References an object-side phrase binds: the ones just *after* it. */
function addTrailingObjectRefs(
	clause: string,
	refs: readonly ClauseReference[],
	found: Set<string>,
): void {
	const starts = relationStarts(clause, refs);
	for (const keyword of clause.matchAll(TRAILING_OBJECT_KEYWORDS)) {
		const phraseEnd = keyword.index + keyword[0].length;
		if (SELF_OBJECT_AFTER.test(clause.slice(phraseEnd))) continue;
		const nextRelationStart = starts.find((start) => start > phraseEnd) ?? clause.length;
		for (const ref of refs) {
			const gap = ref.tokenStart - phraseEnd;
			if (gap >= 0 && gap <= BINDING_WINDOW_CHARS && ref.tokenEnd <= nextRelationStart) {
				found.add(ref.number);
			}
		}
	}
}

/** References a subject-side phrase binds: the ones just *before* it. */
function addLeadingObjectRefs(
	clause: string,
	refs: readonly ClauseReference[],
	found: Set<string>,
): void {
	for (const keyword of clause.matchAll(LEADING_OBJECT_KEYWORDS)) {
		const phraseStart = keyword.index;
		if (SELF_OBJECT_BEFORE.test(clause.slice(0, phraseStart))) continue;
		const start = relationStart(clause, phraseStart, refs);
		for (const ref of refs) {
			const gap = phraseStart - ref.tokenEnd;
			if (gap >= 0 && gap <= BINDING_WINDOW_CHARS && ref.tokenStart >= start) {
				found.add(ref.number);
			}
		}
	}
}

/**
 * Find the issue references a work item's prose declares as blocking
 * prerequisites. Splits the text into clauses (newlines / sentence punctuation),
 * then keeps only the references a dependency phrase in that clause actually
 * *binds*: on the phrase's own object side, within {@link BINDING_WINDOW_CHARS}
 * of it, and not when the phrase's object is this item. Returns the unique issue
 * numbers as plain numeric strings (`"319"`), provider-agnostic — the adapter
 * resolves each to a live state.
 */
export function findDependencyReferences(text: string): string[] {
	if (!text) return [];
	const found = new Set<string>();
	// A dependency phrase and its issue ref sit in the same clause, so clause
	// boundaries stay the outer bound — direction and the window then decide which
	// reference *inside* the clause the phrase is actually about.
	for (const clause of text.split(CLAUSE_BOUNDARY)) {
		const refs = clauseReferences(clause);
		if (refs.length === 0) continue;
		addTrailingObjectRefs(clause, refs, found);
		addLeadingObjectRefs(clause, refs, found);
	}
	return [...found];
}

/** Only the blockers that still gate work — the still-open prerequisites. */
export function openBlockers(blockers: readonly WorkItemBlocker[]): WorkItemBlocker[] {
	return blockers.filter((b) => b.open);
}

/**
 * Human copy for a blocker's {@link WorkItemBlocker.source}. The two sources gate
 * a run *identically*, which is exactly why the message has to name them (issue
 * #636): a native relationship is a fact someone recorded on the board, while a
 * prose mention is this module's heuristic reading of a sentence — and therefore
 * the only one of the two a false positive can come from. Without the label, a
 * deferral that shouldn't have happened can only be diagnosed by reproducing the
 * scan by hand, which is what run `bdd362d7-c059-4e40-b7d7-fcd60ac502ba` took.
 */
function blockerSourceLabel(source: WorkItemBlocker['source']): string {
	return source === 'dependency'
		? 'native blocked-by relationship'
		: 'prose mention in the item description or comments';
}

/**
 * The message posted/logged when a run is gated on unfinished prerequisites —
 * the "issue X must be done first" the pipeline surfaces. Lists every open
 * blocker, each annotated with where it came from, so a human sees exactly what
 * to finish and on whose authority (and in a Markdown-friendly form for the board
 * comment).
 */
export function blockedRunMessage(openBlockers: readonly WorkItemBlocker[]): string {
	if (openBlockers.length === 1) {
		const b = openBlockers[0];
		return `Blocked: ${b.reference} (“${b.title}”, ${b.url}) — ${blockerSourceLabel(b.source)} — must be done first.`;
	}
	// Semicolons rather than commas now every entry carries its own em-dashed source:
	// a comma-joined list would read as one run-on clause with no visible boundary
	// between "…, url) — prose mention in the item description or comments" and the
	// next blocker's reference.
	const list = openBlockers
		.map((b) => `${b.reference} (“${b.title}”, ${b.url}) — ${blockerSourceLabel(b.source)}`)
		.join('; ');
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
