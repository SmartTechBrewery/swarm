import { describe, expect, it, vi } from 'vitest';

// `resolveOriginRepoSlug` wraps `execFile` in `promisify`. The mock carries no
// custom-promisify symbol, so `promisify` resolves with the callback's second arg —
// `{ stdout, stderr }` — the same shape `git-worktree-manager.test.ts` mocks.
type GitOutcome = { stdout?: string } | Error;
let gitHandler: (args: string[]) => GitOutcome;
const gitCalls: Array<{ args: string[]; opts: unknown }> = [];

vi.mock('node:child_process', () => ({
	execFile: (
		_cmd: string,
		args: string[],
		opts: unknown,
		cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
	) => {
		gitCalls.push({ args, opts });
		const outcome = gitHandler(args);
		if (outcome instanceof Error) cb(outcome);
		else cb(null, { stdout: outcome.stdout ?? '', stderr: '' });
	},
}));

import {
	normalizeRepoSlug,
	RepoSlugSchema,
	repoSlugFromRemoteUrl,
	repoSlugsMatch,
	resolveDeclarableOriginRepoSlug,
	resolveOriginRepoSlug,
} from '@/scm/repo-slug.js';

// These two moved here out of `src/worker/git-worktree-manager.ts` (issue #687) so
// the wire schema, the worker read model, and the provision-time identity check
// share one definition of `owner/repo`. The assertions below are what that move must
// not regress.
describe('normalizeRepoSlug', () => {
	it('strips a trailing .git and surrounding whitespace, and lower-cases', () => {
		expect(normalizeRepoSlug('  SmartTechBrewery/Swarm.git  ')).toBe('smarttechbrewery/swarm');
	});

	it('strips a trailing slash before removing a .git suffix', () => {
		expect(normalizeRepoSlug('SmartTechBrewery/Swarm.git/')).toBe('smarttechbrewery/swarm');
	});

	it('strips leading and trailing slashes (a URL pathname arrives with one)', () => {
		expect(normalizeRepoSlug('/SmartTechBrewery/swarm/')).toBe('smarttechbrewery/swarm');
	});

	it('leaves an already-normalised slug alone', () => {
		expect(normalizeRepoSlug('smarttechbrewery/swarm')).toBe('smarttechbrewery/swarm');
	});
});

// The named comparison the worker's pre-flight repository check runs (issue #688):
// it must normalise *both* sides, since one of them is a raw `ProjectConfig.repo`.
describe('repoSlugsMatch', () => {
	it('matches slugs that differ only in case, a .git suffix, or surrounding slashes', () => {
		expect(repoSlugsMatch('SmartTechBrewery/swarm', 'smarttechbrewery/Swarm.git')).toBe(true);
		expect(repoSlugsMatch('SmartTechBrewery/swarm', '/smarttechbrewery/swarm/')).toBe(true);
	});

	it('does not match two different repositories', () => {
		expect(repoSlugsMatch('SmartTechBrewery/swarm', 'acme/backend')).toBe(false);
		// Same name, different owner — the second-enrollment case worth failing on.
		expect(repoSlugsMatch('acme/swarm', 'SmartTechBrewery/swarm')).toBe(false);
	});
});

describe('repoSlugFromRemoteUrl', () => {
	it.each([
		['scp-style ssh', 'git@github.com:SmartTechBrewery/swarm.git'],
		['ssh url', 'ssh://git@github.com/SmartTechBrewery/swarm.git'],
		['ssh url with a port', 'ssh://git@github.com:443/SmartTechBrewery/swarm.git'],
		['https url', 'https://github.com/SmartTechBrewery/swarm'],
		['https url with a port', 'https://github.com:8080/SmartTechBrewery/Swarm.git'],
		['scp-style ssh with a trailing slash', 'git@github.com:SmartTechBrewery/swarm.git/'],
		['https url with a trailing slash', 'https://github.com/SmartTechBrewery/swarm.git/'],
	])('reads the slug from a %s', (_form, url) => {
		expect(repoSlugFromRemoteUrl(url)).toBe('smarttechbrewery/swarm');
	});

	// A GitLab subgroup path is kept whole rather than truncated to two segments —
	// the reason `RepoSlugSchema` accepts more than two below.
	it('keeps a nested namespace whole', () => {
		expect(repoSlugFromRemoteUrl('git@gitlab.com:group/sub/project.git')).toBe('group/sub/project');
	});

	it('returns null for an empty or unparseable URL', () => {
		expect(repoSlugFromRemoteUrl('')).toBeNull();
		expect(repoSlugFromRemoteUrl('   ')).toBeNull();
		expect(repoSlugFromRemoteUrl('not-a-url')).toBeNull();
	});
});

