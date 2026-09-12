import { describe, expect, it } from 'vitest';
import {
	isMissingPmCredentialError,
	missingRequiredPmRoles,
	type PmCredentialEntry,
	type PmCredentialsView,
	pmRoleKeyOriginNote,
	pmRoleStatusLabel,
	visiblePmRoles,
} from './pm-credentials.js';

function entry(overrides: Partial<PmCredentialEntry> = {}): PmCredentialEntry {
	return {
		role: 'apiToken',
		label: 'GitHub Projects API Token',
		envVarKey: 'PM_GITHUB_PROJECTS_TOKEN',
		referenceKey: 'PM_GITHUB_PROJECTS_TOKEN',
		optional: false,
		isConfigured: false,
		maskedValue: 'not set',
		...overrides,
	};
}

function view(roles: PmCredentialEntry[]): PmCredentialsView {
	return {
		providerId: 'github-projects',
		providerLabel: 'GitHub Projects',
		providerRegistered: true,
		roles,
	};
}

describe('visiblePmRoles', () => {
	it('keeps the roles a provider owns outright, in declaration order', () => {
		const roles = [entry(), entry({ role: 'secondThing' })];
		expect(visiblePmRoles(view(roles)).map((role) => role.role)).toEqual([
			'apiToken',
			'secondThing',
		]);
	});

	// Issue #902: a role that inherits a shared SCM credential *is* that credential, so
	// it is configured — and inspected — on the Source Control tab alone. The rule is
	// keyed on the flag, never on the `webhookSecret` role name, so a future inheriting
	// role drops out the same way.
	it('drops a role declaring inheritsSharedCredential, whatever it is named', () => {
		const roles = [
			entry(),
			entry({ role: 'webhookSecret', inheritsSharedCredential: 'webhookSecret' }),
			entry({ role: 'sharedThing', inheritsSharedCredential: 'reviewer' }),
		];
		expect(visiblePmRoles(view(roles)).map((role) => role.role)).toEqual(['apiToken']);
	});

	it('renders nothing while the view is still loading', () => {
		expect(visiblePmRoles(undefined)).toEqual([]);
	});
});

describe('pmRoleKeyOriginNote', () => {
	// The common case: the project resolves the role through the provider's own default,
	// so there is nothing to explain and the card stays noise-free.
	it('is absent when the resolved key is the provider’s declared default', () => {
		expect(pmRoleKeyOriginNote(entry())).toBeUndefined();
	});

	it('names both keys when a project configured a reference of its own', () => {
		const note = pmRoleKeyOriginNote(entry({ referenceKey: 'GH_PROJECTS_PAT' }));
		expect(note).toContain('GH_PROJECTS_PAT');
		expect(note).toContain('PM_GITHUB_PROJECTS_TOKEN');
	});

	// An inherited role is not rendered on this tab at all (issue #902), so the helper
	// stays silent rather than describing a credential that is the Source Control tab's.
	it('is absent for an inherited role even when the keys diverge', () => {
		expect(
			pmRoleKeyOriginNote(
				entry({
					envVarKey: 'SCM_WEBHOOK_SECRET',
					referenceKey: 'GITHUB_WEBHOOK_SECRET',
					inheritsSharedCredential: 'webhookSecret',
				}),
			),
		).toBeUndefined();
	});
});

describe('pmRoleStatusLabel', () => {
	it('distinguishes configured, required, and optional-unset', () => {
		expect(pmRoleStatusLabel(entry({ isConfigured: true }))).toBe('Configured');
		expect(pmRoleStatusLabel(entry())).toBe('Required');
		expect(pmRoleStatusLabel(entry({ optional: true }))).toBe('Not set (optional)');
	});
});

describe('missingRequiredPmRoles', () => {
	it('reports a required role with nothing configured', () => {
		expect(missingRequiredPmRoles(view([entry()])).map((role) => role.role)).toEqual(['apiToken']);
	});

	it('ignores configured, optional, and inherited roles', () => {
		const roles = [
			entry({ isConfigured: true }),
			entry({ role: 'optionalThing', optional: true }),
			entry({ role: 'webhookSecret', inheritsSharedCredential: 'webhookSecret' }),
		];
		expect(missingRequiredPmRoles(view(roles))).toEqual([]);
	});

	it('reports nothing while the view is still loading', () => {
		expect(missingRequiredPmRoles(undefined)).toEqual([]);
	});
});

describe('isMissingPmCredentialError', () => {
	// Keyed on the tRPC error code the API assigns the condition, never on wording.
	it('recognizes the PRECONDITION_FAILED discovery failure', () => {
		expect(isMissingPmCredentialError({ data: { code: 'PRECONDITION_FAILED' } })).toBe(true);
	});

	it('does not treat another provider failure as a credential gap', () => {
		expect(isMissingPmCredentialError({ data: { code: 'BAD_REQUEST' } })).toBe(false);
		expect(isMissingPmCredentialError(new Error('No API token configured'))).toBe(false);
		expect(isMissingPmCredentialError(null)).toBe(false);
		expect(isMissingPmCredentialError(undefined)).toBe(false);
	});
});
