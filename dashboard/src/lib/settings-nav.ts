import { z } from 'zod';

/** The tabs on the General Settings screen, in display order (issue #250 added `appearance`). */
export const SETTINGS_TABS = ['agents', 'appearance'] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/**
 * The slice of the signed-in user this module reads — `CurrentUser.instanceAdmin`
 * (`./auth.ts`), taken structurally rather than by importing that type, mirroring
 * `isInstanceAdmin(user: Pick<SwarmUser, 'instanceAdmin'>)` server-side
 * (`src/identity/schema.ts`). `undefined` is a viewer who hasn't resolved yet and
 * is treated as a non-administrator, so an admin-only section can never flash
 * before `auth.me` answers.
 */
export interface SettingsViewer {
	instanceAdmin: boolean;
}

/**
 * Tabs only an instance administrator may see. Agent defaults are
 * installation-wide configuration, so the section is not presented to a user
 * without instance-administration authority (issue #666). This is a **visibility**
 * boundary on the screen alone: the `settings` tRPC router stays the enforcement
 * point and its authorization is unchanged.
 */
const INSTANCE_ADMIN_ONLY_TABS: readonly SettingsTab[] = ['agents'];

/** The tab a bare `/settings` link opens, for a viewer who may see it. */
const DEFAULT_SETTINGS_TAB: SettingsTab = 'agents';

/** The tab every signed-in user may see — where a hidden or unknown tab lands. */
const FALLBACK_SETTINGS_TAB: SettingsTab = 'appearance';

/**
 * Search-param schema for `/settings`. The active tab lives in the URL — not
 * component state — so switching tabs is a real browser-history entry and a
 * direct/reload link lands on the right panel (mirrors `project-nav.ts`'s
 * `projectDetailSearchSchema`). `.catch(undefined)` degrades a stale or
 * hand-edited unknown tab to the default rather than throwing.
 */
export const settingsSearchSchema = z.object({
	tab: z.enum(SETTINGS_TABS).optional().catch(undefined),
});

export type SettingsSearch = z.infer<typeof settingsSearchSchema>;

/** The tabs a viewer may see, in display order (see {@link INSTANCE_ADMIN_ONLY_TABS}). */
export function visibleSettingsTabs(viewer: SettingsViewer | undefined): readonly SettingsTab[] {
	if (viewer?.instanceAdmin) return SETTINGS_TABS;
	return SETTINGS_TABS.filter((tab) => !INSTANCE_ADMIN_ONLY_TABS.includes(tab));
}

/**
 * The tab to render for a given search state and viewer — Agent Defaults is the
 * default for an instance administrator. A tab the viewer may not see degrades to
 * {@link FALLBACK_SETTINGS_TAB} exactly as an unknown `?tab=` does, so a direct
 * link, a bookmark, or a reload can't render an admin-only section for anyone else.
 */
export function resolveActiveSettingsTab(
	search: SettingsSearch,
	viewer?: SettingsViewer,
): SettingsTab {
	const requested = search.tab ?? DEFAULT_SETTINGS_TAB;
	return visibleSettingsTabs(viewer).includes(requested) ? requested : FALLBACK_SETTINGS_TAB;
}

/** Search state for switching to a tab. */
export function settingsTabSearch(tab: SettingsTab): SettingsSearch {
	return { tab };
}