describe('RepoSlugSchema', () => {
	it('normalises rather than only validating, so one canonical form is recorded', () => {
		expect(RepoSlugSchema.parse('SmartTechBrewery/Swarm.git')).toBe('smarttechbrewery/swarm');
		expect(RepoSlugSchema.parse('  smarttechbrewery/swarm  ')).toBe('smarttechbrewery/swarm');
	});

	it('accepts a nested namespace, which ProjectConfig.repo would reject', () => {
		expect(RepoSlugSchema.parse('group/sub/project')).toBe('group/sub/project');
	});

	it('rejects a single segment, a host-prefixed value, and the empty string', () => {
		expect(RepoSlugSchema.safeParse('swarm').success).toBe(false);
		expect(RepoSlugSchema.safeParse('https://github.com/SmartTechBrewery/swarm').success).toBe(
			false,
		);
		expect(RepoSlugSchema.safeParse('').success).toBe(false);
	});
});

describe('resolveOriginRepoSlug', () => {
	it('reads origin with argv in the given cwd and returns the normalised slug', async () => {
		gitCalls.length = 0;
		gitHandler = () => ({ stdout: 'git@github.com:SmartTechBrewery/Swarm.git\n' });

		expect(await resolveOriginRepoSlug('/checkouts/swarm')).toBe('smarttechbrewery/swarm');
		// Argv, never a shell string, and `cwd` is what decides which repository is read.
		expect(gitCalls).toEqual([
			{ args: ['remote', 'get-url', 'origin'], opts: { cwd: '/checkouts/swarm' } },
		]);
	});

	// The "declares nothing rather than failing" contract both callers depend on: the
	// provision-time check treats null as "unverifiable, carry on", and the daemon
	// omits the handshake field instead of dying at startup.
	it('returns null when the checkout has no origin (or is not a repository at all)', async () => {
		gitHandler = () => new Error("error: No such remote 'origin'");
		expect(await resolveOriginRepoSlug('/checkouts/local-only')).toBeNull();
	});

	it('returns null for a remote URL no slug can be read from', async () => {
		gitHandler = () => ({ stdout: 'not-a-url\n' });
		expect(await resolveOriginRepoSlug('/checkouts/odd')).toBeNull();

		gitHandler = () => ({ stdout: '\n' });
		expect(await resolveOriginRepoSlug('/checkouts/empty')).toBeNull();
	});

	// Deliberately *not* filtered through `RepoSlugSchema`: the provision-time identity
	// check wants every slug it can read, since a checkout resolving to something
	// unexpected is exactly what it exists to refuse.
	it('returns a slug the wire schema would reject, rather than swallowing it', async () => {
		gitHandler = () => ({ stdout: 'https://github.com/swarm\n' });
		expect(await resolveOriginRepoSlug('/checkouts/rootish')).toBe('swarm');
	});
});

// The declaration policy: whatever the read produces, the daemon may only declare a
// value `HandshakeRequestSchema.parse` accepts — it parses its own body at startup, so
// an odd remote URL must leave it undeclared rather than kill it (issue #687).
describe('resolveDeclarableOriginRepoSlug', () => {
	it('declares the normalised slug of an identifiable checkout', async () => {
		gitHandler = () => ({ stdout: 'git@github.com:SmartTechBrewery/Swarm.git\n' });
		expect(await resolveDeclarableOriginRepoSlug('/checkouts/swarm')).toBe(
			'smarttechbrewery/swarm',
		);
	});

	it('declares nothing when the checkout has no identifiable origin', async () => {
		gitHandler = () => new Error("error: No such remote 'origin'");
		expect(await resolveDeclarableOriginRepoSlug('/checkouts/local-only')).toBeUndefined();
	});

	it('declares nothing for a slug the wire schema would reject', async () => {
		gitHandler = () => ({ stdout: 'https://github.com/swarm\n' });
		expect(await resolveDeclarableOriginRepoSlug('/checkouts/rootish')).toBeUndefined();
	});
});
