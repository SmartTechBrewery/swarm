/**
 * The provider-neutral `owner/repo` slug — SWARM's one definition of *which
 * repository* something is, and the one read that answers it for a checkout on
 * disk (issue #687).
 *
 * The **normalised form** is what `ProjectConfig.repo` already states: no scheme,
 * no host, no `.git` suffix, no surrounding slashes, lower-cased. Lower-casing is
 * deliberate — this is a comparison key, and a host's own casing of a path is
 * noise rather than identity. It carries no host, which means a slug cannot tell
 * two providers apart (`SmartTechBrewery/swarm` on GitHub and on a self-hosted
 * GitLab normalise identically). That is accepted: every consumer here guards
 * against operator error — a daemon launched in the wrong directory — not against
 * an attacker, and the declaration is self-reported anyway.
 *
 * Four consumers share these definitions, which is why they live here rather
 * than privately in the worktree manager:
 *
 * - the provision-time identity check (`GitWorktreeManager.assertRepoIdentity`),
 *   which refuses a checkout that is a git repository but not the assigned one;
 * - the transport handshake (`HandshakeRequestSchema.repository` and
 *   `.repositories`, `../transport/protocol.ts`), where a daemon declares which
 *   repositories its local checkouts are ({@link resolveDeclarableOriginRepoSlug});
 * - the persisted worker read model (`Worker.repositories`, `../identity/worker.ts`);
 * - the GitHub Projects PM provider's card routing (issue #686), which compares a
 *   card's backing `repository { nameWithOwner }` against the project's repository
 *   entries ({@link repoSlugsMatch}).
 *
 * Sharing one normaliser is the point: a comparison between a declaration and a
 * `ProjectConfig.repo` is only meaningful if both sides agree on what
 * `owner/repo` means, and the stored form is the normalised one — so a later
 * comparison must run the *config* side through {@link normalizeRepoSlug} too.
 *
 * **One host's clone-URL grammar lives here too: Azure DevOps's** (issue #1089). Its
 * remotes decorate the repository path — `/_git/` in HTTPS URLs, a `v3/` prefix over
 * SSH, the organization in the hostname of a legacy `*.visualstudio.com` URL — so the
 * plain path would read an Azure checkout as `org/project/_git/repo` and every
 * consumer above would refuse the `org/project/repo` its config states. The grammar is
 * keyed by host and kept at this git-transport layer rather than in the provider's
 * folder, because this module must stay registry-free: the DB-free daemon's handshake
 * and the worktree manager read it without loading any provider.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

/** Compare a `ProjectConfig.repo` and a remote's path on equal terms — case and trailing `.git` are noise. */
export function normalizeRepoSlug(slug: string): string {
	return slug
		.trim()
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '')
		.toLowerCase();
}

/**
 * Whether two slugs name the same repository, each normalised first — the named
 * form of the comparison the module header describes, so no caller has to
 * remember that the *config* side needs {@link normalizeRepoSlug} too (issue #688).
 *
 * It is an equality test on a host-less slug, with everything that implies (see
 * the header): it guards against operator error, not against an attacker, and it
 * cannot tell two providers hosting the same path apart.
 */
export function repoSlugsMatch(a: string, b: string): boolean {
	return normalizeRepoSlug(a) === normalizeRepoSlug(b);
}

/**
 * The `owner/name` a clone URL points at, or `null` when it cannot be read.
 * Deliberately provider-neutral: handles `scp`-style (`git@host:owner/name`),
 * `ssh://`, and `https://` forms, and keeps the whole path so a nested namespace
 * (a GitLab subgroup) compares correctly rather than being truncated to two parts.
 * An Azure DevOps remote reads as `organization/project/repository`, the shape its
 * `ProjectConfig.repo` states ({@link azureDevOpsRepoPath}).
 */
export function repoSlugFromRemoteUrl(url: string): string | null {
	const trimmed = url.trim();
	if (trimmed === '') return null;
	const scpStyle = trimmed.match(/^[^/@]+@([^:/]+):(.+)$/);
	if (scpStyle?.[1] && scpStyle[2]) {
		return normalizeRepoSlug(azureDevOpsRepoPath(scpStyle[1], scpStyle[2]) ?? scpStyle[2]);
	}
	try {
		const { hostname, pathname } = new URL(trimmed);
		return normalizeRepoSlug(azureDevOpsRepoPath(hostname, pathname) ?? pathname) || null;
	} catch {
		return null;
	}
}

const AZURE_DEVOPS_HOST = 'dev.azure.com';
const AZURE_DEVOPS_SSH_HOSTS: ReadonlySet<string> = new Set([
	'ssh.dev.azure.com',
	'vs-ssh.visualstudio.com',
]);
const AZURE_DEVOPS_LEGACY_HOST_SUFFIX = '.visualstudio.com';

