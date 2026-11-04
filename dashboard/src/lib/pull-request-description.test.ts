import { describe, expect, it } from 'vitest';
import {
	DEFAULT_PULL_REQUEST_DESCRIPTION,
	isDefaultPullRequestDescription,
	isPullRequestDescriptionDirty,
	PULL_REQUEST_DESCRIPTION_MAX_LENGTH,
	pullRequestDescriptionDisplay,
	pullRequestDescriptionError,
} from './pull-request-description.js';

describe('pullRequestDescriptionDisplay', () => {
	it('shows the default until the project stores its own structure', () => {
		expect(pullRequestDescriptionDisplay(undefined)).toBe(DEFAULT_PULL_REQUEST_DESCRIPTION);
		expect(pullRequestDescriptionDisplay('## Zmiany')).toBe('## Zmiany');
	});
});

describe('pullRequestDescriptionError', () => {
	it('accepts the default, blank and within-bound values, and rejects one over the bound', () => {
		expect(pullRequestDescriptionError(undefined)).toBeUndefined();
		expect(pullRequestDescriptionError(DEFAULT_PULL_REQUEST_DESCRIPTION)).toBeUndefined();
		expect(
			pullRequestDescriptionError('a'.repeat(PULL_REQUEST_DESCRIPTION_MAX_LENGTH)),
		).toBeUndefined();
		expect(
			pullRequestDescriptionError('a'.repeat(PULL_REQUEST_DESCRIPTION_MAX_LENGTH + 1)),
		).toMatch(/at most/);
	});
});

describe('isPullRequestDescriptionDirty', () => {
	it('does not treat the untouched default as an edit of an unset field', () => {
		expect(isPullRequestDescriptionDirty(DEFAULT_PULL_REQUEST_DESCRIPTION, undefined)).toBe(false);
		expect(isPullRequestDescriptionDirty(undefined, undefined)).toBe(false);
	});

	it('detects a changed structure and a restored default', () => {
		expect(isPullRequestDescriptionDirty('## Zmiany', undefined)).toBe(true);
		expect(isPullRequestDescriptionDirty(undefined, '## Zmiany')).toBe(true);
		expect(isPullRequestDescriptionDirty('## Zmiany ', '## Zmiany')).toBe(false);
	});
});

describe('isDefaultPullRequestDescription', () => {
	it('is true for unset and the default text, false for a custom structure', () => {
		expect(isDefaultPullRequestDescription(undefined)).toBe(true);
		expect(isDefaultPullRequestDescription(`${DEFAULT_PULL_REQUEST_DESCRIPTION}\n`)).toBe(true);
		expect(isDefaultPullRequestDescription('## Zmiany')).toBe(false);
	});

	it('is false for a cleared field, which shows an empty box rather than the default', () => {
		expect(isDefaultPullRequestDescription('')).toBe(false);
		expect(isDefaultPullRequestDescription('  \n')).toBe(false);
	});
});
