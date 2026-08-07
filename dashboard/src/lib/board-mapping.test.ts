import { describe, expect, it } from 'vitest';
import type { ProjectPm } from '../../../src/config/schema.js';
import {
	blankStatusOptions,
	buildPmUpdate,
	canSaveBoardMapping,
	cleanStatusOptions,
	getPmMappingProvider,
	isBoardMappingDirty,
	STATUS_KEYS,
	toBoardMappingForm,
} from './board-mapping.js';

const fullPm: ProjectPm = {
	type: 'github-projects',
	projectId: 'PVT_kwDODb1Ycc4Bcnwu',
	statusFieldId: 'PVTSSF_lADODb1Ycc4BcnwuzhXPKyM',
	statusOptions: {
		backlog: 'f75ad846',
		planning: '3fe662f4',
		todo: '61e4505c',
		inProgress: '47fc9ee4',
		inReview: 'df73e18b',
		done: '98236657',
	},
};

const linearPm: ProjectPm = {
	type: 'linear',
	teamId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
	statusOptions: { planning: 'f4dd18f6-7943-4a6d-9a0e-4e6cb6e3acb6' },
};

/** Narrow a built payload to one provider's member, failing loudly on a mismatch. */
function asMember<T extends ProjectPm['type']>(
	pm: ProjectPm,
	type: T,
): Extract<ProjectPm, { type: T }> {
	if (pm.type !== type) throw new Error(`expected a '${type}' member, got '${pm.type}'`);
	return pm as Extract<ProjectPm, { type: T }>;
}

describe('toBoardMappingForm', () => {
	it('fills blanks and defaults the provider when config is undefined', () => {
		const form = toBoardMappingForm(undefined);
		expect(form.providerId).toBe('github-projects');
		expect(form.containerId).toBe('');
		expect(form.providerContext).toEqual({});
		for (const key of STATUS_KEYS) {
			expect(form.statusOptions[key]).toBe('');
		}
	});

	it('projects the stored board, field context, and only canonical status keys', () => {
		const form = toBoardMappingForm({
			...fullPm,
			// A board may carry a non-canonical key; it must not leak into the form.
			statusOptions: { ...fullPm.statusOptions, custom: 'zzz' },
		});
		expect(form.containerId).toBe(fullPm.projectId);
		expect(form.providerContext).toEqual({ statusFieldId: fullPm.statusFieldId });
		expect(form.statusOptions.inReview).toBe('df73e18b');
		expect(Object.keys(form.statusOptions).sort()).toEqual([...STATUS_KEYS].sort());
	});

	// The selected provider is the stored member's own discriminator now (issue #495),
	// not a second argument the caller has to keep in sync with the mapping.
	it('takes the provider id from the stored pm member', () => {
		expect(toBoardMappingForm(fullPm).providerId).toBe('github-projects');
	});

	// Issue #531: the Linear member's container is its team, and it carries no
	// provider context — a workflow-state UUID is the whole mapping.
	it('projects a Linear mapping onto the team container with no provider context', () => {
		const form = toBoardMappingForm(linearPm);
		expect(form.providerId).toBe('linear');
		expect(form.containerId).toBe(linearPm.teamId);
		expect(form.providerContext).toEqual({});
		expect(form.statusOptions.planning).toBe(linearPm.statusOptions.planning);
		expect(form.statusOptions.done).toBe('');
		expect(canSaveBoardMapping(form)).toBe(true);
	});

	it('leaves an unmapped canonical key blank and omits absent field context', () => {
		const form = toBoardMappingForm({
			type: 'github-projects',
			projectId: 'PVT_1',
			statusFieldId: '',
			statusOptions: { backlog: 'f75ad846' },
		} as ProjectPm);
		expect(form.statusOptions.backlog).toBe('f75ad846');
		expect(form.statusOptions.done).toBe('');
		expect(form.providerContext).toEqual({});
	});
});

describe('cleanStatusOptions', () => {
	it('drops blank and whitespace-only entries and trims the rest', () => {
		const cleaned = cleanStatusOptions({
			backlog: '  f75ad846  ',
			planning: '',
			todo: '   ',
			inProgress: '47fc9ee4',
			inReview: '',
			done: '',
		});
		expect(cleaned).toEqual({ backlog: 'f75ad846', inProgress: '47fc9ee4' });
	});
});

