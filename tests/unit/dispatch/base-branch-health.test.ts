import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig, ProjectRecord } from '@/config/schema.js';
import type { ScmDeliveryProvider } from '@/scm/delivery.js';
import type { AggregateCheckStatus, CommitPullRequest, ScmPersona } from '@/scm/types.js';

const { loggerError, loggerWarn, loggerDebug } = vi.hoisted(() => ({
	loggerError: vi.fn(),
	loggerWarn: vi.fn(),
	loggerDebug: vi.fn(),
}));
vi.mock('@/lib/logger.js', () => ({
	logger: { error: loggerError, warn: loggerWarn, debug: loggerDebug, info: vi.fn() },
}));

const requireProjectSCMProvider = vi.fn((_project: ProjectConfig) => SCM);
vi.mock('@/integrations/scm/registry.js', () => ({
	requireProjectSCMProvider: (project: ProjectConfig) => requireProjectSCMProvider(project),
	// Also read by `ProjectConfigSchema`'s per-provider credential check (issue #628);
	// an empty registry skips it, which is what this suite's fixtures expect.
	listSCMProviders: () => [],
}));

const listAllProjectRecordsFromDb = vi.fn<() => Promise<ProjectRecord[]>>(async () => []);
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	listAllProjectRecordsFromDb: () => listAllProjectRecordsFromDb(),
}));

import {
	baseBranchRedDeliveryId,
	readBaseBranchHealth,
	sweepBaseBranchHealth,
} from '@/dispatch/base-branch-health.js';
import {
	createFakeScmProvider,
	createMockProjectConfig,
	createMockProjectRepositoryPair,
	toProjectRecord,
} from '../../helpers/factories.js';

const PROJECT = createMockProjectConfig();

const getBranchHead =
	vi.fn<(project: ProjectConfig, branch: string, persona?: ScmPersona) => Promise<string | null>>();
const getAggregateCheckStatus =
	vi.fn<
		(project: ProjectConfig, ref: string, persona?: ScmPersona) => Promise<AggregateCheckStatus>
	>();
const listPullRequestsForCommit =
	vi.fn<
		(project: ProjectConfig, sha: string, persona?: ScmPersona) => Promise<CommitPullRequest[]>
	>();
const postComment = vi.fn<ScmDeliveryProvider['postComment']>(async () => 1);
const deliveryProvider = vi.fn(
	async (_project: ProjectConfig, _persona: ScmPersona) =>
		({ postComment }) as unknown as ScmDeliveryProvider,
);
const SCM = createFakeScmProvider({
	getBranchHead,
	getAggregateCheckStatus,
	listPullRequestsForCommit,
	deliveryProvider,
});

function checks(runs: AggregateCheckStatus['checkRuns']): AggregateCheckStatus {
	return { totalCount: runs.length, checkRuns: runs };
}

const GREEN = checks([{ name: 'build', status: 'completed', conclusion: 'success' }]);
const RED = checks([
	{ name: 'build', status: 'completed', conclusion: 'success' },
	{ name: 'unit', status: 'completed', conclusion: 'failure' },
]);

/** The body of the one comment the sweep posted. */
function postedBody(): string {
	expect(postComment).toHaveBeenCalledTimes(1);
	return postComment.mock.calls[0][0].body;
}

beforeEach(() => {
	loggerError.mockClear();
	loggerWarn.mockClear();
	loggerDebug.mockClear();
	listAllProjectRecordsFromDb.mockResolvedValue([toProjectRecord(PROJECT)]);
	requireProjectSCMProvider.mockReturnValue(SCM);
	getBranchHead.mockReset().mockResolvedValue('base-head-sha');
	getAggregateCheckStatus.mockReset().mockResolvedValue(GREEN);
	listPullRequestsForCommit
		.mockReset()
		.mockResolvedValue([{ number: 77, headBranch: 'issue-77', state: 'closed' }]);
	deliveryProvider.mockClear();
	postComment.mockClear().mockResolvedValue(1);
});

describe('baseBranchRedDeliveryId', () => {
	it('is deterministic for the same (project, base branch, head)', () => {
		expect(baseBranchRedDeliveryId(PROJECT, 'abc123')).toBe(
			baseBranchRedDeliveryId(PROJECT, 'abc123'),
		);
	});

	it('differs at a new head SHA — a new red base is a new incident', () => {
		expect(baseBranchRedDeliveryId(PROJECT, 'abc123')).not.toBe(
			baseBranchRedDeliveryId(PROJECT, 'def456'),
		);
	});

	// Two repositories of one project (issue #685): a shared key would have the
	// second repository's red base absorbed as an already-delivered repeat.
	it('differs across two repositories of one project', () => {
		const [android, backend] = createMockProjectRepositoryPair();
		expect(baseBranchRedDeliveryId(android, 'abc123')).not.toBe(
			baseBranchRedDeliveryId(backend, 'abc123'),
		);
	});

	it('never contains a colon (BullMQ reserves it for key namespacing)', () => {
		expect(baseBranchRedDeliveryId(PROJECT, 'abc123')).not.toContain(':');
	});
});

