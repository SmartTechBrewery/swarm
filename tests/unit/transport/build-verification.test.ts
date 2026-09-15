/**
 * Returning a machine to its last known good build (issue #934).
 *
 * The state file is a `mkdtemp` home and every subprocess runs through the injected
 * {@link CommandRunner}, so nothing here touches a real `~/.swarm`, a real install
 * root, or `process.exit`. What is under test is the daemon's *decisions* — when it
 * counts, when it promotes, and when it gives up — since the mechanism each of them
 * drives is covered by phase 1's own suite next door.
 *
 * The last block is the exception, and has to be: the guarantee that a start is
 * counted before the daemon's own module graph is evaluated is a property of a real
 * process, so it launches one. It still keeps to a temp `HOME`, and it stops two
 * starts short of the cap so the return — which rewrites a checkout — is never
 * reached.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { swarmInstallRoot } from '@/lib/build-identity.js';
import {
	type BuildVerificationOptions,
	createHandshakePromotion,
	returnAfterFatalHandshake,
	verifyStartupBuild,
} from '@/transport/build-verification.js';
import {
	WorkerCapabilityConflictError,
	WorkerSessionConflictError,
	WorkerTransportProtocolError,
	WorkerTransportTransientError,
} from '@/transport/worker-client.js';
import {
	type CommandRunner,
	InstallUpdateStateSchema,
	installUpdateStateDir,
	MAX_FAILED_STARTS,
	type UpdateCommand,
	type UpdateCommandResult,
} from '@/worker/self-update.js';

const INSTALL_ROOT = '/opt/swarm';
const GOOD = 'a'.repeat(40);
const APPLIED = 'b'.repeat(40);

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
	const home = mkdtempSync(join(tmpdir(), 'swarm-build-verification-'));
	homes.push(home);
	return home;
}

function statePath(home: string): string {
	return join(installUpdateStateDir(INSTALL_ROOT, home), 'state.json');
}

/** A state file for an install root that was updated `failedStarts` starts ago. */
function writeState(
	home: string,
	pending: { failedStarts: number; adoptingPeers?: number } | null,
): void {
	mkdirSync(installUpdateStateDir(INSTALL_ROOT, home), { recursive: true });
	writeFileSync(
		statePath(home),
		JSON.stringify({
			installRoot: INSTALL_ROOT,
			remote: 'origin',
			trackedBranch: 'main',
			lastKnownGood: GOOD,
			target: 'main',
			targetCommit: APPLIED,
			appliedAt: '2026-02-01T00:00:00.000Z',
			pendingVerification: pending && {
				commit: APPLIED,
				previousCommit: GOOD,
				failedStarts: pending.failedStarts,
				adoptingPeers: pending.adoptingPeers ?? 0,
				startedAt: '2026-02-01T00:00:00.000Z',
			},
		}),
	);
}

function readState(home: string) {
	return InstallUpdateStateSchema.parse(JSON.parse(readFileSync(statePath(home), 'utf8')));
}

interface Harness extends BuildVerificationOptions {
	exit: ReturnType<typeof vi.fn>;
	shutdown: ReturnType<typeof vi.fn>;
	logger: {
		info: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
	};
	argv: () => string[];
	/** `failedStarts` as it stood on disk when the first subprocess ran — `null` when none did. */
	countedBeforeFirstCommand: () => number | null;
}

/**
 * The options every case passes, with a runner that answers every command `ok` unless
 * `failing` names one to reject.
 */
function harness(home: string, failing?: string): Harness {
	const calls: UpdateCommand[] = [];
	let countedBeforeFirstCommand: number | null = null;
	const run: CommandRunner = async (command): Promise<UpdateCommandResult> => {
		if (calls.length === 0) {
			countedBeforeFirstCommand = readState(home).pendingVerification?.failedStarts ?? null;
		}
		calls.push(command);
		const argv = [command.command, ...command.args].join(' ');
		return argv === failing
			? { exitCode: 1, stdout: '', stderr: 'ERR! ENOSPC' }
			: { exitCode: 0, stdout: '', stderr: '' };
	};
	return {
		installRoot: INSTALL_ROOT,
		homeDir: home,
		run,
		exit: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		argv: () => calls.map((call) => [call.command, ...call.args].join(' ')),
		countedBeforeFirstCommand: () => countedBeforeFirstCommand,
	};
}

const RETURN_ARGV = [`git checkout --detach ${GOOD}`, 'npm ci', 'npm run build'];

