/**
 * Host-local install-root updates (issue #920).
 *
 * Every subprocess runs through the injected {@link CommandRunner}, and the state
 * directory is a `mkdtemp` path, so no git runs and no real `~/.swarm` is touched.
 * The assertions that matter are about *argv* — which commands ran, in which order,
 * with which arguments — because the security properties this module exists for are
 * properties of the argv it builds.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type ApplyUpdateTargetOptions,
	applyUpdateTarget,
	type CommandRunner,
	InstallUpdateStateSchema,
	installUpdateStateDir,
	recordFailedStart,
	recordSuccessfulHandshake,
	returnToLastKnownGood,
	type UpdateCommand,
	type UpdateCommandResult,
} from '@/worker/self-update.js';

const INSTALL_ROOT = '/opt/swarm';
const REMOTE = 'origin';
const BRANCH = 'main';
const HEAD = 'a'.repeat(40);
const TARGET_COMMIT = 'b'.repeat(40);
const HEAD_REF = `refs/heads/${BRANCH}`;
/** The upstream read, as argv — one key, because every case shares the same local branch. */
const UPSTREAM_ARGV = `git for-each-ref --format=%(upstream:remotename)%0a%(upstream:remoteref) ${HEAD_REF}`;

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
	const home = mkdtempSync(join(tmpdir(), 'swarm-self-update-'));
	homes.push(home);
	return home;
}

const ok = (stdout = ''): UpdateCommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = 'boom'): UpdateCommandResult => ({ exitCode: 1, stdout: '', stderr });

/** The argv of a command, as one string — what the assertions below compare against. */
function argvOf(command: UpdateCommand): string {
	return [command.command, ...command.args].join(' ');
}

/**
 * A runner scripted by argv. Anything not named answers `ok('')`, so a case states
 * only the steps it is actually about.
 *
 * An override may be a **list**, consumed one per matching call before falling back
 * to the default — which is how "`npm ci` fails on the new commit and succeeds on
 * the old one" is expressed, since the rollback runs the identical argv.
 */
function scriptedRunner(
	overrides: Record<string, UpdateCommandResult | UpdateCommandResult[]> = {},
): {
	run: CommandRunner;
	calls: UpdateCommand[];
	argv: () => string[];
} {
	const calls: UpdateCommand[] = [];
	const defaults: Record<string, UpdateCommandResult> = {
		'git rev-parse HEAD': ok(HEAD),
		'git status --porcelain': ok(''),
		'git symbolic-ref --quiet HEAD': ok(HEAD_REF),
		[UPSTREAM_ARGV]: ok(`${REMOTE}\n${HEAD_REF}`),
		[`git fetch ${REMOTE}`]: ok(''),
		[`git rev-parse --verify refs/remotes/${REMOTE}/${BRANCH}^{commit}`]: ok(TARGET_COMMIT),
		[`git merge-base --is-ancestor ${TARGET_COMMIT} refs/remotes/${REMOTE}/${BRANCH}`]: ok(''),
	};
	const run = vi.fn<(command: UpdateCommand) => Promise<UpdateCommandResult>>(async (command) => {
		calls.push(command);
		const key = argvOf(command);
		const scripted = overrides[key];
		if (Array.isArray(scripted)) {
			const next = scripted.shift();
			if (next) return next;
		} else if (scripted) {
			return scripted;
		}
		return defaults[key] ?? ok('');
	});
	return { run, calls, argv: () => calls.map(argvOf) };
}

function readState(home: string): unknown {
	const path = join(installUpdateStateDir(INSTALL_ROOT, home), 'state.json');
	return InstallUpdateStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function writeStoredState(home: string, overrides: Record<string, unknown> = {}): void {
	const dir = installUpdateStateDir(INSTALL_ROOT, home);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, 'state.json'),
		JSON.stringify({
			installRoot: INSTALL_ROOT,
			remote: REMOTE,
			trackedBranch: BRANCH,
			lastKnownGood: HEAD,
			target: null,
			targetCommit: null,
			appliedAt: null,
			...overrides,
		}),
	);
}

async function apply(
	home: string,
	run: CommandRunner,
	target = BRANCH,
	extra: Partial<ApplyUpdateTargetOptions> = {},
): ReturnType<typeof applyUpdateTarget> {
	return applyUpdateTarget({
		target,
		installRoot: INSTALL_ROOT,
		homeDir: home,
		run,
		now: () => new Date('2026-02-01T00:00:00.000Z'),
		...extra,
	});
}

