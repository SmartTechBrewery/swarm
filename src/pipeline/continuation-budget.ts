/**
 * The checkpoint-continuation budget's coded default, on its own so the dashboard
 * can import it (issue #1259): `./checkpoint.ts` reads the worktree through
 * `node:child_process`, which a browser bundle cannot load, and the Pipeline tab
 * must show the same default the worker applies rather than re-declaring it.
 */

/**
 * The hard ceiling on one run's checkpoint continuations, by default. It bounds a
 * run whose checkpoint keeps advancing — which the no-progress limit
 * (`DEFAULT_MAX_CONTINUATIONS_WITHOUT_PROGRESS`, `./checkpoint.ts`) never ends —
 * so a phase too large for its budget is still surfaced to a human eventually
 * rather than handed off indefinitely. Six matches `MAX_RATE_LIMIT_RETRIES` and
 * leaves room for a large task that progresses on every stop (issue #1256).
 */
export const DEFAULT_MAX_CONTINUATIONS = 6;
