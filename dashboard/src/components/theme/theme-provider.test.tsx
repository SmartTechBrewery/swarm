// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../../src/config/app-settings.js';

const { mockGetSettings, mockUpdateSettings } = vi.hoisted(() => ({
	mockGetSettings: vi.fn(),
	mockUpdateSettings: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		settings: {
			get: {
				queryOptions: () => ({
					queryKey: ['settings', 'get'],
					queryFn: mockGetSettings,
				}),
			},
		},
	},
	trpcClient: {
		settings: { update: { mutate: mockUpdateSettings } },
	},
}));

const { ThemeProvider, useTheme } = await import('./theme-provider.js');

function stubMatchMedia(matches: boolean) {
	const listeners = new Set<(event: MediaQueryListEvent) => void>();
	const mql = {
		matches,
		media: '(prefers-color-scheme: dark)',
		addEventListener: vi.fn((_: 'change', listener: (event: MediaQueryListEvent) => void) => {
			listeners.add(listener);
		}),
		removeEventListener: vi.fn((_: 'change', listener: (event: MediaQueryListEvent) => void) => {
			listeners.delete(listener);
		}),
	};
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => mql),
	);
	return {
		mql,
		fire: (next: boolean) => {
			mql.matches = next;
			for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
		},
	};
}

function renderTheme() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			<ThemeProvider>{children}</ThemeProvider>
		</QueryClientProvider>
	);
	const view = renderHook(() => useTheme(), { wrapper });
	return { ...view, queryClient };
}

/** Waits for the mocked `settings.get` query to actually resolve into the cache. */
async function waitForSettingsLoaded(queryClient: QueryClient, expected: AppSettings) {
	await waitFor(() => expect(queryClient.getQueryData(['settings', 'get'])).toEqual(expected));
}

describe('ThemeProvider', () => {
	beforeEach(() => {
		mockGetSettings.mockReset();
		mockUpdateSettings.mockReset();
		document.documentElement.removeAttribute('data-theme');
		stubMatchMedia(true);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('defaults to dark while settings are still loading', () => {
		mockGetSettings.mockReturnValue(new Promise(() => {})); // never resolves
		const { result } = renderTheme();

		expect(result.current.preference).toBe('dark');
		expect(result.current.resolvedTheme).toBe('dark');
	});

	it('does not write a partial settings blob while settings are still loading', () => {
		mockGetSettings.mockReturnValue(new Promise(() => {})); // never resolves
		const { result } = renderTheme();

		act(() => result.current.setTheme('light'));

		expect(mockUpdateSettings).not.toHaveBeenCalled();
	});

	it('defaults to dark when the settings query errors', async () => {
		mockGetSettings.mockRejectedValue(new Error('network down'));
		const { result } = renderTheme();

		await waitFor(() => expect(result.current.preference).toBe('dark'));
	});

	it('applies an explicit saved light preference', async () => {
		mockGetSettings.mockResolvedValue({ appearance: { theme: 'light' } } satisfies AppSettings);
		const { result } = renderTheme();

		await waitFor(() => expect(result.current.preference).toBe('light'));
		expect(result.current.resolvedTheme).toBe('light');
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
	});

	it('resolves system to the live OS preference and updates documentElement', async () => {
		const { fire } = stubMatchMedia(true);
		mockGetSettings.mockResolvedValue({ appearance: { theme: 'system' } } satisfies AppSettings);
		const { result } = renderTheme();

		// Wait for the saved 'system' preference to actually load — the initial
		// dark fallback would otherwise satisfy a resolvedTheme==='dark' wait too.
		await waitFor(() => expect(result.current.preference).toBe('system'));
		expect(result.current.resolvedTheme).toBe('dark');
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

		act(() => fire(false));
		await waitFor(() => expect(result.current.resolvedTheme).toBe('light'));
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
	});

	it('does not subscribe to system-preference changes for an explicit dark/light choice', async () => {
		const { mql } = stubMatchMedia(true);
		mockGetSettings.mockResolvedValue({ appearance: { theme: 'dark' } } satisfies AppSettings);
		const { result } = renderTheme();

		await waitFor(() => expect(result.current.preference).toBe('dark'));
		expect(mql.addEventListener).not.toHaveBeenCalled();
	});

	it('unsubscribes the media-query listener when switching away from system', async () => {
		const { mql } = stubMatchMedia(true);
		mockGetSettings.mockResolvedValue({ appearance: { theme: 'system' } } satisfies AppSettings);
		mockUpdateSettings.mockResolvedValue({ appearance: { theme: 'dark' } });
		const { result } = renderTheme();

		await waitFor(() => expect(mql.addEventListener).toHaveBeenCalledTimes(1));

		act(() => result.current.setTheme('dark'));
		await waitFor(() => expect(mql.removeEventListener).toHaveBeenCalledTimes(1));
	});

	it('reads the current OS preference when switching from an explicit theme to system', async () => {
		const { mql } = stubMatchMedia(true);
		mockGetSettings.mockResolvedValue({ appearance: { theme: 'light' } } satisfies AppSettings);
		let resolveUpdate: (value: AppSettings) => void = () => {};
		mockUpdateSettings.mockReturnValue(
			new Promise((resolve) => {
				resolveUpdate = resolve;
			}),
		);
		const { result } = renderTheme();

		await waitFor(() => expect(result.current.preference).toBe('light'));
		mql.matches = false; // OS changed while the explicit light theme was active.

		act(() => result.current.setTheme('system'));

		expect(result.current.preference).toBe('system');
		expect(result.current.resolvedTheme).toBe('light');
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');

		await act(async () => {
			resolveUpdate({ appearance: { theme: 'system' } });
			await Promise.resolve();
		});
	});

	it('switches optimistically and persists the full settings payload, preserving agents.defaults', async () => {
		const stored: AppSettings = {
			agents: { defaults: { claude: 'opus' } },
			appearance: { theme: 'dark' },
		};
		mockGetSettings.mockResolvedValue(stored);
		let resolveUpdate: (value: AppSettings) => void = () => {};
		mockUpdateSettings.mockReturnValue(
			new Promise((resolve) => {
				resolveUpdate = resolve;
			}),
		);
		const { result, queryClient } = renderTheme();
		await waitForSettingsLoaded(queryClient, stored);

		act(() => result.current.setTheme('light'));

		// Optimistic: resolves immediately, before the mutation settles.
		expect(result.current.preference).toBe('light');
		expect(result.current.resolvedTheme).toBe('light');
		await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledTimes(1));
		expect(mockUpdateSettings).toHaveBeenCalledWith({
			agents: { defaults: { claude: 'opus' } },
			appearance: { theme: 'light' },
		});

		await act(async () => {
			resolveUpdate({ ...stored, appearance: { theme: 'light' } });
			await Promise.resolve();
		});
		await waitFor(() => expect(result.current.isPending).toBe(false));
	});

	it('rolls back to the last persisted preference and surfaces an error on save failure', async () => {
		const stored = { appearance: { theme: 'dark' } } satisfies AppSettings;
		mockGetSettings.mockResolvedValue(stored);
		mockUpdateSettings.mockRejectedValue(new Error('save failed'));
		const { result, queryClient } = renderTheme();
		await waitForSettingsLoaded(queryClient, stored);

		act(() => result.current.setTheme('light'));
		expect(result.current.preference).toBe('light');

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.preference).toBe('dark');
		expect(result.current.errorMessage).toBe('save failed');
	});
});
