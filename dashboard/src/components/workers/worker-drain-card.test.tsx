// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setDrainingMutate } = vi.hoisted(() => ({ setDrainingMutate: vi.fn() }));

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: { workers: { setDraining: { mutate: setDrainingMutate } } },
}));

import { WorkerDrainCard } from './worker-drain-card.js';

const NOW = new Date('2026-07-01T12:00:00.000Z');

const onChanged = vi.fn();

function renderCard(
	overrides: {
		drainingSince?: string | null;
		isRunning?: boolean;
		currentRunTitle?: string | null;
	} = {},
) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<WorkerDrainCard
				workerId="worker-1"
				drainingSince={overrides.drainingSince ?? null}
				isRunning={overrides.isRunning ?? false}
				currentRunTitle={overrides.currentRunTitle ?? null}
				onChanged={onChanged}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	setDrainingMutate.mockReset();
	setDrainingMutate.mockResolvedValue({
		workerId: 'worker-1',
		displayName: 'ada-laptop',
		drainingSince: NOW.toISOString(),
		busy: false,
		currentRunId: null,
	});
	onChanged.mockReset();
	// Fake only `Date` (fixes `formatRelativeTime`'s "now") so setTimeout stays real
	// and Testing Library's async helpers resolve normally.
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('WorkerDrainCard in the pool (issue #926)', () => {
	it('offers the drain, and says what draining does', () => {
		renderCard();

		expect(screen.getByRole('button', { name: 'Drain worker' })).toBeDefined();
		expect(screen.getByText(/finishes what it is running/)).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Return to the pool' })).toBeNull();
	});

	it('drains on a single click — it is reversible, so there is no confirmation', async () => {
		renderCard();

		fireEvent.click(screen.getByRole('button', { name: 'Drain worker' }));

		await waitFor(() =>
			expect(setDrainingMutate).toHaveBeenCalledWith({ workerId: 'worker-1', draining: true }),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});
});

describe('WorkerDrainCard while draining (issue #926)', () => {
	const drainingSince = new Date(NOW.getTime() - 5 * 60_000).toISOString();

	it('says since when, with the exact timestamp as a title', () => {
		renderCard({ drainingSince });

		const since = screen.getByText('Draining since 5m ago');
		expect(since.getAttribute('title')).toBe(new Date(drainingSince).toLocaleString());
	});

	it('names the job still running, so restarting waits for it', () => {
		renderCard({
			drainingSince,
			isRunning: true,
			currentRunTitle: 'Teach the dispatcher to count',
		});

		expect(screen.getByText(/Still running “Teach the dispatcher to count”/)).toBeDefined();
		expect(screen.queryByText(/safe to restart now/)).toBeNull();
	});

	// Busy-ness is the run's presence, never its title: a PR-driven phase carries no
	// work-item title at all, and reading one as idleness invited the restart that
	// kills the agent and fails the run.
	it('still says to wait when the running job has no title to name', () => {
		renderCard({ drainingSince, isRunning: true, currentRunTitle: null });

		expect(
			screen.getByText('Still running a job — wait for it to finish before restarting.'),
		).toBeDefined();
		expect(screen.queryByText(/safe to restart now/)).toBeNull();
	});

	it('says restarting is safe once the machine has gone idle', () => {
		renderCard({ drainingSince });

		expect(screen.getByText('Idle — safe to restart now.')).toBeDefined();
	});

	it('returns the machine to the pool', async () => {
		renderCard({ drainingSince });

		fireEvent.click(screen.getByRole('button', { name: 'Return to the pool' }));

		await waitFor(() =>
			expect(setDrainingMutate).toHaveBeenCalledWith({ workerId: 'worker-1', draining: false }),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});
});

describe('WorkerDrainCard errors', () => {
	it('shows the server’s refusal verbatim — the server stays the authority', async () => {
		setDrainingMutate.mockRejectedValue(new Error('Worker not found'));
		renderCard();

		fireEvent.click(screen.getByRole('button', { name: 'Drain worker' }));

		expect(await screen.findByText('Worker not found')).toBeDefined();
		expect(onChanged).not.toHaveBeenCalled();
	});
});
