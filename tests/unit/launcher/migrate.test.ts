/**
 * `swarm-worker migrate` (issue #1313), driven with fakes for everything past this
 * process: the runtime manifest and the credential proof through an injected
 * `fetch`, plists through an injected reader, the clone's agent script and the
 * profile installer through injected runners. The credential cache, the profile
 * and the clone are real files under a temporary HOME, so what is (and is not) left
 * on disk is read back rather than assumed.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	workerCredentialCachePath,
	writeWorkerCredentialCache,
} from '@/cli/_shared/worker-credential-cache.js';
import { cloneAgentControlPlaneUrl, listCloneAgents } from '@/launcher/clone-agent.js';
import { type MigrateDeps, runMigrate } from '@/launcher/migrate.js';
import type { PromptIo } from '@/launcher/operator-prompts.js';
import {
	readWorkerProfile,
	workerProfilePath,
	writeWorkerProfile,
} from '@/launcher/worker-profile.js';
import { checkoutStateDir } from '@/worktree/checkout-key.js';

// `os.homedir()` does not follow `process.env.HOME` inside a worker thread, and the
// reused helpers resolve `~` through it — so it is pointed at the test's own home.
const fakeHome = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:os')>()),
	homedir: () => {
		if (!fakeHome.dir) throw new Error('no test home directory is set');
		return fakeHome.dir;
	},
}));

const CONTROL_PLANE = 'https://swarm.example.com';
const CREDENTIAL = 'raw-worker-credential-value';
const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const LABEL = 'pl.smarttechbrewery.swarm.worker.api.abcd1234';
const ARTIFACT = 'swarm-worker-runtime-2.0.0.tar.gz';

const MANIFEST = {
	available: true,
	version: '2.0.0',
	commit: 'abcdef1234567',
	artifact: {
		name: ARTIFACT,
		url: `/worker/runtime/artifacts/${ARTIFACT}`,
		size: 10,
		sha256: 'a'.repeat(64),
	},
	signature: { format: 'minisign', minisig: 'sig' },
};

let home: string;
let checkout: string;
let extra: string;
let clone: string;
let launcherRoot: string;
let plists: Map<string, unknown>;

function writePlist(label: string, plist: unknown): void {
	const dir = join(home, 'Library', 'LaunchAgents');
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${label}.plist`);
	writeFileSync(path, '<plist/>');
	plists.set(path, plist);
}

function cloneAgentPlist(workingDirectory: string, env: Record<string, string> = {}) {
	return {
		Label: LABEL,
		ProgramArguments: ['/usr/local/bin/node', join(clone, 'bin', 'swarm.js'), 'run:worker'],
		WorkingDirectory: workingDirectory,
		EnvironmentVariables: { PATH: '/usr/bin', ...env },
	};
}

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-worker-migrate-home-')));
	checkout = join(home, 'work', 'api');
	extra = join(home, 'work', 'api-2');
	clone = join(home, 'swarm');
	launcherRoot = join(home, '.swarm', 'launcher');
	for (const dir of [checkout, extra, join(clone, 'bin'), launcherRoot])
		mkdirSync(dir, { recursive: true });
	writeFileSync(join(clone, 'bin', 'swarm.js'), '');
	writeFileSync(join(clone, '.env'), `SWARM_CONTROL_PLANE_URL=${CONTROL_PLANE}/\n`);
	writeWorkerCredentialCache({
		repoRoot: checkout,
		workerId: WORKER_ID,
		credential: CREDENTIAL,
		extraRepoRoots: [extra],
		homeDir: home,
	});
	plists = new Map();
	writePlist(LABEL, cloneAgentPlist(checkout));
	fakeHome.dir = home;
	for (const stream of ['log', 'warn', 'error'] as const)
		vi.spyOn(console, stream).mockImplementation(() => {});
});

afterEach(() => {
	fakeHome.dir = '';
	vi.restoreAllMocks();
	rmSync(home, { recursive: true, force: true });
});

function printed(): string {
	return (['log', 'warn', 'error'] as const)
		.flatMap((stream) => vi.mocked(console[stream]).mock.calls.flat())
		.join('\n');
}

interface Requests {
	urls: string[];
	authorizations: (string | undefined)[];
}

/** The manifest, and the artifact `HEAD` answering `artifactStatus`. */
function fakeFetch(artifactStatus = 200, manifest: unknown = MANIFEST) {
	const requests: Requests = { urls: [], authorizations: [] };
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		requests.urls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
		requests.authorizations.push(
			(init?.headers as Record<string, string> | undefined)?.authorization,
		);
		if (url.pathname === '/worker/runtime/manifest')
			return new Response(JSON.stringify(manifest), { status: 200 });
		if (url.pathname === `/worker/runtime/artifacts/${ARTIFACT}`)
			return new Response(null, { status: artifactStatus });
		return new Response(null, { status: 404 });
	});
	return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

