export interface ParsedRepoUrl {
	owner: string;
	repo: string;
	id: string; // slugified repo name
	name: string; // repo name as-is
}

/**
 * Parses a repository URL generically to extract owner, repo name, slugified ID, and name.
 * Accepts formats:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 * - github.com/owner/repo
 *
 * An Azure DevOps URL reads as the three-segment `organization/project/repository` its
 * project's `repo` states (issue #1089 phase 6/6) — see {@link azureDevOpsRepoPath}, with
 * `owner` the `organization/project` pair.
 */
export function parseRepoUrl(url: string): ParsedRepoUrl | null {
	if (!url) return null;

	// 1. Clean query parameters and hash fragments
	let str = url.trim().split(/[?#]/)[0];

	// 2. Strip protocol (e.g. https://, git+ssh://, etc.)
	str = str.replace(/^[a-zA-Z+-]+:\/\//, '');

	// 3. Strip username prefix if present (e.g. git@)
	str = str.replace(/^[^@]+@/, '');

	// 4. Replace the host-owner separator ":" with "/" if it's SCP-like syntax (not followed by a port number)
	str = str.replace(/^([^/:]+):(?!\d+\/)/, '$1/');

	// 5. Split into segments and filter empty ones
	const segments = str.split('/').filter(Boolean);

	const azure = azureDevOpsRepoPath(segments);
	if (azure) return toParsed(azure.owner, azure.name);

	// We expect at least a host, an owner, and a repo name (at least 3 segments)
	if (segments.length < 3) {
		return null;
	}

	// The last segment is the repo name, the second-to-last is the owner
	let repoSegment = segments[segments.length - 1];
	const owner = segments[segments.length - 2];

	// Tolerating a trailing .git
	if (repoSegment.endsWith('.git')) {
		repoSegment = repoSegment.slice(0, -4);
	}

	if (!repoSegment || !owner) {
		return null;
	}

	return toParsed(owner, repoSegment);
}

function toParsed(owner: string, name: string): ParsedRepoUrl | null {
	// ID: slugified repo name (lowercase, non-[a-z0-9-] runs collapsed to -, trimmed)
	const id = name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '');

	if (!id) {
		return null;
	}

	return {
		owner,
		repo: `${owner}/${name}`,
		id,
		name,
	};
}

const AZURE_DEVOPS_HOST = 'dev.azure.com';
const AZURE_DEVOPS_SSH_HOSTS: ReadonlySet<string> = new Set([
	'ssh.dev.azure.com',
	'vs-ssh.visualstudio.com',
]);
const AZURE_DEVOPS_LEGACY_HOST_SUFFIX = '.visualstudio.com';

/**
 * The `organization/project` owner and repository name an Azure DevOps URL names, or
 * `null` when the host is not Azure DevOps' or the path is not a shape it serves — the
 * same forms the server reads a checkout's remote by (`repoSlugFromRemoteUrl`,
 * `src/scm/repo-slug.ts`, which a browser bundle cannot import):
 *
 * - `dev.azure.com/{org}/{project}/_git/{repo}`, and `{org}/_git/{repo}` for a
 *   repository named like its project;
 * - `ssh.dev.azure.com` / `vs-ssh.visualstudio.com`: `v3/{org}/{project}/{repo}`;
 * - legacy `{org}.visualstudio.com`: an optional `DefaultCollection`, then either of the
 *   `dev.azure.com` forms without the organization, which is the host's first label.
 *
 * Unlike the server's comparison key this keeps Azure's casing — the receiver resolves a
 * project by exact match on `repo` — and percent-decodes each segment, since project and
 * repository names may carry spaces.
 */
function azureDevOpsRepoPath(segments: readonly string[]): { owner: string; name: string } | null {
	const [rawHost, ...rawPath] = segments;
	if (!rawHost) return null;
	const coordinates = azureDevOpsCoordinates(rawHost.toLowerCase(), rawPath.map(decodeSegment));
	if (!coordinates) return null;

	const [org, project, repo] = coordinates;
	const name = repo.replace(/\.git$/i, '');
	return name ? { owner: `${org}/${project}`, name } : null;
}

/** `[org, project, repo]` for one of the host forms {@link azureDevOpsRepoPath} lists. */
function azureDevOpsCoordinates(
	host: string,
	path: readonly string[],
): [string, string, string] | null {
	if (AZURE_DEVOPS_SSH_HOSTS.has(host)) {
		const [version, org, project, repo, ...rest] = path;
		const complete = org && project && repo && rest.length === 0;
		return version?.toLowerCase() === 'v3' && complete ? [org, project, repo] : null;
	}
	if (host === AZURE_DEVOPS_HOST) {
		const [org, ...rest] = path;
		return org ? azureDevOpsGitPath(org, rest) : null;
	}
	if (host.endsWith(AZURE_DEVOPS_LEGACY_HOST_SUFFIX)) {
		const org = host.slice(0, -AZURE_DEVOPS_LEGACY_HOST_SUFFIX.length);
		if (org === '' || org.includes('.')) return null;
		const rest = path[0]?.toLowerCase() === 'defaultcollection' ? path.slice(1) : path;
		return azureDevOpsGitPath(org, rest);
	}
	return null;
}

/** `{project}/_git/{repo}` or `_git/{repo}` under `org`, as `[org, project, repo]`. */
function azureDevOpsGitPath(org: string, rest: readonly string[]): [string, string, string] | null {
	const [first, second, third] = rest;
	if (rest.length === 3 && first && third && second?.toLowerCase() === '_git') {
		return [org, first, third];
	}
	if (rest.length === 2 && second && first?.toLowerCase() === '_git') {
		return [org, second, second];
	}
	return null;
}

function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}
