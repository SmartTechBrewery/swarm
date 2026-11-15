/**
 * The shared check failure (issue #1464, phase 1 of 2) — the same check, which
 * SWARM's own CI agent adjudicated `no-fix`, failing on **two or more** open
 * approved pull-request heads of one repository at once.
 *
 * The approved-head re-run policy (`./approved-head-checks-rerun.ts`, issues
 * #1128/#1463) is per head: it re-runs each head's failed checks up to three
 * times, then writes a per-head operator notice, and Resolve problem's red-head
 * leg (`./resolve-problem-red-head.ts`) attempts each red head it finds quiet. One
 * flaky check on the base branch therefore produced N rounds of re-runs, N notices
 * and N Resolve problem candidates for one problem. This module recognises that
 * shape, records it as one `(project, repository, check)` **episode** and reports
 * it once; while the episode stands, the policy answers `shared-failure` for the
 * heads it covers and does nothing else.
 *
 * - **Observation.** Every time the policy is applied to an adjudicated red
 *   approved head, each failing check is recorded against that head
 *   (`shared_check_failure_observations`).
 * - **Detection.** A check is shared once it has sightings on at least
 *   {@link MIN_SHARED_CHECK_PULL_REQUESTS} distinct pull requests inside
 *   {@link SHARED_CHECK_WINDOW_MS}, each still open on the head it was sighted on
 *   — confirmed with one `getPullRequest` read per *other* pull request, at most
 *   {@link MAX_SHARED_CHECK_PROBES}. A provider error fails closed: that pull
 *   request does not count. Openness is never assumed.
 * - **Episode.** One standing row per `(project, repository, check)`; it stands
 *   while unresolved and younger than {@link SHARED_CHECK_EPISODE_MAX_AGE_MS}.
 *   It records the base branch's head it opened against, best-effort.
 * - **Once-only report.** Whoever wins the episode's `reported_at` claim writes
 *   one structured error log and one durable `failed` Respond-to-CI run with the
 *   `shared-check-failure` diagnosis, which Resolve problem never attempts. No
 *   pull-request comment: per-PR notices are what this removes. A pull request
 *   joining a standing episode later gets an `info` log only.
 * - **Runners.** The report names where each failed attempt ran, where the
 *   provider reports it (`describeFailedCheckAttempts`, issue #1468). Episodes are
 *   not split by runner: the contract offers no stable runner identity to key on.
 *
 * - **Base advanced (issue #1471, phase 2).** The base-branch-health sweep
 *   (`./base-branch-health.ts`) hands every pass's base head to
 *   {@link resumeSharedCheckFailures}. Once the base has moved past the head an
 *   episode opened against and is not red, the episode is resolved
 *   `base-advanced` — once every affected head has been settled, so new reds on
 *   that check are judged per head again. Each affected approved pull request
 *   still open on the head it was sighted on, and not already handed to the
 *   operator, is tried once more first: its merge is resumed with a flag that
 *   brings a stale red head up to date instead of refusing it, and the updated
 *   head's own CI decides. A head that could not be settled this pass (a failed
 *   read or dispatch) keeps the episode standing, so the next pass retries it.
 *
 * Lives under `src/dispatch/` beside the policy it serves.
 */

import type { ProjectConfig } from '../config/schema.js';
import { getApprovedHeadSlot } from '../db/repositories/reviewVerdictsRepository.js';
import { createFailedRun } from '../db/repositories/runsRepository.js';
import {
	type CheckFailureHeadKey,
	type CheckFailureObservation,
	claimEpisodeReport,
	findStandingEpisodes,
	listEpisodeAffectedHeads,
	listRecentCheckFailureObservations,
	listStandingEpisodesForRepository,
	openEpisode,
	recordCheckFailureObservations,
	resolveEpisode,
	type StandingSharedCheckFailureEpisode,
	stampEpisodeBaseHead,
} from '../db/repositories/sharedCheckFailuresRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { SwarmJob } from '../queue/jobs.js';
import type { CheckAttemptRunner, SCMProvider } from '../scm/types.js';
import { operatorHandoffDiagnosis } from '../worker/failure-diagnosis.js';
import type { MergeResumeResult } from '../worker/merge-automation.js';

