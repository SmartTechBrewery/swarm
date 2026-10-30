/**
 * Commit subject patterns (issue #1242) — how a repository words the commits SWARM
 * makes for a task, and the title of the pull request opened from them.
 *
 * The implementer used to write the whole subject itself, as a Conventional Commits
 * line, so nothing could make it follow the target repository's convention: a Jira +
 * Azure DevOps project whose integration links work by a leading `VT-1538` got
 * `feat: add …`, which it never links. A pattern composes the subject from literal text
 * and the branch name pattern's own elements (`./branch-pattern.ts`), in the same
 * `{name}` syntax:
 *
 * - `{issue_key}` — the task id in its original form (`VT-1538`, `42`);
 * - `{work_type}` — one of the same closed {@link WORK_TYPES}, and the same value the
 *   task's branch name uses;
 * - `{subject}` — the implementer's one-line summary of the change, imperative mood.
 *
 * An element written with a capital first letter renders with its first letter
 * capitalised: `{issue_key} {Subject}` → `VT-1538 Add the starting page …`. A
 * repository stating none runs on {@link DEFAULT_COMMIT_SUBJECT_PATTERN}, the
 * Conventional Commits subject SWARM always produced.
 *
 * Dependency-free on purpose, like `./branch-pattern.ts`: the dashboard's pattern
 * editor imports this module for the same validation and preview the config schema
 * applies.
 */

import {
	FALLBACK_WORK_TYPE,
	isWorkType,
	WORK_TYPES,
	type WorkType,
	workTypeFromCommitSubject,
} from './branch-pattern.js';

/** Every element a commit subject pattern may contain, in the order the editor lists them. */
export const COMMIT_SUBJECT_PATTERN_ELEMENTS = ['issue_key', 'work_type', 'subject'] as const;
export type CommitSubjectPatternElement = (typeof COMMIT_SUBJECT_PATTERN_ELEMENTS)[number];

/** The pattern a repository stating none runs on — today's Conventional Commits subject. */
export const DEFAULT_COMMIT_SUBJECT_PATTERN = '{work_type}: {subject}';

/** The length above which the editor warns about a rendered subject, unless the repository states its own. */
export const DEFAULT_COMMIT_SUBJECT_MAX_LENGTH = 72;

/**
 * The fewest characters the implementer is ever asked to fit `{subject}` into, however
 * long the pattern's own text: a summary needs some room, and the editor has already
 * warned about a pattern that leaves less.
 */
const MIN_SUBJECT_BUDGET = 20;

/** What each element stands for, as the editor describes it. */
export const COMMIT_SUBJECT_PATTERN_ELEMENT_DESCRIPTIONS: Record<
	CommitSubjectPatternElement,
	string
> = {
	issue_key:
		'The task id exactly as the task names it — VT-1538 for a board card, 42 for an issue.',
	work_type: `The kind of change — the same value the task's branch name uses: one of ${WORK_TYPES.join(', ')}.`,
	subject:
		'The implementer\'s one-line summary of the change in the imperative mood, e.g. "add the starting page". Required.',
};

/** The values a commit subject pattern is rendered with. */
export interface CommitSubjectParts {
	issueKey: string;
	workType: WorkType;
	subject: string;
}

/** The sample task the editor previews a pattern with — the same task as the branch name editor's. */
export const SAMPLE_COMMIT_SUBJECT_PARTS = {
	issueKey: 'VT-1538',
	workType: 'feat',
	subject: 'add the starting page of the SWARM test bed',
} as const satisfies CommitSubjectParts;

/** The two keys a repository (or the config scoped to it) words its commit subjects by. */
export interface CommitSubjectNaming {
	/** The repository's commit subject pattern; unset means {@link DEFAULT_COMMIT_SUBJECT_PATTERN}. */
	commitSubjectPattern?: string;
	/** The editor's length warning threshold; unset means {@link DEFAULT_COMMIT_SUBJECT_MAX_LENGTH}. */
	commitSubjectMaxLength?: number;
}

/** What {@link validateCommitSubjectPattern} found: errors block saving, warnings only inform. */
export interface CommitSubjectPatternValidation {
	errors: string[];
	warnings: string[];
}

type Segment =
	| { kind: 'literal'; text: string }
	| { kind: 'element'; name: CommitSubjectPatternElement; capitalised: boolean };

const ELEMENT_TOKEN = /\{([^{}]*)\}/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: a commit subject is one line of text
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

