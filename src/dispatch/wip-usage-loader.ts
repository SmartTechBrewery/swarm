/**
 * The WIP-usage loader (issue #1192, moved here by issue #1425) — the database half
 * of the `runs.wip` read model, shared by the API (`../api/routers/runs.ts`, which
 * only links each holder's pull request on top) and by Resolve problem's periodic
 * sweep (`./resolve-problem-trigger.ts`), which takes on the holders this read
 * classifies as waiting on the operator. One loader, so the panel and the sweep
 * cannot disagree about which ticket is stuck and why.
 *
 * The classification itself is pure and lives in `../queue/wip-usage.ts`; this
 * module supplies its bounded reads and the per-project policy and limit lookups.
 * Postgres only.
 */

import { findProjectRepository, resolveWipLimit } from '../config/project-repository.js';
import type { ProjectRecord } from '../config/schema.js';
import {
	countWipLimitWaitsByRepository,
	listActiveDispatchesByDedupKeys,
	listActiveDispatchTaskRefs,
} from '../db/repositories/dispatchesRepository.js';
import {
	hasReviewInFlightAbove,
	isLastPermittedVerdict,
	isReviewAllowanceSpent,
	listActiveReviewSlotsForPullRequest,
	type PullRequestReviewSlot,
} from '../db/repositories/reviewVerdictsRepository.js';
import {
	getCompletedReviewRunForOrdinal,
	listResolveProblemAttemptsForHolders,
	listTaskActivitySince,
} from '../db/repositories/runsRepository.js';
import { listWipSlots, type WipSlotRow } from '../db/repositories/wipSlotsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
	foldResolveProblemAttempts,
	resolveProblemAttemptHolders,
	toWipUsage,
	type WipCappedPullRequest,
	type WipUsageEntry,
} from '../queue/wip-usage.js';
import { ITEM_ACTIVITY_LOOKBACK_MS, type ItemLivenessPolicy } from './item-liveness.js';

/**
 * The two project policies the liveness classification consults, read exactly as
 * the pipeline itself reads them (issue #840): Planning's `autoAdvance` is off
 * unless set (`DEFAULT_AUTO_ADVANCE`, `src/pipeline/planning.ts`) and merge
 * automation is opt-in per repository (`src/worker/consumer.ts`, issue #1066) —
 * which is why this reads the whole **record**, not a config scoped to one of its
 * repositories. A project that no longer resolves gets those same defaults rather
 * than an exception — a stalled-work view that throws because one project row went
 * missing is worse than one that reports that project under the pipeline's own
 * defaults.
 */
export function itemLivenessPolicyFor(record: ProjectRecord | undefined): ItemLivenessPolicy {
	return {
		planningAutoAdvance: record?.pipeline?.planning?.autoAdvance === true,
		autoMergeRepositories:
			record?.repositories.filter((entry) => entry.autoMerge === true).map((entry) => entry.repo) ??
			[],
	};
}

/**
 * Whether this Review run's verdict is the last one SWARM will produce for its
 * pull request unless an operator intervenes (issue #1038): the review-verdict
 * allowance is spent, no operator grant is outstanding, this run holds the
 * highest submitted slot, and no later reservation is already in flight.
 *
 * That last clause is what keeps the answer true *after* an operator acts. A grant
 * is spent by the reservation it pays for, so the moment the granted Review takes
 * its slot the ledger shows a spent allowance, no outstanding grant, and this run
 * still holding the last submitted verdict — every earlier clause satisfied while
 * SWARM is mid-review. Only the pending slot above it says otherwise — and only
 * while the dispatch that took it is still due to run: a reservation whose owner
 * died is a relic no reservation will clear on a capped pull request, so counting
 * it as a review in flight would retire the callout exactly when the operator
 * needs it (`hasReviewInFlightAbove`).
 *
 * Resolved from the ledger rather than stored on the run, because the answer
 * belongs to the *pull request's* ledger and keeps changing after the run ends (a
 * later grant, a recovered slot). Shared by the run-detail read
 * (`../api/routers/runs.ts`) and {@link loadWipCappedPullRequests}, so the
 * detail page's callout and the WIP panel's `review-cap-reached` cannot disagree
 * (moved here from the API router by issue #1425).
 *
 * `null`, never `false`, when the question does not apply, so the dashboard can
 * tell "not a ledgered Review run" from "still has allowance left".
 */
export function resolveReviewCapSpent(
	run: { reviewOrdinal: number | null },
	slots: readonly PullRequestReviewSlot[] | null,
): boolean | null {
	if (!slots) return null;
	return (
		isReviewAllowanceSpent(slots) &&
		isLastPermittedVerdict(slots, run.reviewOrdinal) &&
		!hasReviewInFlightAbove(slots, run.reviewOrdinal)
	);
}

/**
 * A repository's resolved WIP limit from the project records the caller loaded. A
 * repository the project no longer owns — slots outliving a removed entry — reads at
 * the project default rather than failing the view.
 */
export function wipLimitFrom(records: Map<string, ProjectRecord>) {
	return (projectId: string, repository: string): number => {
		const record = records.get(projectId);
		const entry = record ? findProjectRepository(record, repository) : undefined;
		return resolveWipLimit(entry ?? {});
	};
}

