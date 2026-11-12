// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BUG_REPORT_STATUSES } from '../../../../src/api/bug-reports.js';
import { BugReportStatusBadge } from './bug-report-status-badge.js';

describe('BugReportStatusBadge', () => {
	it.each(BUG_REPORT_STATUSES)('labels %s and explains it on hover', (status) => {
		render(<BugReportStatusBadge status={status} data-testid="badge" />);

		const badge = screen.getByTestId('badge');
		expect(badge.textContent?.toLowerCase()).toBe(status);
		expect(badge.getAttribute('title')).toBeTruthy();
	});

	it('mutes environmental and says it is potentially not actionable', () => {
		render(<BugReportStatusBadge status="environmental" data-testid="badge" />);

		const badge = screen.getByTestId('badge');
		expect(badge.getAttribute('title')).toContain('potentially not actionable');
		expect(badge.className).toContain('text-zinc-500');
	});

	it('renders a status this build does not know as itself', () => {
		render(<BugReportStatusBadge status="triaged" data-testid="badge" />);

		expect(screen.getByTestId('badge').textContent).toBe('triaged');
	});
});
