import { describe, expect, it } from 'vitest';
import type { StalledItem } from '@/types/runs.js';
import { queuedPhaseLabel } from './queued-runs.js';
import { stalledItemKey, stalledItemRun, stalledPhaseLabel } from './stalled-items.js';

function pullRequestItem(overrides: Partial<StalledItem> = {}): StalledItem {
	return {
		projectId: 'proj',
		repository: 'acme/widgets',
		unit: 'pull-request',
		reference: '92',
		taskId: '92-respond',
		phase: 'respond-to-review',
		runId: 'run-1',
		runStatus: 'completed',
		prNumber: '92',
		prUrl: 'https://github.com/acme/widgets/pull/92',
		prTitle: 'Add the widget',
		lastActivityAt: '2026-08-30T09:00:00.000Z',
		stalledForMs: 10_800_000,
		...overrides,
	};
}

function workItemItem(overrides: Partial<StalledItem> = {}): StalledItem {
	return {
		projectId: 'proj',
		repository: 'acme/widgets',
		unit: 'work-item',
		reference: '85',
		taskId: '85',
		phase: 'implementation',
		runId: 'run-2',
		runStatus: 'completed',
		workItemId: 'PVTI_abc',
		workItemTitle: 'Fix the widget',
		workItemUrl: 'https://github.com/acme/widgets/issues/85',
		lastActivityAt: '2026-08-30T07:00:00.000Z',
		stalledForMs: 18_000_000,
		...overrides,
	};
}

describe('stalledItemKey', () => {
	it('separates units that differ in any identity field', () => {
		const base = pullRequestItem();
		const keys = new Set([
			stalledItemKey(base),
			stalledItemKey(pullRequestItem({ projectId: 'other' })),
			stalledItemKey(pullRequestItem({ repository: 'acme/gadgets' })),
			stalledItemKey(pullRequestItem({ unit: 'work-item' })),
			stalledItemKey(pullRequestItem({ reference: '93' })),
		]);
		expect(keys.size).toBe(5);
	});

	// A PR and a card that happen to share a reference are different units, and a
	// separator a slug or task id could contain would collapse them onto one row.
	it('does not collide when a field boundary shifts', () => {
		const left = pullRequestItem({ repository: 'acme/widgets', reference: '1' });
		const right = pullRequestItem({ repository: 'acme', reference: 'widgets/1' });
		expect(stalledItemKey(left)).not.toBe(stalledItemKey(right));
	});

	// The report re-derives on every poll and the unit's latest run changes as it
	// ages; the key must not, or an unmoved row would remount each time.
	it('is stable while only the reported run changes', () => {
		const before = pullRequestItem({ runId: 'run-1', phase: 'review', taskId: '92' });
		const after = pullRequestItem({ runId: 'run-9', phase: 'respond-to-ci', taskId: '92-ci' });
		expect(stalledItemKey(after)).toBe(stalledItemKey(before));
	});
});

describe('stalledPhaseLabel', () => {
	it('reuses the Queued section vocabulary so one phase has one name', () => {
		for (const phase of [
			'planning',
			'implementation',
			'review',
			'respond-to-review',
			'respond-to-ci',
			'resolve-conflicts',
		] as const) {
			expect(stalledPhaseLabel(phase)).toBe(queuedPhaseLabel(phase));
		}
	});

	// `phase` is a bare string on the read model (whatever the run row recorded),
	// so an unlisted value still has to render as words rather than blank.
	it('falls back to the humanized phase for a value outside that vocabulary', () => {
		expect(stalledPhaseLabel('some-new-phase')).toBe('some new phase');
	});
});

describe('stalledItemRun', () => {
	it('maps a pull-request item onto the shared run description', () => {
		expect(stalledItemRun(pullRequestItem())).toEqual({
			taskId: '92-respond',
			repository: 'acme/widgets',
			phase: 'respond-to-review',
			workItemId: null,
			workItemTitle: null,
			workItemUrl: null,
			prNumber: '92',
			prUrl: 'https://github.com/acme/widgets/pull/92',
			prTitle: 'Add the widget',
		});
	});

	// The server resolved this URL through the project's own SCM provider, so the
	// adapter has to carry it through verbatim — deriving one here is exactly what
	// sends a GitLab or Bitbucket project's operators to github.com.
	it('carries a provider-resolved pull-request URL through unchanged', () => {
		const gitlab = stalledItemRun(
			pullRequestItem({
				repository: 'team/app',
				prNumber: '42',
				prUrl: 'https://gitlab.com/team/app/-/merge_requests/42',
			}),
		);
		expect(gitlab.prUrl).toBe('https://gitlab.com/team/app/-/merge_requests/42');

		const bitbucket = stalledItemRun(
			pullRequestItem({
				repository: 'team/app',
				prNumber: '7',
				prUrl: 'https://bitbucket.org/team/app/pull-requests/7',
			}),
		);
		expect(bitbucket.prUrl).toBe('https://bitbucket.org/team/app/pull-requests/7');
	});

	it('maps a work-item item onto the shared run description', () => {
		expect(stalledItemRun(workItemItem())).toEqual({
			taskId: '85',
			repository: 'acme/widgets',
			phase: 'implementation',
			workItemId: 'PVTI_abc',
			workItemTitle: 'Fix the widget',
			workItemUrl: 'https://github.com/acme/widgets/issues/85',
			prNumber: null,
			prUrl: null,
			prTitle: null,
		});
	});

	// The read model omits an absent field; a run row reports it as null. That is
	// the whole difference, and it has to be closed here rather than at each cell.
	it('reports every omitted field as null', () => {
		const run = stalledItemRun(workItemItem({ workItemUrl: undefined }));
		expect(run.workItemUrl).toBeNull();
		expect(stalledItemRun(pullRequestItem({ prUrl: undefined })).prUrl).toBeNull();
	});
});
