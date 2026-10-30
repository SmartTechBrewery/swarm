/**
 * Branch name patterns (issue #1241) — how a repository names its task branches.
 *
 * A task branch used to be `<branchPrefix><taskId>`, which can only put text
 * *before* the task id. A pattern composes the name from literal text and three
 * elements, written `{name}` rather than `$name` so a pattern pasted into a shell or
 * a doc is never expanded:
 *
 * - `{issue_key}` — the task id in its original form (`VT-1538`, `42`), never
 *   lowercased: Jira links a branch to its card's Development panel by the
 *   uppercase key.
 * - `{work_type}` — one Conventional Commits type from {@link WORK_TYPES}, chosen by
 *   the implementer from the task's scope.
 * - `{friendly_name}` — a short kebab-case ASCII name for the change, chosen by the
 *   implementer.
 *
 * `{issue_key}` appears exactly once, which is what lets SWARM read the task back
 * out of a branch it named ({@link taskIdFromPatternBranch}). A repository that
 * states only the legacy `branchPrefix` runs on `<prefix>{issue_key}`
 * ({@link branchPatternFromPrefix}), which renders exactly the old name.
 *
 * Dependency-free on purpose: the dashboard's pattern editor imports this module
 * for the same validation and preview the server applies, so the browser can never
 * accept a pattern the config schema refuses.
 */

/** The task-id grammar (ai/ARCHITECTURE.md "Task identity"): an SCM artifact number or a board key. */
export const TASK_ID_FORMS = String.raw`\d+|[A-Z][A-Z0-9_]*-\d+`;

/** Every element a pattern may contain, in the order the editor lists them. */
export const BRANCH_PATTERN_ELEMENTS = ['issue_key', 'work_type', 'friendly_name'] as const;
export type BranchPatternElement = (typeof BRANCH_PATTERN_ELEMENTS)[number];

/** The closed `{work_type}` vocabulary — the Conventional Commits types. */
export const WORK_TYPES = [
	'feat',
	'fix',
	'refactor',
	'perf',
	'test',
	'docs',
	'build',
	'ci',
	'chore',
	'revert',
] as const;
export type WorkType = (typeof WORK_TYPES)[number];

/** The `{work_type}` used when the implementer named none SWARM can read. */
export const FALLBACK_WORK_TYPE: WorkType = 'chore';

/** `{friendly_name}` is at most this many kebab-case words. */
export const FRIENDLY_NAME_MAX_WORDS = 5;

/** `{friendly_name}` is at most this many characters, cut at a word boundary. */
export const FRIENDLY_NAME_MAX_LENGTH = 40;

/** The legacy prefix a repository stating none runs on (`PROJECT_DEFAULTS.branchPrefix`). */
export const DEFAULT_BRANCH_PREFIX = 'issue-';

/** The pattern a repository stating neither a pattern nor a prefix runs on — today's `issue-<id>`. */
export const DEFAULT_BRANCH_PATTERN = `${DEFAULT_BRANCH_PREFIX}{issue_key}`;

/** What each element stands for, as the editor describes it. */
export const BRANCH_PATTERN_ELEMENT_DESCRIPTIONS: Record<BranchPatternElement, string> = {
	issue_key:
		'The task id exactly as the task names it — VT-1538 for a board card, 42 for an issue. Required, exactly once; never lowercased.',
	work_type: `The kind of change, chosen by the implementer from the task's scope: one of ${WORK_TYPES.join(', ')} (the Conventional Commits types).`,
	friendly_name: `A short name for the change chosen by the implementer: lowercase ASCII words joined by hyphens, diacritics transliterated, 2–${FRIENDLY_NAME_MAX_WORDS} words, at most ${FRIENDLY_NAME_MAX_LENGTH} characters.`,
};

/** The sample task the editor previews a pattern with. */
export const SAMPLE_BRANCH_NAME_PARTS = {
	issueKey: 'VT-1538',
	workType: 'feat',
	friendlyName: 'pierwsza-strona-testowa',
} as const satisfies BranchNameParts;

/** The values a pattern is rendered with. */
export interface BranchNameParts {
	issueKey: string;
	workType?: WorkType;
	friendlyName?: string;
}

