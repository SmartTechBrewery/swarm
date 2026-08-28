import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	registerWorker,
	declareWorkerCapabilities,
	listWorkersForOwner,
	getWorker,
	WorkerCapabilityNotProbedError,
	WorkerCapabilityReductionError,
} = vi.hoisted(() => {
	class WorkerCapabilityReductionError extends Error {
		constructor(
			public workerId: string,
			public offending: string[],
		) {
			super(`Cannot update capabilities: ${offending.join(', ')}`);
			this.name = 'WorkerCapabilityReductionError';
		}
	}
	class WorkerCapabilityNotProbedError extends Error {
		constructor(
			public workerId: string,
			public offending: string[],
			public probed: string[],
		) {
			super(`Cannot declare CLIs: ${offending.join(', ')} (probed: ${probed.join(', ')})`);
			this.name = 'WorkerCapabilityNotProbedError';
		}
	}
	return {
		registerWorker: vi.fn(),
		declareWorkerCapabilities: vi.fn(),
		listWorkersForOwner: vi.fn(),
		getWorker: vi.fn(),
		WorkerCapabilityNotProbedError,
		WorkerCapabilityReductionError,
	};
});
const { removeWorker } = vi.hoisted(() => ({ removeWorker: vi.fn() }));
const { writeWorkerScmCredential } = vi.hoisted(() => ({ writeWorkerScmCredential: vi.fn() }));
const { promptHidden, readStdin } = vi.hoisted(() => ({
	promptHidden: vi.fn(),
	readStdin: vi.fn(),
}));
const { findUserByIdentifier, listUsers } = vi.hoisted(() => ({
	findUserByIdentifier: vi.fn(),
	listUsers: vi.fn(),
}));
const { closeDb } = vi.hoisted(() => ({ closeDb: vi.fn() }));
const { writeWorkerCredentialCache } = vi.hoisted(() => ({ writeWorkerCredentialCache: vi.fn() }));
const { findProjectByIdFromDb } = vi.hoisted(() => ({ findProjectByIdFromDb: vi.fn() }));
const { getEnrollment } = vi.hoisted(() => ({ getEnrollment: vi.fn() }));
const {
	enrollWorker,
	approveEnrollment,
	setSharingConsent,
	updateEnrollmentConstraints,
	AllowedClisNotCapableError,
	EnrollmentRepositoryMismatchError,
} = vi.hoisted(() => {
	class AllowedClisNotCapableError extends Error {
		constructor(
			public workerId: string,
			public offending: string[],
		) {
			super(`not capable: ${offending.join(', ')}`);
			this.name = 'AllowedClisNotCapableError';
		}
	}
	class EnrollmentRepositoryMismatchError extends Error {
		constructor(
			public workerId: string,
			public declaredRepository: string,
			public projectRepository: string,
		) {
			super(`checkout is ${declaredRepository}, project is ${projectRepository}`);
			this.name = 'EnrollmentRepositoryMismatchError';
		}
	}
	return {
		enrollWorker: vi.fn(),
		approveEnrollment: vi.fn(),
		setSharingConsent: vi.fn(),
		updateEnrollmentConstraints: vi.fn(),
		AllowedClisNotCapableError,
		EnrollmentRepositoryMismatchError,
	};
});

vi.mock('@/identity/worker-service.js', () => ({
	registerWorker,
	declareWorkerCapabilities,
	listWorkersForOwner,
	getWorker,
	WorkerCapabilityNotProbedError,
	WorkerCapabilityReductionError,
}));
vi.mock('@/identity/worker-enrollment-service.js', () => ({
	enrollWorker,
	approveEnrollment,
	setSharingConsent,
	updateEnrollmentConstraints,
	AllowedClisNotCapableError,
	EnrollmentRepositoryMismatchError,
}));
vi.mock('@/db/repositories/workersRepository.js', () => ({ removeWorker }));
vi.mock('@/db/repositories/workerScmCredentialsRepository.js', () => ({
	writeWorkerScmCredential,
}));
vi.mock('@/cli/_shared/secret-input.js', () => ({ promptHidden, readStdin }));
vi.mock('@/db/repositories/usersRepository.js', () => ({ findUserByIdentifier, listUsers }));
vi.mock('@/db/repositories/projectsRepository.js', () => ({ findProjectByIdFromDb }));
vi.mock('@/db/repositories/workerEnrollmentsRepository.js', () => ({ getEnrollment }));
vi.mock('@/db/client.js', () => ({ closeDb }));
vi.mock('@/cli/_shared/worker-credential-cache.js', () => ({ writeWorkerCredentialCache }));

