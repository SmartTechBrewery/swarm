/**
 * Provider-agnostic dependency gate for the pipeline (issue #330).
 *
 * Given a {@link PMProvider} and a work item, returns the still-open prerequisites
 * that should defer the item's Implementation run — so a phase never starts while
 * a task it depends on is unfinished (the out-of-order build that produced the
 * PR #326 ⁄ #327 conflict). It speaks only the PMProvider interface (no GitHub
 * specifics, ai/RULES.md §2), so it works for any provider and no-ops for one
 * that can't model dependencies (`supportsDependencies === false`) — there the
 * human-readable split comment remains the guard.
 *
 * **Only a recorded relationship gates** (issue #643). `listBlockers` reports two
 * kinds of blocker and this gate does not treat them alike: a native `blocked by`
 * relationship defers the run, a prerequisite found only in the item's prose is
 * surfaced for a human and the run proceeds. `src/pm/dependencies.ts`'s module
 * comment holds the false-positive history that decided that; the split itself is
 * `partitionBlockersBySource` there, so both halves of the rule live next to each
 * other rather than as a `source` comparison here.
 *
 * **And a cycle never gates** (issue #639). Whatever survives that split is then
 * checked against the item's own outgoing edges (`listDependents`): a blocker the
 * item *natively blocks* cannot close until the gated item lands, so gating on it
 * could only exhaust the wait budget and settle the run failed. That is the
 * structural backstop, which is why it lives here — on the shared gate, applying to
 * every provider — rather than in whichever adapter or parser produced the blocker.
 */

import { logger } from '@/lib/logger.js';
import {
	blockedRunMessage,
	openBlockers,
	partitionBlockersBySource,
	partitionCyclicBlockers,
	proseAdvisoryCommentBody,
	proseAdvisoryMarker,
} from '@/pm/dependencies.js';
import type { PMProvider, WorkItem, WorkItemBlocker, WorkItemDependent } from '@/pm/types.js';

/**
 * Thrown by a phase that must not run yet because its work item is blocked by an
 * unfinished prerequisite. The worker (`handlePhaseFailure`) treats it specially:
 * a bounded, token-free deferral that re-checks on a slow cadence (never the
 * small rate-limit budget) and only settles failed — posting this message on the
 * board — once the wait budget is exhausted. Its `message` is the human-readable
 * "must be done first" summary.
 */
export class DependencyBlockedError extends Error {
	readonly workItem: WorkItem;
	readonly blockers: WorkItemBlocker[];

	constructor(workItem: WorkItem, blockers: WorkItemBlocker[]) {
		super(blockedRunMessage(blockers));
		this.name = 'DependencyBlockedError';
		this.workItem = workItem;
		this.blockers = blockers;
	}
}

/**
 * Report a prose-only prerequisite without gating on it (issue #643): log it, and
 * post the notice on the item itself — the place an operator looks to find out why
 * an item is or is not proceeding — so an unrecorded dependency prompts somebody
 * to record it natively instead of silently disappearing.
 *
 * Idempotent on {@link proseAdvisoryMarker}, which is keyed on the reference set,
 * so the five-minute dependency re-check of a *natively* blocked item does not
 * re-post the same notice every cycle while a later, different unrecorded
 * prerequisite still gets its own.
 *
 * Best-effort: every failure here is logged and swallowed. This is a notice about
 * something that is deliberately not gating, so failing the Implementation run
 * over a board write would be strictly worse than the missed comment — the log
 * line still carries the same information.
 */
