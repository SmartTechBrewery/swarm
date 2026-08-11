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
 */

import { logger } from '@/lib/logger.js';
import {
	blockedRunMessage,
	openBlockers,
	partitionBlockersBySource,
	proseAdvisoryCommentBody,
	proseAdvisoryMarker,
} from '@/pm/dependencies.js';
import type { PMProvider, WorkItem, WorkItemBlocker } from '@/pm/types.js';

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
 * The still-open prerequisites that **gate** `workItem`, or `[]` when nothing
 * does. Prose-only prerequisites are surfaced (logged and posted on the item) as a
 * side effect and deliberately left out of the returned list, so a caller cannot
 * gate on one by forgetting to filter — see the module comment.
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
	return gating;
}
