/**
 * Base-branch health (issue #872 phase 1) — the periodic sweep that asks one
 * question per repository, *is this project's base branch currently red?*, and
 * reports the answer when it is.
 *
 * **What it exists to remove.** Nothing in SWARM watches the base branch. A merge
 * that breaks `main` is only ever noticed indirectly, through some *other* pull
 * request whose CI then fails on the merge of its own head with that broken base
 * — so the failure presents as belonging to a diff that has nothing to do with
 * it, and a human has to infer the real cause from an unrelated symptom. This
 * sweep makes the base's own state a first-class observation instead.
 *
 * **It changes no lifecycle.** Nothing is dispatched, no phase runs, no merge
 * decision, trigger disposition, or review verdict is affected. On the healthy
 * path a pass costs exactly two provider reads per repository. That is what makes
 * it safe to ship on its own, ahead of the two halves that *act* on the answer:
 * per-pull-request attribution of a red CI to the base (issue #873) and
 * preventing a red base in the first place (issue #874).
 *
 * **The report, when the base is red.** Two things, both deliberate:
 *
 *  1. one structured `error` log per pass, naming the project, repository, base
 *     branch, head SHA and failing check names. Every pass while the base stays
 *     red, not once — an ongoing incident should stay loud rather than scroll
 *     away after a single line.
 *  2. one comment on the pull request whose merge produced that base head, posted
 *     through the **delivery seam** so its per-delivery marker makes it land
 *     exactly once per red head with no new durable state to keep. SWARM has no
 *     operator alert channel, and inventing one is a bigger change than this
 *     needs; the merged pull request is the most addressable artifact available,
 *     it names the change that broke the base, and its participants are notified.
 *
 * **The base head may not come from a pull request at all** — a direct push, or a
 * provider that has not indexed the commit yet. {@link SCMProvider.listPullRequestsForCommit}
 * then answers `[]`, which is an ordinary answer: the pass logs and posts nothing.
 * That is stated here rather than worked around, because there is nothing better
 * to comment on.
 *
 * Lives under `src/dispatch/` for the reason `./unreviewed-pr-recovery.ts` — the
 * module this one is shaped after — and `./ci-no-fix-recovery.ts` do: it is work
 * scheduled at the composition root (`src/router/dispatcher.ts`), not by a phase
 * (ai/RULES.md §2).
 */

import { scopeProjectToRepository } from '../config/project-repository.js';
import type { ProjectConfig } from '../config/schema.js';
import { listAllProjectRecordsFromDb } from '../db/repositories/projectsRepository.js';
import { requireProjectSCMProvider } from '../integrations/scm/registry.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { deliveryIdentity } from '../scm/delivery.js';
import { SWARM_GENERATED_FOOTER } from '../scm/swarm-origin.js';
import type { AggregateCheckStatus, SCMProvider } from '../scm/types.js';
import { decideAggregateCheckOutcome } from '../triggers/handlers/aggregate-check-decision.js';

/**
 * How often the sweep runs.
 *
 * Shorter than `UNREVIEWED_PR_SWEEP_INTERVAL_MS`'s 15 minutes on both halves of
 * the same trade-off: a pass here costs two provider reads per repository on the
 * healthy path (against that sweep's pull-request list read plus one read per
 * candidate), and the incident it exists to shorten is measured in a lost
 * ~40-minute round of every open pull request's CI rather than in one delayed
 * review. Not configurable, on `DISPATCH_CONSUMER_CONCURRENCY`'s precedent:
 * detection latency is not an operator dial.
 *
 * **Not the reconciler's five minutes.** That one is tunable
 * (`SWARM_STALE_RUN_SWEEP_INTERVAL_MS`, `src/router/dispatcher.ts`) and reclaims
 * leases; the coincidence of value is exactly that, and neither number should
 * ever be changed because the other was.
 */
export const BASE_BRANCH_HEALTH_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The persona every read in this sweep authenticates as.
 *
 * Stated once and passed explicitly, because the three contract methods used here
 * disagree on their own defaults — `listPullRequestsForCommit` and
 * `getAggregateCheckStatus` default to the **reviewer**, `listConflictCandidates`
 * hard-codes the **implementer** — so leaving it implicit would have one pass
 * authenticate as two different accounts. Implementer is the credential the
 * router actually holds (`SWARM_OPERATOR_GH_TOKEN`) and the one the unreviewed-PR
 * sweep beside this reads with.
 */
const SWEEP_PERSONA = 'implementer' as const;

