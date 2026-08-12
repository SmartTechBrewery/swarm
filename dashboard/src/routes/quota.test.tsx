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
				cli: 'claude',
				status: 'available',
				source: 'live',
				plan: 'max',
				credits: 'available: 1',
				lastUpdated: new Date().toISOString(),
				windows: [{ name: 'Weekly', sourceSlot: 'primary', durationMins: 10080, usedPercent: 40 }],
			},
			{
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
});