describe('buildPmUpdate', () => {
	it('serializes the container to projectId and the discovered field context to statusFieldId', () => {
		const payload = buildPmUpdate(
			{
				providerId: 'github-projects',
				containerId: '  PVT_1  ',
				statusOptions: { ...toBoardMappingForm(undefined).statusOptions, planning: ' 3fe662f4 ' },
				providerContext: { statusFieldId: '  PVTSSF_1  ' },
			},
			undefined,
		);
		// The payload is a whole `pm` member — discriminator included.
		const member = asMember(payload, 'github-projects');
		expect(member.projectId).toBe('PVT_1');
		expect(member.statusFieldId).toBe('PVTSSF_1');
		expect(member.statusOptions).toEqual({ planning: '3fe662f4' });
	});

	it('preserves phaseLabels from the existing config', () => {
		const existing: ProjectPm = {
			...fullPm,
			phaseLabels: { 'phase-6': 'phase-6' },
		};
		const payload = asMember(
			buildPmUpdate(toBoardMappingForm(existing), existing),
			'github-projects',
		);
		expect(payload.phaseLabels).toEqual({ 'phase-6': 'phase-6' });
	});

	it('omits phaseLabels when the existing config has none', () => {
		const payload = buildPmUpdate(toBoardMappingForm(fullPm), fullPm);
		expect(payload).not.toHaveProperty('phaseLabels');
	});

	it('round-trips a Linear mapping back to an equal member', () => {
		expect(buildPmUpdate(toBoardMappingForm(linearPm), linearPm)).toEqual(linearPm);
	});

	it('serializes the container to teamId for Linear and carries no field context', () => {
		const payload = asMember(
			buildPmUpdate(
				{
					providerId: 'linear',
					containerId: `  ${linearPm.teamId}  `,
					statusOptions: { ...blankStatusOptions(), inReview: ' state_review ' },
					providerContext: {},
				},
				undefined,
			),
			'linear',
		);
		expect(payload.teamId).toBe(linearPm.teamId);
		expect(payload.statusOptions).toEqual({ inReview: 'state_review' });
		expect(payload).not.toHaveProperty('statusFieldId');
		expect(payload).not.toHaveProperty('projectId');
	});

	// Acceptance criterion of issue #531: neither provider's own keys may cross a
	// provider switch — not from the stored member, not from a stale form context.
	it('never leaks the other provider’s keys across a provider switch', () => {
		const storedGitHub: ProjectPm = { ...fullPm, phaseLabels: { 'phase-6': 'phase-6' } };
		const toLinear = asMember(
			buildPmUpdate(
				{
					providerId: 'linear',
					containerId: linearPm.teamId,
					statusOptions: { ...blankStatusOptions(), planning: 'state_planning' },
					providerContext: { statusFieldId: 'PVTSSF_stale' },
				},
				storedGitHub,
			),
			'linear',
		);
		expect(toLinear).toEqual({
			type: 'linear',
			teamId: linearPm.teamId,
			statusOptions: { planning: 'state_planning' },
		});

		const toGitHub = asMember(
			buildPmUpdate(
				{
					providerId: 'github-projects',
					containerId: 'PVT_1',
					statusOptions: { ...blankStatusOptions(), todo: 'opt_ready' },
					providerContext: { statusFieldId: 'PVTSSF_1' },
				},
				linearPm,
			),
			'github-projects',
		);
		expect(toGitHub).toEqual({
			type: 'github-projects',
			projectId: 'PVT_1',
			statusFieldId: 'PVTSSF_1',
			statusOptions: { todo: 'opt_ready' },
		});
	});

	it('builds the default provider’s member for an unknown provider id', () => {
		const payload = buildPmUpdate({ ...toBoardMappingForm(fullPm), providerId: 'nope' }, fullPm);
		expect(payload.type).toBe('github-projects');
	});
});

