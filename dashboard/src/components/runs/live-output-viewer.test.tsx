// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	groupOutputByAttempt,
	type LiveOutputEvent,
	LiveOutputViewer,
} from './live-output-viewer.js';
import { type RunAttempt, RunAttemptsTimeline } from './run-attempts.js';

const event: LiveOutputEvent = {
	id: 1,
	stream: 'stdout',
	content: 'Working…',
	emittedAt: '2026-07-16T18:00:00.000Z',
};

const viewerProps = {
	isRunning: true,
	isLoading: false,
	retentionBytes: 10_000_000,
	serverTruncated: false,
	uiTruncated: false,
};

afterEach(() => vi.restoreAllMocks());

describe('LiveOutputViewer', () => {
	it('auto-scrolls only its fixed-height output box by default', () => {
		const scrollIntoView = vi.fn();
		Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
			configurable: true,
			value: scrollIntoView,
		});
		const scrollHeight = vi
			.spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
			.mockReturnValue(1_000);

		render(<LiveOutputViewer events={[event]} {...viewerProps} />);

		const output = screen.getByTestId('live-output-scrollbox');
		expect(output.className).toContain('overflow-auto');
		expect(output.parentElement?.className).toContain('h-[600px]');
		expect(output.scrollTop).toBe(1_000);
		expect(scrollIntoView).not.toHaveBeenCalled();
		scrollHeight.mockRestore();
	});

	it('labels the stream as agent activity, not raw stdout', () => {
		// Claude's protocol stream is decoded into readable progress before it is
		// stored (issue #356), so "raw stdout" would misdescribe what is shown.
		render(<LiveOutputViewer events={[event]} {...viewerProps} />);

		expect(screen.getByText(/Agent activity and CLI output/)).toBeDefined();
		expect(screen.getByText('Working…')).toBeDefined();
	});

	it('lets the user disable auto-scroll', () => {
		const { rerender } = render(<LiveOutputViewer events={[event]} {...viewerProps} />);
		const output = screen.getByTestId('live-output-scrollbox');

		const toggle = screen.getByLabelText('Disable auto-scroll');
		expect(toggle.querySelector('.lucide-play')).not.toBeNull();
		fireEvent.click(toggle);
		const disabledToggle = screen.getByLabelText('Enable auto-scroll');
		expect(disabledToggle.querySelector('.lucide-pause')).not.toBeNull();

		output.scrollTop = 123;
		rerender(<LiveOutputViewer events={[event, { ...event, id: 2 }]} {...viewerProps} />);
		expect(output.scrollTop).toBe(123);
	});
});

// Issue #1400: the run 667489fa shape — attempt 1 deferred for a Codex usage limit on
// one worker with all the output, attempt 2 failed preparing its checkout on another
// worker with none. The page must not show attempt 1's output under attempt 2.
const attempts: RunAttempt[] = [
	{
		id: 'attempt-1',
		seq: 1,
		trigger: 'automatic',
		requestedAt: null,
		workerId: 'w1',
		workerName: 'jacek_uc_platform',
		engine: 'codex',
		model: null,
		startedAt: '2026-11-09T06:56:00.000Z',
		endedAt: '2026-11-09T07:10:00.000Z',
		outcome: 'deferred',
		error: 'Codex usage limit reached',
		nextRetryAt: '2026-11-09T10:50:00.000Z',
		outputEventCount: 1,
		outputTruncated: false,
	},
	{
		id: 'attempt-2',
		seq: 2,
		trigger: 'reset',
		requestedAt: '2026-11-09T09:08:48.000Z',
		workerId: 'w2',
		workerName: 'karolina_uc_platform',
		engine: 'claude',
		model: null,
		startedAt: '2026-11-09T09:09:00.000Z',
		endedAt: '2026-11-09T09:10:00.000Z',
		outcome: 'failed',
		error: 'git worktree add failed: fatal: invalid reference: issue-2113',
		nextRetryAt: null,
		outputEventCount: 0,
		outputTruncated: false,
	},
];
const limitLine: LiveOutputEvent = {
	id: 7,
	attemptId: 'attempt-1',
	stream: 'stdout',
	content: '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}',
	emittedAt: '2026-11-09T07:10:00.000Z',
};

describe('LiveOutputViewer grouped by attempt (issue #1400)', () => {
	it('puts each line under the attempt that produced it and says when one produced none', () => {
		render(<LiveOutputViewer events={[limitLine]} {...viewerProps} attempts={attempts} />);

		const first = screen.getByTestId('output-group-attempt-1');
		expect(
			within(first).getByText(/Attempt 1 · jacek_uc_platform · codex · Deferred/),
		).toBeDefined();
		expect(within(first).getByText(/usage limit/)).toBeDefined();

		const second = screen.getByTestId('output-group-attempt-2');
		expect(
			within(second).getByText(/Attempt 2 · karolina_uc_platform · claude · Failed/),
		).toBeDefined();
		expect(within(second).queryByText(/usage limit/)).toBeNull();
		expect(
			within(second).getByText('No agent output was captured for this attempt.'),
		).toBeDefined();
	});

	it('keeps output recorded before attempts were tracked apart from every attempt', () => {
		const groups = groupOutputByAttempt([{ ...event, attemptId: null }, limitLine], attempts);

		expect(groups.map((group) => [group.key, group.events.length])).toEqual([
			['unattributed', 1],
			['attempt-1', 1],
			['attempt-2', 0],
		]);
	});
});

describe('RunAttemptsTimeline (issue #1400)', () => {
	it('shows each attempt with its worker, CLI, outcome and error, and the operator reset', () => {
		render(<RunAttemptsTimeline attempts={attempts} />);

		const first = screen.getByTestId('run-attempt-1');
		expect(within(first).getByText('Deferred')).toBeDefined();
		expect(within(first).getByText('jacek_uc_platform · codex')).toBeDefined();
		expect(within(first).getByText('Codex usage limit reached')).toBeDefined();
		expect(within(first).getByText(/retry was scheduled for/)).toBeDefined();
		expect(within(first).queryByText(/requested by an operator/)).toBeNull();

		const second = screen.getByTestId('run-attempt-2');
		expect(within(second).getByText('Failed')).toBeDefined();
		expect(within(second).getByText('Latest')).toBeDefined();
		expect(within(second).getByText('karolina_uc_platform · claude')).toBeDefined();
		expect(within(second).getByText(/invalid reference: issue-2113/)).toBeDefined();
		expect(within(second).getByText(/Reset & restart requested by an operator/)).toBeDefined();
		expect(
			within(second).getByText('No agent output was captured for this attempt.'),
		).toBeDefined();
	});

	it('renders nothing for a run with no recorded attempts', () => {
		const { container } = render(<RunAttemptsTimeline attempts={[]} />);
		expect(container.firstChild).toBeNull();
	});
});