type Segment = { kind: 'literal'; text: string } | { kind: 'element'; name: BranchPatternElement };

/** What {@link validateBranchPattern} found: errors block saving, warnings only inform. */
export interface BranchPatternValidation {
	errors: string[];
	warnings: string[];
}

const SEPARATORS = new Set(['/', '-', '_']);
const LITERAL_CHARACTER = /^[A-Za-z0-9/_-]$/;
const ELEMENT_TOKEN = /\{([^{}]*)\}/g;
const FRIENDLY_NAME_FORM = `[a-z0-9]+(?:-[a-z0-9]+){0,${FRIENDLY_NAME_MAX_WORDS - 1}}`;

function isElement(name: string): name is BranchPatternElement {
	return (BRANCH_PATTERN_ELEMENTS as readonly string[]).includes(name);
}

/** Whether `value` is one of the {@link WORK_TYPES}. */
export function isWorkType(value: string): value is WorkType {
	return (WORK_TYPES as readonly string[]).includes(value);
}

/**
 * Split a pattern into literal text and elements, collecting what makes it
 * unreadable (an unknown element, a stray brace) rather than throwing on the first.
 */
function tokenize(pattern: string): { segments: Segment[]; errors: string[] } {
	const segments: Segment[] = [];
	const errors: string[] = [];
	let last = 0;
	const pushLiteral = (text: string): void => {
		if (!text) return;
		if (text.includes('{') || text.includes('}')) {
			errors.push('Every "{" must close an element with "}", e.g. {issue_key}.');
		}
		segments.push({ kind: 'literal', text });
	};
	for (const match of pattern.matchAll(ELEMENT_TOKEN)) {
		pushLiteral(pattern.slice(last, match.index));
		const name = match[1] ?? '';
		if (isElement(name)) segments.push({ kind: 'element', name });
		else errors.push(`Unknown element {${name}} — use ${elementList()}.`);
		last = match.index + match[0].length;
	}
	pushLiteral(pattern.slice(last));
	return { segments, errors };
}

function elementList(): string {
	return BRANCH_PATTERN_ELEMENTS.map((name) => `{${name}}`).join(', ');
}

/**
 * Check a pattern against the editor's rules (issue #1241):
 *
 * 1. `{issue_key}` appears exactly once — without it SWARM cannot tie a branch back to
 *    its task, card, WIP slot or merge.
 * 2. Literal text uses only letters, digits and the separators `/`, `-`, `_`, and every
 *    element stands between separators (or at either end), so the rendered name can be
 *    read back unambiguously.
 * 3. The rendered name is a valid git branch name (`git check-ref-format --branch`).
 *
 * A **warning**, not an error, when the name ends in a bare `{issue_key}`: git cannot
 * hold `VT-1538` and `VT-1538/…` at once, so a flat key blocks every `KEY/…` branch a
 * person would create.
 */
export function validateBranchPattern(pattern: string): BranchPatternValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (pattern.trim() === '') {
		return { errors: ['The pattern is empty — it needs at least {issue_key}.'], warnings };
	}
	const { segments, errors: tokenErrors } = tokenize(pattern);
	errors.push(...tokenErrors);

	const issueKeys = segments.filter((s) => s.kind === 'element' && s.name === 'issue_key').length;
	if (issueKeys === 0) {
		errors.push('The pattern must contain {issue_key} — SWARM reads the task back from it.');
	} else if (issueKeys > 1) {
		errors.push('{issue_key} must appear exactly once.');
	}

	errors.push(...literalCharacterErrors(segments), ...separationErrors(segments));

	if (errors.length === 0) {
		const sample = renderSegments(segments, SAMPLE_BRANCH_NAME_PARTS);
		const refError = branchNameError(sample);
		if (refError)
			errors.push(`The pattern renders "${sample}", which is not a valid branch: ${refError}`);
		const lastComponent = pattern.split('/').at(-1);
		if (lastComponent === '{issue_key}') {
			warnings.push(
				`The branch ends in a bare issue key ("${sample}"). Git cannot hold "${sample}" and "${sample}/…" at once, so this blocks every KEY/… branch people create by hand — add something after the key, e.g. {issue_key}/{friendly_name}.`,
			);
		}
	}
	return { errors: [...new Set(errors)], warnings };
}

