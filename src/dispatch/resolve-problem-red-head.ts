/**
 * Resolve problem on red pull-request heads (issue #1459) — the detection half of
 * the sweep's third leg: an **open SWARM pull request whose current head has red
 * required checks while nothing in SWARM acts on it**.
 *
 * **Why the other two legs miss it.** Every run on such a pull request is
 * `completed` — typically a Respond-to-CI that settled `no-fix` on a head merge
 * automation brought up to date — so the failed-run leg has nothing to read, and
 * the WIP classifier reads the holder as `settling` for `ITEM_STALL_AFTER_MS` (2 h)
 * and then, when the latest run is the approving Review, rests it permanently as
 * `approved-awaiting-merge`, which the Waiting-on-you leg excludes. Neither table
 * records "the current head is red" — only the provider knows that. So this leg
 * picks a short list of quiet pull-request units out of the database
 * ({@link redHeadCandidates}) and confirms each with one live provider read
 * ({@link probeRedHead}), on `recoverUnreviewedPullRequests`'s shape.
 *
 * **What counts as "nothing acting".** No live run and no non-terminal dispatch on
 * the pull request (Resolve problem's own excluded); a latest run that is
 * `completed` — a `failed` one belongs to the other two legs, which also covers the
 * "Approved head needs the operator" hand-off run, a Respond-to-CI give-up and a
 * user termination; no review-cap stop; no automatic check re-run on the head still
 * inside its settle window, nor a spaced approved-head re-run still to come (issue
 * #1463); and no recorded operator hand-off for the head
 * ({@link redHeadHandled}). Approved and not-yet-approved heads both count — except
 * an approved one on a repository without `autoMerge`, which waits for a person to
 * merge it.
 *
 * **The bound.** A unit qualifies once it has been quiet for {@link RED_HEAD_QUIET_MS}
 * — the failed-run leg's own delay, not the 2 h stall window: a completed check
 * suite with a known conclusion is not external latency — and the leg runs every
 * {@link RED_HEAD_SWEEP_INTERVAL_MS}, so the worst case from going quiet to an
 * attempt is about twenty minutes. Older than {@link RED_HEAD_LOOKBACK_MS} is left
 * to the operator, as the failed-run leg does, which also bounds the provider reads.
 *
 * **Provider cost.** Two reads (the pull request, then its head's checks) per quiet,
 * unmerged pull-request unit whose latest run completed, in projects that turned
 * Resolve problem on, within the lookback — per pass. Both run as the project's
 * reviewer credential, the providers' default for these reads.
 *
 * Pure fold plus two small probes, so the sweep leg
 * (`./resolve-problem-trigger.ts`) and the claim-time re-check
 * (`./resolve-problem.ts`) cannot disagree about what "red, nothing acting" means.
 * Imports neither, which keeps the three modules free of a cycle.
 */

import type { ProjectConfig } from '../config/schema.js';
import type { ActiveDispatchTaskRef } from '../db/repositories/dispatchesRepository.js';
import {
	getApprovedHeadSlot,
	type ReviewVerdictKey,
} from '../db/repositories/reviewVerdictsRepository.js';
import {
	findUpdatedHeadReviewRun,
	type TaskActivityRow,
} from '../db/repositories/runsRepository.js';
import { requireProjectSCMProvider } from '../integrations/scm/registry.js';
import { repoSlugsMatch } from '../scm/repo-slug.js';
import type { SCMProvider } from '../scm/types.js';
import { decideAggregateCheckOutcome } from '../triggers/handlers/aggregate-check-decision.js';
import {
	approvedHeadRerunInFlight,
	MAX_APPROVED_HEAD_RERUNS,
	nextApprovedHeadRerunDueAt,
	RERUN_SETTLE_MS,
} from './approved-head-checks-rerun.js';
import {
	foldLivenessUnits,
	type ItemLivenessPolicy,
	type ItemLivenessUnit,
} from './item-liveness.js';

