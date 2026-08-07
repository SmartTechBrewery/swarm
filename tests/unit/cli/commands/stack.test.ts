import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/cli/_shared/exec.js', () => ({ runCommand: vi.fn(async () => 0) }));
// The worker-readiness hint's only database touch (issue #552) — stubbed so the
// stack commands stay runnable without one, exactly as they are in real life.
vi.mock('@/db/client.js', () => ({ closeDb: vi.fn(async () => {}) }));
vi.mock('@/identity/worker-service.js', () => ({
	resolveWorkerByCredential: vi.fn(async () => undefined),
}));

import { runCommand } from '@/cli/_shared/exec.js';
import { run as logsRun } from '@/cli/commands/logs.js';
import { run as startRun } from '@/cli/commands/start.js';
import { run as statusRun } from '@/cli/commands/status.js';
import { run as stopRun } from '@/cli/commands/stop.js';
import { resolveWorkerByCredential } from '@/identity/worker-service.js';

const anyCwd = expect.objectContaining({ cwd: expect.any(String) });

/**
 * Silence the worker-readiness hint (its own suite below) by presenting a
 * credential that resolves to a registered worker — otherwise these cases would
 * report whatever `SWARM_WORKER_CREDENTIAL` the ambient environment happens to
 * carry.
 */
function withReadyWorker(): void {
	vi.stubEnv('SWARM_WORKER_CREDENTIAL', 'registered-credential');
	vi.mocked(resolveWorkerByCredential).mockResolvedValue({ id: 'w-local' } as never);
}

describe('swarm start', () => {
	beforeEach(() => {
		vi.mocked(runCommand).mockReset().mockResolvedValue(0);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		withReadyWorker();
	});

	it('waits for the stack, then applies pending database migrations', async () => {
		expect(await startRun([])).toBe(0);
		expect(runCommand).toHaveBeenNthCalledWith(
			1,
			'docker',
			['compose', 'up', '-d', '--wait'],
			anyCwd,
		);
		expect(runCommand).toHaveBeenNthCalledWith(2, 'npm', ['run', 'db:migrate'], anyCwd);
	});

	it('adds --build with the flag', async () => {
		await startRun(['--build']);
		expect(runCommand).toHaveBeenCalledWith(
			'docker',
			['compose', 'up', '-d', '--wait', '--build'],
			anyCwd,
		);
	});

	it('does not migrate when Docker Compose fails', async () => {
		vi.mocked(runCommand).mockResolvedValueOnce(1);
		expect(await startRun([])).toBe(1);
		expect(runCommand).toHaveBeenCalledTimes(1);
	});

	it('returns the migration failure when the schema cannot be updated', async () => {
		vi.mocked(runCommand).mockResolvedValueOnce(0).mockResolvedValueOnce(2);
		expect(await startRun([])).toBe(2);
	});
});

describe('swarm stop', () => {
	beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));

	it('runs `docker compose down`, preserving volumes by default', async () => {
		await stopRun([]);
		expect(runCommand).toHaveBeenCalledWith('docker', ['compose', 'down'], anyCwd);
	});

	it('adds --volumes with -v', async () => {
		await stopRun(['-v']);
		expect(runCommand).toHaveBeenCalledWith('docker', ['compose', 'down', '--volumes'], anyCwd);
	});
});

describe('swarm logs', () => {
	it('runs `docker compose logs`', async () => {
		await logsRun([]);
		expect(runCommand).toHaveBeenCalledWith('docker', ['compose', 'logs'], anyCwd);
	});

	it('supports --follow and a service name', async () => {
		await logsRun(['-f', 'router']);
		expect(runCommand).toHaveBeenCalledWith(
			'docker',
			['compose', 'logs', '--follow', 'router'],
			anyCwd,
		);
	});
});

describe('swarm status', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		withReadyWorker();
	});

	it('runs `docker compose ps` and reports a healthy router', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, status: 200 }) as Response),
		);
		expect(await statusRun([])).toBe(0);
		expect(runCommand).toHaveBeenCalledWith('docker', ['compose', 'ps'], anyCwd);
	});

	it('does not throw when the router is unreachable', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('ECONNREFUSED');
			}),
		);
		expect(await statusRun([])).toBe(0);
	});
});

describe('worker-readiness hint (issue #552)', () => {
	let logs: string[];
	let warnings: string[];

	beforeEach(() => {
		logs = [];
		warnings = [];
		vi.spyOn(console, 'log').mockImplementation((message) => {
			logs.push(String(message));
		});
		vi.spyOn(console, 'warn').mockImplementation((message) => {
			warnings.push(String(message));
		});
		vi.mocked(runCommand).mockReset().mockResolvedValue(0);
		vi.mocked(resolveWorkerByCredential).mockReset().mockResolvedValue(undefined);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, status: 200 }) as Response),
		);
	});

	it('tells `swarm start` which commands register this host as a worker', async () => {
		// Every deployment dispatches to a registered worker now, so an unset
		// credential means the phases queue up with nothing to run them.
		vi.stubEnv('SWARM_WORKER_CREDENTIAL', '');

		expect(await startRun([])).toBe(0);

		expect(warnings.join('\n')).toMatch(/SWARM_WORKER_CREDENTIAL is unset/);
		expect(logs.join('\n')).toContain('workers register');
		expect(logs.join('\n')).toContain('workers enroll');
		// Nothing to look up — the hint is reached without touching the database.
		expect(resolveWorkerByCredential).not.toHaveBeenCalled();
	});

	it('warns from `swarm status` when the credential names no registered worker', async () => {
		vi.stubEnv('SWARM_WORKER_CREDENTIAL', 'stale-credential');

		expect(await statusRun([])).toBe(0);

		expect(resolveWorkerByCredential).toHaveBeenCalledWith('stale-credential');
		expect(warnings.join('\n')).toMatch(/matches no registered worker/);
		expect(logs.join('\n')).toContain('workers register');
	});

	it('says nothing when the credential resolves to a registered worker', async () => {
		vi.stubEnv('SWARM_WORKER_CREDENTIAL', 'good-credential');
		vi.mocked(resolveWorkerByCredential).mockResolvedValue({ id: 'w-local' } as never);

		expect(await statusRun([])).toBe(0);

		expect(warnings.join('\n')).not.toMatch(/SWARM_WORKER_CREDENTIAL/);
		expect(logs.join('\n')).not.toContain('workers register');
	});

	it('stays silent rather than crying wolf when the lookup cannot be made', async () => {
		// No DATABASE_URL, or the stack is down: "unknown" is not "unregistered",
		// and the command's exit code still reports the stack rather than this.
		vi.stubEnv('SWARM_WORKER_CREDENTIAL', 'unverifiable');
		vi.mocked(resolveWorkerByCredential).mockRejectedValue(new Error('ECONNREFUSED'));

		expect(await statusRun([])).toBe(0);

		expect(warnings.join('\n')).not.toMatch(/SWARM_WORKER_CREDENTIAL/);
	});
});
