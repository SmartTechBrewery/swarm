import { describe, expect, it } from 'vitest';
import type { ProjectPm } from '../../../src/config/schema.js';
// The provider's own schema — the `jira` member of `ProjectPmSchema` — imported
// directly rather than through that union: it is the half this form has to satisfy,
// and it is a leaf module (Zod only), unlike the whole config schema.
import { jiraConfigSchema } from '../../../src/integrations/pm/jira/config-schema.js';
import {
	blankStatusOptions,
	buildPmUpdate,
	canSaveBoardMapping,
	cleanStatusOptions,
	getPmMappingProvider,
	isBaseUrlMissing,
	isBoardMappingDirty,
	STATUS_KEYS,
	toBoardMappingForm,
	withSelectedContainer,
	withSelectedProvider,
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

const jiraPm: ProjectPm = {
	type: 'jira',
	baseUrl: 'https://acme.atlassian.net',
	projectKey: 'SWARM',
	statusOptions: { todo: '10001', done: '10002' },
};

/** Narrow a built payload to one provider's member, failing loudly on a mismatch. */
function asMember<T extends ProjectPm['type']>(
	pm: ProjectPm,
	type: T,
): Extract<ProjectPm, { type: T }> {
	if (pm.type !== type) throw new Error(`expected a '${type}' member, got '${pm.type}'`);
	return pm as Extract<ProjectPm, { type: T }>;
}

/** Strip the union discriminator, leaving the provider's own (strict) config shape. */
function withoutDiscriminator(pm: ProjectPm): Record<string, unknown> {
	const { type: _type, ...config } = pm;
	return config;
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

	// Issue #581: Jira's container is its project *key*, and the site base URL — board
	// identity this screen never edits — rides along in the opaque provider context.
	it('projects a Jira mapping onto the project key and carries its base URL', () => {
		const form = toBoardMappingForm(jiraPm);
		expect(form.providerId).toBe('jira');
		expect(form.containerId).toBe('SWARM');
		expect(form.providerContext).toEqual({ baseUrl: 'https://acme.atlassian.net' });
		expect(form.statusOptions.todo).toBe('10001');
		expect(form.statusOptions.planning).toBe('');
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

	it('round-trips a Jira mapping into a member the config schema accepts', () => {
		const payload = buildPmUpdate(toBoardMappingForm(jiraPm), jiraPm);
		// The stored base URL survives the save unchanged, and the member is one
		// `jiraConfigSchema` actually parses — never a silent write it then rejects.
		expect(payload).toEqual(jiraPm);
		expect(jiraConfigSchema.safeParse(withoutDiscriminator(payload)).success).toBe(true);
	});

	it('serializes the container to projectKey and the carried base URL for Jira', () => {
		const payload = asMember(
			buildPmUpdate(
				{
					providerId: 'jira',
					containerId: '  SWARM  ',
					statusOptions: { ...blankStatusOptions(), inProgress: ' 10003 ' },
					providerContext: { baseUrl: '  https://acme.atlassian.net  ' },
				},
				undefined,
			),
			'jira',
		);
		expect(payload).toEqual({
			type: 'jira',
			baseUrl: 'https://acme.atlassian.net',
			projectKey: 'SWARM',
			statusOptions: { inProgress: '10003' },
		});
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

	// Same rule for the third provider: a stale Jira base URL must not land on a GitHub
	// member, and a GitHub field id must not land on a Jira one.
	it('never leaks Jira’s base URL or another provider’s context across a switch', () => {
		const toGitHub = asMember(
			buildPmUpdate(
				{
					providerId: 'github-projects',
					containerId: 'PVT_1',
					statusOptions: { ...blankStatusOptions(), todo: 'opt_ready' },
					providerContext: { statusFieldId: 'PVTSSF_1', baseUrl: 'https://acme.atlassian.net' },
				},
				jiraPm,
			),
			'github-projects',
		);
		expect(toGitHub).toEqual({
			type: 'github-projects',
			projectId: 'PVT_1',
			statusFieldId: 'PVTSSF_1',
			statusOptions: { todo: 'opt_ready' },
		});

		const toJira = asMember(
			buildPmUpdate(
				{
					providerId: 'jira',
					containerId: 'SWARM',
					statusOptions: { ...blankStatusOptions(), todo: '10001' },
					providerContext: { statusFieldId: 'PVTSSF_stale' },
				},
				fullPm,
			),
			'jira',
		);
		// No base URL survives from a GitHub member, so the payload the gate refuses to
		// send carries a blank one rather than another provider's value.
		expect(toJira).toEqual({
			type: 'jira',
			baseUrl: '',
			projectKey: 'SWARM',
			statusOptions: { todo: '10001' },
		});
		expect(jiraConfigSchema.safeParse(withoutDiscriminator(toJira)).success).toBe(false);
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

	it('is false when a Jira form matches its stored mapping', () => {
		expect(isBoardMappingDirty(toBoardMappingForm(jiraPm), jiraPm)).toBe(false);
	});

	it('is true when a Jira project key or workflow status changes', () => {
		const project = toBoardMappingForm(jiraPm);
		project.containerId = 'OTHER';
		expect(isBoardMappingDirty(project, jiraPm)).toBe(true);

		const status = toBoardMappingForm(jiraPm);
		status.statusOptions.inReview = '10004';
		expect(isBoardMappingDirty(status, jiraPm)).toBe(true);
	});

	// Jira returns no Status field context, so a stale GitHub field id left on the form
	// must not read as a change against a stored Jira mapping.
	it('ignores the Status field context for a Jira form', () => {
		const form = toBoardMappingForm(jiraPm);
		form.providerContext = { ...form.providerContext, statusFieldId: 'PVTSSF_stale' };
		expect(isBoardMappingDirty(form, jiraPm)).toBe(false);
	});

	it('is true when a Jira form loses the stored base URL', () => {
		const form = toBoardMappingForm(jiraPm);
		form.providerContext = {};
		expect(isBoardMappingDirty(form, jiraPm)).toBe(true);
	});
});

describe('withSelectedProvider', () => {
	it('clears provider-scoped values so they cannot cross a provider switch', () => {
		const switched = withSelectedProvider(toBoardMappingForm(fullPm), 'linear');
		expect(switched).toEqual({
			providerId: 'linear',
			containerId: '',
			statusOptions: blankStatusOptions(),
			providerContext: {},
		});
	});

	// The base URL comes from the stored Jira member, so leaving Jira and coming back
	// leaves nothing to save with — exactly what the save gate must refuse.
	it('drops Jira’s base URL on a switch away and back, blocking save', () => {
		const back = withSelectedProvider(
			withSelectedProvider(toBoardMappingForm(jiraPm), 'linear'),
			'jira',
		);
		expect(back.providerContext).toEqual({});
		back.containerId = 'SWARM';
		back.statusOptions.todo = '10001';
		expect(isBaseUrlMissing(back)).toBe(true);
		expect(canSaveBoardMapping(back)).toBe(false);
	});
});

describe('withSelectedContainer', () => {
	it('clears the previous board’s states and field context', () => {
		const switched = withSelectedContainer(toBoardMappingForm(fullPm), 'PVT_other');
		expect(switched).toEqual({
			providerId: 'github-projects',
			containerId: 'PVT_other',
			statusOptions: blankStatusOptions(),
			providerContext: {},
		});
	});

	// The site URL is not a property of the selected project, and nothing re-seeds it
	// (Jira's state discovery returns no context), so it has to survive the switch.
	it('keeps Jira’s base URL when another project is selected', () => {
		const switched = withSelectedContainer(toBoardMappingForm(jiraPm), 'OTHER');
		expect(switched.containerId).toBe('OTHER');
		expect(switched.statusOptions).toEqual(blankStatusOptions());
		expect(switched.providerContext).toEqual({ baseUrl: 'https://acme.atlassian.net' });
	});

	it('returns the same form when the container is unchanged', () => {
		const form = toBoardMappingForm(jiraPm);
		expect(withSelectedContainer(form, 'SWARM')).toBe(form);
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

	// Issue #581: Jira's own required context is the site base URL, and it is not a
	// Status field id — a Jira mapping is gated on one and not the other.
	it('requires a project, a base URL, and one mapped status for Jira', () => {
		const form = toBoardMappingForm(jiraPm);
		expect(isBaseUrlMissing(form)).toBe(false);
		expect(canSaveBoardMapping(form)).toBe(true);

		const noProject = toBoardMappingForm(jiraPm);
		noProject.containerId = '';
		expect(canSaveBoardMapping(noProject)).toBe(false);

		const noStatus = toBoardMappingForm(jiraPm);
		noStatus.statusOptions = blankStatusOptions();
		expect(canSaveBoardMapping(noStatus)).toBe(false);
	});

	it('is false for a Jira form with no stored base URL', () => {
		const form = toBoardMappingForm(jiraPm);
		form.providerContext = { baseUrl: '   ' };
		expect(isBaseUrlMissing(form)).toBe(true);
		expect(canSaveBoardMapping(form)).toBe(false);
	});

	it('never reports a missing base URL for a provider that has none', () => {
		expect(isBaseUrlMissing(toBoardMappingForm(fullPm))).toBe(false);
		expect(isBaseUrlMissing(toBoardMappingForm(linearPm))).toBe(false);
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
		expect(getPmMappingProvider('jira')).toMatchObject({
			label: 'Jira',
			containerNoun: 'project',
			containerNounPlural: 'projects',
			stateNoun: 'status',
			stateNounPlural: 'statuses',
		});
		expect(getPmMappingProvider('nope').id).toBe('github-projects');
	});
});