/**
 * How long a pull request must have been quiet before its red head is attempted —
 * the failed-run leg's own `RESOLVE_PROBLEM_DELAY_MS`, so the two bounds compare.
 */
export const RED_HEAD_QUIET_MS = 10 * 60 * 1000;

/**
 * How far back the leg looks — the failed-run leg's `RESOLVE_PROBLEM_LOOKBACK_MS`:
 * an older quiet pull request is left to the operator, and the provider reads stay
 * bounded.
 */
export const RED_HEAD_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * How often the leg runs. Its own interval rather than a step of the reconciler's
 * Resolve problem pass, because a pass reads the provider while the reconciler's
 * is bounded database work — the reason the review-recovery sweep has its own.
 */
export const RED_HEAD_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** A quiet pull request whose head the leg reads from the provider. */
export interface RedHeadCandidate {
	projectId: string;
	repository: string;
	prNumber: string;
	/** The pull request's latest run — the attempt's anchor. */
	latestRunId: string;
	/** That run's own task id (`<pr>`, `<pr>-ci`, …). */
	taskId: string;
	workItemId?: string;
	/** Whether merge automation is on for the pull request's repository. */
	autoMerge: boolean;
}

/** Whether a unit's latest run is the approving Review — the human merge gate's shape. */
function latestIsApproval(latest: TaskActivityRow): boolean {
	return latest.phase === 'review' && latest.reviewVerdict === 'approve';
}

/**
 * Whether a pull-request unit is quiet in the leg's sense: nothing live or queued,
 * not merged, its latest run `completed` and not a review-cap stop, and silent for
 * at least {@link RED_HEAD_QUIET_MS}.
 */
function isQuietPullRequest(unit: ItemLivenessUnit, now: Date): boolean {
	if (unit.unit !== 'pull-request') return false;
	if (unit.liveRunCount > 0 || unit.hasActiveDispatch || unit.mergedRunCount > 0) return false;
	if (unit.latest.status !== 'completed') return false;
	if (unit.latest.reviewAutomationOutcome === 'manual-intervention-required') return false;
	return now.getTime() - unit.lastActivityAt.getTime() >= RED_HEAD_QUIET_MS;
}

/**
 * The quiet pull-request units whose head the leg reads (issue #1459): nothing
 * live and nothing queued on them, not merged, a `completed` latest run that is
 * not a review-cap stop, quiet for at least {@link RED_HEAD_QUIET_MS}, and — on a
 * repository without `autoMerge` — not resting on an approval, which waits for a
 * person to merge it. Pure.
 */
export function redHeadCandidates(
	activity: readonly TaskActivityRow[],
	activeDispatches: readonly ActiveDispatchTaskRef[],
	policies: Readonly<Record<string, ItemLivenessPolicy>>,
	now: Date,
): RedHeadCandidate[] {
	const candidates: RedHeadCandidate[] = [];
	for (const unit of foldLivenessUnits(activity, activeDispatches, [])) {
		if (!isQuietPullRequest(unit, now)) continue;
		const { latest } = unit;
		const autoMerge =
			policies[unit.projectId]?.autoMergeRepositories.some((repo) =>
				repoSlugsMatch(repo, unit.repository),
			) ?? false;
		if (!autoMerge && latestIsApproval(latest)) continue;
		candidates.push({
			projectId: unit.projectId,
			repository: unit.repository,
			prNumber: unit.reference,
			latestRunId: latest.runId,
			taskId: latest.taskId,
			...(latest.workItemId ? { workItemId: latest.workItemId } : {}),
			autoMerge,
		});
	}
	return candidates;
}

/** What one live read of a pull request's head found. */
export type RedHeadProbe =
	| { state: 'red'; headSha: string; failedChecks: string[] }
	| { state: 'not-open' }
	/** Open, but its head's checks are still running (`defer`) or green (`review`). */
	| { state: 'not-red'; headSha: string; checks: 'defer' | 'review' };

