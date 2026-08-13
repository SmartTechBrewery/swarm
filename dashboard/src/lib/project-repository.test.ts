import { describe, expect, it } from 'vitest';

import {
	addRepository,
	areRepositoriesDirty,
	duplicateRepositories,
	moveRepository,
	patchRepository,
	projectRepo,
	type RepositoryEntry,
	type RepositoryForm,
	removeRepository,
	toRepositoryEntries,
	toRepositoryForms,
} from './project-repository.js';

/**
 * A list as it may still be **stored** on a project written before issue #727 dropped
 * the per-repository SCM provider. `RepositoryEntry` no longer models the key, so the
 * fixture states it past the type — which is exactly the situation: the server strips
 * it on parse, and this screen must not resurrect it.
 */
const PRE_727_ENTRIES = [{ repo: 'acme/first', scm: 'gitlab' }] as unknown as RepositoryEntry[];

describe('projectRepo', () => {
	it('reads the project’s repository off its list', () => {
		expect(projectRepo({ repositories: [{ repo: 'acme/widgets' }] })).toBe('acme/widgets');
	});

	// These incidental reads show the project's *default* repository — its first entry.
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

describe('toRepositoryForms', () => {
	it('projects every entry onto a row, in order', () => {
		expect(
			toRepositoryForms([
				{ repo: 'acme/first', baseBranch: 'main', branchPrefix: 'issue-' },
				{ repo: 'acme/second', baseBranch: 'trunk', branchPrefix: 'work-' },
			]),
		).toEqual([
			{ id: '1', repo: 'acme/first', baseBranch: 'main', branchPrefix: 'issue-' },
			{ id: '2', repo: 'acme/second', baseBranch: 'trunk', branchPrefix: 'work-' },
		]);
	});

	// Issue #727: a project has one SCM provider, so a row carries none. A pre-#727
	// entry still stored on the project is ignored rather than surfacing as a value the
	// screen cannot show — the same thing the server does with it on parse.
	it('ignores a stored per-repository scm', () => {
		expect(toRepositoryForms(PRE_727_ENTRIES)).toEqual([
			{ id: '1', repo: 'acme/first', baseBranch: '', branchPrefix: '' },
		]);
	});

	// The schema requires at least one entry, so an editor showing none would offer
	// nothing to fix.
	it('yields one blank row for an absent or empty list', () => {
		const blank = { id: '1', repo: '', baseBranch: 'main', branchPrefix: 'issue-' };
		expect(toRepositoryForms(undefined)).toEqual([blank]);
		expect(toRepositoryForms([])).toEqual([blank]);
	});
});

describe('toRepositoryEntries', () => {
	it('sends every row, in order', () => {
		expect(
			toRepositoryEntries([
				{ id: '1', repo: 'acme/first', baseBranch: 'main', branchPrefix: 'issue-' },
				{ id: '2', repo: 'acme/second', baseBranch: 'trunk', branchPrefix: 'work-' },
			]),
		).toEqual([
			{ repo: 'acme/first', baseBranch: 'main', branchPrefix: 'issue-' },
			{ repo: 'acme/second', baseBranch: 'trunk', branchPrefix: 'work-' },
		]);
	});

	// A save states no provider per repository (issue #727), so a stored one is dropped
	// here exactly as the server drops it — the two surfaces agree on the shape.
	it('sends no `scm`, even for a row projected from a stored one', () => {
		const [entry] = toRepositoryEntries(toRepositoryForms(PRE_727_ENTRIES));
		expect(entry && 'scm' in entry).toBe(false);
	});

	// The form-only React key is not part of the config.
	it('does not send the row id', () => {
		const [entry] = toRepositoryEntries([
			{ id: '7', repo: 'acme/first', baseBranch: 'main', branchPrefix: 'issue-' },
		]);
		expect(entry && 'id' in entry).toBe(false);
	});

	// Issue #686: the routing token is authored in `swarm.config.json` and has no input
	// on this screen, so a save that rebuilt entries from the rendered fields alone
	// would delete it. It rides on the row instead, reorder included.
	it('carries a routing token this screen does not edit through a save', () => {
		const rows = toRepositoryForms([
			{ repo: 'acme/first', baseBranch: 'main', branchPrefix: 'issue-' },
			{
				repo: 'acme/second',
				baseBranch: 'main',
				branchPrefix: 'issue-',
				pmRoutingToken: 'component-2',
			},
		]);
		expect(rows[1]?.pmRoutingToken).toBe('component-2');
		expect(toRepositoryEntries(moveRepository(rows, 1, 'up'))).toEqual([
			{
				repo: 'acme/second',
				baseBranch: 'main',
				branchPrefix: 'issue-',
				pmRoutingToken: 'component-2',
			},
			{ repo: 'acme/first', baseBranch: 'main', branchPrefix: 'issue-' },
		]);
	});
});

describe('repository list mutations', () => {
	const rows: RepositoryForm[] = [
		{ id: '1', repo: 'acme/first', baseBranch: 'main', branchPrefix: 'issue-' },
		{ id: '2', repo: 'acme/second', baseBranch: 'trunk', branchPrefix: 'work-' },
	];

	it('appends a blank row on the project defaults, with an unused id', () => {
		expect(addRepository(rows)).toEqual([
			...rows,
			{ id: '3', repo: '', baseBranch: 'main', branchPrefix: 'issue-' },
		]);
	});

	// Ids must stay unique after a removal, or two rows would share a React key.
	it('does not reuse an id a surviving row already holds', () => {
		const afterRemove = removeRepository(rows, 0);
		expect(addRepository(afterRemove).map((row) => row.id)).toEqual(['2', '3']);
	});

	it('removes the named row', () => {
		expect(removeRepository(rows, 0)).toEqual([rows[1]]);
	});

	// A project owns at least one repository, so the last row cannot go.
	it('refuses to remove the last row', () => {
		const only = [rows[0] as RepositoryForm];
		expect(removeRepository(only, 0)).toBe(only);
	});

	// Order is meaningful: the first entry is the project's default repository.
	it('reorders rows and leaves out-of-range moves alone', () => {
		expect(moveRepository(rows, 1, 'up')).toEqual([rows[1], rows[0]]);
		expect(moveRepository(rows, 0, 'down')).toEqual([rows[1], rows[0]]);
		expect(moveRepository(rows, 0, 'up')).toBe(rows);
		expect(moveRepository(rows, 1, 'down')).toBe(rows);
	});

	it('patches one field of one row', () => {
		expect(patchRepository(rows, 1, { baseBranch: 'develop' })[1]).toEqual({
			...rows[1],
			baseBranch: 'develop',
		});
		expect(patchRepository(rows, 5, { baseBranch: 'develop' })).toBe(rows);
	});
});

// The server's conflict guard only refuses a repository *another* project owns, so this
// check has no server-side twin — it is why Save is blocked client-side.
describe('duplicateRepositories', () => {
	function row(repo: string): RepositoryForm {
		return { id: repo, repo, baseBranch: 'main', branchPrefix: 'issue-' };
	}

	it('names each repository more than one row claims', () => {
		expect(duplicateRepositories([row('acme/first'), row('acme/second')])).toEqual([]);
		expect(duplicateRepositories([row('acme/first'), row('acme/first')])).toEqual(['acme/first']);
	});

	it('ignores blank rows and compares trimmed', () => {
		expect(duplicateRepositories([row(''), row('')])).toEqual([]);
		expect(duplicateRepositories([row('acme/first'), row(' acme/first ')])).toEqual(['acme/first']);
	});
});

describe('areRepositoriesDirty', () => {
	const stored = [
		{ repo: 'acme/first', baseBranch: 'main', branchPrefix: 'issue-' },
		{ repo: 'acme/second', baseBranch: 'trunk', branchPrefix: 'work-' },
	];

	it('is clean for the stored list projected back onto rows', () => {
		expect(areRepositoriesDirty(toRepositoryForms(stored), stored)).toBe(false);
	});

	it('reports an edited field, an added row and a removed row', () => {
		expect(
			areRepositoriesDirty(
				patchRepository(toRepositoryForms(stored), 0, { repo: 'acme/x' }),
				stored,
			),
		).toBe(true);
		expect(areRepositoriesDirty(addRepository(toRepositoryForms(stored)), stored)).toBe(true);
		expect(areRepositoriesDirty(removeRepository(toRepositoryForms(stored), 1), stored)).toBe(true);
	});

	// Position is part of the value: the first entry is the project's default.
	it('reports a reorder that changes nothing else', () => {
		expect(areRepositoriesDirty(moveRepository(toRepositoryForms(stored), 1, 'up'), stored)).toBe(
			true,
		);
	});

	// A project has not loaded yet, or a cache entry is partial: the one blank row the
	// projection yields must not read as the stored value.
	it('reports the blank row against an absent list', () => {
		expect(areRepositoriesDirty(toRepositoryForms(undefined), undefined)).toBe(false);
		expect(areRepositoriesDirty(toRepositoryForms(stored), undefined)).toBe(true);
	});
});
