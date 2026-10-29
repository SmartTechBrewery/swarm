import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('@/cli/_shared/exec.js', () => ({ runCommand }));

import { REPO_ROOT } from '@/cli/_shared/paths.js';
import { installWorkerAutostart } from '@/cli/_shared/worker-autostart.js';

describe('installWorkerAutostart', () => {
	beforeEach(() => {
		runCommand.mockReset().mockResolvedValue(0);
	});

	it('hands the checkout to the packaged LaunchAgent installer on macOS', async () => {
		expect(await installWorkerAutostart('/work/api', 'darwin')).toEqual({ kind: 'installed' });
		expect(runCommand).toHaveBeenCalledExactlyOnceWith(
			join(REPO_ROOT, 'bin', 'swarm-worker-agent'),
			['install', '/work/api'],
		);
	});

	it('reports a non-zero installer exit as a failure', async () => {
		runCommand.mockResolvedValue(1);
		expect(await installWorkerAutostart('/work/api', 'darwin')).toEqual({
			kind: 'failed',
			reason: 'swarm-worker-agent install exited with code 1',
		});
	});

	it('reports a spawn failure as a failure rather than throwing', async () => {
		runCommand.mockRejectedValue(new Error('`swarm-worker-agent` not found on PATH'));
		expect(await installWorkerAutostart('/work/api', 'darwin')).toEqual({
			kind: 'failed',
			reason: '`swarm-worker-agent` not found on PATH',
		});
	});

	it('runs nothing on a platform with no installer yet', async () => {
		expect(await installWorkerAutostart('C:\\work\\api', 'win32')).toEqual({
			kind: 'unsupported',
			platform: 'win32',
		});
		expect(runCommand).not.toHaveBeenCalled();
	});
});