describe('applyUpdateTarget — target validation', () => {
	const rejected = [
		['a URL', 'https://evil.example/repo.git'],
		['a shell fragment', 'main; rm -rf /'],
		['a git option', '--upload-pack=curl'],
		['a leading dot', '.hidden'],
		['a parent-directory escape', 'refs/heads/../../etc'],
		['a revision expression', 'main@{1}'],
		['a refspec arrow', 'main:refs/heads/main'],
		['whitespace', 'main master'],
		['a tilde expression', 'main~3'],
		['a trailing slash', 'feature/'],
		['a ref lock file', 'main.lock'],
		['an over-long string', `${'a'.repeat(201)}`],
		['an empty string', ''],
	] as const;

	for (const [what, target] of rejected) {
		it(`refuses ${what} without running anything`, async () => {
			const home = makeHome();
			const { run, calls } = scriptedRunner();

			const outcome = await apply(home, run, target);

			expect(outcome.status).toBe('refused');
			expect(calls).toHaveLength(0);
		});
	}

	it('does not echo control characters from a rejected target', async () => {
		const home = makeHome();
		const { run } = scriptedRunner();

		const outcome = await apply(home, run, 'main\u001b[31m');

		expect(outcome.status).toBe('refused');
		if (outcome.status !== 'refused') return;
		expect(outcome.reason).not.toContain('\u001b');
	});

	const accepted = ['main', 'release/2026-01', 'v1.2.3', TARGET_COMMIT, 'abc1234'];
	for (const target of accepted) {
		it(`accepts '${target}'`, async () => {
			const home = makeHome();
			const { run, argv } = scriptedRunner({
				[`git rev-parse --verify refs/remotes/${REMOTE}/${target}^{commit}`]: ok(TARGET_COMMIT),
				[`git rev-parse --verify ${target}^{commit}`]: ok(TARGET_COMMIT),
			});

			const outcome = await apply(home, run, target);

			expect(outcome.status).toBe('applied');
			expect(argv()).toContain('git rev-parse HEAD');
		});
	}
});

describe('applyUpdateTarget — what it asks git for', () => {
	it('fetches only the configured remote, with no refspec and no URL', async () => {
		const home = makeHome();
		const { run, calls, argv } = scriptedRunner();

		await apply(home, run);

		const fetch = calls.find((call) => call.args[0] === 'fetch');
		expect(fetch).toBeDefined();
		expect(fetch?.command).toBe('git');
		expect(fetch?.args).toEqual(['fetch', REMOTE]);
		// The target never rides the fetch — the remote's own config decides what arrives.
		expect(argv().filter((line) => line.startsWith('git fetch'))).toEqual([`git fetch ${REMOTE}`]);
	});

	it('prefers the remote namespace when resolving a branch target', async () => {
		const home = makeHome();
		const { run, argv } = scriptedRunner();

		await apply(home, run);

		expect(argv()).toContain(`git rev-parse --verify refs/remotes/${REMOTE}/${BRANCH}^{commit}`);
		expect(argv()).not.toContain(`git rev-parse --verify ${BRANCH}^{commit}`);
	});

	it('falls back to the plain ref for a tag or commit id', async () => {
		const home = makeHome();
		const { run, argv } = scriptedRunner({
			[`git rev-parse --verify refs/remotes/${REMOTE}/v9.9.9^{commit}`]: fail('unknown revision'),
			'git rev-parse --verify v9.9.9^{commit}': ok(TARGET_COMMIT),
		});

		const outcome = await apply(home, run, 'v9.9.9');

		expect(outcome.status).toBe('applied');
		expect(argv()).toContain('git rev-parse --verify v9.9.9^{commit}');
	});

	it('runs checkout, npm ci and npm run build in that order, all in the install root', async () => {
		const home = makeHome();
		const { run, calls, argv } = scriptedRunner();

		const outcome = await apply(home, run);

		expect(outcome).toEqual({
			status: 'applied',
			commit: TARGET_COMMIT,
			previousCommit: HEAD,
		});
		expect(argv().slice(-3)).toEqual([
			`git checkout --detach ${TARGET_COMMIT}`,
			'npm ci',
			'npm run build',
		]);
		expect(calls.every((call) => call.cwd === INSTALL_ROOT)).toBe(true);
		expect(calls.every((call) => call.timeoutMs > 0)).toBe(true);
	});
});

describe('applyUpdateTarget — refusals', () => {
	it('refuses an install root that is not a git checkout', async () => {
		const home = makeHome();
		const { run, argv } = scriptedRunner({ 'git rev-parse HEAD': fail('not a repository') });

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('refused');
		if (outcome.status !== 'refused') return;
		expect(outcome.reason).toContain(INSTALL_ROOT);
		expect(argv()).toEqual(['git rev-parse HEAD']);
	});

	it('refuses a dirty install root before fetching or building anything', async () => {
		const home = makeHome();
		const { run, argv } = scriptedRunner({
			'git status --porcelain': ok(' M src/index.ts\n'),
		});

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('refused');
		if (outcome.status !== 'refused') return;
		expect(outcome.reason).toContain('uncommitted changes');
		expect(argv()).toEqual(['git rev-parse HEAD', 'git status --porcelain']);
	});

	it('refuses a target that is not reachable from the tracked branch', async () => {
		const home = makeHome();
		const { run, argv } = scriptedRunner({
			[`git merge-base --is-ancestor ${TARGET_COMMIT} refs/remotes/${REMOTE}/${BRANCH}`]: fail(''),
		});

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('refused');
		if (outcome.status !== 'refused') return;
		expect(outcome.reason).toContain('not reachable');
		expect(argv().some((line) => line.startsWith('git checkout'))).toBe(false);
		expect(argv().some((line) => line.startsWith('npm'))).toBe(false);
	});

	it('refuses a target no ref resolves', async () => {
		const home = makeHome();
		const { run, argv } = scriptedRunner({
			[`git rev-parse --verify refs/remotes/${REMOTE}/nope^{commit}`]: fail(''),
			'git rev-parse --verify nope^{commit}': fail(''),
		});

		const outcome = await apply(home, run, 'nope');

		expect(outcome.status).toBe('refused');
		if (outcome.status !== 'refused') return;
		expect(outcome.reason).toContain("'nope'");
		expect(argv().some((line) => line.startsWith('git merge-base'))).toBe(false);
	});

	it('refuses when the fetch fails', async () => {
		const home = makeHome();
		const { run, argv } = scriptedRunner({ [`git fetch ${REMOTE}`]: fail('network down') });

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('refused');
		if (outcome.status !== 'refused') return;
		expect(outcome.reason).toContain(REMOTE);
		expect(argv().some((line) => line.startsWith('git checkout'))).toBe(false);
	});

	it('refuses an unreadable state file without running anything past the reads', async () => {
		const home = makeHome();
		mkdirSync(installUpdateStateDir(INSTALL_ROOT, home), { recursive: true });
		writeFileSync(join(installUpdateStateDir(INSTALL_ROOT, home), 'state.json'), 'not json');
		const { run, argv } = scriptedRunner();

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('refused');
		if (outcome.status !== 'refused') return;
		expect(outcome.reason).toContain('unreadable');
		expect(argv()).toEqual(['git rev-parse HEAD', 'git status --porcelain']);
	});

	it('never throws when the runner rejects', async () => {
		const home = makeHome();
		const run = vi.fn<(command: UpdateCommand) => Promise<UpdateCommandResult>>(async () => {
			throw new Error('spawn ENOENT');
		});

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('refused');
		if (outcome.status !== 'refused') return;
		expect(outcome.reason).toContain('spawn ENOENT');
	});
});

