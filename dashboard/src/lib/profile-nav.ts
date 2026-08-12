import { z } from 'zod';

/**
 * The tabs on the user-profile screen, in display order — the profile's whole
 * user-facing navigation structure (issue #659), not only the part built today.
<<<<<<< HEAD
 * `workers` (issue #660), `projects` (issue #661), and `security` (issue #662) have all arrived.
 */
export const PROFILE_TABS = ['account', 'workers', 'projects', 'security'] as const;

export type ProfileTab = (typeof PROFILE_TABS)[number];

/**
 * The declared tabs that actually have content behind them. A declared-but-
 * undelivered tab is neither rendered nor resolvable, so a bookmarked
 * `?tab=projects` lands on Account instead of an empty screen — the same
 * degrade-don't-throw rule `project-nav.ts` applies to an unknown tab value.
 */
export const AVAILABLE_PROFILE_TABS: ReadonlySet<ProfileTab> = new Set<ProfileTab>([
	'account',
	'workers',
	'projects',
	'security',
]);

/** Whether a declared tab has a panel to render yet. */
export function isProfileTabAvailable(tab: ProfileTab): boolean {
	return AVAILABLE_PROFILE_TABS.has(tab);
}

/**
 * Search-param schema for `/profile`. The active tab lives in the URL — not
 * component state — so switching tabs is a real browser-history entry and a
 * direct/reload link lands on the right panel (mirrors `settings-nav.ts`'s
 * `settingsSearchSchema`). `.catch(undefined)` degrades a stale or hand-edited
 * unknown tab to the default rather than throwing.
 *
 * The profile names no user: it is always the signed-in one, resolved from the
 * session by `auth.me`, and this schema strips every param it doesn't declare —
 * so a hand-added `?userId=` addresses nothing and no other user's account data
 * is reachable through a link.
 */
export const profileSearchSchema = z.object({
	tab: z.enum(PROFILE_TABS).optional().catch(undefined),
});

export type ProfileSearch = z.infer<typeof profileSearchSchema>;

/**
 * The tab to render for a given search state — Account is the default, and also
 * the fallback for a tab that is declared but not yet delivered.
 */
export function resolveActiveProfileTab(search: ProfileSearch): ProfileTab {
	return search.tab && isProfileTabAvailable(search.tab) ? search.tab : 'account';
}

/** Search state for switching to a tab. */
export function profileTabSearch(tab: ProfileTab): ProfileSearch {
	return { tab };
}
