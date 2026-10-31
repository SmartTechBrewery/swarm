import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItemDependent } from '@/pm/types.js';
import type { TriggerResult } from '@/triggers/types.js';
import { notifyBlockingFailure } from '@/worker/failure-notification.js';
import { createMockProjectConfig, createMockWorkItem } from '../../helpers/factories.js';

const listDependents = vi.fn(async (_id: string): Promise<WorkItemDependent[]> => []);
let supportsDependencies = true;
vi.mock('@/integrations/pm/registry.js', async (importOriginal) => ({
	// The project factory validates credentials against the real registry.
	...(await importOriginal<typeof import('@/integrations/pm/registry.js')>()),
	requireProjectPMProvider: () => ({
		get supportsDependencies() {
			return supportsDependencies;
		},
		listDependents: (id: string) => listDependents(id),
	}),
}));

const findBoardItemIdForTask = vi.fn(
	async (_projectId: string, _taskId: string): Promise<string | undefined> => undefined,
);
vi.mock('@/db/repositories/runsRepository.js', () => ({
	findBoardItemIdForTask: (projectId: string, taskId: string) =>
		findBoardItemIdForTask(projectId, taskId),
	// No recorded Implementation branch: the PR branch's task comes from its decode.
	findTaskIdForStoredTaskBranch: async () => undefined,
}));

const WEBHOOK = 'https://hooks.example.test/swarm';
const ERROR =
	'Implementation agent timed out — checkpoint continuation ceiling reached (6 of 6 continuations used, pipeline.maxContinuations)';
const IMPLEMENTATION: TriggerResult = {
	phase: 'implementation',
	taskId: '1963',
	workItem: createMockWorkItem({ id: 'ITEM_1963' }),
};
// A pull-request phase's own task id is the PR number, never the card's task.
const REVIEW: TriggerResult = {
	phase: 'review',
	taskId: '1980',
	prNumber: '1980',
	prBranch: 'issue-1963',
	headSha: 'deadbeef',
};
const RESPOND_TO_CI: TriggerResult = {
	phase: 'respond-to-ci',
	taskId: '1980-ci',
	prNumber: '1980',
	prBranch: 'issue-1963',
	headSha: 'deadbeef',
};

const dependent = (reference: string, open = true): WorkItemDependent => ({
	reference,
	title: `Part ${reference}`,
	url: `https://example.test/issues/${reference.slice(1)}`,
	open,
});

function project(failureNotifications?: { enabled?: boolean; webhookUrl?: string }) {
	return createMockProjectConfig({ pipeline: { failureNotifications } });
}

function okFetch() {
	return vi.fn(async (_url: string, _init: { body: string }) => ({ ok: true, status: 200 }));
}

// Issue #1257: a run that fails terminally while other work items wait on its own tells
// the operator through the project's webhook, naming the run, the reason and the items.
describe('notifyBlockingFailure', () => {
	beforeEach(() => {
		supportsDependencies = true;
		listDependents.mockReset();
		listDependents.mockResolvedValue([]);
		findBoardItemIdForTask.mockReset();
		findBoardItemIdForTask.mockResolvedValue(undefined);
	});

	it('posts the run, the reason and the open items waiting on it', async () => {
		listDependents.mockResolvedValue([dependent('#1964'), dependent('#1965', false)]);
		const fetchImpl = okFetch();

		await notifyBlockingFailure(
			{
				project: project({ webhookUrl: WEBHOOK }),
				trigger: IMPLEMENTATION,
				runId: 'run-1',
				error: ERROR,
			},
			fetchImpl,
		);

		expect(listDependents).toHaveBeenCalledWith('ITEM_1963');
		expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
			WEBHOOK,
			expect.objectContaining({ method: 'POST' }),
		);
		const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
		expect(body).toMatchObject({
			run: { id: 'run-1', phase: 'implementation', taskId: '1963' },
			reason: ERROR,
			// A closed dependent is not waiting.
			waiting: [
				{ reference: '#1964', title: 'Part #1964', url: 'https://example.test/issues/1964' },
			],
		});
		expect(body.text).toContain('run-1');
		expect(body.text).toContain('#1964 Part #1964');
		expect(body.text).toContain('checkpoint continuation ceiling reached');
	});

	it.each([
		['Review', REVIEW],
		['Respond-to-CI', RESPOND_TO_CI],
	])("finds a %s run's work item through its branch's task, not the PR number", async (_phase, trigger) => {
		findBoardItemIdForTask.mockImplementation(async (_projectId, taskId) =>
			taskId === '1963' ? 'ITEM_1963' : undefined,
		);
		listDependents.mockResolvedValue([dependent('#1964')]);
		const fetchImpl = okFetch();

		await notifyBlockingFailure(
			{ project: project({ webhookUrl: WEBHOOK }), trigger, runId: 'run-2', error: ERROR },
			fetchImpl,
		);

		expect(findBoardItemIdForTask).toHaveBeenCalledExactlyOnceWith(expect.any(String), '1963');
		expect(listDependents).toHaveBeenCalledWith('ITEM_1963');
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it('sends nothing for a pull-request phase whose branch names no task', async () => {
		listDependents.mockResolvedValue([dependent('#1964')]);
		const fetchImpl = okFetch();

		await notifyBlockingFailure(
			{
				project: project({ webhookUrl: WEBHOOK }),
				trigger: { ...REVIEW, prBranch: 'hand-named-fix' },
				runId: 'run-2',
				error: ERROR,
			},
			fetchImpl,
		);

		expect(findBoardItemIdForTask).not.toHaveBeenCalled();
		expect(listDependents).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each([
		['no webhook is configured', undefined],
		['notifications are turned off', { enabled: false, webhookUrl: WEBHOOK }],
	])('sends nothing when %s', async (_case, config) => {
		listDependents.mockResolvedValue([dependent('#1964')]);
		const fetchImpl = okFetch();

		await notifyBlockingFailure(
			{ project: project(config), trigger: IMPLEMENTATION, runId: 'run-1', error: ERROR },
			fetchImpl,
		);

		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('sends nothing when no open item waits on the run', async () => {
		listDependents.mockResolvedValue([dependent('#1964', false)]);
		const fetchImpl = okFetch();

		await notifyBlockingFailure(
			{
				project: project({ webhookUrl: WEBHOOK }),
				trigger: IMPLEMENTATION,
				runId: 'run-1',
				error: ERROR,
			},
			fetchImpl,
		);

		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('sends nothing for a provider with no dependency graph', async () => {
		supportsDependencies = false;
		const fetchImpl = okFetch();

		await notifyBlockingFailure(
			{
				project: project({ webhookUrl: WEBHOOK }),
				trigger: IMPLEMENTATION,
				runId: 'run-1',
				error: ERROR,
			},
			fetchImpl,
		);

		expect(listDependents).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('never throws when the board read or the webhook fails', async () => {
		listDependents.mockRejectedValueOnce(new Error('board unavailable'));
		const failing = project({ webhookUrl: WEBHOOK });
		await expect(
			notifyBlockingFailure(
				{ project: failing, trigger: IMPLEMENTATION, runId: 'run-1', error: ERROR },
				okFetch(),
			),
		).resolves.toBeUndefined();

		listDependents.mockResolvedValue([dependent('#1964')]);
		await expect(
			notifyBlockingFailure(
				{ project: failing, trigger: IMPLEMENTATION, runId: 'run-1', error: ERROR },
				vi.fn(async () => ({ ok: false, status: 502 })),
			),
		).resolves.toBeUndefined();
	});
});
