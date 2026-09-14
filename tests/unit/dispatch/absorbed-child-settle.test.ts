import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunRow } from '@/db/repositories/runsRepository.js';
import type { retireSupersededBoardPhases as RetireSuperseded } from '@/dispatch/board-phase-retirement.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';
import type { ReviewAbsorbed } from '@/scm/delivery.js';

vi.mock('@/db/repositories/runsRepository.js', () => ({
	getReviewAbsorbedForPullRequest: vi.fn<() => Promise<ReviewAbsorbed[]>>(),
	getRunByIdFromDb: vi.fn<() => Promise<RunRow | undefined>>(),
}));

// Partial: `createMockProjectConfig` parses a config whose credential refinement
// reads `getPMProvider` off this very module, so replacing the whole registry
// would break the fixture rather than the subject.
vi.mock('@/integrations/pm/registry.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/integrations/pm/registry.js')>()),
	requireProjectPMProvider: vi.fn<() => PMProvider>(),
}));

vi.mock('@/dispatch/board-phase-retirement.js', () => ({
	retireSupersededBoardPhases: vi.fn<typeof RetireSuperseded>(),
}));

import {
	getReviewAbsorbedForPullRequest,
	getRunByIdFromDb,
} from '@/db/repositories/runsRepository.js';
import { absorbedChildMarker, settleAbsorbedChildren } from '@/dispatch/absorbed-child-settle.js';
import { retireSupersededBoardPhases } from '@/dispatch/board-phase-retirement.js';
import { requireProjectPMProvider } from '@/integrations/pm/registry.js';
import { SPLIT_CHILD_LABEL } from '@/pipeline/preplan.js';
import { createMockProjectConfig, createMockWorkItem } from '../../helpers/factories.js';

const PROJECT = createMockProjectConfig();
const REPOSITORY = PROJECT.repo;
const PR_NUMBER = '965';
/** The task the merged pull request itself delivers — never settled by this. */
const OWN_TASK_ID = '959';

const INPUT = {
	project: PROJECT,
	dispatchId: 'dispatch-merge',
	reviewRunId: 'run-review',
	repository: REPOSITORY,
	prNumber: PR_NUMBER,
};

const DECLARED: ReviewAbsorbed = {
	url: `https://github.com/${REPOSITORY}/issues/947`,
	reference: '#947',
	evidence: 'Its only criterion — the close capability — is `closeWorkItem` in this diff.',
};

/** A declared split child as the board holds it: labelled, open, in this repository. */
function child(overrides: Partial<WorkItem> = {}): WorkItem {
	return createMockWorkItem({
		id: 'PVTI_child',
		url: DECLARED.url,
		status: 'Ready',
		statusId: '61e4505c',
		labels: [{ id: 'LA_split', name: SPLIT_CHILD_LABEL }],
		...overrides,
	});
}

/**
 * The board this settle runs against. Every method a guard or a write touches is a
 * spy; the rest throw, so a call this module should never make fails the test
 * rather than passing silently.
 */
function board(overrides: Partial<PMProvider> = {}): PMProvider {
	return {
		type: 'github-projects',
		getWorkItem: async () => {
			throw new Error('getWorkItem must not be called');
		},
		listWorkItems: async () => {
			throw new Error('a one-card lookup must not read the board');
		},
		findWorkItemByUrlSuffix: vi.fn(async () => child()),
		findWorkItemForArtifact: async () => undefined,
		findWorkItemByDescriptionMarker: async () => undefined,
		moveWorkItem: async () => undefined,
		closeWorkItem: vi.fn(async () => undefined),
		addComment: vi.fn(async () => 'comment-1'),
		findComment: vi.fn(async () => undefined),
		createWorkItem: async () => child(),
		updateWorkItem: async () => undefined,
		addLabel: async () => undefined,
		supportsDependencies: true,
		supportsAssignees: true,
		listBlockers: async () => [],
		listDependents: async () => [],
		addBlockedBy: async () => undefined,
		resolveItemRepository: async () => ({ status: 'unrouted' }),
		...overrides,
	};
}

