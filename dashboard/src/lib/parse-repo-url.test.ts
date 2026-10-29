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
			provider: 'github',
		});
	});

	it('parses HTTPS URLs with trailing .git', () => {
		const result = parseRepoUrl('https://github.com/owner/repo.git');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
			provider: 'github',
		});
	});

	it('parses git@ SSH URLs', () => {
		const result = parseRepoUrl('git@github.com:owner/repo.git');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
			provider: 'github',
		});
	});

	it('parses plain domain URLs', () => {
		const result = parseRepoUrl('github.com/owner/repo');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
			provider: 'github',
		});
	});

	it('handles trailing slash', () => {
		const result = parseRepoUrl('https://github.com/owner/repo/');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
			provider: 'github',
		});
	});

	it('handles query parameters and hash fragments', () => {
		const result = parseRepoUrl('https://github.com/owner/repo.git?foo=bar#L12');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo',
			id: 'repo',
			name: 'repo',
			provider: 'github',
		});
	});

	it('slugifies name for ID properly', () => {
		const result = parseRepoUrl('https://github.com/Some-Org/My_Awesome.Repo.123');
		expect(result).toEqual({
			owner: 'Some-Org',
			repo: 'Some-Org/My_Awesome.Repo.123',
			id: 'my-awesome-repo-123',
			name: 'My_Awesome.Repo.123',
			provider: 'github',
		});
	});

	it('handles generic hosts and host port', () => {
		const result = parseRepoUrl('https://gitlab.custom-domain.org:8080/some-group/project.git');
		expect(result).toEqual({
			owner: 'some-group',
			repo: 'some-group/project',
			id: 'project',
			name: 'project',
			provider: null,
		});
	});

	it('handles SSH with ssh:// protocol and custom port', () => {
		const result = parseRepoUrl('ssh://git@altssh.gitlab.com:443/owner/repo-name.git');
		expect(result).toEqual({
			owner: 'owner',
			repo: 'owner/repo-name',
			id: 'repo-name',
			name: 'repo-name',
			provider: 'gitlab',
		});
	});

	it('handles org starting with digits', () => {
		const result = parseRepoUrl('git@github.com:123org/repo-name.git');
		expect(result).toEqual({
			owner: '123org',
			repo: '123org/repo-name',
			id: 'repo-name',
			name: 'repo-name',
			provider: 'github',
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
			provider: 'azure-devops',
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
				provider: 'azure-devops',
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

	// Issue #1181: autofill selects the provider a URL belongs to, so the parser reports it
	// alongside the repository — read off the host, HTTPS and SSH forms alike.
	describe('provider recognition', () => {
		it.each([
			['https://github.com/owner/repo', 'github'],
			['git@github.com:owner/repo.git', 'github'],
			['ssh://git@ssh.github.com:443/owner/repo.git', 'github'],
			['https://bitbucket.org/workspace/repo', 'bitbucket'],
			['https://user@bitbucket.org/workspace/repo.git', 'bitbucket'],
			['git@bitbucket.org:workspace/repo.git', 'bitbucket'],
			['ssh://git@altssh.bitbucket.org:443/workspace/repo.git', 'bitbucket'],
			['https://gitlab.com/namespace/project', 'gitlab'],
			['git@gitlab.com:namespace/project.git', 'gitlab'],
			['ssh://git@altssh.gitlab.com:443/namespace/project.git', 'gitlab'],
			['https://dev.azure.com/Fabrikam/Fiber/_git/Web', 'azure-devops'],
			['git@ssh.dev.azure.com:v3/Fabrikam/Fiber/Web', 'azure-devops'],
			['https://fabrikam.visualstudio.com/Fiber/_git/Web', 'azure-devops'],
			['Fabrikam@vs-ssh.visualstudio.com:v3/Fabrikam/Fiber/Web', 'azure-devops'],
			['HTTPS://GitHub.com/owner/repo', 'github'],
		])('recognizes %s as %s', (url, provider) => {
			expect(parseRepoUrl(url)?.provider).toBe(provider);
		});

		// The host alone decides: an Azure path the parser cannot read is still Azure's, so
		// selecting it lets the Repo field say the repository is incomplete.
		it('recognizes the provider even when the path falls back to the generic reading', () => {
			expect(parseRepoUrl('https://dev.azure.com/Fabrikam/Fiber')?.provider).toBe('azure-devops');
		});

		it.each([
			'https://gitlab.example.com/group/project.git',
			'git@git.internal:team/repo.git',
			'https://github.example.com/owner/repo',
			'https://notgithub.com/owner/repo',
		])('reports no provider for %s, whose host does not tell', (url) => {
			const result = parseRepoUrl(url);
			expect(result).not.toBeNull();
			expect(result?.provider).toBeNull();
		});
	});
});
