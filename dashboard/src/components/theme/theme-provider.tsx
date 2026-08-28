import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import type { AppearanceTheme, ResolvedTheme } from '@/lib/theme.js';
import { getSystemTheme, resolveTheme, subscribeToSystemTheme } from '@/lib/theme.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import type { AppSettings } from '../../../../src/config/app-settings.js';

/** The theme applied when settings are absent, still loading, or failed to load. */
const FALLBACK_PREFERENCE: AppearanceTheme = 'dark';

interface ThemeContextValue {
	/** The explicit saved choice (or the optimistic one mid-save) — never the resolved system color. */
	preference: AppearanceTheme;
	/** The theme actually rendered — `preference` with `system` resolved to the live OS/browser value. */
	resolvedTheme: ResolvedTheme;
	setTheme: (next: AppearanceTheme) => void;
	isPending: boolean;
	isError: boolean;
	errorMessage?: string;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/**
 * Applies the dashboard's theme dashboard-wide (issue #250): mounted once near
 * the root (`app.tsx`), inside the `QueryClientProvider` so it can share the
 * cached `settings.get` query the Appearance panel also reads. Defaults to
 * dark whenever settings are absent/loading/erroring, matching the
 * dashboard's original look for every installation that hasn't opted into
 * Light or System default.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
	const queryClient = useQueryClient();
	const settingsQuery = useQuery(trpc.settings.get.queryOptions());
	const settings = settingsQuery.data;
	const savedPreference = settings?.appearance.theme ?? FALLBACK_PREFERENCE;

	// Optimistic local override: set the instant a selection is made, cleared
	// once the mutation settles (success or failure) so `preference` snaps back
	// to whatever `settings.get` actually holds.
	const [pendingPreference, setPendingPreference] = useState<AppearanceTheme | undefined>(
		undefined,
	);
	const preference = pendingPreference ?? savedPreference;

	const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());
	useEffect(() => {
		if (preference !== 'system') return;
		return subscribeToSystemTheme(setSystemTheme);
	}, [preference]);

	const resolvedTheme = resolveTheme(preference, systemTheme);

	useEffect(() => {
		document.documentElement.setAttribute('data-theme', resolvedTheme);
	}, [resolvedTheme]);

	const updateMutation = useMutation({
		mutationFn: (next: AppearanceTheme) => {
			// Merge onto the currently loaded settings (not just `{ appearance }`) so
			// saving a theme choice can never drop `agents.defaults`.
			const nextSettings: AppSettings = {
				...settings,
				appearance: { theme: next },
			} as AppSettings;
			return trpcClient.settings.update.mutate(nextSettings);
		},
		onSuccess: () => {
			setPendingPreference(undefined);
			return queryClient.invalidateQueries({
				queryKey: trpc.settings.get.queryOptions().queryKey,
			});
		},
		onError: () => {
			// Roll back the optimistic pick — `preference` falls through to
			// whatever `settings.get` last actually persisted.
			setPendingPreference(undefined);
		},
	});

	const setTheme = (next: AppearanceTheme) => {
		// A theme change is a full settings-blob replacement, so there is no safe payload
		// until the current blob has loaded. The settings route normally prevents the
		// Appearance panel from rendering in this state; retain this guard at the write
		// boundary so another caller cannot accidentally drop sibling settings.
		if (!settings) return;
		// A system change while an explicit preference is active produces no
		// media-query event because there is intentionally no subscription. Read
		// the current value before rendering `system`, rather than reusing that
		// stale snapshot for one render.
		if (next === 'system') setSystemTheme(getSystemTheme());
		setPendingPreference(next);
		updateMutation.mutate(next);
	};

	const value: ThemeContextValue = {
		preference,
		resolvedTheme,
		setTheme,
		isPending: updateMutation.isPending,
		isError: updateMutation.isError,
		errorMessage: updateMutation.error?.message,
	};

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
	const ctx = useContext(ThemeContext);
	if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
	return ctx;
}
