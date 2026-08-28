import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	registerWorker,
	refreshWorkerCapabilities,
	listWorkersForOwner,
	getWorker,
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
	return {
		registerWorker: vi.fn(),
		refreshWorkerCapabilities: vi.fn(),
		listWorkersForOwner: vi.fn(),
		getWorker: vi.fn(),
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
	refreshWorkerCapabilities,
	listWorkersForOwner,
	getWorker,
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

import { run } from '@/cli/commands/workers.js';

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
		refreshWorkerCapabilities
			.mockReset()
			.mockImplementation(async (id, capabilities) => makeWorker({ id, capabilities }));
		listWorkersForOwner.mockReset().mockResolvedValue([]);
		removeWorker.mockReset().mockResolvedValue(true);
		writeWorkerScmCredential.mockReset().mockResolvedValue(undefined);
		// Non-TTY is the shape a test process actually has, so the command reads stdin.
		promptHidden.mockReset().mockResolvedValue('typed-secret');
		readStdin.mockReset().mockResolvedValue('  piped-secret\n');
		findUserByIdentifier.mockReset().mockResolvedValue(makeUser());
		listUsers.mockReset().mockResolvedValue([makeUser()]);
		closeDb.mockReset().mockResolvedValue(undefined);
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
			expect(closeDb).toHaveBeenCalledOnce();
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
		it('refreshes a worker capability set by id', async () => {
			expect(await run(['set-cli', WORKER_ID, '--cli', 'codex'])).toBe(0);
			expect(refreshWorkerCapabilities).toHaveBeenCalledWith(WORKER_ID, ['codex']);
		});

		it('requires --cli', async () => {
			expect(await run(['set-cli', WORKER_ID])).toBe(1);
			expect(refreshWorkerCapabilities).not.toHaveBeenCalled();
		});

		it('fails cleanly for a missing worker', async () => {
			refreshWorkerCapabilities.mockResolvedValue(undefined);
			expect(await run(['set-cli', WORKER_ID, '--cli', 'claude'])).toBe(1);
		});

		it('translates a capability reduction error to a friendly message and exits 1', async () => {
			refreshWorkerCapabilities.mockRejectedValue(
				new WorkerCapabilityReductionError(WORKER_ID, ['claude']),
			);
			const error = vi.spyOn(console, 'error');
			expect(await run(['set-cli', WORKER_ID, '--cli', 'codex'])).toBe(1);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('Cannot update capabilities'));
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
			expect(registerWorker).not.toHaveBeenCalled();
			expect(closeDb).not.toHaveBeenCalled();
		});
	});
});
