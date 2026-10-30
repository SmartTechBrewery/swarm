import { describe, expect, it } from 'vitest';
import {
	branchNameError,
	branchPatternFromPrefix,
	branchPatternNeedsImplementer,
	renderBranchName,
	taskIdFromPatternBranch,
	toFriendlyName,
	validateBranchPattern,
	workTypeFromCommitSubject,
} from '@/pipeline/branch-pattern.js';

describe('validateBranchPattern', () => {
	it('accepts the default and the patterns the issue names, with no warning', () => {
		for (const pattern of [
			'issue-{issue_key}',
			'{issue_key}/{friendly_name}',
			'{work_type}/{issue_key}-{friendly_name}',
		]) {
			expect(validateBranchPattern(pattern)).toEqual({ errors: [], warnings: [] });
		}
	});

	it('refuses a pattern without {issue_key}, or with it twice', () => {
		expect(validateBranchPattern('feature/{friendly_name}').errors).toEqual([
			expect.stringContaining('must contain {issue_key}'),
		]);
		expect(validateBranchPattern('{issue_key}/{issue_key}').errors).toEqual([
			expect.stringContaining('exactly once'),
		]);
		expect(validateBranchPattern('   ').errors).toHaveLength(1);
	});

	it('warns — without refusing — when the name ends in a bare issue key', () => {
		const flat = validateBranchPattern('{issue_key}');
		expect(flat.errors).toEqual([]);
		expect(flat.warnings).toEqual([expect.stringContaining('"VT-1538/…"')]);
		expect(validateBranchPattern('feat/{issue_key}').warnings).toHaveLength(1);
	});

	it('refuses unknown elements and stray braces', () => {
		expect(validateBranchPattern('{issue_key}/{slug}').errors).toEqual([
			expect.stringContaining('Unknown element {slug}'),
		]);
		expect(validateBranchPattern('{issue_key}/{friendly_name').errors).not.toEqual([]);
	});

	it('limits literal text to letters, digits and / - _', () => {
		expect(validateBranchPattern('users/jan.kowalski/{issue_key}').errors).toEqual([
			expect.stringContaining('"."'),
		]);
		expect(validateBranchPattern('a b/{issue_key}').errors).not.toEqual([]);
	});

	it('requires a separator between an element and the text around it', () => {
		expect(validateBranchPattern('{work_type}{issue_key}').errors).not.toEqual([]);
		expect(validateBranchPattern('{issue_key}x').errors).not.toEqual([]);
		expect(validateBranchPattern('issue{issue_key}').errors).not.toEqual([]);
	});

	it('refuses a pattern that renders an invalid git branch', () => {
		expect(validateBranchPattern('/{issue_key}').errors).toEqual([
			expect.stringContaining('not a valid branch'),
		]);
		expect(validateBranchPattern('{issue_key}//{friendly_name}').errors).not.toEqual([]);
		expect(validateBranchPattern('-{issue_key}').errors).not.toEqual([]);
	});
});

describe('renderBranchName', () => {
	it('keeps the issue key as-is and renders the issue examples', () => {
		expect(
			renderBranchName('{issue_key}/{friendly_name}', {
				issueKey: 'VT-1538',
				friendlyName: 'Pierwsza strona testowa',
			}),
		).toBe('VT-1538/pierwsza-strona-testowa');
		expect(
			renderBranchName('{work_type}/{issue_key}-{friendly_name}', {
				issueKey: 'VT-1234',
				workType: 'fix',
				friendlyName: 'main-filters-refresh',
			}),
		).toBe('fix/VT-1234-main-filters-refresh');
	});

	it('renders a legacy prefix pattern to the old name exactly', () => {
		expect(renderBranchName(branchPatternFromPrefix('issue-'), { issueKey: '42' })).toBe(
			'issue-42',
		);
		expect(renderBranchName(branchPatternFromPrefix(''), { issueKey: 'VT-1' })).toBe('VT-1');
	});

	it('throws when the pattern needs a part it was not given', () => {
		expect(() => renderBranchName('{work_type}/{issue_key}', { issueKey: '42' })).toThrow();
		expect(() =>
			renderBranchName('{issue_key}/{friendly_name}', { issueKey: '42', friendlyName: '!!' }),
		).toThrow();
	});
});

