import { describe, expect, it } from 'vitest';

import { projectRepo } from './project-repository.js';

describe('projectRepo', () => {
	it('reads the project’s repository off its list', () => {
		expect(projectRepo({ repositories: [{ repo: 'acme/widgets' }] })).toBe('acme/widgets');
	});

	// Phase 1 of issue #684 caps the list at one entry, so the first one is the project's
	// repository. Stated as a test so phase 3's list editor has to decide deliberately.
	it('shows the first entry when a project owns several', () => {
		expect(projectRepo({ repositories: [{ repo: 'acme/first' }, { repo: 'acme/second' }] })).toBe(
			'acme/first',
		);
	});

	// A link built from an empty string would point at github.com/​/pull/1, so callers
	// test the result — which means the absent cases must be falsy, not `undefined`
	// rendered into a template.
	it('is empty for a missing, listless or empty project', () => {
		expect(projectRepo(undefined)).toBe('');
		expect(projectRepo(null)).toBe('');
		expect(projectRepo({})).toBe('');
		expect(projectRepo({ repositories: [] })).toBe('');
	});
});
