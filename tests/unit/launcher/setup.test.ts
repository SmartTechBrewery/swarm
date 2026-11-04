/**
 * `swarm-worker setup` (issue #1311), driven end to end with fakes for everything
 * past this process: the sign-in endpoint and the runtime manifest through an
 * injected `fetch`, the operator API through an injected client, and the terminal
 * through an injected prompt. The profile, the session cache and the checkout are
 * real files under a temporary HOME, so what is (and is not) left on disk is read
 * back rather than assumed.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperatorApiError, type OperatorClient } from '@/cli/_shared/operator-client.js';
import {
	operatorSessionCachePath,
	writeOperatorSessionCache,
} from '@/cli/_shared/operator-session-cache.js';
import { REPO_ROOT } from '@/cli/_shared/paths.js';
import type { PromptIo } from '@/launcher/operator-prompts.js';
import { runSetup, type SetupDeps } from '@/launcher/setup.js';
import { workerProfilePath } from '@/launcher/worker-profile.js';

// `os.homedir()` does not follow `process.env.HOME` inside a worker thread, and the
// reused `swarm workers` helpers resolve `~` through it — so it is pointed at the
// test's own home, and throws rather than reaching the real one.
const fakeHome = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:os')>()),
	homedir: () => {
		if (!fakeHome.dir) throw new Error('no test home directory is set');
		return fakeHome.dir;
	},
}));

// This checkout ships `bin/swarm.js`, so the hints name `swarm` unless a test says
// it runs from the launcher package, which ships none (issue #1311).
const launcherPackage = vi.hoisted(() => ({ on: false }));
vi.mock('@/cli/_shared/installation-command.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/cli/_shared/installation-command.js')>()),
	isLauncherPackage: () => launcherPackage.on,
}));

const CONTROL_PLANE = 'https://swarm.example.com';
const PASSWORD = 'correct-horse-battery-staple';
const SCM_TOKEN = 'ghp_scm-token-value';
const SESSION_TOKEN = 'opaque-session-token';
const WORKER_CREDENTIAL = 'raw-worker-credential';
const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const USER = { id: 'user-1', identifier: 'ada@example.com', displayName: 'Ada' };
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';

let home: string;
let checkout: string;
let passwordFile: string;
let tokenFile: string;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-worker-setup-home-')));
	checkout = join(home, 'work', 'api');
	mkdirSync(checkout, { recursive: true });
	passwordFile = join(home, 'password');
	tokenFile = join(home, 'token');
	writeFileSync(passwordFile, `${PASSWORD}\n`);
	writeFileSync(tokenFile, `${SCM_TOKEN}\n`);
	fakeHome.dir = home;
	for (const stream of ['log', 'warn', 'error'] as const)
		vi.spyOn(console, stream).mockImplementation(() => {});
});

afterEach(() => {
	fakeHome.dir = '';
	launcherPackage.on = false;
	vi.restoreAllMocks();
	rmSync(home, { recursive: true, force: true });
});

function printed(): string {
	return (['log', 'warn', 'error'] as const)
		.flatMap((stream) => vi.mocked(console[stream]).mock.calls.flat())
		.join('\n');
}

/** Every file under `dir`, read as text — to prove a secret was written nowhere. */
function everyFileUnder(dir: string): string {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
		.join('\n');
}

/** A terminal that fails the test if anything asks it a question. */
function noTerminal(overrides: Partial<PromptIo> = {}): PromptIo {
	return {
		isTTY: false,
		ask: vi.fn(async (question: string) => {
			throw new Error(`prompted: ${question}`);
		}),
		askHidden: vi.fn(async (question: string) => {
			throw new Error(`prompted for a secret: ${question}`);
		}),
		readStdin: vi.fn(async () => {
			throw new Error('read stdin');
		}),
		readFile: (path: string) => readFileSync(path, 'utf8'),
		...overrides,
	};
}

type Route = (init: RequestInit) => { status: number; body?: unknown };