async function surfaceProseAdvisory(
	pm: PMProvider,
	workItem: WorkItem,
	advisory: readonly WorkItemBlocker[],
): Promise<void> {
	logger.warn('Dependency gate: prose-only prerequisite surfaced, not gating', {
		workItemId: workItem.id,
		blockers: advisory.map((b) => b.reference),
		action: 'record it as a native blocked-by relationship if it really is a prerequisite',
	});
	const marker = proseAdvisoryMarker(advisory);
	try {
		if (await pm.findComment(workItem.id, marker)) return;
		await pm.addComment(workItem.id, proseAdvisoryCommentBody(advisory));
	} catch (err) {
		logger.warn('Dependency gate: could not post the prose-prerequisite notice', {
			workItemId: workItem.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Drop any blocker the item itself natively blocks (issue #639) — a cycle that
 * could never resolve. Each suppression is logged with the blocker's reference and
 * its {@link WorkItemBlocker.source} (issue #638's vocabulary), because a
 * suppressed gate must be visible: it is the difference between "nothing was
 * blocking this" and "something was, and it was impossible".
 *
 * The reverse read is best-effort in the *conservative* direction, unlike the
 * blocker read above: a failure means the cycle check could not run, not that
 * there is no cycle, so the blockers are returned unchanged and the existing
 * five-minute re-check tries again. Ungating on a failed read would turn a
 * transient board error into an out-of-order build — the failure issue #330 exists
 * to prevent — which is strictly worse than the deadlock this guards against,
 * since that one at least terminates.
 */
async function withoutCyclicBlockers(
	pm: PMProvider,
	workItem: WorkItem,
	gating: WorkItemBlocker[],
): Promise<WorkItemBlocker[]> {
	let dependents: WorkItemDependent[];
	try {
		dependents = await pm.listDependents(workItem.id);
	} catch (err) {
		logger.warn('Dependency gate: could not read dependents; keeping the blockers as they are', {
			workItemId: workItem.id,
			error: err instanceof Error ? err.message : String(err),
		});
		return gating;
	}
	const partitioned = partitionCyclicBlockers(gating, dependents);
	for (const blocker of partitioned.suppressed) {
		logger.warn(
			'Dependency gate: blocker is itself natively blocked by this item; gating on it could never resolve',
			{
				workItemId: workItem.id,
				reference: blocker.reference,
				source: blocker.source,
			},
		);
	}
	return partitioned.gating;
}

/**
 * The still-open prerequisites that **gate** `workItem`, or `[]` when nothing
 * does. Prose-only prerequisites are surfaced (logged and posted on the item) as a
 * side effect and deliberately left out of the returned list, so a caller cannot
 * gate on one by forgetting to filter — see the module comment. A blocker this item
 * natively blocks is dropped too, for the reason {@link withoutCyclicBlockers}
 * gives.
 *
 * Best-effort by design: if the provider can't model dependencies, or the blocker
 * lookup fails transiently, this returns `[]` (proceed) rather than gating — a
 * spurious network error must not wedge every Implementation run. The native
 * relationship plus the human-readable comment are the durable guards; this is
 * the automated convenience on top.
 *
 * **A provider that declares `supportsDependencies: false` gates on nothing, and
 * that is unchanged by issue #643.** The capability check below short-circuits
 * before `listBlockers` is ever called, so such a provider (Trello today) never
 * produced a gate from prose either: its blockers would have to be synthesised
 * from GitHub issue numbers whose state only an SCM provider can resolve, which
 * the provider refuses to do (`src/integrations/pm/trello/provider.ts`). There the
 * guard is, as before, the human-readable prose Planning writes into each split
 * child — no automated gate is lost here, because there was none to lose.
 */
export async function findGatingBlockers(
	pm: PMProvider,
	workItem: WorkItem,
): Promise<WorkItemBlocker[]> {
	if (!pm.supportsDependencies) return [];
	let open: WorkItemBlocker[];
	try {
		open = openBlockers(await pm.listBlockers(workItem.id));
	} catch (err) {
		logger.warn('Dependency gate: could not read blockers; proceeding without gating', {
			workItemId: workItem.id,
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}
	const { gating, advisory } = partitionBlockersBySource(open);
	if (advisory.length > 0) await surfaceProseAdvisory(pm, workItem, advisory);
	// Only worth a reverse read when something would otherwise gate: with nothing to
	// suppress, the check could only cost a board call per dispatch.
	if (gating.length === 0) return gating;
	return withoutCyclicBlockers(pm, workItem, gating);
}