describe('verifyStartupBuild', () => {
	it('counts nothing and runs nothing on a machine with no update awaiting proof', async () => {
		const home = makeHome();
		writeState(home, null);
		const options = harness(home);

		expect(await verifyStartupBuild(options)).toBe(false);
		expect(options.argv()).toEqual([]);
		expect(options.exit).not.toHaveBeenCalled();
		expect(readState(home).pendingVerification).toBeNull();
	});

	it('counts nothing on a machine that has never been updated', async () => {
		const home = makeHome();
		const options = harness(home);

		expect(await verifyStartupBuild(options)).toBe(false);
		expect(options.argv()).toEqual([]);
	});

	it('counts this start and lets the daemon carry on below the cap', async () => {
		const home = makeHome();
		writeState(home, { failedStarts: 0 });
		const options = harness(home);

		expect(await verifyStartupBuild(options)).toBe(false);

		expect(readState(home).pendingVerification).toMatchObject({ failedStarts: 1 });
		expect(options.argv()).toEqual([]);
		expect(options.exit).not.toHaveBeenCalled();
	});

	it('carries on until the last start below the cap', async () => {
		const home = makeHome();
		writeState(home, { failedStarts: MAX_FAILED_STARTS - 2 });

		expect(await verifyStartupBuild(harness(home))).toBe(false);
		expect(readState(home).pendingVerification).toMatchObject({
			failedStarts: MAX_FAILED_STARTS - 1,
		});
	});

	it('returns to the last known good build on the start that reaches the cap', async () => {
		const home = makeHome();
		writeState(home, { failedStarts: MAX_FAILED_STARTS - 1 });
		const options = harness(home);

		expect(await verifyStartupBuild(options)).toBe(true);

		expect(options.argv()).toEqual(RETURN_ARGV);
		// Exit 0, because this is a clean stop the supervisor should restart — on the
		// build that is now in the install root.
		expect(options.exit).toHaveBeenCalledWith(0);
		expect(readState(home)).toMatchObject({ lastKnownGood: GOOD, pendingVerification: null });
	});

	it('has the start on disk before it runs anything, so a build that dies here still counted', async () => {
		const home = makeHome();
		writeState(home, { failedStarts: MAX_FAILED_STARTS - 1 });
		const options = harness(home);

		await verifyStartupBuild(options);

		expect(options.countedBeforeFirstCommand()).toBe(MAX_FAILED_STARTS);
	});

	it('stays down loudly when the return itself fails, keeping the record', async () => {
		const home = makeHome();
		writeState(home, { failedStarts: MAX_FAILED_STARTS });
		const options = harness(home, 'npm ci');

		expect(await verifyStartupBuild(options)).toBe(true);

		expect(options.exit).toHaveBeenCalledWith(1);
		expect(options.logger.error).toHaveBeenCalled();
		expect(readState(home).pendingVerification).toMatchObject({ commit: APPLIED });
	});

	it('releases what the daemon holds before ending the process', async () => {
		const home = makeHome();
		writeState(home, { failedStarts: MAX_FAILED_STARTS });
		const options = harness(home);

		await verifyStartupBuild(options);

		expect(options.shutdown).toHaveBeenCalledTimes(1);
		expect(options.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
			options.exit.mock.invocationCallOrder[0],
		);
	});

	// The record is keyed on the install root, so on a shared one every peer's ordinary
	// restart lands on the same counter (issue #973). Three daemons coming up healthily
	// would otherwise spend a three-start budget between them and roll the machine back
	// off a build that was working.
	it('does not return the install root when the peers that adopted this build restart', async () => {
		const home = makeHome();
		// One applier plus three adopters: the applier's own restart is the first start,
		// and each adopter contributes one more.
		writeState(home, { failedStarts: 0, adoptingPeers: 3 });

		for (let start = 1; start <= 4; start += 1) {
			const options = harness(home);
			expect(await verifyStartupBuild(options)).toBe(false);
			expect(options.argv()).toEqual([]);
			expect(options.exit).not.toHaveBeenCalled();
			expect(readState(home).pendingVerification).toMatchObject({ failedStarts: start });
		}
	});

	// The guarantee the budget exists for, unchanged: a machine's worth of adopters buys
	// a start each and nothing more, so a build nothing can run is still abandoned.
	it('still returns the install root once the whole budget is spent', async () => {
		const home = makeHome();
		writeState(home, { failedStarts: MAX_FAILED_STARTS + 2, adoptingPeers: 3 });
		const options = harness(home);

		expect(await verifyStartupBuild(options)).toBe(true);
		expect(options.argv()).toEqual(RETURN_ARGV);
		expect(options.exit).toHaveBeenCalledWith(0);
	});

	// Nobody adopted, so the budget is the constant it always was — one daemon failing
	// three starts in a row returns the install root even while peers are running.
	it('returns on the third failed start of a machine no peer adopted from', async () => {
		const home = makeHome();
		writeState(home, { failedStarts: MAX_FAILED_STARTS - 1, adoptingPeers: 0 });
		const options = harness(home);

		expect(await verifyStartupBuild(options)).toBe(true);
		expect(options.argv()).toEqual(RETURN_ARGV);
	});

	it('honours a cap of its own', async () => {
		const home = makeHome();
		writeState(home, { failedStarts: 0 });
		const options = { ...harness(home), maxFailedStarts: 1 };

		expect(await verifyStartupBuild(options)).toBe(true);
		expect(options.argv()).toEqual(RETURN_ARGV);
	});
});

