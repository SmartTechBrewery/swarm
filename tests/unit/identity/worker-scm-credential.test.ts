import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/workerScmCredentialsRepository.js', () => ({
	resolveWorkerScmCredential: vi.fn(),
}));

vi.mock('@/db/repositories/workerEnrollmentsRepository.js', () => ({
	listEnrollmentsForWorker: vi.fn(),
}));

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectByIdFromDb: vi.fn(),
}));

// The real manifests, so `requireProjectSCMProviderId` resolves the providers a
// dispatch would actually resolve rather than a fixture's.
import '@/integrations/entrypoint.js';
import type { ProjectConfig } from '@/config/schema.js';
import { findProjectByIdFromDb } from '@/db/repositories/projectsRepository.js';
import { listEnrollmentsForWorker } from '@/db/repositories/workerEnrollmentsRepository.js';
import { resolveWorkerScmCredential } from '@/db/repositories/workerScmCredentialsRepository.js';
import type { WorkerEnrollment } from '@/identity/worker-enrollment.js';
import {
	listWorkerScmProviders,
	MissingWorkerScmCredentialError,
	requireWorkerScmCredential,
} from '@/identity/worker-scm-credential.js';

const REQUEST = {
	workerId: '11111111-1111-4111-8111-111111111111',
	workerName: 'm5_pro',
	scmProviderId: 'github',
} as const;

describe('requireWorkerScmCredential', () => {
	beforeEach(() => {
		vi.mocked(resolveWorkerScmCredential).mockReset();
	});

	it('returns the stored credential for the (worker, provider) pair asked for', async () => {
		vi.mocked(resolveWorkerScmCredential).mockResolvedValue('ghp_stored');
		await expect(requireWorkerScmCredential(REQUEST)).resolves.toBe('ghp_stored');
		expect(resolveWorkerScmCredential).toHaveBeenCalledWith(REQUEST.workerId, 'github');
	});

	it('reads only the provider it was asked for, never another', async () => {
		vi.mocked(resolveWorkerScmCredential).mockResolvedValue('bb_stored');
		await expect(
			requireWorkerScmCredential({ ...REQUEST, scmProviderId: 'bitbucket' }),
		).resolves.toBe('bb_stored');
		expect(resolveWorkerScmCredential).toHaveBeenCalledWith(REQUEST.workerId, 'bitbucket');
	});

	/**
	 * The attribution criterion: an unset credential must name the machine and the
	 * provider, as fields a caller can read and in a message an operator can act on —
	 * not the provider's own generic "Could not resolve GitHub identity" a few seconds
	 * into a run.
	 */
	it('throws a typed, attributable error when nothing is stored', async () => {
		vi.mocked(resolveWorkerScmCredential).mockResolvedValue(null);

		const error = await requireWorkerScmCredential(REQUEST).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(MissingWorkerScmCredentialError);
		const missing = error as MissingWorkerScmCredentialError;
		expect(missing.workerId).toBe(REQUEST.workerId);
		expect(missing.workerName).toBe('m5_pro');
		expect(missing.scmProviderId).toBe('github');
		expect(missing.message).toContain("worker 'm5_pro'");
		expect(missing.message).toContain(REQUEST.workerId);
		expect(missing.message).toContain("provider 'github'");
		// And the one command that fixes it, so nobody has to go digging in the DB.
		expect(missing.message).toContain(
			`swarm workers set-scm-credential ${REQUEST.workerId} github`,
		);
	});
});

/**
 * The read behind phase 2/3's dashboard form (issue #766): which providers a
 * worker's own enrollments make it need a credential for.
 */
describe('listWorkerScmProviders', () => {
	const WORKER_ID = REQUEST.workerId;

	function enrollment(projectId: string, status: WorkerEnrollment['status'] = 'active') {
		return { id: `enr-${projectId}`, workerId: WORKER_ID, projectId, status } as WorkerEnrollment;
	}

	function project(id: string, scm: string | undefined) {
		return { id, repo: 'acme/app', scm } as unknown as ProjectConfig;
	}

	beforeEach(() => {
		vi.mocked(listEnrollmentsForWorker).mockReset();
		vi.mocked(findProjectByIdFromDb).mockReset();
	});

	it('returns nothing for a worker with no enrollments', async () => {
		vi.mocked(listEnrollmentsForWorker).mockResolvedValue([]);
		await expect(listWorkerScmProviders(WORKER_ID)).resolves.toEqual([]);
	});

	it('de-duplicates two enrollments that resolve to one provider', async () => {
		vi.mocked(listEnrollmentsForWorker).mockResolvedValue([
			enrollment('proj-a'),
			enrollment('proj-b'),
		]);
		vi.mocked(findProjectByIdFromDb).mockImplementation(async (id: string) =>
			project(id, 'github'),
		);

		await expect(listWorkerScmProviders(WORKER_ID)).resolves.toEqual(['github']);
	});

	it('returns both providers for a worker split across two, in enrollment order', async () => {
		vi.mocked(listEnrollmentsForWorker).mockResolvedValue([
			enrollment('proj-a'),
			enrollment('proj-b'),
		]);
		vi.mocked(findProjectByIdFromDb).mockImplementation(async (id: string) =>
			project(id, id === 'proj-a' ? 'gitlab' : 'github'),
		);

		await expect(listWorkerScmProviders(WORKER_ID)).resolves.toEqual(['gitlab', 'github']);
	});

	// The acceptance criteria's "or is being enrolled in": a machine has to be able to
	// set its credential before a project administrator approves the offer.
	it('counts a pending enrollment', async () => {
		vi.mocked(listEnrollmentsForWorker).mockResolvedValue([enrollment('proj-a', 'pending')]);
		vi.mocked(findProjectByIdFromDb).mockResolvedValue(project('proj-a', 'bitbucket'));

		await expect(listWorkerScmProviders(WORKER_ID)).resolves.toEqual(['bitbucket']);
	});

	// The fix for a project whose `scm` resolves nothing is that project's own config,
	// not the worker owner's credential — so it is skipped rather than thrown or offered.
	it('skips a project whose provider does not resolve, keeping the others', async () => {
		vi.mocked(listEnrollmentsForWorker).mockResolvedValue([
			enrollment('proj-a'),
			enrollment('proj-b'),
		]);
		vi.mocked(findProjectByIdFromDb).mockImplementation(async (id: string) =>
			project(id, id === 'proj-a' ? 'nonesuch' : 'github'),
		);

		await expect(listWorkerScmProviders(WORKER_ID)).resolves.toEqual(['github']);
	});

	it('skips an enrollment whose project no longer exists', async () => {
		vi.mocked(listEnrollmentsForWorker).mockResolvedValue([enrollment('proj-gone')]);
		vi.mocked(findProjectByIdFromDb).mockResolvedValue(undefined);

		await expect(listWorkerScmProviders(WORKER_ID)).resolves.toEqual([]);
	});
});
