import { describe, expect, it } from 'vitest';
import {
	DEFAULT_COMMIT_SUBJECT_PATTERN,
	fixCommitSubject,
	normalizeSubject,
	renderCommitSubject,
	resolveCommitSubjectMaxLength,
	resolveCommitSubjectPattern,
	SAMPLE_COMMIT_SUBJECT_PARTS,
	subjectLengthBudget,
	validateCommitSubjectPattern,
} from '@/pipeline/commit-subject-pattern.js';

describe('validateCommitSubjectPattern', () => {
	it.each([
		DEFAULT_COMMIT_SUBJECT_PATTERN,
		'{issue_key} {Subject}',
		'{issue_key}: {work_type}({issue_key}) {subject}',
		'[{Issue_key}] {Work_type} — {Subject}',
	])('accepts %s', (pattern) => {
		expect(validateCommitSubjectPattern(pattern).errors).toEqual([]);
	});

	it.each([
		['', 'empty'],
		['   ', 'empty'],
		['{issue_key}', 'must contain {subject}'],
		['{issue_key} {summary}', 'Unknown element {summary}'],
		['{SUBJECT}', 'Unknown element {SUBJECT}'],
		['{issue_key} {subject', 'must close an element'],
		['{issue_key}\n{subject}', 'one line'],
	])('refuses %j (%s)', (pattern, message) => {
		const { errors } = validateCommitSubjectPattern(pattern);
		expect(errors.join(' ')).toContain(message);
	});

	it('warns, without refusing, when the sample subject is over the length limit', () => {
		const pattern = '{issue_key} {Subject}';
		expect(validateCommitSubjectPattern(pattern).warnings).toEqual([]);
		const tight = validateCommitSubjectPattern(pattern, 40);
		expect(tight.errors).toEqual([]);
		expect(tight.warnings.join(' ')).toContain('over the 40-character limit');
	});
});

describe('renderCommitSubject', () => {
	it('renders the issue’s own example', () => {
		expect(renderCommitSubject('{issue_key} {Subject}', SAMPLE_COMMIT_SUBJECT_PARTS)).toBe(
			'VT-1538 Add the starting page of the SWARM test bed',
		);
	});

	it('renders today’s conventional subject by default', () => {
		expect(
			renderCommitSubject(DEFAULT_COMMIT_SUBJECT_PATTERN, {
				issueKey: '42',
				workType: 'fix',
				subject: 'refresh the main filters',
			}),
		).toBe('fix: refresh the main filters');
	});

	it('capitalises any element written with a capital first letter', () => {
		expect(
			renderCommitSubject('{Work_type}: {subject}', {
				issueKey: '42',
				workType: 'feat',
				subject: 'add x',
			}),
		).toBe('Feat: add x');
	});

	it('keeps the result on one trimmed line', () => {
		expect(
			renderCommitSubject(' {issue_key}  {Subject} ', {
				issueKey: 'VT-1',
				workType: 'feat',
				subject: 'add\nthe   page',
			}),
		).toBe('VT-1 Add the page');
	});
});

describe('normalizeSubject', () => {
	it('drops what the pattern supplies — a conventional prefix, the issue key — and a trailing period', () => {
		expect(normalizeSubject('feat(ui)!: add the page.')).toBe('add the page');
		expect(normalizeSubject('VT-1538 add the page', 'VT-1538')).toBe('add the page');
		expect(normalizeSubject('VT-1538: add the page', 'VT-1538')).toBe('add the page');
	});

	it('keeps text that only looks like a prefix', () => {
		expect(normalizeSubject('feature: add the page')).toBe('feature: add the page');
		expect(normalizeSubject('VT-15380 is unrelated', 'VT-1538')).toBe('VT-15380 is unrelated');
	});
});

describe('subjectLengthBudget', () => {
	it('leaves the limit minus the pattern’s own text, the key and the longest work type', () => {
		expect(subjectLengthBudget('{issue_key} {Subject}', 'VT-1538', 72)).toBe(64);
		// "refactor: " is the longest rendering of "{work_type}: ".
		expect(subjectLengthBudget(DEFAULT_COMMIT_SUBJECT_PATTERN, '42', 72)).toBe(62);
	});

	it('never asks for a summary too short to say anything', () => {
		expect(subjectLengthBudget('{issue_key} {subject}', 'VT-1538', 20)).toBe(20);
	});
});

describe('resolving a repository’s naming', () => {
	it('falls back to the defaults when the repository states none', () => {
		expect(resolveCommitSubjectPattern({})).toBe('{work_type}: {subject}');
		expect(resolveCommitSubjectMaxLength({})).toBe(72);
		expect(resolveCommitSubjectPattern({ commitSubjectPattern: '{issue_key} {Subject}' })).toBe(
			'{issue_key} {Subject}',
		);
	});
});

describe('fixCommitSubject', () => {
	const naming = { commitSubjectPattern: '{issue_key} {Subject}' };

	it('prefers the subject Implementation stored for the task', () => {
		expect(
			fixCommitSubject({
				stored: 'VT-1538 Add the starting page',
				agentSubject: 'fix: address review feedback',
				naming,
				issueKey: 'VT-1538',
			}),
		).toBe('VT-1538 Add the starting page');
	});

	it('renders the agent’s own subject through the pattern when none is stored', () => {
		expect(
			fixCommitSubject({
				agentSubject: 'fix: address review feedback',
				naming,
				issueKey: 'VT-1538',
			}),
		).toBe('VT-1538 Address review feedback');
	});

	it('keeps the agent’s subject verbatim when the repository states no pattern', () => {
		expect(
			fixCommitSubject({ agentSubject: 'fix(api): address review', naming: {}, issueKey: '42' }),
		).toBe('fix(api): address review');
	});

	it('keeps the agent’s subject verbatim when the pattern needs a key the branch does not carry', () => {
		expect(fixCommitSubject({ agentSubject: 'fix: address review', naming })).toBe(
			'fix: address review',
		);
	});

	it('has nothing to commit with when neither is there', () => {
		expect(fixCommitSubject({ naming, issueKey: 'VT-1538' })).toBeUndefined();
	});
});
