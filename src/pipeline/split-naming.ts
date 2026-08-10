/**
 * Card naming for Planning's task split (issue #594).
 *
 * A split turns one board card into an ordered run of them, and the only thing
 * that makes those cards recognisable as one piece of work in the Planning column
 * is their titles. The prompt used to ask for `Phase 2/6: …`, which reads the same
 * on every split on the board — so this module owns the convention that replaces
 * it, `<shared task name> <phase>/<total>: <phase-specific task>`, and *enforces*
 * it rather than trusting the model to have followed the instruction: the agent's
 * titles are parsed, stripped of whatever marker they came with, and re-emitted
 * with the split's one shared name. A response that omits the shared prefix, or
 * puts the phase first, therefore cannot leave phase-first cards on the board.
 *
 * Deliberately pure and free of any PM/provider import: it is a string convention,
 * so `src/pipeline/planning.ts` applies it to both the re-scoped original and every
 * generated child from one call.
 */

/**
 * Longest derived shared name, in words and in characters. Only reached on the
 * fallback path — the agent declares `sharedName` and normally prefixes its titles
 * — where the name is condensed out of a full task title, which is a sentence
 * rather than a label. The bound keeps a derived prefix scannable in a board column
 * instead of pushing the phase marker off the end of the card.
 */
const MAX_DERIVED_NAME_WORDS = 6;
const MAX_DERIVED_NAME_CHARS = 48;

/** A title decomposed into its (optional) shared-name/phase marker and the phase's own task. */
export interface ParsedSplitTitle {
	/**
	 * The shared name the title was prefixed with, or `undefined` when it carried
	 * none — which includes the retired phase-first `Phase 2/6: …` spelling, whose
	 * literal "Phase" names no split and is dropped rather than adopted.
	 */
	sharedName?: string;
	/** The phase-specific task: everything after the marker, or the whole title when there is none. */
	task: string;
}

/**
 * Split a title into `<shared name> <phase>/<total>` and the task after the colon.
 *
 * Anchored on the **first** colon: everything before it must end in `<n>/<m>` for
 * the title to count as marked, so an ordinary title that happens to contain a
 * colon (`fix: the thing`) or a slash (`retry/backoff policy`) is returned whole
 * rather than being mistaken for a marker and truncated. Parsing what the convention
 * itself emits round-trips, which is what makes re-normalising an already-correct
 * title a no-op instead of nesting a second prefix.
 */
export function parseSplitTitle(title: string): ParsedSplitTitle {
	const colon = title.indexOf(':');
	if (colon === -1) return { task: title.trim() };
	const head = title.slice(0, colon).trim();
	const task = title.slice(colon + 1).trim();
	const marker = /^(.*?)\s*\d+\s*\/\s*\d+$/.exec(head);
	if (!marker || task.length === 0) return { task: title.trim() };
	// A bare `Phase 2/6:` names no split — it is exactly the generic prefix this
	// convention replaces, so it must not be adopted as the shared name.
	const name = marker[1].trim();
	return { ...(name && !/^phase$/i.test(name) && { sharedName: name }), task };
}

/** Render one card's title in the shared-name-first convention. */
export function formatSplitTitle(
	sharedName: string,
	phase: number,
	totalPhases: number,
	task: string,
): string {
	return `${sharedName} ${phase}/${totalPhases}: ${task}`;
}

/**
 * Reduce a candidate to a usable shared name, or `undefined` when nothing usable
 * is left. A name carrying its own colon or trailing `<n>/<m>` would break the
 * convention's round-trip (the next normalisation would parse the wrong prefix),
 * so both are cut off here rather than being re-emitted verbatim.
 */
function sanitizeSharedName(candidate: string | undefined): string | undefined {
	if (!candidate) return undefined;
	const name = candidate
		.split(':')[0]
		.replace(/\s*\d+\s*\/\s*\d+\s*$/, '')
		.trim();
	return name.length > 0 ? name : undefined;
}

/**
 * Condense a task title into a shared name — the last resort, used when the agent
 * declared no `sharedName` and prefixed none of its titles. Taking the title's
 * opening words keeps the name derived from *this* split's own subject, so two
 * splits with the same phase count still read as different runs of cards.
 */
function deriveSharedName(title: string): string {
	const kept: string[] = [];
	let length = 0;
	for (const word of title.trim().split(/\s+/)) {
		const next = kept.length === 0 ? word.length : length + 1 + word.length;
		if (kept.length > 0 && (kept.length >= MAX_DERIVED_NAME_WORDS || next > MAX_DERIVED_NAME_CHARS))
			break;
		kept.push(word);
		length = next;
	}
	return sanitizeSharedName(kept.join(' ').replace(/[\s\-–—,;.]+$/, '')) ?? title.trim();
}

/** The titles one split's cards are given, and the shared name they all carry. */
export interface SplitNaming {
	sharedName: string;
	/** Phase 1 — the re-scoped original item. */
	mainTaskTitle: string;
	/** Phases 2..N, in order, one per generated child. */
	subTaskTitles: string[];
}

export interface ResolveSplitNamingInput {
	/** `sharedName` as the agent declared it in `proposed_split.json`, when it did. */
	declaredSharedName?: string;
	/** The original item's current board title — the fallback subject the name is derived from. */
	parentTitle: string;
	/** The agent's title for the re-scoped first task; absent when it kept the original's. */
	mainTaskTitle?: string;
	/** The agent's titles for the generated children, in phase order. */
	subTaskTitles: readonly string[];
}

/**
 * Decide every title a split writes, from the agent's proposal (issue #594).
 *
 * The shared name is taken from the first source that yields one — the declared
 * `sharedName`, then a prefix the agent already put on one of its own titles, then
 * a name condensed from the first task — so a model that answered the prompt keeps
 * its wording, and one that ignored it still produces cards a human can group at a
 * glance. Whichever source wins, *one* name is applied to all of them, which is
 * what makes the phases of a split recognisable as a set.
 */
export function resolveSplitNaming(input: ResolveSplitNamingInput): SplitNaming {
	const main = parseSplitTitle(input.mainTaskTitle ?? input.parentTitle);
	const subs = input.subTaskTitles.map(parseSplitTitle);
	const sharedName =
		sanitizeSharedName(input.declaredSharedName) ??
		sanitizeSharedName([main, ...subs].find((parsed) => parsed.sharedName)?.sharedName) ??
		deriveSharedName(main.task || input.parentTitle);
	const totalPhases = subs.length + 1;
	return {
		sharedName,
		mainTaskTitle: formatSplitTitle(sharedName, 1, totalPhases, main.task),
		subTaskTitles: subs.map((sub, index) =>
			formatSplitTitle(sharedName, index + 2, totalPhases, sub.task),
		),
	};
}
