import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/runsRepository.js', () => ({
	findPullRequestProducerWorkerId: vi.fn(),
}));
vi.mock('@/db/repositories/workersRepository.js', () => ({
	getWorkerById: vi.fn(),
}));
vi.mock('@/db/repositories/workerScmCredentialsRepository.js', () => ({
	resolveWorkerScmCredential: vi.fn(),
}));

// The real manifests, so the project's provider resolves exactly as a dispatch's does.
import '@/integrations/entrypoint.js';
import { findPullRequestProducerWorkerId } from '@/db/repositories/runsRepository.js';
import { resolveWorkerScmCredential } from '@/db/repositories/workerScmCredentialsRepository.js';
import { getWorkerById } from '@/db/repositories/workersRepository.js';
import {
	attributedToOperator,
	PullRequestOperatorUnavailableError,
	runAsPullRequestOperator,
} from '@/identity/pull-request-operator.js';
import type { Worker } from '@/identity/worker.js';
import { scopedOperatorCredential } from '@/scm/operator-credential.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const project = createMockProjectConfig({
	scm: 'azure-devops',
	repo: 'fabrikam/kuchnia-vikinga/web',
});

describe('runAsPullRequestOperator (issue #1249)', () => {
	beforeEach(() => {
		vi.mocked(findPullRequestProducerWorkerId).mockReset();
		vi.mocked(findPullRequestProducerWorkerId).mockResolvedValue(WORKER_ID);
		vi.mocked(getWorkerById).mockReset();
		vi.mocked(getWorkerById).mockResolvedValue({
			id: WORKER_ID,
			displayName: 'alice-laptop',
		} as Worker);
		vi.mocked(resolveWorkerScmCredential).mockReset();
		vi.mocked(resolveWorkerScmCredential).mockResolvedValue('alice-pat');
	});

	it("runs the write with the producing worker's stored credential as the implementer", async () => {
		const seen = await runAsPullRequestOperator(project, '3472', async (operator) => ({
			operator,
			credential: scopedOperatorCredential(),
		}));

		expect(seen).toEqual({
			operator: { workerId: WORKER_ID, workerName: 'alice-laptop' },
			credential: 'alice-pat',
		});
		expect(findPullRequestProducerWorkerId).toHaveBeenCalledWith(project.id, project.repo, '3472');
		expect(resolveWorkerScmCredential).toHaveBeenCalledWith(WORKER_ID, 'azure-devops');
		expect(scopedOperatorCredential()).toBeNull();
	});

	it('refuses, without running the write, when no worker is recorded as producing the pull request', async () => {
		vi.mocked(findPullRequestProducerWorkerId).mockResolvedValue(undefined);
		const write = vi.fn(async () => 'merged');

		await expect(runAsPullRequestOperator(project, '3472', write)).rejects.toThrow(
			PullRequestOperatorUnavailableError,
		);
		await expect(runAsPullRequestOperator(project, '3472', write)).rejects.toThrow(
			'no registered SWARM worker is recorded as having produced pull request #3472',
		);
		expect(write).not.toHaveBeenCalled();
		expect(resolveWorkerScmCredential).not.toHaveBeenCalled();
	});

	it('refuses the same way when the recorded worker has since been removed', async () => {
		vi.mocked(getWorkerById).mockResolvedValue(undefined);
		const write = vi.fn(async () => 'merged');

		await expect(runAsPullRequestOperator(project, '3472', write)).rejects.toThrow(
			PullRequestOperatorUnavailableError,
		);
		expect(write).not.toHaveBeenCalled();
	});

	it('refuses with where to store the credential when the worker holds none, never an env var', async () => {
		vi.mocked(resolveWorkerScmCredential).mockResolvedValue(null);
		const write = vi.fn(async () => 'merged');

		const failure = runAsPullRequestOperator(project, '3472', write);
		await expect(failure).rejects.toThrow(PullRequestOperatorUnavailableError);
		await expect(failure).rejects.toThrow(
			"no operator source-control credential is stored for worker 'alice-laptop' on azure-devops",
		);
		await expect(failure).rejects.toThrow(
			`swarm workers set-scm-credential ${WORKER_ID} azure-devops`,
		);
		await expect(failure).rejects.not.toThrow(/SWARM_OPERATOR_/);
		expect(write).not.toHaveBeenCalled();
	});
});

describe('attributedToOperator', () => {
	it('names the worker whose credential a provider refused', () => {
		expect(
			attributedToOperator('HTTP 401', { workerId: WORKER_ID, workerName: 'alice-laptop' }),
		).toBe("HTTP 401 (acting as the operator credential stored for worker 'alice-laptop')");
	});
});
