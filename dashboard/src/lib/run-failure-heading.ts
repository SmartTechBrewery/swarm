/**
 * The heading of a run's red failure callout (`PipelineFailureCallout`). A
 * cancellation and a timeout are named from the run's own flags; a Claude run
 * that failed because the CLI is not authenticated (issue #1478) is named from
 * the marker `agentRunError` (`src/harness/agent-failure.ts`) splices into
 * `runs.error`, so the operator reads the cause rather than "Run Failure Error".
 * The match keys on that parenthesised marker, not on free prose, so an
 * unrelated error that merely mentions authentication keeps the default.
 */

import type { RunRow } from '@/types/runs.js';
import { CLAUDE_AUTH_REQUIRED } from '../../../src/harness/agent-failure.js';

export function pipelineFailureHeading(
	run: Pick<RunRow, 'cancellation' | 'timedOut'>,
	error: string,
): string {
	if (run.cancellation) return 'Run Cancelled';
	if (run.timedOut) return 'Run Timed Out';
	if (error.includes(`(${CLAUDE_AUTH_REQUIRED}:`)) return CLAUDE_AUTH_REQUIRED;
	return 'Run Failure Error';
}