/** How recent a sighting must be to count toward a shared failure — the red-head leg's lookback. */
export const SHARED_CHECK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long an episode stands once opened. Nothing resolves one in phase 1, so this
 * is what keeps a check that flaked once from being suppressed in its repository
 * for good.
 */
export const SHARED_CHECK_EPISODE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The most other pull requests one detection reads from the provider, per check. */
export const MAX_SHARED_CHECK_PROBES = 10;

/** How many distinct pull requests make a failure shared. */
export const MIN_SHARED_CHECK_PULL_REQUESTS = 2;

/** One affected approved head. */
export interface AffectedHead {
	prNumber: string;
	headSha: string;
}

/**
 * Per check, the *other* pull requests to confirm before the failure counts as
 * shared: their latest sighted head each, newest first, never the current pull
 * request (another head of the same pull request is not a second pull request).
 * Pure.
 */
export function sharedCheckCandidates(
	observations: readonly CheckFailureObservation[],
	current: AffectedHead,
	checks: readonly string[],
): Map<string, AffectedHead[]> {
	const candidates = new Map<string, AffectedHead[]>();
	for (const check of checks) {
		const latest = new Map<string, CheckFailureObservation>();
		for (const observation of observations) {
			if (observation.checkName !== check || observation.prNumber === current.prNumber) continue;
			const seen = latest.get(observation.prNumber);
			if (!seen || observation.observedAt > seen.observedAt) {
				latest.set(observation.prNumber, observation);
			}
		}
		if (latest.size + 1 < MIN_SHARED_CHECK_PULL_REQUESTS) continue;
		candidates.set(
			check,
			[...latest.values()]
				.sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
				.map(({ prNumber, headSha }) => ({ prNumber, headSha })),
		);
	}
	return candidates;
}

/** The writes and reads this module makes, injectable for tests. */
export interface SharedCheckFailureDeps {
	recordCheckFailureObservations: typeof recordCheckFailureObservations;
	listRecentCheckFailureObservations: typeof listRecentCheckFailureObservations;
	findStandingEpisodes: typeof findStandingEpisodes;
	openEpisode: typeof openEpisode;
	claimEpisodeReport: typeof claimEpisodeReport;
	stampEpisodeBaseHead: typeof stampEpisodeBaseHead;
	createFailedRun: typeof createFailedRun;
}

// Wrapped rather than referenced, so a suite that mocks either repository module
// without these functions can still import this one.
const defaultDeps: SharedCheckFailureDeps = {
	recordCheckFailureObservations: (key, checks) => recordCheckFailureObservations(key, checks),
	listRecentCheckFailureObservations: (projectId, repository, checks, since) =>
		listRecentCheckFailureObservations(projectId, repository, checks, since),
	findStandingEpisodes: (projectId, repository, checks, openedAfter) =>
		findStandingEpisodes(projectId, repository, checks, openedAfter),
	openEpisode: (projectId, repository, check, expiredAtOrBefore) =>
		openEpisode(projectId, repository, check, expiredAtOrBefore),
	claimEpisodeReport: (episodeId) => claimEpisodeReport(episodeId),
	stampEpisodeBaseHead: (episodeId, baseHeadSha) => stampEpisodeBaseHead(episodeId, baseHeadSha),
	createFailedRun: (input) => createFailedRun(input),
};

export interface NoteAdjudicatedCheckFailuresInput {
	/** Scoped to the pull request's repository. */
	project: ProjectConfig;
	scm: Pick<SCMProvider, 'getPullRequest' | 'describeFailedCheckAttempts' | 'getBranchHead'>;
	prNumber: string;
	/** The approved head whose red was adjudicated. */
	headSha: string;
	failedChecks: string[];
	/** The payload a dashboard "Retry now" on the report run rebuilds its dispatch from. */
	jobPayload?: SwarmJob;
}

/**
 * Record this adjudicated red approved head's failing checks, detect any that fail
 * on several pull requests, open and report each such episode once, and answer the
 * checks a standing episode covers. Throws what the database throws — the policy
 * catches it and falls open to its per-head behaviour.
 */
