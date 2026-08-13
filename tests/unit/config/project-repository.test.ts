import { describe, expect, it } from 'vitest';

import {
	defaultProjectRepository,
	findProjectRepository,
	requireProjectRepository,
	scopeProjectToRepository,
} from '@/config/project-repository.js';
import type { ProjectRecord } from '@/config/schema.js';
import { createMockProjectRecord } from '../../helpers/factories.js';

/**
 * A record naming two repositories. The schema caps `repositories` at one entry for
 * issue #684 phase 1, so this is built past the parser on purpose: the *helpers* are
 * already written for the list phase 2 delivers, and these are the cases that prove
 * scoping picks the right entry rather than always the first.
 */
function twoRepositoryRecord(): ProjectRecord {
	return {
		...createMockProjectRecord({ id: 'multi', scm: 'github' }),
		repositories: [
			{ repo: 'acme/first', baseBranch: 'main', branchPrefix: 'issue-' },
			{ repo: 'acme/second', baseBranch: 'develop', branchPrefix: 'task-' },
		],
	};
}

describe('project repository scoping (issue #684)', () => {
	describe('defaultProjectRepository', () => {
		it('is the first entry — what board-driven work, which names no repository, runs against', () => {
			expect(defaultProjectRepository(twoRepositoryRecord()).repo).toBe('acme/first');
		});

		it('throws naming the project when the list is empty', () => {
			const empty = { ...createMockProjectRecord({ id: 'empty' }), repositories: [] };
			expect(() => defaultProjectRepository(empty)).toThrow(/'empty'/);
		});
	});

	describe('findProjectRepository', () => {
		it('finds an entry by its repo and returns undefined for one the project does not own', () => {
			const record = twoRepositoryRecord();
			expect(findProjectRepository(record, 'acme/second')?.baseBranch).toBe('develop');
			expect(findProjectRepository(record, 'acme/third')).toBeUndefined();
		});
	});

	describe('requireProjectRepository', () => {
		it('throws naming the project and the repositories it does own', () => {
			expect(() => requireProjectRepository(twoRepositoryRecord(), 'acme/third')).toThrow(
				/'multi'.*acme\/first, acme\/second/,
			);
		});
	});

	describe('scopeProjectToRepository', () => {
		it('flattens the named entry over the shared settings and drops the list', () => {
			const scoped = scopeProjectToRepository(twoRepositoryRecord(), 'acme/second');

			expect(scoped).toMatchObject({
				id: 'multi',
				repo: 'acme/second',
				baseBranch: 'develop',
				branchPrefix: 'task-',
			});
			// The whole point of the scoped shape: nothing downstream can reach another
			// repository, because a scoped config carries no list at all.
			expect(scoped).not.toHaveProperty('repositories');
		});

		it('scopes to the default entry when no repository is named', () => {
			expect(scopeProjectToRepository(twoRepositoryRecord()).repo).toBe('acme/first');
		});

		// Issue #727: a project has one SCM provider and every repository it owns lives on
		// it, so every entry scopes to the project's own `scm` — including one whose
		// persisted jsonb still carries a pre-#727 override, which nothing reads.
		it('resolves scm from the project alone, for every entry', () => {
			const record = twoRepositoryRecord();
			expect(scopeProjectToRepository(record, 'acme/first').scm).toBe('github');
			expect(scopeProjectToRepository(record, 'acme/second').scm).toBe('github');

			const withStaleOverride = {
				...record,
				repositories: record.repositories.map((entry) => ({ ...entry, scm: 'gitlab' })),
			};
			expect(scopeProjectToRepository(withStaleOverride, 'acme/second').scm).toBe('github');
		});

		// "States no provider" is a distinct case `requireProjectSCMProvider` reports on,
		// so an unstated provider must stay an *absent* key rather than an explicit
		// `undefined` (the same care the DB read takes for a NULL `scm_type`).
		it('leaves scm absent when the project states none', () => {
			const record = createMockProjectRecord({ id: 'unstated' });
			const scoped = scopeProjectToRepository(record);
			expect(scoped.scm).toBeUndefined();
			expect(Object.hasOwn(scoped, 'scm')).toBe(false);
		});

		it('throws rather than falling back when the repository is not the project’s', () => {
			expect(() => scopeProjectToRepository(twoRepositoryRecord(), 'acme/third')).toThrow();
		});
	});
});
