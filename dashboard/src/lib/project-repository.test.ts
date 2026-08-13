import { describe, expect, it } from 'vitest';

import { projectRepo, withDefaultRepositoryEdited } from './project-repository.js';

describe('projectRepo', () => {
	it('reads the project’s repository off its list', () => {
		expect(projectRepo({ repositories: [{ repo: 'acme/widgets' }] })).toBe('acme/widgets');
	});

	// These incidental reads show the project's *default* repository — its first entry.
	// Stated as a test so phase 3's list editor has to decide deliberately.
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

// `projects.update` replaces `repositories` wholesale, so the General tab's three-input
// save must carry the entries it does not edit. Without this, saving General Settings on
// a project that owns several repositories deletes all but the first — reachable the
// moment issue #684 phase 2 lifted the one-entry cap.
describe('withDefaultRepositoryEdited', () => {
	const edit = { repo: 'acme/renamed', baseBranch: 'develop', branchPrefix: 'task-' };

	it('applies the edit to the default entry', () => {
		expect(
			withDefaultRepositoryEdited(
				{ repositories: [{ repo: 'acme/first', baseBranch: 'main', branchPrefix: 'issue-' }] },
				edit,
			),
		).toEqual([edit]);
	});

	it('carries the entries the tab does not edit through untouched', () => {
		expect(
			withDefaultRepositoryEdited(
				{
					repositories: [
						{ repo: 'acme/first', baseBranch: 'main', branchPrefix: 'issue-' },
						{ repo: 'acme/second', baseBranch: 'trunk', branchPrefix: 'work-' },
						{ repo: 'acme/third', baseBranch: 'main', branchPrefix: 'issue-', scm: 'gitlab' },
					],
				},
				edit,
			),
		).toEqual([
			edit,
			{ repo: 'acme/second', baseBranch: 'trunk', branchPrefix: 'work-' },
			{ repo: 'acme/third', baseBranch: 'main', branchPrefix: 'issue-', scm: 'gitlab' },
		]);
	});

	// The tab shows no `scm` input, so the default entry's own provider override must
	// survive a save of the three fields it does show.
	it("preserves the default entry's own fields the tab never shows", () => {
		expect(
			withDefaultRepositoryEdited(
				{
					repositories: [
						{ repo: 'acme/first', baseBranch: 'main', branchPrefix: 'issue-', scm: 'bitbucket' },
					],
				},
				edit,
			),
		).toEqual([{ ...edit, scm: 'bitbucket' }]);
	});

	// The form can submit before the project query resolves; the edit alone is still a
	// valid one-entry list, so the save is not silently dropped.
	it('returns the edit alone when the project has not loaded', () => {
		expect(withDefaultRepositoryEdited(undefined, edit)).toEqual([edit]);
	});
});
