// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { mockUseTheme } = vi.hoisted(() => ({ mockUseTheme: vi.fn() }));

vi.mock('@/components/theme/theme-provider.js', () => ({
	useTheme: mockUseTheme,
}));

import { isRedirect } from '@tanstack/react-router';
import { SETTINGS_TABS, settingsSearchSchema, visibleSettingsTabs } from '@/lib/settings-nav.js';
import { AppearancePanel, SettingsPageTitle, SettingsTabBar, settingsRoute } from './index.js';

describe('SettingsPageTitle', () => {
	// The page reads "General"; the sidebar link that opens it reads "Settings" (issue #1390).
	it('reads General', () => {
		render(<SettingsPageTitle />);

		expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('General');
	});
});

describe('settingsRoute legacy bug-report links (issue #1443)', () => {
	const REPORT = '00000000-0000-4000-8000-000000000001';

	/** What the route's `beforeLoad` does for `rawSearch`: the redirect it throws, if any. */
	function beforeLoadFor(rawSearch: Record<string, unknown>) {
		const search = settingsSearchSchema.parse(rawSearch);
		try {
			// biome-ignore lint/suspicious/noExplicitAny: `beforeLoad` reads only `search`.
			settingsRoute.options.beforeLoad?.({ search } as any);
		} catch (thrown) {
			return thrown;
		}
		return undefined;
	}

	it.each([
		{ link: '?tab=issues', rawSearch: { tab: 'issues' }, search: {} },
		{
			link: '?tab=issues&report=<id>',
			rawSearch: { tab: 'issues', report: REPORT },
			search: { report: REPORT },
		},
	])('redirects $link to the bug reports page', ({ rawSearch, search }) => {
		const thrown = beforeLoadFor(rawSearch);

		expect(isRedirect(thrown)).toBe(true);
		const options = (thrown as { options: { to: string; search: unknown; replace: boolean } })
			.options;
		expect(options.to).toBe('/bug-reports');
		expect(options.search).toEqual(search);
		expect(options.replace).toBe(true);
	});

	it('leaves every other settings link on the settings page', () => {
		expect(beforeLoadFor({})).toBeUndefined();
		expect(beforeLoadFor({ tab: 'appearance' })).toBeUndefined();
	});
});

describe('SettingsTabBar', () => {
	it('renders the tabs in SETTINGS_TABS order for an instance administrator', () => {
		render(
			<SettingsTabBar
				tabs={visibleSettingsTabs({ instanceAdmin: true })}
				activeTab="agents"
				onSelect={() => {}}
			/>,
		);

		const labels = screen.getAllByRole('button').map((button) => button.textContent);
		expect(labels).toEqual(['Agent Defaults', 'Credentials', 'Users', 'Fleet', 'Appearance']);
		// The rendered order and the `?tab=` vocabulary must not drift apart.
		expect(labels).toHaveLength(SETTINGS_TABS.length);
	});

	// Issues is no longer a tab: the bug reports have their own page (issue #1443).
	it('offers no admin-only tab to a non-administrator (issues #666, #769, #1151, #1284)', () => {
		render(
			<SettingsTabBar
				tabs={visibleSettingsTabs({ instanceAdmin: false })}
				activeTab="appearance"
				onSelect={() => {}}
			/>,
		);

		const labels = screen.getAllByRole('button').map((button) => button.textContent);
		expect(labels).toEqual(['Appearance']);
	});

	it('selects the tab that was clicked', () => {
		const onSelect = vi.fn();
		render(
			<SettingsTabBar
				tabs={visibleSettingsTabs({ instanceAdmin: true })}
				activeTab="agents"
				onSelect={onSelect}
			/>,
		);

		fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));

		expect(onSelect).toHaveBeenCalledWith('appearance');
	});
});

describe('AppearancePanel', () => {
	it('renders all three theme options as accessible radios', () => {
		mockUseTheme.mockReturnValue({
			preference: 'dark',
			resolvedTheme: 'dark',
			setTheme: vi.fn(),
			isPending: false,
			isError: false,
		});
		render(<AppearancePanel />);

		expect(screen.getByRole('radio', { name: /^Dark/ })).not.toBeNull();
		expect(screen.getByRole('radio', { name: /^Light/ })).not.toBeNull();
		expect(screen.getByRole('radio', { name: /^System default/ })).not.toBeNull();
	});

	it('checks the option matching the explicit preference, not the resolved theme', () => {
		// preference is 'system' while the OS happens to resolve to dark — the
		// radio group must reflect the saved choice, never the resolved color.
		mockUseTheme.mockReturnValue({
			preference: 'system',
			resolvedTheme: 'dark',
			setTheme: vi.fn(),
			isPending: false,
			isError: false,
		});
		render(<AppearancePanel />);

		expect(
			(screen.getByRole('radio', { name: /^System default/ }) as HTMLInputElement).checked,
		).toBe(true);
		expect((screen.getByRole('radio', { name: /^Dark/ }) as HTMLInputElement).checked).toBe(false);
		expect((screen.getByRole('radio', { name: /^Light/ }) as HTMLInputElement).checked).toBe(false);
	});

	it('calls setTheme with the selected value', () => {
		const setTheme = vi.fn();
		mockUseTheme.mockReturnValue({
			preference: 'dark',
			resolvedTheme: 'dark',
			setTheme,
			isPending: false,
			isError: false,
		});
		render(<AppearancePanel />);

		fireEvent.click(screen.getByRole('radio', { name: /^Light/ }));
		expect(setTheme).toHaveBeenCalledWith('light');

		fireEvent.click(screen.getByRole('radio', { name: /^System default/ }));
		expect(setTheme).toHaveBeenCalledWith('system');
	});

	it('disables every option while a save is pending', () => {
		mockUseTheme.mockReturnValue({
			preference: 'dark',
			resolvedTheme: 'dark',
			setTheme: vi.fn(),
			isPending: true,
			isError: false,
		});
		render(<AppearancePanel />);

		for (const radio of screen.getAllByRole('radio') as HTMLInputElement[]) {
			expect(radio.disabled).toBe(true);
		}
	});

	it('shows an error banner with the message when saving fails', () => {
		mockUseTheme.mockReturnValue({
			preference: 'dark',
			resolvedTheme: 'dark',
			setTheme: vi.fn(),
			isPending: false,
			isError: true,
			errorMessage: 'save failed',
		});
		render(<AppearancePanel />);

		expect(screen.getByText(/Failed to save appearance/)).not.toBeNull();
		expect(screen.getByText(/save failed/)).not.toBeNull();
	});
});
