import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `swarm workers` holds no `DATABASE_URL` since issue #800: every subcommand goes
 * through `_shared/operator-client.ts` to the control plane's operator API. So the
 * seam this suite drives is that client — one `query`/`mutate` pair answering per
 * procedure path — rather than the identity services and repositories it used to
 * mock. The `parse` each call site passes is invoked for real, so a fixture whose
 * shape the command could not read fails here rather than in production.
 */
const { query, mutate, createOperatorClient, requireOperatorSession, OperatorApiError } =
	vi.hoisted(() => {
		class OperatorApiError extends Error {
			constructor(message: string) {
				super(message);
				this.name = 'OperatorApiError';
			}
		}
		return {
			query: vi.fn(),
			mutate: vi.fn(),
			createOperatorClient: vi.fn(),
			requireOperatorSession: vi.fn(),
			OperatorApiError,
		};
	});
const { promptHidden, readStdin } = vi.hoisted(() => ({
	promptHidden: vi.fn(),
	readStdin: vi.fn(),
}));
const { writeWorkerCredentialCache } = vi.hoisted(() => ({ writeWorkerCredentialCache: vi.fn() }));

vi.mock('@/cli/_shared/operator-client.js', () => ({
	createOperatorClient,
	requireOperatorSession,
	OperatorApiError,
}));
vi.mock('@/cli/_shared/secret-input.js', () => ({ promptHidden, readStdin }));
vi.mock('@/cli/_shared/worker-credential-cache.js', () => ({ writeWorkerCredentialCache }));

import { run } from '@/cli/commands/workers.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = 'proj-a';
const IDENTIFIER = 'ada@example.com';
const ENROLLMENT_ID = '33333333-3333-4333-8333-333333333333';
const ORIGINAL_INIT_CWD = process.env.INIT_CWD;

type Answer = (input: Record<string, unknown>) => unknown;

/** What the control plane answers per procedure path — replaced per test where it matters. */
const answers = new Map<string, Answer>();

/** Record every call so a test can assert both *that* and *what* was sent. */
const calls: { path: string; input: unknown }[] = [];

function answer(path: string, input: unknown): unknown {
	calls.push({ path, input });
	const handler = answers.get(path);
	if (!handler) throw new Error(`test fixture has no answer for '${path}'`);
	return handler((input ?? {}) as Record<string, unknown>);
}

/** Make one procedure refuse the way the control plane would — a message, not a stack. */
function refuse(path: string, message: string): void {
	answers.set(path, () => {
		throw new OperatorApiError(message);
	});
}

function pathsCalled(): string[] {
	return calls.map((call) => call.path);
}

function inputFor(path: string): Record<string, unknown> | undefined {
	return calls.find((call) => call.path === path)?.input as Record<string, unknown> | undefined;
}

function lines(): string[] {
	return vi.mocked(console.log).mock.calls.map(([line]) => String(line));
}

