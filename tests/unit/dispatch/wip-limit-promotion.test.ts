import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig, ProjectRecord } from '@/config/schema.js';
import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import type { SwarmJob } from '@/queue/jobs.js';
import {
	createMockPmWebhookJob,
	createMockProjectConfig,
	createMockProjectRecord,
	createMockScmWebhookJob,
} from '../../helpers/factories.js';

const listWipLimitWaits =
	vi.fn<(projectId: string, repository: string) => Promise<DispatchRow[]>>();
const listRepositoriesWithWipWaits =
	vi.fn<() => Promise<{ projectId: string; repository: string }[]>>();
vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	listWipLimitWaits: (projectId: string, repository: string) =>
		listWipLimitWaits(projectId, repository),
	listRepositoriesWithWipWaits: () => listRepositoriesWithWipWaits(),
}));

const findProjectRecordByIdFromDb = vi.fn<(id: string) => Promise<ProjectRecord | undefined>>();
const findProjectByIdFromDb =
	vi.fn<(id: string, repo?: string) => Promise<ProjectConfig | undefined>>();
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectRecordByIdFromDb: (id: string) => findProjectRecordByIdFromDb(id),
	findProjectByIdFromDb: (id: string, repo?: string) => findProjectByIdFromDb(id, repo),
}));

const countWipSlots = vi.fn<(projectId: string, repository: string) => Promise<number>>();
const releaseWipSlot =
	vi.fn<(projectId: string, repository: string, taskId: string) => Promise<boolean>>();
const recordWipSlotPullRequest =
	vi.fn<
		(projectId: string, repository: string, taskId: string, prNumber: string) => Promise<void>
	>();
vi.mock('@/db/repositories/wipSlotsRepository.js', () => ({
	countWipSlots: (projectId: string, repository: string) => countWipSlots(projectId, repository),
	releaseWipSlot: (projectId: string, repository: string, taskId: string) =>
		releaseWipSlot(projectId, repository, taskId),
	recordWipSlotPullRequest: (
		projectId: string,
		repository: string,
		taskId: string,
		prNumber: string,
	) => recordWipSlotPullRequest(projectId, repository, taskId, prNumber),
	reserveWipSlot: vi.fn(),
}));

const publishDispatchWakeUp = vi.fn<(dispatch: DispatchRow) => Promise<void>>();
vi.mock('@/dispatch/dispatcher.js', () => ({
	publishDispatchWakeUp: (dispatch: DispatchRow) => publishDispatchWakeUp(dispatch),
}));

import {
	promoteAllWipWaits,
	promoteWipWaits,
	recordTicketPullRequest,
	releasePutBackTicketSlot,
	releaseTicketSlot,
	wipLimitWaitReason,
} from '@/dispatch/wip-limit.js';

const REPO = 'SmartTechBrewery/swarm';

function row(id: string, overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id,
		projectId: 'swarm',
		repository: REPO,
		taskId: id,
		phase: 'planning',
		state: 'pending',
		waitReason: 'wip-limit',
		wakeSeq: 1,
		jobPayload: createMockPmWebhookJob(),
		...overrides,
	} as DispatchRow;
}

function recordWithLimit(wipLimit?: number): ProjectRecord {
	const record = createMockProjectRecord();
	return {
		...record,
		repositories: record.repositories.map((entry) => ({
			...entry,
			...(wipLimit !== undefined ? { wipLimit } : {}),
		})),
	};
}

