// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../../src/config/app-settings.js';

const { updateMutate } = vi.hoisted(() => ({ updateMutate: vi.fn() }));

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: { settings: { update: { mutate: updateMutate } } },
	trpc: { settings: { get: { queryOptions: () => ({ queryKey: ['settings.get'] }) } } },
}));

import { FleetUpdatesPanel } from './fleet-updates-panel.js';

const STORED: AppSettings = {
	agents: { defaults: { claude: 'opus' } },
	appearance: { theme: 'light' },
	workers: { followInstallationVersion: true },
};

function renderPanel(settings: AppSettings = STORED) {
	const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<FleetUpdatesPanel settings={settings} />
		</QueryClientProvider>,
	);
}

const switchLabel = "Keep workers on this installation's version";

describe('FleetUpdatesPanel', () => {
	beforeEach(() => {
		updateMutate.mockReset();
	});

	it('shows the stored value', () => {
		renderPanel({ ...STORED, workers: { followInstallationVersion: false } });

		expect(screen.getByRole('switch', { name: switchLabel }).getAttribute('aria-checked')).toBe(
			'false',
		);
	});

	// Merged onto the whole loaded blob, so turning it off cannot drop the theme or
	// the agent defaults.
	it('saves the flipped value merged onto the loaded settings', async () => {
		updateMutate.mockResolvedValue(STORED);
		renderPanel();

		fireEvent.click(screen.getByRole('switch', { name: switchLabel }));

		await waitFor(() =>
			expect(updateMutate).toHaveBeenCalledWith({
				...STORED,
				workers: { followInstallationVersion: false },
			}),
		);
	});

	it('surfaces a refused save', async () => {
		updateMutate.mockRejectedValue(new Error('instance administrators only'));
		renderPanel();

		fireEvent.click(screen.getByRole('switch', { name: switchLabel }));

		expect(await screen.findByText(/instance administrators only/)).toBeTruthy();
	});
});