/** Rule 2's first half: literal text uses only letters, digits and the separators. */
function literalCharacterErrors(segments: Segment[]): string[] {
	const badCharacters = new Set<string>();
	for (const segment of segments) {
		if (segment.kind !== 'literal') continue;
		for (const character of segment.text) {
			// A stray brace is reported by `tokenize` already, in its own words.
			if (character !== '{' && character !== '}' && !LITERAL_CHARACTER.test(character)) {
				badCharacters.add(character);
			}
		}
	}
	if (badCharacters.size === 0) return [];
	const found = [...badCharacters].map((c) => JSON.stringify(c)).join(', ');
	return [
		`Literal text may use only letters, digits and the separators /, - and _ (found ${found}).`,
	];
}

/** Rule 2's second half: every element stands between separators, or at either end. */
function separationErrors(segments: Segment[]): string[] {
	const errors: string[] = [];
	segments.forEach((segment, index) => {
		if (segment.kind !== 'element') return;
		const before = segments[index - 1];
		const after = segments[index + 1];
		const separatedBefore =
			!before || (before.kind === 'literal' && SEPARATORS.has(before.text.at(-1) ?? ''));
		const separatedAfter =
			!after || (after.kind === 'literal' && SEPARATORS.has(after.text.at(0) ?? ''));
		if (!separatedBefore || !separatedAfter) {
			errors.push(
				`{${segment.name}} must be separated from the text around it by /, - or _ (or start/end the pattern).`,
			);
		}
	});
	return errors;
}

/** Whether {@link validateBranchPattern} finds no error in `pattern`. */
export function isValidBranchPattern(pattern: string): boolean {
	return validateBranchPattern(pattern).errors.length === 0;
}

/** The pattern a legacy `branchPrefix` stands for — `<prefix>{issue_key}`, rendering the old name exactly. */
export function branchPatternFromPrefix(prefix: string): string {
	return `${prefix}{issue_key}`;
}

/** Whether the pattern has a part the implementer chooses, so the name is only known after it runs. */
export function branchPatternNeedsImplementer(pattern: string): boolean {
	return pattern.includes('{work_type}') || pattern.includes('{friendly_name}');
}

/**
 * Render a pattern for one task. `{issue_key}` is used verbatim; `{friendly_name}` is
 * normalised through {@link toFriendlyName}. Throws when the pattern needs a part
 * `parts` lacks, or the friendly name normalises to nothing — the caller supplies
 * its fallbacks first.
 */
export function renderBranchName(pattern: string, parts: BranchNameParts): string {
	return renderSegments(tokenize(pattern).segments, parts);
}

function renderSegments(segments: Segment[], parts: BranchNameParts): string {
	return segments
		.map((segment) =>
			segment.kind === 'literal' ? segment.text : elementValue(segment.name, parts),
		)
		.join('');
}

function elementValue(name: BranchPatternElement, parts: BranchNameParts): string {
	if (name === 'issue_key') return parts.issueKey;
	if (name === 'work_type') {
		if (!parts.workType) throw new Error('The branch pattern needs a {work_type}');
		return parts.workType;
	}
	const friendlyName = toFriendlyName(parts.friendlyName ?? '');
	if (!friendlyName) throw new Error('The branch pattern needs a {friendly_name}');
	return friendlyName;
}

/**
 * What each element matches when reading a branch back. Validated literal text is
 * letters, digits and `/ - _` — nothing a regex reads specially — so it is used as-is.
 */
const ELEMENT_FORMS: Record<BranchPatternElement, string> = {
	issue_key: `(${TASK_ID_FORMS})`,
	work_type: `(?:${WORK_TYPES.join('|')})`,
	friendly_name: FRIENDLY_NAME_FORM,
};

const patternRegexCache = new Map<string, RegExp | null>();

/**
 * The regex a branch named by `pattern` matches, capturing its task id — `null` for a
 * pattern that does not validate. `{friendly_name}` matches only what
 * {@link toFriendlyName} can produce and `{work_type}` only the closed list, so a
 * branch is recognised only in a shape SWARM itself renders.
 */