describe('applyUpdateTarget — already current', () => {
	it('short-circuits with nothing installed and nothing built', async () => {
		const home = makeHome();
		const { run, argv } = scriptedRunner({
			[`git rev-parse --verify refs/remotes/${REMOTE}/${BRANCH}^{commit}`]: ok(HEAD),
			[`git merge-base --is-ancestor ${HEAD} refs/remotes/${REMOTE}/${BRANCH}`]: ok(''),
		});

		const outcome = await apply(home, run);

		expect(outcome).toEqual({ status: 'already-current', commit: HEAD });
		expect(argv().some((line) => line.startsWith('git checkout'))).toBe(false);
		expect(argv().some((line) => line.startsWith('npm'))).toBe(false);
	});
});

describe('applyUpdateTarget — the tracked branch', () => {
	it('records the branch read off an attached HEAD', async () => {
		const home = makeHome();
		const { run } = scriptedRunner();

		await apply(home, run);

		expect(readState(home)).toMatchObject({
			installRoot: INSTALL_ROOT,
			remote: REMOTE,
			trackedBranch: BRANCH,
		});
	});

	// git accepts a remote whose own name contains a slash, so the abbreviated
	// `<remote>/<branch>` form cannot be split — both halves have to come from git.
	it('keeps a remote name that itself contains a slash whole', async () => {
		const home = makeHome();
		const remote = 'team/origin';
		const { run, argv } = scriptedRunner({
			[UPSTREAM_ARGV]: ok(`${remote}\n${HEAD_REF}`),
			[`git rev-parse --verify refs/remotes/${remote}/${BRANCH}^{commit}`]: ok(TARGET_COMMIT),
		});

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('applied');
		expect(argv()).toContain(`git fetch ${remote}`);
		expect(argv()).toContain(
			`git merge-base --is-ancestor ${TARGET_COMMIT} refs/remotes/${remote}/${BRANCH}`,
		);
		expect(readState(home)).toMatchObject({ remote, trackedBranch: BRANCH });
	});

	it('treats a branch tracking a local sibling as having no remote', async () => {
		const home = makeHome();
		// `.` is git's name for this repository as an upstream — nothing to fetch from.
		const { run, argv } = scriptedRunner({ [UPSTREAM_ARGV]: ok(`.\n${HEAD_REF}`) });

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('refused');
		if (outcome.status !== 'refused') return;
		expect(outcome.reason).toContain('Check out the branch this install should follow');
		expect(argv().some((line) => line.startsWith('git fetch'))).toBe(false);
	});

	it('proceeds on a detached HEAD using the persisted remote and branch', async () => {
		const home = makeHome();
		writeStoredState(home, { lastKnownGood: 'c'.repeat(40) });
		const { run, argv } = scriptedRunner({
			'git symbolic-ref --quiet HEAD': fail('HEAD is detached'),
		});

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('applied');
		expect(argv()).toContain(`git fetch ${REMOTE}`);
		expect(argv()).toContain(
			`git merge-base --is-ancestor ${TARGET_COMMIT} refs/remotes/${REMOTE}/${BRANCH}`,
		);
	});

	it('refuses a detached HEAD with nothing persisted, naming the remedy', async () => {
		const home = makeHome();
		const { run, argv } = scriptedRunner({
			'git symbolic-ref --quiet HEAD': fail('HEAD is detached'),
		});

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('refused');
		if (outcome.status !== 'refused') return;
		expect(outcome.reason).toContain('Check out the branch this install should follow');
		expect(argv().some((line) => line.startsWith('git fetch'))).toBe(false);
	});
});

