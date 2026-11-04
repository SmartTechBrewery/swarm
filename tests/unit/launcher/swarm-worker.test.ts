import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launcherVersion, run, USAGE } from '@/launcher/swarm-worker.js';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rootWith(packageJson: string | undefined): string {
	const dir = mkdtempSync(join(tmpdir(), 'swarm-worker-'));
	dirs.push(dir);
	if (packageJson !== undefined) writeFileSync(join(dir, 'package.json'), packageJson);
	return dir;
}

function capture() {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, stdout: (line: string) => out.push(line), stderr: (l: string) => err.push(l) };
}

describe('swarm-worker', () => {
	it.each([
		[['run', 'w-1']],
		[['runtimes']],
		[['run', 'w-1', '--help']],
	])('hands %j to the launcher unchanged, with its deps', async (argv) => {
		const launcher = vi.fn().mockResolvedValue(7);
		const io = capture();

		const status = await run(argv, {
			launcher,
			installRoot: '/nowhere',
			homeDir: '/home/op',
			stdout: io.stdout,
			stderr: io.stderr,
		});

		expect(status).toBe(7);
		expect(launcher).toHaveBeenCalledWith(argv, {
			homeDir: '/home/op',
			stdout: io.stdout,
			stderr: io.stderr,
		});
	});

	it('reaches the real launcher for runtimes', async () => {
		const home = rootWith(undefined);
		const io = capture();

		expect(await run(['runtimes'], { homeDir: home, stdout: io.stdout, stderr: io.stderr })).toBe(
			0,
		);
		expect(io.out).toEqual([
			`swarm-launcher: no runtimes installed under ${join(home, '.swarm/runtimes')}`,
		]);
	});

	it.each([
		['--version'],
		['version'],
		['-v'],
	])('prints the install root’s package version for %s', async (flag) => {
		const io = capture();
		const root = rootWith('{"name":"swarm-worker-launcher","version":"9.8.7"}');

		expect(await run([flag], { installRoot: root, stdout: io.stdout })).toBe(0);
		expect(io.out).toEqual(['9.8.7']);
	});

	it('prints unknown for a version it cannot read', () => {
		expect(launcherVersion(rootWith(undefined))).toBe('unknown');
		expect(launcherVersion(rootWith('not json'))).toBe('unknown');
		expect(launcherVersion(rootWith('{"version":3}'))).toBe('unknown');
	});

	it.each([
		[[]],
		[['help']],
		[['--help']],
		[['-h']],
	])('prints the usage for %j and succeeds', async (argv) => {
		const launcher = vi.fn();
		const io = capture();

		expect(await run(argv, { launcher, stdout: io.stdout, stderr: io.stderr })).toBe(0);
		expect(io.out).toEqual([USAGE]);
		expect(launcher).not.toHaveBeenCalled();
	});

	it('refuses an unknown command with the usage', async () => {
		const launcher = vi.fn();
		const io = capture();

		expect(await run(['upgrade'], { launcher, stdout: io.stdout, stderr: io.stderr })).toBe(1);
		expect(io.err).toEqual(['swarm-worker: unknown command: upgrade']);
		expect(io.out).toEqual([USAGE]);
		expect(launcher).not.toHaveBeenCalled();
	});

	it('names only the subcommands that exist', () => {
		for (const command of ['setup', 'login', 'status', 'migrate', 'run <workerId>', 'runtimes'])
			expect(USAGE).toContain(`swarm-worker ${command}`);
		expect(USAGE).not.toMatch(/swarm-worker upgrade\b/);
	});

	// Issue #1311.
	it.each([
		['setup', ['setup', '--control-plane-url', 'https://swarm.example.com']],
		['login', ['login', '--email', 'ada@example.com']],
		['status', ['status', 'w-1']],
		// Issue #1313.
		['migrate', ['migrate', '/work/api', '--yes']],
	] as const)('hands %s its own arguments, and nothing to the launcher', async (command, argv) => {
		const launcher = vi.fn();
		const handler = vi.fn().mockResolvedValue(3);

		expect(await run([...argv], { launcher, [command]: handler })).toBe(3);
		expect(handler).toHaveBeenCalledWith(argv.slice(1));
		expect(launcher).not.toHaveBeenCalled();
	});
});
