/**
 * The service-manager seam (issue #1323): which manager each platform gets, and the
 * launchd manager's delegation to `bin/swarm-worker-agent`.
 */

import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '@/cli/_shared/paths.js';
import {
	launchdInstallerPath,
	resolveServiceManager,
	serviceCommand,
} from '@/launcher/service-manager.js';

describe('resolveServiceManager', () => {
	it.each([
		['darwin', 'launchd'],
		['win32', 'Task Scheduler'],
	] as const)('gives %s %s', (platform, name) => {
		expect(resolveServiceManager(platform)?.name).toBe(name);
	});

	it('gives every other platform none', () => {
		expect(resolveServiceManager('linux')).toBeNull();
	});
});

describe('serviceCommand', () => {
	it('names swarm-worker agent on Windows and the LaunchAgent installer on macOS', () => {
		expect(serviceCommand('win32')).toBe('swarm-worker agent');
		expect(serviceCommand('darwin')).toMatch(/swarm-worker-agent$/);
	});
});

describe('the launchd manager', () => {
	it('installs through swarm-worker-agent install --profile <id>', async () => {
		const runCommand = vi.fn(async () => 0);
		const launchd = resolveServiceManager('darwin', { runCommand });

		expect(await launchd?.install('w-1')).toEqual({ kind: 'installed' });
		expect(launchdInstallerPath()).toBe(join(REPO_ROOT, 'bin', 'swarm-worker-agent'));
		expect(runCommand).toHaveBeenCalledExactlyOnceWith(launchdInstallerPath(), [
			'install',
			'--profile',
			'w-1',
		]);
	});

	it.each([
		['a non-zero exit', vi.fn(async () => 1), 'swarm-worker-agent install exited with code 1'],
		[
			'a spawn failure',
			vi.fn(async () => {
				throw new Error('`swarm-worker-agent` not found on PATH');
			}),
			'`swarm-worker-agent` not found on PATH',
		],
	])('reports %s as a failed install', async (_case, runCommand, reason) => {
		expect(await resolveServiceManager('darwin', { runCommand })?.install('w-1')).toEqual({
			kind: 'failed',
			reason,
		});
	});

	it('captures swarm-worker-agent status --profile <id> for swarm-worker status', async () => {
		const capture = vi.fn(async () => ({ code: 0, output: 'state = running' }));
		expect(await resolveServiceManager('darwin', { capture })?.status('w-1')).toEqual({
			output: 'state = running',
			installed: true,
		});
		expect(capture).toHaveBeenCalledWith(launchdInstallerPath(), ['status', '--profile', 'w-1']);
	});
});
