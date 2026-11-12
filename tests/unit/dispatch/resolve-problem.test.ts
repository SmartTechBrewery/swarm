import { afterEach, describe, expect, it, vi } from 'vitest';

const createAndPublishDispatch = vi.fn(async (input: { jobPayload: unknown }) => ({
	dispatch: { id: 'dispatch-1', jobPayload: input.jobPayload },
	created: true,
}));
vi.mock('@/dispatch/dispatcher.js', () => ({
	createAndPublishDispatch: (input: { jobPayload: unknown }) => createAndPublishDispatch(input),
}));

const mintRunBoundAgentToken = vi.fn(async (_input: unknown) => ({ token: 'minted-token' }));
const revokeRunBoundAgentTokens = vi.fn(async (_runId: string) => 1);
vi.mock('@/identity/agent-access-token-service.js', () => ({
	mintRunBoundAgentToken: (input: unknown) => mintRunBoundAgentToken(input),
	revokeRunBoundAgentTokens: (runId: string) => revokeRunBoundAgentTokens(runId),
}));

import type { RunRow } from '@/db/repositories/runsRepository.js';
import {
	mintResolveProblemAccess,
	operatorMcpUrl,
	RESOLVE_PROBLEM_TOKEN_GRACE_MS,
	resolveProblemDedupKey,
	resolveProblemTicketDedupKey,
	resolveProblemTrigger,
	revokeResolveProblemAccess,
	scheduleResolveProblem,
	scheduleResolveProblemForTicket,
	verifyResolveProblemOutcome,
} from '@/dispatch/resolve-problem.js';
import type { AgentCliResult } from '@/harness/agent-cli.js';
import { AgentRunError } from '@/harness/agent-failure.js';
import type { ResolveProblemReport } from '@/pipeline/resolve-problem.js';
import type { ResolveProblemJob } from '@/queue/jobs.js';
import type { WipTicket } from '@/queue/wip-usage.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const PROJECT = createMockProjectConfig({
	pipeline: { resolveProblem: { enabled: true, maxWriteActions: 7 } },
});

const FAILED_RUN = {
	id: '11111111-1111-4111-8111-111111111111',
	projectId: PROJECT.id,
	repository: PROJECT.repo,
	taskId: '1395',
	phase: 'implementation',
	status: 'failed',
	prNumber: null,
	workItemId: 'PVTI_card',
	error: 'Agent did not write required hand-off implementation_handoff.json',
	failureDiagnosis: null,
} as unknown as RunRow;

const JOB: ResolveProblemJob = {
	type: 'resolve-problem',
	projectId: PROJECT.id,
	failedRunId: FAILED_RUN.id,
};

const AGENT: AgentCliResult = {
	cli: 'claude',
	exitCode: 0,
	signal: null,
	stdout: '',
	stderr: '',
	durationMs: 10,
	timedOut: false,
	aborted: false,
	outputTruncated: false,
};

const REPORT: ResolveProblemReport = {
	outcome: 'resolved',
	bugReportId: 'report-1',
	actions: [{ tool: 'run_reset', target: FAILED_RUN.id, result: 'restarted' }],
	summary: 'The checkout was wedged; a reset restarted the phase.',
};

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe('scheduleResolveProblem (issue #1395)', () => {
	it('dispatches a resolve-problem job deduplicated on the failed run, never on the task', async () => {
		await scheduleResolveProblem(FAILED_RUN);
		expect(createAndPublishDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT.id,
				dedupKey: `resolve-problem:${FAILED_RUN.id}`,
				phase: 'resolve-problem',
				jobPayload: {
					type: 'resolve-problem',
					projectId: PROJECT.id,
					failedRunId: FAILED_RUN.id,
					repository: PROJECT.repo,
				},
			}),
		);
		expect(createAndPublishDispatch.mock.calls[0][0]).not.toHaveProperty('taskId');
		expect(resolveProblemDedupKey('x')).toBe('resolve-problem:x');
	});
});

