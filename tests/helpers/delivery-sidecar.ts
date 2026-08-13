/**
 * Reading a phase's delivery-progress sidecar back off the worktree it ran in.
 *
 * `.swarm_delivery.json` (`PROGRESS_FILENAME`, `src/scm/delivery.ts`) is where every
 * delivery-owning phase records the identity it keyed its delivery under, and it is
 * the only place that identity is observable without re-deriving it — which is what
 * the cross-repository key assertions (issue #685) need: re-computing
 * `deliveryIdentity([...])` in the test would prove the hash function works, not
 * that the phase fed it the repository of the task at hand.
 *
 * Only usable from a suite running against real `node:fs`; the ones that mock it
 * intercept the write instead.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The sidecar's file name, as deterministic delivery writes it. */
export const DELIVERY_PROGRESS_FILENAME = '.swarm_delivery.json';

/** The delivery identity the phase that ran in `worktreePath` keyed its delivery under. */
export function readDeliveryId(worktreePath: string): string {
	const progress: unknown = JSON.parse(
		readFileSync(join(worktreePath, DELIVERY_PROGRESS_FILENAME), 'utf8'),
	);
	const deliveryId = (progress as { deliveryId?: unknown }).deliveryId;
	if (typeof deliveryId !== 'string') {
		throw new Error(`No deliveryId in ${DELIVERY_PROGRESS_FILENAME} under ${worktreePath}`);
	}
	return deliveryId;
}
