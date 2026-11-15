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
	RESOLVE_PROBLEM_HANDED_OFF_PREFIX,
	RESOLVE_PROBLEM_TOKEN_GRACE_MS,
	type ReadRedHeadAtClaim,
	resolveProblemAnchorCancelled,
	resolveProblemAnchorHandedOff,
	resolveProblemDedupKey,
	resolveProblemTicketDedupKey,
	resolveProblemTrigger,
	revokeResolveProblemAccess,
	scheduleResolveProblem,
	scheduleResolveProblemForRedHead,
	scheduleResolveProblemForTicket,
	verifyResolveProblemOutcome,
} from '@/dispatch/resolve-problem.js';
import type { AgentCliResult } from '@/harness/agent-cli.js';
import { AgentRunError } from '@/harness/agent-failure.js';
import { RED_HEAD_BUG_REPORT_TITLE } from '@/pipeline/prompts/resolve-problem.js';
import type { ResolveProblemReport } from '@/pipeline/resolve-problem.js';
import type { ResolveProblemJob } from '@/queue/jobs.js';
import type { WipTicket } from '@/queue/wip-usage.js';
import { diagnoseFailure, operatorHandoffDiagnosis } from '@/worker/failure-diagnosis.js';
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

/** The two deliberate hand-offs SWARM writes to a person (issue #1462). */
const HANDOFF_DIAGNOSES = [
	operatorHandoffDiagnosis({
		kind: 'approved-head-needs-operator',
		prNumber: '42',
		headSha: 'abc123',
		failedChecks: ['integration'],
	}),
	operatorHandoffDiagnosis({
		kind: 'ci-fix-attempts-exhausted',
		prNumber: '42',
		attempt: 4,
		maxAttempts: 3,
	}),
];

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

	it('skips a failed run an operator cancelled, and still resolves one nobody did (issue #1453)', async () => {
		const cancelled = {
			...FAILED_RUN,
			cancellation: { source: 'board-backlog', requestedAt: '2026-11-12T07:00:00.000Z' },
		} as RunRow;
		expect(await resolveProblemTrigger(JOB, PROJECT, readRun(cancelled))).toEqual({
			skip: expect.stringContaining('cancelled by an operator (board-backlog)'),
			taskId: '1395',
		});
		expect(
			await resolveProblemTrigger(
				JOB,
				PROJECT,
				readRun({ ...FAILED_RUN, cancellation: null } as RunRow),
			),
		).toMatchObject({ phase: 'resolve-problem', failedRunId: FAILED_RUN.id });
	});

	it.each(
		HANDOFF_DIAGNOSES.map((diagnosis) => [diagnosis.kind, diagnosis] as const),
	)('skips a failed run SWARM wrote as a deliberate hand-off (%s, issue #1462)', async (_kind, failureDiagnosis) => {
		expect(
			await resolveProblemTrigger(
				JOB,
				PROJECT,
				readRun({ ...FAILED_RUN, failureDiagnosis } as RunRow),
			),
		).toEqual({
			skip: `Run ${FAILED_RUN.id} is a deliberate hand-off to a person (${failureDiagnosis.title}) — Resolve problem does not attempt it`,
			taskId: '1395',
		});
	});

	it('still resolves an ordinary failed run — with no diagnosis or any other kind (issue #1462)', async () => {
		for (const failureDiagnosis of [
			null,
			diagnoseFailure({ knownCondition: 'provider-rate-limit' }),
		]) {
			expect(
				await resolveProblemTrigger(
					JOB,
					PROJECT,
					readRun({ ...FAILED_RUN, failureDiagnosis } as RunRow),
				),
			).toMatchObject({ phase: 'resolve-problem', failedRunId: FAILED_RUN.id });
		}
	});
});