describe('resolveProblemTrigger', () => {
	const readRun = (run: RunRow | undefined) => async () => run;

	it("resolves the phase's inputs from the failed run", async () => {
		expect(await resolveProblemTrigger(JOB, PROJECT, readRun(FAILED_RUN))).toEqual({
			phase: 'resolve-problem',
			taskId: '1395',
			failedRunId: FAILED_RUN.id,
			workItemId: 'PVTI_card',
			failedRun: {
				id: FAILED_RUN.id,
				phase: 'implementation',
				taskId: '1395',
				prNumber: null,
				error: FAILED_RUN.error,
				failureDiagnosis: null,
			},
		});
	});

	it('skips when the project has not turned the phase on', async () => {
		const project = createMockProjectConfig();
		expect(await resolveProblemTrigger(JOB, project, readRun(FAILED_RUN))).toEqual({
			skip: expect.stringContaining('not enabled'),
		});
	});

	it('skips a run that is gone, belongs elsewhere, is no longer failed, or is itself an attempt', async () => {
		expect(await resolveProblemTrigger(JOB, PROJECT, readRun(undefined))).toHaveProperty('skip');
		expect(
			await resolveProblemTrigger(
				JOB,
				PROJECT,
				readRun({ ...FAILED_RUN, projectId: 'other' } as RunRow),
			),
		).toHaveProperty('skip');
		expect(
			await resolveProblemTrigger(
				JOB,
				PROJECT,
				readRun({ ...FAILED_RUN, status: 'running' } as RunRow),
			),
		).toEqual({ skip: expect.stringContaining('is running, not failed'), taskId: '1395' });
		expect(
			await resolveProblemTrigger(
				JOB,
				PROJECT,
				readRun({ ...FAILED_RUN, phase: 'resolve-problem' } as RunRow),
			),
		).toEqual({
			skip: expect.stringContaining('itself a Resolve problem attempt'),
			taskId: '1395',
		});
	});
});

describe('scheduleResolveProblemForTicket (issue #1425)', () => {
	const SLOT = {
		projectId: PROJECT.id,
		repository: PROJECT.repo,
		taskId: '1425',
		slotOpenedAt: '2026-11-10T08:00:00.000Z',
	};

	it('keys a ticket that ran on its latest run — the key a run attempt on it takes', async () => {
		await scheduleResolveProblemForTicket({
			...SLOT,
			latestRunId: FAILED_RUN.id,
			prNumber: '42',
			workItemId: 'PVTI_card',
		});
		expect(createAndPublishDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT.id,
				dedupKey: resolveProblemDedupKey(FAILED_RUN.id),
				phase: 'resolve-problem',
				source: 'synthetic',
				jobPayload: {
					type: 'resolve-problem',
					projectId: PROJECT.id,
					repository: PROJECT.repo,
					failedRunId: FAILED_RUN.id,
					ticket: {
						taskId: '1425',
						reason: 'stalled',
						slotOpenedAt: SLOT.slotOpenedAt,
						prNumber: '42',
						workItemId: 'PVTI_card',
					},
				},
			}),
		);
		expect(createAndPublishDispatch.mock.calls[0][0]).not.toHaveProperty('taskId');
	});

	it('keys a ticket that never ran on its slot, so a re-opened slot is a new situation', async () => {
		await scheduleResolveProblemForTicket(SLOT);
		const input = createAndPublishDispatch.mock.calls[0][0] as {
			dedupKey: string;
			jobPayload: ResolveProblemJob;
		};
		expect(input.dedupKey).toBe(
			`resolve-problem:slot:${PROJECT.id}:${PROJECT.repo}:1425:${Date.parse(SLOT.slotOpenedAt)}`,
		);
		expect(input.jobPayload).not.toHaveProperty('failedRunId');
		expect(
			resolveProblemTicketDedupKey({ ...SLOT, slotOpenedAt: '2026-11-11T08:00:00Z' }),
		).not.toBe(input.dedupKey);
	});
});

