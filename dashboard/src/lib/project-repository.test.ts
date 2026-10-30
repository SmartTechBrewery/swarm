import { describe, expect, it } from 'vitest';

import {
	addRepository,
	applyBranchPattern,
	applyCommitSubjectPattern,
	areRepositoriesDirty,
	branchPatternPatch,
	duplicateRepositories,
	effectiveBranchPattern,
	effectiveCommitSubjectMaxLength,
	effectiveCommitSubjectPattern,
	moveRepository,
	patchRepository,
	projectRepo,
	type RepositoryEntry,
	type RepositoryForm,
	removeRepository,
	sharedBranchPattern,
	sharedCommitSubjectNaming,
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
			{
				id: '1',
				repo: 'acme/first',
				baseBranch: 'main',
				branchPrefix: 'issue-',
				branchPattern: '',
				commitSubjectPattern: '',
				commitSubjectMaxLength: '',
				autoMerge: false,
				reviewChecks: 'required',
				reviewChecksWaitMinutes: '',
				wipLimit: '',
			},
			{
				id: '2',
				repo: 'acme/second',
				baseBranch: 'trunk',
				branchPrefix: 'work-',
				branchPattern: '',
				commitSubjectPattern: '',
				commitSubjectMaxLength: '',
				autoMerge: false,
				reviewChecks: 'required',
				reviewChecksWaitMinutes: '',
				wipLimit: '',
			},
		]);
	});

	// Issue #727: a project has one SCM provider, so a row carries none. A pre-#727
	// entry still stored on the project is ignored rather than surfacing as a value the
	// screen cannot show — the same thing the server does with it on parse.
	it('ignores a stored per-repository scm', () => {
		expect(toRepositoryForms(PRE_727_ENTRIES)).toEqual([
			{
				id: '1',
				repo: 'acme/first',
				baseBranch: '',
				branchPrefix: '',
				branchPattern: '',
				commitSubjectPattern: '',
				commitSubjectMaxLength: '',
				autoMerge: false,
				reviewChecks: 'required',
				reviewChecksWaitMinutes: '',
				wipLimit: '',
			},
		]);
	});

	// The schema requires at least one entry, so an editor showing none would offer
	// nothing to fix.
	it('yields one blank row for an absent or empty list', () => {
		const blank = {
			id: '1',
			repo: '',
			baseBranch: 'main',
			branchPrefix: 'issue-',
			branchPattern: '',
			commitSubjectPattern: '',
			commitSubjectMaxLength: '',
			autoMerge: false,
			reviewChecks: 'required',
			reviewChecksWaitMinutes: '',
			wipLimit: '',
		};
		expect(toRepositoryForms(undefined)).toEqual([blank]);
		expect(toRepositoryForms([])).toEqual([blank]);
	});
});

