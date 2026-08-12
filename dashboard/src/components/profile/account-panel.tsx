import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge.js';
import {
	type InstallationRole,
	installationRoleFor,
	type SwarmUser,
} from '../../../../src/identity/schema.js';

/**
 * Who the viewer is signed in as on this installation (issue #659) — the profile's
 * Account tab, and the first personal read-only surface the dashboard has had.
 *
 * **It is read-only by construction, not by filtering.** Its one source is the
 * `auth.me` read model, which is already the public `SwarmUser` shape (no password
 * hash, no session token), and it renders only the three facts that answer "who am
 * I and what may I do here": the display name, the login identifier, and the
 * installation role. Editing is a separate surface — the Security tab (issue #662)
 * is where a user changes their own display name and password — so nothing here
 * offers a control, and the two facts an operator owns are not editable anywhere.
 *
 * **It shows the signed-in user and nobody else.** The component takes the user it
 * renders rather than fetching one, and its only caller passes the session's own —
 * the `/profile` route has no user-id parameter to address another account with.
 */

const CARD_CLASS = 'border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm';
const SECTION_HEADING_CLASS =
	'text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4';
const LABEL_CLASS = 'block text-xs font-medium text-zinc-400';

/** The fields the Account tab reads — the whole of what it needs from `auth.me`. */
export type AccountUser = Pick<SwarmUser, 'displayName' | 'identifier' | 'instanceAdmin'>;

/**
 * The installation roles in the viewer's own terms. A `Record` over the enum, so
 * a role added to `InstallationRoleSchema` is a compile error here rather than a
 * silently unlabelled badge.
 */
const ROLE_COPY: Record<InstallationRole, { label: string; description: string }> = {
	instanceAdmin: {
		label: 'Instance administrator',
		description:
			'Administers every project, membership, and worker enrollment on this installation.',
	},
	user: {
		label: 'User',
		description: 'Access to each project comes from its membership.',
	},
};

/**
 * One labelled read-only field. Deliberately a local copy of the identity-grid
 * helper in `components/workers/worker-detail.tsx` rather than a shared component:
 * three fields don't justify editing an unrelated screen to extract one.
 */
function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
	return (
		<div>
			<span className={LABEL_CLASS}>{label}</span>
			<div
				className={`mt-1 text-sm text-zinc-200 break-words ${mono ? 'font-mono select-all' : ''}`}
			>
				{children}
			</div>
		</div>
	);
}

export function AccountPanel({ user }: { user: AccountUser }) {
	const role = ROLE_COPY[installationRoleFor(user)];

	return (
		<div className={CARD_CLASS}>
			<h2 className={SECTION_HEADING_CLASS}>Account</h2>
			<p className="text-xs text-zinc-400 mb-4">
				Who you are signed in as on this SWARM installation. Your login identifier and installation
				role are read-only — an operator manages them with the{' '}
				<span className="font-mono">swarm users</span> CLI. Your display name is yours to change, on
				the Security tab.
			</p>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				<Field label="Display name">{user.displayName}</Field>
				<Field label="Login identifier" mono>
					{user.identifier}
				</Field>
				<Field label="Installation role">
					<Badge>{role.label}</Badge>
					<p className="mt-1.5 text-xs text-zinc-400">{role.description}</p>
				</Field>
			</div>
		</div>
	);
}