describe('resolveProblemTrigger — ticket attempts (issue #1425)', () => {
	const OPENED_AT = '2026-11-10T08:00:00.000Z';
	const NOW = new Date('2026-11-12T08:00:00Z');
	const ANCHOR = {
		...FAILED_RUN,
		taskId: '1425',
		phase: 'review',
		status: 'completed',
		resetStartedAt: null,
		nextRetryAt: null,
	} as unknown as RunRow;
	const HELD: WipTicket = {
		taskId: '1425',
		workItemId: 'PVTI_card',
		openedPhase: 'implementation',
		openedAt: OPENED_AT,
		state: 'waiting-on-operator',
		operatorReason: 'stalled',
		phase: 'review',
		prNumber: '42',
		latestRunId: ANCHOR.id,
		lastActivityAt: '2026-11-10T09:00:00.000Z',
	};
	const TICKET_JOB: ResolveProblemJob = {
		type: 'resolve-problem',
		projectId: PROJECT.id,
		repository: PROJECT.repo,
		failedRunId: ANCHOR.id,
		ticket: { taskId: '1425', reason: 'stalled', slotOpenedAt: OPENED_AT },
	};
	const resolve = (
		held: WipTicket | undefined,
		anchor: RunRow | undefined = ANCHOR,
		job: ResolveProblemJob = TICKET_JOB,
	) =>
		resolveProblemTrigger(
			job,
			PROJECT,
			async () => anchor,
			async () => held,
			() => NOW,
		);

	it('returns the ticket and its latest run while the ticket is unchanged', async () => {
		expect(await resolve(HELD)).toEqual({
			phase: 'resolve-problem',
			taskId: '1425',
			failedRunId: ANCHOR.id,
			prNumber: '42',
			workItemId: 'PVTI_card',
			failedRun: {
				id: ANCHOR.id,
				phase: 'review',
				taskId: '1425',
				prNumber: null,
				error: ANCHOR.error,
				failureDiagnosis: null,
			},
			ticket: {
				taskId: '1425',
				repository: PROJECT.repo,
				reason: 'stalled',
				slotOpenedAt: OPENED_AT,
				lastActivityAt: HELD.lastActivityAt,
				prNumber: '42',
				workItemId: 'PVTI_card',
			},
		});
	});

	it('runs a ticket that never ran without an anchor', async () => {
		const { latestRunId: _, lastActivityAt: __, ...neverRan } = HELD;
		const { failedRunId: ___, ...job } = TICKET_JOB;
		const readRun = vi.fn(async () => ANCHOR);
		const trigger = await resolveProblemTrigger(
			job,
			PROJECT,
			readRun,
			async () => neverRan,
			() => NOW,
		);
		expect(trigger).toMatchObject({ phase: 'resolve-problem', taskId: '1425' });
		expect(trigger).not.toHaveProperty('failedRunId');
		expect(trigger).not.toHaveProperty('failedRun');
		expect(readRun).not.toHaveBeenCalled();
	});

	it.each([
		['the ticket left its slot', undefined, /no longer holds a WIP slot/],
		['it is running again', { ...HELD, state: 'running' as const }, /is running again/],
		[
			'it waits on the pipeline again',
			{ ...HELD, state: 'waiting-on-pipeline' as const, operatorReason: undefined },
			/is waiting-on-pipeline again/,
		],
		[
			'it now waits for an excluded reason',
			{ ...HELD, operatorReason: 'review-cap-reached' as const },
			/review-cap-reached: The review cap is a safety stop/,
		],
		['a newer run moved it', { ...HELD, latestRunId: 'run-newer' }, /has moved/],
		[
			'it took a new slot',
			{ ...HELD, openedAt: '2026-11-11T08:00:00.000Z' },
			/took a new WIP slot/,
		],
	])('skips when %s', async (_label, held, message) => {
		expect(await resolve(held)).toEqual({ skip: expect.stringMatching(message), taskId: '1425' });
	});

	it('skips while its anchor run is being Reset or retries by itself', async () => {
		expect(
			await resolve(HELD, { ...ANCHOR, resetStartedAt: new Date('2026-11-12T07:00:00Z') }),
		).toEqual({ skip: expect.stringContaining('being Reset'), taskId: '1425' });
		expect(
			await resolve(HELD, { ...ANCHOR, nextRetryAt: new Date('2026-11-12T09:00:00Z') }),
		).toEqual({ skip: expect.stringContaining('retry of its own'), taskId: '1425' });
		expect(await resolve(HELD, { ...ANCHOR, phase: 'resolve-problem' })).toEqual({
			skip: expect.stringContaining('itself a Resolve problem attempt'),
			taskId: '1425',
		});
	});

	it('skips a dispatch that names neither a failed run nor a ticket', async () => {
		const { failedRunId: _, ...bare } = JOB;
		expect(await resolveProblemTrigger(bare, PROJECT, async () => FAILED_RUN)).toEqual({
			skip: expect.stringContaining('neither a failed run nor a ticket'),
		});
	});
});

describe('mintResolveProblemAccess / revokeResolveProblemAccess', () => {
	it("mints a token held by the worker's owner, scoped to the project and run, capped and short-lived", async () => {
		vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', 'https://swarm.example.com/');
		const access = await mintResolveProblemAccess({
			project: PROJECT,
			runId: 'run-resolve',
			holderUserId: 'owner-1',
			timeoutMs: 60_000,
		});
		expect(access).toEqual({
			url: 'https://swarm.example.com/operator/mcp',
			token: 'minted-token',
		});
		expect(mintRunBoundAgentToken).toHaveBeenCalledWith({
			holderUserId: 'owner-1',
			projectId: PROJECT.id,
			runId: 'run-resolve',
			maxWriteActions: 7,
			ttlMs: 60_000 + RESOLVE_PROBLEM_TOKEN_GRACE_MS,
		});
	});

	it('leaves the URL to the worker when no public base URL is configured', async () => {
		vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', '');
		expect(operatorMcpUrl()).toBeUndefined();
		expect(
			await mintResolveProblemAccess({
				project: PROJECT,
				runId: 'run-resolve',
				holderUserId: 'owner-1',
				timeoutMs: 1,
			}),
		).toEqual({ token: 'minted-token' });
	});

	it('refuses to mint an unbound token for a run with no row', async () => {
		await expect(
			mintResolveProblemAccess({
				project: PROJECT,
				runId: undefined,
				holderUserId: 'owner-1',
				timeoutMs: 1,
			}),
		).rejects.toBeInstanceOf(AgentRunError);
		expect(mintRunBoundAgentToken).not.toHaveBeenCalled();
	});

	it('revokes the run tokens and swallows a failure to', async () => {
		await revokeResolveProblemAccess('run-resolve');
		expect(revokeRunBoundAgentTokens).toHaveBeenCalledWith('run-resolve');
		revokeRunBoundAgentTokens.mockRejectedValueOnce(new Error('db down'));
		await expect(revokeResolveProblemAccess('run-resolve')).resolves.toBeUndefined();
		await revokeResolveProblemAccess(undefined);
		expect(revokeRunBoundAgentTokens).toHaveBeenCalledTimes(2);
	});
});