// The real manifests, so `register-and-enroll` resolves the provider a dispatch
// would actually resolve rather than a fixture's. Deliberately not a mock of
// `@/integrations/scm/registry.js`: the entrypoint registers *into* that registry,
// so mocking it would fight the import and assert nothing real.
import '@/integrations/entrypoint.js';
import { run } from '@/cli/commands/workers.js';
import { createMockProjectConfig } from '../../../helpers/factories.js';

const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = 'proj-a';

function makeUser(overrides: Record<string, unknown> = {}) {
	return {
		id: OWNER_ID,
		identifier: 'ada@example.com',
		displayName: 'Ada Lovelace',
		instanceAdmin: false,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function makeWorker(overrides: Record<string, unknown> = {}) {
	return {
		id: WORKER_ID,
		ownerUserId: OWNER_ID,
		displayName: 'ada-laptop',
		capabilities: ['claude'],
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

describe('swarm workers', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		registerWorker.mockReset().mockImplementation(async (input) => ({
			worker: makeWorker({ displayName: input.displayName, capabilities: input.capabilities }),
			credential: 'raw-credential-token',
		}));
		declareWorkerCapabilities
			.mockReset()
			.mockImplementation(async (id, capabilities) =>
				makeWorker({ id, capabilities: capabilities ?? ['claude', 'codex'] }),
			);
		listWorkersForOwner.mockReset().mockResolvedValue([]);
		removeWorker.mockReset().mockResolvedValue(true);
		writeWorkerScmCredential.mockReset().mockResolvedValue(undefined);
		// Non-TTY is the shape a test process actually has, so the command reads stdin.
		promptHidden.mockReset().mockResolvedValue('typed-secret');
		readStdin.mockReset().mockResolvedValue('  piped-secret\n');
		findUserByIdentifier.mockReset().mockResolvedValue(makeUser());
		listUsers.mockReset().mockResolvedValue([makeUser()]);
		closeDb.mockReset().mockResolvedValue(undefined);
		writeWorkerCredentialCache
			.mockReset()
			.mockReturnValue('/home/ada/.swarm/worker-credentials/deadbeef/credential.json');
		getWorker.mockReset().mockResolvedValue(makeWorker());
		findProjectByIdFromDb.mockReset().mockResolvedValue({ id: PROJECT_ID });
		getEnrollment
			.mockReset()
			.mockResolvedValue({ id: 'enr-1', workerId: WORKER_ID, projectId: PROJECT_ID });
		enrollWorker.mockReset().mockImplementation(async (input) => ({
			id: 'enr-1',
			workerId: input.worker.id,
			projectId: input.projectId,
			status: input.status ?? 'pending',
			allowedClis: input.allowedClis,
			concurrencyAllocation: input.concurrencyAllocation ?? 1,
			sharingConsent: input.sharingConsent ?? false,
		}));
		approveEnrollment.mockReset().mockResolvedValue({ id: 'enr-1', status: 'active' });
		setSharingConsent.mockReset().mockResolvedValue({ id: 'enr-1', sharingConsent: false });
		updateEnrollmentConstraints.mockReset().mockImplementation(async (input) => ({
			id: input.enrollmentId,
			workerId: WORKER_ID,
			projectId: PROJECT_ID,
			status: 'active',
			allowedClis: input.allowedClis ?? ['claude'],
			concurrencyAllocation: input.concurrencyAllocation ?? 1,
			sharingConsent: true,
		}));
	});

	describe('register', () => {
		it('registers a worker and prints the credential exactly once', async () => {
			const log = vi.spyOn(console, 'log');
			expect(
				await run(['register', 'ada@example.com', '--name', 'ada-laptop', '--cli', 'claude,codex']),
			).toBe(0);
			expect(registerWorker).toHaveBeenCalledWith({
				ownerUserId: OWNER_ID,
				displayName: 'ada-laptop',
				capabilities: ['claude', 'codex'],
			});
			const credentialLines = log.mock.calls.filter(([line]) =>
				String(line).includes('raw-credential-token'),
			);
			expect(credentialLines).toHaveLength(1);
			// Printing stays *and* the credential is cached for this checkout (issue #788).
			expect(writeWorkerCredentialCache).toHaveBeenCalledExactlyOnceWith({
				repoRoot: process.cwd(),
				workerId: WORKER_ID,
				credential: 'raw-credential-token',
			});
			expect(closeDb).toHaveBeenCalledOnce();
		});

		it('names the cache file it wrote without putting the credential on that line', async () => {
			const log = vi.spyOn(console, 'log');
			expect(
				await run(['register', 'ada@example.com', '--name', 'ada-laptop', '--cli', 'claude']),
			).toBe(0);
			const lines = log.mock.calls.map(([line]) => String(line));
			const cacheLine = lines.find((line) => line.includes('credential.json')) ?? '';
			expect(cacheLine).toContain('/home/ada/.swarm/worker-credentials/deadbeef/credential.json');
			expect(cacheLine).toContain('swarm run:worker');
			expect(cacheLine).not.toContain('raw-credential-token');
			// Still exactly one line carrying the secret, and still the last one.
			expect(lines.filter((line) => line.includes('raw-credential-token'))).toHaveLength(1);
			expect(lines[lines.length - 1]).toContain('raw-credential-token');
		});

		// The credential is issued and about to be printed; a cache the operator can
		// re-create by re-registering must never strand a registered worker.
		it('warns but still succeeds when the cache cannot be written', async () => {
			writeWorkerCredentialCache.mockImplementation(() => {
				throw new Error('EACCES: permission denied');
			});
			const log = vi.spyOn(console, 'log');
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			expect(
				await run(['register', 'ada@example.com', '--name', 'ada-laptop', '--cli', 'claude']),
			).toBe(0);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not cache the credential'));
			const lines = log.mock.calls.map(([line]) => String(line));
			expect(lines.filter((line) => line.includes('raw-credential-token'))).toHaveLength(1);
			expect(lines[lines.length - 1]).toContain('raw-credential-token');
		});

		it('hands the operator off to the dashboard for the SCM credential, naming no provider and reading no secret', async () => {
			const log = vi.spyOn(console, 'log');
			expect(
				await run(['register', 'ada@example.com', '--name', 'ada-laptop', '--cli', 'claude']),
			).toBe(0);
			const lines = log.mock.calls.map(([line]) => String(line));
			expect(lines.some((line) => line.includes('cannot run a phase'))).toBe(true);
			expect(
				lines.some(
					(line) =>
						line.includes(`/workers/${WORKER_ID}`) &&
						line.includes('Operator source-control credential'),
				),
			).toBe(true);
			// Provider-agnostic and non-interactive: no provider is named, and nothing is read.
			expect(lines.some((line) => /github|gitlab|bitbucket/i.test(line))).toBe(false);
			expect(promptHidden).not.toHaveBeenCalled();
			expect(readStdin).not.toHaveBeenCalled();
			expect(writeWorkerScmCredential).not.toHaveBeenCalled();
		});

		it('describes the hand-off in --help without registering anything', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(['register', '--help'])).toBe(0);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining('Operator source-control credential'),
			);
			expect(registerWorker).not.toHaveBeenCalled();
		});

		it('requires an owner identifier, a name, and a cli list', async () => {
			expect(await run(['register'])).toBe(1);
			expect(await run(['register', 'ada@example.com'])).toBe(1);
			expect(await run(['register', 'ada@example.com', '--name', 'ada-laptop'])).toBe(1);
			expect(registerWorker).not.toHaveBeenCalled();
		});

		it('rejects an invalid CLI without hitting the service', async () => {
			expect(
				await run(['register', 'ada@example.com', '--name', 'ada-laptop', '--cli', 'claude,vim']),
			).toBe(1);
			expect(registerWorker).not.toHaveBeenCalled();
		});

		it('fails for an unknown owner', async () => {
			findUserByIdentifier.mockResolvedValue(undefined);
			expect(await run(['register', 'nobody', '--name', 'ada-laptop', '--cli', 'claude'])).toBe(1);
			expect(registerWorker).not.toHaveBeenCalled();
		});

		it('translates a duplicate worker name to a friendly error', async () => {
			registerWorker.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
			const error = vi.spyOn(console, 'error');
			expect(
				await run(['register', 'ada@example.com', '--name', 'ada-laptop', '--cli', 'claude']),
			).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('already exists'));
			expect(closeDb).toHaveBeenCalledOnce();
		});
	});

	// Issue #786 — the composite: register + operator credential + enroll, ending in
	// the exact command that starts the daemon. It composes the three commands above,
	// so what is asserted here is the *ordering* and the credential handling.
	describe('register-and-enroll', () => {
		const REPO_ROOT = '/Users/dev/swarm/swarm';
		const ARGV = [
			'register-and-enroll',
			'ada@example.com',
			PROJECT_ID,
			'--name',
			'ada-laptop',
			'--cli',
			'claude',
		];

		beforeEach(() => {
			// The suite's global fixture is a bare `{ id }` with no `scm`, which would
			// exercise the registry's "selects no provider" throw in every case here.
			findProjectByIdFromDb.mockResolvedValue(
				createMockProjectConfig({ id: PROJECT_ID, scm: 'github', repoRoot: REPO_ROOT }),
			);
		});

		it('registers, stores the credential for the resolved provider, and enrolls active + consenting', async () => {
			expect(await run(ARGV)).toBe(0);
			expect(registerWorker).toHaveBeenCalledWith({
				ownerUserId: OWNER_ID,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
			});
			expect(writeWorkerScmCredential).toHaveBeenCalledWith(WORKER_ID, 'github', 'piped-secret');
			expect(enrollWorker).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: PROJECT_ID,
					allowedClis: ['claude'],
					status: 'active',
					sharingConsent: true,
				}),
			);
			expect(closeDb).toHaveBeenCalledOnce();
		});

		// It prints the start command rather than running it: the daemon stays a
		// foreground, operator-owned process, so the suite mocks no process spawner and
		// the command must not need one.
		it('ends with the ready-to-run start command', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(ARGV)).toBe(0);
			const lines = log.mock.calls.map(([line]) => String(line));
			const last = lines[lines.length - 1] ?? '';
			expect(last).toContain('SWARM_WORKER_CREDENTIAL=raw-credential-token');
			expect(last).toContain(`SWARM_WORKER_REPO_ROOT=${REPO_ROOT}`);
			expect(last).toContain('npm run dev:worker');
		});

		// #786's command registers through its own code path, so it needs its own
		// assertion that the cache is written — a worker made the recommended way must
		// be findable by `run:worker` too.
		it('caches the credential for this checkout and names the file, not the value', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(ARGV)).toBe(0);
			expect(writeWorkerCredentialCache).toHaveBeenCalledExactlyOnceWith({
				repoRoot: process.cwd(),
				workerId: WORKER_ID,
				credential: 'raw-credential-token',
			});
			const cacheLine =
				log.mock.calls.map(([line]) => String(line)).find((line) => line.includes('run:worker')) ??
				'';
			expect(cacheLine).toContain('/home/ada/.swarm/worker-credentials/deadbeef/credential.json');
			expect(cacheLine).not.toContain('raw-credential-token');
		});

		it('warns but still completes when the cache cannot be written', async () => {
			writeWorkerCredentialCache.mockImplementation(() => {
				throw new Error('EACCES: permission denied');
			});
			const log = vi.spyOn(console, 'log');
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			expect(await run(ARGV)).toBe(0);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not cache the credential'));
			const lines = log.mock.calls.map(([line]) => String(line));
			expect(lines.filter((line) => line.includes('raw-credential-token'))).toHaveLength(1);
			expect(lines[lines.length - 1]).toContain('npm run dev:worker');
		});

		it('prints the worker credential exactly once and never echoes the operator secret', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(ARGV)).toBe(0);
			const lines = log.mock.calls.map(([line]) => String(line));
			expect(lines.filter((line) => line.includes('raw-credential-token'))).toHaveLength(1);
			expect(lines.some((line) => line.includes('piped-secret'))).toBe(false);
		});

		// The provider comes from the project, never from a `?? 'github'` fallback.
		it('stores the credential under the provider the project names, not GitHub', async () => {
			findProjectByIdFromDb.mockResolvedValue(
				createMockProjectConfig({ id: PROJECT_ID, scm: 'bitbucket', repoRoot: REPO_ROOT }),
			);
			expect(await run(ARGV)).toBe(0);
			expect(writeWorkerScmCredential).toHaveBeenCalledWith(WORKER_ID, 'bitbucket', 'piped-secret');
		});

		it('refuses a project whose SCM provider does not resolve, before writing anything', async () => {
			findProjectByIdFromDb.mockResolvedValue(
				createMockProjectConfig({ id: PROJECT_ID, scm: undefined, repoRoot: REPO_ROOT }),
			);
			const error = vi.spyOn(console, 'error');
			expect(await run(ARGV)).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining(PROJECT_ID));
			expect(registerWorker).not.toHaveBeenCalled();
			expect(writeWorkerScmCredential).not.toHaveBeenCalled();
			expect(enrollWorker).not.toHaveBeenCalled();
		});

		it('requires an owner identifier, a project id, --name, and --cli', async () => {
			expect(await run(['register-and-enroll'])).toBe(1);
			expect(await run(['register-and-enroll', 'ada@example.com'])).toBe(1);
			expect(
				await run(['register-and-enroll', 'ada@example.com', PROJECT_ID, '--cli', 'claude']),
			).toBe(1);
			expect(
				await run(['register-and-enroll', 'ada@example.com', PROJECT_ID, '--name', 'ada-laptop']),
			).toBe(1);
			expect(registerWorker).not.toHaveBeenCalled();
			expect(readStdin).not.toHaveBeenCalled();
		});

		it('rejects an invalid CLI without hitting a service', async () => {
			expect(
				await run([
					'register-and-enroll',
					'ada@example.com',
					PROJECT_ID,
					'--name',
					'ada-laptop',
					'--cli',
					'claude,vim',
				]),
			).toBe(1);
			expect(registerWorker).not.toHaveBeenCalled();
		});

		it('fails for an unknown owner or project without reading the secret', async () => {
			findUserByIdentifier.mockResolvedValue(undefined);
			expect(await run(ARGV)).toBe(1);
			findUserByIdentifier.mockResolvedValue(makeUser());
			findProjectByIdFromDb.mockResolvedValue(undefined);
			expect(await run(ARGV)).toBe(1);
			expect(promptHidden).not.toHaveBeenCalled();
			expect(readStdin).not.toHaveBeenCalled();
			expect(registerWorker).not.toHaveBeenCalled();
		});

		// The ordering guarantee: the secret is read before the first write, so an
		// empty (or aborted) one leaves no worker row behind.
		it('rejects an empty secret before registering the worker', async () => {
			readStdin.mockResolvedValue('   \n');
			expect(await run(ARGV)).toBe(1);
			expect(registerWorker).not.toHaveBeenCalled();
			expect(writeWorkerScmCredential).not.toHaveBeenCalled();
		});

		it('translates a duplicate worker name and stores no credential', async () => {
			registerWorker.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
			const error = vi.spyOn(console, 'error');
			expect(await run(ARGV)).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('already exists'));
			expect(writeWorkerScmCredential).not.toHaveBeenCalled();
		});

		// An enroll refusal is surfaced verbatim, and the one-time worker credential is
		// still handed over — losing it would mean remove + register again.
		it('surfaces an enroll refusal and still hands over the credential once', async () => {
			enrollWorker.mockRejectedValue(
				new EnrollmentRepositoryMismatchError(WORKER_ID, 'acme/frontend', 'acme/backend'),
			);
			const log = vi.spyOn(console, 'log');
			const error = vi.spyOn(console, 'error');
			expect(await run(ARGV)).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('acme/frontend'));
			expect(error).toHaveBeenCalledWith(expect.stringContaining('acme/backend'));
			const lines = log.mock.calls.map(([line]) => String(line));
			expect(lines.filter((line) => line.includes('raw-credential-token'))).toHaveLength(1);
			expect(lines.some((line) => line.includes('workers enroll'))).toBe(true);
		});

		it('hands over the credential and the remaining steps when the credential write fails', async () => {
			writeWorkerScmCredential.mockRejectedValue(new Error('CREDENTIAL_MASTER_KEY is not set'));
			const log = vi.spyOn(console, 'log');
			expect(await run(ARGV)).toBe(1);
			expect(enrollWorker).not.toHaveBeenCalled();
			const lines = log.mock.calls.map(([line]) => String(line));
			expect(lines.filter((line) => line.includes('raw-credential-token'))).toHaveLength(1);
			expect(lines.some((line) => line.includes('set-scm-credential'))).toBe(true);
			expect(lines.some((line) => line.includes('workers enroll'))).toBe(true);
		});

		it('prints --repo-root instead of the project checkout when given', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run([...ARGV, '--repo-root', '/opt/checkouts/swarm'])).toBe(0);
			const lines = log.mock.calls.map(([line]) => String(line));
			const last = lines[lines.length - 1] ?? '';
			expect(last).toContain('SWARM_WORKER_REPO_ROOT=/opt/checkouts/swarm');
			expect(last).not.toContain(REPO_ROOT);
		});

		it('describes itself in --help without writing anything', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(['register-and-enroll', '--help'])).toBe(0);
			expect(log).toHaveBeenCalledWith(expect.stringContaining('register-and-enroll'));
			expect(registerWorker).not.toHaveBeenCalled();
			expect(readStdin).not.toHaveBeenCalled();
		});
	});

	describe('list', () => {
		it("lists a single owner's workers without printing a hash", async () => {
			listWorkersForOwner.mockResolvedValue([makeWorker({ capabilities: ['claude', 'codex'] })]);
			const log = vi.spyOn(console, 'log');
			expect(await run(['list', 'ada@example.com'])).toBe(0);
			expect(listWorkersForOwner).toHaveBeenCalledWith(OWNER_ID);
			expect(log).toHaveBeenCalledWith(expect.stringContaining('ada-laptop'));
			const printed = log.mock.calls.map(([line]) => String(line)).join('\n');
			expect(printed).not.toMatch(/credential|hash/i);
			expect(closeDb).toHaveBeenCalledOnce();
		});

		it('lists all owners when no identifier is given, prefixed by owner', async () => {
			listWorkersForOwner.mockResolvedValue([makeWorker()]);
			const log = vi.spyOn(console, 'log');
			expect(await run(['list'])).toBe(0);
			expect(listUsers).toHaveBeenCalledOnce();
			expect(log).toHaveBeenCalledWith(expect.stringContaining('ada@example.com'));
		});

		it('fails for an unknown owner identifier', async () => {
			findUserByIdentifier.mockResolvedValue(undefined);
			expect(await run(['list', 'nobody'])).toBe(1);
			expect(listWorkersForOwner).not.toHaveBeenCalled();
		});
	});

	describe('set-cli', () => {
		// Issue #783: it writes the owner's *declaration*, not the probe a handshake
		// refreshes — which is the whole reason the statement now survives a reconnect.
		it('declares a worker CLI set by id', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(['set-cli', WORKER_ID, '--cli', 'codex'])).toBe(0);
			expect(declareWorkerCapabilities).toHaveBeenCalledWith(WORKER_ID, ['codex']);
			expect(log.mock.calls.flat().join('\n')).toContain('survives the machine');
		});

		it('clears the declaration with --auto', async () => {
			expect(await run(['set-cli', WORKER_ID, '--auto'])).toBe(0);
			expect(declareWorkerCapabilities).toHaveBeenCalledWith(WORKER_ID, null);
		});

		it('requires one of --cli or --auto', async () => {
			expect(await run(['set-cli', WORKER_ID])).toBe(1);
			expect(declareWorkerCapabilities).not.toHaveBeenCalled();
		});

		it('refuses --cli and --auto together rather than letting argument order decide', async () => {
			expect(await run(['set-cli', WORKER_ID, '--cli', 'codex', '--auto'])).toBe(1);
			expect(declareWorkerCapabilities).not.toHaveBeenCalled();
		});

		it('fails cleanly for a missing worker', async () => {
			declareWorkerCapabilities.mockResolvedValue(undefined);
			expect(await run(['set-cli', WORKER_ID, '--cli', 'claude'])).toBe(1);
		});

		it('translates a capability reduction error to a friendly message and exits 1', async () => {
			declareWorkerCapabilities.mockRejectedValue(
				new WorkerCapabilityReductionError(WORKER_ID, ['claude']),
			);
			const error = vi.spyOn(console, 'error');
			expect(await run(['set-cli', WORKER_ID, '--cli', 'codex'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('Cannot update capabilities'));
		});

		it('translates a not-probed error to a friendly message and exits 1', async () => {
			declareWorkerCapabilities.mockRejectedValue(
				new WorkerCapabilityNotProbedError(WORKER_ID, ['codex'], ['claude']),
			);
			const error = vi.spyOn(console, 'error');
			expect(await run(['set-cli', WORKER_ID, '--cli', 'codex'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('Cannot declare CLIs'));
		});
	});

	describe('set-scm-credential', () => {
		it('stores the trimmed secret for the (worker, provider) pair, printing no preview', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(['set-scm-credential', WORKER_ID, 'bitbucket'])).toBe(0);
			expect(writeWorkerScmCredential).toHaveBeenCalledWith(WORKER_ID, 'bitbucket', 'piped-secret');
			// It confirms the write and nothing else — a preview of an operator identity
			// in a terminal scrollback is the thing this command exists to avoid.
			const printed = log.mock.calls.flat().join('\n');
			expect(printed).toContain("stored operator scm credential for worker 'ada-laptop'");
			expect(printed).not.toContain('piped-secret');
		});

		it('rejects an unknown SCM provider id', async () => {
			expect(await run(['set-scm-credential', WORKER_ID, 'perforce'])).toBe(1);
			expect(writeWorkerScmCredential).not.toHaveBeenCalled();
		});

		// Checked here rather than left to the FK, so the operator gets a message
		// instead of a constraint violation.
		it('fails cleanly for a missing worker', async () => {
			getWorker.mockResolvedValue(undefined);
			expect(await run(['set-scm-credential', WORKER_ID, 'github'])).toBe(1);
			expect(writeWorkerScmCredential).not.toHaveBeenCalled();
		});

		it('rejects an empty secret', async () => {
			readStdin.mockResolvedValue('   \n');
			expect(await run(['set-scm-credential', WORKER_ID, 'github'])).toBe(1);
			expect(writeWorkerScmCredential).not.toHaveBeenCalled();
		});

		it('requires both a worker id and a provider id', async () => {
			expect(await run(['set-scm-credential', WORKER_ID])).toBe(1);
			expect(writeWorkerScmCredential).not.toHaveBeenCalled();
		});
	});

	describe('remove', () => {
		it('removes a worker by id', async () => {
			expect(await run(['remove', WORKER_ID])).toBe(0);
			expect(removeWorker).toHaveBeenCalledWith(WORKER_ID);
		});

		it('fails cleanly for a missing worker', async () => {
			removeWorker.mockResolvedValue(false);
			expect(await run(['remove', WORKER_ID])).toBe(1);
		});
	});

	describe('enroll', () => {
		it('enrolls a worker into a project with allowed CLIs', async () => {
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(0);
			expect(enrollWorker).toHaveBeenCalledWith(
				expect.objectContaining({ projectId: PROJECT_ID, allowedClis: ['claude'] }),
			);
		});

		it('seeds an active, consenting enrollment with --active --consent', async () => {
			expect(
				await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude', '--active', '--consent']),
			).toBe(0);
			expect(enrollWorker).toHaveBeenCalledWith(
				expect.objectContaining({ status: 'active', sharingConsent: true }),
			);
		});

		it('requires worker id, project id, and --cli', async () => {
			expect(await run(['enroll', WORKER_ID, PROJECT_ID])).toBe(1);
			expect(await run(['enroll', WORKER_ID])).toBe(1);
			expect(enrollWorker).not.toHaveBeenCalled();
		});

		it('rejects a non-positive or empty --concurrency without hitting the service', async () => {
			expect(
				await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude', '--concurrency', '0']),
			).toBe(1);
			// Issue #480: an empty value must not read as "clear the allocation".
			expect(
				await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude', '--concurrency', '']),
			).toBe(1);
			expect(enrollWorker).not.toHaveBeenCalled();
		});

		it('leaves --concurrency to the service default and reports the stored allocation', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(0);
			// Omitted, so the service applies DEFAULT_CONCURRENCY_ALLOCATION rather
			// than the CLI inventing a value or sending null (issue #480).
			expect(enrollWorker).toHaveBeenCalledWith(
				expect.objectContaining({ concurrencyAllocation: undefined }),
			);
			expect(log).toHaveBeenCalledWith(expect.stringContaining('concurrency 1'));
		});

		it('passes an explicit --concurrency through for a wider worker', async () => {
			expect(
				await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude', '--concurrency', '3']),
			).toBe(0);
			expect(enrollWorker).toHaveBeenCalledWith(
				expect.objectContaining({ concurrencyAllocation: 3 }),
			);
		});

		it('fails cleanly for a missing worker or project', async () => {
			getWorker.mockResolvedValue(undefined);
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(1);
			getWorker.mockResolvedValue(makeWorker());
			findProjectByIdFromDb.mockResolvedValue(undefined);
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(1);
			expect(enrollWorker).not.toHaveBeenCalled();
		});

		it('translates an out-of-capability CLI set to a friendly error', async () => {
			enrollWorker.mockRejectedValue(new AllowedClisNotCapableError(WORKER_ID, ['antigravity']));
			const error = vi.spyOn(console, 'error');
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'antigravity'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('not capable'));
		});

		// Issue #690 — the machine's checkout is not this project's repository. One
		// actionable line, the typed error's own message, and exit 1.
		it('translates a repository mismatch to a single actionable line', async () => {
			enrollWorker.mockRejectedValue(
				new EnrollmentRepositoryMismatchError(WORKER_ID, 'acme/frontend', 'acme/backend'),
			);
			const error = vi.spyOn(console, 'error');
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('acme/frontend'));
			expect(error).toHaveBeenCalledWith(expect.stringContaining('acme/backend'));
		});

		it('translates a duplicate enrollment (23505) to a friendly error', async () => {
			enrollWorker.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(1);
		});
	});

	describe('update-enrollment', () => {
		it('updates allowed CLIs without changing the stored concurrency', async () => {
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--cli', 'claude,codex'])).toBe(
				0,
			);
			expect(updateEnrollmentConstraints).toHaveBeenCalledWith({
				worker: expect.objectContaining({ id: WORKER_ID }),
				enrollmentId: 'enr-1',
				allowedClis: ['claude', 'codex'],
				concurrencyAllocation: undefined,
			});
		});

		it('updates concurrency without changing the allowed CLIs', async () => {
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--concurrency', '3'])).toBe(0);
			expect(updateEnrollmentConstraints).toHaveBeenCalledWith({
				worker: expect.objectContaining({ id: WORKER_ID }),
				enrollmentId: 'enr-1',
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
			expect(updateEnrollmentConstraints).not.toHaveBeenCalled();
		});

		it('rejects invalid CLI and concurrency values before resolving an enrollment', async () => {
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--cli', 'claude,vim'])).toBe(
				1,
			);
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--concurrency', '0'])).toBe(1);
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--concurrency', ''])).toBe(1);
			expect(getWorker).not.toHaveBeenCalled();
			expect(updateEnrollmentConstraints).not.toHaveBeenCalled();
		});

		it('fails cleanly for a missing worker, project, or enrollment', async () => {
			getWorker.mockResolvedValueOnce(undefined);
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(1);
			findProjectByIdFromDb.mockResolvedValueOnce(undefined);
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(1);
			getEnrollment.mockResolvedValueOnce(undefined);
			expect(await run(['update-enrollment', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(1);
			expect(updateEnrollmentConstraints).not.toHaveBeenCalled();
		});

		it('translates an out-of-capability CLI set to a friendly error', async () => {
			updateEnrollmentConstraints.mockRejectedValue(
				new AllowedClisNotCapableError(WORKER_ID, ['antigravity']),
			);
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
			expect(approveEnrollment).toHaveBeenCalledWith('enr-1');
		});

		it('fails cleanly when no enrollment exists', async () => {
			getEnrollment.mockResolvedValue(undefined);
			expect(await run(['approve', WORKER_ID, PROJECT_ID])).toBe(1);
			expect(approveEnrollment).not.toHaveBeenCalled();
		});
	});

	describe('consent', () => {
		it('turns sharing consent on and off', async () => {
			expect(await run(['consent', WORKER_ID, PROJECT_ID, 'on'])).toBe(0);
			expect(setSharingConsent).toHaveBeenCalledWith('enr-1', true);
			expect(await run(['consent', WORKER_ID, PROJECT_ID, 'off'])).toBe(0);
			expect(setSharingConsent).toHaveBeenCalledWith('enr-1', false);
		});

		it('rejects a toggle other than on/off', async () => {
			expect(await run(['consent', WORKER_ID, PROJECT_ID, 'maybe'])).toBe(1);
			expect(setSharingConsent).not.toHaveBeenCalled();
		});

		it('fails cleanly when no enrollment exists', async () => {
			getEnrollment.mockResolvedValue(undefined);
			expect(await run(['consent', WORKER_ID, PROJECT_ID, 'on'])).toBe(1);
			expect(setSharingConsent).not.toHaveBeenCalled();
		});
	});

	describe('dispatch', () => {
		it('returns 1 for an unknown subcommand without opening the db', async () => {
			expect(await run(['nope'])).toBe(1);
			expect(closeDb).not.toHaveBeenCalled();
		});

		it('returns 1 with no subcommand and 0 for explicit --help', async () => {
			const log = vi.spyOn(console, 'log');
			expect(await run([])).toBe(1);
			expect(await run(['--help'])).toBe(0);
			expect(log).toHaveBeenCalledWith(expect.stringContaining('update-enrollment'));
			expect(log).toHaveBeenCalledWith(expect.stringContaining('register-and-enroll'));
			expect(registerWorker).not.toHaveBeenCalled();
			expect(closeDb).not.toHaveBeenCalled();
		});
	});
});