/** The sign-in endpoint and the runtime manifest; everything else is a 404. */
function fakeFetch(routes: Record<string, Route> = {}) {
	const all: Record<string, Route> = {
		[`POST ${CONTROL_PLANE}/operator/session`]: () => ({
			status: 200,
			body: { token: SESSION_TOKEN, expiresAt: EXPIRES_AT, user: USER },
		}),
		[`GET ${CONTROL_PLANE}/operator/session`]: () => ({ status: 200, body: { user: USER } }),
		...routes,
	};
	return vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
		const key = `${init.method ?? 'GET'} ${String(input)}`;
		const route = all[key];
		if (!route) return new Response('not found', { status: 404 });
		const { status, body } = route(init);
		return new Response(typeof body === 'string' ? body : JSON.stringify(body ?? {}), { status });
	}) as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>;
}

type Handler = (input: unknown) => unknown;

/** The operator API, one handler per procedure; an unexpected call fails the test. */
function fakeOperatorApi(overrides: Record<string, Handler> = {}) {
	const handlers: Record<string, Handler> = {
		'workers.enrollableProjects': () => [{ id: 'api', name: 'API', role: 'projectAdmin' }],
		'workers.projectScmProvider': () => ({ providerId: 'github' }),
		'workers.register': (input) => ({
			worker: {
				id: WORKER_ID,
				displayName: (input as { displayName: string }).displayName,
				capabilities: (input as { capabilities: string[] }).capabilities,
			},
			credential: WORKER_CREDENTIAL,
		}),
		'workers.enroll': () => ({
			id: 'enrollment-1',
			status: 'active',
			allowedClis: ['claude'],
			concurrencyAllocation: 1,
			sharingConsent: true,
		}),
		'workers.scmCredentials.set': () => ({ login: 'ada' }),
		'workers.listMine': () => [{ workerId: WORKER_ID, displayName: 'w', connection: 'online' }],
		...overrides,
	};
	const calls: { path: string; input: unknown }[] = [];
	const call = async <T>(path: string, input: unknown, parse: (value: unknown) => T) => {
		calls.push({ path, input });
		const handler = handlers[path];
		if (!handler) throw new Error(`unexpected operator call: ${path}`);
		return parse(await handler(input));
	};
	const client: OperatorClient = { query: call, mutate: call };
	return { client, calls, paths: () => calls.map((entry) => entry.path) };
}

const FULL_FLAGS = [
	'--control-plane-url',
	CONTROL_PLANE,
	'--email',
	USER.identifier,
	'--password-file',
	'',
	'--project',
	'api',
	'--cli',
	'claude',
	'--name',
	'ada-api',
	'--scm-token-file',
	'',
];

function fullFlags(): string[] {
	const argv = [...FULL_FLAGS];
	argv[5] = passwordFile;
	argv[13] = tokenFile;
	return argv;
}

function deps(overrides: Partial<SetupDeps> = {}) {
	const api = fakeOperatorApi();
	const installAutostart = vi.fn(async () => ({ kind: 'installed' as const }));
	const base: SetupDeps = {
		io: noTerminal(),
		fetch: fakeFetch(),
		createClient: () => api.client,
		discoverClis: async () => ['claude'],
		installAutostart,
		trustedPublicKey: null,
		cwd: checkout,
		hostname: 'ada-mac.local',
		sleep: async () => {},
		homeDir: home,
		...overrides,
	};
	return { deps: base, api, installAutostart };
}

