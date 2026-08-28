// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { removeMutate } = vi.hoisted(() => ({ removeMutate: vi.fn() }));

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: { workers: { remove: { mutate: removeMutate } } },
}));

import { WorkerDeleteCard } from './worker-delete-card.js';

const onDeleted = vi.fn();

function renderCard(overrides: { enrollmentCount?: number; currentRunTitle?: string | null } = {}) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<WorkerDeleteCard
				workerId="worker-1"
				workerName="ada-laptop"
				enrollmentCount={overrides.enrollmentCount ?? 1}
				currentRunTitle={overrides.currentRunTitle ?? null}
				onDeleted={onDeleted}
			/>
		</QueryClientProvider>,
	);
}

/** The modal's copy of the action, which shares its name with the entry point. */
function confirmButton(): HTMLElement {
	const buttons = screen.getAllByRole('button', { name: 'Delete worker' });
	return buttons[buttons.length - 1];
}

beforeEach(() => {
	removeMutate.mockReset();
	removeMutate.mockResolvedValue({ workerId: 'worker-1' });
	onDeleted.mockReset();
});

describe('WorkerDeleteCard (issue #789)', () => {
	it('does not delete on the first click — the confirmation comes first', () => {
		renderCard();

		fireEvent.click(screen.getByRole('button', { name: 'Delete worker' }));

		expect(screen.getByRole('heading', { name: 'Delete this worker?' })).toBeDefined();
		expect(removeMutate).not.toHaveBeenCalled();
	});

	it('deletes on confirmation and reports it to the caller', async () => {
		renderCard();

		fireEvent.click(screen.getByRole('button', { name: 'Delete worker' }));
		fireEvent.click(confirmButton());

		await waitFor(() => expect(removeMutate).toHaveBeenCalledWith({ workerId: 'worker-1' }));
		await waitFor(() => expect(onDeleted).toHaveBeenCalled());
	});

	it('cancelling closes the confirmation without mutating', () => {
		renderCard();

		fireEvent.click(screen.getByRole('button', { name: 'Delete worker' }));
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('heading', { name: 'Delete this worker?' })).toBeNull();
		expect(removeMutate).not.toHaveBeenCalled();
	});

	// The non-binding ask on the issue: an owner should not be surprised by what
	// disappears with the machine, so the confirmation names each cascade.
	it('names the machine and what goes with it — enrollments, the credential, the session', () => {
		renderCard({ enrollmentCount: 2 });

		fireEvent.click(screen.getByRole('button', { name: 'Delete worker' }));

		expect(screen.getByText(/ada-laptop/)).toBeDefined();
		expect(screen.getByText(/2 project enrollments/)).toBeDefined();
		expect(screen.getByText(/operator source-control credential/)).toBeDefined();
		expect(screen.getByText(/cannot reconnect/)).toBeDefined();
		// And what survives, so history isn't assumed lost too.
		expect(screen.getByText(/stay in run history/)).toBeDefined();
	});

	it('warns when the machine is mid-run, naming the job', () => {
		renderCard({ currentRunTitle: 'Fix the flaky test' });

		fireEvent.click(screen.getByRole('button', { name: 'Delete worker' }));

		expect(screen.getByText(/Fix the flaky test/)).toBeDefined();
	});

	it('shows the server’s refusal verbatim, leaving the confirmation open', async () => {
		removeMutate.mockRejectedValue(
			new Error('This worker is running a job right now. Wait for it to finish.'),
		);
		renderCard();

		fireEvent.click(screen.getByRole('button', { name: 'Delete worker' }));
		fireEvent.click(confirmButton());

		expect(
			await screen.findByText('This worker is running a job right now. Wait for it to finish.'),
		).toBeDefined();
		expect(screen.getByRole('heading', { name: 'Delete this worker?' })).toBeDefined();
		expect(onDeleted).not.toHaveBeenCalled();
	});
});
