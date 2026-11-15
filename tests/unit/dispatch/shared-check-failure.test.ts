import { beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger.js', () => ({ logger }));

import type { ProjectConfig } from '@/config/schema.js';
import type {
	CheckFailureObservation,
	SharedCheckFailureEpisode,
	StandingSharedCheckFailureEpisode,
} from '@/db/repositories/sharedCheckFailuresRepository.js';
import {
	MAX_SHARED_CHECK_PROBES,
	type NoteAdjudicatedCheckFailuresInput,
	noteAdjudicatedCheckFailures,
	type ResumeAffectedHead,
	type ResumeSharedCheckFailuresInput,
	resumeSharedCheckFailures,
	SHARED_CHECK_EPISODE_MAX_AGE_MS,
	SHARED_CHECK_WINDOW_MS,
	type SharedCheckFailureDeps,
	type SharedCheckResumeDeps,
	sharedCheckCandidates,
	summarizeSharedRunners,
} from '@/dispatch/shared-check-failure.js';
import type { CheckAttemptRunner, PullRequestDetails } from '@/scm/types.js';
import type { MergeResumeResult } from '@/worker/merge-automation.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const PROJECT = createMockProjectConfig({ autoMerge: true });
const NOW = new Date('2026-11-15T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function observation(
	prNumber: string,
	headSha: string,
	agoMs = 0,
	checkName = 'Verify',
): CheckFailureObservation {
	return { checkName, prNumber, headSha, observedAt: new Date(NOW.getTime() - agoMs) };
}

function pullRequest(overrides: Partial<PullRequestDetails> = {}): PullRequestDetails {
	return {
		number: 1,
		headBranch: 'b',
		headSha: 'h',
		baseBranch: 'main',
		baseSha: 'base',
		mergeable: true,
		authorLogin: null,
		state: 'open',
		...overrides,
	} as PullRequestDetails;
}

describe('sharedCheckCandidates', () => {
	const current = { prNumber: '10', headSha: 'h10' };

	it('finds nothing for a pull request failing on its own', () => {
		expect(sharedCheckCandidates([observation('10', 'h10')], current, ['Verify']).size).toBe(0);
	});

	it('names the other pull request failing the same check', () => {
		const found = sharedCheckCandidates(
			[observation('10', 'h10'), observation('11', 'h11')],
			current,
			['Verify'],
		);
		expect(found.get('Verify')).toEqual([{ prNumber: '11', headSha: 'h11' }]);
	});

	it('counts two heads of the same pull request once — and never as a second one', () => {
		expect(
			sharedCheckCandidates([observation('10', 'old'), observation('10', 'h10')], current, [
				'Verify',
			]).size,
		).toBe(0);
		const found = sharedCheckCandidates(
			[observation('11', 'old', HOUR), observation('11', 'new')],
			current,
			['Verify'],
		);
		expect(found.get('Verify')).toEqual([{ prNumber: '11', headSha: 'new' }]);
	});

	it('does not mix checks', () => {
		expect(
			sharedCheckCandidates([observation('11', 'h11', 0, 'lint')], current, ['Verify']).size,
		).toBe(0);
	});
});

describe('noteAdjudicatedCheckFailures', () => {
	const EPISODE: SharedCheckFailureEpisode = {
		id: 'episode-1',
		checkName: 'Verify',
		openedAt: NOW,
		reportedAt: null,
	};
	let deps: {
		[K in keyof SharedCheckFailureDeps]: ReturnType<typeof vi.fn> & SharedCheckFailureDeps[K];
	};
	const getPullRequest = vi.fn(async (_p: ProjectConfig, n: number) =>
		pullRequest({ number: n, headSha: `h${n}` }),
	);
	const describeFailedCheckAttempts = vi.fn(
		async (_p: ProjectConfig, _ref: string): Promise<CheckAttemptRunner[]> => [],
	);
	const getBranchHead = vi.fn(async (_p: ProjectConfig, _branch: string, _persona?: string) =>
		Promise.resolve<string | null>('base-1'),
	);

	function input(
		overrides: Partial<NoteAdjudicatedCheckFailuresInput> = {},
	): NoteAdjudicatedCheckFailuresInput {
		return {
			project: PROJECT,
			scm: { getPullRequest, describeFailedCheckAttempts, getBranchHead },
			prNumber: '10',
			headSha: 'h10',
			failedChecks: ['Verify'],
			...overrides,
		};
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		logger.info.mockClear();
		logger.error.mockClear();
		getPullRequest.mockClear();
		describeFailedCheckAttempts.mockReset();
		describeFailedCheckAttempts.mockResolvedValue([]);
		getBranchHead.mockReset();
		getBranchHead.mockResolvedValue('base-1');
		deps = {
			recordCheckFailureObservations: vi.fn(async () => {}),
			listRecentCheckFailureObservations: vi.fn(async () => [
				observation('10', 'h10'),
				observation('11', 'h11'),
			]),
			findStandingEpisodes: vi.fn(async () => []),
			openEpisode: vi.fn(async () => ({ episode: EPISODE, created: true })),
			claimEpisodeReport: vi.fn(async () => true),
			stampEpisodeBaseHead: vi.fn(async () => true),
			createFailedRun: vi.fn(async () => 'run-report'),
		} as unknown as typeof deps;
	});

	it('records the sighting and stays per-head for a pull request failing on its own', async () => {
		deps.listRecentCheckFailureObservations.mockResolvedValue([observation('10', 'h10')]);
		const shared = await noteAdjudicatedCheckFailures(input(), deps);
		expect(shared.size).toBe(0);
		expect(deps.recordCheckFailureObservations).toHaveBeenCalledWith(
			{ projectId: PROJECT.id, repository: PROJECT.repo, prNumber: '10', headSha: 'h10' },
			['Verify'],
		);
		expect(deps.listRecentCheckFailureObservations).toHaveBeenCalledWith(
			PROJECT.id,
			PROJECT.repo,
			['Verify'],
			new Date(NOW.getTime() - SHARED_CHECK_WINDOW_MS),
		);
		expect(getPullRequest).not.toHaveBeenCalled();
		expect(deps.openEpisode).not.toHaveBeenCalled();
		expect(deps.createFailedRun).not.toHaveBeenCalled();
	});

	it('opens one episode and reports it once, naming the check and every pull request', async () => {
		const shared = await noteAdjudicatedCheckFailures(
			input({ jobPayload: { type: 'scm' } as never }),
			deps,
		);
		expect([...shared]).toEqual(['Verify']);
		expect(getPullRequest).toHaveBeenCalledWith(PROJECT, 11);
		expect(deps.openEpisode).toHaveBeenCalledWith(
			PROJECT.id,
			PROJECT.repo,
			'Verify',
			new Date(NOW.getTime() - SHARED_CHECK_EPISODE_MAX_AGE_MS),
		);
		expect(deps.createFailedRun).toHaveBeenCalledTimes(1);
		const run = deps.createFailedRun.mock.calls[0][0] as {
			taskId: string;
			phase: string;
			prNumber: string;
			error: string;
			jobPayload: unknown;
			failureDiagnosis: { kind: string; message: string };
		};
		expect(run).toMatchObject({ taskId: '10-ci', phase: 'respond-to-ci', prNumber: '10' });
		expect(run.jobPayload).toEqual({ type: 'scm' });
		expect(run.failureDiagnosis.kind).toBe('shared-check-failure');
		expect(run.failureDiagnosis.message).toContain('#10, #11');
		expect(run.error).toContain('check Verify fails on 2 approved pull requests');
		expect(run.error).toContain('#10 (h10), #11 (h11)');
		expect(run.error).not.toContain('ran on');
		expect(logger.error).toHaveBeenCalledWith(
			'shared check failure: one check fails on several approved pull requests',
			expect.objectContaining({
				check: 'Verify',
				pullRequests: [
					{ prNumber: '10', headSha: 'h10' },
					{ prNumber: '11', headSha: 'h11' },
				],
			}),
		);
	});

	it('records the base head a new episode opened against (issue #1471)', async () => {
		await noteAdjudicatedCheckFailures(input(), deps);
		expect(getBranchHead).toHaveBeenCalledWith(PROJECT, PROJECT.baseBranch, 'reviewer');
		expect(deps.stampEpisodeBaseHead).toHaveBeenCalledWith('episode-1', 'base-1');
	});

	it('does not stamp an episode another caller opened', async () => {
		deps.openEpisode.mockResolvedValue({ episode: EPISODE, created: false });
		await noteAdjudicatedCheckFailures(input(), deps);
		expect(getBranchHead).not.toHaveBeenCalled();
		expect(deps.stampEpisodeBaseHead).not.toHaveBeenCalled();
	});

	it('still opens and reports the episode when the base head cannot be read', async () => {
		getBranchHead.mockRejectedValue(new Error('provider down'));
		const shared = await noteAdjudicatedCheckFailures(input(), deps);
		expect([...shared]).toEqual(['Verify']);
		expect(deps.stampEpisodeBaseHead).not.toHaveBeenCalled();
		expect(deps.createFailedRun).toHaveBeenCalledTimes(1);
	});

	it('names the runners where the provider reports them', async () => {
		describeFailedCheckAttempts.mockImplementation(async (_p, ref) => [
			{ check: 'Verify', attempt: 1, runner: 'm5_pro_sm_1' },
			{ check: 'lint', attempt: 1, runner: 'other' },
			...(ref === 'h11' ? [{ check: 'Verify', attempt: 2, runner: 'm5_pro_sm_1' }] : []),
		]);
		await noteAdjudicatedCheckFailures(input(), deps);
		const run = deps.createFailedRun.mock.calls[0][0] as { error: string };
		expect(run.error).toContain(
			'The failed attempts ran on: #10: attempt 1 `m5_pro_sm_1`; #11: attempt 1 `m5_pro_sm_1`, attempt 2 `m5_pro_sm_1`.',
		);
		expect(run.error).toContain('All 3 failed attempts ran on one runner, `m5_pro_sm_1`.');
	});

	it('still reports when a runner read throws', async () => {
		describeFailedCheckAttempts.mockRejectedValue(new Error('provider down'));
		await noteAdjudicatedCheckFailures(input(), deps);
		expect(deps.createFailedRun).toHaveBeenCalledTimes(1);
	});

	it.each([
		['closed', pullRequest({ state: 'closed', headSha: 'h11' })],
		['moved to a new head', pullRequest({ headSha: 'newer' })],
	])('does not count another pull request that is %s', async (_name, pr) => {
		getPullRequest.mockResolvedValueOnce(pr);
		expect((await noteAdjudicatedCheckFailures(input(), deps)).size).toBe(0);
		expect(deps.openEpisode).not.toHaveBeenCalled();
	});

	it('does not count another pull request it cannot read (fail closed)', async () => {
		getPullRequest.mockRejectedValueOnce(new Error('502'));
		expect((await noteAdjudicatedCheckFailures(input(), deps)).size).toBe(0);
		expect(deps.openEpisode).not.toHaveBeenCalled();
	});

	it('reads at most the probe cap of other pull requests', async () => {
		deps.listRecentCheckFailureObservations.mockResolvedValue(
			Array.from({ length: MAX_SHARED_CHECK_PROBES + 5 }, (_, i) =>
				observation(String(100 + i), `h${100 + i}`, i),
			),
		);
		await noteAdjudicatedCheckFailures(input(), deps);
		expect(getPullRequest).toHaveBeenCalledTimes(MAX_SHARED_CHECK_PROBES);
	});

	it('writes nothing for the caller that loses the report claim', async () => {
		deps.claimEpisodeReport.mockResolvedValueOnce(true).mockResolvedValue(false);
		const first = await noteAdjudicatedCheckFailures(input(), deps);
		const second = await noteAdjudicatedCheckFailures(
			input({ prNumber: '11', headSha: 'h11' }),
			deps,
		);
		expect([...first]).toEqual(['Verify']);
		expect([...second]).toEqual(['Verify']);
		expect(deps.createFailedRun).toHaveBeenCalledTimes(1);
	});

	it('joins a standing episode without probing or reporting again', async () => {
		deps.findStandingEpisodes.mockResolvedValue([EPISODE]);
		const shared = await noteAdjudicatedCheckFailures(
			input({ prNumber: '12', headSha: 'h12' }),
			deps,
		);
		expect([...shared]).toEqual(['Verify']);
		expect(deps.findStandingEpisodes).toHaveBeenCalledWith(
			PROJECT.id,
			PROJECT.repo,
			['Verify'],
			new Date(NOW.getTime() - SHARED_CHECK_EPISODE_MAX_AGE_MS),
		);
		expect(deps.listRecentCheckFailureObservations).not.toHaveBeenCalled();
		expect(getPullRequest).not.toHaveBeenCalled();
		expect(deps.openEpisode).not.toHaveBeenCalled();
		expect(deps.createFailedRun).not.toHaveBeenCalled();
	});

	it('answers only the checks that are shared', async () => {
		deps.listRecentCheckFailureObservations.mockResolvedValue([
			observation('10', 'h10'),
			observation('11', 'h11'),
			observation('10', 'h10', 0, 'lint'),
		]);
		const shared = await noteAdjudicatedCheckFailures(
			input({ failedChecks: ['Verify', 'lint'] }),
			deps,
		);
		expect([...shared]).toEqual(['Verify']);
	});

	it('does nothing for a head that names no failing check', async () => {
		expect((await noteAdjudicatedCheckFailures(input({ failedChecks: [] }), deps)).size).toBe(0);
		expect(deps.recordCheckFailureObservations).not.toHaveBeenCalled();
	});
});