describe('applyUpdateTarget — the state file', () => {
	it('records the commit the install was on as the last known good, before the checkout', async () => {
		const home = makeHome();
		const { run } = scriptedRunner();

		await apply(home, run);

		expect(readState(home)).toEqual({
			installRoot: INSTALL_ROOT,
			remote: REMOTE,
			trackedBranch: BRANCH,
			lastKnownGood: HEAD,
			target: BRANCH,
			targetCommit: TARGET_COMMIT,
			appliedAt: '2026-02-01T00:00:00.000Z',
			// `lastKnownGood` stays on the build that was running: the new one is only
			// awaiting proof until a daemon on it handshakes (issue #934).
			pendingVerification: {
				commit: TARGET_COMMIT,
				previousCommit: HEAD,
				failedStarts: 0,
				startedAt: '2026-02-01T00:00:00.000Z',
			},
		});
	});

	it('lives under ~/.swarm/install-updates keyed by the install root', () => {
		const home = makeHome();

		const dir = installUpdateStateDir(INSTALL_ROOT, home);

		expect(dir.startsWith(join(home, '.swarm', 'install-updates'))).toBe(true);
		expect(dir).not.toContain(INSTALL_ROOT);
	});

	it('is not written at all when the target is refused', async () => {
		const home = makeHome();
		const { run } = scriptedRunner();

		await apply(home, run, 'https://evil.example/repo.git');

		expect(existsSync(join(installUpdateStateDir(INSTALL_ROOT, home), 'state.json'))).toBe(false);
	});
});

describe('applyUpdateTarget — failure and rollback', () => {
	it('rolls back a failed install and reports the stage', async () => {
		const home = makeHome();
		const { run, argv } = scriptedRunner({ 'npm ci': [fail('ERR! peer dep')] });

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('failed');
		if (outcome.status !== 'failed') return;
		expect(outcome.stage).toBe('install');
		expect(outcome.rolledBack).toBe(true);
		expect(outcome.previousCommit).toBe(HEAD);
		expect(outcome.outputTail).toContain('ERR! peer dep');
		expect(outcome.reason).toContain(INSTALL_ROOT);
		expect(argv().slice(-5)).toEqual([
			`git checkout --detach ${TARGET_COMMIT}`,
			'npm ci',
			`git checkout --detach ${HEAD}`,
			'npm ci',
			'npm run build',
		]);
		// The rollback target is what was recorded before the checkout, untouched.
		expect(readState(home)).toMatchObject({ lastKnownGood: HEAD });
	});

	it('rolls back a failed build and reports the stage', async () => {
		const home = makeHome();
		const { run, argv } = scriptedRunner({ 'npm run build': [fail('TS2322')] });

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('failed');
		if (outcome.status !== 'failed') return;
		expect(outcome.stage).toBe('build');
		expect(outcome.rolledBack).toBe(true);
		expect(argv().slice(-3)).toEqual([`git checkout --detach ${HEAD}`, 'npm ci', 'npm run build']);
		expect(readState(home)).toMatchObject({ lastKnownGood: HEAD });
	});

	it('reports a rollback that itself failed as the loud outcome', async () => {
		const home = makeHome();
		const { run } = scriptedRunner({
			'npm run build': fail('TS2322'),
			[`git checkout --detach ${HEAD}`]: fail('index.lock exists'),
		});

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('failed');
		if (outcome.status !== 'failed') return;
		expect(outcome.rolledBack).toBe(false);
		expect(outcome.reason).toContain(INSTALL_ROOT);
		expect(outcome.reason).toContain(HEAD);
	});

	it('does not reinstall when a failed checkout never moved HEAD', async () => {
		const home = makeHome();
		const { run, argv } = scriptedRunner({
			[`git checkout --detach ${TARGET_COMMIT}`]: fail('pathspec did not match'),
		});

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('failed');
		if (outcome.status !== 'failed') return;
		expect(outcome.stage).toBe('checkout');
		expect(outcome.rolledBack).toBe(true);
		expect(argv().some((line) => line.startsWith('npm'))).toBe(false);
	});

	it('bounds the captured output rather than folding it into the reason', async () => {
		const home = makeHome();
		const noise = 'x'.repeat(20_000);
		const { run } = scriptedRunner({
			'npm ci': { exitCode: 1, stdout: noise, stderr: '' },
		});

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('failed');
		if (outcome.status !== 'failed') return;
		expect(outcome.outputTail.length).toBeLessThanOrEqual(4_000);
		expect(outcome.reason).not.toContain(noise);
	});
});

/**
 * The record an applied build is judged on, and the three transitions on it
 * (issue #934). Every case drives the real state file in a temp home, because the
 * whole point of the record is that it survives the process that wrote it.
 */
