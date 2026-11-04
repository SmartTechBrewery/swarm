import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	isLauncherPackage,
	launcherCommand,
	swarmCommand,
	workerAgentCommand,
	workerDashboardUrl,
} from '@/cli/_shared/installation-command.js';

/**
 * Two fake installations, each with a `bin/`, and a synthetic PATH directory
 * holding the symlinks `npm link` would leave — so nothing here depends on the
 * real checkout or the developer's own PATH.
 */
describe('installation command', () => {
	let root: string;
	let mine: string;
	let other: string;
	let pathDir: string;

	function installation(dir: string): string {
		mkdirSync(join(dir, 'bin'), { recursive: true });
		for (const file of ['swarm.js', 'swarm-worker-agent', 'swarm-launcher.js']) {
			writeFileSync(join(dir, 'bin', file), '#!/bin/sh\n');
			chmodSync(join(dir, 'bin', file), 0o755);
		}
		return dir;
	}

	function link(name: string, target: string): void {
		symlinkSync(target, join(pathDir, name));
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'swarm-installation-command-'));
		mine = installation(join(root, 'swarm-two'));
		other = installation(join(root, 'swarm'));
		pathDir = join(root, 'path-bin');
		mkdirSync(pathDir);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it('names the bare commands when PATH resolves to this installation', () => {
		link('swarm', join(mine, 'bin', 'swarm.js'));
		link('swarm-worker-agent', join(mine, 'bin', 'swarm-worker-agent'));
		expect(swarmCommand({ PATH: pathDir }, mine)).toBe('swarm');
		expect(workerAgentCommand({ PATH: pathDir }, mine)).toBe('swarm-worker-agent');
	});

	// Issue #1296: a profile worker's start command is named the same way.
	it('names swarm-launcher bare only when PATH resolves to this installation', () => {
		expect(launcherCommand({ PATH: pathDir }, mine)).toBe(
			`node ${join(mine, 'bin', 'swarm-launcher.js')}`,
		);
		link('swarm-launcher', join(other, 'bin', 'swarm-launcher.js'));
		expect(launcherCommand({ PATH: pathDir }, mine)).toBe(
			`node ${join(mine, 'bin', 'swarm-launcher.js')}`,
		);
		expect(launcherCommand({ PATH: pathDir }, other)).toBe('swarm-launcher');
	});

	// Issue #1311: the launcher package ships `swarm-worker` and no `swarm-launcher`,
	// and its `run <worker-id>` is the same command.
	it('names swarm-worker for a launcher package, which has no swarm-launcher', () => {
		const pkg = join(root, 'swarm-worker-launcher');
		mkdirSync(join(pkg, 'bin'), { recursive: true });
		writeFileSync(join(pkg, 'bin', 'swarm-worker.js'), '#!/bin/sh\n');
		chmodSync(join(pkg, 'bin', 'swarm-worker.js'), 0o755);
		expect(launcherCommand({ PATH: pathDir }, pkg)).toBe(
			`node ${join(pkg, 'bin', 'swarm-worker.js')}`,
		);
		link('swarm-worker', join(pkg, 'bin', 'swarm-worker.js'));
		expect(launcherCommand({ PATH: pathDir }, pkg)).toBe('swarm-worker');
	});

	// Issue #1311: the launcher package ships no `bin/swarm.js`, so naming one under
	// its root would print a command that fails with MODULE_NOT_FOUND.
	it('never names a bin/swarm.js the launcher package does not ship', () => {
		const pkg = join(root, 'swarm-worker-launcher');
		mkdirSync(join(pkg, 'bin'), { recursive: true });
		writeFileSync(join(pkg, 'bin', 'swarm-worker.js'), '#!/bin/sh\n');
		expect(isLauncherPackage(pkg)).toBe(true);
		expect(isLauncherPackage(mine)).toBe(false);
		expect(swarmCommand({ PATH: pathDir }, pkg)).toBe('swarm');
		expect(swarmCommand({}, pkg)).not.toContain(join(pkg, 'bin', 'swarm.js'));
	});

	it("names a worker's page on the installation's dashboard", () => {
		expect(workerDashboardUrl('https://SWARM.example.com/', 'w 1')).toBe(
			'https://swarm.example.com/workers/w%201',
		);
	});

	it('follows a symlink chain the way npm link leaves one', () => {
		const global = join(root, 'global', 'node_modules');
		mkdirSync(global, { recursive: true });
		symlinkSync(mine, join(global, 'swarm'));
		link('swarm', join(global, 'swarm', 'bin', 'swarm.js'));
		expect(swarmCommand({ PATH: pathDir }, mine)).toBe('swarm');
	});

	it('names the absolute form when PATH resolves to another installation', () => {
		link('swarm', join(other, 'bin', 'swarm.js'));
		link('swarm-worker-agent', join(other, 'bin', 'swarm-worker-agent'));
		expect(swarmCommand({ PATH: pathDir }, mine)).toBe(`node ${join(mine, 'bin', 'swarm.js')}`);
		expect(workerAgentCommand({ PATH: pathDir }, mine)).toBe(
			join(mine, 'bin', 'swarm-worker-agent'),
		);
	});

	it('names the absolute form when nothing on PATH is called swarm', () => {
		expect(swarmCommand({ PATH: pathDir }, mine)).toBe(`node ${join(mine, 'bin', 'swarm.js')}`);
		expect(swarmCommand({}, mine)).toBe(`node ${join(mine, 'bin', 'swarm.js')}`);
	});

	it('names the absolute form, without throwing, for a broken symlink', () => {
		link('swarm', join(root, 'gone', 'bin', 'swarm.js'));
		expect(swarmCommand({ PATH: pathDir }, mine)).toBe(`node ${join(mine, 'bin', 'swarm.js')}`);
	});

	it('names the absolute form, without throwing, when this installation has no bin/', () => {
		link('swarm', join(other, 'bin', 'swarm.js'));
		const missing = join(root, 'missing');
		expect(swarmCommand({ PATH: pathDir }, missing)).toBe(
			`node ${join(missing, 'bin', 'swarm.js')}`,
		);
	});

	it('quotes an install root a shell would split', () => {
		const spaced = installation(join(root, "Ada's code", 'swarm two'));
		expect(swarmCommand({ PATH: pathDir }, spaced)).toBe(
			`node '${join(root, "Ada'\\''s code", 'swarm two', 'bin', 'swarm.js')}'`,
		);
	});
});
