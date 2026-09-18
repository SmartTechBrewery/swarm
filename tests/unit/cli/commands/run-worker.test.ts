import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

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
import { daemonNodeArgs, run } from '@/cli/commands/run-worker.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
/** What the command derives from its invocation directory — the same canonicalization the cache keys on. */
const CWD = realpathSync(process.cwd());
const ORIGINAL_INIT_CWD = process.env.INIT_CWD;

describe('swarm run:worker', () => {
	let log: ReturnType<typeof vi.spyOn>;
	let error: ReturnType<typeof vi.spyOn>;
	let warn: ReturnType<typeof vi.spyOn>;
	/**
	 * `process.execve` really does replace the process, so it is stubbed for the whole
	 * suite — an unstubbed call here would end the test run by becoming a worker. The
	 * stub throws nothing and returns, which is the one thing the real call cannot do,
	 * so every test that wants the spawn path asserts it explicitly rather than
	 * relying on fall-through.
	 */
	let execve: MockInstance<(...args: unknown[]) => unknown>;
	let chdir: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		delete process.env.INIT_CWD;
		// Typed through a loose view of `process`: the real signature returns `never`, which
		// leaves nothing for `mockImplementation` to accept.
		execve = vi
			.spyOn(process as unknown as { execve: (...args: unknown[]) => unknown }, 'execve')
			.mockImplementation(() => undefined);
		chdir = vi.spyOn(process, 'chdir').mockImplementation(() => {});
		log = vi.spyOn(console, 'log').mockImplementation(() => {});
		error = vi.spyOn(console, 'error').mockImplementation(() => {});
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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

	afterEach(() => {
		vi.restoreAllMocks();
		if (ORIGINAL_INIT_CWD === undefined) delete process.env.INIT_CWD;
		else process.env.INIT_CWD = ORIGINAL_INIT_CWD;
	});

	/** Every line this command printed, on either stream. */
	function printed(): string[] {
		return [...log.mock.calls, ...error.mock.calls, ...warn.mock.calls].map(([line]) =>
			String(line),
		);
	}

	/** Run with `process.execve` absent, as a pre-Node-24 runtime or a non-POSIX host has it. */
	async function runWithoutExecve(argv: string[] = []): Promise<number> {
		const descriptor = Object.getOwnPropertyDescriptor(process, 'execve');
		Object.defineProperty(process, 'execve', { value: undefined, configurable: true });
		try {
			return await run(argv);
		} finally {
			if (descriptor) Object.defineProperty(process, 'execve', descriptor);
		}
	}

	// The whole reason this command exists in its current shape: the process a
	// supervisor started has to *be* the daemon, or `detectWorkerSupervision` reads
	// the machine as unsupervised and every fleet update skips it.
	it('replaces its own process with the daemon rather than spawning one', async () => {
		expect(await run([])).toBe(0);
		expect(readWorkerCredentialCache).toHaveBeenCalledWith(CWD);
		expect(chdir).toHaveBeenCalledWith(REPO_ROOT);
		expect(execve).toHaveBeenCalledWith(
			process.execPath,
			[process.execPath, ...daemonNodeArgs(REPO_ROOT)],
			expect.objectContaining({
				SWARM_WORKER_REPO_ROOT: CWD,
				SWARM_WORKER_CREDENTIAL: 'raw-credential-token',
			}),
		);
		expect(runCommand).not.toHaveBeenCalled();
	});

	// `XPC_SERVICE_NAME` is the other half of the macOS supervision read, and PATH/HOME
	// are what the daemon and the agent CLIs it spawns need, so the exec carries the
	// whole environment rather than only the two values this command resolved.
	it('carries the inherited environment through the replacement', async () => {
		process.env.XPC_SERVICE_NAME = 'pl.smarttechbrewery.swarm.worker.test';
		try {
			expect(await run([])).toBe(0);
			expect(execve).toHaveBeenCalledWith(
				process.execPath,
				expect.any(Array),
				expect.objectContaining({
					XPC_SERVICE_NAME: 'pl.smarttechbrewery.swarm.worker.test',
					PATH: process.env.PATH,
				}),
			);
		} finally {
			delete process.env.XPC_SERVICE_NAME;
		}
	});

	// The duplication `daemonNodeArgs` introduces, pinned: exec'ing `npm` would put npm
	// back between the supervisor and the daemon, so the script cannot simply be run.
	it('execs exactly what `npm run dev:worker` would have run', () => {
		const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
			scripts: Record<string, string>;
		};
		const script = pkg.scripts['dev:worker'] as string;
		expect(script.startsWith('node ')).toBe(true);
		const scriptArgs = script.slice('node '.length).split(' ');
		// The script's paths are relative to the checkout; ours are absolute for the
		// same files, which is the only difference allowed between the two.
		const asRelative = daemonNodeArgs(REPO_ROOT).map((arg) =>
			arg.replaceAll(`${REPO_ROOT}/`, '').replace(`${REPO_ROOT}`, '.'),
		);
		expect(asRelative).toEqual(scriptArgs);
	});

	it('falls back to spawning the daemon where the runtime has no execve', async () => {
		expect(await runWithoutExecve()).toBe(0);
		expect(runCommand).toHaveBeenCalledWith('npm', ['run', 'dev:worker'], {
			cwd: REPO_ROOT,
			env: { SWARM_WORKER_REPO_ROOT: CWD, SWARM_WORKER_CREDENTIAL: 'raw-credential-token' },
		});
	});

	// A worker that starts behind a needless extra process beats one that does not start.
	it('warns and spawns when the replacement itself fails', async () => {
		execve.mockImplementation(() => {
			throw new Error('execve not permitted here');
		});
		expect(await run([])).toBe(0);
		expect(printed().some((line) => line.includes('execve not permitted here'))).toBe(true);
		expect(runCommand).toHaveBeenCalledWith('npm', ['run', 'dev:worker'], {
			cwd: REPO_ROOT,
			env: { SWARM_WORKER_REPO_ROOT: CWD, SWARM_WORKER_CREDENTIAL: 'raw-credential-token' },
		});
	});

	it("uses npm's caller directory when it differs from the script cwd", async () => {
		const invocationDirectory = realpathSync('src');
		process.env.INIT_CWD = invocationDirectory;

		expect(await run([])).toBe(0);
		expect(readWorkerCredentialCache).toHaveBeenCalledWith(invocationDirectory);
		expect(execve).toHaveBeenCalledWith(
			process.execPath,
			expect.any(Array),
			expect.objectContaining({ SWARM_WORKER_REPO_ROOT: invocationDirectory }),
		);
	});

	// Only reachable on the fallback path — a successful replacement never returns.
	it("returns the daemon's own exit code when it had to spawn it", async () => {
		runCommand.mockResolvedValue(3);
		expect(await runWithoutExecve()).toBe(3);
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
		expect(execve).not.toHaveBeenCalled();
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
		expect(execve).not.toHaveBeenCalled();
	});

	it('prints usage for --help without starting anything', async () => {
		expect(await run(['--help'])).toBe(0);
		expect(log).toHaveBeenCalledWith(expect.stringContaining('run:worker'));
		expect(readWorkerCredentialCache).not.toHaveBeenCalled();
		expect(runCommand).not.toHaveBeenCalled();
		expect(execve).not.toHaveBeenCalled();
	});
});
