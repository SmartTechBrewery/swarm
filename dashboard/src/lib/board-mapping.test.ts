import { describe, expect, it } from 'vitest';
import type { ProjectPm } from '../../../src/config/schema.js';
import {
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

	it('keeps a Linear mapping inert until its board form is available', () => {
		const form = toBoardMappingForm(linearPm);
		expect(form.providerId).toBe('linear');
		expect(form.containerId).toBe('');
		expect(form.providerContext).toEqual({});
		expect(form.statusOptions.planning).toBe(linearPm.statusOptions.planning);
		expect(canSaveBoardMapping(form)).toBe(false);
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
		expect(payload.type).toBe('github-projects');
		expect(payload.projectId).toBe('PVT_1');
		expect(payload.statusFieldId).toBe('PVTSSF_1');
		expect(payload.statusOptions).toEqual({ planning: '3fe662f4' });
	});

	it('preserves phaseLabels from the existing config', () => {
		const existing: ProjectPm = {
			...fullPm,
			phaseLabels: { 'phase-6': 'phase-6' },
		};
		const payload = buildPmUpdate(toBoardMappingForm(existing), existing);
		expect(payload.phaseLabels).toEqual({ 'phase-6': 'phase-6' });
	});

	it('omits phaseLabels when the existing config has none', () => {
		const payload = buildPmUpdate(toBoardMappingForm(fullPm), fullPm);
		expect(payload).not.toHaveProperty('phaseLabels');
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
});

describe('getPmMappingProvider', () => {
	it('returns the matching provider and falls back to the default for an unknown id', () => {
		expect(getPmMappingProvider('github-projects').label).toBe('GitHub Projects');
		expect(getPmMappingProvider('linear')).toMatchObject({
			label: 'Linear',
			containerNoun: 'team',
			stateNoun: 'workflow state',
		});
		expect(getPmMappingProvider('nope').id).toBe('github-projects');
	});
});
