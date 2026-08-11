import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { canViewInstanceWide } from '@/lib/instance-admin.js';
import { useCurrentUser } from '@/lib/use-current-user.js';

/**
 * The route-level gate on SWARM's two installation-wide screens — the global
 * `/runs` and `/workers` views (issue #647). It is a **wrapper**, not an early
 * return inside each screen, for two reasons: the guarded screen never mounts
 * when access is denied (so none of its cross-project queries is ever issued,
 * and a denial can't render as a wall of `FORBIDDEN` panels), and the screen
 * components keep their own hook order untouched.
 *
 * Being the route's component is also what makes the boundary consistent: a
 * typed URL, a deep link carrying search params, and an in-app link all resolve
 * to this same frame. The server still enforces the rule independently
 * (`assertInstanceAdmin`, `src/api/authz.ts`) — this only stops the dashboard
 * from asking.
 *
 * `view` names the screen in the copy ("runs", "workers").
 */
export function InstanceAdminOnly({ view, children }: { view: string; children: ReactNode }) {
	const { data: user } = useCurrentUser();

	// The authenticated shell (`routes/__root.tsx`) already blocks on an unresolved
	// session, so this frame is only reachable transiently; render nothing rather
	// than flashing a denial at a user whose role we don't know yet.
	if (!user) return null;

	if (!canViewInstanceWide(user)) {
		return (
			<div className="border border-zinc-800 rounded-lg bg-panel/20 p-8 text-center space-y-2">
				<ShieldAlert className="w-12 h-12 stroke-1 text-zinc-700 mx-auto" />
				<p className="text-sm text-zinc-400">
					This page is available to instance administrators only.
				</p>
				<p className="text-xs text-zinc-500">
					The installation-wide {view} view spans every project on this instance. Open a project you
					are enrolled in to see its {view}.
				</p>
			</div>
		);
	}

	return <>{children}</>;
}