function patternRegex(pattern: string): RegExp | null {
	const cached = patternRegexCache.get(pattern);
	if (cached !== undefined) return cached;
	let regex: RegExp | null = null;
	if (isValidBranchPattern(pattern)) {
		const source = tokenize(pattern)
			.segments.map((segment) =>
				segment.kind === 'literal' ? segment.text : ELEMENT_FORMS[segment.name],
			)
			.join('');
		regex = new RegExp(`^${source}$`);
	}
	patternRegexCache.set(pattern, regex);
	return regex;
}

/**
 * The task id a branch named by `pattern` carries, or `undefined` when the branch is
 * not in that pattern's shape (or the pattern does not validate). The whole branch
 * must match — the pattern-shaped twin of the legacy strict prefix parse.
 */
export function taskIdFromPatternBranch(branch: string, pattern: string): string | undefined {
	return patternRegex(pattern)?.exec(branch)?.[1];
}

/** Letters NFKD does not decompose into an ASCII base plus a mark. */
const TRANSLITERATIONS: Record<string, string> = {
	ł: 'l',
	Ł: 'l',
	đ: 'd',
	Đ: 'd',
	ø: 'o',
	Ø: 'o',
	ß: 'ss',
	æ: 'ae',
	Æ: 'ae',
	œ: 'oe',
	Œ: 'oe',
	þ: 'th',
	Þ: 'th',
	ð: 'd',
	Ð: 'd',
	ı: 'i',
};

/**
 * Normalise free text into a `{friendly_name}`: diacritics transliterated (`ą`→`a`,
 * `ł`→`l`), lowercased, every other run of characters a single hyphen, at most
 * {@link FRIENDLY_NAME_MAX_WORDS} words and {@link FRIENDLY_NAME_MAX_LENGTH}
 * characters (cut at a word boundary). `''` when nothing ASCII survives.
 */
export function toFriendlyName(text: string): string {
	const ascii = [...text]
		.map((character) => TRANSLITERATIONS[character] ?? character)
		.join('')
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase();
	const words = ascii
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.slice(0, FRIENDLY_NAME_MAX_WORDS);
	let name = '';
	for (const word of words) {
		const next = name ? `${name}-${word}` : word;
		if (next.length > FRIENDLY_NAME_MAX_LENGTH) break;
		name = next;
	}
	return name || (words[0]?.slice(0, FRIENDLY_NAME_MAX_LENGTH) ?? '');
}

/**
 * The `{work_type}` a Conventional Commits subject states (`fix(api): …` → `fix`), or
 * `undefined` when it states none from {@link WORK_TYPES}.
 */
export function workTypeFromCommitSubject(subject: string): WorkType | undefined {
	const type = /^([a-z]+)(?:\([^)]*\))?!?:/i.exec(subject.trim())?.[1]?.toLowerCase();
	return type && isWorkType(type) ? type : undefined;
}

/**
 * The rules of `git check-ref-format --branch`, each as "broken when" plus the reason,
 * restated so the dashboard can apply them without git.
 */
const BRANCH_NAME_RULES: ReadonlyArray<readonly [(name: string) => boolean, string]> = [
	[(name) => name === '', 'it is empty'],
	[(name) => name === '@' || name === 'HEAD', 'it is a name git reserves'],
	[(name) => name.startsWith('-'), 'it starts with "-"'],
	[(name) => name.startsWith('/') || name.endsWith('/'), 'it starts or ends with "/"'],
	[(name) => name.includes('//'), 'it contains "//"'],
	[(name) => name.includes('..'), 'it contains ".."'],
	[(name) => name.includes('@{'), 'it contains "@{"'],
	[(name) => name.endsWith('.'), 'it ends with "."'],
	// biome-ignore lint/suspicious/noControlCharactersInRegex: git forbids control characters in a ref
	[(name) => /[\x00-\x20\x7f~^:?*[\\]/.test(name), 'it contains a character git forbids in a ref'],
	[(name) => name.split('/').some((c) => c.startsWith('.')), 'a path component starts with "."'],
	[
		(name) => name.split('/').some((c) => c.endsWith('.lock')),
		'a path component ends with ".lock"',
	],
];

/** Why `name` is not a valid git branch name, or `undefined` when it is. */
export function branchNameError(name: string): string | undefined {
	return BRANCH_NAME_RULES.find(([broken]) => broken(name))?.[1];
}