describe('readBaseBranchHealth', () => {
	it('reports green when every check completed and none failed', async () => {
		await expect(readBaseBranchHealth(PROJECT, SCM)).resolves.toEqual({
			status: 'green',
			headSha: 'base-head-sha',
		});
		expect(getBranchHead).toHaveBeenCalledWith(PROJECT, PROJECT.baseBranch, 'implementer');
		expect(getAggregateCheckStatus).toHaveBeenCalledWith(PROJECT, 'base-head-sha', 'implementer');
	});

	it('reports red with exactly the failing check names', async () => {
		getAggregateCheckStatus.mockResolvedValue(RED);

		await expect(readBaseBranchHealth(PROJECT, SCM)).resolves.toEqual({
			status: 'red',
			headSha: 'base-head-sha',
			failedChecks: ['unit'],
		});
	});

	it('reports unsettled while a check is still running', async () => {
		getAggregateCheckStatus.mockResolvedValue(
			checks([{ name: 'build', status: 'in_progress', conclusion: null }]),
		);

		await expect(readBaseBranchHealth(PROJECT, SCM)).resolves.toEqual({
			status: 'unsettled',
			headSha: 'base-head-sha',
		});
	});

	// The shared classifier is what judges this, under the project's own policy —
	// the base branch and a pull request are never judged by two different rules.
	it('reports unsettled for zero checks under the default `required` policy', async () => {
		getAggregateCheckStatus.mockResolvedValue(checks([]));

		await expect(readBaseBranchHealth(PROJECT, SCM)).resolves.toEqual({
			status: 'unsettled',
			headSha: 'base-head-sha',
		});
	});

	it("reports green for zero checks under the project's `if-present` policy", async () => {
		getAggregateCheckStatus.mockResolvedValue(checks([]));
		const project = createMockProjectConfig({
			pipeline: {
				...PROJECT.pipeline,
				review: { ...PROJECT.pipeline?.review, checks: 'if-present' },
			},
		});

		await expect(readBaseBranchHealth(project, SCM)).resolves.toEqual({
			status: 'green',
			headSha: 'base-head-sha',
		});
	});

	it('reports unknown when the branch head read throws, without reading checks', async () => {
		getBranchHead.mockRejectedValue(new Error('404 not found'));

		const health = await readBaseBranchHealth(PROJECT, SCM);

		expect(health.status).toBe('unknown');
		expect(health).toMatchObject({ reason: expect.stringContaining('404 not found') });
		expect(getAggregateCheckStatus).not.toHaveBeenCalled();
	});

	it('reports unknown when the provider names no head commit, without reading checks', async () => {
		getBranchHead.mockResolvedValue(null);

		const health = await readBaseBranchHealth(PROJECT, SCM);

		expect(health.status).toBe('unknown');
		expect(getAggregateCheckStatus).not.toHaveBeenCalled();
	});

	it('reports unknown when the aggregate check read throws', async () => {
		getAggregateCheckStatus.mockRejectedValue(new Error('provider unreachable'));

		const health = await readBaseBranchHealth(PROJECT, SCM);

		expect(health.status).toBe('unknown');
		expect(health).toMatchObject({ reason: expect.stringContaining('provider unreachable') });
	});
});