describe('the pending verification', () => {
	const APPLIED_COMMIT = TARGET_COMMIT;
	const PENDING = {
		commit: APPLIED_COMMIT,
		previousCommit: HEAD,
		failedStarts: 0,
		startedAt: '2026-02-01T00:00:00.000Z',
	};

	/** A state file describing an install root that was updated and has not proved it yet. */
	function writePending(home: string, failedStarts = 0): void {
		writeStoredState(home, {
			lastKnownGood: HEAD,
			target: BRANCH,
			targetCommit: APPLIED_COMMIT,
			appliedAt: '2026-02-01T00:00:00.000Z',
			pendingVerification: { ...PENDING, failedStarts },
		});
	}

	const at = (home: string) => ({ installRoot: INSTALL_ROOT, homeDir: home });

	it('is not recorded when the apply failed and rolled back', async () => {
		const home = makeHome();
		const { run } = scriptedRunner({ 'npm run build': [fail('TS2322')] });

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('failed');
		expect(readState(home)).toMatchObject({ lastKnownGood: HEAD, pendingVerification: null });
	});

	it('is cleared by an update applied on top of it', async () => {
		const home = makeHome();
		writePending(home);
		const later = 'd'.repeat(40);
		const { run } = scriptedRunner({
			'git rev-parse HEAD': ok(APPLIED_COMMIT),
			[`git rev-parse --verify refs/remotes/${REMOTE}/${BRANCH}^{commit}`]: ok(later),
			[`git merge-base --is-ancestor ${later} refs/remotes/${REMOTE}/${BRANCH}`]: ok(''),
		});

		const outcome = await apply(home, run);

		expect(outcome.status).toBe('applied');
		expect(readState(home)).toMatchObject({
			lastKnownGood: APPLIED_COMMIT,
			pendingVerification: { commit: later, previousCommit: APPLIED_COMMIT, failedStarts: 0 },
		});
	});

	describe('recordFailedStart', () => {
		it('counts up across restarts, leaving the rest of the record alone', () => {
			const home = makeHome();
			writePending(home);

			expect(recordFailedStart(at(home))?.failedStarts).toBe(1);
			expect(recordFailedStart(at(home))?.failedStarts).toBe(2);

			expect(readState(home)).toMatchObject({
				lastKnownGood: HEAD,
				pendingVerification: { ...PENDING, failedStarts: 2 },
			});
		});

		it('counts nothing when no build is awaiting proof', () => {
			const home = makeHome();
			writeStoredState(home);

			expect(recordFailedStart(at(home))).toBeNull();
			expect(readState(home)).toMatchObject({ pendingVerification: null });
		});

		it('counts nothing when this install root has no record at all', () => {
			const home = makeHome();

			expect(recordFailedStart(at(home))).toBeNull();
			expect(existsSync(join(installUpdateStateDir(INSTALL_ROOT, home), 'state.json'))).toBe(false);
		});

		it('counts nothing when the record is unreadable', () => {
			const home = makeHome();
			mkdirSync(installUpdateStateDir(INSTALL_ROOT, home), { recursive: true });
			writeFileSync(join(installUpdateStateDir(INSTALL_ROOT, home), 'state.json'), 'not json');

			expect(recordFailedStart(at(home))).toBeNull();
		});
	});

	describe('recordSuccessfulHandshake', () => {
		it('promotes the build that handshaked and clears the record', () => {
			const home = makeHome();
			writePending(home, 2);

			expect(recordSuccessfulHandshake(at(home))).toBe(APPLIED_COMMIT);

			expect(readState(home)).toMatchObject({
				lastKnownGood: APPLIED_COMMIT,
				pendingVerification: null,
			});
		});

		it('is a no-op once there is nothing left to promote', () => {
			const home = makeHome();
			writePending(home);

			recordSuccessfulHandshake(at(home));
			expect(recordSuccessfulHandshake(at(home))).toBeNull();

			expect(readState(home)).toMatchObject({ lastKnownGood: APPLIED_COMMIT });
		});
	});

	describe('returnToLastKnownGood', () => {
		it('checks out, reinstalls and rebuilds the last known good build, then clears the record', async () => {
			const home = makeHome();
			writePending(home, 3);
			const { run, argv, calls } = scriptedRunner();

			const outcome = await returnToLastKnownGood({ ...at(home), run });

			expect(outcome).toEqual({
				status: 'returned',
				commit: HEAD,
				abandonedCommit: APPLIED_COMMIT,
			});
			expect(argv()).toEqual([`git checkout --detach ${HEAD}`, 'npm ci', 'npm run build']);
			expect(calls.every((call) => call.cwd === INSTALL_ROOT)).toBe(true);
			// Cleared, so the daemon the supervisor starts next counts nothing and — the
			// failure that matters — does not promote the build it just abandoned.
			expect(readState(home)).toMatchObject({
				lastKnownGood: HEAD,
				pendingVerification: null,
			});
		});

		it('runs nothing when no build is awaiting proof', async () => {
			const home = makeHome();
			writeStoredState(home);
			const { run, calls } = scriptedRunner();

			expect(await returnToLastKnownGood({ ...at(home), run })).toEqual({
				status: 'nothing-pending',
			});
			expect(calls).toHaveLength(0);
		});

		it('keeps the record when the return itself failed, and names the step', async () => {
			const home = makeHome();
			writePending(home, 3);
			const { run } = scriptedRunner({ 'npm ci': fail('ERR! ENOSPC') });

			const outcome = await returnToLastKnownGood({ ...at(home), run });

			expect(outcome.status).toBe('failed');
			if (outcome.status !== 'failed') return;
			expect(outcome.stage).toBe('install');
			expect(outcome.reason).toContain(INSTALL_ROOT);
			expect(outcome.outputTail).toContain('ERR! ENOSPC');
			// Kept: clearing it would send the next start back into the build that could
			// not start, with nothing left to notice that it had.
			expect(readState(home)).toMatchObject({ pendingVerification: { commit: APPLIED_COMMIT } });
		});
	});
});

