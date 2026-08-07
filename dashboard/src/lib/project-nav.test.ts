import { describe, expect, it } from 'vitest';
import {
	agentConfigSearch,
	PROJECT_TABS,
	phaseDetailSearch,
	projectDetailSearchSchema,
	resolveActiveTab,
	tabSearch,
} from './project-nav.js';

describe('PROJECT_TABS', () => {
	// Issue #574: the Workers tab is the project-scoped worker roster and belongs
	// directly after Runs, ahead of the configuration tabs.
	it('lists the tabs in display order with Workers directly after Runs', () => {
		expect([...PROJECT_TABS]).toEqual([
			'runs',
			'workers',
			'general',
			'agents',
			'pipeline',
			'projectManagement',
			'credentials',
		]);
	});
});

describe('projectDetailSearchSchema', () => {
	it('parses a valid tab and phase (a phase-details link)', () => {
		expect(projectDetailSearchSchema.parse({ tab: 'agents', phase: 'review' })).toEqual({
			tab: 'agents',
			phase: 'review',
		});
	});

	it('yields no tab/phase for a bare project link', () => {
		expect(projectDetailSearchSchema.parse({})).toEqual({ tab: undefined, phase: undefined });
	});

	it('falls back to undefined rather than throwing on an unknown tab or phase', () => {
		// A stale or hand-edited deep link must stay usable with a sensible fallback,
		// not error the route (issue #210).
		expect(projectDetailSearchSchema.parse({ tab: 'nope', phase: 'bogus' })).toEqual({
			tab: undefined,
			phase: undefined,
		});
	});

	// Issue #537 renamed the `boardMapping` tab to `projectManagement`. A bookmarked
	// link must land on the tab that replaced it, not degrade to Runs.
	it('maps the legacy boardMapping tab onto Project Management', () => {
		expect(projectDetailSearchSchema.parse({ tab: 'boardMapping' })).toEqual({
			tab: 'projectManagement',
			phase: undefined,
		});
	});

	it('round-trips the Workers tab (issue #574)', () => {
		expect(projectDetailSearchSchema.parse({ tab: 'workers' })).toEqual({
			tab: 'workers',
			phase: undefined,
		});
	});

	it('strips unknown params', () => {
		expect(projectDetailSearchSchema.parse({ tab: 'pipeline', extra: 'x' })).toEqual({
			tab: 'pipeline',
			phase: undefined,
		});
	});
});

describe('resolveActiveTab', () => {
	it('defaults to the Runs tab for an empty search', () => {
		expect(resolveActiveTab({})).toBe('runs');
	});

	it('honors an explicit tab', () => {
		expect(resolveActiveTab({ tab: 'pipeline' })).toBe('pipeline');
		expect(resolveActiveTab({ tab: 'workers' })).toBe('workers');
	});

	it('resolves a phase-details deep link without a tab to the Agent Configuration tab', () => {
		// So a direct link/reload of `?phase=review` still renders the detail view.
		expect(resolveActiveTab({ phase: 'review' })).toBe('agents');
	});
});

describe('navigation targets', () => {
	it('nests a phase detail under the Agent Configuration summary', () => {
		// The phase-detail search shares the summary's `tab`, so a browser Back from
		// the detail lands on the summary rather than the previous page (issue #210).
		expect(phaseDetailSearch('review')).toEqual({ tab: 'agents', phase: 'review' });
		expect(phaseDetailSearch('review').tab).toBe(agentConfigSearch().tab);
	});

	it('points the Agent Configuration summary at the agents tab with no phase', () => {
		expect(agentConfigSearch()).toEqual({ tab: 'agents' });
		expect(agentConfigSearch().phase).toBeUndefined();
	});

	it('drops any open phase detail when switching tabs', () => {
		expect(tabSearch('runs')).toEqual({ tab: 'runs' });
		expect(tabSearch('runs').phase).toBeUndefined();
	});
});
