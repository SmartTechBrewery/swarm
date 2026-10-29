import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig, ProjectRecord } from '@/config/schema.js';
import type { WipSlotRow } from '@/db/repositories/wipSlotsRepository.js';
import type { WipReleaseCause } from '@/dispatch/wip-limit.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';
import { createMockProjectRecord, createMockWorkItem } from '../../helpers/factories.js';

const listWipSlots = vi.fn<() => Promise<WipSlotRow[]>>();
vi.mock('@/db/repositories/wipSlotsRepository.js', () => ({
	listWipSlots: () => listWipSlots(),
}));

const findProjectRecordByIdFromDb = vi.fn<(id: string) => Promise<ProjectRecord | undefined>>();
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectRecordByIdFromDb: (id: string) => findProjectRecordByIdFromDb(id),
}));

const findBoardItemIdForTask =
	vi.fn<(projectId: string, taskId: string) => Promise<string | undefined>>();
vi.mock('@/db/repositories/runsRepository.js', () => ({
	findBoardItemIdForTask: (projectId: string, taskId: string) =>
		findBoardItemIdForTask(projectId, taskId),
}));

const getWorkItem = vi.fn<(id: string) => Promise<WorkItem>>();
const listWorkItems = vi.fn();
const requireProjectPMProvider = vi.fn<(project: ProjectConfig) => PMProvider>();
vi.mock('@/integrations/pm/registry.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/integrations/pm/registry.js')>()),
	requireProjectPMProvider: (project: ProjectConfig) => requireProjectPMProvider(project),
}));

const releaseTicketSlot =
	vi.fn<
		(
			projectId: string,
			repository: string,
			taskId: string,
			cause: WipReleaseCause,
		) => Promise<boolean>
	>();
vi.mock('@/dispatch/wip-limit.js', () => ({
	releaseTicketSlot: (
		projectId: string,
		repository: string,
		taskId: string,
		cause: WipReleaseCause,
	) => releaseTicketSlot(projectId, repository, taskId, cause),
}));

import { sweepWipSlots, wipSlotReleaseCause } from '@/dispatch/wip-slot-sweep.js';

const REPO = 'SmartTechBrewery/swarm';

function slot(taskId: string, overrides: Partial<WipSlotRow> = {}): WipSlotRow {
	return {
		projectId: 'swarm',
		repository: REPO,
		taskId,
		workItemId: `ITEM_${taskId}`,
		...overrides,
	};
}

/** A card in the pipeline, labelled — one the sweep must keep. */
function liveCard(overrides: Partial<WorkItem> = {}): WorkItem {
	return createMockWorkItem({ statusKey: 'inProgress', ...overrides });
}

describe('wipSlotReleaseCause (issue #1189)', () => {
	const record = createMockProjectRecord();

	it('releases a card missing the automation label', () => {
		expect(wipSlotReleaseCause(slot('1'), liveCard({ labels: [] }), record)).toBe('label-removed');
	});

	it('keeps a labelled card in the pipeline', () => {
		expect(wipSlotReleaseCause(slot('1'), liveCard(), record)).toBeUndefined();
	});

	it('never releases on labels when the project disables the label gate', () => {
		const ungated = createMockProjectRecord({ pipeline: { automationLabel: '' } });

		expect(wipSlotReleaseCause(slot('1'), liveCard({ labels: [] }), ungated)).toBeUndefined();
	});

	it('reads a project-configured label rather than the default', () => {
		const custom = createMockProjectRecord({ pipeline: { automationLabel: 'automate' } });

		expect(wipSlotReleaseCause(slot('1'), liveCard(), custom)).toBe('label-removed');
	});

	it.each([
		['done', 'board-done'],
		['backlog', 'board-backlog'],
	])('releases a card whose status is %s', (statusKey, cause) => {
		expect(wipSlotReleaseCause(slot('1'), liveCard({ statusKey }), record)).toBe(cause);
	});

	it.each(['planning', 'todo', 'inProgress', 'inReview'])('keeps a card in %s', (statusKey) => {
		expect(wipSlotReleaseCause(slot('1'), liveCard({ statusKey }), record)).toBeUndefined();
	});

	it('releases a slot whose repository the project no longer owns, without a card', () => {
		expect(wipSlotReleaseCause(slot('1', { repository: 'acme/gone' }), undefined, record)).toBe(
			'repository-removed',
		);
	});

	it('keeps a slot whose card was not read', () => {
		expect(wipSlotReleaseCause(slot('1'), undefined, record)).toBeUndefined();
	});
});