describe('isBoardMappingDirty', () => {
	it('is false when the form matches the stored config', () => {
		expect(isBoardMappingDirty(toBoardMappingForm(fullPm), fullPm)).toBe(false);
	});

	it('ignores surrounding whitespace when comparing', () => {
		const form = toBoardMappingForm(fullPm);
		form.containerId = `  ${fullPm.projectId}  `;
		expect(isBoardMappingDirty(form, fullPm)).toBe(false);
	});

	it('is true when an option id changes', () => {
		const form = toBoardMappingForm(fullPm);
		form.statusOptions.done = 'changed';
		expect(isBoardMappingDirty(form, fullPm)).toBe(true);
	});

	it('is true when the discovered Status field context changes', () => {
		const form = toBoardMappingForm(fullPm);
		form.providerContext = { statusFieldId: 'PVTSSF_other' };
		expect(isBoardMappingDirty(form, fullPm)).toBe(true);
	});

	it('is true when a board is selected against an empty config', () => {
		const form = toBoardMappingForm(undefined);
		form.containerId = 'PVT_1';
		expect(isBoardMappingDirty(form, undefined)).toBe(true);
	});

	it('is false when a Linear form matches its stored mapping', () => {
		expect(isBoardMappingDirty(toBoardMappingForm(linearPm), linearPm)).toBe(false);
	});

	it('is true when a Linear team or workflow state changes', () => {
		const team = toBoardMappingForm(linearPm);
		team.containerId = 'other-team';
		expect(isBoardMappingDirty(team, linearPm)).toBe(true);

		const state = toBoardMappingForm(linearPm);
		state.statusOptions.done = 'state_done';
		expect(isBoardMappingDirty(state, linearPm)).toBe(true);
	});

	// Linear returns no `providerContext`, so a stale GitHub field id left on the form
	// must not read as a change against a stored Linear mapping.
	it('ignores the Status field context for a Linear form', () => {
		const form = toBoardMappingForm(linearPm);
		form.providerContext = { statusFieldId: 'PVTSSF_stale' };
		expect(isBoardMappingDirty(form, linearPm)).toBe(false);
	});

	it('is true when the selected provider changes', () => {
		expect(
			isBoardMappingDirty({ ...toBoardMappingForm(fullPm), providerId: 'linear' }, fullPm),
		).toBe(true);
	});
});

describe('canSaveBoardMapping', () => {
	it('requires a board, a Status field context, and at least one mapped status', () => {
		expect(canSaveBoardMapping(toBoardMappingForm(fullPm))).toBe(true);
	});

	it('is false without a selected board', () => {
		const form = toBoardMappingForm(fullPm);
		form.containerId = '';
		expect(canSaveBoardMapping(form)).toBe(false);
	});

	it('is false without a Status field context', () => {
		const form = toBoardMappingForm(fullPm);
		form.providerContext = {};
		expect(canSaveBoardMapping(form)).toBe(false);
	});

	it('is false when no status is mapped', () => {
		const form = toBoardMappingForm(undefined);
		form.containerId = 'PVT_1';
		form.providerContext = { statusFieldId: 'PVTSSF_1' };
		expect(canSaveBoardMapping(form)).toBe(false);
	});

	// The Status field id is GitHub Projects' own scope; Linear's state UUIDs need none.
	it('requires only a team and one workflow state for Linear', () => {
		const form = toBoardMappingForm(linearPm);
		expect(form.providerContext).toEqual({});
		expect(canSaveBoardMapping(form)).toBe(true);
	});

	it('is false for a Linear form without a team', () => {
		const form = toBoardMappingForm(linearPm);
		form.containerId = '';
		expect(canSaveBoardMapping(form)).toBe(false);
	});

	it('is false for a Linear form with no workflow state mapped', () => {
		const form = toBoardMappingForm(linearPm);
		form.statusOptions = blankStatusOptions();
		expect(canSaveBoardMapping(form)).toBe(false);
	});
});

describe('getPmMappingProvider', () => {
	it('returns the matching provider and falls back to the default for an unknown id', () => {
		expect(getPmMappingProvider('github-projects').label).toBe('GitHub Projects');
		expect(getPmMappingProvider('linear')).toMatchObject({
			label: 'Linear',
			containerNoun: 'team',
			stateNoun: 'workflow state',
			stateNounPlural: 'workflow states',
		});
		expect(getPmMappingProvider('nope').id).toBe('github-projects');
	});
});