describe('resolveProblemAnchorHandedOff (issue #1462)', () => {
	it('names a deliberate hand-off, and nothing for an ordinary failure', () => {
		for (const failureDiagnosis of HANDOFF_DIAGNOSES) {
			expect(resolveProblemAnchorHandedOff({ id: 'run-1', failureDiagnosis })).toBe(
				`Run run-1 is a deliberate hand-off to a person (${failureDiagnosis.title}) — Resolve problem does not attempt it`,
			);
		}
		expect(resolveProblemAnchorHandedOff({ id: 'run-1', failureDiagnosis: null })).toBeUndefined();
		expect(
			resolveProblemAnchorHandedOff({
				id: 'run-1',
				failureDiagnosis: diagnoseFailure({ knownCondition: 'user-terminated' }) ?? null,
			}),
		).toBeUndefined();
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

describe('resolveProblemAnchorCancelled (issue #1453)', () => {
	it('names the recorded origin of an operator cancellation, and nothing without one', () => {
		expect(resolveProblemAnchorCancelled({ id: 'run-1', cancellation: null })).toBeUndefined();
		for (const source of ['dashboard', 'api', 'board-backlog'] as const) {
			expect(
				resolveProblemAnchorCancelled({
					id: 'run-1',
					cancellation: { source, requestedAt: '2026-11-12T07:00:00.000Z' },
				}),
			).toBe(`Run run-1 was cancelled by an operator (${source}) — restarting it is their call`);
		}
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

	it('skips when an operator cancelled its anchor run (issue #1453)', async () => {
		expect(
			await resolve(HELD, {
				...ANCHOR,
				status: 'failed',
				cancellation: { source: 'dashboard', requestedAt: '2026-11-12T07:00:00.000Z' },
			}),
		).toEqual({
			skip: expect.stringContaining('cancelled by an operator (dashboard)'),
			taskId: '1425',
		});
	});

	it('skips when its anchor run is a deliberate hand-off to a person (issue #1462)', async () => {
		expect(
			await resolve(HELD, { ...ANCHOR, status: 'failed', failureDiagnosis: HANDOFF_DIAGNOSES[1] }),
		).toEqual({
			skip: expect.stringContaining('deliberate hand-off to a person (CI fix attempts exhausted)'),
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
		).resolves.toEqual({ outcome: 'resolved' });
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
		expect(settle).toEqual({
			outcome: 'already-resolved',
			headline:
				'Resolve problem found nothing left to resolve — the failed run was already fixed: PR #2219 was merged outside SWARM at head abc123. Tried: no recovery action.',
		});
	});

	it('settles a handed-off report as a success whose headline says what a person must do (issue #1462)', async () => {
		const settle = await verifyResolveProblemOutcome(
			{
				runId: 'run-resolve',
				report: {
					...REPORT,
					outcome: 'handed-off',
					actions: [],
					summary: 'Force re-review PR #7: the review-verdict cap stopped it on purpose.',
				},
				agent: AGENT,
			},
			filed,
		);
		expect(settle).toEqual({
			outcome: 'handed-off',
			headline:
				'Resolve problem handed the failed run to a person — Force re-review PR #7: the review-verdict cap stopped it on purpose. Tried: no recovery action.',
		});
		expect(settle.headline?.startsWith(RESOLVE_PROBLEM_HANDED_OFF_PREFIX)).toBe(true);
	});

	it('names the subject of a handed-off ticket attempt (issue #1462)', async () => {
		const settle = await verifyResolveProblemOutcome(
			{
				runId: 'run-resolve',
				report: { ...REPORT, outcome: 'handed-off', summary: 'Move the card to Ready.' },
				agent: AGENT,
				subject: 'ticket',
			},
			filed,
		);
		expect(settle.headline).toContain(
			'handed the stuck ticket to a person — Move the card to Ready.',
		);
	});

	it('fails a handed-off report that filed no bug report (issue #1462)', async () => {
		const error = await failureOf(
			verifyResolveProblemOutcome(
				{
					runId: 'run-resolve',
					report: { ...REPORT, outcome: 'handed-off', summary: 'Re-run the failed job.' },
					agent: AGENT,
				},
				none,
			),
		);
		expect(error.message).toContain('filed no bug report');
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

describe('scheduleResolveProblemForRedHead (issue #1459)', () => {
	it('anchors the attempt on the latest run and deduplicates it on the head', async () => {
		await scheduleResolveProblemForRedHead({
			projectId: PROJECT.id,
			repository: PROJECT.repo,
			prNumber: '2401',
			latestRunId: FAILED_RUN.id,
			taskId: '2401-ci',
			workItemId: 'card',
			headSha: 'abc123',
			failedChecks: ['integration'],
		});
		expect(createAndPublishDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT.id,
				dedupKey: `resolve-problem:red-head:${PROJECT.id}:${PROJECT.repo}:2401:abc123`,
				phase: 'resolve-problem',
				source: 'synthetic',
				jobPayload: {
					type: 'resolve-problem',
					projectId: PROJECT.id,
					repository: PROJECT.repo,
					failedRunId: FAILED_RUN.id,
					redHead: {
						prNumber: '2401',
						headSha: 'abc123',
						taskId: '2401-ci',
						failedChecks: ['integration'],
						workItemId: 'card',
					},
				},
			}),
		);
	});
});

describe('resolveProblemTrigger — red-head attempts (issue #1459)', () => {
	const ANCHOR = {
		...FAILED_RUN,
		phase: 'respond-to-ci',
		status: 'completed',
		taskId: '2401-ci',
		prNumber: '2401',
		error: null,
	} as unknown as RunRow;
	const RED_JOB: ResolveProblemJob = {
		type: 'resolve-problem',
		projectId: PROJECT.id,
		repository: PROJECT.repo,
		failedRunId: ANCHOR.id,
		redHead: {
			prNumber: '2401',
			headSha: 'abc123',
			taskId: '2401-ci',
			failedChecks: ['stale-name'],
			workItemId: 'card',
		},
	};
	const NOW = new Date('2026-11-15T12:20:00Z');
	const readRun = (run: RunRow | undefined) => async () => run;
	const noTicket = vi.fn(async () => undefined);
	const red =
		(result: Awaited<ReturnType<ReadRedHeadAtClaim>>): ReadRedHeadAtClaim =>
		async () =>
			result;
	const claim = (readRedHead: ReadRedHeadAtClaim, run: RunRow | undefined = ANCHOR) =>
		resolveProblemTrigger(RED_JOB, PROJECT, readRun(run), noTicket, () => NOW, readRedHead);

	it('runs while the head is still red and unhandled, with the fresh failing checks', async () => {
		const readRedHead = vi.fn(
			red({ probe: { state: 'red', headSha: 'abc123', failedChecks: ['integration'] } }),
		);
		expect(await claim(readRedHead)).toEqual({
			phase: 'resolve-problem',
			taskId: '2401-ci',
			failedRunId: ANCHOR.id,
			failedRun: {
				id: ANCHOR.id,
				phase: 'respond-to-ci',
				taskId: '2401-ci',
				prNumber: '2401',
				error: null,
				failureDiagnosis: null,
			},
			prNumber: '2401',
			workItemId: 'card',
			redHead: {
				repository: PROJECT.repo,
				prNumber: '2401',
				headSha: 'abc123',
				taskId: '2401-ci',
				failedChecks: ['integration'],
				workItemId: 'card',
			},
		});
		expect(readRedHead).toHaveBeenCalledWith(PROJECT, '2401', NOW);
		expect(noTicket).not.toHaveBeenCalled();
	});

	it('skips a pull request that closed, moved on, went green or is still running', async () => {
		expect(await claim(red({ probe: { state: 'not-open' } }))).toMatchObject({
			skip: expect.stringContaining('no longer open'),
			taskId: '2401-ci',
		});
		expect(
			await claim(red({ probe: { state: 'red', headSha: 'def456', failedChecks: [] } })),
		).toMatchObject({ skip: expect.stringContaining('moved from head abc123 to def456') });
		expect(
			await claim(red({ probe: { state: 'not-red', headSha: 'abc123', checks: 'review' } })),
		).toMatchObject({ skip: expect.stringContaining('no longer red (its checks are green)') });
		expect(
			await claim(red({ probe: { state: 'not-red', headSha: 'abc123', checks: 'defer' } })),
		).toMatchObject({ skip: expect.stringContaining('running') });
	});

	it('skips a head something now handles — an operator hand-off, a settling re-run', async () => {
		const handled = red({
			probe: { state: 'red', headSha: 'abc123', failedChecks: ['integration'] },
			handled: 'SWARM already handed approved head abc123 to the operator',
		});
		expect(await claim(handled)).toEqual({
			skip: 'SWARM already handed approved head abc123 to the operator',
			taskId: '2401-ci',
		});
	});

	it('skips while its anchor run is cancelled, being Reset or gone — before any provider read', async () => {
		const readRedHead = vi.fn(red({ probe: { state: 'not-open' } }));
		const cancelled = { ...ANCHOR, cancellation: { source: 'dashboard' } } as unknown as RunRow;
		const reset = { ...ANCHOR, resetStartedAt: NOW } as unknown as RunRow;
		expect(await claim(readRedHead, cancelled)).toMatchObject({
			skip: expect.stringContaining('cancelled by an operator'),
		});
		expect(await claim(readRedHead, reset)).toMatchObject({
			skip: expect.stringContaining('being Reset'),
		});
		const handedOff = { ...ANCHOR, failureDiagnosis: HANDOFF_DIAGNOSES[0] } as unknown as RunRow;
		expect(await claim(readRedHead, handedOff)).toMatchObject({
			skip: expect.stringContaining('deliberate hand-off to a person'),
		});
		expect(
			await resolveProblemTrigger(
				RED_JOB,
				PROJECT,
				readRun(undefined),
				noTicket,
				() => NOW,
				readRedHead,
			),
		).toMatchObject({
			skip: expect.stringContaining('does not exist'),
		});
		expect(readRedHead).not.toHaveBeenCalled();
	});

	it('skips, rather than fails, when the provider cannot be read', async () => {
		const unreadable: ReadRedHeadAtClaim = async () => {
			throw new Error('502');
		};
		expect(await claim(unreadable)).toMatchObject({
			skip: expect.stringContaining('could not be read'),
		});
	});

	it('skips a red-head dispatch that names no repository', async () => {
		const { repository: _repository, ...job } = RED_JOB;
		expect(
			await resolveProblemTrigger(job, PROJECT, readRun(ANCHOR), noTicket, () => NOW),
		).toMatchObject({ skip: expect.stringContaining('names no repository') });
	});
});

describe('verifyResolveProblemOutcome — red-head attempts (issue #1459)', () => {
	const filed = vi.fn(async (_runId: string) => ({ id: 'occ-1', reportId: 'report-1' }));
	const report = (title: string) => vi.fn(async (_id: string) => ({ title }));
	const verify = (outcome: ResolveProblemReport['outcome'], title: string) =>
		verifyResolveProblemOutcome(
			{ runId: 'run-resolve', report: { ...REPORT, outcome }, agent: AGENT, subject: 'red-head' },
			filed,
			report(title),
		);

	it('fails an attempt that recorded its occurrence on any other report than the class one', async () => {
		const error = await verify('resolved', 'Some other problem').catch((err: unknown) => err);
		expect(error).toBeInstanceOf(AgentRunError);
		expect((error as AgentRunError).message).toContain(
			`must land on the report titled "${RED_HEAD_BUG_REPORT_TITLE}"`,
		);
	});

	it('fails a handed-off attempt recorded on any other report than the class one (issue #1462)', async () => {
		const error = await verify('handed-off', 'Some other problem').catch((err: unknown) => err);
		expect(error).toBeInstanceOf(AgentRunError);
		expect((error as AgentRunError).message).toContain(
			`must land on the report titled "${RED_HEAD_BUG_REPORT_TITLE}"`,
		);
	});

	it('accepts the class report, and keeps the usual outcome handling', async () => {
		await expect(verify('resolved', RED_HEAD_BUG_REPORT_TITLE)).resolves.toEqual({
			outcome: 'resolved',
		});
		const handedOff = await verify('handed-off', RED_HEAD_BUG_REPORT_TITLE);
		expect(handedOff.outcome).toBe('handed-off');
		expect(handedOff.headline).toContain(
			`${RESOLVE_PROBLEM_HANDED_OFF_PREFIX} red pull-request head to a person — `,
		);
		const settle = await verify('already-resolved', RED_HEAD_BUG_REPORT_TITLE);
		expect(settle.headline).toContain('the red pull-request head was already fixed');
		const error = await verify('unresolved', RED_HEAD_BUG_REPORT_TITLE).catch(
			(err: unknown) => err,
		);
		expect((error as AgentRunError).message).toContain(
			'could not resolve the red pull-request head',
		);
	});

	it('never reads the report for a failed-run or ticket attempt', async () => {
		const read = report('anything');
		await verifyResolveProblemOutcome(
			{ runId: 'run-resolve', report: REPORT, agent: AGENT },
			filed,
			read,
		);
		expect(read).not.toHaveBeenCalled();
	});
});
