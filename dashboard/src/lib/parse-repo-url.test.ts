import { describe, expect, it } from 'vitest';
import { parseRepoUrl } from './parse-repo-url.js';

describe('parseRepoUrl', () => {
	it('parses HTTPS URLs', () => {
		const result = parseRepoUrl('https://github.com/owner/repo');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
		});
	});

	it('parses HTTPS URLs with trailing .git', () => {
		const result = parseRepoUrl('https://github.com/owner/repo.git');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
		});
	});

	it('parses git@ SSH URLs', () => {
		const result = parseRepoUrl('git@github.com:owner/repo.git');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
		});
	});

	it('parses plain domain URLs', () => {
		const result = parseRepoUrl('github.com/owner/repo');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
		});
	});

	it('handles trailing slash', () => {
		const result = parseRepoUrl('https://github.com/owner/repo/');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
		});
	});

	it('handles query parameters and hash fragments', () => {
		const result = parseRepoUrl('https://github.com/owner/repo.git?foo=bar#L12');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
		});
	});

	it('slugifies name for ID properly', () => {
		const result = parseRepoUrl('https://github.com/Some-Org/My_Awesome.Repo.123');
		expect(result).toEqual({
			owner: 'Some-Org',
			repo: 'Some-Org/My_Awesome.Repo.123',
			id: 'my-awesome-repo-123',
			name: 'My_Awesome.Repo.123',
		});
	});

	it('handles generic hosts and host port', () => {
		const result = parseRepoUrl('https://gitlab.custom-domain.org:8080/some-group/project.git');
		expect(result).toEqual({
			owner: 'some-group',
			repo: 'some-group/project',
			id: 'project',
			name: 'project',
		});
	});

	it('handles SSH with ssh:// protocol and custom port', () => {
		const result = parseRepoUrl('ssh://git@altssh.gitlab.com:443/owner/repo-name.git');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo-name',
			id: 'repo-name',
			name: 'repo-name',
		});
	});

	it('handles org starting with digits', () => {
		const result = parseRepoUrl('git@github.com:123org/repo-name.git');
		expect(result).toEqual({
			owner: '123org',
			repo: '123org/repo-name',
			id: 'repo-name',
			name: 'repo-name',
		});
	});

	it('returns null for invalid inputs', () => {
		expect(parseRepoUrl('')).toBeNull();
		expect(parseRepoUrl('not-a-url')).toBeNull();
		expect(parseRepoUrl('github.com/owner')).toBeNull(); // missing repo name
		expect(parseRepoUrl('https://github.com/')).toBeNull();
	});

	// Issue #1089 phase 6/6: Azure DevOps addresses a repository by three segments, and a
	// clone URL decorates the path (`_git`, `v3/`, a legacy host carrying the organization).
	describe('Azure DevOps URLs', () => {
		const fiberWeb = {
			owner: 'Fabrikam/Fiber',
			repo: 'Fabrikam/Fiber/Web',
			id: 'web',
			name: 'Web',
		};

		it.each([
			'https://dev.azure.com/Fabrikam/Fiber/_git/Web',
			'https://Fabrikam@dev.azure.com/Fabrikam/Fiber/_git/Web',
			'git@ssh.dev.azure.com:v3/Fabrikam/Fiber/Web',
			'Fabrikam@vs-ssh.visualstudio.com:v3/Fabrikam/Fiber/Web',
		])('reads %s as organization/project/repository, keeping its casing', (url) => {
			expect(parseRepoUrl(url)).toEqual(fiberWeb);
		});

		it('decodes a project name carrying a space', () => {
			expect(parseRepoUrl('https://dev.azure.com/Fabrikam/Fiber%20Project/_git/Web')).toEqual({
				owner: 'Fabrikam/Fiber Project',
				repo: 'Fabrikam/Fiber Project/Web',
				id: 'web',
				name: 'Web',
			});
		});

		it('reads the short form for a repository named like its project', () => {
			expect(parseRepoUrl('https://dev.azure.com/Fabrikam/_git/Fiber')?.repo).toBe(
				'Fabrikam/Fiber/Fiber',
			);
		});

		// A hostname has no casing, so a legacy host's organization reads lower-case.
		it('reads a legacy visualstudio.com host, with or without DefaultCollection', () => {
			expect(parseRepoUrl('https://fabrikam.visualstudio.com/Fiber/_git/Web')?.repo).toBe(
				'fabrikam/Fiber/Web',
			);
			expect(
				parseRepoUrl('https://fabrikam.visualstudio.com/DefaultCollection/Fiber/_git/Web')?.repo,
			).toBe('fabrikam/Fiber/Web');
		});

		it('falls back to the generic reading for an Azure path it does not recognize', () => {
			expect(parseRepoUrl('https://dev.azure.com/Fabrikam/Fiber')?.repo).toBe('Fabrikam/Fiber');
		});
	});
});
