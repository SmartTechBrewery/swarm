// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		projects: {
			list: {
				queryOptions: () => ({
					queryKey: ['projects.list'],
					queryFn: () => Promise.resolve([]),
				}),
			},
		},
	},
}));

import { RunFilters } from './run-filters.js';

function renderFilters() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<RunFilters
				onProjectIdChange={vi.fn()}
				onStatusChange={vi.fn()}
				onPhaseChange={vi.fn()}
				onClear={vi.fn()}
			/>
		</QueryClientProvider>,
	);
}

// Issue #971 added the value and its label; issue #974 pins the naming rather than
// changing it. The Phase filter is the *kind of work* axis, so a maintenance run is
// isolated there by the phase it records — and the label must never be worded as a
// status, which the Status filter beside it owns.
describe('the Phase filter isolates worker-update runs (issues #971, #974)', () => {
	it('offers the worker-update phase, labelled as a phase and not as a status', () => {
		renderFilters();

		const phaseSelect = screen.getByLabelText('Phase') as HTMLSelectElement;
		const option = Array.from(phaseSelect.options).find((o) => o.value === 'worker-update');
		expect(option?.textContent).toBe('Worker Update');

		// `Updating` would read as a status; the Status filter is the axis that carries one.
		for (const o of Array.from(phaseSelect.options)) {
			expect(o.textContent).not.toMatch(/updating/i);
		}
	});

	it('ranks it after the six pipeline phases, which keep their own order', () => {
		renderFilters();

		const phaseSelect = screen.getByLabelText('Phase') as HTMLSelectElement;
		const values = Array.from(phaseSelect.options)
			.map((o) => o.value)
			.filter(Boolean);
		expect(values).toEqual([
			'planning',
			'implementation',
			'review',
			'respond-to-review',
			'respond-to-ci',
			'resolve-conflicts',
			'worker-update',
		]);
	});
});