/**
 * Read a pull request and its head's checks from the provider, decided with the
 * repository's own check policy exactly as the `pr-review` trigger decides them. A
 * red is any failed or cancelled check (`respond-to-ci`, issue #1429); a check
 * still running — a re-run in progress included — is not. `project` must be scoped
 * to the pull request's repository. Throws what the provider throws.
 */
export async function probeRedHead(
	project: ProjectConfig,
	prNumber: string,
	provider: Pick<
		SCMProvider,
		'getPullRequest' | 'getAggregateCheckStatus'
	> = requireProjectSCMProvider(project),
): Promise<RedHeadProbe> {
	const pr = await provider.getPullRequest(project, Number(prNumber));
	if (pr.state !== 'open') return { state: 'not-open' };
	const status = await provider.getAggregateCheckStatus(project, pr.headSha);
	const decision = decideAggregateCheckOutcome(
		status,
		prNumber,
		project.reviewChecks ?? 'required',
	);
	if (decision.action === 'respond-to-ci') {
		return { state: 'red', headSha: pr.headSha, failedChecks: decision.failedChecks };
	}
	return { state: 'not-red', headSha: pr.headSha, checks: decision.action };
}

/** The two database reads {@link redHeadHandled} makes, injectable for tests. */
export interface RedHeadHandledReads {
	getApprovedHeadSlot: typeof getApprovedHeadSlot;
	findUpdatedHeadReviewRun: typeof findUpdatedHeadReviewRun;
}

// Wrapped rather than referenced, so a suite that mocks either repository module
// without these reads can still import this one.
const defaultHandledReads: RedHeadHandledReads = {
	getApprovedHeadSlot: (key) => getApprovedHeadSlot(key),
	findUpdatedHeadReviewRun: (key) => findUpdatedHeadReviewRun(key),
};

/**
 * Why a red head is still being handled — and so not attempted — or `undefined`
 * when nothing is: SWARM already handed the approved head to the operator; one of
 * SWARM's automatic check re-runs on it (the approved head's, issue #1128, or the
 * updated head's, issue #1433) is still inside {@link RERUN_SETTLE_MS}; the approved
 * head's next spaced re-run is still to come (issue #1463 — the policy's own
 * {@link approvedHeadRerunInFlight}, so the sweep and the policy agree); or the
 * head is approved on a repository without `autoMerge`, so it waits for a person
 * to merge it.
 */
export async function redHeadHandled(
	key: ReviewVerdictKey,
	autoMerge: boolean,
	now: Date,
	reads: RedHeadHandledReads = defaultHandledReads,
): Promise<string | undefined> {
	const slot = await reads.getApprovedHeadSlot(key);
	if (slot?.operatorNotifiedAt) {
		return `SWARM already handed approved head ${key.headSha} to the operator`;
	}
	if (slot && !autoMerge) {
		return `Head ${key.headSha} is approved on a repository without auto-merge — it waits for a person to merge it`;
	}
	if (slot && approvedHeadRerunInFlight(slot, now)) {
		const spent = slot.checksRerunAttempts;
		const dueAt = nextApprovedHeadRerunDueAt(slot);
		const next =
			dueAt && dueAt.getTime() > now.getTime() ? `; the next is due at ${dueAt.toISOString()}` : '';
		return `SWARM has re-run ${spent} of ${MAX_APPROVED_HEAD_RERUNS} of approved head ${key.headSha}'s checks${next}`;
	}
	const settling = (at: Date | null | undefined): boolean =>
		!!at && now.getTime() - at.getTime() < RERUN_SETTLE_MS;
	const updated = await reads.findUpdatedHeadReviewRun(key);
	if (updated?.checksRerunHeadSha === key.headSha && settling(updated.checksRerunAt)) {
		return `SWARM re-ran the checks on updated head ${key.headSha} moments ago — the re-run is settling`;
	}
	return undefined;
}
