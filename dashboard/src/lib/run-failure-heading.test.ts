import { describe, expect, it } from 'vitest';
import { pipelineFailureHeading } from './run-failure-heading.js';

const AUTH_ERROR =
	"Implementation agent (claude) exited with code 1 (Claude requires authentication: run `claude auth login` on the worker host, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs) for task '892'";
const PLAIN = { cancellation: null, timedOut: false };

describe('pipelineFailureHeading (issue #1478)', () => {
	it('heads a Claude auth failure with its cause', () => {
		expect(pipelineFailureHeading(PLAIN, AUTH_ERROR)).toBe('Claude requires authentication');
	});

	it('keeps the default for an error that only mentions authentication', () => {
		expect(
			pipelineFailureHeading(
				PLAIN,
				'Review agent (claude) exited with code 1 for PR #9: Claude requires authentication to the registry',
			),
		).toBe('Run Failure Error');
		expect(
			pipelineFailureHeading(
				PLAIN,
				'Review agent (codex) exited with code 1 (authentication failed)',
			),
		).toBe('Run Failure Error');
	});

	it('ranks cancellation, then timeout, ahead of the auth heading', () => {
		expect(
			pipelineFailureHeading(
				{
					cancellation: { source: 'dashboard', requestedAt: '2026-11-24T07:27:00Z' },
					timedOut: true,
				},
				AUTH_ERROR,
			),
		).toBe('Run Cancelled');
		expect(pipelineFailureHeading({ cancellation: null, timedOut: true }, AUTH_ERROR)).toBe(
			'Run Timed Out',
		);
	});
});
