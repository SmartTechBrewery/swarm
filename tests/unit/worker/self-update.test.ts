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
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	applyUpdateTarget,
	type CommandRunner,
	InstallUpdateStateSchema,
	installUpdateStateDir,
	type UpdateCommand,
	type UpdateCommandResult,
} from '@/worker/self-update.js';

const INSTALL_ROOT = '/opt/swarm';
const REMOTE = 'origin';
const BRANCH = 'main';
const HEAD = 'a'.repeat(40);
const TARGET_COMMIT = 'b'.repeat(40);

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
		'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}': ok(`${REMOTE}/${BRANCH}`),
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
): ReturnType<typeof applyUpdateTarget> {
	return applyUpdateTarget({
		target,
		installRoot: INSTALL_ROOT,
		homeDir: home,
		run,
		now: () => new Date('2026-02-01T00:00:00.000Z'),
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

	it('proceeds on a detached HEAD using the persisted remote and branch', async () => {
		const home = makeHome();
		writeStoredState(home, { lastKnownGood: 'c'.repeat(40) });
		const { run, argv } = scriptedRunner({
			'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}': fail('HEAD is detached'),
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
			'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}': fail('HEAD is detached'),
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