describe('sweepBaseBranchHealth', () => {
	it('says nothing at all about a green base branch', async () => {
		await sweepBaseBranchHealth();

		expect(loggerError).not.toHaveBeenCalled();
		expect(listPullRequestsForCommit).not.toHaveBeenCalled();
		expect(postComment).not.toHaveBeenCalled();
	});

	describe('when the base branch is red', () => {
		beforeEach(() => {
			getAggregateCheckStatus.mockResolvedValue(RED);
		});

		it('logs one structured error naming the repository, base branch, head and failures', async () => {
			await sweepBaseBranchHealth();

			expect(loggerError).toHaveBeenCalledTimes(1);
			expect(loggerError).toHaveBeenCalledWith(
				'base branch health: the base branch is red',
				expect.objectContaining({
					projectId: PROJECT.id,
					repository: PROJECT.repo,
					baseBranch: PROJECT.baseBranch,
					headSha: 'base-head-sha',
					failedChecks: ['unit'],
				}),
			);
		});

		it('comments once on the pull request whose merge produced the head', async () => {
			await sweepBaseBranchHealth();

			expect(listPullRequestsForCommit).toHaveBeenCalledWith(
				PROJECT,
				'base-head-sha',
				'implementer',
			);
			expect(deliveryProvider).toHaveBeenCalledWith(PROJECT, 'implementer');
			expect(postComment).toHaveBeenCalledTimes(1);
			expect(postComment.mock.calls[0][0]).toMatchObject({
				prNumber: 77,
				deliveryId: baseBranchRedDeliveryId(PROJECT, 'base-head-sha'),
			});
		});

		it('names the base branch, the short SHA and the failing checks in the comment', async () => {
			await sweepBaseBranchHealth();

			const body = postedBody();
			expect(body).toContain(`\`${PROJECT.baseBranch}\``);
			expect(body).toContain('`base-he`');
			expect(body).toContain('`unit`');
			expect(body).toContain('Open pull requests build the merge of their head with this base');
			// Load-bearing: ingress drops the resulting comment event on this footer.
			expect(body).toContain('_Generated by SWARM');
		});

		// The once-only property this module owns; the idempotence itself belongs to
		// the delivery provider, which matches on the id.
		it('reuses one delivery id across passes at the same head and mints a new one at a new head', async () => {
			await sweepBaseBranchHealth();
			await sweepBaseBranchHealth();
			expect(postComment.mock.calls[0][0].deliveryId).toBe(postComment.mock.calls[1][0].deliveryId);

			getBranchHead.mockResolvedValue('second-head-sha');
			await sweepBaseBranchHealth();
			expect(postComment.mock.calls[2][0].deliveryId).not.toBe(
				postComment.mock.calls[0][0].deliveryId,
			);
		});

		it('logs only when no pull request produced the base head', async () => {
			listPullRequestsForCommit.mockResolvedValue([]);

			await expect(sweepBaseBranchHealth()).resolves.toBeUndefined();

			expect(loggerError).toHaveBeenCalledTimes(1);
			expect(postComment).not.toHaveBeenCalled();
		});

		it('warns and continues when the comment cannot be delivered', async () => {
			postComment.mockRejectedValue(new Error('comment rejected'));

			await expect(sweepBaseBranchHealth()).resolves.toBeUndefined();

			expect(loggerError).toHaveBeenCalledTimes(1);
			expect(loggerWarn).toHaveBeenCalledWith(
				'base branch health: could not post the red-base notice',
				expect.objectContaining({ prNumber: '77' }),
			);
		});
	});

	it('skips a repository whose SCM provider does not resolve and sweeps the next project', async () => {
		const other = createMockProjectConfig({ id: 'other', name: 'other', repo: 'acme/other' });
		listAllProjectRecordsFromDb.mockResolvedValue([
			toProjectRecord(PROJECT),
			toProjectRecord(other),
		]);
		requireProjectSCMProvider.mockImplementationOnce(() => {
			throw new Error('project names no scm');
		});

		await sweepBaseBranchHealth();

		expect(getBranchHead).toHaveBeenCalledTimes(1);
		expect(getBranchHead.mock.calls[0][0].repo).toBe(other.repo);
	});

	// Issue #685: a project spans repositories, and each has its own base branch.
	it('reads each repository of a multi-repository project with that repository’s scoped config', async () => {
		const [android, backend] = createMockProjectRepositoryPair();
		listAllProjectRecordsFromDb.mockResolvedValue([
			// One record with both repositories — what `scopeProjectToRepository` splits.
			{
				...toProjectRecord(android),
				repositories: [
					...toProjectRecord(android).repositories,
					...toProjectRecord(backend).repositories,
				],
			},
		]);

		await sweepBaseBranchHealth();

		expect(getBranchHead).toHaveBeenCalledTimes(2);
		expect(getBranchHead.mock.calls.map((call) => call[0].repo)).toEqual([
			android.repo,
			backend.repo,
		]);
	});

	it('warns rather than reporting when the base branch cannot be read', async () => {
		getBranchHead.mockRejectedValue(new Error('provider unreachable'));

		await expect(sweepBaseBranchHealth()).resolves.toBeUndefined();

		expect(loggerError).not.toHaveBeenCalled();
		expect(loggerWarn).toHaveBeenCalledWith(
			'base branch health: could not read the base branch this pass',
			expect.objectContaining({ repository: PROJECT.repo }),
		);
	});

	// An unhandled rejection out of the bare `setInterval` callback would take the
	// router down, so the entry point resolves whatever fails inside it.
	it('resolves rather than rejecting when the project read itself throws', async () => {
		listAllProjectRecordsFromDb.mockRejectedValue(new Error('database down'));

		await expect(sweepBaseBranchHealth()).resolves.toBeUndefined();

		expect(loggerError).toHaveBeenCalledWith(
			'base branch health: sweep failed (continuing)',
			expect.objectContaining({ error: expect.stringContaining('database down') }),
		);
	});
});