describe('swarm workers', () => {
	beforeEach(() => {
		delete process.env.INIT_CWD;
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		calls.length = 0;
		answers.clear();

		query.mockReset().mockImplementation(async (path, input, parse) => parse(answer(path, input)));
		mutate.mockReset().mockImplementation(async (path, input, parse) => parse(answer(path, input)));
		createOperatorClient.mockReset().mockReturnValue({ query, mutate });
		requireOperatorSession.mockReset().mockReturnValue({
			session: {
				controlPlaneUrl: 'https://swarm.example.com',
				token: 'opaque-session-token',
				identifier: IDENTIFIER,
			},
		});

		// Non-TTY is the shape a test process actually has, so the command reads stdin.
		promptHidden.mockReset().mockResolvedValue('typed-secret');
		readStdin.mockReset().mockResolvedValue('  piped-secret\n');
		writeWorkerCredentialCache
			.mockReset()
			.mockReturnValue('/home/ada/.swarm/worker-credentials/deadbeef/credential.json');

		answers.set('workers.register', (input) => ({
			worker: {
				id: WORKER_ID,
				displayName: input.displayName,
				capabilities: input.capabilities,
			},
			credential: 'raw-credential-token',
		}));
		answers.set('workers.list', () => []);
		answers.set('workers.listMine', () => []);
		answers.set('workers.getById', () => ({
			workerId: WORKER_ID,
			displayName: 'ada-laptop',
			enrollments: [{ enrollmentId: ENROLLMENT_ID, projectId: PROJECT_ID }],
		}));
		answers.set('workers.setDeclaredCapabilities', (input) => ({
			id: input.workerId,
			displayName: 'ada-laptop',
			capabilities: input.capabilities ?? ['claude', 'codex'],
		}));
		answers.set('workers.scmCredentials.set', () => ({ login: 'ada-bot' }));
		answers.set('workers.remove', (input) => ({ workerId: input.workerId }));
		answers.set('workers.enroll', (input) => ({
			id: ENROLLMENT_ID,
			status: 'pending',
			allowedClis: input.allowedClis,
			concurrencyAllocation: input.concurrencyAllocation ?? 1,
			sharingConsent: false,
		}));
		answers.set('workers.approveEnrollment', () => ({
			id: ENROLLMENT_ID,
			status: 'active',
			allowedClis: ['claude'],
			concurrencyAllocation: 1,
			sharingConsent: false,
		}));
		answers.set('workers.setConsent', (input) => ({
			id: ENROLLMENT_ID,
			status: 'active',
			allowedClis: ['claude'],
			concurrencyAllocation: 1,
			sharingConsent: input.sharingConsent,
		}));
		answers.set('workers.updateConstraints', (input) => ({
			id: input.enrollmentId,
			status: 'active',
			allowedClis: input.allowedClis ?? ['claude'],
			concurrencyAllocation: input.concurrencyAllocation ?? 1,
			sharingConsent: true,
		}));
		answers.set('workers.projectScmProvider', () => ({ providerId: 'github' }));
	});

	afterEach(() => {
		if (ORIGINAL_INIT_CWD === undefined) delete process.env.INIT_CWD;
		else process.env.INIT_CWD = ORIGINAL_INIT_CWD;
	});

	// Issue #800's headline: the command group needs a control plane and a session,
	// not a database — and says exactly which of the two is missing.
	describe('the operator session', () => {
		it('refuses every subcommand with one actionable line when nothing is cached', async () => {
			requireOperatorSession.mockReturnValue({ error: 'not signed in — run `swarm login`' });
			const error = vi.spyOn(console, 'error');

			expect(await run(['list'])).toBe(1);
			expect(await run(['remove', WORKER_ID])).toBe(1);
			expect(await run(['register', IDENTIFIER, '--name', 'ada-laptop', '--cli', 'claude'])).toBe(
				1,
			);

			expect(error).toHaveBeenCalledWith(expect.stringContaining('swarm login'));
			expect(calls).toHaveLength(0);
		});

		it('refuses when SWARM_CONTROL_PLANE_URL is unset', async () => {
			requireOperatorSession.mockReturnValue({ error: 'SWARM_CONTROL_PLANE_URL is unset — …' });
			const error = vi.spyOn(console, 'error');
			expect(await run(['list'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('SWARM_CONTROL_PLANE_URL'));
		});

		// The token is spent on the first call, so an expired one surfaces as the
		// client's own refusal — printed as written, exit 1, nothing thrown.
		it('surfaces an expired session from the first call it is spent on', async () => {
			refuse('workers.list', 'your control-plane session has expired — run `swarm login`');
			const error = vi.spyOn(console, 'error');
			expect(await run(['list'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('session has expired'));
		});

		// A usage answer must not require a login: it is what an operator reads
		// *before* signing in.
		it('answers --help with no session at all', async () => {
			requireOperatorSession.mockReturnValue({ error: 'not signed in — run `swarm login`' });
			const log = vi.spyOn(console, 'log');
			expect(await run(['--help'])).toBe(0);
			expect(await run(['register', '--help'])).toBe(0);
			expect(log).toHaveBeenCalledWith(expect.stringContaining('register-and-enroll'));
			expect(calls).toHaveLength(0);
		});
	});

	describe('register', () => {
		it('registers a worker and prints the credential exactly once', async () => {
			expect(
				await run(['register', IDENTIFIER, '--name', 'ada-laptop', '--cli', 'claude,codex']),
			).toBe(0);
			expect(inputFor('workers.register')).toEqual({
				ownerIdentifier: IDENTIFIER,
				displayName: 'ada-laptop',
				capabilities: ['claude', 'codex'],
			});
			expect(lines().filter((line) => line.includes('raw-credential-token'))).toHaveLength(1);
			// Printing stays *and* the credential is cached for this checkout (issue #788).
			expect(writeWorkerCredentialCache).toHaveBeenCalledExactlyOnceWith({
				repoRoot: process.cwd(),
				workerId: WORKER_ID,
				credential: 'raw-credential-token',
			});
		});

		it('names the cache file it wrote without putting the credential on that line', async () => {
			expect(await run(['register', IDENTIFIER, '--name', 'ada-laptop', '--cli', 'claude'])).toBe(
				0,
			);
			const printed = lines();
			const cacheLine = printed.find((line) => line.includes('credential.json')) ?? '';
			expect(cacheLine).toContain('/home/ada/.swarm/worker-credentials/deadbeef/credential.json');
			expect(cacheLine).toContain('swarm run:worker');
			expect(cacheLine).not.toContain('raw-credential-token');
			// Still exactly one line carrying the secret, and still the last one.
			expect(printed.filter((line) => line.includes('raw-credential-token'))).toHaveLength(1);
			expect(printed[printed.length - 1]).toContain('raw-credential-token');
		});

		it("keys the cache to npm's caller directory", async () => {
			const invocationDirectory = `${process.cwd()}/src`;
			process.env.INIT_CWD = invocationDirectory;

			expect(await run(['register', IDENTIFIER, '--name', 'ada-laptop', '--cli', 'claude'])).toBe(
				0,
			);
			expect(writeWorkerCredentialCache).toHaveBeenCalledExactlyOnceWith({
				repoRoot: invocationDirectory,
				workerId: WORKER_ID,
				credential: 'raw-credential-token',
			});
		});

		// The credential is issued and about to be printed; a cache the operator can
		// re-create by re-registering must never strand a registered worker.
		it('warns but still succeeds when the cache cannot be written', async () => {
			writeWorkerCredentialCache.mockImplementation(() => {
				throw new Error('EACCES: permission denied');
			});
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			expect(await run(['register', IDENTIFIER, '--name', 'ada-laptop', '--cli', 'claude'])).toBe(
				0,
			);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not cache the credential'));
			const printed = lines();
			expect(printed.filter((line) => line.includes('raw-credential-token'))).toHaveLength(1);
			expect(printed[printed.length - 1]).toContain('raw-credential-token');
		});

		it('hands the operator off to the SCM credential surfaces, naming no provider and reading no secret', async () => {
			expect(await run(['register', IDENTIFIER, '--name', 'ada-laptop', '--cli', 'claude'])).toBe(
				0,
			);
			const printed = lines();
			expect(printed.some((line) => line.includes('cannot run a phase'))).toBe(true);
			expect(
				printed.some(
					(line) =>
						line.includes(`/workers/${WORKER_ID}`) &&
						line.includes('Operator source-control credential'),
				),
			).toBe(true);
			// Provider-agnostic and non-interactive: no provider is named, and nothing is read.
			expect(printed.some((line) => /github|gitlab|bitbucket/i.test(line))).toBe(false);
			expect(promptHidden).not.toHaveBeenCalled();
			expect(readStdin).not.toHaveBeenCalled();
		});

		it('describes the hand-off in --help without registering anything', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(['register', '--help'])).toBe(0);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining('Operator source-control credential'),
			);
			expect(calls).toHaveLength(0);
		});

		it('requires an owner identifier, a name, and a cli list', async () => {
			expect(await run(['register'])).toBe(1);
			expect(await run(['register', IDENTIFIER])).toBe(1);
			expect(await run(['register', IDENTIFIER, '--name', 'ada-laptop'])).toBe(1);
			expect(calls).toHaveLength(0);
		});

		it('rejects an invalid CLI without reaching the control plane', async () => {
			expect(
				await run(['register', IDENTIFIER, '--name', 'ada-laptop', '--cli', 'claude,vim']),
			).toBe(1);
			expect(calls).toHaveLength(0);
		});

		// The owner lookup is the control plane's now, so its refusal is what is shown.
		it('surfaces an unknown owner as the control plane words it', async () => {
			refuse('workers.register', 'User with identifier "nobody" not found');
			const error = vi.spyOn(console, 'error');
			expect(await run(['register', 'nobody', '--name', 'ada-laptop', '--cli', 'claude'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('not found'));
			expect(writeWorkerCredentialCache).not.toHaveBeenCalled();
		});

		it('surfaces a duplicate worker name and caches nothing', async () => {
			refuse(
				'workers.register',
				'A worker named "ada-laptop" already exists for "ada@example.com".',
			);
			const error = vi.spyOn(console, 'error');
			expect(await run(['register', IDENTIFIER, '--name', 'ada-laptop', '--cli', 'claude'])).toBe(
				1,
			);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('already exists'));
			expect(writeWorkerCredentialCache).not.toHaveBeenCalled();
		});
	});

	// Issue #786 — the composite: register + operator credential + enroll, ending in
	// the exact command that starts the daemon. It composes the three commands above,
	// so what is asserted here is the *ordering* and the credential handling.
	describe('register-and-enroll', () => {
		/** The checkout this test process is standing in — the command's own default. */
		const REPO_ROOT = process.cwd();
		const ARGV = [
			'register-and-enroll',
			IDENTIFIER,
			PROJECT_ID,
			'--name',
			'ada-laptop',
			'--cli',
			'claude',
		];

		it('resolves the provider, registers, credentials, and enrolls active + consenting', async () => {
			expect(await run(ARGV)).toBe(0);
			expect(pathsCalled()).toEqual([
				'workers.projectScmProvider',
				'workers.register',
				'workers.scmCredentials.set',
				'workers.enroll',
				'workers.approveEnrollment',
				'workers.setConsent',
			]);
			expect(inputFor('workers.scmCredentials.set')).toEqual({
				workerId: WORKER_ID,
				providerId: 'github',
				value: 'piped-secret',
			});
			expect(inputFor('workers.setConsent')).toEqual({
				enrollmentId: ENROLLMENT_ID,
				sharingConsent: true,
			});
		});

		// Enrolling your own machine in a project you administer already arrives
		// active and consenting (issue #784), so neither extra call is spent.
		it('spends no approval call when the enrollment already comes back routable', async () => {
			answers.set('workers.enroll', (input) => ({
				id: ENROLLMENT_ID,
				status: 'active',
				allowedClis: input.allowedClis,
				concurrencyAllocation: 1,
				sharingConsent: true,
			}));
			expect(await run(ARGV)).toBe(0);
			expect(pathsCalled()).not.toContain('workers.approveEnrollment');
			expect(pathsCalled()).not.toContain('workers.setConsent');
			expect(lines().some((line) => line.includes('sharing consent on'))).toBe(true);
		});

		// It prints the start command rather than running it: the daemon stays a
		// foreground, operator-owned process, so the suite mocks no process spawner and
		// the command must not need one.
		it('ends with the ready-to-run start command', async () => {
			expect(await run(ARGV)).toBe(0);
			const printed = lines();
			const last = printed[printed.length - 1] ?? '';
			expect(last).toContain('SWARM_WORKER_CREDENTIAL=raw-credential-token');
			expect(last).toContain(`SWARM_WORKER_REPO_ROOT=${REPO_ROOT}`);
			expect(last).toContain('npm run dev:worker');
		});

		it('caches the credential for the resolved worker checkout and names the file, not the value', async () => {
			expect(await run(ARGV)).toBe(0);
			expect(writeWorkerCredentialCache).toHaveBeenCalledExactlyOnceWith({
				repoRoot: REPO_ROOT,
				workerId: WORKER_ID,
				credential: 'raw-credential-token',
			});
			const cacheLine = lines().find((line) => line.includes('run:worker')) ?? '';
			expect(cacheLine).toContain('/home/ada/.swarm/worker-credentials/deadbeef/credential.json');
			expect(cacheLine).not.toContain('raw-credential-token');
		});

		it('does not invite a local start when the worker checkout is not on this machine', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run([...ARGV, '--repo-root', '/remote/ada/myapp'])).toBe(0);
			expect(writeWorkerCredentialCache).toHaveBeenCalledExactlyOnceWith({
				repoRoot: '/remote/ada/myapp',
				workerId: WORKER_ID,
				credential: 'raw-credential-token',
			});
			expect(log).not.toHaveBeenCalledWith(expect.stringContaining('swarm run:worker'));
		});

		// `--repo-root` outranks the invoking checkout, which is otherwise the default
		// (issue #796) — that is what makes onboarding a machine from elsewhere possible.
		it('keys the cache to an explicit worker checkout', async () => {
			const repoRoot = `${process.cwd()}/src`;
			process.env.INIT_CWD = '/where/the/operator/is/standing';
			expect(await run([...ARGV, '--repo-root', repoRoot])).toBe(0);
			expect(writeWorkerCredentialCache).toHaveBeenCalledExactlyOnceWith({
				repoRoot,
				workerId: WORKER_ID,
				credential: 'raw-credential-token',
			});
		});

		it('warns but still completes when the cache cannot be written', async () => {
			writeWorkerCredentialCache.mockImplementation(() => {
				throw new Error('EACCES: permission denied');
			});
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			expect(await run(ARGV)).toBe(0);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not cache the credential'));
			const printed = lines();
			expect(printed.filter((line) => line.includes('raw-credential-token'))).toHaveLength(1);
			expect(printed[printed.length - 1]).toContain('npm run dev:worker');
		});

		it('prints the worker credential exactly once and never echoes the operator secret', async () => {
			expect(await run(ARGV)).toBe(0);
			const printed = lines();
			expect(printed.filter((line) => line.includes('raw-credential-token'))).toHaveLength(1);
			expect(printed.some((line) => line.includes('piped-secret'))).toBe(false);
		});

		// The provider comes from the project, never from a `?? 'github'` fallback.
		it('stores the credential under the provider the project names, not GitHub', async () => {
			answers.set('workers.projectScmProvider', () => ({ providerId: 'bitbucket' }));
			expect(await run(ARGV)).toBe(0);
			expect(inputFor('workers.scmCredentials.set')).toMatchObject({ providerId: 'bitbucket' });
		});

		// The ordering guarantee, restated for the networked calls: everything that can
		// fail without writing runs before `workers.register`.
		it('refuses a project whose SCM provider does not resolve, before writing anything', async () => {
			refuse(
				'workers.projectScmProvider',
				`Project '${PROJECT_ID}' selects no SCM provider and 3 are runtime-ready`,
			);
			const error = vi.spyOn(console, 'error');
			expect(await run(ARGV)).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining(PROJECT_ID));
			expect(pathsCalled()).toEqual(['workers.projectScmProvider']);
			expect(readStdin).not.toHaveBeenCalled();
		});

		it('requires an owner identifier, a project id, --name, and --cli', async () => {
			expect(await run(['register-and-enroll'])).toBe(1);
			expect(await run(['register-and-enroll', IDENTIFIER])).toBe(1);
			expect(await run(['register-and-enroll', IDENTIFIER, PROJECT_ID, '--cli', 'claude'])).toBe(1);
			expect(
				await run(['register-and-enroll', IDENTIFIER, PROJECT_ID, '--name', 'ada-laptop']),
			).toBe(1);
			expect(calls).toHaveLength(0);
			expect(readStdin).not.toHaveBeenCalled();
		});

		it('rejects an invalid CLI before reaching the control plane', async () => {
			expect(
				await run([
					'register-and-enroll',
					IDENTIFIER,
					PROJECT_ID,
					'--name',
					'ada-laptop',
					'--cli',
					'claude,vim',
				]),
			).toBe(1);
			expect(calls).toHaveLength(0);
		});

		// The ordering guarantee: the secret is read before the first write, so an
		// empty (or aborted) one leaves no worker row behind.
		it('rejects an empty secret before registering the worker', async () => {
			readStdin.mockResolvedValue('   \n');
			expect(await run(ARGV)).toBe(1);
			expect(pathsCalled()).toEqual(['workers.projectScmProvider']);
		});

		it('surfaces a duplicate worker name and stores no credential', async () => {
			refuse(
				'workers.register',
				'A worker named "ada-laptop" already exists for "ada@example.com".',
			);
			const error = vi.spyOn(console, 'error');
			expect(await run(ARGV)).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('already exists'));
			expect(pathsCalled()).not.toContain('workers.scmCredentials.set');
		});

		// An enroll refusal is surfaced verbatim, and the one-time worker credential is
		// still handed over — losing it would mean remove + register again.
		it('surfaces an enroll refusal and still hands over the credential once', async () => {
			refuse(
				'workers.enroll',
				"Worker 11111111's checkout is acme/frontend, but project proj-a is acme/backend",
			);
			const error = vi.spyOn(console, 'error');
			expect(await run(ARGV)).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('acme/frontend'));
			expect(error).toHaveBeenCalledWith(expect.stringContaining('acme/backend'));
			const printed = lines();
			expect(printed.filter((line) => line.includes('raw-credential-token'))).toHaveLength(1);
			expect(printed.some((line) => line.includes('workers enroll'))).toBe(true);
		});

		// The other half of that: `workers.enroll` *succeeded* and only the projectAdmin
		// approval on top of it was refused — the enrollment exists, so re-running
		// `workers enroll` could only answer CONFLICT. Name the two approvals instead,
		// and still hand the one-time credential over exactly once.
		it('names the outstanding approvals, not another enroll, when --active is refused', async () => {
			refuse(
				'workers.approveEnrollment',
				'You do not have permission to perform this action on project "proj-a".',
			);
			const error = vi.spyOn(console, 'error');
			expect(await run(ARGV)).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('do not have permission'));
			const printed = lines();
			const created = printed.find((line) => line.includes('the enrollment was created')) ?? '';
			expect(created).toContain('status pending');
			expect(created).toContain('sharing consent off');
			expect(
				printed.some((line) => line.endsWith(`swarm workers approve ${WORKER_ID} ${PROJECT_ID}`)),
			).toBe(true);
			expect(
				printed.some((line) =>
					line.endsWith(`swarm workers consent ${WORKER_ID} ${PROJECT_ID} on`),
				),
			).toBe(true);
			expect(printed.some((line) => line.includes('swarm workers enroll'))).toBe(false);
			expect(printed.filter((line) => line.includes('raw-credential-token'))).toHaveLength(1);
		});

		it('hands over the credential and the remaining steps when the credential write fails', async () => {
			refuse(
				'workers.scmCredentials.set',
				'That credential did not resolve to a GitHub account, so nothing was stored.',
			);
			expect(await run(ARGV)).toBe(1);
			expect(pathsCalled()).not.toContain('workers.enroll');
			const printed = lines();
			expect(printed.filter((line) => line.includes('raw-credential-token'))).toHaveLength(1);
			expect(printed.some((line) => line.includes('set-scm-credential'))).toBe(true);
			expect(printed.some((line) => line.includes('workers enroll'))).toBe(true);
		});

		it('prints --repo-root instead of the invoking checkout when given', async () => {
			expect(await run([...ARGV, '--repo-root', '/opt/checkouts/swarm'])).toBe(0);
			const printed = lines();
			const last = printed[printed.length - 1] ?? '';
			expect(last).toContain('SWARM_WORKER_REPO_ROOT=/opt/checkouts/swarm');
			expect(last).not.toContain(REPO_ROOT);
		});

		it("defaults to npm's caller directory", async () => {
			const invocationDirectory = `${process.cwd()}/src`;
			process.env.INIT_CWD = invocationDirectory;

			expect(await run(ARGV)).toBe(0);
			expect(writeWorkerCredentialCache).toHaveBeenCalledExactlyOnceWith({
				repoRoot: invocationDirectory,
				workerId: WORKER_ID,
				credential: 'raw-credential-token',
			});
			const printed = lines();
			expect(printed[printed.length - 1] ?? '').toContain(
				`SWARM_WORKER_REPO_ROOT=${invocationDirectory}`,
			);
		});

		it('falls back to the current directory when there is no INIT_CWD', async () => {
			delete process.env.INIT_CWD;
			expect(await run(ARGV)).toBe(0);
			expect(writeWorkerCredentialCache).toHaveBeenCalledExactlyOnceWith({
				repoRoot: REPO_ROOT,
				workerId: WORKER_ID,
				credential: 'raw-credential-token',
			});
		});

		it('describes itself in --help without writing anything', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(['register-and-enroll', '--help'])).toBe(0);
			expect(log).toHaveBeenCalledWith(expect.stringContaining('register-and-enroll'));
			expect(calls).toHaveLength(0);
			expect(readStdin).not.toHaveBeenCalled();
		});
	});

	describe('list', () => {
		it("reads the caller's own machines through listMine, which needs no admin", async () => {
			answers.set('workers.listMine', () => [
				{ workerId: WORKER_ID, displayName: 'ada-laptop', capabilities: ['claude', 'codex'] },
			]);
			const log = vi.spyOn(console, 'log');
			expect(await run(['list', IDENTIFIER])).toBe(0);
			expect(pathsCalled()).toEqual(['workers.listMine']);
			expect(log).toHaveBeenCalledWith(expect.stringContaining('ada-laptop'));
			expect(lines().join('\n')).not.toMatch(/credential|hash/i);
		});

		it('matches the signed-in handle regardless of case', async () => {
			expect(await run(['list', 'Ada@Example.com'])).toBe(0);
			expect(pathsCalled()).toEqual(['workers.listMine']);
		});

		it("filters the installation roster client-side for another owner's machines", async () => {
			answers.set('workers.list', () => [
				{
					workerId: WORKER_ID,
					displayName: 'ada-laptop',
					capabilities: ['claude'],
					owner: { identifier: IDENTIFIER },
				},
				{
					workerId: '22222222-2222-4222-8222-222222222222',
					displayName: 'grace-desktop',
					capabilities: ['codex'],
					owner: { identifier: 'grace@example.com' },
				},
			]);
			const log = vi.spyOn(console, 'log');
			expect(await run(['list', 'grace@example.com'])).toBe(0);
			expect(pathsCalled()).toEqual(['workers.list']);
			expect(log).toHaveBeenCalledWith(expect.stringContaining('grace-desktop'));
			expect(lines().some((line) => line.includes('ada-laptop'))).toBe(false);
		});

		it('lists every owner when no identifier is given, prefixed by owner', async () => {
			answers.set('workers.list', () => [
				{
					workerId: WORKER_ID,
					displayName: 'ada-laptop',
					capabilities: ['claude'],
					owner: { identifier: IDENTIFIER },
				},
			]);
			const log = vi.spyOn(console, 'log');
			expect(await run(['list'])).toBe(0);
			expect(log).toHaveBeenCalledWith(expect.stringContaining(IDENTIFIER));
		});

		// The unscoped roster is admin-only (issue #647); the refusal is the server's.
		it('surfaces the installation-admin refusal for a roster read', async () => {
			refuse('workers.list', 'Open a project you are enrolled in to see its workers.');
			const error = vi.spyOn(console, 'error');
			expect(await run(['list'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('Open a project'));
		});

		it('reports an owner with no visible workers rather than failing', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(['list', 'nobody@example.com'])).toBe(0);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("no workers for 'nobody@example.com'"),
			);
		});

		it('reports an empty installation roster', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(['list'])).toBe(0);
			expect(log).toHaveBeenCalledWith(expect.stringContaining('no workers'));
		});
	});

	describe('set-cli', () => {
		// Issue #783: it writes the owner's *declaration*, not the probe a handshake
		// refreshes — which is the whole reason the statement now survives a reconnect.
		it('declares a worker CLI set by id', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(['set-cli', WORKER_ID, '--cli', 'codex'])).toBe(0);
			expect(inputFor('workers.setDeclaredCapabilities')).toEqual({
				workerId: WORKER_ID,
				capabilities: ['codex'],
			});
			expect(log.mock.calls.flat().join('\n')).toContain('survives the machine');
		});

		it('clears the declaration with --auto', async () => {
			expect(await run(['set-cli', WORKER_ID, '--auto'])).toBe(0);
			expect(inputFor('workers.setDeclaredCapabilities')).toEqual({
				workerId: WORKER_ID,
				capabilities: null,
			});
		});

		it('requires one of --cli or --auto', async () => {
			expect(await run(['set-cli', WORKER_ID])).toBe(1);
			expect(calls).toHaveLength(0);
		});

		it('refuses --cli and --auto together rather than letting argument order decide', async () => {
			expect(await run(['set-cli', WORKER_ID, '--cli', 'codex', '--auto'])).toBe(1);
			expect(calls).toHaveLength(0);
		});

		// The procedures type `workerId` as a uuid, so a display name typed in its
		// place is refused here rather than coming back as an input-schema dump.
		it('refuses a worker id that is not a uuid without a round trip', async () => {
			const error = vi.spyOn(console, 'error');
			expect(await run(['set-cli', 'ada-laptop', '--cli', 'claude'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining("no worker with id 'ada-laptop'"));
			expect(calls).toHaveLength(0);
		});

		it('surfaces an unknown or someone-elses worker as the control plane words it', async () => {
			refuse('workers.setDeclaredCapabilities', `Worker with ID "${WORKER_ID}" not found`);
			const error = vi.spyOn(console, 'error');
			expect(await run(['set-cli', WORKER_ID, '--cli', 'claude'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('not found'));
		});

		it('surfaces a capability reduction refusal and exits 1', async () => {
			refuse('workers.setDeclaredCapabilities', 'Cannot update capabilities: claude');
			const error = vi.spyOn(console, 'error');
			expect(await run(['set-cli', WORKER_ID, '--cli', 'codex'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('Cannot update capabilities'));
		});

		it('surfaces a not-probed refusal and exits 1', async () => {
			refuse('workers.setDeclaredCapabilities', 'Cannot declare CLIs: codex (probed: claude)');
			const error = vi.spyOn(console, 'error');
			expect(await run(['set-cli', WORKER_ID, '--cli', 'codex'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('Cannot declare CLIs'));
		});
	});

	describe('set-scm-credential', () => {
		it('stores the trimmed secret for the (worker, provider) pair, printing no preview', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(['set-scm-credential', WORKER_ID, 'bitbucket'])).toBe(0);
			expect(inputFor('workers.scmCredentials.set')).toEqual({
				workerId: WORKER_ID,
				providerId: 'bitbucket',
				value: 'piped-secret',
			});
			// It confirms the write and the account it resolved to, and nothing else — a
			// preview of an operator secret in a terminal scrollback is the thing this
			// command exists to avoid.
			const printed = log.mock.calls.flat().join('\n');
			expect(printed).toContain("stored operator scm credential for worker 'ada-laptop'");
			expect(printed).toContain('ada-bot');
			expect(printed).not.toContain('piped-secret');
		});

		// The prompt names the machine, which is why the detail is read before it.
		it('names the worker in the prompt on a TTY', async () => {
			const isTTY = process.stdin.isTTY;
			Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
			try {
				expect(await run(['set-scm-credential', WORKER_ID, 'github'])).toBe(0);
				expect(promptHidden).toHaveBeenCalledWith(
					expect.stringContaining("Operator github credential for 'ada-laptop'"),
				);
			} finally {
				Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
			}
		});

		it('rejects an unknown SCM provider id without a round trip', async () => {
			expect(await run(['set-scm-credential', WORKER_ID, 'perforce'])).toBe(1);
			expect(calls).toHaveLength(0);
		});

		it('surfaces a worker the caller does not own', async () => {
			refuse('workers.getById', `Worker with ID "${WORKER_ID}" not found`);
			const error = vi.spyOn(console, 'error');
			expect(await run(['set-scm-credential', WORKER_ID, 'github'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('not found'));
			expect(readStdin).not.toHaveBeenCalled();
		});

		it('rejects an empty secret', async () => {
			readStdin.mockResolvedValue('   \n');
			expect(await run(['set-scm-credential', WORKER_ID, 'github'])).toBe(1);
			expect(pathsCalled()).not.toContain('workers.scmCredentials.set');
		});

		// Verified against the provider before it is stored (issue #766's contract).
		it('surfaces a credential the provider does not recognise', async () => {
			refuse(
				'workers.scmCredentials.set',
				'That credential did not resolve to a GitHub account, so nothing was stored.',
			);
			const error = vi.spyOn(console, 'error');
			expect(await run(['set-scm-credential', WORKER_ID, 'github'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('did not resolve'));
		});

		it('requires both a worker id and a provider id', async () => {
			expect(await run(['set-scm-credential', WORKER_ID])).toBe(1);
			expect(calls).toHaveLength(0);
		});
	});

	describe('remove', () => {
		it('removes a worker by id', async () => {
			expect(await run(['remove', WORKER_ID])).toBe(0);
			expect(inputFor('workers.remove')).toEqual({ workerId: WORKER_ID });
		});

		it('surfaces a missing worker', async () => {
			refuse('workers.remove', `Worker with ID "${WORKER_ID}" not found`);
			expect(await run(['remove', WORKER_ID])).toBe(1);
		});

		// Issue #800's second narrowing: `workers.remove` blocks a machine mid-run,
		// where the direct-DB delete did not.
		it('surfaces the busy-worker refusal as the control plane words it', async () => {
			refuse(
				'workers.remove',
				'This worker is running a job right now. Wait for it to finish, or stop the run, before deleting the worker.',
			);
			const error = vi.spyOn(console, 'error');
			expect(await run(['remove', WORKER_ID])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('running a job right now'));
		});
	});

	describe('enroll', () => {
		it('enrolls a worker into a project with allowed CLIs', async () => {
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(0);
			expect(inputFor('workers.enroll')).toEqual({
				workerId: WORKER_ID,
				projectId: PROJECT_ID,
				allowedClis: ['claude'],
				concurrencyAllocation: undefined,
			});
			// Neither flag was asked for, so neither approval call is spent.
			expect(pathsCalled()).toEqual(['workers.getById', 'workers.enroll']);
		});

		it('seeds an active, consenting enrollment with --active --consent', async () => {
			const log = vi.spyOn(console, 'log');
			expect(
				await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude', '--active', '--consent']),
			).toBe(0);
			expect(pathsCalled()).toEqual([
				'workers.getById',
				'workers.enroll',
				'workers.approveEnrollment',
				'workers.setConsent',
			]);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining('status active, CLIs claude, concurrency 1, sharing consent on'),
			);
		});

		it('requires worker id, project id, and --cli', async () => {
			expect(await run(['enroll', WORKER_ID, PROJECT_ID])).toBe(1);
			expect(await run(['enroll', WORKER_ID])).toBe(1);
			expect(calls).toHaveLength(0);
		});

		it('rejects a non-positive or empty --concurrency without a round trip', async () => {
			expect(
				await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude', '--concurrency', '0']),
			).toBe(1);
			// Issue #480: an empty value must not read as "clear the allocation".
			expect(
				await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude', '--concurrency', '']),
			).toBe(1);
			expect(calls).toHaveLength(0);
		});

		it('leaves --concurrency to the service default and reports the stored allocation', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(0);
			expect(inputFor('workers.enroll')).toMatchObject({ concurrencyAllocation: undefined });
			expect(log).toHaveBeenCalledWith(expect.stringContaining('concurrency 1'));
		});

		it('passes an explicit --concurrency through for a wider worker', async () => {
			expect(
				await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude', '--concurrency', '3']),
			).toBe(0);
			expect(inputFor('workers.enroll')).toMatchObject({ concurrencyAllocation: 3 });
		});

		it('fails cleanly for a worker the caller cannot see', async () => {
			refuse('workers.getById', `Worker with ID "${WORKER_ID}" not found`);
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(1);
			expect(pathsCalled()).not.toContain('workers.enroll');
		});

		it('surfaces an unknown or inaccessible project', async () => {
			refuse('workers.enroll', `Project with ID "${PROJECT_ID}" not found`);
			const error = vi.spyOn(console, 'error');
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('not found'));
		});

		it('surfaces an out-of-capability CLI set', async () => {
			refuse('workers.enroll', 'not capable: antigravity');
			const error = vi.spyOn(console, 'error');
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'antigravity'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('not capable'));
		});

		// Issue #690 — the machine's checkout is not this project's repository. One
		// actionable line, the control plane's own message, and exit 1.
		it('surfaces a repository mismatch as a single actionable line', async () => {
			refuse('workers.enroll', 'checkout is acme/frontend, project is acme/backend');
			const error = vi.spyOn(console, 'error');
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('acme/frontend'));
			expect(error).toHaveBeenCalledWith(expect.stringContaining('acme/backend'));
		});

		it('surfaces a duplicate enrollment', async () => {
			refuse('workers.enroll', 'This worker is already enrolled in this project.');
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(1);
		});

		// The approval is a projectAdmin's, so `--active` can be refused after the
		// enrollment was created — that is reported rather than silently ignored. The
		// row survives the refusal, so the report has to say so: an operator told only
		// "not found" re-runs this command and gets CONFLICT.
		it('reports a refused --active without claiming the enrollment is routable', async () => {
			refuse('workers.approveEnrollment', `Enrollment with ID "${ENROLLMENT_ID}" not found`);
			const error = vi.spyOn(console, 'error');
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude', '--active'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('not found'));
			expect(lines().some((line) => line.includes('enrolled worker'))).toBe(false);
			const created = lines().find((line) => line.includes('the enrollment was created')) ?? '';
			expect(created).toContain('status pending');
			expect(created).toContain('sharing consent off');
		});

		// The steps it names are the ones the refusal actually left outstanding —
		// never `workers enroll`, which from here can only answer CONFLICT.
		it('names the outstanding approvals after a refused --active, not another enroll', async () => {
			refuse('workers.approveEnrollment', `Enrollment with ID "${ENROLLMENT_ID}" not found`);
			expect(
				await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude', '--active', '--consent']),
			).toBe(1);
			const printed = lines();
			expect(
				printed.some((line) => line.endsWith(`swarm workers approve ${WORKER_ID} ${PROJECT_ID}`)),
			).toBe(true);
			expect(
				printed.some((line) =>
					line.endsWith(`swarm workers consent ${WORKER_ID} ${PROJECT_ID} on`),
				),
			).toBe(true);
			expect(printed.some((line) => line.includes('swarm workers enroll'))).toBe(false);
		});

		// `setConsent` is strictly the machine owner's — an installation admin seeding
		// somebody else's machine is refused here, with the approval already applied.
		it('reports a refused --consent and names only the consent step', async () => {
			refuse('workers.setConsent', `Enrollment with ID "${ENROLLMENT_ID}" not found`);
			expect(
				await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude', '--active', '--consent']),
			).toBe(1);
			const printed = lines();
			const created = printed.find((line) => line.includes('the enrollment was created')) ?? '';
			expect(created).toContain('status active');
			expect(created).toContain('sharing consent off');
			expect(
				printed.some((line) =>
					line.endsWith(`swarm workers consent ${WORKER_ID} ${PROJECT_ID} on`),
				),
			).toBe(true);
			expect(printed.some((line) => line.includes('swarm workers approve'))).toBe(false);
		});
	});

	describe('update-enrollment', () => {
		it('updates allowed CLIs without changing the stored concurrency', async () => {
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--cli', 'claude,codex'])).toBe(
				0,
			);
			expect(inputFor('workers.updateConstraints')).toEqual({
				enrollmentId: ENROLLMENT_ID,
				allowedClis: ['claude', 'codex'],
				concurrencyAllocation: undefined,
			});
		});

		it('updates concurrency without changing the allowed CLIs', async () => {
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--concurrency', '3'])).toBe(0);
			expect(inputFor('workers.updateConstraints')).toEqual({
				enrollmentId: ENROLLMENT_ID,
				allowedClis: undefined,
				concurrencyAllocation: 3,
			});
		});

		it('updates both constraints and reports the stored values', async () => {
			const log = vi.spyOn(console, 'log');
			expect(
				await run([
					'update-enrollment',
					WORKER_ID,
					PROJECT_ID,
					'--cli',
					'claude,codex',
					'--concurrency',
					'3',
				]),
			).toBe(0);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining('CLIs claude, codex, concurrency 3'),
			);
		});

		it('requires a worker, project, and at least one constraint flag', async () => {
			expect(await run(['update-enrollment'])).toBe(1);
			expect(await run(['update-enrollment', WORKER_ID])).toBe(1);
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID])).toBe(1);
			expect(calls).toHaveLength(0);
		});

		it('rejects invalid CLI and concurrency values before resolving an enrollment', async () => {
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--cli', 'claude,vim'])).toBe(
				1,
			);
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--concurrency', '0'])).toBe(1);
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--concurrency', ''])).toBe(1);
			expect(calls).toHaveLength(0);
		});

		// The `(worker, project)` pair is bridged to an enrollment id through
		// `workers.getById`, whose detail carries one per visible project.
		it('reports a pair that names no enrollment, in the wording it always used', async () => {
			answers.set('workers.getById', () => ({
				workerId: WORKER_ID,
				displayName: 'ada-laptop',
				enrollments: [],
			}));
			const error = vi.spyOn(console, 'error');
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(1);
			expect(error).toHaveBeenCalledWith(
				`swarm: no enrollment for worker '${WORKER_ID}' in '${PROJECT_ID}'`,
			);
			expect(pathsCalled()).not.toContain('workers.updateConstraints');
		});

		it('fails cleanly for a worker the caller cannot see', async () => {
			refuse('workers.getById', `Worker with ID "${WORKER_ID}" not found`);
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(1);
			expect(pathsCalled()).not.toContain('workers.updateConstraints');
		});

		it('surfaces an out-of-capability CLI set', async () => {
			refuse('workers.updateConstraints', 'not capable: antigravity');
			const error = vi.spyOn(console, 'error');
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--cli', 'antigravity'])).toBe(
				1,
			);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('not capable'));
		});
	});

	describe('approve', () => {
		it('approves an existing enrollment', async () => {
			expect(await run(['approve', WORKER_ID, PROJECT_ID])).toBe(0);
			expect(inputFor('workers.approveEnrollment')).toEqual({ enrollmentId: ENROLLMENT_ID });
		});

		it('fails cleanly when the pair names no enrollment', async () => {
			answers.set('workers.getById', () => ({
				workerId: WORKER_ID,
				displayName: 'ada-laptop',
				enrollments: [],
			}));
			expect(await run(['approve', WORKER_ID, PROJECT_ID])).toBe(1);
			expect(pathsCalled()).not.toContain('workers.approveEnrollment');
		});

		it('surfaces a project the caller does not administer', async () => {
			refuse('workers.approveEnrollment', `Enrollment with ID "${ENROLLMENT_ID}" not found`);
			expect(await run(['approve', WORKER_ID, PROJECT_ID])).toBe(1);
		});
	});

	describe('consent', () => {
		it('turns sharing consent on and off', async () => {
			expect(await run(['consent', WORKER_ID, PROJECT_ID, 'on'])).toBe(0);
			expect(inputFor('workers.setConsent')).toEqual({
				enrollmentId: ENROLLMENT_ID,
				sharingConsent: true,
			});
			calls.length = 0;
			expect(await run(['consent', WORKER_ID, PROJECT_ID, 'off'])).toBe(0);
			expect(inputFor('workers.setConsent')).toEqual({
				enrollmentId: ENROLLMENT_ID,
				sharingConsent: false,
			});
		});

		it('rejects a toggle other than on/off', async () => {
			expect(await run(['consent', WORKER_ID, PROJECT_ID, 'maybe'])).toBe(1);
			expect(calls).toHaveLength(0);
		});

		it('fails cleanly when the pair names no enrollment', async () => {
			answers.set('workers.getById', () => ({
				workerId: WORKER_ID,
				displayName: 'ada-laptop',
				enrollments: [],
			}));
			expect(await run(['consent', WORKER_ID, PROJECT_ID, 'on'])).toBe(1);
			expect(pathsCalled()).not.toContain('workers.setConsent');
		});
	});

	describe('dispatch', () => {
		it('returns 1 for an unknown subcommand without calling the control plane', async () => {
			expect(await run(['nope'])).toBe(1);
			expect(requireOperatorSession).not.toHaveBeenCalled();
		});

		it('returns 1 with no subcommand and 0 for explicit --help', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run([])).toBe(1);
			expect(await run(['--help'])).toBe(0);
			expect(log).toHaveBeenCalledWith(expect.stringContaining('update-enrollment'));
			expect(log).toHaveBeenCalledWith(expect.stringContaining('register-and-enroll'));
			// The requirement the usage states is the real one (issue #800).
			expect(log).toHaveBeenCalledWith(expect.stringContaining('Requires SWARM_CONTROL_PLANE_URL'));
			expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Requires DATABASE_URL'));
			expect(requireOperatorSession).not.toHaveBeenCalled();
		});

		// A genuine programming error must not be swallowed as an operator-facing line.
		it('lets a non-API failure crash rather than reporting exit 1', async () => {
			answers.set('workers.list', () => {
				throw new TypeError('boom');
			});
			await expect(run(['list'])).rejects.toThrow('boom');
		});
	});
});
