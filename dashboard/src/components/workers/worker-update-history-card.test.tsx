// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerUpdateHistoryEntry } from '@/types/workers.js';
import { WorkerUpdateHistoryCard } from './worker-update-history-card.js';

const NOW = new Date('2026-07-01T12:00:00.000Z');

function makeEntry(overrides: Partial<WorkerUpdateHistoryEntry> = {}): WorkerUpdateHistoryEntry {
	return {
		runId: 'run-1',
		projectId: 'proj-a',
		target: 'main',
		status: 'completed',
		startedAt: '2026-07-01T09:00:00.000Z',
		completedAt: '2026-07-01T09:00:30.000Z',
		durationMs: 30_000,
		error: null,
		...overrides,
	};
}

beforeEach(() => {
	// Fake only `Date`, so `formatRelativeTime`'s "now" is fixed while timers stay real.
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('WorkerUpdateHistoryCard (issue #977)', () => {
	it('says a machine has never been asked, rather than showing an empty list', () => {
		render(<WorkerUpdateHistoryCard entries={[]} />);

		expect(screen.getByText('This machine has never been asked to update.')).toBeTruthy();
		expect(screen.queryByRole('link')).toBeNull();
	});

	it('names the build a completed request moved to and links to its run', () => {
		render(<WorkerUpdateHistoryCard entries={[makeEntry({ target: 'v2.1.0' })]} />);

		const link = screen.getByRole('link', { name: 'v2.1.0' });
		expect(link.getAttribute('href')).toBe('/runs/run-1');
		expect(screen.getByText('Completed')).toBeTruthy();
		expect(screen.getByText(/Asked 3h ago/)).toBeTruthy();
		expect(screen.getByText(/took 30s/)).toBeTruthy();
	});

	it('shows the machine’s own reason for a failed request', () => {
		render(
			<WorkerUpdateHistoryCard
				entries={[
					makeEntry({
						status: 'failed',
						error: 'The install root is dirty; the checkout was left on v2.0.0.',
					}),
				]}
			/>,
		);

		expect(screen.getByText('Failed')).toBeTruthy();
		expect(
			screen.getByText('The install root is dirty; the checkout was left on v2.0.0.'),
		).toBeTruthy();
	});

	// A request still in flight reads as in progress through the shared badge — never
	// an "Updating" word invented for this surface (that is phase 3's, elsewhere).
	it('reads a request still in flight as running, with no duration yet', () => {
		render(
			<WorkerUpdateHistoryCard
				entries={[makeEntry({ status: 'running', completedAt: null, durationMs: null })]}
			/>,
		);

		expect(screen.getByText('Running')).toBeTruthy();
		expect(screen.queryByText(/took/)).toBeNull();
	});

	it('keeps each entry naming its own build, newest first as it was handed them', () => {
		render(
			<WorkerUpdateHistoryCard
				entries={[
					makeEntry({ runId: 'run-2', target: 'v2' }),
					makeEntry({ runId: 'run-1', target: 'v1' }),
				]}
			/>,
		);

		const entries = screen.getAllByRole('listitem');
		expect(entries).toHaveLength(2);
		expect(within(entries[0]).getByRole('link').getAttribute('href')).toBe('/runs/run-2');
		expect(within(entries[0]).getByRole('link').textContent).toBe('v2');
		expect(within(entries[1]).getByRole('link').textContent).toBe('v1');
	});
});
