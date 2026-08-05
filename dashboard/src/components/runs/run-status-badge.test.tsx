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
