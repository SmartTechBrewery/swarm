import { describe, expect, it, vi } from 'vitest';

import { DependencyBlockedError, findGatingBlockers } from '@/pipeline/dependency-guard.js';
import type { PMProvider, WorkItem, WorkItemBlocker } from '@/pm/types.js';
import { createMockWorkItem } from '../../helpers/factories.js';

type PmOverrides = Partial<
	Pick<PMProvider, 'supportsDependencies' | 'listBlockers' | 'findComment' | 'addComment'>
>;

function pmWith(overrides: PmOverrides): PMProvider {
	return {
		type: 'github-projects',
		getWorkItem: vi.fn(),
		listWorkItems: vi.fn(async () => []),
		findWorkItemByUrlSuffix: vi.fn(async () => undefined),
		findWorkItemForArtifact: vi.fn(async () => undefined),
		findWorkItemByDescriptionMarker: vi.fn(async () => undefined),
		moveWorkItem: vi.fn(async () => {}),
		addComment: overrides.addComment ?? vi.fn(async () => 'c1'),
		findComment: overrides.findComment ?? vi.fn(async () => undefined),
		createWorkItem: vi.fn(async () => createMockWorkItem()),
		updateWorkItem: vi.fn(async () => {}),
		addLabel: vi.fn(async () => {}),
		supportsDependencies: overrides.supportsDependencies ?? true,
		supportsAssignees: true,
		listBlockers: overrides.listBlockers ?? vi.fn(async () => []),
		addBlockedBy: vi.fn(async () => {}),
	};
}

function blocker(overrides: Partial<WorkItemBlocker> = {}): WorkItemBlocker {
	return {
		reference: '#319',
		url: 'https://github.com/o/r/issues/319',
		title: 'Session auth',
		open: true,
		source: 'dependency',
		...overrides,
	};
}

/** A still-open prerequisite whose only evidence is a sentence — advisory since issue #643. */
function mention(overrides: Partial<WorkItemBlocker> = {}): WorkItemBlocker {
	return blocker({
		reference: '#631',
		url: 'https://github.com/o/r/issues/631',
		title: 'Hold PM credentials per provider',
		source: 'mention',
		...overrides,
	});
}

const workItem: WorkItem = createMockWorkItem({ id: 'PVTI_1' });

describe('findGatingBlockers', () => {
	it('returns the open native blockers from the provider', async () => {
		const pm = pmWith({
			listBlockers: vi.fn(async () => [blocker(), blocker({ reference: '#5', open: false })]),
		});
		const gating = await findGatingBlockers(pm, workItem);
		expect(gating.map((b) => b.reference)).toEqual(['#319']);
	});

	it('returns [] (proceeds) when the provider cannot model dependencies', async () => {
		const listBlockers = vi.fn(async () => [blocker()]);
		const pm = pmWith({ supportsDependencies: false, listBlockers });
		expect(await findGatingBlockers(pm, workItem)).toEqual([]);
		// Never even queried — the gate is inert for such a provider.
		expect(listBlockers).not.toHaveBeenCalled();
	});

	it('fails open (proceeds) when the blocker lookup throws', async () => {
		const pm = pmWith({
			listBlockers: vi.fn(async () => {
				throw new Error('GitHub 500');
			}),
		});
		expect(await findGatingBlockers(pm, workItem)).toEqual([]);
	});

	// Issue #643 — the whole point: a sentence carries no scheduling authority.
	it('does not gate on a blocker whose only source is a prose mention', async () => {
		const pm = pmWith({ listBlockers: vi.fn(async () => [mention()]) });
		expect(await findGatingBlockers(pm, workItem)).toEqual([]);
	});

	it('gates on the native blockers only, when both sources are open', async () => {
		const pm = pmWith({ listBlockers: vi.fn(async () => [mention(), blocker()]) });
		const gating = await findGatingBlockers(pm, workItem);
		expect(gating.map((b) => b.reference)).toEqual(['#319']);
	});

	it('surfaces a prose-only prerequisite as a notice on the item', async () => {
		const addComment = vi.fn(async () => 'c1');
		const pm = pmWith({ listBlockers: vi.fn(async () => [mention()]), addComment });
		await findGatingBlockers(pm, workItem);
		expect(addComment).toHaveBeenCalledTimes(1);
		const [itemId, body] = addComment.mock.calls[0] as unknown as [string, string];
		expect(itemId).toBe('PVTI_1');
		expect(body).toContain('#631');
		expect(body).toContain('Hold PM credentials per provider');
		// Names the notice's own marker, so the next re-check recognises it.
		expect(body).toContain('<!-- swarm-prose-dependency:#631 -->');
	});

	it('does not re-post the notice once this reference set has one', async () => {
		const addComment = vi.fn(async () => 'c1');
		const findComment = vi.fn(async () => 'existing-comment-id');
		const pm = pmWith({ listBlockers: vi.fn(async () => [mention()]), addComment, findComment });
		await findGatingBlockers(pm, workItem);
		expect(findComment).toHaveBeenCalledWith('PVTI_1', '<!-- swarm-prose-dependency:#631 -->');
		expect(addComment).not.toHaveBeenCalled();
	});

	it('posts no notice when every blocker is a recorded relationship', async () => {
		const addComment = vi.fn(async () => 'c1');
		const findComment = vi.fn(async () => undefined);
		const pm = pmWith({ listBlockers: vi.fn(async () => [blocker()]), addComment, findComment });
		await findGatingBlockers(pm, workItem);
		expect(findComment).not.toHaveBeenCalled();
		expect(addComment).not.toHaveBeenCalled();
	});

	it('still proceeds when posting the notice fails', async () => {
		const pm = pmWith({
			listBlockers: vi.fn(async () => [mention(), blocker()]),
			addComment: vi.fn(async () => {
				throw new Error('board write refused');
			}),
		});
		// The board write is best-effort: the gate keeps its verdict either way.
		const gating = await findGatingBlockers(pm, workItem);
		expect(gating.map((b) => b.reference)).toEqual(['#319']);
	});

	it('ignores a closed prose mention entirely — nothing to surface', async () => {
		const addComment = vi.fn(async () => 'c1');
		const pm = pmWith({ listBlockers: vi.fn(async () => [mention({ open: false })]), addComment });
		expect(await findGatingBlockers(pm, workItem)).toEqual([]);
		expect(addComment).not.toHaveBeenCalled();
	});
});

describe('DependencyBlockedError', () => {
	it('summarises the blockers in its message', () => {
		const err = new DependencyBlockedError(workItem, [blocker()]);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('DependencyBlockedError');
		expect(err.message).toContain('#319');
		expect(err.blockers).toHaveLength(1);
		expect(err.workItem.id).toBe('PVTI_1');
	});
});