describe('verifyResolveProblemOutcome', () => {
	const filed = vi.fn(async (_runId: string) => ({ id: 'occ-1', reportId: 'report-1' }));
	const none = vi.fn(async (_runId: string) => undefined);

	async function failureOf(promise: Promise<unknown>): Promise<AgentRunError> {
		const error = await promise.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(AgentRunError);
		expect((error as AgentRunError).failure.kind).toBe('error');
		return error as AgentRunError;
	}

	it('succeeds on a resolved report backed by a bug report the run filed', async () => {
		await expect(
			verifyResolveProblemOutcome({ runId: 'run-resolve', report: REPORT, agent: AGENT }, filed),
		).resolves.toEqual({});
		expect(filed).toHaveBeenCalledWith('run-resolve');
	});

	it('settles an already-resolved report as a success with its explanation as the headline (issue #1441)', async () => {
		const settle = await verifyResolveProblemOutcome(
			{
				runId: 'run-resolve',
				report: {
					...REPORT,
					outcome: 'already-resolved',
					actions: [],
					summary: 'PR #2219 was merged outside SWARM at head abc123.',
				},
				agent: AGENT,
			},
			filed,
		);
		expect(settle.headline).toBe(
			'Resolve problem found nothing left to resolve — the failed run was already fixed: PR #2219 was merged outside SWARM at head abc123. Tried: no recovery action.',
		);
	});

	it('names a stuck ticket in an already-resolved headline (issue #1441)', async () => {
		const settle = await verifyResolveProblemOutcome(
			{
				runId: 'run-resolve',
				report: { ...REPORT, outcome: 'already-resolved', summary: 'PR #7 was closed.' },
				agent: AGENT,
				subject: 'ticket',
			},
			filed,
		);
		expect(settle.headline).toContain('the stuck ticket was already fixed: PR #7 was closed.');
		expect(settle.headline).toContain(`run_reset on ${FAILED_RUN.id} → restarted`);
	});

	it('fails an already-resolved report that filed no bug report (issue #1441)', async () => {
		const error = await failureOf(
			verifyResolveProblemOutcome(
				{
					runId: 'run-resolve',
					report: { ...REPORT, outcome: 'already-resolved', summary: 'PR #2219 was merged.' },
					agent: AGENT,
				},
				none,
			),
		);
		expect(error.message).toContain('filed no bug report');
	});

	it('fails an unresolved report with its summary and the actions it tried', async () => {
		const error = await failureOf(
			verifyResolveProblemOutcome(
				{
					runId: 'run-resolve',
					report: { ...REPORT, outcome: 'unresolved', summary: 'The review cap stopped it.' },
					agent: AGENT,
				},
				filed,
			),
		);
		expect(error.message).toContain('could not resolve the failed run: The review cap stopped it.');
		expect(error.message).toContain(`run_reset on ${FAILED_RUN.id} → restarted`);
	});

	it('names a stuck ticket as the subject of an unresolved ticket attempt (issue #1425)', async () => {
		const error = await failureOf(
			verifyResolveProblemOutcome(
				{
					runId: 'run-resolve',
					report: { ...REPORT, outcome: 'unresolved', summary: 'The card needs a move.' },
					agent: AGENT,
					subject: 'ticket',
				},
				filed,
			),
		);
		expect(error.message).toContain('could not resolve the stuck ticket: The card needs a move.');
	});

	it('fails a run that filed no bug report, even one claiming success', async () => {
		const error = await failureOf(
			verifyResolveProblemOutcome({ runId: 'run-resolve', report: REPORT, agent: AGENT }, none),
		);
		expect(error.message).toContain('filed no bug report');
	});

	it('fails a run that handed back no report', async () => {
		const error = await failureOf(
			verifyResolveProblemOutcome({ runId: 'run-resolve', report: undefined, agent: AGENT }, filed),
		);
		expect(error.message).toContain('without a report');
	});
});