export async function noteAdjudicatedCheckFailures(
	input: NoteAdjudicatedCheckFailuresInput,
	deps: SharedCheckFailureDeps = defaultDeps,
): Promise<Set<string>> {
	const { project, prNumber, headSha } = input;
	const checks = [...new Set(input.failedChecks)];
	const shared = new Set<string>();
	if (checks.length === 0) return shared;

	const key: CheckFailureHeadKey = {
		projectId: project.id,
		repository: project.repo,
		prNumber,
		headSha,
	};
	await deps.recordCheckFailureObservations(key, checks);

	const now = Date.now();
	const openedAfter = new Date(now - SHARED_CHECK_EPISODE_MAX_AGE_MS);
	const standing = await deps.findStandingEpisodes(project.id, project.repo, checks, openedAfter);
	for (const episode of standing) {
		shared.add(episode.checkName);
		logger.info('shared check failure: another pull request fails a check already reported', {
			prNumber,
			headSha,
			check: episode.checkName,
			episodeOpenedAt: episode.openedAt.toISOString(),
		});
	}

	const unshared = checks.filter((check) => !shared.has(check));
	if (unshared.length === 0) return shared;
	const observations = await deps.listRecentCheckFailureObservations(
		project.id,
		project.repo,
		unshared,
		new Date(now - SHARED_CHECK_WINDOW_MS),
	);
	const current: AffectedHead = { prNumber, headSha };
	for (const [check, others] of sharedCheckCandidates(observations, current, unshared)) {
		const confirmed = await confirmOpenHeads(input, others.slice(0, MAX_SHARED_CHECK_PROBES));
		if (confirmed.length + 1 < MIN_SHARED_CHECK_PULL_REQUESTS) continue;
		const { episode, created } = await deps.openEpisode(
			project.id,
			project.repo,
			check,
			openedAfter,
		);
		if (created) await stampOpeningBaseHead(input, episode.id, deps);
		shared.add(check);
		if (!(await deps.claimEpisodeReport(episode.id))) {
			logger.info('shared check failure: already reported by another caller', {
				prNumber,
				headSha,
				check,
			});
			continue;
		}
		await reportSharedCheckFailure(input, check, [current, ...confirmed], deps);
	}
	return shared;
}

/**
 * Record the base branch's head a new episode opened against (issue #1471), which
 * is what a later base-branch-health pass compares the base with. Best-effort:
 * a failed read or write leaves it `null`, and the next pass stamps it instead.
 */
async function stampOpeningBaseHead(
	input: NoteAdjudicatedCheckFailuresInput,
	episodeId: string,
	deps: SharedCheckFailureDeps,
): Promise<void> {
	const { project } = input;
	try {
		const baseHeadSha = await input.scm.getBranchHead(project, project.baseBranch, 'reviewer');
		if (baseHeadSha) await deps.stampEpisodeBaseHead(episodeId, baseHeadSha);
	} catch (err) {
		logger.warn('shared check failure: could not record the base head the episode opened on', {
			episodeId,
			baseBranch: project.baseBranch,
			error: describeError(err),
		});
	}
}

/**
 * The other heads still open on the head they were sighted on. One provider read
 * each; a read that fails drops that pull request (fail closed).
 */
async function confirmOpenHeads(
	input: NoteAdjudicatedCheckFailuresInput,
	others: readonly AffectedHead[],
): Promise<AffectedHead[]> {
	const confirmed: AffectedHead[] = [];
	for (const other of others) {
		try {
			const pr = await input.scm.getPullRequest(input.project, Number(other.prNumber));
			if (pr.state === 'open' && pr.headSha === other.headSha) confirmed.push(other);
		} catch (err) {
			logger.warn('shared check failure: could not read another pull request — not counting it', {
				prNumber: other.prNumber,
				headSha: other.headSha,
				error: describeError(err),
			});
		}
	}
	return confirmed;
}

/**
 * The once-only report: one structured error log and one durable `failed`
 * Respond-to-CI run anchored on the pull request whose sighting completed the
 * detection. Each write is best-effort and logs its own failure, on
 * `handToOperator`'s posture — the claim is already spent, so a failed write is
 * not retried.
 */