describe('swarm-worker setup', () => {
	it('runs fully flagged with no terminal: asks nothing, and ends connected under launchd', async () => {
		const { deps: setupDeps, api, installAutostart } = deps();

		expect(await runSetup(fullFlags(), setupDeps)).toBe(0);

		expect(setupDeps.io?.ask).not.toHaveBeenCalled();
		expect(setupDeps.io?.askHidden).not.toHaveBeenCalled();
		expect(api.paths()).toEqual([
			'workers.enrollableProjects',
			'workers.projectScmProvider',
			'workers.register',
			'workers.enroll',
			'workers.scmCredentials.set',
			'workers.listMine',
		]);
		expect(api.calls.find((c) => c.path === 'workers.scmCredentials.set')?.input).toEqual({
			workerId: WORKER_ID,
			providerId: 'github',
			value: SCM_TOKEN,
		});
		expect(installAutostart).toHaveBeenCalledWith(WORKER_ID);

		const profile = JSON.parse(readFileSync(workerProfilePath(WORKER_ID, home), 'utf8'));
		expect(profile).toMatchObject({
			workerId: WORKER_ID,
			controlPlaneUrl: CONTROL_PLANE,
			credential: WORKER_CREDENTIAL,
			repoRoots: [checkout],
		});
		const session = operatorSessionCachePath(CONTROL_PLANE, home);
		expect(JSON.parse(readFileSync(session, 'utf8'))).toMatchObject({ token: SESSION_TOKEN });
		expect(statSync(session).mode & 0o777).toBe(0o600);
		expect(printed()).toContain(`is connected to ${CONTROL_PLANE}`);
		// A control plane serving no runtime yet is a warning, not a failure.
		expect(printed()).toMatch(/could not fetch the installation's runtime yet/);
	});

	it('never prints, logs or writes the password, the SCM token or the worker credential', async () => {
		const { deps: setupDeps } = deps();
		rmSync(passwordFile);
		rmSync(tokenFile);
		// Typed at a terminal this time — the other way a secret arrives.
		const io = noTerminal({
			isTTY: true,
			askHidden: vi.fn(async (question: string) =>
				question.startsWith('Password') ? PASSWORD : SCM_TOKEN,
			),
		});
		const argv = ['--control-plane-url', CONTROL_PLANE, '--email', USER.identifier, '--yes'];

		expect(await runSetup(argv, { ...setupDeps, io })).toBe(0);

		expect(io.askHidden).toHaveBeenCalledTimes(2);
		const output = printed();
		for (const secret of [PASSWORD, SCM_TOKEN, WORKER_CREDENTIAL, SESSION_TOKEN])
			expect(output).not.toContain(secret);
		const onDisk = everyFileUnder(home);
		expect(onDisk).not.toContain(PASSWORD);
		expect(onDisk).not.toContain(SCM_TOKEN);
	});

	it('leaves no .env behind, in the checkout or the install root', async () => {
		const hadEnv = existsSync(join(REPO_ROOT, '.env'));
		const before = hadEnv ? readFileSync(join(REPO_ROOT, '.env'), 'utf8') : undefined;
		const { deps: setupDeps } = deps();

		expect(await runSetup(fullFlags(), setupDeps)).toBe(0);

		expect(existsSync(join(checkout, '.env'))).toBe(false);
		expect(existsSync(join(REPO_ROOT, '.env'))).toBe(hadEnv);
		if (hadEnv) expect(readFileSync(join(REPO_ROOT, '.env'), 'utf8')).toBe(before);
	});

	it.each([
		['--email', '--email <email>'],
		['--password-file', '--password-file <path|->'],
		['--scm-token-file', '--scm-token-file <path|->'],
		['--control-plane-url', '--control-plane-url <url>'],
	])('fails naming %s when it is missing and there is no terminal', async (flag, named) => {
		const argv = fullFlags();
		argv.splice(argv.indexOf(flag), 2);
		const { deps: setupDeps } = deps();

		expect(await runSetup(argv, setupDeps)).toBe(1);

		expect(printed()).toContain(`pass ${named}`);
		expect(existsSync(join(home, '.swarm', 'workers'))).toBe(false);
	});

	it('fails naming --project when several projects are yours and there is no terminal', async () => {
		const argv = fullFlags();
		argv.splice(argv.indexOf('--project'), 2);
		const api = fakeOperatorApi({
			'workers.enrollableProjects': () => [
				{ id: 'web', name: 'Web', role: 'member' },
				{ id: 'mobile', name: 'Mobile', role: 'member' },
			],
		});
		const { deps: setupDeps } = deps({ createClient: () => api.client });

		expect(await runSetup(argv, setupDeps)).toBe(1);

		expect(printed()).toMatch(/pass --project <id>.*yours: web, mobile/);
		expect(api.paths()).toEqual(['workers.enrollableProjects']);
	});

	it('auto-picks the only project the operator can enroll into', async () => {
		const argv = fullFlags();
		argv.splice(argv.indexOf('--project'), 2);
		const { deps: setupDeps, api } = deps();

		expect(await runSetup(argv, setupDeps)).toBe(0);

		expect(printed()).toContain('project: API (api) — projectAdmin — the only one');
		expect(api.calls.find((c) => c.path === 'workers.enroll')?.input).toMatchObject({
			projectId: 'api',
		});
	});

	it('picks from a numbered list on a terminal', async () => {
		const api = fakeOperatorApi({
			'workers.enrollableProjects': () => [
				{ id: 'web', name: 'Web', role: 'member' },
				{ id: 'api', name: 'API', role: 'member' },
			],
		});
		const io = noTerminal({ isTTY: true, ask: vi.fn(async () => '2') });
		const argv = fullFlags().filter(
			(_, i, all) => all[i] !== '--project' && all[i - 1] !== '--project',
		);
		const { deps: setupDeps } = deps({ createClient: () => api.client, io });

		expect(await runSetup(argv, setupDeps)).toBe(0);

		expect(printed()).toContain('  2) API (api) — member');
		expect(api.calls.find((c) => c.path === 'workers.enroll')?.input).toMatchObject({
			projectId: 'api',
		});
	});

	it('refuses a project the operator cannot enroll into, before anything is written', async () => {
		const argv = fullFlags();
		argv[argv.indexOf('--project') + 1] = 'someone-elses';
		const { deps: setupDeps, api } = deps();

		expect(await runSetup(argv, setupDeps)).toBe(1);

		expect(printed()).toContain("'someone-elses' is not a project you can enroll a worker into");
		expect(api.paths()).toEqual(['workers.enrollableProjects']);
	});

	it('refuses - for both the password and the SCM token', async () => {
		const argv = fullFlags();
		argv[argv.indexOf('--password-file') + 1] = '-';
		argv[argv.indexOf('--scm-token-file') + 1] = '-';
		const fetch = fakeFetch();
		const { deps: setupDeps, api } = deps({ fetch });

		expect(await runSetup(argv, setupDeps)).toBe(1);

		expect(printed()).toContain(
			'only one of --password-file and --scm-token-file may be - (stdin carries one secret)',
		);
		expect(fetch).not.toHaveBeenCalled();
		expect(api.calls).toEqual([]);
	});

	it('reads one secret from stdin when only one source is -', async () => {
		const argv = fullFlags();
		argv[argv.indexOf('--password-file') + 1] = '-';
		const io = noTerminal({ readStdin: vi.fn(async () => `${PASSWORD}\n`) });
		const fetch = fakeFetch();
		const { deps: setupDeps } = deps({ fetch, io });

		expect(await runSetup(argv, setupDeps)).toBe(0);

		const [, init] = fetch.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(String(init.body))).toEqual({
			identifier: USER.identifier,
			password: PASSWORD,
		});
	});

	it('reuses a live session for the URL without asking for the password', async () => {
		writeOperatorSessionCache({
			controlPlaneUrl: CONTROL_PLANE,
			token: SESSION_TOKEN,
			userId: USER.id,
			identifier: USER.identifier,
			expiresAt: EXPIRES_AT,
			homeDir: home,
		});
		const fetch = fakeFetch({
			[`POST ${CONTROL_PLANE}/operator/session`]: () => {
				throw new Error('signed in again');
			},
		});
		const readStdin = vi.fn(async () => PASSWORD);
		const argv = fullFlags();
		argv.splice(argv.indexOf('--password-file'), 2);
		argv.splice(argv.indexOf('--email'), 2);
		const { deps: setupDeps } = deps({ fetch, io: noTerminal({ readStdin }) });

		expect(await runSetup(argv, setupDeps)).toBe(0);

		expect(readStdin).not.toHaveBeenCalled();
		expect(printed()).toContain(`using your session on ${CONTROL_PLANE} as '${USER.identifier}'`);
	});

	it('signs in again when the cached session was revoked', async () => {
		writeOperatorSessionCache({
			controlPlaneUrl: CONTROL_PLANE,
			token: 'revoked-token',
			userId: USER.id,
			identifier: USER.identifier,
			expiresAt: EXPIRES_AT,
			homeDir: home,
		});
		const fetch = fakeFetch({
			[`GET ${CONTROL_PLANE}/operator/session`]: (init) =>
				(init.headers as Record<string, string>).authorization === 'Bearer revoked-token'
					? { status: 401 }
					: { status: 200, body: { user: USER } },
		});
		const { deps: setupDeps } = deps({ fetch });

		expect(await runSetup(fullFlags(), setupDeps)).toBe(0);

		expect(printed()).toContain(`signed in to ${CONTROL_PLANE} as '${USER.identifier}'`);
	});

	it('leaves no profile when registration is refused', async () => {
		const api = fakeOperatorApi({
			'workers.register': () => {
				throw new OperatorApiError(
					'A worker named "ada-api" already exists for "ada@example.com".',
				);
			},
		});
		const { deps: setupDeps, installAutostart } = deps({ createClient: () => api.client });

		expect(await runSetup(fullFlags(), setupDeps)).toBe(1);

		expect(printed()).toContain('A worker named "ada-api" already exists');
		expect(existsSync(join(home, '.swarm', 'workers'))).toBe(false);
		expect(installAutostart).not.toHaveBeenCalled();
	});

	it('stops before autostart when the runtime fails verification', async () => {
		const name = 'swarm-worker-runtime-1.2.3.tar.gz';
		const artifact = `/worker/runtime/artifacts/${name}`;
		const fetch = fakeFetch({
			[`GET ${CONTROL_PLANE}/worker/runtime/manifest`]: () => ({
				status: 200,
				body: {
					available: true,
					version: '1.2.3',
					commit: 'c'.repeat(40),
					artifact: { name, url: artifact, size: 7, sha256: '0'.repeat(64) },
					signature: { format: 'minisign', minisig: 'untrusted' },
				},
			}),
			[`GET ${CONTROL_PLANE}${artifact}`]: () => ({ status: 200, body: 'garbage' }),
		});
		const { deps: setupDeps, installAutostart } = deps({
			fetch,
			trustedPublicKey: 'a trusted key',
		});

		expect(await runSetup(fullFlags(), setupDeps)).toBe(1);

		expect(printed()).toMatch(/the installation's runtime was not installed — v1\.2\.3: .*SHA-256/);
		expect(printed()).toContain(`install --profile ${WORKER_ID}`);
		expect(installAutostart).not.toHaveBeenCalled();
		expect(existsSync(join(home, '.swarm', 'runtimes', '1.2.3'))).toBe(false);
		// Registered, so its profile is kept for the retry.
		expect(existsSync(workerProfilePath(WORKER_ID, home))).toBe(true);
	});

	it('installs and starts a worker whose enrollment awaits approval, and says who approves it', async () => {
		const api = fakeOperatorApi({
			'workers.enroll': () => ({
				id: 'enrollment-1',
				status: 'pending',
				allowedClis: ['claude'],
				concurrencyAllocation: 1,
				sharingConsent: false,
			}),
			'workers.approveEnrollment': () => {
				throw new OperatorApiError('Only a project administrator may approve an enrollment.');
			},
			'workers.setConsent': () => ({
				id: 'enrollment-1',
				status: 'pending',
				allowedClis: ['claude'],
				concurrencyAllocation: 1,
				sharingConsent: true,
			}),
		});
		const { deps: setupDeps, installAutostart } = deps({ createClient: () => api.client });

		expect(await runSetup(fullFlags(), setupDeps)).toBe(0);

		expect(installAutostart).toHaveBeenCalledWith(WORKER_ID);
		expect(printed()).toMatch(/takes no work in 'api' until its enrollment is finished/);
		expect(printed()).toMatch(new RegExp(`workers approve ${WORKER_ID} api`));
	});

	describe('from the launcher package, which ships no swarm CLI', () => {
		const workerPage = `${CONTROL_PLANE}/workers/${WORKER_ID}`;

		beforeEach(() => {
			launcherPackage.on = true;
		});

		it('names the worker page for a pending approval and consent, not a swarm command', async () => {
			const api = fakeOperatorApi({
				'workers.enroll': () => ({
					id: 'enrollment-1',
					status: 'pending',
					allowedClis: ['claude'],
					concurrencyAllocation: 1,
					sharingConsent: false,
				}),
				'workers.approveEnrollment': () => {
					throw new OperatorApiError('Only a project administrator may approve an enrollment.');
				},
				'workers.setConsent': () => {
					throw new OperatorApiError('Only the owner may grant consent.');
				},
			});
			const { deps: setupDeps } = deps({ createClient: () => api.client });

			expect(await runSetup(fullFlags(), setupDeps)).toBe(0);

			expect(printed()).toContain(`approve its enrollment in 'api' on ${workerPage}`);
			expect(printed()).toContain(`turn on its sharing consent for 'api' on ${workerPage}`);
			expect(printed()).not.toMatch(/bin\/swarm\.js|swarm workers/);
		});

		it('fails on a refused SCM token, naming the worker page to set it on', async () => {
			const api = fakeOperatorApi({
				'workers.scmCredentials.set': () => {
					throw new OperatorApiError('the credential was rejected by github');
				},
			});
			const { deps: setupDeps, installAutostart } = deps({ createClient: () => api.client });

			expect(await runSetup(fullFlags(), setupDeps)).toBe(1);

			expect(installAutostart).not.toHaveBeenCalled();
			expect(printed()).toContain('the credential was rejected by github');
			expect(printed()).toContain(`set its github operator credential on ${workerPage}`);
			expect(printed()).not.toMatch(/bin\/swarm\.js|swarm workers/);
		});

		it('refuses a re-run for a served checkout, naming the worker page to delete it on', async () => {
			const { deps: setupDeps } = deps();
			expect(await runSetup(fullFlags(), setupDeps)).toBe(0);

			expect(await runSetup(fullFlags(), deps().deps)).toBe(1);

			expect(printed()).toContain(`to replace it, delete it on ${workerPage}`);
			expect(printed()).not.toMatch(/bin\/swarm\.js|swarm workers/);
		});
	});

	it('reports a worker that never connects as a failure, naming how to check it', async () => {
		let clock = 0;
		const api = fakeOperatorApi({
			'workers.listMine': () => [{ workerId: WORKER_ID, displayName: 'w', connection: 'offline' }],
		});
		const { deps: setupDeps } = deps({
			createClient: () => api.client,
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});

		expect(await runSetup(fullFlags(), setupDeps)).toBe(1);

		expect(printed()).toContain('has not seen it connect within 60s');
		expect(printed()).toContain(`swarm-worker status ${WORKER_ID}`);
	});

	it('prints the foreground command with --no-autostart', async () => {
		const { deps: setupDeps, installAutostart } = deps();

		expect(await runSetup([...fullFlags(), '--no-autostart'], setupDeps)).toBe(0);

		expect(installAutostart).not.toHaveBeenCalled();
		expect(printed()).toMatch(new RegExp(`start the worker with: .*run ${WORKER_ID}`));
	});

	it('refuses a checkout a profile already serves for the same installation', async () => {
		const { deps: setupDeps } = deps();
		expect(await runSetup(fullFlags(), setupDeps)).toBe(0);
		vi.mocked(console.error).mockClear();

		const again = deps();
		expect(await runSetup(fullFlags(), again.deps)).toBe(1);

		expect(printed()).toContain('it never issues a second worker for one checkout');
		expect(again.api.calls).toEqual([]);
	});
});
