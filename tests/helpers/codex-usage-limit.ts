/**
 * The Codex account-quota transcript captured live from run
 * `e5c74d0d-de8b-4b74-8f15-dafe09a02882` (issue #963), shared by the three
 * suites that pin the path it travels: the decoder that lifts it out of the
 * JSONL (`usage.test.ts`), the harness that carries it on the result
 * (`agent-cli.test.ts`), and the classifier that must read it as a rate limit
 * (`agent-failure.test.ts`).
 *
 * The banner and the agent messages are *derived from* the fixture rather than
 * re-typed beside it, so no suite can drift from the captured bytes — an
 * invented Codex shape is exactly what `ai/RULES.md` §6 forbids.
 */

import { readFileSync } from 'node:fs';

/** The raw `codex exec --json` stdout of the failing turn, verbatim. */
export const CODEX_USAGE_LIMIT_TRANSCRIPT = readFileSync(
	new URL('../fixtures/agent-failure/codex-usage-limit-transcript.txt', import.meta.url),
	'utf8',
);

const lines = CODEX_USAGE_LIMIT_TRANSCRIPT.trim().split('\n');

function event(index: number): Record<string, unknown> {
	return JSON.parse(lines[index] as string) as Record<string, unknown>;
}

/** The transcript's individual lines, in emission order. */
export const CODEX_USAGE_LIMIT_LINES = lines;

/** The `{"type":"error","message":"…"}` line Codex emitted when quota ran out. */
export const CODEX_USAGE_LIMIT_ERROR_LINE = lines[2] as string;

/** The `{"type":"turn.failed",…}` line that followed it. */
export const CODEX_USAGE_LIMIT_TURN_FAILED_LINE = lines[3] as string;

/** Codex's own banner text, as both terminal events carried it. */
export const CODEX_USAGE_LIMIT_MESSAGE = event(2).message as string;

/**
 * What `parseCodexOutput` keeps as the run's log: the two `agent_message` items
 * that preceded the failure, and the entire window classification used to see.
 */
export const CODEX_USAGE_LIMIT_LOG_TEXT = [0, 1]
	.map((index) => (event(index).item as Record<string, unknown>).text as string)
	.join('\n');
