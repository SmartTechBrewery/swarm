/**
 * `swarm-worker status` and `swarm-worker login` (issue #1311): real profiles,
 * states and session caches under a temporary home, with the login service, the
 * operator API and the sign-in endpoint faked.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperatorApiError, type OperatorClient } from '@/cli/_shared/operator-client.js';
import {
	operatorSessionCachePath,
	writeOperatorSessionCache,
} from '@/cli/_shared/operator-session-cache.js';
import { runLogin } from '@/launcher/login.js';
import type { PromptIo } from '@/launcher/operator-prompts.js';
import { runStatus, type StatusDeps } from '@/launcher/status.js';
import { writeWorkerProfile, writeWorkerState } from '@/launcher/worker-profile.js';

const fakeHome = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:os')>()),
	homedir: () => {
		if (!fakeHome.dir) throw new Error('no test home directory is set');
		return fakeHome.dir;
	},
}));

const CONTROL_PLANE = 'https://swarm.example.com';
const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const IDENTIFIER = 'ada@example.com';
const LAST_SEEN = '2026-11-04T10:00:00.000Z';

let home: string;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-worker-status-')));
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

function profile(workerId = WORKER_ID, controlPlaneUrl = CONTROL_PLANE): void {
	writeWorkerProfile({
		workerId,
		controlPlaneUrl,
		credential: 'raw-credential',
		repoRoots: [join(home, 'work', 'api')],
		homeDir: home,
	});
}

function signedIn(expiresAt = '2099-01-01T00:00:00.000Z'): void {
	writeOperatorSessionCache({
		controlPlaneUrl: CONTROL_PLANE,
		token: 'session-token',
		userId: 'user-1',
		identifier: IDENTIFIER,
		expiresAt,
		homeDir: home,
	});
}

function api(rows: unknown) {
	const query = vi.fn(async <T>(_path: string, _input: unknown, parse: (value: unknown) => T) => {
		if (rows instanceof Error) throw rows;
		return parse(rows);
	});
	const client = { query, mutate: query } as unknown as OperatorClient;
	return { client, query };
}

function deps(overrides: Partial<StatusDeps> = {}): StatusDeps {
	return {
		agentStatus: async () => ({ supervisor: 'launchd', output: 'label:    pl.x\nstate = running' }),
		homeDir: home,
		...overrides,
	};
}

describe('swarm-worker status', () => {
	it('reports a connected worker and exits 0', async () => {
		profile();
		writeWorkerState(
			WORKER_ID,
			{
				lastRuntimeVersion: '1.2.3',
				startedAt: '2026-11-04T09:00:00.000Z',
				selectedVersion: '1.2.3',
			},
			home,
		);
		signedIn();
		const { client, query } = api([
			{
				workerId: WORKER_ID,
				displayName: 'ada-api',
				connection: 'online',
				lastSeenAt: LAST_SEEN,
				drainingSince: null,
				enrollments: [{ projectId: 'api', status: 'active', sharingConsent: true }],
			},
		]);

		expect(await runStatus([], deps({ createClient: () => client }))).toBe(0);

		expect(query).toHaveBeenCalledWith('workers.listMine', undefined, expect.any(Function));
		const output = printed();
		expect(output).toContain(`worker ${WORKER_ID} on ${CONTROL_PLANE}`);
		expect(output).toContain('    state = running');
		expect(output).toContain(
			'runtime: selected v1.2.3 (not installed), last started v1.2.3 at 2026-11-04T09:00:00.000Z',
		);
		expect(output).toContain(`control plane: connected, last seen ${LAST_SEEN}`);
		expect(output).toContain('enrollment: api — active, sharing consent on');
		expect(output).not.toContain('raw-credential');
	});

	it('reports a disconnected, drained worker and exits non-zero', async () => {
		profile();
		signedIn();
		const { client } = api([
			{
				workerId: WORKER_ID,
				displayName: 'ada-api',
				connection: 'offline',
				lastSeenAt: LAST_SEEN,
				drainingSince: '2026-11-04T11:00:00.000Z',
				enrollments: [],
			},
		]);

		expect(await runStatus([WORKER_ID], deps({ createClient: () => client }))).toBe(1);

		expect(printed()).toContain(
			`control plane: not connected, last seen ${LAST_SEEN}, drained since 2026-11-04T11:00:00.000Z`,
		);
		expect(printed()).toContain('runtime: not started by the launcher yet');
	});

	it('shows the local view and says to log in when there is no live session', async () => {
		profile();
		signedIn('2000-01-01T00:00:00.000Z');
		const createClient = vi.fn();

		expect(await runStatus([], deps({ createClient }))).toBe(1);

		expect(createClient).not.toHaveBeenCalled();
		expect(printed()).toContain('    state = running');
		expect(printed()).toContain(
			`control plane: not signed in — run swarm-worker login --control-plane-url ${CONTROL_PLANE}`,
		);
	});

	it('reports a refusal from the control plane in its own words', async () => {
		profile();
		signedIn();
		const { client } = api(
			new OperatorApiError(`your control-plane session at ${CONTROL_PLANE} has expired`),
		);

		expect(await runStatus([], deps({ createClient: () => client }))).toBe(1);

		expect(printed()).toContain('has expired');
	});

	it('asks each installation once, however many of its workers are here', async () => {
		const other = '22222222-2222-4222-8222-222222222222';
		profile();
		profile(other);
		signedIn();
		const { client, query } = api([
			{ workerId: WORKER_ID, displayName: 'a', connection: 'online' },
			{ workerId: other, displayName: 'b', connection: 'online' },
		]);

		expect(await runStatus([], deps({ createClient: () => client }))).toBe(0);
		expect(query).toHaveBeenCalledTimes(1);
	});

	it('names the foreground command where there is no service manager', async () => {
		profile();

		expect(await runStatus([], deps({ agentStatus: async () => null }))).toBe(1);

		expect(printed()).toMatch(
			/service: none \(no supported service manager on \w+\) — run it with: .* run /,
		);
	});

	// Issue #1323.
	it('names the supervisor its report comes from', async () => {
		profile();
		const agentStatus = async () => ({
			supervisor: 'Task Scheduler',
			output: 'task:    swarm.worker.x\nStatus: Running',
		});

		await runStatus([], deps({ agentStatus }));

		expect(printed()).toContain('  service (Task Scheduler):');
		expect(printed()).toContain('    Status: Running');
	});

	it('says so when there is nothing to report', async () => {
		expect(await runStatus([], deps())).toBe(1);
		expect(printed()).toContain('no worker profiles on this host');

		profile();
		expect(await runStatus(['22222222-2222-4222-8222-222222222222'], deps())).toBe(1);
		expect(printed()).toContain("no profile for worker '22222222-2222-4222-8222-222222222222'");
	});
});

describe('swarm-worker login', () => {
	const PASSWORD = 'correct-horse';

	function io(overrides: Partial<PromptIo> = {}): PromptIo {
		return {
			isTTY: false,
			ask: vi.fn(async () => {
				throw new Error('prompted');
			}),
			askHidden: vi.fn(async () => {
				throw new Error('prompted for a secret');
			}),
			readStdin: vi.fn(async () => `${PASSWORD}\n`),
			readFile: (path: string) => readFileSync(path, 'utf8'),
			...overrides,
		};
	}

	function sessionFetch() {
		return vi.fn(async (_url: string, init: RequestInit = {}) => {
			const user = { id: 'user-1', identifier: IDENTIFIER, displayName: 'Ada' };
			const body =
				init.method === 'POST'
					? { token: 'fresh-token', expiresAt: '2099-01-01T00:00:00.000Z', user }
					: { user };
			return new Response(JSON.stringify(body), { status: 200 });
		});
	}

	it('renews the session for the only installation the profiles serve, as the last identifier', async () => {
		profile();
		signedIn();
		const fetch = sessionFetch();

		expect(await runLogin(['--password-file', '-'], { io: io(), fetch, homeDir: home })).toBe(0);

		const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${CONTROL_PLANE}/operator/session`);
		expect(JSON.parse(String(init.body))).toEqual({ identifier: IDENTIFIER, password: PASSWORD });
		const cached = JSON.parse(readFileSync(operatorSessionCachePath(CONTROL_PLANE, home), 'utf8'));
		expect(cached.token).toBe('fresh-token');
		expect(printed()).not.toContain(PASSWORD);
		expect(printed()).not.toContain('fresh-token');
	});

	it('reads the password from a file', async () => {
		const file = join(home, 'password');
		writeFileSync(file, `${PASSWORD}\n`);
		const fetch = sessionFetch();

		expect(
			await runLogin(
				['--control-plane-url', CONTROL_PLANE, '--email', IDENTIFIER, '--password-file', file],
				{ io: io(), fetch, homeDir: home },
			),
		).toBe(0);
		const [, init] = fetch.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(String(init.body)).password).toBe(PASSWORD);
	});

	it('fails naming the flag for what it cannot default with no terminal', async () => {
		expect(await runLogin(['--password-file', '-'], { io: io(), homeDir: home })).toBe(1);
		expect(printed()).toContain('pass --control-plane-url <url>');

		expect(
			await runLogin(['--control-plane-url', CONTROL_PLANE], { io: io(), homeDir: home }),
		).toBe(1);
		expect(printed()).toContain('pass --email <email>');
	});
});
