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