function deps(overrides: Partial<MigrateDeps> = {}) {
	const calls: string[] = [];
	const runCommand = vi.fn(async (command: string, args: string[]) => {
		calls.push([command, ...args].join(' '));
		return 0;
	});
	const installAutostart = vi.fn(async (workerId: string) => {
		calls.push(`install --profile ${workerId}`);
		return { kind: 'installed' as const };
	});
	const ensureRuntime = vi.fn(async () => ({
		version: '2.0.0',
		dir: join(home, '.swarm', 'runtimes', '2.0.0'),
		entrypoint: 'dist/transport/connect-entry.mjs',
		installed: true,
	}));
	const { fetch, requests } = fakeFetch();
	const base: MigrateDeps = {
		fetch,
		ensureRuntime,
		runCommand,
		installAutostart,
		readPlist: async (path) => {
			if (!plists.has(path)) throw new Error(`no plist ${path}`);
			return plists.get(path);
		},
		trustedPublicKey: null,
		installRoot: launcherRoot,
		platform: 'darwin',
		pidIsLive: () => false,
		cwd: checkout,
		homeDir: home,
		sleep: async () => {},
		...overrides,
	};
	return { deps: base, calls, runCommand, installAutostart, ensureRuntime, requests };
}

/** Nothing on disk moved: the cache is where it was and no profile exists. */
function expectNothingChanged(): void {
	expect(existsSync(workerCredentialCachePath(checkout, home))).toBe(true);
	expect(existsSync(workerProfilePath(WORKER_ID, home))).toBe(false);
}

const cloneScript = () => join(clone, 'bin', 'swarm-worker-agent');