describe('createHandshakePromotion', () => {
	it('promotes the build on the first session of the process', () => {
		const home = makeHome();
		writeState(home, { failedStarts: 2 });
		const options = harness(home);

		createHandshakePromotion(options)();

		expect(readState(home)).toMatchObject({ lastKnownGood: APPLIED, pendingVerification: null });
	});

	it('does nothing on the reconnects after it', () => {
		const home = makeHome();
		writeState(home, { failedStarts: 0 });
		const promote = createHandshakePromotion(harness(home));

		promote();
		// A second update applied and re-pending would be promoted by a *later* process,
		// never by this one's reconnect — the record is proof about the build in memory.
		writeState(home, { failedStarts: 1 });
		promote();

		expect(readState(home).pendingVerification).toMatchObject({ failedStarts: 1 });
	});
});

describe('returnAfterFatalHandshake', () => {
	const fatal = [
		['a protocol rejection', new WorkerTransportProtocolError()],
		['a capability rejection', new WorkerCapabilityConflictError(['claude'])],
	] as const;

	for (const [what, err] of fatal) {
		it(`returns to the last known good build on ${what}`, async () => {
			const home = makeHome();
			writeState(home, { failedStarts: 1 });
			const options = harness(home);

			expect(await returnAfterFatalHandshake(err, options)).toBe(true);

			expect(options.argv()).toEqual(RETURN_ARGV);
			expect(options.exit).toHaveBeenCalledWith(0);
			expect(readState(home)).toMatchObject({ lastKnownGood: GOOD, pendingVerification: null });
		});
	}

	it('does not wait the counter out', async () => {
		const home = makeHome();
		writeState(home, { failedStarts: 0 });
		const options = harness(home);

		expect(await returnAfterFatalHandshake(new WorkerTransportProtocolError(), options)).toBe(true);
		expect(options.argv()).toEqual(RETURN_ARGV);
	});

	it('leaves a transient failure to the reconnect loop', async () => {
		const home = makeHome();
		writeState(home, { failedStarts: 1 });
		const options = harness(home);

		expect(await returnAfterFatalHandshake(new WorkerTransportTransientError('503'), options)).toBe(
			false,
		);
		expect(options.argv()).toEqual([]);
	});

	it('leaves a session conflict alone — that is about the other daemon, not this build', async () => {
		const home = makeHome();
		writeState(home, { failedStarts: 1 });
		const options = harness(home);

		expect(await returnAfterFatalHandshake(new WorkerSessionConflictError(), options)).toBe(false);
		expect(options.argv()).toEqual([]);
	});

	it('does nothing when no build is awaiting proof', async () => {
		const home = makeHome();
		writeState(home, null);
		const options = harness(home);

		expect(await returnAfterFatalHandshake(new WorkerTransportProtocolError(), options)).toBe(
			false,
		);
		expect(options.argv()).toEqual([]);
		expect(options.exit).not.toHaveBeenCalled();
	});
});

/**
 * The one property that cannot be asserted by calling anything: the count is only
 * worth having if it is durable before *any* of the daemon's code — its static
 * imports included — has been evaluated. ESM runs a module's imports before its own
 * body, so a guard sitting at the top of the daemon's module runs last, not first,
 * and a build that throws at import time would never be counted at all. The property
 * therefore belongs to `connect-entry.ts`'s import list and to the process it starts,
 * and both are checked here.
 */
