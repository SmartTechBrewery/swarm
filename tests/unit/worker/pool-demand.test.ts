import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	listRunnableDispatchesForPool: vi.fn(),
}));

import {
	type DispatchRow,
	listRunnableDispatchesForPool,
} from '@/db/repositories/dispatchesRepository.js';
import type { SwarmJob } from '@/queue/jobs.js';
import { loadRunnableDispatchDemands } from '@/worker/pool-demand.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const listRunnable = vi.mocked(listRunnableDispatchesForPool);

const JOB: SwarmJob = {
	type: 'pm',
	projectId: 'swarm',
	providerId: 'github-projects',
	event: { itemId: 'item-1', containerId: 'proj-1', action: 'edited' },
};

function dispatchRow(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'd-1',
		projectId: 'swarm',
		phase: 'review',
		jobPayload: JOB,
		selectedWorkerId: null,
		state: 'pending',
		...overrides,
	} as DispatchRow;
}

describe('loadRunnableDispatchDemands', () => {
	beforeEach(() => {
		listRunnable.mockReset();
	});

	it('reads each runnable dispatch’s phase and its configured target priority', async () => {
		const project = createMockProjectConfig({
			agents: { review: { targets: [{ cli: 'codex' }, { cli: 'claude' }] } },
		});
		listRunnable.mockResolvedValue([dispatchRow(), dispatchRow({ id: 'd-2', phase: 'planning' })]);

		const demands = await loadRunnableDispatchDemands(project);

		expect(demands).toEqual([
			{
				dispatchId: 'd-1',
				phase: 'review',
				targets: [{ cli: 'codex' }, { cli: 'claude' }],
				phaseDefaultCli: 'claude',
			},
			// An unconfigured phase contributes the implicit coded-default target, exactly
			// as its own dispatch will resolve it.
			{ dispatchId: 'd-2', phase: 'planning', targets: [{}], phaseDefaultCli: 'claude' },
		]);
	});

	it('honours a per-run target pin carried on the stored payload', async () => {
		// A "Retry now" that pinned codex demands a codex worker, not the phase's list.
		const project = createMockProjectConfig({
			agents: { review: { targets: [{ cli: 'claude' }] } },
		});
		listRunnable.mockResolvedValue([
			dispatchRow({ jobPayload: { ...JOB, cliOverride: 'codex' } as SwarmJob }),
		]);

		expect(await loadRunnableDispatchDemands(project)).toMatchObject([
			{ dispatchId: 'd-1', targets: [{ cli: 'codex' }] },
		]);
	});

	// Issue #714: the gate narrows a contender by its own repository, so the demand has
	// to carry it — read off the stored payload exactly as the contender's own dispatch
	// will scope its project by it.
	it('carries each contender’s own repository', async () => {
		listRunnable.mockResolvedValue([
			dispatchRow({ jobPayload: { ...JOB, repository: 'smarttechbrewery/dashboard' } as SwarmJob }),
			// A payload naming none means the project's default entry, which the scoped
			// project may not be — so the gate skips the check rather than guessing.
			dispatchRow({ id: 'd-legacy' }),
		]);

		expect(await loadRunnableDispatchDemands(createMockProjectConfig())).toMatchObject([
			{ dispatchId: 'd-1', repository: 'smarttechbrewery/dashboard' },
			{ dispatchId: 'd-legacy', repository: undefined },
		]);
	});

	it('drops dispatches that demand no worker', async () => {
		// A dispatch whose trigger has not resolved yet names no phase, and merge
		// automation runs no agent at all — neither competes for the pool.
		listRunnable.mockResolvedValue([
			dispatchRow({ id: 'd-unresolved', phase: null }),
			dispatchRow({ id: 'd-merge', phase: 'merge-automation' }),
			dispatchRow({ id: 'd-real' }),
		]);

		const demands = await loadRunnableDispatchDemands(createMockProjectConfig());

		expect(demands?.map((demand) => demand.dispatchId)).toEqual(['d-real']);
	});

	it('reports no pool information when the read fails', async () => {
		// The gate reads `undefined` as "keep the first-eligible pick": a scheduling
		// preference must never be why a ready dispatch waits.
		listRunnable.mockRejectedValue(new Error('database is down'));

		expect(await loadRunnableDispatchDemands(createMockProjectConfig())).toBeUndefined();
	});
});
