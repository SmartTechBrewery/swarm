// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRateLimit } from '@/types/workers.js';
import { WorkerRateLimitCard } from './worker-rate-limit-card.js';

const NOW = new Date('2026-07-01T12:00:00.000Z');

function limit(overrides: Partial<WorkerRateLimit> = {}): WorkerRateLimit {
	return {
		cli: 'claude',
		// Two hours out, so the expiry reads as a wait rather than as "shortly".
		expiresAt: new Date('2026-07-01T14:00:00.000Z').toISOString(),
		observedAt: new Date('2026-07-01T11:30:00.000Z').toISOString(),
		resetHint: null,
		...overrides,
	};
}

beforeEach(() => {
	// Fake only `Date`, as the sibling drain-card test does, so the relative/until
	// formatters have a fixed "now" while timers stay real.
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

// Issue #988. The card is the Workers screen's answer to "which machine is cooling
// on which CLI until when" — the fact the Queue's `worker-rate-limited` wait names
// only in aggregate.
describe('WorkerRateLimitCard', () => {
	it('renders one entry per cooling CLI and says the others are unaffected', () => {
		render(
			<WorkerRateLimitCard
				rateLimits={[
					limit({ cli: 'claude' }),
					limit({ cli: 'codex', expiresAt: new Date('2026-07-01T12:30:00.000Z').toISOString() }),
				]}
			/>,
		);

		// Each CLI names itself — a machine cooling on `claude` keeps taking `codex`
		// work, so a collapsed machine-wide mark would be a lie about the other CLIs.
		expect(screen.getByText('claude')).toBeDefined();
		expect(screen.getByText('codex')).toBeDefined();
		// And each says when it is expected back, independently: two cool-downs on one
		// machine lapse at their own instants.
		expect(screen.getByText('Expected back in ~2 h')).toBeDefined();
		expect(screen.getByText('Expected back in 30 min')).toBeDefined();
		expect(screen.getByText(/Every other CLI this machine declares is unaffected/)).toBeDefined();
	});

	// The copy must read as an automatic, self-clearing condition. There is no control
	// here and none anywhere else, so anything that reads as an action item sends an
	// operator looking for a switch that does not exist.
	it('offers no action and says the wait ends by itself', () => {
		render(<WorkerRateLimitCard rateLimits={[limit()]} />);

		expect(screen.queryByRole('button')).toBeNull();
		expect(screen.getByText(/nothing can be cleared by hand/)).toBeDefined();
	});

	// The CLI's own words beside the derived instant, never instead of it — a reset
	// text SWARM read differently than the operator does must stay visible.
	it("shows the CLI's verbatim reset text when it gave one, and omits the line when it did not", () => {
		const { unmount } = render(
			<WorkerRateLimitCard rateLimits={[limit({ resetHint: 'resets at 2pm' })]} />,
		);
		expect(screen.getByText('resets at 2pm')).toBeDefined();
		expect(screen.getByText('Expected back in ~2 h')).toBeDefined();
		unmount();

		render(<WorkerRateLimitCard rateLimits={[limit({ resetHint: null })]} />);
		expect(screen.queryByText(/Reported by the CLI/)).toBeNull();
	});

	// A machine with no live record renders nothing at all. The record releases itself
	// at its own expiry, so there is no "was rate-limited an hour ago" state to report
	// and an empty panel would be reporting a non-event.
	it('renders nothing for a machine cooling on nothing', () => {
		const { container } = render(<WorkerRateLimitCard rateLimits={[]} />);
		expect(container.innerHTML).toBe('');
	});
});