describe('the daemon entrypoint', () => {
	const REPO_ROOT = swarmInstallRoot();
	const ENTRY = join(REPO_ROOT, 'src/transport/connect-entry.ts');
	const POISON = join(REPO_ROOT, 'tests/fixtures/poison-worker-main/register.mjs');

	/** The entrypoint's state file, which is keyed on the *real* install root. */
	function installRootStatePath(home: string): string {
		return join(installUpdateStateDir(REPO_ROOT, home), 'state.json');
	}

	/**
	 * A record awaiting proof for this checkout, so a launched entrypoint has something
	 * to count against. `lastKnownGood` stays the unreachable `GOOD` sha on purpose: no
	 * launch here may reach {@link MAX_FAILED_STARTS}, but if one ever did, the return's
	 * first step is `git checkout --detach <that sha>` in this very checkout — and a sha
	 * no object matches fails before anything is touched.
	 */
	function writeInstallRootState(home: string, failedStarts: number): void {
		mkdirSync(installUpdateStateDir(REPO_ROOT, home), { recursive: true });
		writeFileSync(
			installRootStatePath(home),
			JSON.stringify({
				installRoot: REPO_ROOT,
				remote: 'origin',
				trackedBranch: 'main',
				lastKnownGood: GOOD,
				target: 'main',
				targetCommit: APPLIED,
				appliedAt: '2026-02-01T00:00:00.000Z',
				pendingVerification: {
					commit: APPLIED,
					previousCommit: GOOD,
					failedStarts,
					startedAt: '2026-02-01T00:00:00.000Z',
				},
			}),
		);
	}

	function countedStarts(home: string): number | undefined {
		const state = InstallUpdateStateSchema.parse(
			JSON.parse(readFileSync(installRootStatePath(home), 'utf8')),
		);
		return state.pendingVerification?.failedStarts;
	}

	/**
	 * Start the real entrypoint the way a supervisor does, with `HOME` and the log file
	 * pointed at a temp directory and the daemon's own two required variables stripped —
	 * so a launch that gets past the bootstrap dies on a missing credential instead of
	 * connecting to whatever the developer's environment names.
	 */
	function launch(home: string, options: { poison?: boolean } = {}) {
		const args = ['--import', 'tsx/esm'];
		if (options.poison) args.push('--import', pathToFileURL(POISON).href);
		args.push(ENTRY);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: home,
			SWARM_LOG_FILE: join(home, 'worker.log'),
			// `spawn` drops an undefined value rather than passing the string "undefined",
			// which is what makes these two genuinely absent in the child.
			SWARM_WORKER_CREDENTIAL: undefined,
			SWARM_CONTROL_PLANE_URL: undefined,
		};
		const result = spawnSync(process.execPath, args, {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			env,
			timeout: 60_000,
		});
		return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
	}

	it('statically imports only what counts a start, and reaches the daemon dynamically', () => {
		const source = readFileSync(ENTRY, 'utf8');

		const staticImports = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';$/gm)].map(
			(match) => match[1],
		);
		// Node builtins and `zod` are all that lies below these four. Adding anything the
		// daemon needs but the counter does not re-opens the hole this file documents.
		expect(staticImports.sort()).toEqual([
			'../lib/env.js',
			'../lib/errors.js',
			'../lib/logger.js',
			'./build-verification.js',
		]);

		const counted = source.indexOf('await verifyStartupBuild(');
		const loaded = source.indexOf("await import('./worker-main.js')");
		expect(counted).toBeGreaterThan(-1);
		expect(loaded).toBeGreaterThan(-1);
		expect(counted).toBeLessThan(loaded);
	});

	it('counts a start whose daemon throws while ESM is still loading it, and one that runs', {
		timeout: 120_000,
	}, () => {
		const home = makeHome();
		writeInstallRootState(home, 0);

		// The blocker case: this build's daemon module cannot even be evaluated. The
		// process still ends with the start on disk, so the supervisor's next restart
		// is the second of three rather than another uncounted one.
		const died = launch(home, { poison: true });
		expect(died.status).toBe(1);
		expect(died.output).toContain('poisoned worker-main');
		expect(countedStarts(home)).toBe(1);

		// And the ordinary path still reaches the daemon: with the module loadable, the
		// process gets all the way into `main()` — far enough to miss its credential —
		// which is what proves the dynamic import actually resolves.
		const ran = launch(home);
		expect(ran.status).toBe(1);
		expect(ran.output).toContain('Missing required environment variable: SWARM_WORKER_CREDENTIAL');
		expect(countedStarts(home)).toBe(2);
		// Neither launch may reach the cap: the third is the one that rewrites a checkout.
		expect(MAX_FAILED_STARTS).toBeGreaterThan(2);
	});
});
