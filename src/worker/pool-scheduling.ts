/**
 * **Pool-aware worker assignment** (issue #533) — the tie-break the dispatch gate
 * applies once more than one worker could take the same phase.
 *
 * The gate judges one dispatch at a time (`./eligibility-gate.ts`), and until now
 * it took the *first* eligible worker in the deterministic enrollment order. With
 * the control-plane consumer processing several dispatches concurrently (PR #526)
 * that greedy pick can spend a scarce capability another runnable phase uniquely
 * needs: a Review eligible on workers A and B takes A, and a Planning eligible
 * only on A then has nowhere to run even though B is idle and the project has a
 * spare slot.
 *
 * This module models the whole picture instead — the project's runnable dispatches
 * against the pool's free worker slots — and computes a **maximum bipartite
 * matching**, so no assignment consumes a worker another runnable dispatch needs
 * more when an alternative exists. Demands are served in scheduling order (the
 * queue's own priority → availability → creation ordering), and the augmenting-path
 * search re-homes an already-placed demand rather than dropping it, so a
 * higher-ranked demand never loses its slot to a later one: the matching is
 * maximum *and* rank-respecting.
 *
 * **It only ever chooses between workers — it never withholds work.** Callers use
 * {@link selectPooledWorker} and fall back to their own first-eligible pick when
 * the matching leaves them unassigned, which is the property that keeps this policy
 * free of new starvation risk: a dispatch that could run still runs on some
 * eligible worker this instant, because the contending demand the matching preferred
 * may be a dispatch whose own wake-up has not fired yet. Ageing and priority stay
 * exactly where they already live — the dispatch row's `priority`/`availableAt`
 * ordering the caller ranks by — rather than being re-invented here.
 *
 * Pure and dependency-light, in the shape of `src/identity/worker-eligibility.ts`
 * and `src/pm/dependencies.ts`: eligibility, capacity, and rank are resolved by the
 * caller and passed in, so the policy holds no I/O and is deterministic — the same
 * input always yields the same assignment.
 *
 * **Determinism is not agreement between concurrent gates, and this does not need
 * it to be.** Each gate substitutes its *own* affinity-narrowed eligible set for
 * itself while reconstructing every contender as a superset, so two gates running
 * against the same database snapshot are not solving the same instance and can pick
 * the same worker: with slots on A and B, a higher-ranked D1 truly confined to B
 * (its superset says `A,B`) and a D2 eligible on both, the gate judging D1 takes B
 * and the gate judging D2 also takes B. What makes that harmless is the *next* two
 * properties rather than agreement — the atomic claim
 * (`claimWorkerForDispatch`) remains the only authority on capacity, and this is a
 * read-side preference that never withholds work, so a collision costs at most the
 * one deferral a raced claim costs today.
 */

/** One runnable dispatch's demand on the pool: what it is, and what could serve it. */
export interface PoolDemand {
	/** The durable dispatch row this demand belongs to (`dispatches.id`). */
	dispatchId: string;
	/**
	 * Every worker that may take it *right now*, in the gate's deterministic order —
	 * already judged against enrollment, consent, connectivity, capacity, phase, and
	 * CLI. An empty list is a demand nothing can serve; it constrains nothing.
	 */
	eligibleWorkerIds: readonly string[];
}

/** Everything {@link assignWorkerPool} matches over. */
export interface PoolAssignmentInput {
	/**
	 * The runnable demands in **scheduling order** — first served first. The caller
	 * ranks them (the queue's `priority` → `availableAt` → `createdAt` ordering), so
	 * this module never re-invents priority or ageing.
	 */
	demands: readonly PoolDemand[];
	/**
	 * Free execution slots per worker id. A worker absent from the map, or mapped to
	 * a non-positive count, can hold nothing — so a busy or disconnected worker
	 * simply never appears in an assignment.
	 */
	freeSlots: ReadonlyMap<string, number>;
}