describe('swarm-worker migrate', () => {
	it('moves the worker into a profile, swaps the agents and deletes the cache entry', async () => {
		const { deps: migrateDeps, calls, ensureRuntime, requests } = deps();

		expect(await runMigrate(['--yes'], migrateDeps)).toBe(0);

		expect(readWorkerProfile(WORKER_ID, home)).toEqual(
			expect.objectContaining({
				workerId: WORKER_ID,
				credential: CREDENTIAL,
				controlPlaneUrl: CONTROL_PLANE,
				repoRoots: [checkout, extra],
			}),
		);
		expect(ensureRuntime).toHaveBeenCalledWith(
			expect.objectContaining({ controlPlaneUrl: CONTROL_PLANE, bearer: CREDENTIAL }),
		);
		// The clone's own script uninstalls its agent before the package's installs.
		expect(calls).toEqual([
			`${cloneScript()} uninstall ${checkout}`,
			`install --profile ${WORKER_ID}`,
		]);
		expect(existsSync(workerCredentialCachePath(checkout, home))).toBe(false);
		// Nothing registers or enrolls: the only requests are the manifest and the proof.
		expect(requests.urls).toEqual([
			'GET /worker/runtime/manifest',
			`HEAD /worker/runtime/artifacts/${ARTIFACT}`,
		]);
		expect(requests.authorizations[1]).toBe(`Bearer ${CREDENTIAL}`);

		const output = printed();
		expect(output).toContain(`now runs from ${launcherRoot} and no longer needs ${clone}`);
		expect(output).toContain(`nothing else on this machine runs ${clone}, so it can be deleted`);
		expect(output).toContain(`swarm-worker status ${WORKER_ID}`);
		expect(output).toContain('interrupts a run in progress');
		expect(output).not.toContain(CREDENTIAL);
	});

	it('names the other clone agents still running the clone', async () => {
		writePlist('pl.smarttechbrewery.swarm.worker.web.ffff0000', cloneAgentPlist(extra));
		const { deps: migrateDeps } = deps();

		expect(await runMigrate([checkout, '--yes'], migrateDeps)).toBe(0);

		const output = printed();
		expect(output).toContain(`${clone} is still run by:`);
		expect(output).toContain(`pl.smarttechbrewery.swarm.worker.web.ffff0000 (${extra})`);
		expect(output).not.toContain('can be deleted');
	});

	it('accepts a --control-plane-url that agrees with the clone', async () => {
		const { deps: migrateDeps } = deps();

		expect(
			await runMigrate(['--control-plane-url', `${CONTROL_PLANE}/`, '--yes'], migrateDeps),
		).toBe(0);
	});

	it('refuses a --control-plane-url that disagrees with the clone, naming both', async () => {
		const { deps: migrateDeps, calls, requests } = deps();

		expect(
			await runMigrate(['--control-plane-url', 'https://other.example.com', '--yes'], migrateDeps),
		).toBe(1);

		const output = printed();
		expect(output).toContain(CONTROL_PLANE);
		expect(output).toContain('https://other.example.com');
		expect(calls).toEqual([]);
		expect(requests.urls).toEqual([]);
		expectNothingChanged();
	});

	it('refuses a checkout with no cached clone worker', async () => {
		rmSync(workerCredentialCachePath(checkout, home));
		const { deps: migrateDeps, calls } = deps();

		expect(await runMigrate(['--yes'], migrateDeps)).toBe(1);

		expect(printed()).toContain(`no clone-based worker is registered for ${checkout}`);
		expect(calls).toEqual([]);
		expect(existsSync(workerProfilePath(WORKER_ID, home))).toBe(false);
	});

	it('refuses a checkout a profile already serves for the installation', async () => {
		const other = '22222222-2222-4222-8222-222222222222';
		writeWorkerProfile({
			workerId: other,
			controlPlaneUrl: CONTROL_PLANE,
			credential: 'another-credential',
			repoRoots: [checkout],
			homeDir: home,
		});
		const { deps: migrateDeps, calls, requests } = deps();

		expect(await runMigrate(['--yes'], migrateDeps)).toBe(1);

		expect(printed()).toContain(`worker ${other}'s profile already serves ${checkout}`);
		expect(calls).toEqual([]);
		expect(requests.urls).toEqual([]);
		expectNothingChanged();
	});

	it('changes nothing when the control plane rejects the credential', async () => {
		const { fetch } = fakeFetch(401);
		const { deps: migrateDeps, calls, ensureRuntime } = deps({ fetch });

		expect(await runMigrate(['--yes'], migrateDeps)).toBe(1);

		const output = printed();
		expect(output).toContain('does not accept the cached worker credential');
		expect(output).not.toContain(CREDENTIAL);
		expect(ensureRuntime).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
		expectNothingChanged();
	});

	it('changes nothing when the runtime fails verification', async () => {
		const { deps: migrateDeps, calls } = deps({
			ensureRuntime: async () => ({ error: 'the signature does not verify' }),
		});

		expect(await runMigrate(['--yes'], migrateDeps)).toBe(1);

		expect(printed()).toContain('the signature does not verify');
		expect(calls).toEqual([]);
		expectNothingChanged();
	});

	it('rolls back to the clone agent when the profile agent cannot be installed', async () => {
		const { deps: migrateDeps, calls } = deps({
			installAutostart: async () => ({ kind: 'failed', reason: 'launchctl bootstrap failed' }),
		});

		expect(await runMigrate(['--yes'], migrateDeps)).toBe(1);

		expect(calls).toEqual([
			`${cloneScript()} uninstall ${checkout}`,
			`${cloneScript()} install ${checkout}`,
		]);
		const output = printed();
		expect(output).toContain('launchctl bootstrap failed');
		expect(output).toContain("rolled back: the clone's LaunchAgent was reinstalled");
		expect(output).not.toContain(CREDENTIAL);
		expectNothingChanged();
	});

	it('waits for the clone daemon to let go of its checkout before installing', async () => {
		const lockDir = checkoutStateDir('checkout-locks', checkout, home);
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 4242 }));
		let alive = 3;
		const { deps: migrateDeps, installAutostart } = deps({
			pidIsLive: () => alive-- > 0,
		});

		expect(await runMigrate(['--yes'], migrateDeps)).toBe(0);

		expect(alive).toBeLessThan(0);
		expect(installAutostart).toHaveBeenCalledOnce();
	});

	it('asks before changing anything, and stops on no', async () => {
		const io: PromptIo = {
			isTTY: true,
			ask: vi.fn(async () => 'n'),
			askHidden: vi.fn(),
			readStdin: vi.fn(),
			readFile: vi.fn(),
		};
		const { deps: migrateDeps, calls } = deps({ io });

		expect(await runMigrate([], migrateDeps)).toBe(1);

		expect(io.ask).toHaveBeenCalledOnce();
		expect(calls).toEqual([]);
		expectNothingChanged();
	});

	it('refuses to go on without a terminal or --yes', async () => {
		const io: PromptIo = {
			isTTY: false,
			ask: vi.fn(),
			askHidden: vi.fn(),
			readStdin: vi.fn(),
			readFile: vi.fn(),
		};
		const { deps: migrateDeps, calls } = deps({ io });

		expect(await runMigrate([], migrateDeps)).toBe(1);

		expect(printed()).toContain('--yes');
		expect(calls).toEqual([]);
		expectNothingChanged();
	});

	it('with no clone agent, needs --control-plane-url and prints how to start the worker', async () => {
		plists.clear();
		rmSync(join(home, 'Library'), { recursive: true });
		const { deps: refused } = deps();
		expect(await runMigrate(['--yes'], refused)).toBe(1);
		expect(printed()).toContain('pass --control-plane-url');
		expectNothingChanged();

		const { deps: migrateDeps, calls } = deps();
		expect(await runMigrate(['--control-plane-url', CONTROL_PLANE, '--yes'], migrateDeps)).toBe(0);

		expect(calls).toEqual([]);
		expect(readWorkerProfile(WORKER_ID, home)?.repoRoots).toEqual([checkout, extra]);
		expect(existsSync(workerCredentialCachePath(checkout, home))).toBe(false);
		expect(printed()).toContain(`swarm-worker run ${WORKER_ID}`);
	});

	it('refuses to run from the clone it is moving the worker off', async () => {
		const { deps: migrateDeps, calls } = deps({ installRoot: clone });

		expect(await runMigrate(['--yes'], migrateDeps)).toBe(1);

		expect(printed()).toContain('the very clone the worker is being moved off');
		expect(calls).toEqual([]);
		expectNothingChanged();
	});

	it('never writes the credential anywhere but the profile', async () => {
		const { deps: migrateDeps } = deps();

		expect(await runMigrate(['--yes'], migrateDeps)).toBe(0);

		const holders = readdirSync(home, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => join(entry.parentPath, entry.name))
			.filter((path) => readFileSync(path, 'utf8').includes(CREDENTIAL));
		expect(holders).toEqual([workerProfilePath(WORKER_ID, home)]);
	});
});

describe('clone agents', () => {
	it('reads only run:worker agents, and prefers the plist’s URL over the clone’s .env', async () => {
		writePlist('pl.smarttechbrewery.swarm.worker.github.w-2.12345678', {
			ProgramArguments: [
				'/usr/local/bin/node',
				join(launcherRoot, 'bin', 'swarm-worker.js'),
				'run',
				'w-2',
			],
			WorkingDirectory: join(home, '.swarm', 'workers', 'w-2'),
		});
		writePlist(
			LABEL,
			cloneAgentPlist(checkout, { SWARM_CONTROL_PLANE_URL: 'https://plist.example.com' }),
		);

		const agents = await listCloneAgents({
			homeDir: home,
			readPlist: async (path) => plists.get(path),
		});

		expect(agents.map((agent) => [agent.label, agent.checkout, agent.cloneRoot])).toEqual([
			[LABEL, checkout, clone],
		]);
		expect(cloneAgentControlPlaneUrl(agents[0])).toBe('https://plist.example.com');
		expect(cloneAgentControlPlaneUrl({ ...agents[0], environment: {} })).toBe(`${CONTROL_PLANE}/`);
	});
});