/**
 * The holders' pull requests the review cap stopped on a refused approval (issue
 * #1379) — rule 2b of `src/queue/wip-usage.ts`. That stop fires on a webhook and
 * records no run, so it is read off each pull request's review ledger: the highest
 * submitted slot's completed Review run must be the one {@link resolveReviewCapSpent}
 * calls cap-spent, and an approval merge automation refused (`not-eligible`) — the
 * same fact the run-detail page's `isCapSpentApproval` reads, so the two agree. An
 * outstanding grant or a review in flight above that verdict means an operator has
 * acted, and the ticket is the pipeline's again.
 *
 * One ledger read per distinct pull request held in a slot (bounded by the sum of
 * the WIP limits), plus one run read only for a spent allowance. Best-effort per
 * pull request: a failed read logs and leaves that ticket uncapped rather than
 * failing the view.
 */
export async function loadWipCappedPullRequests(
	slots: readonly WipSlotRow[],
): Promise<WipCappedPullRequest[]> {
	const pullRequests = new Map<
		string,
		{ projectId: string; repository: string; prNumber: string }
	>();
	for (const slot of slots) {
		if (!slot.prNumber) continue;
		pullRequests.set([slot.projectId, slot.repository, slot.prNumber].join('\u0000'), {
			projectId: slot.projectId,
			repository: slot.repository,
			prNumber: slot.prNumber,
		});
	}
	const resolved = await Promise.all(
		[...pullRequests.values()].map(async (pr): Promise<WipCappedPullRequest | null> => {
			try {
				const slotsOfPr = await listActiveReviewSlotsForPullRequest(
					pr.projectId,
					pr.repository,
					pr.prNumber,
				);
				if (!isReviewAllowanceSpent(slotsOfPr)) return null;
				const submitted = slotsOfPr.filter((slot) => slot.state === 'submitted');
				if (submitted.length === 0) return null;
				const lastOrdinal = Math.max(...submitted.map((slot) => slot.ordinal));
				if (hasReviewInFlightAbove(slotsOfPr, lastOrdinal)) return null;
				const run = await getCompletedReviewRunForOrdinal(
					pr.projectId,
					pr.repository,
					pr.prNumber,
					lastOrdinal,
				);
				if (
					!run ||
					run.status !== 'completed' ||
					run.phase !== 'review' ||
					run.reviewVerdict !== 'approve' ||
					run.reviewMergeOutcome !== 'not-eligible' ||
					resolveReviewCapSpent(run, slotsOfPr) !== true
				) {
					return null;
				}
				return { ...pr, runId: run.id };
			} catch (error) {
				logger.warn('wip usage: review-ledger lookup failed; reporting the pull request uncapped', {
					projectId: pr.projectId,
					repository: pr.repository,
					prNumber: pr.prNumber,
					error: describeError(error),
				});
				return null;
			}
		}),
	);
	return resolved.filter((pr): pr is WipCappedPullRequest => pr !== null);
}

/**
 * Fold each `waiting-on-operator` holder's Resolve problem attempt onto `entries`
 * (issue #1428): two bounded reads — the attempt runs on the holders' anchors and
 * the non-terminal dispatches under their dedup keys — folded by
 * `foldResolveProblemAttempts`. Nothing is read when no holder waits on the
 * operator. Best-effort: a failed read logs and returns the entries without the
 * field rather than failing the view (or Resolve problem's own sweep).
 */
export async function withResolveProblemAttempts(
	entries: WipUsageEntry[],
): Promise<WipUsageEntry[]> {
	const holders = resolveProblemAttemptHolders(entries);
	if (holders.dedupKeys.length === 0) return entries;
	try {
		const [runs, queued] = await Promise.all([
			listResolveProblemAttemptsForHolders(holders),
			listActiveDispatchesByDedupKeys(holders.dedupKeys),
		]);
		return foldResolveProblemAttempts(entries, { runs, queued });
	} catch (error) {
		logger.warn('wip usage: Resolve problem attempt lookup failed; reporting holders without it', {
			holders: holders.dedupKeys.length,
			error: describeError(error),
		});
		return entries;
	}
}

/**
 * Assemble the WIP-usage read model (issue #1192) for `projectIds` (every project
 * when absent) from its four bounded reads plus the review-cap ledger, classified
 * by `toWipUsage`, with each waiting holder's Resolve problem attempt folded on
 * ({@link withResolveProblemAttempts}). Pull requests are left unlinked: linking
 * them is the API's concern, and the sweep needs none.
 */
export async function loadWipUsageEntries(
	records: readonly ProjectRecord[],
	projectIds?: string[],
): Promise<WipUsageEntry[]> {
	const since = new Date(Date.now() - ITEM_ACTIVITY_LOOKBACK_MS);
	const [slots, waiters] = await Promise.all([
		listWipSlots(projectIds),
		countWipLimitWaitsByRepository(projectIds),
	]);
	if (slots.length === 0 && waiters.length === 0) return [];
	const [activity, activeDispatches, cappedPullRequests] = slots.length
		? await Promise.all([
				listTaskActivitySince({ since, projectIds }),
				listActiveDispatchTaskRefs(projectIds),
				loadWipCappedPullRequests(slots),
			])
		: [[], [], []];
	const entries = toWipUsage({
		slots,
		waiters,
		limitFor: wipLimitFrom(new Map(records.map((record) => [record.id, record]))),
		activity,
		activeDispatches,
		cappedPullRequests,
		policies: Object.fromEntries(
			records.map((record) => [record.id, itemLivenessPolicyFor(record)]),
		),
	});
	return withResolveProblemAttempts(entries);
}