/**
 * Match runnable demands onto free worker slots, maximizing how many demands can
 * start. Returns `dispatchId → workerId` for the demands that got a slot; a demand
 * absent from the map could not be placed without unplacing a higher-ranked one.
 *
 * Kuhn's augmenting-path search, extended to multi-slot workers (a worker enrolled
 * with `concurrencyAllocation: 2` and one run in flight offers one slot). Demands
 * are placed in the order given and never dropped once placed — a later demand may
 * only *re-home* an earlier one onto another worker it is equally eligible for.
 */
export function assignWorkerPool(input: PoolAssignmentInput): Map<string, string> {
	/** dispatchId → workerId, the matching built so far. */
	const assigned = new Map<string, string>();
	/** workerId → the dispatches currently holding its slots, in placement order. */
	const holders = new Map<string, string[]>();
	const byId = new Map(input.demands.map((demand) => [demand.dispatchId, demand]));

	const heldBy = (workerId: string): string[] => holders.get(workerId) ?? [];

	/** Record the placement, evicting whoever this demand displaced from that worker. */
	function occupy(workerId: string, dispatchId: string, displaced?: string): void {
		holders.set(workerId, [...heldBy(workerId).filter((held) => held !== displaced), dispatchId]);
		assigned.set(dispatchId, workerId);
	}

	/**
	 * A worker with a genuinely free slot, in the caller's deterministic order. Tried
	 * before any re-homing so a placement never disturbs an incumbent it did not have
	 * to: the earlier demand keeps the worker it would have picked on its own.
	 */
	function freeWorkerFor(demand: PoolDemand, visited: Set<string>): string | undefined {
		return demand.eligibleWorkerIds.find((workerId) => {
			const slots = input.freeSlots.get(workerId) ?? 0;
			return !visited.has(workerId) && slots > 0 && heldBy(workerId).length < slots;
		});
	}

	/**
	 * Free a slot for this demand by moving one incumbent onto another worker it is
	 * also eligible for — the augmenting step. An incumbent that cannot move keeps its
	 * slot, so an earlier demand is never displaced into nothing.
	 */
	function rehomeFor(
		demand: PoolDemand,
		visited: Set<string>,
	): { workerId: string; displaced: string } | undefined {
		for (const workerId of demand.eligibleWorkerIds) {
			if (visited.has(workerId)) continue;
			// Marked before recursing: this is what terminates the search, and what stops
			// an incumbent from reclaiming a worker upstream of it on the same path.
			visited.add(workerId);
			if ((input.freeSlots.get(workerId) ?? 0) <= 0) continue;
			const displaced = heldBy(workerId).find((incumbent) => place(incumbent, visited));
			if (displaced) return { workerId, displaced };
		}
		return undefined;
	}

	/** Place one demand, re-homing incumbents as needed. */
	function place(dispatchId: string, visited: Set<string>): boolean {
		const demand = byId.get(dispatchId);
		if (!demand) return false;
		const free = freeWorkerFor(demand, visited);
		if (free) {
			occupy(free, dispatchId);
			return true;
		}
		const rehomed = rehomeFor(demand, visited);
		if (!rehomed) return false;
		occupy(rehomed.workerId, dispatchId, rehomed.displaced);
		return true;
	}

	for (const demand of input.demands) {
		if (demand.eligibleWorkerIds.length === 0) continue;
		place(demand.dispatchId, new Set<string>());
	}
	return assigned;
}

/**
 * The worker the pool would give this dispatch, or `undefined` when the matching
 * placed a higher-ranked demand on every worker it could use.
 *
 * `undefined` is a *preference*, never a refusal: the caller keeps its own
 * first-eligible pick, because the demand that won the slot may be a dispatch whose
 * wake-up has not fired yet, and idling a free worker on the strength of that would
 * trade a real run for a speculative one.
 */
export function selectPooledWorker(
	input: PoolAssignmentInput,
	dispatchId: string,
): string | undefined {
	return assignWorkerPool(input).get(dispatchId);
}
