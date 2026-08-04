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
const { findUserByIdentifier, listUsers } = vi.hoisted(() => ({
	findUserByIdentifier: vi.fn(),
	listUsers: vi.fn(),
}));
const { closeDb } = vi.hoisted(() => ({ closeDb: vi.fn() }));
const { findProjectByIdFromDb } = vi.hoisted(() => ({ findProjectByIdFromDb: vi.fn() }));
const { getEnrollment } = vi.hoisted(() => ({ getEnrollment: vi.fn() }));
const { enrollWorker, approveEnrollment, setSharingConsent, AllowedClisNotCapableError } =
	vi.hoisted(() => {
		class AllowedClisNotCapableError extends Error {
			constructor(
				public workerId: string,
				public offending: string[],
			) {
				super(`not capable: ${offending.join(', ')}`);
				this.name = 'AllowedClisNotCapableError';
			}
		}
		return {
			enrollWorker: vi.fn(),
			approveEnrollment: vi.fn(),
			setSharingConsent: vi.fn(),
			AllowedClisNotCapableError,
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
	AllowedClisNotCapableError,
}));
vi.mock('@/db/repositories/workersRepository.js', () => ({ removeWorker }));
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

		it('translates a duplicate enrollment (23505) to a friendly error', async () => {
			enrollWorker.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
			expect(await run(['enroll', WORKER_ID, PROJECT_ID, '--cli', 'claude'])).toBe(1);
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
			expect(await run([])).toBe(1);
			expect(await run(['--help'])).toBe(0);
			expect(registerWorker).not.toHaveBeenCalled();
			expect(closeDb).not.toHaveBeenCalled();
		});
	});
});
