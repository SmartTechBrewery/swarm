import { describe, expect, it } from 'vitest';
import {
	isMissingPmCredentialError,
	isPmRoleEditable,
	missingRequiredPmRoles,
	type PmCredentialEntry,
	type PmCredentialsView,
	pmRoleInheritanceNote,
	pmRoleKeyOriginNote,
	pmRoleStatusLabel,
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

describe('isPmRoleEditable', () => {
	it('allows editing a role the provider owns outright', () => {
		expect(isPmRoleEditable(entry())).toBe(true);
	});

	// A role that inherits a shared SCM credential *is* that credential, so it is
	// configured on the Source Control tab (the API refuses the write too).
	it('refuses a role that inherits a shared SCM credential', () => {
		expect(isPmRoleEditable(entry({ inheritsSharedCredential: 'webhookSecret' }))).toBe(false);
	});
});

describe('pmRoleInheritanceNote', () => {
	// The reported defect (issue #630): the role inherits the shared SCM reference, so
	// it resolves through `GITHUB_WEBHOOK_SECRET` while the provider's declared key is
	// the neutral `SCM_WEBHOOK_SECRET`. The note must name the key that is actually
	// read — never the unread default, and never SWARM's internal role name.
	it('names the key an inherited role resolves through, and where it is configured', () => {
		const note = pmRoleInheritanceNote(
			entry({
				role: 'webhookSecret',
				envVarKey: 'SCM_WEBHOOK_SECRET',
				referenceKey: 'GITHUB_WEBHOOK_SECRET',
				inheritsSharedCredential: 'webhookSecret',
			}),
		);
		expect(note).toContain('GITHUB_WEBHOOK_SECRET');
		expect(note).toContain('Source Control');
		expect(note).not.toContain('SCM_WEBHOOK_SECRET');
	});

	it('is absent for a role of the provider’s own', () => {
		expect(pmRoleInheritanceNote(entry())).toBeUndefined();
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

	// An inherited role's own note already names the resolved key, so this one stays
	// silent rather than putting two key lines on the same card.
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