/** What the base branch's own CI says right now. */
export type BaseBranchHealth =
	| { status: 'green'; headSha: string }
	| { status: 'red'; headSha: string; failedChecks: string[] }
	/** Checks still running, or none registered yet — not an answer, so say nothing. */
	| { status: 'unsettled'; headSha: string }
	/** The branch head or its checks could not be read this pass. */
	| { status: 'unknown'; reason: string };

/**
 * The deterministic once-only identity of the report for one red base head.
 *
 * `project.repo` is in the hash for the reason `unreviewedPrRecoveryDeliveryId`
 * states: a project spans repositories (issue #685), so a shared key would let
 * one repository's red base absorb another's as an already-delivered repeat. The
 * head SHA is what makes the comment land once per broken commit rather than once
 * per pass — a *new* red head is a new incident and gets its own comment.
 */
export function baseBranchRedDeliveryId(project: ProjectConfig, headSha: string): string {
	return deliveryIdentity(['base-red', project.repo, project.baseBranch, headSha]);
}

/**
 * Read the health of **one named branch** of one repository. Never throws —
 * every failure comes back as `unknown` carrying the provider's own diagnostic.
 *
 * The branch is a parameter rather than `project.baseBranch` because the two are
 * not always the same branch: the sweep below asks about the project's
 * configured base, while issue #873's per-pull-request attribution must ask
 * about the base *that pull request actually targets* — a retargeted pull
 * request (say, moved from `main` onto `release/1.0`) would otherwise be judged
 * against a branch it does not build against at all.
 *
 * Exported separately from the sweep because that attribution reuses it to
 * decide whether a pull request's red CI is its own fault: it is a pure provider
 * read with no reporting side effects, and the reporting lives in the sweep.
 */
export async function readBaseBranchHealth(
	project: ProjectConfig,
	provider: SCMProvider,
	baseBranch: string,
): Promise<BaseBranchHealth> {
	let headSha: string | null;
	try {
		headSha = await provider.getBranchHead(project, baseBranch, SWEEP_PERSONA);
	} catch (err) {
		return { status: 'unknown', reason: `branch head read failed: ${describeError(err)}` };
	}
	if (headSha === null) {
		return {
			status: 'unknown',
			reason: `the provider named no head commit for ${baseBranch}`,
		};
	}

	let checkStatus: AggregateCheckStatus;
	try {
		checkStatus = await provider.getAggregateCheckStatus(project, headSha, SWEEP_PERSONA);
	} catch (err) {
		return { status: 'unknown', reason: `aggregate check read failed: ${describeError(err)}` };
	}

	// The *same* classifier the `pr-review` handler judges a pull request's head
	// with, under the project's own `pipeline.review.checks` policy — so a base
	// branch and a pull request are never judged red by two different rules. Its
	// `prNumber` parameter is only ever interpolated into a `defer` message this
	// caller does not read, so the base branch's name goes there instead of a
	// number this read has none of.
	const decision = decideAggregateCheckOutcome(
		checkStatus,
		baseBranch,
		project.pipeline?.review?.checks ?? 'required',
	);
	if (decision.action === 'respond-to-ci') {
		return { status: 'red', headSha, failedChecks: decision.failedChecks };
	}
	if (decision.action === 'defer') return { status: 'unsettled', headSha };
	return { status: 'green', headSha };
}