describe('branchPatternNeedsImplementer', () => {
	it('is true only for a pattern with a model-chosen part', () => {
		expect(branchPatternNeedsImplementer('issue-{issue_key}')).toBe(false);
		expect(branchPatternNeedsImplementer('{issue_key}/{friendly_name}')).toBe(true);
		expect(branchPatternNeedsImplementer('{work_type}/{issue_key}')).toBe(true);
	});
});

describe('taskIdFromPatternBranch', () => {
	it('reads the task id back out of a branch the pattern rendered', () => {
		expect(
			taskIdFromPatternBranch('VT-1538/pierwsza-strona-testowa', '{issue_key}/{friendly_name}'),
		).toBe('VT-1538');
		expect(
			taskIdFromPatternBranch(
				'fix/VT-1234-main-filters-refresh',
				'{work_type}/{issue_key}-{friendly_name}',
			),
		).toBe('VT-1234');
		expect(taskIdFromPatternBranch('42-2fa-login', '{issue_key}-{friendly_name}')).toBe('42');
		expect(taskIdFromPatternBranch('login-fix-42', '{friendly_name}-{issue_key}')).toBe('42');
	});

	it('recognises only the shape SWARM renders', () => {
		const pattern = '{work_type}/{issue_key}-{friendly_name}';
		expect(taskIdFromPatternBranch('feature/VT-1-x', pattern)).toBeUndefined();
		expect(taskIdFromPatternBranch('fix/vt-1-x', pattern)).toBeUndefined();
		expect(taskIdFromPatternBranch('fix/VT-1-Upper', pattern)).toBeUndefined();
		expect(taskIdFromPatternBranch('VT-1538', '{issue_key}/{friendly_name}')).toBeUndefined();
	});

	it('recognises nothing under a pattern that does not validate', () => {
		expect(taskIdFromPatternBranch('42', '{friendly_name}')).toBeUndefined();
	});
});

describe('toFriendlyName', () => {
	it('transliterates Polish and other diacritics into kebab-case ASCII', () => {
		expect(toFriendlyName('Pierwsza strona testowa')).toBe('pierwsza-strona-testowa');
		expect(toFriendlyName('Zażółć gęślą jaźń')).toBe('zazolc-gesla-jazn');
		expect(toFriendlyName('Straße — Øre')).toBe('strasse-ore');
	});

	it('caps the name at five words and the length limit, at a word boundary', () => {
		expect(toFriendlyName('one two three four five six seven')).toBe('one-two-three-four-five');
		const long = toFriendlyName('internationalization localization configuration refactoring');
		expect(long.length).toBeLessThanOrEqual(40);
		expect(long).toBe('internationalization-localization');
	});

	it('is empty when nothing ASCII survives', () => {
		expect(toFriendlyName('—')).toBe('');
	});
});

describe('workTypeFromCommitSubject', () => {
	it('reads the Conventional Commits type, when it is on the list', () => {
		expect(workTypeFromCommitSubject('fix(api): refresh filters')).toBe('fix');
		expect(workTypeFromCommitSubject('feat!: drop the prefix')).toBe('feat');
		expect(workTypeFromCommitSubject('feature: something')).toBeUndefined();
		expect(workTypeFromCommitSubject('Refresh filters')).toBeUndefined();
	});
});

describe('branchNameError', () => {
	it('mirrors git check-ref-format --branch', () => {
		expect(branchNameError('fix/VT-1234-x')).toBeUndefined();
		expect(branchNameError('a..b')).toBeDefined();
		expect(branchNameError('a/.b')).toBeDefined();
		expect(branchNameError('a.lock')).toBeDefined();
		expect(branchNameError('HEAD')).toBeDefined();
		expect(branchNameError('a b')).toBeDefined();
	});
});