describe('toRepositoryEntries', () => {
	it('sends every row, in order', () => {
		expect(
			toRepositoryEntries([
				{
					id: '1',
					repo: 'acme/first',
					baseBranch: 'main',
					branchPrefix: 'issue-',
					branchPattern: '',
					commitSubjectPattern: '',
					commitSubjectMaxLength: '',
					autoMerge: false,
					reviewChecks: 'required',
					reviewChecksWaitMinutes: '',
					wipLimit: '',
				},
				{
					id: '2',
					repo: 'acme/second',
					baseBranch: 'trunk',
					branchPrefix: 'work-',
					branchPattern: '',
					commitSubjectPattern: '',
					commitSubjectMaxLength: '',
					autoMerge: false,
					reviewChecks: 'required',
					reviewChecksWaitMinutes: '',
					wipLimit: '',
				},
			]),
		).toEqual([
			{
				repo: 'acme/first',
				baseBranch: 'main',
				branchPrefix: 'issue-',
				autoMerge: false,
				reviewChecks: 'required',
			},
			{
				repo: 'acme/second',
				baseBranch: 'trunk',
				branchPrefix: 'work-',
				autoMerge: false,
				reviewChecks: 'required',
			},
		]);
	});

	// Issue #1066: each row carries its own merge automation, written explicitly.
	it('sends each row’s own merge automation', () => {
		const rows = toRepositoryForms([
			{ repo: 'acme/first', autoMerge: true, reviewChecks: 'required' },
			{ repo: 'acme/second' },
		]);
		expect(rows.map((row) => row.autoMerge)).toEqual([true, false]);
		expect(toRepositoryEntries(rows).map((entry) => entry.autoMerge)).toEqual([true, false]);
	});

	// Issue #1109: each row carries its own Review check policy and wait. The policy is
	// always written; a blank wait is omitted so the server's default applies.
	it('sends each row’s own Review check policy and wait, omitting a blank wait', () => {
		const rows = toRepositoryForms([
			{ repo: 'acme/mobile', reviewChecks: 'if-present' },
			{ repo: 'acme/platform', reviewChecksWaitMinutes: 30 },
		]);
		expect(rows.map((row) => [row.reviewChecks, row.reviewChecksWaitMinutes])).toEqual([
			['if-present', ''],
			['required', '30'],
		]);
		const entries = toRepositoryEntries(
			patchRepository(rows, 0, { reviewChecksWaitMinutes: ' 45 ' }),
		);
		expect(entries[0]).toMatchObject({ reviewChecks: 'if-present', reviewChecksWaitMinutes: 45 });
		expect(entries[1]).toMatchObject({ reviewChecks: 'required', reviewChecksWaitMinutes: 30 });
		const [blank] = toRepositoryEntries(
			patchRepository(rows, 1, { reviewChecksWaitMinutes: '' }).slice(1),
		);
		expect(blank && 'reviewChecksWaitMinutes' in blank).toBe(false);
	});

	// Issue #1185: the WIP limit round-trips per row, so saving the list cannot erase a
	// limit set in `swarm.config.json`; a blank one is omitted so the default (1) applies.
	it('carries each row’s WIP limit through, omitting a blank one', () => {
		const rows = toRepositoryForms([{ repo: 'acme/first', wipLimit: 3 }, { repo: 'acme/second' }]);
		expect(rows.map((row) => row.wipLimit)).toEqual(['3', '']);
		const entries = toRepositoryEntries(patchRepository(rows, 0, { wipLimit: ' 2 ' }));
		expect(entries[0]).toMatchObject({ repo: 'acme/first', wipLimit: 2 });
		expect(entries[1] && 'wipLimit' in entries[1]).toBe(false);
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
			{
				id: '7',
				repo: 'acme/first',
				baseBranch: 'main',
				branchPrefix: 'issue-',
				branchPattern: '',
				commitSubjectPattern: '',
				commitSubjectMaxLength: '',
				autoMerge: false,
				reviewChecks: 'required',
				reviewChecksWaitMinutes: '',
				wipLimit: '',
			},
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
				autoMerge: false,
				reviewChecks: 'required',
				pmRoutingToken: 'component-2',
			},
			{
				repo: 'acme/first',
				baseBranch: 'main',
				branchPrefix: 'issue-',
				autoMerge: false,
				reviewChecks: 'required',
			},
		]);
	});
});