function isElement(name: string): name is CommitSubjectPatternElement {
	return (COMMIT_SUBJECT_PATTERN_ELEMENTS as readonly string[]).includes(name);
}

/** `{subject}` reads as itself, `{Subject}` as the capitalised form; anything else is unknown. */
function parseElement(token: string): Segment | undefined {
	if (isElement(token)) return { kind: 'element', name: token, capitalised: false };
	const first = token.charAt(0);
	const lowered = `${first.toLowerCase()}${token.slice(1)}`;
	if (first !== first.toLowerCase() && isElement(lowered))
		return { kind: 'element', name: lowered, capitalised: true };
	return undefined;
}

function elementList(): string {
	return COMMIT_SUBJECT_PATTERN_ELEMENTS.map((name) => `{${name}}`).join(', ');
}

/**
 * Split a pattern into literal text and elements, collecting what makes it unreadable
 * (an unknown element, a stray brace) rather than throwing on the first.
 */
function tokenize(pattern: string): { segments: Segment[]; errors: string[] } {
	const segments: Segment[] = [];
	const errors: string[] = [];
	let last = 0;
	const pushLiteral = (text: string): void => {
		if (!text) return;
		if (text.includes('{') || text.includes('}')) {
			errors.push('Every "{" must close an element with "}", e.g. {subject}.');
		}
		segments.push({ kind: 'literal', text });
	};
	for (const match of pattern.matchAll(ELEMENT_TOKEN)) {
		pushLiteral(pattern.slice(last, match.index));
		const token = match[1] ?? '';
		const element = parseElement(token);
		if (element) segments.push(element);
		else
			errors.push(
				`Unknown element {${token}} — use ${elementList()}, or capitalise one ({Subject}).`,
			);
		last = match.index + match[0].length;
	}
	pushLiteral(pattern.slice(last));
	return { segments, errors };
}

/**
 * Check a commit subject pattern against the editor's rules (issue #1242):
 *
 * 1. It names only known elements, in either case form, with every brace closed.
 * 2. It contains `{subject}` (or `{Subject}`) — without it every commit of every task
 *    would read the same, saying nothing about the change.
 * 3. It is one line: no line break or other control character.
 *
 * A **warning**, not an error, when the sample task's subject renders longer than
 * `maxLength`: real subjects vary in length, so only the pattern's own share of the
 * limit is the operator's to fix.
 */
export function validateCommitSubjectPattern(
	pattern: string,
	maxLength: number = DEFAULT_COMMIT_SUBJECT_MAX_LENGTH,
): CommitSubjectPatternValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (pattern.trim() === '') {
		return { errors: ['The pattern is empty — it needs at least {subject}.'], warnings };
	}
	const { segments, errors: tokenErrors } = tokenize(pattern);
	errors.push(...tokenErrors);
	if (!segments.some((s) => s.kind === 'element' && s.name === 'subject')) {
		errors.push(
			'The pattern must contain {subject} (or {Subject}) — the summary of what the change does.',
		);
	}
	if (CONTROL_CHARACTER.test(pattern)) {
		errors.push('A commit subject is one line — the pattern may not contain line breaks or tabs.');
	}
	if (errors.length === 0) {
		const sample = renderSegments(segments, SAMPLE_COMMIT_SUBJECT_PARTS);
		if (sample.length > maxLength) {
			warnings.push(
				`The sample subject is ${sample.length} characters, over the ${maxLength}-character limit. Each task's summary differs in length; keep the pattern's own text short so most of them fit.`,
			);
		}
	}
	return { errors: [...new Set(errors)], warnings };
}

/** Whether {@link validateCommitSubjectPattern} finds no error in `pattern`. */
export function isValidCommitSubjectPattern(pattern: string): boolean {
	return validateCommitSubjectPattern(pattern).errors.length === 0;
}

/** The pattern a repository words its commit subjects by — its own, or {@link DEFAULT_COMMIT_SUBJECT_PATTERN}. */
export function resolveCommitSubjectPattern(naming: CommitSubjectNaming): string {
	return naming.commitSubjectPattern ?? DEFAULT_COMMIT_SUBJECT_PATTERN;
}

/** The rendered subject length a repository aims to stay within. */
export function resolveCommitSubjectMaxLength(naming: CommitSubjectNaming): number {
	return naming.commitSubjectMaxLength ?? DEFAULT_COMMIT_SUBJECT_MAX_LENGTH;
}

/**
 * Render a pattern for one task: one line, runs of whitespace collapsed, trimmed.
 * `{subject}` is normalised through {@link normalizeSubject} first, so a summary that
 * repeats the work type or the issue key the pattern already supplies does not say it
 * twice.
 */
