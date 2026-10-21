import { describe, expect, it } from 'vitest';
import { repoCoordinatesIssue, SCM_REPO_COORDINATES } from '@/scm/repo-coordinates.js';
import { SCM_TYPES } from '@/scm/types.js';

describe('SCM_REPO_COORDINATES', () => {
	it('addresses an Azure DevOps repository by three segments and every other provider by two', () => {
		for (const scm of SCM_TYPES) {
			expect(SCM_REPO_COORDINATES[scm].segments).toBe(scm === 'azure-devops' ? 3 : 2);
			expect(SCM_REPO_COORDINATES[scm].format.split('/')).toHaveLength(
				SCM_REPO_COORDINATES[scm].segments,
			);
		}
	});
});

describe('repoCoordinatesIssue', () => {
	it('accepts a repository in the shape its provider addresses one by', () => {
		expect(repoCoordinatesIssue('github', 'owner/repo')).toBeNull();
		expect(repoCoordinatesIssue('azure-devops', 'Org/My Project/Repo')).toBeNull();
	});

	it('names the provider and its format for a mismatch in either direction', () => {
		expect(repoCoordinatesIssue('github', 'org/project/repo')).toBe(
			"Repository 'org/project/repo' has 3 segments, but SCM provider 'github' expects 2: \"owner/repo\"",
		);
		expect(repoCoordinatesIssue('azure-devops', 'project/repo')).toMatch(
			/SCM provider 'azure-devops' expects 3: "organization\/project\/repository"/,
		);
	});

	// The shape of every project written before `scm` existed.
	it('expects two segments when the project names no provider', () => {
		expect(repoCoordinatesIssue(undefined, 'owner/repo')).toBeNull();
		expect(repoCoordinatesIssue(undefined, 'org/project/repo')).toMatch(
			/a project that names no SCM provider expects 2/,
		);
	});
});
