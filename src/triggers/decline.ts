/**
 * A handler's own reason for not running a phase (issue #1248) — the `skipped`
 * {@link TriggerDecline}.
 *
 * Every skip path a retry can reach notes one, so a run that "Retry now", `run
 * reset` or a continuation re-evaluated into a skip records what actually stopped
 * it — "pull request #3472 is closed" — rather than the settle's generic guess at
 * a changed disposition. The note is read only for a run a continuation carries
 * (`settleUnmatchedNoTriggerDelivery`, `src/worker/consumer.ts`), so the ordinary
 * webhook delivery that matches nothing stays exactly as quiet as before; the
 * handler's own log line keeps the level it had.
 */

import type { TriggerContext, TriggerDecline } from './types.js';

export function noteSkip(ctx: TriggerContext, reason: string): void {
	const decline: TriggerDecline = { kind: 'skipped', reason };
	ctx.noteDecline?.(decline);
}
