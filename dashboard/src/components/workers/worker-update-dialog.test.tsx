// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerUpdateReport, WorkerUpdateReportEntry } from '@/types/workers.js';
import { WorkerUpdateDialog } from './worker-update-dialog.js';

const requestUpdate = vi.fn();
const onClose = vi.fn();

const COMMIT = 'abc1234def5678901234567890123456789abcde';

function entry(overrides: Partial<WorkerUpdateReportEntry> = {}): WorkerUpdateReportEntry {
	return {
		workerId: 'worker-1',
		displayName: 'ada-laptop',
		disposition: 'requested',
		owner: { userId: 'u1', identifier: 'ada@example.com', displayName: 'Ada Lovelace' },
		update: null,
		...overrides,
	};
}

function report(workers: WorkerUpdateReportEntry[]): WorkerUpdateReport {
	return { target: COMMIT, requestedBy: 'ada@example.com', workers };
}

function renderDialog(): ReturnType<typeof render> {
	const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<WorkerUpdateDialog
				open
				onClose={onClose}
				title="Update every worker on this installation?"
				confirmCopy="every registered machine on this installation"
				target={COMMIT}
				requestUpdate={requestUpdate}
			/>
		</QueryClientProvider>,
	);
}

/** The modal's affirmative action — deliberately not the button that opened it. */
const confirmButton = () => screen.getByRole('button', { name: 'Ask them to update' });

beforeEach(() => {
	requestUpdate.mockReset();
	onClose.mockReset();
});

describe('WorkerUpdateDialog confirmation (issue #1009)', () => {
	it('names the build and the set before anything is asked', () => {
		renderDialog();

		expect(screen.getByText(/every registered machine on this installation/)).toBeDefined();
		// Abbreviated the way every other Workers surface abbreviates a commit.
		expect(screen.getByText('abc1234')).toBeDefined();
		expect(requestUpdate).not.toHaveBeenCalled();
	});

	it('states that only already-drained machines are asked', () => {
		renderDialog();

		expect(screen.getByText(/already drained/)).toBeDefined();
	});

	it('makes no call at all when the operator cancels', () => {
		renderDialog();

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(requestUpdate).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it('asks exactly once when the operator confirms', async () => {
		requestUpdate.mockResolvedValue(report([entry()]));
		renderDialog();

		fireEvent.click(confirmButton());

		// The report's own heading, not the `Requested` badge one machine earns.
		expect(await screen.findByText(/machine, as ada@example\.com/)).toBeDefined();
		expect(requestUpdate).toHaveBeenCalledTimes(1);
	});
});

describe('WorkerUpdateDialog report (issue #1009)', () => {
	it('lists every machine with its owner and its disposition', async () => {
		requestUpdate.mockResolvedValue(
			report([
				entry(),
				entry({
					workerId: 'worker-2',
					displayName: 'grace-box',
					disposition: 'queued-offline',
					owner: { userId: 'u2', identifier: 'grace@example.com', displayName: 'Grace Hopper' },
				}),
			]),
		);
		renderDialog();

		fireEvent.click(confirmButton());

		expect(await screen.findByText('ada-laptop')).toBeDefined();
		expect(screen.getByText('ada@example.com')).toBeDefined();
		expect(screen.getByText('Requested')).toBeDefined();
		expect(screen.getByText('grace-box')).toBeDefined();
		expect(screen.getByText('grace@example.com')).toBeDefined();
		expect(screen.getByText('Queued')).toBeDefined();
	});

	// The owner is what the grouped remedy lines send the operator to, so a machine
	// whose owner the server could not resolve says so rather than reading as nobody's.
	it('names an unresolved owner as unknown', async () => {
		requestUpdate.mockResolvedValue(report([entry({ owner: null })]));
		renderDialog();

		fireEvent.click(confirmButton());

		expect(await screen.findByText('owner unknown')).toBeDefined();
	});

	it('gives each refusal its own remedy line, naming the owners to ask', async () => {
		requestUpdate.mockResolvedValue(
			report([
				entry({ disposition: 'in-pool' }),
				entry({
					workerId: 'worker-2',
					displayName: 'grace-box',
					disposition: 'no-project',
					owner: { userId: 'u2', identifier: 'grace@example.com', displayName: 'Grace Hopper' },
				}),
				entry({ workerId: 'worker-3', displayName: 'turing-mini', disposition: 'unsupervised' }),
			]),
		);
		renderDialog();

		fireEvent.click(confirmButton());

		// `in-pool` and `no-project` reach the operator who pressed the button rather
		// than only a log, which is the whole reason the lines are rendered here.
		expect(await screen.findByText(/still in the dispatch pool/)).toBeDefined();
		expect(screen.getByText('swarm workers drain <worker-id>')).toBeDefined();
		const noProject = screen.getByText(/enrolled in no project/);
		expect(screen.getByText('swarm workers enroll <worker-id> <project-id>')).toBeDefined();
		expect(screen.getByText(/not under a process supervisor/)).toBeDefined();
		expect(screen.getByText('swarm-worker-agent install')).toBeDefined();
		// The person to go and ask, on the line that says what to ask them for.
		expect(noProject.textContent).toContain('grace@example.com');
	});

	it('offers no remedy line when every machine was asked', async () => {
		requestUpdate.mockResolvedValue(report([entry(), entry({ workerId: 'worker-2' })]));
		renderDialog();

		fireEvent.click(confirmButton());

		await screen.findByText(/machines, as ada@example\.com/);
		expect(screen.queryByText(/still in the dispatch pool/)).toBeNull();
	});

	// A newer control plane may report a word this build has never heard of, and a
	// machine missing from the report would read as a machine nobody asked.
	it('still lists a machine whose disposition this build does not know', async () => {
		requestUpdate.mockResolvedValue(report([entry({ disposition: 'rescheduled' })]));
		renderDialog();

		fireEvent.click(confirmButton());

		expect(await screen.findByText('ada-laptop')).toBeDefined();
		expect(screen.getByText('rescheduled')).toBeDefined();
	});

	it('answers an empty set honestly rather than with an empty list', async () => {
		requestUpdate.mockResolvedValue(report([]));
		renderDialog();

		fireEvent.click(confirmButton());

		expect(await screen.findByText(/No machines to ask/)).toBeDefined();
	});

	it('leaves only a Close once the report is in', async () => {
		requestUpdate.mockResolvedValue(report([entry()]));
		renderDialog();

		fireEvent.click(confirmButton());

		expect(await screen.findByRole('button', { name: 'Close' })).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Ask them to update' })).toBeNull();
	});
});

describe('WorkerUpdateDialog refusals (issue #1009)', () => {
	it('renders the server’s refusal verbatim and keeps the modal open', async () => {
		const forbidden =
			'Requesting an update across the installation is available to instance ' +
			'administrators only. Run `swarm workers update --all abc1234` to move the machines you own.';
		requestUpdate.mockRejectedValue(new Error(forbidden));
		renderDialog();

		fireEvent.click(confirmButton());

		expect(await screen.findByText(forbidden)).toBeDefined();
		// Still confirmable — the refusal names a remedy, and nothing was asked.
		expect(confirmButton()).toBeDefined();
	});
});