async function reportSharedCheckFailure(
	input: NoteAdjudicatedCheckFailuresInput,
	check: string,
	affected: readonly AffectedHead[],
	deps: SharedCheckFailureDeps,
): Promise<void> {
	const { project, prNumber } = input;
	const runners = await describeSharedRunners(input, check, affected);
	const prNumbers = affected.map((head) => head.prNumber);
	logger.error('shared check failure: one check fails on several approved pull requests', {
		projectId: project.id,
		repository: project.repo,
		check,
		pullRequests: affected.map((head) => ({ prNumber: head.prNumber, headSha: head.headSha })),
		...(runners ? { runners } : {}),
	});

	const heads = affected.map((head) => `#${head.prNumber} (${head.headSha})`).join(', ');
	try {
		await deps.createFailedRun({
			projectId: project.id,
			repository: project.repo,
			taskId: `${prNumber}-ci`,
			phase: 'respond-to-ci',
			prNumber,
			...(input.jobPayload ? { jobPayload: input.jobPayload } : {}),
			// The durable marker that this run is a deliberate hand-off, so Resolve
			// problem never attempts it (issue #1462).
			failureDiagnosis: operatorHandoffDiagnosis({
				kind: 'shared-check-failure',
				check,
				prNumbers,
			}),
			error:
				`Shared check failure: check ${check} fails on ${affected.length} approved pull ` +
				`requests in ${project.repo} at once: ${heads}. SWARM's CI agent judged it unrelated ` +
				'to each of them, so SWARM reported it once here and stopped re-running it and ' +
				`notifying on those pull requests.${runners ? ` ${runners}` : ''} Fix or de-flake the ` +
				"check on the base branch, or re-run a pull request's checks by hand — SWARM merges " +
				'an approved head once its checks pass.',
		});
	} catch (err) {
		logger.error('shared check failure: failed to record the report run', {
			prNumber,
			check,
			error: describeError(err),
		});
	}
}

/**
 * Where each affected head's failed attempts of `check` ran, as one sentence per
 * head — and, when every attempt across them ran on one runner, that said plainly.
 * `null` when no attempt names a runner. A provider read that throws drops that
 * head's account.
 */
async function describeSharedRunners(
	input: NoteAdjudicatedCheckFailuresInput,
	check: string,
	affected: readonly AffectedHead[],
): Promise<string | null> {
	const perHead: { head: AffectedHead; attempts: CheckAttemptRunner[] }[] = [];
	for (const head of affected) {
		try {
			const attempts = await input.scm.describeFailedCheckAttempts(input.project, head.headSha);
			perHead.push({ head, attempts: attempts.filter((attempt) => attempt.check === check) });
		} catch (err) {
			logger.warn('shared check failure: could not read the runners of the failed attempts', {
				prNumber: head.prNumber,
				headSha: head.headSha,
				error: describeError(err),
			});
		}
	}
	return summarizeSharedRunners(perHead);
}

/** {@link describeSharedRunners}' wording, pure. Exported for tests. */
export function summarizeSharedRunners(
	perHead: readonly { head: AffectedHead; attempts: readonly CheckAttemptRunner[] }[],
): string | null {
	const all = perHead.flatMap(({ attempts }) => attempts);
	if (!all.some((attempt) => attempt.runner !== null)) return null;
	const accounts = perHead
		.filter(({ attempts }) => attempts.length > 0)
		.map(({ head, attempts }) => {
			const list = [...attempts]
				.sort((a, b) => a.attempt - b.attempt)
				.map(
					({ attempt, runner }) =>
						`attempt ${attempt} ${runner === null ? 'runner not reported' : `\`${runner}\``}`,
				)
				.join(', ');
			return `#${head.prNumber}: ${list}`;
		})
		.join('; ');
	const runners = new Set(all.map((attempt) => attempt.runner));
	const [onlyRunner] = runners;
	const allOnOne =
		all.length > 1 && runners.size === 1 && onlyRunner
			? ` All ${all.length} failed attempts ran on one runner, \`${onlyRunner}\`.`
			: '';
	return `The failed attempts ran on: ${accounts}.${allOnOne}`;
}

