import { describe, expect, it } from 'vitest';

import { resolveStatusKeyByOptionId } from '@/integrations/pm/github-projects/status-mapping.js';
import { resolvePipelinePhaseForStatusKey } from '@/pm/pipeline.js';
import { createMockGitHubProjectsConfig } from '../../../../helpers/factories.js';

// The default factory config already maps the canonical pipeline status keys to
// the real board's Status option IDs (ai/RULES.md §5). Using it directly here —
// rather than a hand-written override — means a regression in the factory's
// key→optionId mapping (e.g. the old `ready`-for-Planning mislabel) is caught by
// these resolution assertions, not silently tolerated.
const config = createMockGitHubProjectsConfig();

describe('resolveStatusKeyByOptionId', () => {
	it('inverts the statusOptions map (option ID → status key)', () => {
		expect(resolveStatusKeyByOptionId(config, '47fc9ee4')).toBe('inProgress');
		expect(resolveStatusKeyByOptionId(config, '61e4505c')).toBe('planning');
	});

	it('returns undefined for an option ID not on the board', () => {
		expect(resolveStatusKeyByOptionId(config, 'deadbeef')).toBeUndefined();
	});
});

// The board option → pipeline phase resolution shared code performs, in the two
// steps it is actually split into since issue #297: the provider inverts its board
// mapping to a canonical key (above) and the neutral `src/pm/pipeline.ts` resolves
// the phase from that key. Asserting the composition keeps the end-to-end guarantee
// the single-function version gave, without an option-id→phase shortcut existing.
describe('board option → pipeline phase, through the canonical key', () => {
	function phaseForOption(optionId: string) {
		const statusKey = resolveStatusKeyByOptionId(config, optionId);
		return statusKey === undefined ? undefined : resolvePipelinePhaseForStatusKey(statusKey);
	}

	it('resolves the Planning option to the planning phase', () => {
		expect(phaseForOption('61e4505c')).toBe('planning');
	});

	it('resolves the ToDo option to the implementation phase', () => {
		expect(phaseForOption('3121a97d')).toBe('implementation');
	});

	it.each([
		['Backlog', 'f75ad846'],
		['In progress', '47fc9ee4'],
		['In review', 'df73e18b'],
		['Done', '98236657'],
	])('does not trigger a phase for the %s option', (_name, optionId) => {
		expect(phaseForOption(optionId)).toBeUndefined();
	});

	it('returns undefined for an unmapped option ID', () => {
		expect(phaseForOption('deadbeef')).toBeUndefined();
	});
});
