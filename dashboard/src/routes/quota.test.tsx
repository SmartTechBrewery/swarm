// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { quotaQueryOptions } = vi.hoisted(() => ({ quotaQueryOptions: vi.fn() }));

vi.mock('@/lib/trpc.js', () => ({
	trpc: { quota: { getQuotas: { queryOptions: quotaQueryOptions } } },
	trpcClient: { quota: { refreshQuotas: { mutate: vi.fn() } } },
}));

import { QuotaRouteComponent } from './quota.js';

function renderQuotaScreen(quotas: unknown[]) {
	quotaQueryOptions.mockReturnValue({
		queryKey: ['quota.getQuotas'],
		queryFn: async () => quotas,
	});
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<QuotaRouteComponent />
		</QueryClientProvider>,
	);
}

describe('quota route', () => {
	it('preserves non-integral durations in the window suffix', async () => {
		renderQuotaScreen([
			{
				host: 'builder-01',
				cli: 'codex',
				status: 'available',
				source: 'live',
				lastUpdated: new Date().toISOString(),
				windows: [
					{ name: '90-minute', sourceSlot: 'primary', durationMins: 90, usedPercent: 28 },
					{ name: '1500-minute', sourceSlot: 'secondary', durationMins: 1500, usedPercent: 15 },
				],
			},
		]);

		expect(await screen.findByText('90-minute (90m)')).toBeTruthy();
		expect(screen.getByText('1500-minute (25h)')).toBeTruthy();
	});

	// Issue #679: the plan tier is account/product detail, not a quota, so no card
	// may carry it — not even the "Standard" placeholder shown when a CLI reports none.
	it('omits plan tier copy while keeping credits and usage', async () => {
		renderQuotaScreen([
			{
				host: 'builder-01',
				cli: 'claude',
				status: 'available',
				source: 'live',
				plan: 'max',
				credits: 'available: 1',
				lastUpdated: new Date().toISOString(),
				windows: [{ name: 'Weekly', sourceSlot: 'primary', durationMins: 10080, usedPercent: 40 }],
			},
			{
				host: 'builder-01',
				cli: 'codex',
				status: 'available',
				source: 'live',
				lastUpdated: new Date().toISOString(),
				windows: [{ name: 'Hourly', sourceSlot: 'primary', durationMins: 60, usedPercent: 10 }],
			},
		]);

		expect(await screen.findByText('Weekly (7d)')).toBeTruthy();
		expect(screen.getByText('Credits / Resets')).toBeTruthy();
		expect(screen.getByText('available: 1')).toBeTruthy();
		expect(screen.getByText('Hourly (1h)')).toBeTruthy();
		expect(screen.queryByText(/plan tier/i)).toBeNull();
		expect(screen.queryByText('max')).toBeNull();
		expect(screen.queryByText('Standard')).toBeNull();
	});

	it('uses source slots as distinct keys when window metadata is absent', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		renderQuotaScreen([
			{
				host: 'builder-01',
				cli: 'codex',
				status: 'available',
				source: 'live',
				lastUpdated: new Date().toISOString(),
				windows: [
					{ name: 'Usage limit', sourceSlot: 'primary', usedPercent: 5 },
					{ name: 'Usage limit', sourceSlot: 'secondary', usedPercent: 10 },
				],
			},
		]);

		await screen.findAllByText('Usage limit');
		expect(consoleError.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(
			false,
		);
		consoleError.mockRestore();
	});

	// Issue #703: two hosts reporting the same CLI used to overwrite one another in
	// storage; now both rows arrive, and each allowance must be shown under the
	// machine it describes rather than collapsing into one unlabelled card.
	it('names each host and renders both hosts’ cards for the same CLI', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		renderQuotaScreen([
			{
				host: 'builder-02',
				cli: 'codex',
				status: 'available',
				source: 'live',
				lastUpdated: '2026-08-13T09:00:00.000Z',
				windows: [{ name: 'Weekly', sourceSlot: 'primary', durationMins: 10080, usedPercent: 80 }],
			},
			{
				host: 'builder-01',
				cli: 'codex',
				status: 'available',
				source: 'live',
				lastUpdated: '2026-08-13T08:00:00.000Z',
				windows: [{ name: 'Weekly', sourceSlot: 'primary', durationMins: 10080, usedPercent: 10 }],
			},
		]);

		expect(await screen.findByText('builder-01')).toBeTruthy();
		expect(screen.getByText('builder-02')).toBeTruthy();
		// Both allowances survive: one card per host, not one card for the installation.
		expect(screen.getAllByText('Codex')).toHaveLength(2);
		expect(screen.getAllByText('Weekly (7d)')).toHaveLength(2);
		expect(screen.getByText('90% remaining')).toBeTruthy();
		expect(screen.getByText('20% remaining')).toBeTruthy();
		// `cli` alone is no longer a unique React key across hosts.
		expect(consoleError.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(
			false,
		);
		consoleError.mockRestore();
	});

	it('reports a host’s own diagnostics under that host', async () => {
		renderQuotaScreen([
			{
				host: 'builder-01',
				cli: 'claude',
				status: 'available',
				source: 'live',
				lastUpdated: '2026-08-13T08:00:00.000Z',
				windows: [{ name: 'Weekly', sourceSlot: 'primary', durationMins: 10080, usedPercent: 10 }],
			},
			{
				host: 'builder-02',
				cli: 'claude',
				status: 'unavailable',
				source: 'fallback',
				error: 'claude binary not found on PATH',
				lastUpdated: '2026-08-13T09:00:00.000Z',
			},
		]);

		expect(await screen.findByText('builder-02')).toBeTruthy();
		expect(screen.getByText('claude binary not found on PATH')).toBeTruthy();
		// The reporting host with nothing usable says so for itself, rather than the
		// page reporting "no CLIs discovered" for the whole installation.
		expect(screen.getByText('No active, usable agent CLIs on this host.')).toBeTruthy();
	});

	it('states that no host has reported when nothing is persisted', async () => {
		renderQuotaScreen([]);

		expect(await screen.findByText('No host has reported its agent CLIs yet.')).toBeTruthy();
	});
});
