/**
 * The Antigravity account-quota run captured from
 * `8656fb88-9049-46a2-ab3b-f2ebfa393f2d` (issue #1013): `agy` hit a 429, retried
 * it internally, was cut by its own print timeout mid-retry, and exited **0**
 * carrying the quota verdict in its terminal `result` event.
 *
 * Shared by the two suites that pin the path it travels — the harness gate that
 * must stop such a run before any hand-off is read, and the classifier that must
 * read it as a `rate-limit` rather than as the timeout it also was. Every constant
 * is *derived from* the fixture rather than re-typed beside it, so no suite can
 * drift from the captured bytes.
 */

import { readFileSync } from 'node:fs';

/** The run's two captured output lines, verbatim — one per stream (see below). */
export const ANTIGRAVITY_QUOTA_TRANSCRIPT = readFileSync(
	new URL('../fixtures/agent-failure/antigravity-quota-transcript.txt', import.meta.url),
	'utf8',
);

const lines = ANTIGRAVITY_QUOTA_TRANSCRIPT.trim().split('\n');

/** agy's own print-timeout notice, which it writes on **stderr** while exiting 0. */
export const ANTIGRAVITY_QUOTA_SELF_TIMEOUT = lines[0] as string;

/**
 * What the run stored as its log: `parseAntigravityOutput` keeps the rendered
 * terminal error line alone for a failed run, so this single line is the whole
 * stdout the classifier's tail scan sees.
 */
export const ANTIGRAVITY_QUOTA_LOG_TEXT = lines[1] as string;

// The inverse of `formatAntigravityResultError` (`src/harness/antigravity-stream.ts`),
// which is what rendered the captured line: `<prefix> (<status>): <detail>`.
const rendered = /^Antigravity run failed \(([^)]+)\): (.+)$/.exec(ANTIGRAVITY_QUOTA_LOG_TEXT);

/** The `status` agy's terminal `result` event reported. */
export const ANTIGRAVITY_QUOTA_STATUS = rendered?.[1] as string;

/** The detail that event carried — the quota text plus agy's own reset instant. */
export const ANTIGRAVITY_QUOTA_MESSAGE = rendered?.[2] as string;

/** The structural verdict the harness carries on `AgentCliResult.antigravityFailure`. */
export const ANTIGRAVITY_QUOTA_FAILURE = {
	status: ANTIGRAVITY_QUOTA_STATUS,
	message: ANTIGRAVITY_QUOTA_MESSAGE,
};