describe('summarizeSharedRunners', () => {
	it('is null when no attempt names a runner', () => {
		expect(
			summarizeSharedRunners([
				{
					head: { prNumber: '10', headSha: 'h10' },
					attempts: [{ check: 'Verify', attempt: 1, runner: null }],
				},
			]),
		).toBeNull();
	});

	it('does not claim one runner when the attempts ran on several', () => {
		const summary = summarizeSharedRunners([
			{
				head: { prNumber: '10', headSha: 'h10' },
				attempts: [{ check: 'Verify', attempt: 1, runner: 'a' }],
			},
			{
				head: { prNumber: '11', headSha: 'h11' },
				attempts: [{ check: 'Verify', attempt: 1, runner: 'b' }],
			},
		]);
		expect(summary).toBe('The failed attempts ran on: #10: attempt 1 `a`; #11: attempt 1 `b`.');
	});
});

describe('resumeSharedCheckFailures', () => {
	const OPENED_AT = new Date(NOW.getTime() - 2 * HOUR);
	function standing(
		overrides: Partial<StandingSharedCheckFailureEpisode> = {},
	): StandingSharedCheckFailureEpisode {
		return {
			id: 'episode-1',
			checkName: 'Verify',
			openedAt: OPENED_AT,
			reportedAt: OPENED_AT,
			baseHeadSha: 'base-1',
			...overrides,
		};
	}

	let deps: {
		[K in keyof SharedCheckResumeDeps]: ReturnType<typeof vi.fn> & SharedCheckResumeDeps[K];
	};
	const getPullRequest = vi.fn(async (_p: ProjectConfig, n: number, _persona?: string) =>
		pullRequest({ number: n, headSha: `h${n}` }),
	);
	// The real resume is deduplicated on `merge-resume:<episodeId>:<reviewRunId>`.
	const resumedHeads = new Set<string>();
	const resumeMerge = vi.fn(async (head: ResumeAffectedHead): Promise<MergeResumeResult> => {
		const key = `${head.episodeId}:${head.prNumber}`;
		if (resumedHeads.has(key)) return 'already-resumed';
		resumedHeads.add(key);
		return 'resumed';
	});

	function input(
		overrides: Partial<ResumeSharedCheckFailuresInput> = {},
	): ResumeSharedCheckFailuresInput {
		return {
			project: PROJECT,
			scm: { getPullRequest },
			baseHeadSha: 'base-2',
			baseRed: false,
			resumeMerge,
			...overrides,
		};
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		logger.warn.mockClear();
		getPullRequest.mockClear();
		resumeMerge.mockClear();
		resumedHeads.clear();
		const resolved = new Set<string>();
		deps = {
			// A resolved episode no longer stands (`resolved_at IS NULL`).
			listStandingEpisodesForRepository: vi.fn(async () =>
				[standing()].filter((episode) => !resolved.has(episode.id)),
			),
			stampEpisodeBaseHead: vi.fn(async () => true),
			// The real update is conditional on `resolved_at IS NULL`: one winner.
			resolveEpisode: vi.fn(async (id: string) => {
				if (resolved.has(id)) return false;
				resolved.add(id);
				return true;
			}),
			listEpisodeAffectedHeads: vi.fn(async () => [
				{ prNumber: '10', headSha: 'h10' },
				{ prNumber: '11', headSha: 'h11' },
			]),
			getApprovedHeadSlot: vi.fn(async () => ({
				checksRerunAt: null,
				checksRerunAttempts: 0,
				operatorNotifiedAt: null,
			})),
		} as unknown as typeof deps;
	});

	it('does nothing while the base head is the one the episode opened against', async () => {
		await resumeSharedCheckFailures(input({ baseHeadSha: 'base-1' }), deps);
		expect(deps.listStandingEpisodesForRepository).toHaveBeenCalledWith(
			PROJECT.id,
			PROJECT.repo,
			new Date(NOW.getTime() - SHARED_CHECK_EPISODE_MAX_AGE_MS),
		);
		expect(deps.resolveEpisode).not.toHaveBeenCalled();
		expect(resumeMerge).not.toHaveBeenCalled();
	});

	it('resumes each affected pull request once and then resolves the episode when the base advanced green', async () => {
		await resumeSharedCheckFailures(input(), deps);
		expect(deps.resolveEpisode).toHaveBeenCalledWith('episode-1', 'base-advanced');
		expect(resumeMerge.mock.invocationCallOrder.at(-1)).toBeLessThan(
			deps.resolveEpisode.mock.invocationCallOrder[0] ?? 0,
		);
		expect(deps.listEpisodeAffectedHeads).toHaveBeenCalledWith(
			PROJECT.id,
			PROJECT.repo,
			'Verify',
			new Date(OPENED_AT.getTime() - SHARED_CHECK_WINDOW_MS),
		);
		expect(getPullRequest).toHaveBeenCalledWith(PROJECT, 10, 'reviewer');
		expect(resumeMerge).toHaveBeenCalledTimes(2);
		expect(resumeMerge).toHaveBeenCalledWith({
			prNumber: '10',
			headSha: 'h10',
			episodeId: 'episode-1',
			project: PROJECT,
		});
		expect(resumeMerge).toHaveBeenCalledWith(
			expect.objectContaining({ prNumber: '11', headSha: 'h11' }),
		);

		// A later pass no longer sees the resolved episode and resumes nothing.
		await resumeSharedCheckFailures(input(), deps);
		expect(resumeMerge).toHaveBeenCalledTimes(2);
		expect(deps.resolveEpisode).toHaveBeenCalledTimes(1);
	});

	it('settles a head already resumed by another pass and still resolves', async () => {
		resumedHeads.add('episode-1:10');
		await resumeSharedCheckFailures(input(), deps);
		await expect(resumeMerge.mock.results[0]?.value).resolves.toBe('already-resumed');
		expect(deps.resolveEpisode).toHaveBeenCalledWith('episode-1', 'base-advanced');
	});

	it('leaves the episode standing when the base moved on but is red', async () => {
		await resumeSharedCheckFailures(input({ baseRed: true }), deps);
		expect(deps.resolveEpisode).not.toHaveBeenCalled();
		expect(resumeMerge).not.toHaveBeenCalled();
	});

	it('stamps an episode that has no base head yet and resumes nothing', async () => {
		deps.listStandingEpisodesForRepository.mockResolvedValue([standing({ baseHeadSha: null })]);
		await resumeSharedCheckFailures(input(), deps);
		expect(deps.stampEpisodeBaseHead).toHaveBeenCalledWith('episode-1', 'base-2');
		expect(deps.resolveEpisode).not.toHaveBeenCalled();
		expect(resumeMerge).not.toHaveBeenCalled();
	});

	it.each([
		['closed', pullRequest({ state: 'closed', headSha: 'h10' })],
		['moved to a new head', pullRequest({ headSha: 'newer' })],
	])('skips an affected pull request that is %s', async (_name, pr) => {
		getPullRequest.mockResolvedValueOnce(pr);
		await resumeSharedCheckFailures(input(), deps);
		expect(resumeMerge).toHaveBeenCalledTimes(1);
		expect(resumeMerge).toHaveBeenCalledWith(expect.objectContaining({ prNumber: '11' }));
	});

	it('skips a head SWARM already handed to the operator', async () => {
		deps.getApprovedHeadSlot.mockResolvedValueOnce({
			checksRerunAt: null,
			checksRerunAttempts: 3,
			operatorNotifiedAt: NOW,
		});
		await resumeSharedCheckFailures(input(), deps);
		expect(deps.getApprovedHeadSlot).toHaveBeenCalledWith({
			projectId: PROJECT.id,
			repository: PROJECT.repo,
			prNumber: '10',
			headSha: 'h10',
		});
		expect(resumeMerge).toHaveBeenCalledTimes(1);
		expect(resumeMerge).toHaveBeenCalledWith(expect.objectContaining({ prNumber: '11' }));
	});

	it('resumes the readable head, keeps the episode standing past a failed read, and finishes next pass', async () => {
		getPullRequest.mockRejectedValueOnce(new Error('502'));
		await resumeSharedCheckFailures(input(), deps);
		expect(resumeMerge).toHaveBeenCalledTimes(1);
		expect(resumeMerge).toHaveBeenCalledWith(expect.objectContaining({ prNumber: '11' }));
		expect(logger.warn).toHaveBeenCalledWith(
			'shared check failure: could not resume an affected pull request',
			expect.objectContaining({ prNumber: '10' }),
		);
		expect(deps.resolveEpisode).not.toHaveBeenCalled();

		// The read is healthy again: the remaining head is resumed, the other one is
		// already resumed (dedup), and the episode is resolved.
		await resumeSharedCheckFailures(input(), deps);
		expect(resumeMerge).toHaveBeenCalledTimes(3);
		expect(resumeMerge).toHaveBeenNthCalledWith(2, expect.objectContaining({ prNumber: '10' }));
		expect(deps.resolveEpisode).toHaveBeenCalledWith('episode-1', 'base-advanced');
	});

	it('keeps the episode standing when the affected heads cannot be read, and resumes them next pass', async () => {
		deps.listEpisodeAffectedHeads.mockRejectedValueOnce(new Error('db down'));
		await resumeSharedCheckFailures(input(), deps);
		expect(resumeMerge).not.toHaveBeenCalled();
		expect(deps.resolveEpisode).not.toHaveBeenCalled();

		await resumeSharedCheckFailures(input(), deps);
		expect(resumeMerge).toHaveBeenCalledTimes(2);
		expect(deps.resolveEpisode).toHaveBeenCalledWith('episode-1', 'base-advanced');
	});

	it.each([
		'failed',
		'dispatch-active',
	] as const)('keeps the episode standing when a resume answers %s', async (result) => {
		resumeMerge.mockResolvedValueOnce(result);
		await resumeSharedCheckFailures(input(), deps);
		expect(resumeMerge).toHaveBeenCalledTimes(2);
		expect(deps.resolveEpisode).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			'shared check failure: affected pull request not resumed this pass',
			expect.objectContaining({ prNumber: '10', result }),
		);
	});

	it.each([
		'auto-merge-off',
		'no-stopped-approval',
	] as const)('counts a resume answering %s as settled', async (result) => {
		resumeMerge.mockResolvedValueOnce(result);
		await resumeSharedCheckFailures(input(), deps);
		expect(deps.resolveEpisode).toHaveBeenCalledWith('episode-1', 'base-advanced');
	});

	it('handles each episode on its own and never throws', async () => {
		deps.listStandingEpisodesForRepository.mockResolvedValue([
			standing({ id: 'broken' }),
			standing({ id: 'episode-2', checkName: 'lint' }),
		]);
		deps.resolveEpisode.mockRejectedValueOnce(new Error('db down'));
		await expect(resumeSharedCheckFailures(input(), deps)).resolves.toBeUndefined();
		expect(resumeMerge).toHaveBeenCalledWith(expect.objectContaining({ episodeId: 'episode-2' }));
	});

	it('resolves rather than rejecting when the episodes cannot be read', async () => {
		deps.listStandingEpisodesForRepository.mockRejectedValue(new Error('db down'));
		await expect(resumeSharedCheckFailures(input(), deps)).resolves.toBeUndefined();
		expect(resumeMerge).not.toHaveBeenCalled();
	});
});