describe('sweepWipSlots (issue #1189)', () => {
	beforeEach(() => {
		listWipSlots.mockReset();
		findProjectRecordByIdFromDb.mockReset();
		findProjectRecordByIdFromDb.mockResolvedValue(createMockProjectRecord());
		findBoardItemIdForTask.mockReset();
		findBoardItemIdForTask.mockResolvedValue(undefined);
		getWorkItem.mockReset();
		listWorkItems.mockReset();
		requireProjectPMProvider.mockReset();
		requireProjectPMProvider.mockReturnValue({
			getWorkItem,
			listWorkItems,
		} as unknown as PMProvider);
		releaseTicketSlot.mockReset();
		releaseTicketSlot.mockResolvedValue(true);
	});

	it('releases (and so promotes) a ticket whose card left automation, keeping the rest', async () => {
		listWipSlots.mockResolvedValue([slot('1'), slot('2'), slot('3')]);
		getWorkItem.mockImplementation(async (id) => {
			if (id === 'ITEM_1') return liveCard({ labels: [] });
			if (id === 'ITEM_2') return liveCard({ statusKey: 'done' });
			return liveCard();
		});

		const result = await sweepWipSlots();

		expect(releaseTicketSlot).toHaveBeenCalledTimes(2);
		expect(releaseTicketSlot).toHaveBeenCalledWith('swarm', REPO, '1', 'label-removed');
		expect(releaseTicketSlot).toHaveBeenCalledWith('swarm', REPO, '2', 'board-done');
		expect(result).toEqual({ slots: 3, reads: 3, released: 2, unreadable: 0 });
	});

	it('keeps the slot of a card whose read throws, and carries on with the pass', async () => {
		listWipSlots.mockResolvedValue([slot('1'), slot('2')]);
		getWorkItem.mockImplementation(async (id) => {
			if (id === 'ITEM_1') throw new Error('board unreachable');
			return liveCard({ statusKey: 'backlog' });
		});

		const result = await sweepWipSlots();

		expect(releaseTicketSlot).toHaveBeenCalledOnce();
		expect(releaseTicketSlot).toHaveBeenCalledWith('swarm', REPO, '2', 'board-backlog');
		expect(result).toMatchObject({ reads: 2, released: 1, unreadable: 1 });
	});

	it('reads each card at most once per pass and never lists the board', async () => {
		listWipSlots.mockResolvedValue([slot('1'), slot('2'), slot('3')]);
		getWorkItem.mockResolvedValue(liveCard());

		await sweepWipSlots();

		expect(getWorkItem).toHaveBeenCalledTimes(3);
		expect(listWorkItems).not.toHaveBeenCalled();
		// The project is loaded once and its provider resolved once, not per slot.
		expect(findProjectRecordByIdFromDb).toHaveBeenCalledOnce();
		expect(requireProjectPMProvider).toHaveBeenCalledOnce();
	});

	it('falls back to the card recorded on the ticket’s runs for a slot without one', async () => {
		listWipSlots.mockResolvedValue([slot('1', { workItemId: null })]);
		findBoardItemIdForTask.mockResolvedValue('ITEM_FROM_RUNS');
		getWorkItem.mockResolvedValue(liveCard({ statusKey: 'done' }));

		await sweepWipSlots();

		expect(findBoardItemIdForTask).toHaveBeenCalledWith('swarm', '1');
		expect(getWorkItem).toHaveBeenCalledWith('ITEM_FROM_RUNS');
		expect(releaseTicketSlot).toHaveBeenCalledWith('swarm', REPO, '1', 'board-done');
	});

	it('keeps a slot no card can be found for, without a board read', async () => {
		listWipSlots.mockResolvedValue([slot('1', { workItemId: null })]);

		const result = await sweepWipSlots();

		expect(getWorkItem).not.toHaveBeenCalled();
		expect(releaseTicketSlot).not.toHaveBeenCalled();
		expect(result).toMatchObject({ reads: 0, unreadable: 1 });
	});

	it('releases a removed repository’s slots without reading their cards', async () => {
		listWipSlots.mockResolvedValue([slot('1', { repository: 'acme/gone' })]);

		await sweepWipSlots();

		expect(getWorkItem).not.toHaveBeenCalled();
		expect(releaseTicketSlot).toHaveBeenCalledWith('swarm', 'acme/gone', '1', 'repository-removed');
	});

	it('keeps a project’s slots when its PM provider cannot be resolved, and sweeps the next project', async () => {
		listWipSlots.mockResolvedValue([slot('1'), slot('2', { projectId: 'other' })]);
		findProjectRecordByIdFromDb.mockImplementation(async (id) =>
			createMockProjectRecord({ id, name: id }),
		);
		requireProjectPMProvider.mockImplementationOnce(() => {
			throw new Error('unregistered provider');
		});
		getWorkItem.mockResolvedValue(liveCard({ labels: [] }));

		const result = await sweepWipSlots();

		expect(releaseTicketSlot).toHaveBeenCalledOnce();
		expect(releaseTicketSlot).toHaveBeenCalledWith('other', REPO, '2', 'label-removed');
		expect(result).toMatchObject({ released: 1, unreadable: 1 });
	});

	it('does nothing, and never throws, when the slot list cannot be read', async () => {
		listWipSlots.mockRejectedValue(new Error('db down'));

		await expect(sweepWipSlots()).resolves.toMatchObject({ slots: 0, reads: 0 });
		expect(findProjectRecordByIdFromDb).not.toHaveBeenCalled();
	});
});