export function renderCommitSubject(pattern: string, parts: CommitSubjectParts): string {
	return renderSegments(tokenize(pattern).segments, parts);
}

function renderSegments(segments: Segment[], parts: CommitSubjectParts): string {
	return segments
		.map((segment) => (segment.kind === 'literal' ? segment.text : elementValue(segment, parts)))
		.join('')
		.replace(/\s+/g, ' ')
		.trim();
}

function elementValue(
	segment: Extract<Segment, { kind: 'element' }>,
	parts: CommitSubjectParts,
): string {
	const value =
		segment.name === 'issue_key'
			? parts.issueKey
			: segment.name === 'work_type'
				? parts.workType
				: normalizeSubject(parts.subject, parts.issueKey);
	return segment.capitalised ? capitalise(value) : value;
}

function capitalise(value: string): string {
	return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/** A leading Conventional Commits prefix — `feat: `, `fix(api)!: ` — as the implementer may still write one. */
const CONVENTIONAL_PREFIX = /^([a-z]+)(?:\([^)]*\))?!?:\s*/i;

/**
 * The implementer's summary as `{subject}`: one line, whitespace collapsed, without a
 * leading Conventional Commits prefix from {@link WORK_TYPES}, a leading `issueKey`, or
 * a trailing period — each of which the pattern, not the summary, decides.
 */
export function normalizeSubject(text: string, issueKey?: string): string {
	let subject = text.replace(/\s+/g, ' ').trim();
	const prefix = CONVENTIONAL_PREFIX.exec(subject);
	if (prefix && isWorkType((prefix[1] ?? '').toLowerCase())) {
		subject = subject.slice(prefix[0].length);
	}
	if (issueKey && subject.startsWith(issueKey)) {
		const rest = subject.slice(issueKey.length);
		if (rest === '' || /^[\s:]/.test(rest)) subject = rest.replace(/^[\s:]+/, '');
	}
	return subject.replace(/\.+$/, '').trim();
}

/**
 * How many characters `{subject}` may take for the rendered subject of the task keyed
 * `issueKey` to fit `maxLength` — counted against the longest work type, so whichever
 * the implementer chooses still fits. Never below a floor a summary can be written in.
 */
export function subjectLengthBudget(pattern: string, issueKey: string, maxLength: number): number {
	const longestWorkType = Math.max(...WORK_TYPES.map((type) => type.length));
	const overhead = tokenize(pattern).segments.reduce((total, segment) => {
		if (segment.kind === 'literal') return total + segment.text.length;
		if (segment.name === 'issue_key') return total + issueKey.length;
		if (segment.name === 'work_type') return total + longestWorkType;
		return total;
	}, 0);
	return Math.max(maxLength - overhead, MIN_SUBJECT_BUDGET);
}

/** The inputs {@link fixCommitSubject} chooses between. */
export interface FixCommitSubjectInput {
	/** The subject Implementation decided for the task, read back off its runs control-plane side. */
	stored?: string;
	/** The subject the respond agent wrote into its own hand-off. */
	agentSubject?: string;
	/** The repository's commit subject naming. */
	naming: CommitSubjectNaming;
	/** The task the pull request's branch encodes, when it encodes one. */
	issueKey?: string;
}

/**
 * The subject a Respond-to-review or Respond-to-CI fix commit carries (issue #1242).
 * The one Implementation decided and stored for the task always wins, so every commit
 * of the task reads the same. Without one — a pull request opened before subjects were
 * stored, or a lookup that failed — the agent's own subject stands in: rendered through
 * the repository's pattern when it states one (and the task's key is known if the
 * pattern needs it), verbatim when it states none, which is what such a commit always
 * carried. `undefined` only when there is neither.
 */
export function fixCommitSubject(input: FixCommitSubjectInput): string | undefined {
	const { stored, agentSubject, naming, issueKey } = input;
	if (stored) return stored;
	if (!agentSubject) return undefined;
	const pattern = naming.commitSubjectPattern;
	if (!pattern) return agentSubject;
	const needsKey = tokenize(pattern).segments.some(
		(segment) => segment.kind === 'element' && segment.name === 'issue_key',
	);
	if (needsKey && !issueKey) return agentSubject;
	return renderCommitSubject(pattern, {
		issueKey: issueKey ?? '',
		workType: workTypeFromCommitSubject(agentSubject) ?? FALLBACK_WORK_TYPE,
		subject: agentSubject,
	});
}