/** The reads and writes {@link resumeSharedCheckFailures} makes, injectable for tests. */
export interface SharedCheckResumeDeps {
	listStandingEpisodesForRepository: typeof listStandingEpisodesForRepository;
	stampEpisodeBaseHead: typeof stampEpisodeBaseHead;
	resolveEpisode: typeof resolveEpisode;
	listEpisodeAffectedHeads: typeof listEpisodeAffectedHeads;
	getApprovedHeadSlot: typeof getApprovedHeadSlot;
}

const defaultResumeDeps: SharedCheckResumeDeps = {
	listStandingEpisodesForRepository: (projectId, repository, openedAfter) =>
		listStandingEpisodesForRepository(projectId, repository, openedAfter),
	stampEpisodeBaseHead: (episodeId, baseHeadSha) => stampEpisodeBaseHead(episodeId, baseHeadSha),
	resolveEpisode: (episodeId, resolution) => resolveEpisode(episodeId, resolution),
	listEpisodeAffectedHeads: (projectId, repository, checkName, since) =>
		listEpisodeAffectedHeads(projectId, repository, checkName, since),
	getApprovedHeadSlot: (key) => getApprovedHeadSlot(key),
};

/** One affected head handed to merge automation, as {@link ResumeSharedCheckFailuresInput.resumeMerge} takes it. */
export interface ResumeAffectedHead extends AffectedHead {
	episodeId: string;
	project: ProjectConfig;
}

export interface ResumeSharedCheckFailuresInput {
	/** Scoped to the repository whose base branch was just read. */
	project: ProjectConfig;
	scm: Pick<SCMProvider, 'getPullRequest'>;
	/** The base branch's head this pass read. */
	baseHeadSha: string;
	/** Whether this pass read the base branch red — a red base resumes nothing. */
	baseRed: boolean;
	/**
	 * Merge automation's resume (`resumeMergeAutomationAfterBaseAdvance`,
	 * `src/worker/merge-automation.ts`) — injected by the sweep rather than imported,
	 * since merge automation already depends on this module through the approved-head
	 * re-run policy (the type-only import above is erased at runtime). Expected never
	 * to throw: a failure comes back as `failed`, which — like `dispatch-active` —
	 * leaves the head unsettled, so the episode keeps standing and the next pass
	 * tries it again.
	 */
	resumeMerge: (head: ResumeAffectedHead) => Promise<MergeResumeResult>;
}

/**
 * The answers that leave an affected head for the next pass rather than settling
 * it: the dispatch could not be written, or the approving run still has one due
 * (which may yet be refused without the resume flag).
 */
const UNSETTLED_RESUME_RESULTS: ReadonlySet<MergeResumeResult> = new Set([
	'failed',
	'dispatch-active',
]);

/**
 * The base-branch-health sweep's half of a shared check failure (issue #1471):
 * for each standing episode of this repository —
 *
 * - no base head recorded yet → record this one, and resume nothing;
 * - the base head is still the recorded one → nothing;
 * - the base moved on but is red → nothing: base-blocked attribution (issue #873)
 *   owns a red base, and the episode keeps standing;
 * - the base moved on and is not red → try each affected approved pull request
 *   once more ({@link resumeAffectedHeads}), and only once every head is settled
 *   resolve the episode `base-advanced`. Resuming first is what keeps a transient
 *   failure (a provider read, a dispatch write, the affected-heads read itself)
 *   from losing a head for good: the episode keeps standing and the next pass
 *   retries, while `merge-resume:<episodeId>:<reviewRunId>` keeps a head already
 *   resumed — by an earlier pass, or a concurrent one — from being resumed again.
 *   The retries are bounded by the episode's own age: past
 *   {@link SHARED_CHECK_EPISODE_MAX_AGE_MS} it no longer stands.
 *
 * Never throws: each episode is handled on its own and a failure is logged, so
 * the sweep pass carries on.
 */
