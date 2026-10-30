import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { releaseTicketSlot as ReleaseTicketSlot } from '@/dispatch/wip-limit.js';

vi.mock('@/dispatch/wip-limit.js', () => ({
	releaseTicketSlot: vi.fn<typeof ReleaseTicketSlot>(),
}));

import { releaseTicketSlot } from '@/dispatch/wip-limit.js';
import type { ScmEvent } from '@/scm/events.js';
import { createWipReleaseTrigger } from '@/triggers/handlers/wip-release.js';
import type { TriggerContext } from '@/triggers/types.js';
import {
	createMockPmEvent,
	createMockProjectConfig,
	createMockScmTriggerContext,
} from '../../../helpers/factories.js';

const PROJECT = createMockProjectConfig();
const trigger = createWipReleaseTrigger();

function closed(overrides: Partial<ScmEvent> = {}) {
	return createMockScmTriggerContext({
		project: PROJECT,
		event: {
			kind: 'pull-request',
			action: 'closed',
			repoFullName: PROJECT.repo,
			workItemId: '99',
			prBranch: 'issue-42',
			baseBranch: 'main',
			isCommentEvent: false,
			merged: true,
			...overrides,
		},
	});
}

beforeEach(() => {
	vi.mocked(releaseTicketSlot).mockReset();
	vi.mocked(releaseTicketSlot).mockResolvedValue(true);
});

// Issue #1185: a ticket's pull request closing frees its repository WIP slot.
describe('wip-release trigger', () => {
	it('releases the ticket of a merged pull request and yields', async () => {
		const ctx = closed();

		expect(trigger.matches(ctx)).toBe(true);
		expect(await trigger.handle(ctx)).toBeNull();
		expect(releaseTicketSlot).toHaveBeenCalledExactlyOnceWith(
			PROJECT.id,
			PROJECT.repo,
			'42',
			'pull-request-merged',
		);
	});

	it('releases the ticket of a pull request closed without merging', async () => {
		await trigger.handle(closed({ merged: false }));

		expect(releaseTicketSlot).toHaveBeenCalledExactlyOnceWith(
			PROJECT.id,
			PROJECT.repo,
			'42',
			'pull-request-closed',
		);
	});

	it('releases the ticket of a board-key task branch (issue #1226)', async () => {
		await trigger.handle(closed({ prBranch: 'issue-VT-1538' }));

		expect(releaseTicketSlot).toHaveBeenCalledExactlyOnceWith(
			PROJECT.id,
			PROJECT.repo,
			'VT-1538',
			'pull-request-merged',
		);
	});

	it.each([
		['a branch SWARM did not name', 'feature/x'],
		['a lowercase human branch under the prefix', 'issue-hotfix-2'],
		['a suffixed branch under the strict rule', 'issue-12-foo'],
	])('frees nothing for %s', async (_name, prBranch) => {
		expect(await trigger.handle(closed({ prBranch }))).toBeNull();
		expect(releaseTicketSlot).not.toHaveBeenCalled();
	});

	it('frees nothing for a close that names no branch', async () => {
		expect(await trigger.handle(closed({ prBranch: undefined }))).toBeNull();
		expect(releaseTicketSlot).not.toHaveBeenCalled();
	});

	it.each([
		['an opened pull request', closed({ action: 'opened' })],
		['a conflict fan-out re-check', closed({ conflictPrNumber: '7' })],
		['a merge catch-up', { ...closed(), mergeCatchUp: { reviewRunId: 'run-1', headSha: 'abc' } }],
		['a review event', closed({ kind: 'pull-request-review' })],
	])('does not match %s', (_name, ctx) => {
		expect(trigger.matches(ctx)).toBe(false);
	});

	it('does not match a board event', () => {
		const ctx = {
			project: PROJECT,
			dispatchId: 'dispatch-1',
			source: 'pm',
			providerId: 'github-projects',
			event: createMockPmEvent(),
		} as unknown as TriggerContext;

		expect(trigger.matches(ctx)).toBe(false);
	});
});
