import { describe, expect, it, vi } from 'vitest';

import { DependencyBlockedError, findOpenBlockers } from '@/pipeline/dependency-guard.js';
import type { PMProvider, WorkItem, WorkItemBlocker } from '@/pm/types.js';
import { createMockWorkItem } from '../../helpers/factories.js';

function pmWith(
	overrides: Partial<Pick<PMProvider, 'supportsDependencies' | 'listBlockers'>>,
): PMProvider {
	return {
		type: 'github-projects',
		getWorkItem: vi.fn(),
		listWorkItems: vi.fn(async () => []),
		findWorkItemByUrlSuffix: vi.fn(async () => undefined),
		findWorkItemForArtifact: vi.fn(async () => undefined),
		findWorkItemByDescriptionMarker: vi.fn(async () => undefined),
		moveWorkItem: vi.fn(async () => {}),
		addComment: vi.fn(async () => 'c1'),
		findComment: vi.fn(async () => undefined),
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

const workItem: WorkItem = createMockWorkItem({ id: 'PVTI_1' });

describe('findOpenBlockers', () => {
	it('returns the open blockers from the provider', async () => {
		const pm = pmWith({
			listBlockers: vi.fn(async () => [blocker(), blocker({ reference: '#5', open: false })]),
		});
		const open = await findOpenBlockers(pm, workItem);
		expect(open.map((b) => b.reference)).toEqual(['#319']);
	});

	it('returns [] (proceeds) when the provider cannot model dependencies', async () => {
		const listBlockers = vi.fn(async () => [blocker()]);
		const pm = pmWith({ supportsDependencies: false, listBlockers });
		expect(await findOpenBlockers(pm, workItem)).toEqual([]);
		// Never even queried — the gate is inert for such a provider.
		expect(listBlockers).not.toHaveBeenCalled();
	});

	it('fails open (proceeds) when the blocker lookup throws', async () => {
		const pm = pmWith({
			listBlockers: vi.fn(async () => {
				throw new Error('GitHub 500');
			}),
		});
		expect(await findOpenBlockers(pm, workItem)).toEqual([]);
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
