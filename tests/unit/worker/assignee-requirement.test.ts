import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedAssignee } from '@/identity/assignee-resolver.js';
import type { PMProvider, WorkItemAssignee } from '@/pm/types.js';
import { checkAssigneeRequirement, resolveRequireAssignee } from '@/worker/assignee-requirement.js';

const resolveAssignedUser = vi.fn<
	(
		workItem: { assignees: WorkItemAssignee[] },
		provider: string,
	) => Promise<ResolvedAssignee | undefined>
>(async () => undefined);
vi.mock('@/identity/assignee-resolver.js', () => ({
	resolveAssignedUser: (workItem: { assignees: WorkItemAssignee[] }, provider: string) =>
		resolveAssignedUser(workItem, provider),
}));

const PM: Pick<PMProvider, 'type' | 'supportsAssignees'> = {
	type: 'github-projects',
	supportsAssignees: true,
};
const LINKED = { user: { id: 'u-alice' }, assignee: { handle: 'alice' } } as ResolvedAssignee;

beforeEach(() => {
	resolveAssignedUser.mockReset();
	resolveAssignedUser.mockResolvedValue(undefined);
});

describe('resolveRequireAssignee', () => {
	it('is off when the project has no pipeline block or omits the setting', () => {
		expect(resolveRequireAssignee(undefined)).toBe(false);
		expect(resolveRequireAssignee({})).toBe(false);
		expect(resolveRequireAssignee({ requireAssignee: false })).toBe(false);
	});

	it('is on only when the project sets it', () => {
		expect(resolveRequireAssignee({ requireAssignee: true })).toBe(true);
	});
});

describe('checkAssigneeRequirement', () => {
	it('is satisfied by an assignee linked to a SWARM user', async () => {
		resolveAssignedUser.mockResolvedValue(LINKED);
		const item = { assignees: [{ handle: 'alice' }] };

		await expect(checkAssigneeRequirement(item, PM)).resolves.toEqual({ satisfied: true });
		expect(resolveAssignedUser).toHaveBeenCalledWith(item, 'github-projects');
	});

	it('refuses an item with no assignee, without resolving anything', async () => {
		const verdict = await checkAssigneeRequirement({ assignees: [] }, PM);

		expect(verdict).toMatchObject({
			satisfied: false,
			cause: 'unassigned',
			message: expect.stringContaining('this item has no assignee'),
		});
		expect(resolveAssignedUser).not.toHaveBeenCalled();
	});

	it('refuses an unlinked assignee, naming the handle and how to link it', async () => {
		const verdict = await checkAssigneeRequirement({ assignees: [{ handle: 'octocat' }] }, PM);

		expect(verdict).toMatchObject({ satisfied: false, cause: 'unlinked' });
		if (verdict.satisfied) throw new Error('unreachable');
		expect(verdict.message).toContain("assignee 'octocat' is not linked to a SWARM user");
		expect(verdict.message).toContain(
			'swarm identities link --user <identifier> --provider github-projects --handle octocat',
		);
	});

	it('names every unlinked assignee', async () => {
		const verdict = await checkAssigneeRequirement(
			{ assignees: [{ handle: 'a' }, { handle: 'b' }] },
			PM,
		);

		if (verdict.satisfied) throw new Error('unreachable');
		expect(verdict.message).toContain("assignees 'a', 'b' are not linked");
	});

	it('refuses everything for a provider without assignees, naming the provider', async () => {
		const verdict = await checkAssigneeRequirement(
			{ assignees: [{ handle: 'alice' }] },
			{ type: 'trello', supportsAssignees: false },
		);

		expect(verdict).toMatchObject({ satisfied: false, cause: 'assignees-unsupported' });
		if (verdict.satisfied) throw new Error('unreachable');
		expect(verdict.message).toContain("PM provider 'trello' does not model assignees");
		expect(resolveAssignedUser).not.toHaveBeenCalled();
	});
});