/** Stage the declarations and the board, and answer the run read with the PR's own task. */
function stage(declared: ReviewAbsorbed[], pm: PMProvider): PMProvider {
	vi.mocked(getReviewAbsorbedForPullRequest).mockResolvedValue(declared);
	vi.mocked(getRunByIdFromDb).mockResolvedValue({
		id: INPUT.reviewRunId,
		taskId: OWN_TASK_ID,
		repository: REPOSITORY,
	} as RunRow);
	vi.mocked(requireProjectPMProvider).mockReturnValue(pm);
	return pm;
}

beforeEach(() => {
	vi.mocked(getReviewAbsorbedForPullRequest).mockReset();
	vi.mocked(getRunByIdFromDb).mockReset();
	vi.mocked(requireProjectPMProvider).mockReset();
	vi.mocked(retireSupersededBoardPhases).mockReset().mockResolvedValue(0);
});

describe('settleAbsorbedChildren', () => {
	it('comments on, closes, and retires the queued phase of a declared split child', async () => {
		const pm = stage([DECLARED], board());

		expect(await settleAbsorbedChildren(INPUT)).toEqual(['#947']);

		expect(pm.findWorkItemByUrlSuffix).toHaveBeenCalledWith(DECLARED.url);
		const body = vi.mocked(pm.addComment).mock.calls[0]?.[1] ?? '';
		expect(body).toContain(`${REPOSITORY}#${PR_NUMBER}`);
		expect(body).toContain(DECLARED.evidence);
		expect(body).toContain(absorbedChildMarker(REPOSITORY, PR_NUMBER));
		expect(pm.closeWorkItem).toHaveBeenCalledWith('PVTI_child');
		expect(retireSupersededBoardPhases).toHaveBeenCalledWith({
			projectId: PROJECT.id,
			taskId: '947',
			keepPhase: undefined,
			excludeDispatchId: INPUT.dispatchId,
		});
	});

	it('settles nothing when no Review run declared anything', async () => {
		const pm = stage([], board());

		expect(await settleAbsorbedChildren(INPUT)).toEqual([]);
		expect(pm.findWorkItemByUrlSuffix).not.toHaveBeenCalled();
		expect(pm.closeWorkItem).not.toHaveBeenCalled();
	});

	it('leaves a card that is not a SWARM split child completely alone', async () => {
		const pm = stage(
			[DECLARED],
			board({
				findWorkItemByUrlSuffix: vi.fn(async () =>
					child({ labels: [{ id: 'LA_bug', name: 'bug' }] }),
				),
			}),
		);

		expect(await settleAbsorbedChildren(INPUT)).toEqual([]);
		expect(pm.addComment).not.toHaveBeenCalled();
		expect(pm.closeWorkItem).not.toHaveBeenCalled();
		expect(retireSupersededBoardPhases).not.toHaveBeenCalled();
	});

	it("leaves the pull request's own task alone", async () => {
		const pm = stage(
			[DECLARED],
			board({
				findWorkItemByUrlSuffix: vi.fn(async () =>
					child({ url: `https://github.com/${REPOSITORY}/issues/${OWN_TASK_ID}` }),
				),
			}),
		);

		expect(await settleAbsorbedChildren(INPUT)).toEqual([]);
		expect(pm.closeWorkItem).not.toHaveBeenCalled();
	});

	it('settles a same-numbered card in another repository, which is not its own task', async () => {
		const pm = stage(
			[DECLARED],
			board({
				findWorkItemByUrlSuffix: vi.fn(async () =>
					child({ url: `https://github.com/SmartTechBrewery/rover/issues/${OWN_TASK_ID}` }),
				),
			}),
		);

		expect(await settleAbsorbedChildren(INPUT)).toEqual(['#947']);
		expect(pm.closeWorkItem).toHaveBeenCalledWith('PVTI_child');
		// Retirement keys on `(projectId, taskId)` alone, so a card whose artifact
		// lives elsewhere is left queued rather than retiring this repository's
		// same-numbered task.
		expect(retireSupersededBoardPhases).not.toHaveBeenCalled();
	});

	it('leaves an already-settled card alone, so a re-run of the dispatch is a no-op', async () => {
		const pm = stage(
			[DECLARED],
			board({
				findWorkItemByUrlSuffix: vi.fn(async () => child({ status: 'Done', statusId: '98236657' })),
			}),
		);

		expect(await settleAbsorbedChildren(INPUT)).toEqual([]);
		expect(pm.addComment).not.toHaveBeenCalled();
		expect(pm.closeWorkItem).not.toHaveBeenCalled();
	});

	it('skips a declared URL no card on this board wraps', async () => {
		const pm = stage([DECLARED], board({ findWorkItemByUrlSuffix: vi.fn(async () => undefined) }));

		expect(await settleAbsorbedChildren(INPUT)).toEqual([]);
		expect(pm.closeWorkItem).not.toHaveBeenCalled();
	});

	it('skips a card that names no source-control artifact', async () => {
		const pm = stage(
			[DECLARED],
			board({
				findWorkItemByUrlSuffix: vi.fn(async () =>
					child({ taskRef: undefined, taskRepository: undefined }),
				),
			}),
		);

		expect(await settleAbsorbedChildren(INPUT)).toEqual([]);
		expect(pm.closeWorkItem).not.toHaveBeenCalled();
	});

	it('posts no second comment when its marker is already there, and still closes', async () => {
		const pm = stage([DECLARED], board({ findComment: vi.fn(async () => 'existing-comment') }));

		expect(await settleAbsorbedChildren(INPUT)).toEqual(['#947']);
		expect(pm.findComment).toHaveBeenCalledWith(
			'PVTI_child',
			absorbedChildMarker(REPOSITORY, PR_NUMBER),
		);
		expect(pm.addComment).not.toHaveBeenCalled();
		expect(pm.closeWorkItem).toHaveBeenCalledWith('PVTI_child');
	});

	it('carries on to the next entry when one close fails, and never throws', async () => {
		const second: ReviewAbsorbed = {
			url: `https://github.com/${REPOSITORY}/issues/948`,
			reference: '#948',
			evidence: 'Its acceptance criteria are met by the same diff.',
		};
		const pm = stage(
			[DECLARED, second],
			board({
				findWorkItemByUrlSuffix: vi.fn(async (urlSuffix: string) =>
					child({ id: urlSuffix === second.url ? 'PVTI_second' : 'PVTI_child', url: urlSuffix }),
				),
				closeWorkItem: vi.fn(async (id: string) => {
					if (id === 'PVTI_child') throw new Error('board write refused');
				}),
			}),
		);

		expect(await settleAbsorbedChildren(INPUT)).toEqual(['#948']);
		expect(pm.closeWorkItem).toHaveBeenCalledTimes(2);
	});

	it('settles nothing when the Review run row is gone', async () => {
		const pm = board();
		vi.mocked(getReviewAbsorbedForPullRequest).mockResolvedValue([DECLARED]);
		vi.mocked(getRunByIdFromDb).mockResolvedValue(undefined);
		vi.mocked(requireProjectPMProvider).mockReturnValue(pm);

		expect(await settleAbsorbedChildren(INPUT)).toEqual([]);
		expect(pm.findWorkItemByUrlSuffix).not.toHaveBeenCalled();
	});

	it('answers [] rather than throwing when the declaration read fails', async () => {
		vi.mocked(getReviewAbsorbedForPullRequest).mockRejectedValue(new Error('database down'));

		expect(await settleAbsorbedChildren(INPUT)).toEqual([]);
	});
});
