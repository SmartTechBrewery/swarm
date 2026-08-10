// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunStatusBadge } from './run-status-badge.js';

describe('RunStatusBadge', () => {
	describe('completed Review runs show the submitted verdict (issue #218)', () => {
		it('renders an approval as a green "Approved" badge', () => {
			render(<RunStatusBadge status="completed" phase="review" reviewVerdict="approve" />);
			const badge = screen.getByText('Approved');
			expect(badge.className).toContain('text-emerald-400');
			expect(screen.queryByText('Completed')).toBeNull();
		});

		it('renders a changes-requested verdict as an amber "Changes requested" badge', () => {
			render(<RunStatusBadge status="completed" phase="review" reviewVerdict="request-changes" />);
			const badge = screen.getByText('Changes requested');
			expect(badge.className).toContain('text-amber-400');
		});

		it('renders a comment verdict as a distinct violet "Commented" badge', () => {
			render(<RunStatusBadge status="completed" phase="review" reviewVerdict="comment" />);
			const badge = screen.getByText('Commented');
			expect(badge.className).toContain('text-violet-400');
		});

		it('falls back to a violet, humanized label for an unknown verdict', () => {
			render(<RunStatusBadge status="completed" phase="review" reviewVerdict="needs-info" />);
			const badge = screen.getByText('Needs info');
			expect(badge.className).toContain('text-violet-400');
		});
	});

	describe('review-cap manual intervention (issue #242)', () => {
		it('renders a distinct "Manual action required" badge for the cap-stopping second changes-requested verdict', () => {
			render(
				<RunStatusBadge
					status="completed"
					phase="review"
					reviewVerdict="request-changes"
					reviewAutomationOutcome="manual-intervention-required"
				/>,
			);
			const badge = screen.getByText('Manual action required');
			expect(badge.className).toContain('text-red-400');
			expect(screen.queryByText('Changes requested')).toBeNull();
		});

		it('retains the underlying request-changes context in the title', () => {
			render(
				<RunStatusBadge
					status="completed"
					phase="review"
					reviewVerdict="request-changes"
					reviewAutomationOutcome="manual-intervention-required"
				/>,
			);
			const badge = screen.getByText('Manual action required');
			expect(badge.getAttribute('title')).toMatch(/changes-requested/i);
		});

		it('shows the ordinary "Changes requested" badge for a first changes-requested verdict (no cap outcome)', () => {
			render(<RunStatusBadge status="completed" phase="review" reviewVerdict="request-changes" />);
			const badge = screen.getByText('Changes requested');
			expect(badge.className).toContain('text-amber-400');
		});

		it('ignores the cap outcome for an approval verdict', () => {
			render(
				<RunStatusBadge
					status="completed"
					phase="review"
					reviewVerdict="approve"
					reviewAutomationOutcome="manual-intervention-required"
				/>,
			);
			expect(screen.getByText('Approved')).not.toBeNull();
			expect(screen.queryByText('Manual action required')).toBeNull();
		});
	});

	describe('checkpointed runs read distinctly from deferred (issues #503, #504)', () => {
		it('renders a "Checkpointed" badge in its own hue, not the amber Deferred one', () => {
			render(<RunStatusBadge status="checkpointed" phase="implementation" />);
			const badge = screen.getByText('Checkpointed');
			expect(badge.className).toContain('text-sky-400');
			expect(badge.className).not.toContain('amber');
			expect(screen.queryByText('Deferred')).toBeNull();
		});

		it('says in its title that it waits on a continuation rather than on quota', () => {
			render(<RunStatusBadge status="checkpointed" phase="implementation" />);
			const title = screen.getByText('Checkpointed').getAttribute('title') ?? '';
			expect(title).toMatch(/continued/i);
			expect(title).toMatch(/not waiting on quota/i);
		});

		it('does not pulse — no live agent is running', () => {
			const { container } = render(<RunStatusBadge status="checkpointed" />);
			expect(container.querySelector('.animate-pulse')).toBeNull();
		});
	});

	describe('a resumable wall-clock kill reads as a timeout (issue #600)', () => {
		it('names the timeout on a deferred run while keeping the amber deferred hue', () => {
			render(<RunStatusBadge status="deferred" phase="implementation" timedOut />);
			const badge = screen.getByText('Timed out · retrying');
			expect(badge.className).toContain('text-amber-400');
			expect(screen.queryByText('Deferred')).toBeNull();
			// The terminal-failure orange stays reserved for the non-resumable kill.
			expect(badge.className).not.toContain('orange');
		});

		it('names the timeout on a checkpointed run while keeping the sky checkpointed hue', () => {
			render(<RunStatusBadge status="checkpointed" phase="implementation" timedOut />);
			const badge = screen.getByText('Timed out · checkpointed');
			expect(badge.className).toContain('text-sky-400');
			expect(screen.queryByText('Checkpointed')).toBeNull();
			expect(badge.className).not.toContain('orange');
		});

		it('keeps the retry state readable in the title of each', () => {
			const { rerender } = render(<RunStatusBadge status="deferred" timedOut />);
			const deferredTitle = screen.getByText('Timed out · retrying').getAttribute('title') ?? '';
			expect(deferredTitle).toMatch(/wall-clock timeout/i);
			expect(deferredTitle).toMatch(/retry/i);

			rerender(<RunStatusBadge status="checkpointed" timedOut />);
			const checkpointedTitle =
				screen.getByText('Timed out · checkpointed').getAttribute('title') ?? '';
			expect(checkpointedTitle).toMatch(/wall-clock timeout/i);
			expect(checkpointedTitle).toMatch(/checkpoint/i);
		});

		it('leaves a deferred or checkpointed run that did not time out unchanged', () => {
			const { rerender } = render(<RunStatusBadge status="deferred" phase="implementation" />);
			expect(screen.getByText('Deferred').className).toContain('text-amber-400');
			expect(screen.queryByText(/Timed out/)).toBeNull();

			rerender(<RunStatusBadge status="checkpointed" phase="implementation" />);
			expect(screen.getByText('Checkpointed').className).toContain('text-sky-400');
			expect(screen.queryByText(/Timed out/)).toBeNull();
		});

		it('leaves the terminal timed-out failure badge unchanged', () => {
			render(<RunStatusBadge status="failed" phase="implementation" timedOut />);
			const badge = screen.getByText('Timed out');
			expect(badge.className).toContain('text-orange-400');
		});

		it('does not divert a completed Review run away from its verdict badge', () => {
			render(<RunStatusBadge status="completed" phase="review" timedOut reviewVerdict="approve" />);
			expect(screen.getByText('Approved')).not.toBeNull();
			expect(screen.queryByText(/Timed out/)).toBeNull();
		});
	});

	describe('lifecycle status is kept where a verdict must not show', () => {
		it('shows "Completed" for a completed non-Review run even if a verdict slipped through', () => {
			render(<RunStatusBadge status="completed" phase="implementation" reviewVerdict="approve" />);
			expect(screen.getByText('Completed')).not.toBeNull();
			expect(screen.queryByText('Approved')).toBeNull();
		});

		it('shows "Completed" for a completed Review run that has no verdict (older rows)', () => {
			render(<RunStatusBadge status="completed" phase="review" reviewVerdict={null} />);
			expect(screen.getByText('Completed')).not.toBeNull();
		});

		it('shows lifecycle "Failed", not a stale verdict, for a failed Review run', () => {
			render(<RunStatusBadge status="failed" phase="review" reviewVerdict="approve" />);
			expect(screen.getByText('Failed')).not.toBeNull();
			expect(screen.queryByText('Approved')).toBeNull();
		});

		it('shows lifecycle status for running and deferred Review runs', () => {
			const { rerender } = render(<RunStatusBadge status="running" phase="review" />);
			expect(screen.getByText('Running')).not.toBeNull();
			rerender(<RunStatusBadge status="deferred" phase="review" />);
			expect(screen.getByText('Deferred')).not.toBeNull();
		});

		it('still renders "Timed out" for a timed-out failure regardless of phase (issue #165)', () => {
			render(<RunStatusBadge status="failed" phase="review" timedOut reviewVerdict="approve" />);
			expect(screen.getByText('Timed out')).not.toBeNull();
		});
	});
});
