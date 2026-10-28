import { PM_MAPPING_PROVIDERS, type PmProviderId } from './board-mapping.js';

/**
 * Settings → Users' **linked identities** (issue #1167): the copy and the pure
 * helpers behind the `users.identities` procedures (`src/api/routers/users.ts`).
 * A link says "this handle on this board provider is this SWARM user", which is
 * what assignee affinity routes on (ADR-001, `src/identity/assignee-resolver.ts`).
 *
 * What a "handle" is differs per provider — each provider's `mapAssignees` puts its
 * own field into `WorkItemAssignee.handle` — so the copy is per provider and keyed
 * on {@link PmProviderId}: a provider without an entry is a compile error. Provider
 * *names* come from the existing catalogue ({@link PM_MAPPING_PROVIDERS}), never a
 * hard-coded GitHub label (ai/RULES.md §2).
 */

/** One row of `users.identities.list` (serialized: no transformer, so dates are strings). */
export interface LinkedIdentity {
	id: string;
	userId: string;
	provider: string;
	handle: string;
	createdAt: string | Date;
}

interface IdentityHandleCopy {
	/** The handle field's label — what the provider calls the value. */
	handleLabel: string;
	/** Where to find it, shown under the field. */
	hint: string;
	placeholder: string;
}

export const IDENTITY_HANDLE_COPY: Readonly<Record<PmProviderId, IdentityHandleCopy>> = {
	'github-projects': {
		handleLabel: 'GitHub login',
		hint: 'The username on their GitHub profile (github.com/<login>), which the board reports as an issue’s assignee.',
		placeholder: 'octocat',
	},
	linear: {
		handleLabel: 'Linear display name',
		hint: 'The short unique name on their Linear profile — not their full name.',
		placeholder: 'ada',
	},
	jira: {
		handleLabel: 'Atlassian accountId',
		hint: 'Not their e-mail or display name. It is the last segment of their profile URL (https://<site>/jira/people/<accountId>), or returned by GET /rest/api/3/user/search?query=<email>.',
		placeholder: '557058:f58131cb-b67d-43c7-b30d-6b58d40bd077',
	},
	trello: {
		handleLabel: 'Trello username',
		hint: 'The member username on their Trello profile (trello.com/u/<username>), without the @.',
		placeholder: 'ada_lovelace',
	},
};

export interface IdentityProviderOption extends IdentityHandleCopy {
	id: PmProviderId;
	label: string;
}

/** The provider picker's options, in the catalogue's order, labelled with each provider's own name. */
export const IDENTITY_PROVIDER_OPTIONS: readonly IdentityProviderOption[] =
	PM_MAPPING_PROVIDERS.map((p) => ({ id: p.id, label: p.label, ...IDENTITY_HANDLE_COPY[p.id] }));

/**
 * A stored link's provider label — the catalogue name, or the raw stored key when
 * the catalogue does not know it (a row the CLI wrote under a legacy key). Not
 * `getPmMappingProvider`, which would fall back to GitHub's label.
 */
export function identityProviderLabel(provider: string): string {
	return PM_MAPPING_PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
}

/** Links grouped by `userId`, keeping the server's order inside each user. */
export function groupIdentitiesByUser(
	identities: readonly LinkedIdentity[],
): Map<string, LinkedIdentity[]> {
	const byUser = new Map<string, LinkedIdentity[]>();
	for (const identity of identities) {
		const existing = byUser.get(identity.userId);
		if (existing) existing.push(identity);
		else byUser.set(identity.userId, [identity]);
	}
	return byUser;
}