describe('repository list mutations', () => {
	const rows: RepositoryForm[] = [
		{
			id: '1',
			repo: 'acme/first',
			baseBranch: 'main',
			branchPrefix: 'issue-',
			branchPattern: '',
			commitSubjectPattern: '',
			commitSubjectMaxLength: '',
			autoMerge: false,
			reviewChecks: 'required',
			reviewChecksWaitMinutes: '',
			wipLimit: '',
		},
		{
			id: '2',
			repo: 'acme/second',
			baseBranch: 'trunk',
			branchPrefix: 'work-',
			branchPattern: '',
			commitSubjectPattern: '',
			commitSubjectMaxLength: '',
			autoMerge: false,
			reviewChecks: 'required',
			reviewChecksWaitMinutes: '',
			wipLimit: '',
		},
	];

	// The two fixture rows differ in prefix, so there is no project branch pattern to take.
	it('appends a blank row on the project defaults, with an unused id', () => {
		expect(addRepository(rows)).toEqual([
			...rows,
			{
				id: '3',
				repo: '',
				baseBranch: 'main',
				branchPrefix: 'issue-',
				branchPattern: '',
				commitSubjectPattern: '',
				commitSubjectMaxLength: '',
				autoMerge: false,
				reviewChecks: 'required',
				reviewChecksWaitMinutes: '',
				wipLimit: '',
			},
		]);
	});

	// Issue #1246: a repository added later takes the project's patterns.
	it('starts an added row on the patterns every row shares', () => {
		const named = applyCommitSubjectPattern(
			applyBranchPattern(rows, '{issue_key}/{friendly_name}'),
			'{issue_key} {Subject}',
			60,
		);
		expect(addRepository(named)[2]).toMatchObject({
			branchPrefix: 'issue-',
			branchPattern: '{issue_key}/{friendly_name}',
			commitSubjectPattern: '{issue_key} {Subject}',
			commitSubjectMaxLength: '60',
		});
	});

	// A pattern the new row's own prefix already renders is stored as none, like any row's.
	it('starts an added row on a shared legacy pattern through its own prefix', () => {
		const onPrefix = rows.map((row) => ({ ...row, branchPrefix: 'issue-' }));
		expect(addRepository(onPrefix)[2]).toMatchObject({ branchPrefix: 'issue-', branchPattern: '' });
		const onOtherPrefix = rows.map((row) => ({ ...row, branchPrefix: 'work-' }));
		expect(addRepository(onOtherPrefix)[2]).toMatchObject({
			branchPrefix: 'issue-',
			branchPattern: 'work-{issue_key}',
		});
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
		return {
			id: repo,
			repo,
			baseBranch: 'main',
			branchPrefix: 'issue-',
			branchPattern: '',
			commitSubjectPattern: '',
			commitSubjectMaxLength: '',
			autoMerge: false,
			reviewChecks: 'required',
			reviewChecksWaitMinutes: '',
			wipLimit: '',
		};
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

	it('reports a merge automation toggle that changes nothing else', () => {
		expect(
			areRepositoriesDirty(
				patchRepository(toRepositoryForms(stored), 1, {
					autoMerge: true,
					reviewChecks: 'required',
				}),
				stored,
			),
		).toBe(true);
	});

	it('reports a Review check policy or wait change that changes nothing else', () => {
		expect(
			areRepositoriesDirty(
				patchRepository(toRepositoryForms(stored), 1, { reviewChecks: 'if-present' }),
				stored,
			),
		).toBe(true);
		expect(
			areRepositoriesDirty(
				patchRepository(toRepositoryForms(stored), 0, { reviewChecksWaitMinutes: '20' }),
				stored,
			),
		).toBe(true);
	});

	it('reports a WIP limit change that changes nothing else (issue #1185)', () => {
		expect(
			areRepositoriesDirty(
				patchRepository(toRepositoryForms(stored), 0, { wipLimit: '2' }),
				stored,
			),
		).toBe(true);
		expect(
			areRepositoriesDirty(
				patchRepository(toRepositoryForms(stored), 0, { wipLimit: ' ' }),
				stored,
			),
		).toBe(false);
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

// Issue #1241: the pattern replaces the prefix as the edited setting; the prefix rides
// through untouched, since it is still recognised for branches already open.
describe('branch name pattern', () => {
	it('reads an entry with no pattern as its prefix before {issue_key}', () => {
		const [row] = toRepositoryForms([{ repo: 'acme/first', branchPrefix: 'work-' }]);
		expect(row?.branchPattern).toBe('');
		expect(effectiveBranchPattern(row as RepositoryForm)).toBe('work-{issue_key}');
	});

	it('round-trips a pattern and keeps the prefix beside it', () => {
		const stored: RepositoryEntry[] = [
			{ repo: 'acme/first', branchPrefix: 'issue-', branchPattern: '{issue_key}/{friendly_name}' },
		];
		const rows = toRepositoryForms(stored);
		expect(effectiveBranchPattern(rows[0] as RepositoryForm)).toBe('{issue_key}/{friendly_name}');
		expect(toRepositoryEntries(rows)[0]).toMatchObject({
			branchPrefix: 'issue-',
			branchPattern: '{issue_key}/{friendly_name}',
		});
		expect(areRepositoriesDirty(rows, stored)).toBe(false);
		expect(
			areRepositoriesDirty(patchRepository(rows, 0, { branchPattern: '{issue_key}' }), stored),
		).toBe(true);
	});

	it('saves no pattern for an entry still on its prefix', () => {
		const rows = toRepositoryForms([{ repo: 'acme/first', branchPrefix: 'issue-' }]);
		expect(toRepositoryEntries(rows)[0]).not.toHaveProperty('branchPattern');
	});

	it('stores the prefix’s own pattern as none, and anything else as itself', () => {
		expect(branchPatternPatch({ branchPrefix: 'issue-' }, 'issue-{issue_key}')).toEqual({
			branchPattern: '',
		});
		expect(branchPatternPatch({ branchPrefix: 'issue-' }, '{issue_key}/{friendly_name}')).toEqual({
			branchPattern: '{issue_key}/{friendly_name}',
		});
	});
});

describe('commit subject pattern (issue #1242)', () => {
	it('reads an entry with none as the default pattern and limit, and saves neither', () => {
		const rows = toRepositoryForms([{ repo: 'acme/first' }]);
		const row = rows[0] as RepositoryForm;
		expect(effectiveCommitSubjectPattern(row)).toBe('{work_type}: {subject}');
		expect(effectiveCommitSubjectMaxLength(row)).toBe(72);
		expect(toRepositoryEntries(rows)[0]).not.toHaveProperty('commitSubjectPattern');
		expect(toRepositoryEntries(rows)[0]).not.toHaveProperty('commitSubjectMaxLength');
	});

	it('round-trips a pattern and its limit, and sees a change as dirty', () => {
		const stored: RepositoryEntry[] = [
			{
				repo: 'acme/first',
				commitSubjectPattern: '{issue_key} {Subject}',
				commitSubjectMaxLength: 60,
			},
		];
		const rows = toRepositoryForms(stored);
		expect(toRepositoryEntries(rows)[0]).toMatchObject({
			commitSubjectPattern: '{issue_key} {Subject}',
			commitSubjectMaxLength: 60,
		});
		expect(areRepositoriesDirty(rows, stored)).toBe(false);
		expect(
			areRepositoriesDirty(patchRepository(rows, 0, { commitSubjectMaxLength: '72' }), stored),
		).toBe(true);
	});
});

// Issue #1246: the patterns are set once per project, but still stored on every row.
describe('project-wide patterns', () => {
	const rows = toRepositoryForms([
		{ repo: 'acme/first', branchPrefix: 'issue-' },
		{ repo: 'acme/second', branchPrefix: 'issue-' },
	]);

	it('reads the patterns the rows share', () => {
		expect(sharedBranchPattern(rows)).toBe('issue-{issue_key}');
		expect(sharedCommitSubjectNaming(rows)).toEqual({
			commitSubjectPattern: '',
			commitSubjectMaxLength: '',
		});
	});

	it('compares branch patterns by the name they render', () => {
		const stated = patchRepository(rows, 1, { branchPattern: 'issue-{issue_key}' });
		expect(sharedBranchPattern(stated)).toBe('issue-{issue_key}');
		expect(
			sharedBranchPattern(patchRepository(rows, 1, { branchPrefix: 'work-' })),
		).toBeUndefined();
		expect(
			sharedBranchPattern(
				patchRepository(rows, 1, { branchPattern: '{issue_key}/{friendly_name}' }),
			),
		).toBeUndefined();
	});

	// Stating none titles pull requests by their card; stating the default does not.
	it('tells a stated default commit subject pattern apart from none, but not a stated default limit', () => {
		expect(
			sharedCommitSubjectNaming(
				patchRepository(rows, 1, { commitSubjectPattern: '{work_type}: {subject}' }),
			),
		).toBeUndefined();
		expect(
			sharedCommitSubjectNaming(patchRepository(rows, 1, { commitSubjectMaxLength: '72' })),
		).toBeDefined();
		expect(
			sharedCommitSubjectNaming(patchRepository(rows, 1, { commitSubjectMaxLength: '60' })),
		).toBeUndefined();
	});

	it('applies a branch pattern to every row, storing a prefix’s own pattern as none', () => {
		const mixed = patchRepository(rows, 1, { branchPrefix: 'work-' });
		const applied = applyBranchPattern(mixed, 'issue-{issue_key}');
		expect(applied.map((row) => row.branchPattern)).toEqual(['', 'issue-{issue_key}']);
		expect(sharedBranchPattern(applied)).toBe('issue-{issue_key}');
		expect(
			applyBranchPattern(mixed, '{issue_key}/{friendly_name}').map((row) => row.branchPattern),
		).toEqual(['{issue_key}/{friendly_name}', '{issue_key}/{friendly_name}']);
	});

	it('keeps rows stating none on none when the defaults are applied unchanged', () => {
		const applied = applyCommitSubjectPattern(rows, '{work_type}: {subject}', 72);
		expect(applied).toEqual(rows);
		expect(areRepositoriesDirty(applied, toRepositoryEntries(rows))).toBe(false);
	});

	// Once any row states its own, every row states what is applied — the default included —
	// so the repositories end up identical rather than split between none and the default.
	it('writes the same pattern and limit to every row once any row states its own', () => {
		const mixed = patchRepository(rows, 1, {
			commitSubjectPattern: '{issue_key} {Subject}',
			commitSubjectMaxLength: '60',
		});
		const applied = applyCommitSubjectPattern(mixed, '{work_type}: {subject}', 72);
		expect(toRepositoryEntries(applied).map((entry) => entry.commitSubjectPattern)).toEqual([
			'{work_type}: {subject}',
			'{work_type}: {subject}',
		]);
		expect(toRepositoryEntries(applied).map((entry) => entry.commitSubjectMaxLength)).toEqual([
			72, 72,
		]);
		expect(sharedCommitSubjectNaming(applied)).toBeDefined();
	});
});
