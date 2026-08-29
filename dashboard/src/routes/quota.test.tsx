// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { quotaQueryOptions } = vi.hoisted(() => ({ quotaQueryOptions: vi.fn() }));

vi.mock('@/lib/trpc.js', () => ({
	trpc: { quota: { getQuotas: { queryOptions: quotaQueryOptions } } },
}));

import { QuotaRouteComponent, QuotaWindowCard } from './quota.js';

/** The colour class of every quota bar rendered, in document order. */
function barColors(container: HTMLElement): string[] {
	const bars = container.querySelectorAll<HTMLElement>('[data-testid="quota-bar"]');
	if (bars.length === 0) throw new Error('no quota bar was rendered');
	return Array.from(bars).map((bar) => {
		const color = Array.from(bar.classList).find((name) => name.startsWith('bg-'));
		if (!color) throw new Error(`quota bar carries no colour class: ${bar.className}`);
		return color;
	});
}

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

/** The screen with a failing `getQuotas` read, so the error branch renders. */
function renderFailedQuotaScreen(message: string) {
	quotaQueryOptions.mockReturnValue({
		queryKey: ['quota.getQuotas'],
		queryFn: async () => {
			throw new Error(message);
		},
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
				workerId: 'worker-01',
				workerName: 'builder-01',
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
				workerId: 'worker-01',
				workerName: 'builder-01',
				cli: 'claude',
				status: 'available',
				source: 'live',
				plan: 'max',
				credits: 'available: 1',
				lastUpdated: new Date().toISOString(),
				windows: [{ name: 'Weekly', sourceSlot: 'primary', durationMins: 10080, usedPercent: 40 }],
			},
			{
				workerId: 'worker-01',
				workerName: 'builder-01',
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
				workerId: 'worker-01',
				workerName: 'builder-01',
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

	// Issue #703: two machines reporting the same CLI used to overwrite one another
	// in storage; now both rows arrive, and each allowance must be shown under the
	// machine it describes rather than collapsing into one unlabelled card. The
	// machine is named by its worker since issue #823.
	it('names each worker and renders both workers’ cards for the same CLI', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		renderQuotaScreen([
			{
				workerId: 'worker-02',
				workerName: 'builder-02',
				cli: 'codex',
				status: 'available',
				source: 'live',
				lastUpdated: '2026-08-13T09:00:00.000Z',
				windows: [{ name: 'Weekly', sourceSlot: 'primary', durationMins: 10080, usedPercent: 80 }],
			},
			{
				workerId: 'worker-01',
				workerName: 'builder-01',
				cli: 'codex',
				status: 'available',
				source: 'live',
				lastUpdated: '2026-08-13T08:00:00.000Z',
				windows: [{ name: 'Weekly', sourceSlot: 'primary', durationMins: 10080, usedPercent: 10 }],
			},
		]);

		expect(await screen.findByText('builder-01')).toBeTruthy();
		expect(screen.getByText('builder-02')).toBeTruthy();
		// Both allowances survive: one card per worker, not one card for the installation.
		expect(screen.getAllByText('Codex')).toHaveLength(2);
		expect(screen.getAllByText('Weekly (7d)')).toHaveLength(2);
		expect(screen.getByText('90% remaining')).toBeTruthy();
		expect(screen.getByText('20% remaining')).toBeTruthy();
		// `cli` alone is no longer a unique React key across workers.
		expect(consoleError.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(
			false,
		);
		consoleError.mockRestore();
	});

	it('reports a worker’s own diagnostics under that worker', async () => {
		renderQuotaScreen([
			{
				workerId: 'worker-01',
				workerName: 'builder-01',
				cli: 'claude',
				status: 'available',
				source: 'live',
				lastUpdated: '2026-08-13T08:00:00.000Z',
				windows: [{ name: 'Weekly', sourceSlot: 'primary', durationMins: 10080, usedPercent: 10 }],
			},
			{
				workerId: 'worker-02',
				workerName: 'builder-02',
				cli: 'claude',
				status: 'unavailable',
				source: 'fallback',
				error: 'claude binary not found on PATH',
				lastUpdated: '2026-08-13T09:00:00.000Z',
			},
		]);

		expect(await screen.findByText('builder-02')).toBeTruthy();
		expect(screen.getByText('claude binary not found on PATH')).toBeTruthy();
		// The reporting worker with nothing usable says so for itself, rather than the
		// page reporting "no CLIs discovered" for the whole installation.
		expect(screen.getByText('No quota data is available for this worker.')).toBeTruthy();
	});

	// Issue #823: the read is scoped to the viewer's own workers, so an empty result
	// means "nothing of yours" rather than "nothing anywhere" — and the same state
	// covers owning no worker at all and owning one that has not reported.
	it('states the owner-scoped empty case when nothing is persisted', async () => {
		renderQuotaScreen([]);

		expect(
			await screen.findByText('No CLI quota has been reported for any worker you own.'),
		).toBeTruthy();
		expect(screen.getByText('This page shows only your own registered machines.')).toBeTruthy();
	});

	// Issue #754: the screen reads persisted snapshots, so the freshness caveat and the
	// refresh instruction are stated once for the page — and stated whether or not any
	// quota data is present — instead of being repeated by each empty placeholder.
	describe('freshness notice', () => {
		it('shows the notice alongside populated cards', async () => {
			renderQuotaScreen([
				{
					workerId: 'worker-01',
					workerName: 'builder-01',
					cli: 'claude',
					status: 'available',
					source: 'live',
					lastUpdated: '2026-08-13T08:00:00.000Z',
					windows: [
						{ name: 'Weekly', sourceSlot: 'primary', durationMins: 10080, usedPercent: 40 },
					],
				},
			]);

			expect(await screen.findByText('Weekly (7d)')).toBeTruthy();
			expect(screen.getByText(/may be out of date/i)).toBeTruthy();
			expect(screen.getByText(/Refresh re-reads the latest stored snapshot/i)).toBeTruthy();
		});

		it('shows the notice when there is no quota data at all', async () => {
			renderQuotaScreen([]);

			expect(
				await screen.findByText('No CLI quota has been reported for any worker you own.'),
			).toBeTruthy();
			expect(screen.getByText(/may be out of date/i)).toBeTruthy();
		});

		it('shows the notice beside a load error, which stays distinguishable', async () => {
			renderFailedQuotaScreen('quota read failed');

			expect(await screen.findByText('Error Loading Quotas')).toBeTruthy();
			expect(screen.getByText('quota read failed')).toBeTruthy();
			expect(screen.getByText(/may be out of date/i)).toBeTruthy();
		});
	});

	// Issue #754: a placeholder states only the absence — no claim that usage is tracked
	// from run outcomes, and no second copy of the page-level refresh instruction.
	describe('empty placeholders', () => {
		it('states the absence for a CLI reporting no usage windows', async () => {
			renderQuotaScreen([
				{
					workerId: 'worker-01',
					workerName: 'builder-01',
					cli: 'claude',
					status: 'available',
					source: 'fallback',
					lastUpdated: '2026-08-13T08:00:00.000Z',
					windows: [],
				},
			]);

			expect(
				await screen.findByText('No usage window data is available for this CLI.'),
			).toBeTruthy();
			expect(screen.queryByText(/tracked dynamically/i)).toBeNull();
			expect(screen.queryByText(/from run outcomes/i)).toBeNull();
			// The page-level notice owns the refresh instruction; the placeholders don't repeat it.
			expect(screen.queryByText(/then click Refresh/i)).toBeNull();
			expect(screen.queryByText(/installed and logged in/i)).toBeNull();
		});

		it('keeps an unavailable CLI marked unavailable when it reports no error detail', async () => {
			renderQuotaScreen([
				{
					workerId: 'worker-01',
					workerName: 'builder-01',
					cli: 'codex',
					status: 'unavailable',
					source: 'fallback',
					lastUpdated: '2026-08-13T08:00:00.000Z',
				},
			]);

			expect(await screen.findByText('Unavailable')).toBeTruthy();
			expect(screen.getByText('No error detail is available for this CLI.')).toBeTruthy();
			// The snapshot named no cause, so the row no longer invents one.
			expect(screen.queryByText(/missing or unauthenticated/i)).toBeNull();
		});

		it('keeps rate-limit exhaustion distinct from an ordinary absence of data', async () => {
			renderQuotaScreen([
				{
					workerId: 'worker-01',
					workerName: 'builder-01',
					cli: 'claude',
					status: 'available',
					source: 'fallback',
					lastUpdated: '2026-08-13T08:00:00.000Z',
					resetTime: '2026-08-13T12:00:00.000Z',
					windows: [],
				},
			]);

			expect(await screen.findByText('Rate Limit Exhaustion Detected')).toBeTruthy();
			expect(screen.queryByText('No usage window data is available for this CLI.')).toBeNull();
		});
	});

	// Issue #753: the bar reads *remaining* allowance, so both boundaries are
	// inclusive and are asserted at the exact percentage rather than around it —
	// 30% remaining is already a warning, 10% remaining is already critical.
	describe('quota bar urgency thresholds', () => {
		it.each([
			{ remaining: 100, usedPercent: 0, color: 'bg-emerald-500' },
			{ remaining: 31, usedPercent: 69, color: 'bg-emerald-500' },
			{ remaining: 30, usedPercent: 70, color: 'bg-amber-500' },
			{ remaining: 11, usedPercent: 89, color: 'bg-amber-500' },
			{ remaining: 10, usedPercent: 90, color: 'bg-rose-500' },
			{ remaining: 0, usedPercent: 100, color: 'bg-rose-500' },
		])('paints $color at $remaining% remaining', ({ remaining, usedPercent, color }) => {
			const { container } = render(<QuotaWindowCard name="Weekly" usedPercent={usedPercent} />);

			expect(screen.getByText(`${remaining}% remaining`)).toBeTruthy();
			expect(barColors(container)).toEqual([color]);
		});

		it('applies the same thresholds to every window on the page', async () => {
			const { container } = renderQuotaScreen([
				{
					workerId: 'worker-01',
					workerName: 'builder-01',
					cli: 'claude',
					status: 'available',
					source: 'live',
					lastUpdated: '2026-08-13T08:00:00.000Z',
					windows: [
						{ name: 'Weekly', sourceSlot: 'primary', durationMins: 10080, usedPercent: 69 },
						{ name: 'Session', sourceSlot: 'secondary', durationMins: 300, usedPercent: 70 },
					],
				},
				{
					workerId: 'worker-02',
					workerName: 'builder-02',
					cli: 'codex',
					status: 'available',
					source: 'live',
					lastUpdated: '2026-08-13T09:00:00.000Z',
					windows: [
						{ name: 'Weekly', sourceSlot: 'primary', durationMins: 10080, usedPercent: 90 },
					],
				},
			]);

			await screen.findByText('Session (5h)');
			// Every window is coloured by its own remaining percentage, whichever worker
			// or CLI reported it: 31% green, 30% amber, 10% red.
			expect(barColors(container)).toEqual(['bg-emerald-500', 'bg-amber-500', 'bg-rose-500']);
		});
	});
});