/**
 * The `organization/project/repository` an Azure DevOps clone URL's `path` names on
 * `host`, or `null` when `host` is not an Azure DevOps host or the path is not a shape
 * it serves — the generic path then applies, so an unexpected shape fails the identity
 * check loudly rather than being guessed at. The forms:
 *
 * - `dev.azure.com/{org}/{project}/_git/{repo}`, and `{org}/_git/{repo}` — Azure's short
 *   form for a repository named like its project;
 * - `ssh.dev.azure.com` / `vs-ssh.visualstudio.com`: `v3/{org}/{project}/{repo}`;
 * - legacy `{org}.visualstudio.com`: an optional `DefaultCollection`, then either of the
 *   `dev.azure.com` forms without the organization, which is the host's first label.
 *
 * Each segment is percent-decoded, since Azure project and repository names may carry
 * spaces (`My%20Project`); that is confined to these hosts, so every other remote reads
 * exactly as it did.
 */
function azureDevOpsRepoPath(host: string, path: string): string | null {
	const hostname = host.toLowerCase();
	const segments = path
		.split('/')
		.filter((segment) => segment !== '')
		.map(decodePathSegment);

	if (AZURE_DEVOPS_SSH_HOSTS.has(hostname)) {
		const [version, org, project, repo, ...rest] = segments;
		if (version?.toLowerCase() !== 'v3' || !org || !project || !repo || rest.length > 0) {
			return null;
		}
		return `${org}/${project}/${repo}`;
	}
	if (hostname === AZURE_DEVOPS_HOST) {
		const [org, ...rest] = segments;
		return org ? azureDevOpsGitPath(org, rest) : null;
	}
	if (hostname.endsWith(AZURE_DEVOPS_LEGACY_HOST_SUFFIX)) {
		const org = hostname.slice(0, -AZURE_DEVOPS_LEGACY_HOST_SUFFIX.length);
		if (org === '' || org.includes('.')) return null;
		const rest = segments[0]?.toLowerCase() === 'defaultcollection' ? segments.slice(1) : segments;
		return azureDevOpsGitPath(org, rest);
	}
	return null;
}

/** `{project}/_git/{repo}` or `_git/{repo}` under `org`, as `org/project/repo`. */
function azureDevOpsGitPath(org: string, rest: readonly string[]): string | null {
	const [first, second, third] = rest;
	if (rest.length === 3 && first && third && second?.toLowerCase() === '_git') {
		return `${org}/${first}/${third}`;
	}
	if (rest.length === 2 && second && first?.toLowerCase() === '_git') {
		return `${org}/${second}/${second}`;
	}
	return null;
}

function decodePathSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/**
 * A repository slug on the wire and in the read model. It **normalises** rather
 * than only validating, so one canonical form is recorded whatever casing or
 * `.git` suffix a sender happens to have — the same normalise-at-the-boundary
 * move the handshake already makes for `supportedPhases`.
 *
 * It accepts **two or more** segments, unlike `ProjectConfigBaseSchema.repo`'s
 * two-or-three, whose exact count is the provider's (`src/scm/repo-coordinates.ts` —
 * three on Azure DevOps since issue #1089, two elsewhere): {@link repoSlugFromRemoteUrl}
 * deliberately keeps a nested
 * namespace whole, and a checkout of a GitLab subgroup must be able to state
 * what it is. Rejecting one would fail that daemon's handshake outright instead
 * of simply matching no project.
 */
export const RepoSlugSchema = z
	.string()
	.trim()
	.transform(normalizeRepoSlug)
	.refine((slug) => /^[^/]+(?:\/[^/]+)+$/.test(slug), {
		message: 'must be a host-less "owner/repo" slug',
	});

/**
 * The repository a checkout at `cwd` actually is, read from its `origin` remote, or
 * `null` when it cannot be identified — no `origin` at all (a local-only clone, a
 * test fixture), a `cwd` that is not a git repository, or a URL no slug can be read
 * from.
 *
 * **Never throws.** Both callers depend on that: the provision-time identity check
 * treats `null` as "unverifiable, carry on" rather than refusing a checkout it cannot
 * name, and the daemon must be able to start on a machine whose checkout cannot be
 * identified.
 *
 * Argv, never a shell string, exactly as `GitWorktreeManager.git` runs it.
 */
export async function resolveOriginRepoSlug(cwd: string): Promise<string | null> {
	let remoteUrl: string;
	try {
		remoteUrl = (
			await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd })
		).stdout.trim();
	} catch {
		return null;
	}
	return repoSlugFromRemoteUrl(remoteUrl);
}

/**
 * The slug a daemon may **declare** for its checkout at `cwd`, or `undefined` when it
 * has none to declare — {@link resolveOriginRepoSlug} put through
 * {@link RepoSlugSchema}, which is what makes the declaration safe to hand to
 * `HandshakeRequestSchema.parse`: the daemon parses its own handshake body at
 * startup, so a value that schema would reject must never reach it, or an odd remote
 * URL would kill the daemon instead of leaving it undeclared (issue #687).
 *
 * Kept separate from the plain read rather than folded into it, because the filter is
 * a *declaration* policy: the identity check wants every slug it can read, including
 * one this schema rejects, since a checkout that resolves to something unexpected is
 * exactly what it exists to refuse.
 */
export async function resolveDeclarableOriginRepoSlug(cwd: string): Promise<string | undefined> {
	const slug = await resolveOriginRepoSlug(cwd);
	if (!slug) return undefined;
	const parsed = RepoSlugSchema.safeParse(slug);
	return parsed.success ? parsed.data : undefined;
}
