import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/workerScmCredentialsRepository.js', () => ({
	resolveWorkerScmCredential: vi.fn(),
}));

import { resolveWorkerScmCredential } from '@/db/repositories/workerScmCredentialsRepository.js';
import {
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
