/**
 * The checkpoint-continuation budget's coded default, on its own so the dashboard
 * can import it (issue #1259): `./checkpoint.ts` reads the worktree through
 * `node:child_process`, which a browser bundle cannot load, and the Pipeline tab
 * must show the same default the worker applies rather than re-declaring it.
 */

/**
 * How many checkpoint continuations one run gets by default. Two is deliberately
 * small: each continuation pays for a fresh session seeded from a degraded
 * hand-off, so a phase that keeps stopping involuntarily is better surfaced to a
 * human than handed off indefinitely.
 */
export const DEFAULT_MAX_CONTINUATIONS = 2;