/** The comment posted on the pull request whose merge produced a red base head. */
function redBaseCommentBody(baseBranch: string, headSha: string, failedChecks: string[]): string {
	const shortSha = headSha.slice(0, 7);
	return [
		`## ⚠️ \`${baseBranch}\` is red at the commit this pull request produced`,
		'',
		`Every check on \`${baseBranch}\` at \`${shortSha}\` has completed and these failed: ${failedChecks
			.map((name) => `\`${name}\``)
			.join(', ')}.`,
		'',
		'Open pull requests build the merge of their head with this base, so their own',
		'checks may be failing for this reason rather than for anything in their diff.',
		'',
		'---',
		// Load-bearing, not decoration: ingress drops an inbound comment event whose
		// body carries `SWARM_GENERATED_SIGNATURE` (`isSwarmGeneratedBody`), which is
		// what stops this comment from waking a trigger.
		SWARM_GENERATED_FOOTER,
	].join('\n');
}

/**
 * Report one red base branch: the structured log every pass, and the once-only
 * comment on the pull request whose merge produced the head.
 *
 * Every provider failure below is caught and logged at `warn` — a report that
 * cannot be delivered must not abort the pass, and the log line above it already
 * carries the same facts for anyone watching the router.
 */
async function reportRedBaseBranch(
	project: ProjectConfig,
	provider: SCMProvider,
	headSha: string,
	failedChecks: string[],
): Promise<void> {
	const context = {
		projectId: project.id,
		repository: project.repo,
		baseBranch: project.baseBranch,
		headSha,
	};
	logger.error('base branch health: the base branch is red', { ...context, failedChecks });

	// `listPullRequestsForCommit` answers "the pull requests this commit belongs
	// to", which for a merge commit on the base branch is the pull request whose
	// merge produced it. It also reports closed and merged pull requests, and the
	// first is taken without consulting `state`: a base head's pull request is
	// merged by definition, so filtering for `open` would discard every real
	// answer.
	let mergedPr: number | undefined;
	try {
		const [pr] = await provider.listPullRequestsForCommit(project, headSha, SWEEP_PERSONA);
		mergedPr = pr?.number;
	} catch (err) {
		logger.warn('base branch health: could not resolve the pull request behind the base head', {
			...context,
			error: describeError(err),
		});
		return;
	}
	if (mergedPr === undefined) {
		// An ordinary answer: a direct push to the base branch, or a provider that
		// has not indexed the commit. The log above is the whole report.
		logger.debug('base branch health: no pull request produced this base head — logged only', {
			...context,
		});
		return;
	}

	try {
		const delivery = await provider.deliveryProvider(project, SWEEP_PERSONA);
		await delivery.postComment({
			prNumber: mergedPr,
			body: redBaseCommentBody(project.baseBranch, headSha, failedChecks),
			deliveryId: baseBranchRedDeliveryId(project, headSha),
		});
	} catch (err) {
		logger.warn('base branch health: could not post the red-base notice', {
			...context,
			prNumber: String(mergedPr),
			error: describeError(err),
		});
	}
}

/** Sweep one repository of one project. Throws nothing the caller has to handle. */
async function sweepRepository(project: ProjectConfig): Promise<void> {
	const context = { projectId: project.id, repository: project.repo };

	// Never a fallback: `requireProjectSCMProvider` throws for an unregistered, a
	// not-runtime-ready, and an unstated `scm`, and resolving a project's
	// operations onto a provider it did not name is the exact failure it exists to
	// prevent.
	let provider: SCMProvider;
	try {
		provider = requireProjectSCMProvider(project);
	} catch (err) {
		logger.debug('base branch health: no SCM provider for this project — skipping repository', {
			...context,
			error: describeError(err),
		});
		return;
	}

	// Deliberately ungated beyond that: a repository is swept regardless of
	// `pipeline.review.enabled`, because base-branch health is not Review, and
	// there is no automation-label gate either — that label is per work item, and
	// this asks about a branch.
	// The project's configured base, which is the only branch this periodic sweep
	// is about — per-pull-request attribution passes the pull request's own base
	// instead (issue #873).
	const health = await readBaseBranchHealth(project, provider, project.baseBranch);
	if (health.status === 'unknown') {
		logger.warn('base branch health: could not read the base branch this pass', {
			...context,
			baseBranch: project.baseBranch,
			reason: health.reason,
		});
		return;
	}
	if (health.status !== 'red') {
		logger.debug('base branch health: base branch is not reporting a completed failure', {
			...context,
			baseBranch: project.baseBranch,
			headSha: health.headSha,
			health: health.status,
		});
		return;
	}

	await reportRedBaseBranch(project, provider, health.headSha, health.failedChecks);
}

/**
 * One sweep pass over every repository of every project.
 *
 * Best-effort throughout, on `recoverUnreviewedPullRequests`'s posture: every
 * failure is logged and the pass continues, and this never throws — an unhandled
 * rejection out of a bare `setInterval` callback would take the router down.
 */
export async function sweepBaseBranchHealth(): Promise<void> {
	try {
		const records = await listAllProjectRecordsFromDb();
		for (const record of records) {
			// Per repository, so a multi-repository project (issue #685) has each of
			// its base branches read against that repository's own scoped config.
			for (const entry of record.repositories) {
				try {
					await sweepRepository(scopeProjectToRepository(record, entry.repo));
				} catch (err) {
					logger.warn('base branch health: repository pass failed — continuing the sweep', {
						projectId: record.id,
						repository: entry.repo,
						error: describeError(err),
					});
				}
			}
		}
	} catch (err) {
		logger.error('base branch health: sweep failed (continuing)', { error: describeError(err) });
	}
}
