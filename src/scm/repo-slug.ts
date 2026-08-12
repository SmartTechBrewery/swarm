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
 * Three consumers share these definitions, which is why they live here rather
 * than privately in the worktree manager:
 *
 * - the provision-time identity check (`GitWorktreeManager.assertRepoIdentity`),
 *   which refuses a checkout that is a git repository but not the assigned one;
 * - the transport handshake (`HandshakeRequestSchema.repository`,
 *   `../transport/protocol.ts`), where a daemon declares which repository its one
 *   local checkout is ({@link resolveDeclarableOriginRepoSlug});
 * - the persisted worker read model (`Worker.repository`, `../identity/worker.ts`).
 *
 * Sharing one normaliser is the point: a comparison between a declaration and a
 * `ProjectConfig.repo` is only meaningful if both sides agree on what
 * `owner/repo` means, and the stored form is the normalised one — so a later
 * comparison must run the *config* side through {@link normalizeRepoSlug} too.
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
 * The `owner/name` a clone URL points at, or `null` when it cannot be read.
 * Deliberately provider-neutral: handles `scp`-style (`git@host:owner/name`),
 * `ssh://`, and `https://` forms, and keeps the whole path so a nested namespace
 * (a GitLab subgroup) compares correctly rather than being truncated to two parts.
 */
export function repoSlugFromRemoteUrl(url: string): string | null {
	const trimmed = url.trim();
	if (trimmed === '') return null;
	const scpStyle = trimmed.match(/^[^/@]+@[^:/]+:(.+)$/);
	if (scpStyle?.[1]) return normalizeRepoSlug(scpStyle[1]);
	try {
		return normalizeRepoSlug(new URL(trimmed).pathname) || null;
	} catch {
		return null;
	}
}

/**
 * A repository slug on the wire and in the read model. It **normalises** rather
 * than only validating, so one canonical form is recorded whatever casing or
 * `.git` suffix a sender happens to have — the same normalise-at-the-boundary
 * move the handshake already makes for `supportedPhases`.
 *
 * It accepts **two or more** segments, unlike `ProjectConfigBaseSchema.repo`'s
 * exactly-two: {@link repoSlugFromRemoteUrl} deliberately keeps a nested
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