describe('repository WIP limit promotion (issue #1185)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findProjectRecordByIdFromDb.mockResolvedValue(recordWithLimit());
		findProjectByIdFromDb.mockResolvedValue(createMockProjectConfig());
		countWipSlots.mockResolvedValue(0);
		listWipLimitWaits.mockResolvedValue([]);
		publishDispatchWakeUp.mockResolvedValue(undefined);
	});

	describe('promoteWipWaits', () => {
		it('wakes exactly as many waiters as there are free slots, in admission order', async () => {
			findProjectRecordByIdFromDb.mockResolvedValue(recordWithLimit(3));
			countWipSlots.mockResolvedValue(1);
			listWipLimitWaits.mockResolvedValue([row('a'), row('b'), row('c')]);

			expect(await promoteWipWaits('swarm', REPO)).toBe(2);

			expect(publishDispatchWakeUp.mock.calls.map(([dispatch]) => dispatch.id)).toEqual(['a', 'b']);
		});

		it('wakes nothing while the repository is full', async () => {
			countWipSlots.mockResolvedValue(1);
			listWipLimitWaits.mockResolvedValue([row('a')]);

			expect(await promoteWipWaits('swarm', REPO)).toBe(0);
			expect(publishDispatchWakeUp).not.toHaveBeenCalled();
		});

		it('wakes several once the limit is raised', async () => {
			findProjectRecordByIdFromDb.mockResolvedValue(recordWithLimit(4));
			countWipSlots.mockResolvedValue(1);
			listWipLimitWaits.mockResolvedValue([row('a'), row('b'), row('c'), row('d')]);

			expect(await promoteWipWaits('swarm', REPO)).toBe(3);
		});

		it('defaults an entry stating no limit to 1', async () => {
			listWipLimitWaits.mockResolvedValue([row('a'), row('b')]);

			expect(await promoteWipWaits('swarm', REPO)).toBe(1);
		});

		it('wakes every waiter of a repository the project no longer owns', async () => {
			listWipLimitWaits.mockResolvedValue([row('a'), row('b')]);

			expect(await promoteWipWaits('swarm', 'acme/removed')).toBe(2);
		});

		it('reads nothing more when nobody waits', async () => {
			expect(await promoteWipWaits('swarm', REPO)).toBe(0);
			expect(findProjectRecordByIdFromDb).not.toHaveBeenCalled();
		});

		it('swallows a failure', async () => {
			listWipLimitWaits.mockRejectedValue(new Error('db down'));

			expect(await promoteWipWaits('swarm', REPO)).toBe(0);
		});
	});

	describe('releaseTicketSlot', () => {
		it('promotes the repository’s waiters when a slot was freed', async () => {
			releaseWipSlot.mockResolvedValue(true);
			listWipLimitWaits.mockResolvedValue([row('a')]);

			expect(await releaseTicketSlot('swarm', REPO, '42', 'pull-request-merged')).toBe(true);

			expect(releaseWipSlot).toHaveBeenCalledWith('swarm', REPO, '42');
			expect(publishDispatchWakeUp).toHaveBeenCalledOnce();
		});

		it('promotes nothing when the ticket held no slot', async () => {
			releaseWipSlot.mockResolvedValue(false);

			expect(await releaseTicketSlot('swarm', REPO, '42', 'board-done')).toBe(false);
			expect(listWipLimitWaits).not.toHaveBeenCalled();
		});

		it('swallows a failure', async () => {
			releaseWipSlot.mockRejectedValue(new Error('db down'));

			expect(await releaseTicketSlot('swarm', REPO, '42', 'board-done')).toBe(false);
		});
	});

	describe('promoteAllWipWaits', () => {
		it('promotes every repository holding waiters', async () => {
			listRepositoriesWithWipWaits.mockResolvedValue([
				{ projectId: 'swarm', repository: REPO },
				{ projectId: 'other', repository: 'acme/x' },
			]);

			await promoteAllWipWaits();

			expect(listWipLimitWaits).toHaveBeenCalledWith('swarm', REPO);
			expect(listWipLimitWaits).toHaveBeenCalledWith('other', 'acme/x');
		});
	});

	describe('releasePutBackTicketSlot', () => {
		beforeEach(() => {
			releaseWipSlot.mockResolvedValue(true);
		});

		it('releases a board job’s ticket by the dispatch’s task id', async () => {
			await releasePutBackTicketSlot('swarm', createMockPmWebhookJob() as SwarmJob, {
				dispatchTaskId: '216',
				cardTaskRef: '10',
			});

			expect(releaseWipSlot).toHaveBeenCalledWith('swarm', REPO, '216');
		});

		it('falls back to the card’s task reference when the dispatch resolved none', async () => {
			await releasePutBackTicketSlot('swarm', createMockPmWebhookJob() as SwarmJob, {
				dispatchTaskId: null,
				cardTaskRef: '10',
			});

			expect(releaseWipSlot).toHaveBeenCalledWith('swarm', REPO, '10');
		});

		it('releases a pull request job’s ticket by its branch, not its suffixed task id', async () => {
			const job = createMockScmWebhookJob();
			if (job.type !== 'scm') throw new Error('expected an scm job');
			job.event = { ...job.event, prBranch: 'issue-77' };

			await releasePutBackTicketSlot('swarm', job, { dispatchTaskId: '99-respond' });

			expect(findProjectByIdFromDb).toHaveBeenCalledWith('swarm', job.event.repoFullName);
			expect(releaseWipSlot).toHaveBeenCalledWith('swarm', REPO, '77');
		});

		it('releases a board-key task branch’s ticket by its key (issue #1226)', async () => {
			const job = createMockScmWebhookJob();
			if (job.type !== 'scm') throw new Error('expected an scm job');
			job.event = { ...job.event, prBranch: 'issue-VT-1538' };

			await releasePutBackTicketSlot('swarm', job, { dispatchTaskId: '99-respond' });

			expect(releaseWipSlot).toHaveBeenCalledWith('swarm', REPO, 'VT-1538');
		});

		it('releases nothing when no ticket can be resolved', async () => {
			await releasePutBackTicketSlot('swarm', createMockPmWebhookJob() as SwarmJob, {
				dispatchTaskId: null,
			});

			expect(releaseWipSlot).not.toHaveBeenCalled();
		});
	});

	describe('recordTicketPullRequest', () => {
		const project = createMockProjectConfig();

		it.each([
			['an SCM-number task branch', 'issue-42', '42'],
			['a board-key task branch (issue #1226)', 'issue-VT-1538', 'VT-1538'],
		])('records the pull request against %s', async (_name, prBranch, taskId) => {
			await recordTicketPullRequest(project, { prNumber: '7', prBranch });

			expect(recordWipSlotPullRequest).toHaveBeenCalledExactlyOnceWith(
				project.id,
				project.repo,
				taskId,
				'7',
			);
		});

		it('records nothing for a human branch under the prefix', async () => {
			await recordTicketPullRequest(project, { prNumber: '7', prBranch: 'issue-hotfix-2' });

			expect(recordWipSlotPullRequest).not.toHaveBeenCalled();
		});
	});

	it('names the repository, the count and the holders in the wait reason', () => {
		expect(
			wipLimitWaitReason(REPO, 1, [{ taskId: '1180', workItemTitle: null, openedAt: new Date() }]),
		).toBe(
			`Repository '${REPO}' is at its WIP limit (1/1 tickets in flight: #1180) — waiting for one to finish`,
		);
	});
});