/**
 * Several daemons on one install root (issue #935) — the control-plane host's real
 * shape. The peer daemons here are records on disk, since that is all one daemon can
 * ever see of another: `../worktree/install-lock.ts` is where those records are
 * written, and this is where the update's behaviour around them is pinned.
 */
describe('applyUpdateTarget — a shared install root', () => {
	const OUR_PID = 5001;
	const PEER_PID = 5002;
	const TEST_HOST = 'ada-laptop';
	const PEER_WORKER = '22222222-2222-4222-8222-222222222222';
	const NOW_ISO = '2026-02-01T00:00:00.000Z';

	/** Which pids the fake host considers alive — every case's second daemon, unless it says otherwise. */
	let live: Set<number>;

	beforeEach(() => {
		live = new Set([OUR_PID, PEER_PID]);
	});

	/** This process, on a machine whose other daemons are written by hand below. */
	function sharedHost(): Partial<ApplyUpdateTargetOptions> {
		return {
			host: {
				hostname: TEST_HOST,
				pid: OUR_PID,
				isPidLive: (pid: number) => live.has(pid),
			},
			// The wait is a real pause; every case here is about what happens after it.
			lockWaitMs: 0,
		};
	}

	function lockDir(home: string): string {
		return join(installUpdateStateDir(INSTALL_ROOT, home), 'update-lock');
	}

	/** A peer daemon holding the update lock. */
	function writePeerLock(home: string, overrides: Record<string, unknown> = {}): void {
		mkdirSync(lockDir(home), { recursive: true });
		writeFileSync(
			join(lockDir(home), 'owner.json'),
			JSON.stringify({
				installRoot: INSTALL_ROOT,
				pid: PEER_PID,
				hostname: TEST_HOST,
				workerId: PEER_WORKER,
				createdAt: NOW_ISO,
				refreshedAt: NOW_ISO,
				...overrides,
			}),
		);
	}

	/**
	 * A peer that is holding the update lock when this daemon arrives and has released
	 * it by the time it looks again — the sequence a follower actually meets, since the
	 * holder releases in a `finally` on every path.
	 *
	 * The release is hung off the liveness probe because that is the one injected call
	 * `acquireInstallLock` makes while it is deciding, and nothing else a test owns runs
	 * between two attempts. The probe still answers `true`, so the lock is *released*
	 * rather than reclaimed from a corpse — which is the case under test.
	 */
	function peerReleasesWhileWeWait(home: string): Partial<ApplyUpdateTargetOptions> {
		writePeerLock(home);
		return {
			host: {
				hostname: TEST_HOST,
				pid: OUR_PID,
				isPidLive: (pid: number) => {
					if (pid === PEER_PID) rmSync(lockDir(home), { recursive: true, force: true });
					return live.has(pid);
				},
			},
			// Long enough for one poll of the module's own interval, which is what the wait
			// costs here. The production default is measured in tens of minutes.
			lockWaitMs: 5_000,
		};
	}

	/** What a holder leaves behind once its apply succeeded: the target, proved or awaiting proof. */
	function writeLandedByPeer(home: string, pendingVerification: unknown): void {
		writeStoredState(home, {
			lastKnownGood: HEAD,
			target: BRANCH,
			targetCommit: TARGET_COMMIT,
			appliedAt: NOW_ISO,
			pendingVerification,
		});
	}

	/** A peer daemon running from the same install root. */
	function writePeerParticipant(home: string, overrides: Record<string, unknown> = {}): void {
		const dir = join(installUpdateStateDir(INSTALL_ROOT, home), 'participants');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${PEER_PID}.json`),
			JSON.stringify({
				installRoot: INSTALL_ROOT,
				pid: PEER_PID,
				hostname: TEST_HOST,
				workerId: PEER_WORKER,
				busy: false,
				startedAt: NOW_ISO,
				refreshedAt: NOW_ISO,
				...overrides,
			}),
		);
	}

	describe('two daemons asked at once', () => {
		it('refuses, naming the holder, while it has not landed the target yet', async () => {
			const home = makeHome();
			writePeerLock(home);
			const { run, argv } = scriptedRunner();

			const outcome = await apply(home, run, BRANCH, sharedHost());

			expect(outcome.status).toBe('refused');
			if (outcome.status !== 'refused') return;
			expect(outcome.reason).toContain(PEER_WORKER);
			// Nothing was fetched, let alone checked out: the holder owns the tree.
			expect(argv()).not.toContain(`git fetch ${REMOTE}`);
		});

		// The reading this used to answer `already-current` on proves nothing: `buildAt`
		// checks out *before* it installs, so HEAD reaches the target while `node_modules`
		// and `dist` are half-written. Now that `already-current` is a peer's licence to
		// restart (issue #973), the only honest answer from outside the lock is a refusal.
		it('refuses rather than reading a build the holder may be mid-way through', async () => {
			const home = makeHome();
			writePeerLock(home);
			const { run, argv } = scriptedRunner({ 'git rev-parse HEAD': ok(TARGET_COMMIT) });

			const outcome = await apply(home, run, BRANCH, sharedHost());

			expect(outcome.status).toBe('refused');
			if (outcome.status !== 'refused') return;
			expect(outcome.reason).toContain(PEER_WORKER);
			expect(argv()).not.toContain(`git fetch ${REMOTE}`);
		});

		it('waits for the holder, then adopts what it landed without fetching', async () => {
			const home = makeHome();
			writeLandedByPeer(home, {
				commit: TARGET_COMMIT,
				previousCommit: HEAD,
				failedStarts: 0,
				startedAt: NOW_ISO,
			});
			const { run, argv } = scriptedRunner({ 'git rev-parse HEAD': ok(TARGET_COMMIT) });

			const outcome = await apply(home, run, BRANCH, peerReleasesWhileWeWait(home));

			expect(outcome).toEqual({ status: 'already-current', commit: TARGET_COMMIT });
			// One machine, one fetch and one build: the holder's own already moved these
			// remote-tracking refs, and the tree it left is the one this daemon restarts onto.
			expect(argv()).not.toContain(`git fetch ${REMOTE}`);
			expect(argv()).not.toContain('npm ci');
			expect(argv()).not.toContain('npm run build');
		});

		// Equally good proof: the build was promoted to last known good before this daemon
		// got in, which is what a peer that already handshaked leaves behind.
		it('adopts a build the machine has already proved', async () => {
			const home = makeHome();
			writeLandedByPeer(home, null);
			writeStoredState(home, {
				lastKnownGood: TARGET_COMMIT,
				target: BRANCH,
				targetCommit: TARGET_COMMIT,
				appliedAt: NOW_ISO,
				pendingVerification: null,
			});
			const { run } = scriptedRunner({ 'git rev-parse HEAD': ok(TARGET_COMMIT) });

			const outcome = await apply(home, run, BRANCH, peerReleasesWhileWeWait(home));

			expect(outcome).toEqual({ status: 'already-current', commit: TARGET_COMMIT });
		});

		it('refuses when the daemon that was moving it did not land this target', async () => {
			const home = makeHome();
			// HEAD is left on the old commit: whatever that peer was doing, it was not this.
			const { run, argv } = scriptedRunner();

			const outcome = await apply(home, run, BRANCH, peerReleasesWhileWeWait(home));

			expect(outcome.status).toBe('refused');
			if (outcome.status !== 'refused') return;
			expect(outcome.reason).toContain(HEAD);
			expect(outcome.reason).toContain(BRANCH);
			// Re-running the same fetch and build behind a peer that just failed is how one
			// broken build becomes four.
			expect(argv()).not.toContain(`git fetch ${REMOTE}`);
			expect(argv()).not.toContain(`git checkout --detach ${TARGET_COMMIT}`);
			expect(argv()).not.toContain('npm ci');
		});

		// The half-written tree itself: `applying` is written with no pending verification
		// *before* the checkout, so HEAD reaches the target with `npm ci` still to run.
		it('refuses a target the install root reached but never finished building', async () => {
			const home = makeHome();
			writeLandedByPeer(home, null);
			const { run, argv } = scriptedRunner({ 'git rev-parse HEAD': ok(TARGET_COMMIT) });

			const outcome = await apply(home, run, BRANCH, peerReleasesWhileWeWait(home));

			expect(outcome.status).toBe('refused');
			expect(argv()).not.toContain('npm ci');
			expect(argv()).not.toContain('npm run build');
		});

		// A peer can land a whole apply between this daemon's first read and its lock, so
		// the pre-lock reading is never what the locked half acts on.
		it('re-reads HEAD under the lock rather than acting on the pre-lock reading', async () => {
			const home = makeHome();
			const { run, argv } = scriptedRunner({
				'git rev-parse HEAD': [ok(HEAD), ok(TARGET_COMMIT)],
			});

			const outcome = await apply(home, run, BRANCH, sharedHost());

			expect(outcome).toEqual({ status: 'already-current', commit: TARGET_COMMIT });
			expect(argv()).not.toContain('npm ci');
		});

		it('takes over a lock left behind by a daemon that is gone', async () => {
			const home = makeHome();
			writePeerLock(home);
			live.delete(PEER_PID);
			const { run } = scriptedRunner();

			const outcome = await apply(home, run, BRANCH, sharedHost());

			expect(outcome.status).toBe('applied');
		});

		it('releases the lock on the way out, whatever the outcome', async () => {
			const home = makeHome();

			const applied = await apply(home, scriptedRunner().run, BRANCH, sharedHost());
			expect(applied.status).toBe('applied');
			expect(existsSync(lockDir(home))).toBe(false);

			const fetchFailed = await apply(
				home,
				scriptedRunner({ [`git fetch ${REMOTE}`]: fail('no route to host') }).run,
				BRANCH,
				sharedHost(),
			);
			expect(fetchFailed.status).toBe('refused');
			expect(existsSync(lockDir(home))).toBe(false);

			const buildFailed = await apply(
				home,
				scriptedRunner({ 'npm run build': [fail('TS2322')] }).run,
				BRANCH,
				sharedHost(),
			);
			expect(buildFailed.status).toBe('failed');
			expect(existsSync(lockDir(home))).toBe(false);
		});
	});

	describe('a peer daemon mid-phase', () => {
		it('refuses before anything is checked out, naming the worker to drain', async () => {
			const home = makeHome();
			writePeerParticipant(home, { busy: true });
			const { run, argv } = scriptedRunner();

			const outcome = await apply(home, run, BRANCH, sharedHost());

			expect(outcome.status).toBe('refused');
			if (outcome.status !== 'refused') return;
			expect(outcome.reason).toContain(PEER_WORKER);
			expect(outcome.reason).toContain('Drain that worker');
			// The guard is about replacing code a peer is executing, and only these do that.
			// The fetch ahead of it writes remote-tracking refs and swaps nothing (issue #973).
			expect(argv()).not.toContain(`git checkout --detach ${TARGET_COMMIT}`);
			expect(argv()).not.toContain('npm ci');
			expect(argv()).not.toContain('npm run build');
		});

		// The whole of a peer's own update, and the reason the guard moved below the
		// short-circuit: this daemon writes nothing, so a busy peer is no reason to refuse it.
		it('lets a daemon that only needs to notice the machine is already there through', async () => {
			const home = makeHome();
			writePeerParticipant(home, { busy: true });
			const { run, argv } = scriptedRunner({ 'git rev-parse HEAD': ok(TARGET_COMMIT) });

			const outcome = await apply(home, run, BRANCH, sharedHost());

			expect(outcome).toEqual({ status: 'already-current', commit: TARGET_COMMIT });
			expect(argv()).not.toContain(`git checkout --detach ${TARGET_COMMIT}`);
		});

		it('proceeds past an idle peer', async () => {
			const home = makeHome();
			writePeerParticipant(home, { busy: false });
			const { run } = scriptedRunner();

			expect((await apply(home, run, BRANCH, sharedHost())).status).toBe('applied');
		});

		it('proceeds past a departed peer whose record still says it was busy', async () => {
			const home = makeHome();
			writePeerParticipant(home, { busy: true });
			live.delete(PEER_PID);
			const { run } = scriptedRunner();

			expect((await apply(home, run, BRANCH, sharedHost())).status).toBe('applied');
		});
	});

	describe('returning to the last known good build', () => {
		const PENDING = {
			commit: TARGET_COMMIT,
			previousCommit: HEAD,
			failedStarts: 3,
			startedAt: NOW_ISO,
		};

		function writePending(home: string): void {
			writeStoredState(home, {
				lastKnownGood: HEAD,
				target: BRANCH,
				targetCommit: TARGET_COMMIT,
				appliedAt: NOW_ISO,
				pendingVerification: PENDING,
			});
		}

		function returnOptions(home: string, run: CommandRunner) {
			return {
				installRoot: INSTALL_ROOT,
				homeDir: home,
				run,
				now: () => new Date(NOW_ISO),
				...sharedHost(),
			};
		}

		it('gives up rather than rebuilding under another daemon that is updating', async () => {
			const home = makeHome();
			writePending(home);
			writePeerLock(home);
			const { run, calls } = scriptedRunner();

			const outcome = await returnToLastKnownGood(returnOptions(home, run));

			expect(outcome.status).toBe('failed');
			if (outcome.status !== 'failed') return;
			expect(outcome.stage).toBe('lock');
			expect(outcome.reason).toContain(PEER_WORKER);
			expect(calls).toHaveLength(0);
			// Kept, so the start after this one returns instead of promoting a bad build.
			expect(readState(home)).toMatchObject({ pendingVerification: { commit: TARGET_COMMIT } });
		});

		it('returns anyway while a peer is mid-phase — a machine that cannot connect must recover', async () => {
			const home = makeHome();
			writePending(home);
			writePeerParticipant(home, { busy: true });
			const { run } = scriptedRunner();

			expect((await returnToLastKnownGood(returnOptions(home, run))).status).toBe('returned');
		});

		it('leaves a newer build a peer landed while it waited for the lock alone', async () => {
			const home = makeHome();
			writePending(home);
			writePeerLock(home);
			const NEWER = 'c'.repeat(40);
			const { run, calls } = scriptedRunner();

			// The peer finishing, made deterministic: the lock reads its holder's liveness
			// last, so its apply — a newer build, recorded and released — lands from inside
			// that answer. This daemon takes the lock a moment later holding a reading of
			// the install root that is no longer true of it.
			const outcome = await returnToLastKnownGood({
				...returnOptions(home, run),
				host: {
					hostname: TEST_HOST,
					pid: OUR_PID,
					isPidLive: (pid: number) => {
						if (pid === PEER_PID) {
							writeStoredState(home, {
								lastKnownGood: HEAD,
								target: BRANCH,
								targetCommit: NEWER,
								appliedAt: NOW_ISO,
								pendingVerification: {
									commit: NEWER,
									previousCommit: TARGET_COMMIT,
									failedStarts: 0,
									startedAt: NOW_ISO,
								},
							});
							rmSync(lockDir(home), { recursive: true, force: true });
							return false;
						}
						return live.has(pid);
					},
				},
			});

			// Nothing of the peer's is this daemon's to undo: it never ran the build now
			// being proved, so it neither checks the old commit back out...
			expect(outcome).toEqual({ status: 'nothing-pending' });
			expect(calls).toHaveLength(0);
			// ...nor erases the record that says the peer's build still needs proving.
			expect(readState(home)).toMatchObject({
				targetCommit: NEWER,
				pendingVerification: { commit: NEWER },
			});
		});
	});
});
