import { z } from 'zod';
import { mayUseAgentAccessTokens } from '../../../src/identity/agent-access-token.js';
import type { SwarmUser } from '../../../src/identity/schema.js';

/**
 * The tabs on the user-profile screen, in display order — the profile's whole
 * user-facing navigation structure (issue #659), not only the part built today.
 * `workers` (issue #660), `projects` (issue #661), `security` (issue #662) and
 * `mcp` (issue #1362) have all arrived.
 */
export const PROFILE_TABS = ['account', 'workers', 'projects', 'security', 'mcp'] as const;

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
	'mcp',
]);

/** Whether a declared tab has a panel to render yet. */
export function isProfileTabAvailable(tab: ProfileTab): boolean {
	return AVAILABLE_PROFILE_TABS.has(tab);
}

/** The profile fields a tab's visibility is decided from — the `auth.me` read model. */
export type ProfileViewer = Pick<SwarmUser, 'instanceAdmin'>;

/**
 * Whether `viewer` sees a tab at all. **MCP** (issue #1362) exists only for those
 * who may hold agent access tokens — the same `MAY_USE_AGENT_ACCESS_TOKENS`
 * decision the token API enforces, which admits every signed-in user since issue
 * #1457, project membership or not. A role that map denies would see no tab, and
 * a deep link to it would degrade to Account like an undelivered one.
 */
export function isProfileTabVisibleTo(tab: ProfileTab, viewer: ProfileViewer): boolean {
	if (!isProfileTabAvailable(tab)) return false;
	return tab === 'mcp' ? mayUseAgentAccessTokens(viewer) : true;
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
 * the fallback for a tab that is declared but not yet delivered, or not shown to
 * this viewer.
 */
export function resolveActiveProfileTab(search: ProfileSearch, viewer: ProfileViewer): ProfileTab {
	return search.tab && isProfileTabVisibleTo(search.tab, viewer) ? search.tab : 'account';
}

/** Search state for switching to a tab. */
export function profileTabSearch(tab: ProfileTab): ProfileSearch {
	return { tab };
}
