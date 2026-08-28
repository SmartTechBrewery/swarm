import { realpathSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }));
const { readWorkerCredentialCache, workerCredentialCachePath } = vi.hoisted(() => ({
	readWorkerCredentialCache: vi.fn(),
	workerCredentialCachePath: vi.fn(),
}));

vi.mock('@/cli/_shared/exec.js', () => ({ runCommand }));
vi.mock('@/cli/_shared/worker-credential-cache.js', () => ({
	readWorkerCredentialCache,
	workerCredentialCachePath,
}));

import { REPO_ROOT } from '@/cli/_shared/paths.js';
import { run } from '@/cli/commands/run-worker.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
/** What the command derives from `process.cwd()` — the same canonicalization the cache keys on. */
const CWD = realpathSync(process.cwd());

describe('swarm run:worker', () => {
	let log: ReturnType<typeof vi.spyOn>;
	let error: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		log = vi.spyOn(console, 'log').mockImplementation(() => {});
		error = vi.spyOn(console, 'error').mockImplementation(() => {});
		runCommand.mockReset().mockResolvedValue(0);
		readWorkerCredentialCache.mockReset().mockReturnValue({
			workerId: WORKER_ID,
			credential: 'raw-credential-token',
			repoRoot: CWD,
			registeredAt: new Date().toISOString(),
		});
		workerCredentialCachePath
			.mockReset()
			.mockReturnValue('/home/ada/.swarm/worker-credentials/deadbeef/credential.json');
	});

	/** Every line this command printed, on either stream. */
	function printed(): string[] {
		return [...log.mock.calls, ...error.mock.calls].map(([line]) => String(line));
	}

	it('starts the daemon for this checkout with the cached credential in its environment', async () => {
		expect(await run([])).toBe(0);
		expect(readWorkerCredentialCache).toHaveBeenCalledWith(CWD);
		expect(runCommand).toHaveBeenCalledWith('npm', ['run', 'dev:worker'], {
			cwd: REPO_ROOT,
			env: { SWARM_WORKER_REPO_ROOT: CWD, SWARM_WORKER_CREDENTIAL: 'raw-credential-token' },
		});
	});

	it("returns the daemon's own exit code", async () => {
		runCommand.mockResolvedValue(3);
		expect(await run([])).toBe(3);
	});

	// The whole point of the cache: the operator never sees or types the credential.
	it('never prints the credential', async () => {
		expect(await run([])).toBe(0);
		expect(printed().some((line) => line.includes('raw-credential-token'))).toBe(false);
		// It does name the worker and the checkout, which is what an operator can act on.
		expect(printed().some((line) => line.includes(WORKER_ID) && line.includes(CWD))).toBe(true);
	});

	it('refuses actionably when no worker is registered for this checkout', async () => {
		readWorkerCredentialCache.mockReturnValue(null);
		expect(await run([])).toBe(1);
		expect(error).toHaveBeenCalledWith(expect.stringContaining('no worker registered'));
		expect(printed().some((line) => line.includes(CWD))).toBe(true);
		expect(printed().some((line) => line.includes('swarm workers register'))).toBe(true);
		expect(printed().some((line) => line.includes('npm run dev:worker'))).toBe(true);
		expect(runCommand).not.toHaveBeenCalled();
	});

	it('reports an unreadable cache entry distinctly, naming the file', async () => {
		readWorkerCredentialCache.mockReturnValue(undefined);
		expect(await run([])).toBe(1);
		expect(error).toHaveBeenCalledWith(expect.stringContaining('could not be read'));
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('/home/ada/.swarm/worker-credentials/deadbeef/credential.json'),
		);
		expect(error).not.toHaveBeenCalledWith(expect.stringContaining('no worker registered'));
		expect(runCommand).not.toHaveBeenCalled();
	});

	it('prints usage for --help without starting anything', async () => {
		expect(await run(['--help'])).toBe(0);
		expect(log).toHaveBeenCalledWith(expect.stringContaining('run:worker'));
		expect(readWorkerCredentialCache).not.toHaveBeenCalled();
		expect(runCommand).not.toHaveBeenCalled();
	});
});