export async function resumeSharedCheckFailures(
	input: ResumeSharedCheckFailuresInput,
	deps: SharedCheckResumeDeps = defaultResumeDeps,
): Promise<void> {
	const { project, baseHeadSha } = input;
	let episodes: StandingSharedCheckFailureEpisode[];
	try {
		episodes = await deps.listStandingEpisodesForRepository(
			project.id,
			project.repo,
			new Date(Date.now() - SHARED_CHECK_EPISODE_MAX_AGE_MS),
		);
	} catch (err) {
		logger.warn('shared check failure: could not read the standing episodes', {
			projectId: project.id,
			repository: project.repo,
			error: describeError(err),
		});
		return;
	}
	for (const episode of episodes) {
		const context = {
			projectId: project.id,
			repository: project.repo,
			episodeId: episode.id,
			check: episode.checkName,
			baseHeadSha,
		};
		try {
			if (episode.baseHeadSha === null) {
				await deps.stampEpisodeBaseHead(episode.id, baseHeadSha);
				continue;
			}
			if (episode.baseHeadSha === baseHeadSha) continue;
			if (input.baseRed) {
				logger.debug('shared check failure: the base moved on but is red — episode stands', {
					...context,
					episodeBaseHeadSha: episode.baseHeadSha,
				});
				continue;
			}
			logger.info('shared check failure: the base advanced — resuming affected heads', {
				...context,
				episodeBaseHeadSha: episode.baseHeadSha,
			});
			if (!(await resumeAffectedHeads(input, episode, deps))) {
				logger.warn(
					'shared check failure: an affected head could not be settled — episode stands, retrying next pass',
					context,
				);
				continue;
			}
			if (await deps.resolveEpisode(episode.id, 'base-advanced')) {
				logger.info('shared check failure: resolved base-advanced', context);
			}
		} catch (err) {
			logger.warn('shared check failure: could not act on the base advancing', {
				...context,
				error: describeError(err),
			});
		}
	}
}

/**
 * Try each head an episode covered once more, before it is resolved
 * `base-advanced`: only a pull request still open on the very head it was sighted
 * failing on (one provider read), and only one SWARM has not already handed to the
 * operator — the #1128 notice is the operator's, not something a base push undoes.
 *
 * Answers whether every head is **settled** — resumed, already resumed, closed,
 * moved to another head, handed to the operator, or with no stopped approval to
 * resume — so the caller may resolve the episode. A head whose read throws, or
 * whose resume answers `failed` / `dispatch-active`, is unsettled: the loop still
 * carries on to the other heads, but the episode keeps standing for the next pass.
 * A throw from reading the affected heads themselves reaches the caller, which
 * leaves the episode standing too.
 */
async function resumeAffectedHeads(
	input: ResumeSharedCheckFailuresInput,
	episode: StandingSharedCheckFailureEpisode,
	deps: SharedCheckResumeDeps,
): Promise<boolean> {
	const { project } = input;
	let settled = true;
	const heads = await deps.listEpisodeAffectedHeads(
		project.id,
		project.repo,
		episode.checkName,
		new Date(episode.openedAt.getTime() - SHARED_CHECK_WINDOW_MS),
	);
	for (const head of heads) {
		const context = { episodeId: episode.id, prNumber: head.prNumber, headSha: head.headSha };
		try {
			const pr = await input.scm.getPullRequest(project, Number(head.prNumber), 'reviewer');
			if (pr.state !== 'open' || pr.headSha !== head.headSha) {
				logger.debug('shared check failure: affected pull request moved on — not resuming', {
					...context,
					state: pr.state,
					currentHeadSha: pr.headSha,
				});
				continue;
			}
			const slot = await deps.getApprovedHeadSlot({
				projectId: project.id,
				repository: project.repo,
				prNumber: head.prNumber,
				headSha: head.headSha,
			});
			if (slot?.operatorNotifiedAt) {
				logger.debug('shared check failure: head already handed to the operator — not resuming', {
					...context,
				});
				continue;
			}
			const result = await input.resumeMerge({ ...head, episodeId: episode.id, project });
			if (UNSETTLED_RESUME_RESULTS.has(result)) {
				logger.warn('shared check failure: affected pull request not resumed this pass', {
					...context,
					result,
				});
				settled = false;
			}
		} catch (err) {
			logger.warn('shared check failure: could not resume an affected pull request', {
				...context,
				error: describeError(err),
			});
			settled = false;
		}
	}
	return settled;
}
