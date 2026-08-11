import { createRoute, useNavigate } from '@tanstack/react-router';
import { FolderGit2, type LucideIcon, Server, ShieldCheck, UserRound } from 'lucide-react';
import { AccountPanel } from '@/components/profile/account-panel.js';
import { MyProjectsPanel } from '@/components/profile/my-projects-panel.js';
import { MyWorkersPanel } from '@/components/profile/my-workers-panel.js';
import {
	isProfileTabAvailable,
	type ProfileTab,
	profileSearchSchema,
	profileTabSearch,
	resolveActiveProfileTab,
} from '@/lib/profile-nav.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import { rootRoute } from './__root.js';

/**
 * The signed-in user's own profile (issue #659) — reached from their name in the
 * sidebar, which was previously a label and is now the way in. It uses the same
 * horizontal tab pattern as the project and settings screens, so a personal
 * screen navigates like every other multi-panel screen in the dashboard.
 *
 * **It is the viewer's own account, structurally.** The route takes no user id:
 * the user it renders comes from `auth.me`, resolved server-side from the session
 * cookie, so there is no parameter through which another user's account could be
 * requested and a direct link resolves only to a tab. An admin-facing view of
 * *another* user is deliberately not this screen.
 *
 * Only tabs with a panel behind them are rendered ({@link ProfileTabBar} filters
 * on `isProfileTabAvailable`), and a deep link to a declared-but-undelivered one
 * degrades to Account — so the navigation structure is stated once in
 * `lib/profile-nav.ts` while each follow-up ships its own tab. **Account**, **My
 * Workers** (issue #660), and **My Projects** (issue #661) are delivered; Security
 * is not yet.
 *
 * Each panel fetches its own data — nothing about the signed-in user is threaded
 * into one as a prop, so no panel can be handed an identity the session doesn't
 * already establish server-side.
 */

/**
 * The profile tabs in display order, each with the icon and label it renders.
 * Ordered to match `PROFILE_TABS` (`lib/profile-nav.ts`), which is the URL
 * vocabulary — a test asserts the two agree, so the rendered order and the
 * `?tab=` values can't drift apart.
 */
export const PROFILE_TAB_ITEMS: ReadonlyArray<{
	tab: ProfileTab;
	label: string;
	icon: LucideIcon;
}> = [
	{ tab: 'account', label: 'Account', icon: UserRound },
	{ tab: 'workers', label: 'My Workers', icon: Server },
	{ tab: 'projects', label: 'My Projects', icon: FolderGit2 },
	{ tab: 'security', label: 'Security', icon: ShieldCheck },
];

/** The horizontal tab bar, rendered from the available {@link PROFILE_TAB_ITEMS}. */
export function ProfileTabBar({
	activeTab,
	onSelect,
}: {
	activeTab: ProfileTab;
	onSelect: (tab: ProfileTab) => void;
}) {
	return (
		<div className="flex border-b border-zinc-800">
			{PROFILE_TAB_ITEMS.filter(({ tab }) => isProfileTabAvailable(tab)).map(
				({ tab, label, icon: Icon }) => (
					<button
						key={tab}
						type="button"
						onClick={() => onSelect(tab)}
						className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all border-b-2 ${
							activeTab === tab
								? 'border-violet-500 text-zinc-100 bg-zinc-800/20'
								: 'border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
						}`}
					>
						<Icon className="h-4 w-4 text-violet-400" />
						{label}
					</button>
				),
			)}
		</div>
	);
}

function ProfileRouteComponent() {
	const search = profileRoute.useSearch();
	const navigate = useNavigate();
	const activeTab = resolveActiveProfileTab(search);
	// The tab lives in the URL, so each switch is a real browser-history entry and
	// a reload lands on the same panel (the rule `lib/profile-nav.ts` documents).
	const goToTab = (tab: ProfileTab) => {
		navigate({ to: '/profile', search: profileTabSearch(tab) });
	};

	// `AuthenticatedShell` already blocks rendering until `auth.me` resolves, so
	// this is normally a cache read; the two states are still handled rather than
	// assumed, the same way every other route handles its own query.
	const currentUser = useCurrentUser();

	if (currentUser.isError) {
		return (
			<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex flex-col gap-2">
				<h3 className="text-sm font-semibold text-red-200">Error Loading Profile</h3>
				<p className="text-xs text-red-400/80 font-mono">{currentUser.error.message}</p>
			</div>
		);
	}

	if (!currentUser.data) {
		return <div className="text-sm text-zinc-400">Loading profile…</div>;
	}

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Profile</h1>
				<p className="text-xs text-zinc-500 mt-1">Your SWARM account on this installation.</p>
			</div>

			<ProfileTabBar activeTab={activeTab} onSelect={goToTab} />

			{activeTab === 'account' && <AccountPanel user={currentUser.data} />}
			{activeTab === 'workers' && <MyWorkersPanel />}
			{activeTab === 'projects' && <MyProjectsPanel />}
		</div>
	);
}

export const profileRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/profile',
	validateSearch: (search) => profileSearchSchema.parse(search),
	component: ProfileRouteComponent,
});
