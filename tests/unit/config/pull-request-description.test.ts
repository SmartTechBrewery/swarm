import { describe, expect, it } from 'vitest';
import {
	DEFAULT_PULL_REQUEST_DESCRIPTION,
	normalizePullRequestDescription,
	resolvePullRequestDescription,
} from '@/config/pull-request-description.js';

describe('DEFAULT_PULL_REQUEST_DESCRIPTION (issue #1277)', () => {
	it('carries every mandatory section of the default structure, in order', () => {
		const headings = DEFAULT_PULL_REQUEST_DESCRIPTION.split('\n').filter((line) =>
			line.startsWith('## '),
		);
		expect(headings).toEqual([
			'## Changes',
			'## Why this way',
			'## Verification',
			'## Out of scope',
		]);
		expect(DEFAULT_PULL_REQUEST_DESCRIPTION).toContain('| File / area | What it is |');
		expect(DEFAULT_PULL_REQUEST_DESCRIPTION).toContain('**Not checked:**');
	});
});

describe('normalizePullRequestDescription', () => {
	it('treats blank as unset and trims a custom structure', () => {
		expect(normalizePullRequestDescription(undefined)).toBeUndefined();
		expect(normalizePullRequestDescription(' \n ')).toBeUndefined();
		expect(normalizePullRequestDescription('  ## Zmiany  ')).toBe('## Zmiany');
	});

	it('treats the default — padded or with CRLF line endings — as unset', () => {
		expect(normalizePullRequestDescription(DEFAULT_PULL_REQUEST_DESCRIPTION)).toBeUndefined();
		expect(
			normalizePullRequestDescription(
				`\n${DEFAULT_PULL_REQUEST_DESCRIPTION.replace(/\n/g, '\r\n')}\n`,
			),
		).toBeUndefined();
	});
});

describe('resolvePullRequestDescription', () => {
	it('falls back to the default and otherwise keeps the project’s structure', () => {
		expect(resolvePullRequestDescription(undefined)).toBe(DEFAULT_PULL_REQUEST_DESCRIPTION);
		expect(resolvePullRequestDescription('## Zmiany')).toBe('## Zmiany');
	});
});
