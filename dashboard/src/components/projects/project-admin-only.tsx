import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { isProjectAdminTab, type ProjectTab } from '@/lib/project-nav.js';

/**
 * The gate on the project-detail screen's configuration tabs (issue #655) — the
 * project-scoped twin of `InstanceAdminOnly` (`../layout/instance-admin-only.tsx`),
 * and it makes the same two guarantees. It is a **wrapper**, not an early return
 * inside each panel, so a denied tab's panels never mount: none of their
 * `projectAdmin`-gated queries (a credential list, a PM provider list, board
 * discovery) is ever issued, and a denial cannot render as a wall of `FORBIDDEN`
 * cards. And because the whole configuration half of the screen renders through
 * this one frame, a typed URL, a bookmarked `?tab=` deep link, and an in-app tab
 * click all resolve to it — the tab bar hiding the tab is then a courtesy rather
 * than the boundary.
 *
 * `tab` is the tab the route resolved, so the gate applies only to the ones that
 * are actually the administrator's: Runs and Workers pass straight through, which
 * keeps the operational views an enrolled non-administrator relies on untouched.
 *
 * The server remains the enforcement point — `projects.update`, the credential
 * procedures, and the `pm` router each re-check `projectAdmin` for themselves
 * (`src/api/authz.ts`) — so this only stops the dashboard from offering a screen
 * the caller would be refused.
 */
export function ProjectAdminOnly({
	tab,
	canAdminister,
	children,
}: {
	tab: ProjectTab;
	canAdminister: boolean;
	children: ReactNode;
}) {
	if (canAdminister || !isProjectAdminTab(tab)) return <>{children}</>;

	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/20 p-8 text-center space-y-2">
			<ShieldAlert className="w-12 h-12 stroke-1 text-zinc-700 mx-auto" />
			<p className="text-sm text-zinc-400">
				This tab is available to this project's administrators only.
			</p>
			<p className="text-xs text-zinc-500">
				Project settings, agent and pipeline configuration, board mapping, and credentials are
				administered by the project's administrators. The Runs and Workers tabs show what this
				project is doing.
			</p>
		</div>
	);
}
