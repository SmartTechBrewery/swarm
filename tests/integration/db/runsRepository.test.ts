import { eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import {
	cancelWaitingDispatch,
	createDispatch,
	listWaitingDispatches,
} from '../../../src/db/repositories/dispatchesRepository.js';
import { deleteProjectFromDb } from '../../../src/db/repositories/projectsRepository.js';
import {
	appendRunOutputEvents,
	cancelDeferredRunInDb,
	clearRunRecovery,
	completeRun,
	createRun,
	failOrphanedRunningRuns,
	failStaleRunningRuns,
	findBoardItemIdForTask,
	getLatestCompletedPlanningScope,
	getLatestRunForTask,
	getPendingReviewMergeFollowUps,
	getRunByIdFromDb,
	getRunLogsFromDb,
	getRunOutputEvents,
	hasCompletedRunForTask,
	hasLiveRunForTask,
	hasResumableDeferredRun,
	hasRunForTask,
	listRunsFromDb,
	MAX_RUN_OUTPUT_BYTES,
	markRunUserTerminated,
	recordRunCleanupBlocked,
	recordRunPreservedWorker,
	resetRunToRunning,
	storeRunLogs,
	updateReviewMergeOutcome,
} from '../../../src/db/repositories/runsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { removeWorker } from '../../../src/db/repositories/workersRepository.js';
import { runLogs, runs } from '../../../src/db/schema/runs.js';
import type { SwarmUser } from '../../../src/identity/schema.js';
import type { Worker } from '../../../src/identity/worker.js';
import { registerWorker } from '../../../src/identity/worker-service.js';
import type { SwarmJob } from '../../../src/queue/jobs.js';
import { createMockScmWebhookJob } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

// `runs.project_id` FKs `projects`, so every run needs a seeded project first.
const PROJECT_ID = 'proj-runs';

/** A registered worker plus the user who owns it — the attribution record's two ids. */
async function seedWorker(label: string): Promise<{ worker: Worker; owner: SwarmUser }> {
	const owner = await createUser({
		identifier: `${label}@example.com`,
		displayName: `Owner ${label}`,
	});
	const { worker } = await registerWorker({
		ownerUserId: owner.id,
		displayName: `worker-${label}`,
		capabilities: ['claude'],
	});
	return { worker, owner };
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('runsRepository (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
		await seedProject({ id: PROJECT_ID, repo: 'jkwiecien/runs-repo' });
	});

	describe('live output events', () => {
		it('returns only events after the supplied cursor in emission order', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: 'live', phase: 'review' });
			await appendRunOutputEvents(id, [
				{ stream: 'stdout', content: 'first\n', emittedAt: new Date('2026-01-01T00:00:00Z') },
				{ stream: 'stderr', content: 'second\n', emittedAt: new Date('2026-01-01T00:00:01Z') },
			]);

			const first = await getRunOutputEvents(id, 0);
			expect(first.events.map((event) => event.content)).toEqual(['first\n', 'second\n']);
			const second = await getRunOutputEvents(id, first.events[0].id);
			expect(second.events.map((event) => event.content)).toEqual(['second\n']);
		});

		it('clips output at the durable per-run byte limit and marks it truncated', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: 'chatty', phase: 'review' });
			await getDb()
				.update(runs)
				.set({ outputBytes: MAX_RUN_OUTPUT_BYTES - 3 })
				.where(eq(runs.id, id));
			await appendRunOutputEvents(id, [
				{ stream: 'stdout', content: 'abcdef', emittedAt: new Date() },
			]);

			const output = await getRunOutputEvents(id, 0);
			expect(output.events[0].content).toBe('abc');
			expect(output.truncated).toBe(true);
		});
	});

	describe('createRun', () => {
		it('inserts a running row and resolves it by id', async () => {
			const id = await createRun({
				projectId: PROJECT_ID,
				taskId: '42',
				phase: 'implementation',
				workItemId: 'WI_42',
				workItemTitle: 'Fix the widget',
				workItemUrl: 'https://github.com/jkwiecien/runs-repo/issues/42',
				engine: 'claude',
			});

			const row = await getRunByIdFromDb(id);
			expect(row).toBeDefined();
			expect(row?.projectId).toBe(PROJECT_ID);
			expect(row?.taskId).toBe('42');
			expect(row?.phase).toBe('implementation');
			expect(row?.workItemId).toBe('WI_42');
			expect(row?.workItemTitle).toBe('Fix the widget');
			expect(row?.workItemUrl).toBe('https://github.com/jkwiecien/runs-repo/issues/42');
			expect(row?.status).toBe('running');
			// Engine is persisted at creation so the dashboard shows it while running (issue #169).
			expect(row?.engine).toBe('claude');
			// Columns only set at completion (or when a model override exists) stay null.
			expect(row?.model).toBeNull();
			expect(row?.completedAt).toBeNull();
			expect(row?.nextRetryAt).toBeNull();
			expect(row?.startedAt).toBeInstanceOf(Date);
		});

		it('stores null work-item metadata and a null engine when they are omitted', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '7', phase: 'review' });

			const row = await getRunByIdFromDb(id);
			expect(row?.workItemTitle).toBeNull();
			expect(row?.workItemUrl).toBeNull();
			expect(row?.engine).toBeNull();
		});

		it('returns undefined for an unknown run id', async () => {
			expect(await getRunByIdFromDb('00000000-0000-0000-0000-000000000000')).toBeUndefined();
		});

		it('records the dispatched worker and its owning user (issue #398)', async () => {
			const { worker, owner } = await seedWorker('attributed-create');
			const id = await createRun({
				projectId: PROJECT_ID,
				taskId: '398',
				phase: 'implementation',
				workerId: worker.id,
				workerUserId: owner.id,
				workerFencingToken: 7,
			});

			const row = await getRunByIdFromDb(id);
			expect(row?.workerId).toBe(worker.id);
			expect(row?.workerUserId).toBe(owner.id);
			// The PR half of the record is only written at settle.
			expect(row?.producedPrUrl).toBeNull();
		});

		it('leaves the attribution user null for an unfederated run that records no worker', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '398-local', phase: 'review' });

			const row = await getRunByIdFromDb(id);
			expect(row?.workerId).toBeNull();
			expect(row?.workerUserId).toBeNull();
		});

		it('keeps the attribution user when the worker row is removed (issue #398)', async () => {
			// The reason the user id is denormalized onto the row rather than joined
			// through `workers.owner_user_id`: `worker_id` is ON DELETE SET NULL, so
			// removing the worker would otherwise erase the whole attribution.
			const { worker, owner } = await seedWorker('attributed-removed');
			const id = await createRun({
				projectId: PROJECT_ID,
				taskId: '398-removed',
				phase: 'implementation',
				workerId: worker.id,
				workerUserId: owner.id,
			});

			expect(await removeWorker(worker.id)).toBe(true);

			const row = await getRunByIdFromDb(id);
			expect(row?.workerId).toBeNull();
			expect(row?.workerUserId).toBe(owner.id);
		});
	});

	describe('completeRun', () => {
		it('flips a running row to completed and sets its outcome columns', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '1', phase: 'review' });

			await completeRun(id, {
				status: 'completed',
				engine: 'claude',
				exitCode: 0,
				timedOut: false,
				durationMs: 9876,
			});

			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('completed');
			expect(row?.engine).toBe('claude');
			expect(row?.exitCode).toBe(0);
			expect(row?.timedOut).toBe(false);
			expect(row?.durationMs).toBe(9876);
			expect(row?.completedAt).toBeInstanceOf(Date);
			expect(row?.nextRetryAt).toBeNull();
		});

		it('persists the PR a run produced, and leaves it as-is when a later settle omits it (issue #398)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '1b', phase: 'implementation' });

			await completeRun(id, {
				status: 'completed',
				producedPrUrl: 'https://github.com/jkwiecien/runs-repo/pull/7',
			});
			expect((await getRunByIdFromDb(id))?.producedPrUrl).toBe(
				'https://github.com/jkwiecien/runs-repo/pull/7',
			);

			// A settle that reports no produced PR must not blank the recorded one —
			// the "omitted fields are left as-is" contract.
			await completeRun(id, { status: 'completed' });
			expect((await getRunByIdFromDb(id))?.producedPrUrl).toBe(
				'https://github.com/jkwiecien/runs-repo/pull/7',
			);
		});

		// The contract issue #596 rests on: unknown exit metadata is expressed by an
		// *omitted* field, which leaves the column as-is (`exit_code`/`duration_ms` stay
		// NULL) rather than writing the `1 / false / 0` placeholder that used to
		// contradict the `error` the same settle wrote.
		it('leaves the exit columns untouched when a settle reports no exit metadata', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '2f', phase: 'implementation' });

			await completeRun(id, {
				status: 'deferred',
				error: 'Implementation agent (claude) exited with code 143 (timed out)',
			});

			const unreported = await getRunByIdFromDb(id);
			expect(unreported?.exitCode).toBeNull();
			expect(unreported?.durationMs).toBeNull();
			// `timed_out` is NOT NULL DEFAULT false, so its "unknown" is the NULL pair above.
			expect(unreported?.timedOut).toBe(false);

			await completeRun(id, {
				status: 'checkpointed',
				exitCode: 143,
				timedOut: true,
				durationMs: 1_806_000,
			});

			const reported = await getRunByIdFromDb(id);
			expect(reported?.exitCode).toBe(143);
			expect(reported?.timedOut).toBe(true);
			expect(reported?.durationMs).toBe(1_806_000);

			// And a later settle that reports none leaves what was recorded alone.
			await completeRun(id, { status: 'failed', error: 'boom' });
			const kept = await getRunByIdFromDb(id);
			expect(kept?.exitCode).toBe(143);
			expect(kept?.timedOut).toBe(true);
			expect(kept?.durationMs).toBe(1_806_000);
		});

		it('records a failed run with its error message', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '2', phase: 'planning' });

			await completeRun(id, { status: 'failed', engine: 'claude', exitCode: 1, error: 'boom' });

			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('failed');
			expect(row?.error).toBe('boom');
			expect(row?.exitCode).toBe(1);
		});

		it('round-trips a terminal diagnosis without replacing the raw error', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '2b', phase: 'implementation' });
			await completeRun(id, {
				status: 'failed',
				error: 'Implementation agent exited with code 1 (stalled)',
				failureDiagnosis: {
					kind: 'provider-stalled-early',
					title: 'Provider stalled early',
					message:
						'The agent provider stalled before meaningful work began; retry later or use another configured provider.',
					recovery: 'Retry later or use another configured provider.',
				},
			});

			const row = await getRunByIdFromDb(id);
			expect(row?.error).toBe('Implementation agent exited with code 1 (stalled)');
			expect(row?.failureDiagnosis).toMatchObject({ kind: 'provider-stalled-early' });
		});

		it('persists a recorded cancellation origin on a failed run (issue #308)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '2c', phase: 'review' });
			const cancellation = {
				source: 'dashboard' as const,
				requestedAt: '2026-07-10T12:00:00.000Z',
			};

			await completeRun(id, {
				status: 'failed',
				error: 'Run cancelled after a cancellation request.',
				cancellation,
			});

			const row = await getRunByIdFromDb(id);
			expect(row?.cancellation).toEqual(cancellation);
		});

		it('persists a null cancellation for a marker-only cancellation with no recorded origin', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '2d', phase: 'review' });

			await completeRun(id, {
				status: 'failed',
				error: 'Run cancelled after a cancellation request.',
				cancellation: null,
			});

			const row = await getRunByIdFromDb(id);
			expect(row?.cancellation).toBeNull();
		});

		it('leaves cancellation null when omitted (a non-cancellation failure)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '2e', phase: 'review' });

			await completeRun(id, { status: 'failed', error: 'boom' });

			const row = await getRunByIdFromDb(id);
			expect(row?.cancellation).toBeNull();
		});

		it('round-trips reported token usage', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '4', phase: 'implementation' });

			await completeRun(id, {
				status: 'completed',
				engine: 'claude',
				exitCode: 0,
				usage: { inputTokens: 1234, outputTokens: 567, cacheReadTokens: 89 },
			});

			const row = await getRunByIdFromDb(id);
			expect(row?.usage).toEqual({ inputTokens: 1234, outputTokens: 567, cacheReadTokens: 89 });
		});

		it('leaves usage null when omitted', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '5', phase: 'implementation' });

			await completeRun(id, { status: 'completed', engine: 'claude', exitCode: 0 });

			const row = await getRunByIdFromDb(id);
			expect(row?.usage).toBeNull();
		});

		it('records a deferred run without treating it as an error', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '3', phase: 'review' });
			const nextRetryAt = new Date('2026-07-10T12:30:00.000Z');

			await completeRun(id, { status: 'deferred', error: 'rate limited', nextRetryAt });

			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('deferred');
			expect(row?.completedAt).toBeInstanceOf(Date);
			expect(row?.nextRetryAt).toEqual(nextRetryAt);
		});

		it('persists a completed Review run’s submitted verdict (issue #218)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '3c', phase: 'review' });

			await completeRun(id, {
				status: 'completed',
				engine: 'claude',
				exitCode: 0,
				reviewVerdict: 'request-changes',
			});

			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('completed');
			expect(row?.reviewVerdict).toBe('request-changes');
		});

		it('leaves reviewVerdict null when the phase submitted none (issue #218)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '3d', phase: 'implementation' });

			await completeRun(id, { status: 'completed', engine: 'claude', exitCode: 0 });

			const row = await getRunByIdFromDb(id);
			expect(row?.reviewVerdict).toBeNull();
		});

		it('persists the safety-cap ordinal and manual-intervention outcome (issue #235)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '3e', phase: 'review' });

			await completeRun(id, {
				status: 'completed',
				engine: 'claude',
				exitCode: 0,
				reviewVerdict: 'request-changes',
				reviewOrdinal: 2,
				reviewAutomationOutcome: 'manual-intervention-required',
			});

			const row = await getRunByIdFromDb(id);
			expect(row?.reviewOrdinal).toBe(2);
			expect(row?.reviewAutomationOutcome).toBe('manual-intervention-required');
		});

		it('leaves the safety-cap columns null for a non-terminal verdict', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '3f', phase: 'review' });

			await completeRun(id, {
				status: 'completed',
				engine: 'claude',
				exitCode: 0,
				reviewVerdict: 'approve',
				reviewOrdinal: 1,
			});

			const row = await getRunByIdFromDb(id);
			expect(row?.reviewOrdinal).toBe(1);
			expect(row?.reviewAutomationOutcome).toBeNull();
		});

		it('keeps the engine persisted at creation when a deferral omits it (issue #169)', async () => {
			// A run rate-limited before its agent ran defers with no agent result, so
			// `completeRun` omits `engine`. The creation-time engine must survive so the
			// dashboard still shows the CLI for the deferred (retry-pending) run.
			const id = await createRun({
				projectId: PROJECT_ID,
				taskId: '3b',
				phase: 'review',
				engine: 'claude',
			});

			await completeRun(id, { status: 'deferred', error: 'rate limited' });

			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('deferred');
			expect(row?.engine).toBe('claude');
		});
	});

	describe('resetRunToRunning', () => {
		it('flips a deferred run back to running and clears its terminal columns', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '9', phase: 'review' });
			await completeRun(id, {
				status: 'deferred',
				engine: 'claude',
				exitCode: 1,
				timedOut: true,
				error: 'rate limited',
				durationMs: 4200,
				nextRetryAt: new Date('2026-07-10T12:30:00.000Z'),
				usage: { inputTokens: 10, outputTokens: 5 },
				failureDiagnosis: {
					kind: 'provider-stalled-early',
					title: 'Provider stalled early',
					message: 'The provider stalled.',
					recovery: 'Retry later.',
				},
			});

			const reset = await resetRunToRunning(id);

			expect(reset).toBe(true);
			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('running');
			expect(row?.completedAt).toBeNull();
			expect(row?.error).toBeNull();
			expect(row?.nextRetryAt).toBeNull();
			expect(row?.engine).toBeNull();
			expect(row?.exitCode).toBeNull();
			expect(row?.timedOut).toBe(false);
			expect(row?.durationMs).toBeNull();
			expect(row?.usage).toBeNull();
			expect(row?.failureDiagnosis).toBeNull();
		});

		it('clears a prior Review verdict so a re-running row shows no stale verdict (issue #218)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '9c', phase: 'review' });
			await completeRun(id, { status: 'completed', engine: 'claude', reviewVerdict: 'approve' });

			await resetRunToRunning(id);

			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('running');
			expect(row?.reviewVerdict).toBeNull();
		});

		it('clears a prior safety-cap ordinal/outcome alongside the verdict (issue #235)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '9d', phase: 'review' });
			await completeRun(id, {
				status: 'completed',
				engine: 'claude',
				reviewVerdict: 'request-changes',
				reviewOrdinal: 2,
				reviewAutomationOutcome: 'manual-intervention-required',
			});

			await resetRunToRunning(id);

			const row = await getRunByIdFromDb(id);
			expect(row?.reviewOrdinal).toBeNull();
			expect(row?.reviewAutomationOutcome).toBeNull();
		});

		it('clears a prior merge-automation outcome so a re-run starts a fresh generation (issue #278)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '9e', phase: 'review' });
			await completeRun(id, { status: 'completed', engine: 'claude', reviewVerdict: 'approve' });
			await updateReviewMergeOutcome(id, {
				status: 'not-ready',
				message: 'pending checks',
				attempt: 0,
				approvedHeadSha: 'sha-old',
			});

			await resetRunToRunning(id);

			const row = await getRunByIdFromDb(id);
			expect(row?.reviewMergeOutcome).toBeNull();
			expect(row?.reviewMergeMessage).toBeNull();
			expect(row?.reviewMergeAttempt).toBeNull();
			expect(row?.reviewMergeApprovedHeadSha).toBeNull();
		});

		it('clears a prior cancellation origin so a retried run never shows a stale one (issue #308)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '9f', phase: 'review' });
			await completeRun(id, {
				status: 'failed',
				error: 'Run cancelled after a cancellation request.',
				cancellation: { source: 'dashboard', requestedAt: '2026-07-10T12:00:00.000Z' },
			});

			await resetRunToRunning(id);

			const row = await getRunByIdFromDb(id);
			expect(row?.cancellation).toBeNull();
		});

		it('re-binds the worker and its owning user for the fresh attempt (issue #398)', async () => {
			const first = await seedWorker('attributed-reset-a');
			const second = await seedWorker('attributed-reset-b');
			const id = await createRun({
				projectId: PROJECT_ID,
				taskId: '9g',
				phase: 'implementation',
				workerId: first.worker.id,
				workerUserId: first.owner.id,
			});
			await completeRun(id, { status: 'failed', error: 'boom' });

			// A retry can land on a different worker, so the user is re-bound with it.
			await resetRunToRunning(
				id,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				second.worker.id,
				11,
				second.owner.id,
			);

			const row = await getRunByIdFromDb(id);
			expect(row?.workerId).toBe(second.worker.id);
			expect(row?.workerUserId).toBe(second.owner.id);
			expect(row?.workerFencingToken).toBe(11);
		});

		it('clears the worker binding when a retry resolves no worker (issue #398)', async () => {
			const { worker, owner } = await seedWorker('attributed-reset-local');
			const id = await createRun({
				projectId: PROJECT_ID,
				taskId: '9h',
				phase: 'implementation',
				workerId: worker.id,
				workerUserId: owner.id,
				workerFencingToken: 7,
			});
			await completeRun(id, { status: 'failed', error: 'boom' });

			await resetRunToRunning(id);

			const row = await getRunByIdFromDb(id);
			expect(row?.workerId).toBeNull();
			expect(row?.workerUserId).toBeNull();
			expect(row?.workerFencingToken).toBeNull();
		});

		it('keeps a produced PR url across a retry (issue #398)', async () => {
			// Unlike the review columns, the produced PR is a real external artifact
			// that outlives the attempt: a resumed Implementation retry re-reports the
			// same URL, so keeping it can never show something false, whereas clearing
			// would erase the record of a PR that exists.
			const id = await createRun({ projectId: PROJECT_ID, taskId: '9i', phase: 'implementation' });
			await completeRun(id, {
				status: 'deferred',
				producedPrUrl: 'https://github.com/jkwiecien/runs-repo/pull/7',
			});

			await resetRunToRunning(id);

			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('running');
			expect(row?.producedPrUrl).toBe('https://github.com/jkwiecien/runs-repo/pull/7');
		});

		it('records the effective engine for the fresh attempt when one is passed', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '9b', phase: 'review' });
			await completeRun(id, { status: 'failed', engine: 'claude', error: 'boom' });

			// The worker resolves and threads the effective CLI on reset (issue #169), so
			// the row shows it while running rather than clearing to null until completion.
			await resetRunToRunning(id, undefined, undefined, undefined, undefined, undefined, 'codex');

			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('running');
			expect(row?.engine).toBe('codex');
		});

		it('returns false when no row matches the id (pruned between defer and retry)', async () => {
			expect(await resetRunToRunning('00000000-0000-0000-0000-000000000000')).toBe(false);
		});

		it('atomically claims a failed row from its expected status', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '10', phase: 'review' });
			await completeRun(id, { status: 'failed', error: 'boom' });

			expect(await resetRunToRunning(id, undefined, 'failed')).toBe(true);
			expect((await getRunByIdFromDb(id))?.status).toBe('running');
		});

		it('returns false without changing a row that no longer has the expected status', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '11', phase: 'review' });

			expect(await resetRunToRunning(id, undefined, 'failed')).toBe(false);
			expect((await getRunByIdFromDb(id))?.status).toBe('running');
		});

		it('bumps startedAt to the current attempt so a stale-row sweep measures it fresh', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '12', phase: 'review' });
			await completeRun(id, { status: 'failed', error: 'boom' });
			const backdated = new Date(Date.now() - 3 * 60 * 60 * 1000);
			await getDb().update(runs).set({ startedAt: backdated }).where(eq(runs.id, id));

			await resetRunToRunning(id);

			const row = await getRunByIdFromDb(id);
			expect(row?.startedAt.getTime()).toBeGreaterThan(backdated.getTime());
		});
	});

	describe('cancelDeferredRunInDb', () => {
		it('fails the row and persists the recorded cancellation origin (issue #308)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '20a', phase: 'implementation' });
			await completeRun(id, {
				status: 'deferred',
				error: 'rate limited',
				nextRetryAt: new Date('2026-07-10T12:30:00.000Z'),
			});
			const cancellation = {
				source: 'dashboard' as const,
				requestedAt: '2026-07-10T12:31:00.000Z',
			};

			const result = await cancelDeferredRunInDb(
				id,
				'Run cancelled after a cancellation request.',
				cancellation,
			);

			expect(result.success).toBe(true);
			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('failed');
			expect(row?.error).toBe('Run cancelled after a cancellation request.');
			expect(row?.nextRetryAt).toBeNull();
			expect(row?.cancellation).toEqual(cancellation);
		});

		it('returns false without changing a row that is no longer deferred', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '20b', phase: 'implementation' });

			const result = await cancelDeferredRunInDb(
				id,
				'Run cancelled after a cancellation request.',
				{
					source: 'dashboard',
					requestedAt: '2026-07-10T12:31:00.000Z',
				},
			);

			expect(result).toEqual({ success: false, dispatch: null, preservedSession: null });
			expect((await getRunByIdFromDb(id))?.status).toBe('running');
		});

		it('reports the preserved session and recovery record for a resumable deferral (issue #361)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '20c', phase: 'implementation' });
			await completeRun(id, {
				status: 'deferred',
				error: 'rate limited',
				nextRetryAt: new Date('2026-07-10T12:30:00.000Z'),
				agentSessionId: id,
			});

			const result = await cancelDeferredRunInDb(
				id,
				'Run cancelled after a cancellation request.',
				{
					source: 'dashboard',
					requestedAt: '2026-07-10T12:31:00.000Z',
				},
			);

			expect(result.success).toBe(true);
			expect(result.preservedSession).toBe(id);
			const row = await getRunByIdFromDb(id);
			expect(row?.agentSessionId).toBe(id);
			expect(row?.recovery).toEqual({ state: 'preserved', agentSessionId: id });
		});

		it('reports no preserved session and a null recovery record when the deferral had none (issue #361)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '20d', phase: 'implementation' });
			await completeRun(id, {
				status: 'deferred',
				error: 'worktree exists',
				nextRetryAt: new Date('2026-07-10T12:30:00.000Z'),
				agentSessionId: null,
			});

			const result = await cancelDeferredRunInDb(
				id,
				'Run cancelled after a cancellation request.',
				{
					source: 'dashboard',
					requestedAt: '2026-07-10T12:31:00.000Z',
				},
			);

			expect(result.success).toBe(true);
			expect(result.preservedSession).toBeNull();
			const row = await getRunByIdFromDb(id);
			expect(row?.agentSessionId).toBeNull();
			expect(row?.recovery).toBeNull();
		});
	});

	describe('recordRunCleanupBlocked (issue #361)', () => {
		it('records a blocked recovery reason without reopening the cancelled dispatch', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '20e', phase: 'implementation' });
			await completeRun(id, {
				status: 'failed',
				error: 'Run cancelled after a cancellation request.',
				agentSessionId: null,
			});

			await recordRunCleanupBlocked(id, 'dirty');

			const row = await getRunByIdFromDb(id);
			// The terminal state and cleared retry columns are untouched — only recovery.
			expect(row?.status).toBe('failed');
			expect(row?.recovery).toEqual({ state: 'blocked', blockedReason: 'dirty' });
			expect(row?.agentSessionId).toBeNull();
		});
	});

	// Issue #567. The pin is three hand-written SQL expressions on a free-form jsonb
	// column, so it is pinned against a real Postgres rather than reasoned about: the
	// sticky-key merge is what makes the pin survive the wholesale recovery rewrites
	// that every settle and every re-bind perform, and losing it silently re-opens the
	// defect (a continuation dispatched to a machine that does not hold its work).
	describe('preserved-checkout pin (issue #567)', () => {
		/** A deferred run bound to `worker`, with its preserved machine recorded. */
		async function pinnedRun(taskId: string, workerId: string, ownerUserId: string) {
			const id = await createRun({
				projectId: PROJECT_ID,
				taskId,
				phase: 'implementation',
				workerId,
				workerUserId: ownerUserId,
			});
			await completeRun(id, { status: 'deferred', error: 'rate limited', agentSessionId: id });
			await recordRunPreservedWorker(id);
			return id;
		}

		it('records the machine from the attempt’s own worker at settle', async () => {
			const { worker, owner } = await seedWorker('pin-a');
			const id = await pinnedRun('567a', worker.id, owner.id);

			const row = await getRunByIdFromDb(id);
			expect(row?.recovery?.preservedWorkerId).toBe(worker.id);
		});

		it('records nothing for a run with no worker — there is no other machine to pin', async () => {
			const id = await createRun({
				projectId: PROJECT_ID,
				taskId: '567b',
				phase: 'implementation',
			});
			await completeRun(id, { status: 'deferred', error: 'rate limited' });

			await recordRunPreservedWorker(id);

			expect((await getRunByIdFromDb(id))?.recovery).toBeNull();
		});

		it('carries the machine onto the recovery record a re-bind writes', async () => {
			// The exact overwrite that made the location unrecoverable: `worker_id` is
			// replaced with the continuation's worker while `recovery` is rewritten whole.
			const { worker, owner } = await seedWorker('pin-c');
			const other = await seedWorker('pin-c-other');
			const id = await pinnedRun('567c', worker.id, owner.id);

			await resetRunToRunning(
				id,
				undefined,
				'deferred',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ state: 'recovered', agentSessionId: null },
				other.worker.id,
				1,
				other.owner.id,
			);

			const row = await getRunByIdFromDb(id);
			expect(row?.workerId).toBe(other.worker.id);
			expect(row?.recovery).toEqual({ state: 'recovered', preservedWorkerId: worker.id });
		});

		it('drops the machine when a fresh, non-recovery attempt gives the checkout up', async () => {
			const { worker, owner } = await seedWorker('pin-d');
			const id = await pinnedRun('567d', worker.id, owner.id);

			await resetRunToRunning(
				id,
				undefined,
				'deferred',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				null,
				worker.id,
				1,
				owner.id,
			);

			expect((await getRunByIdFromDb(id))?.recovery).toBeNull();
		});

		it('keeps the machine through a cancellation that preserves the session', async () => {
			// Terminate-then-Resume: the checkout survives on the pinned machine, the
			// operator's next action is a resume, and it must still be pinned.
			const { worker, owner } = await seedWorker('pin-e');
			const id = await pinnedRun('567e', worker.id, owner.id);

			const result = await cancelDeferredRunInDb(id, 'terminated', {
				source: 'dashboard',
				requestedAt: new Date().toISOString(),
			});

			expect(result.success).toBe(true);
			const row = await getRunByIdFromDb(id);
			expect(row?.recovery?.state).toBe('preserved');
			expect(row?.recovery?.preservedWorkerId).toBe(worker.id);
		});

		it('keeps the machine through a blocked cleanup — the checkout is still on it', async () => {
			const { worker, owner } = await seedWorker('pin-f');
			const id = await pinnedRun('567f', worker.id, owner.id);

			await recordRunCleanupBlocked(id, 'dirty');

			const row = await getRunByIdFromDb(id);
			expect(row?.recovery).toEqual({
				state: 'blocked',
				blockedReason: 'dirty',
				preservedWorkerId: worker.id,
			});
		});

		it('turns the pin into an abandonment on "Reset & restart", and keeps it thereafter', async () => {
			const { worker, owner } = await seedWorker('pin-g');
			const id = await pinnedRun('567g', worker.id, owner.id);

			await clearRunRecovery(id);
			expect((await getRunByIdFromDb(id))?.recovery).toEqual({
				abandonedWorkerId: worker.id,
			});

			// The restarted attempt writes no recovery at all; the record that this run
			// started over rather than continuing must survive it.
			await resetRunToRunning(
				id,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				null,
				worker.id,
				1,
				owner.id,
			);

			expect((await getRunByIdFromDb(id))?.recovery).toEqual({ abandonedWorkerId: worker.id });
		});
	});

	describe('reset & restart support (issue #424)', () => {
		it('clears the recovery record and the captured session id', async () => {
			const id = await createRun({
				projectId: PROJECT_ID,
				taskId: '424a',
				phase: 'implementation',
			});
			await completeRun(id, { status: 'failed', error: 'wedged', agentSessionId: id });
			await recordRunCleanupBlocked(id, 'live-leased');

			await clearRunRecovery(id);

			const row = await getRunByIdFromDb(id);
			expect(row?.recovery).toBeNull();
			expect(row?.agentSessionId).toBeNull();
			// The terminal state and its reason are untouched.
			expect(row?.status).toBe('failed');
			expect(row?.error).toBe('wedged');
		});

		it('sees a different live run for the task but not the run being reset', async () => {
			const resetting = await createRun({
				projectId: PROJECT_ID,
				taskId: '424b',
				phase: 'implementation',
			});
			// The run being reset is `running` itself — its own lease is the stale marker.
			await expect(hasLiveRunForTask(PROJECT_ID, '424b', resetting)).resolves.toBe(false);

			const other = await createRun({
				projectId: PROJECT_ID,
				taskId: '424b',
				phase: 'review',
			});
			await expect(hasLiveRunForTask(PROJECT_ID, '424b', resetting)).resolves.toBe(true);

			// A settled run no longer owns the checkout.
			await completeRun(other, { status: 'completed' });
			await expect(hasLiveRunForTask(PROJECT_ID, '424b', resetting)).resolves.toBe(false);
		});

		it('ignores live runs for other tasks', async () => {
			const resetting = await createRun({
				projectId: PROJECT_ID,
				taskId: '424c',
				phase: 'implementation',
			});
			await createRun({ projectId: PROJECT_ID, taskId: '424d', phase: 'implementation' });

			await expect(hasLiveRunForTask(PROJECT_ID, '424c', resetting)).resolves.toBe(false);
		});
	});

	describe('markRunUserTerminated', () => {
		it('flips a deferred row to failed with the reason and clears retry columns', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '20', phase: 'implementation' });
			await completeRun(id, {
				status: 'deferred',
				error: 'rate limited',
				nextRetryAt: new Date('2026-07-10T12:30:00.000Z'),
				agentSessionId: id,
			});

			const terminated = await markRunUserTerminated(id, 'Run terminated by user', 'deferred');

			expect(terminated).toBe(true);
			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('failed');
			expect(row?.error).toBe('Run terminated by user');
			expect(row?.nextRetryAt).toBeNull();
			expect(row?.agentSessionId).toBeNull();
			expect(row?.failureDiagnosis).toMatchObject({ kind: 'user-terminated' });
			expect(row?.completedAt).toBeInstanceOf(Date);
		});

		it('is a conditional claim: returns false when the row is no longer deferred', async () => {
			// A concurrent pickup flipped it to running — the conditional must not
			// clobber the in-flight run.
			const id = await createRun({ projectId: PROJECT_ID, taskId: '21', phase: 'review' });

			expect(await markRunUserTerminated(id, 'Run terminated by user', 'deferred')).toBe(false);
			expect((await getRunByIdFromDb(id))?.status).toBe('running');
		});

		it('terminates unconditionally when no fromStatus is supplied', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '22', phase: 'review' });

			expect(await markRunUserTerminated(id, 'Run terminated by user')).toBe(true);
			expect((await getRunByIdFromDb(id))?.status).toBe('failed');
		});

		it('returns false for an unknown run id', async () => {
			expect(await markRunUserTerminated('00000000-0000-0000-0000-000000000000', 'x')).toBe(false);
		});
	});

	describe('getLatestRunForTask', () => {
		it('returns only the newest row matching project, task, and phase', async () => {
			await seedProject({ id: 'proj-other', repo: 'jkwiecien/other-repo' });
			const older = await createRun({ projectId: PROJECT_ID, taskId: '42', phase: 'review' });
			const newest = await createRun({ projectId: PROJECT_ID, taskId: '42', phase: 'review' });
			await getDb()
				.update(runs)
				.set({ startedAt: new Date('2026-01-01') })
				.where(eq(runs.id, older));
			await getDb()
				.update(runs)
				.set({ startedAt: new Date('2026-02-01') })
				.where(eq(runs.id, newest));
			await createRun({ projectId: PROJECT_ID, taskId: '42', phase: 'planning' });
			await createRun({ projectId: PROJECT_ID, taskId: 'other', phase: 'review' });
			await createRun({ projectId: 'proj-other', taskId: '42', phase: 'review' });

			expect((await getLatestRunForTask(PROJECT_ID, '42', 'review'))?.id).toBe(newest);
			expect(await getLatestRunForTask(PROJECT_ID, 'missing', 'review')).toBeUndefined();
		});
	});

	// The durable PR→card link a PR-driven phase resolves its board report through
	// (issue #498) — board-driven runs write it, the respond phase reads it back.
	describe('findBoardItemIdForTask', () => {
		it('returns the most recent card recorded for the task, ignoring cardless rows', async () => {
			await seedProject({ id: 'proj-card-other', repo: 'jkwiecien/card-other' });
			const older = await createRun({
				projectId: PROJECT_ID,
				taskId: '77',
				phase: 'planning',
				workItemId: 'ITEM_OLD',
			});
			const newest = await createRun({
				projectId: PROJECT_ID,
				taskId: '77',
				phase: 'implementation',
				workItemId: 'ITEM_NEW',
			});
			// A PR-driven row for the same task carries no card — it must not shadow
			// the board-driven rows just because it is newer.
			const cardless = await createRun({ projectId: PROJECT_ID, taskId: '77', phase: 'review' });
			// Same task id, different project — never crosses over.
			await createRun({
				projectId: 'proj-card-other',
				taskId: '77',
				phase: 'implementation',
				workItemId: 'ITEM_WRONG_PROJECT',
			});
			await getDb()
				.update(runs)
				.set({ startedAt: new Date('2026-01-01') })
				.where(eq(runs.id, older));
			await getDb()
				.update(runs)
				.set({ startedAt: new Date('2026-02-01') })
				.where(eq(runs.id, newest));
			await getDb()
				.update(runs)
				.set({ startedAt: new Date('2026-03-01') })
				.where(eq(runs.id, cardless));

			expect(await findBoardItemIdForTask(PROJECT_ID, '77')).toBe('ITEM_NEW');
		});

		it('returns undefined when no run for the task ever carried a card', async () => {
			await createRun({ projectId: PROJECT_ID, taskId: '78', phase: 'review' });

			expect(await findBoardItemIdForTask(PROJECT_ID, '78')).toBeUndefined();
			expect(await findBoardItemIdForTask(PROJECT_ID, 'never-ran')).toBeUndefined();
		});
	});

	describe('getLatestCompletedPlanningScope', () => {
		it('returns only the newest completed, scope-bearing Planning artifact for the same task', async () => {
			const older = await createRun({
				projectId: PROJECT_ID,
				taskId: 'scope-1',
				phase: 'planning',
			});
			const newest = await createRun({
				projectId: PROJECT_ID,
				taskId: 'scope-1',
				phase: 'planning',
			});
			const failed = await createRun({
				projectId: PROJECT_ID,
				taskId: 'scope-1',
				phase: 'planning',
			});
			const noScope = await createRun({
				projectId: PROJECT_ID,
				taskId: 'scope-1',
				phase: 'planning',
			});
			const otherPhase = await createRun({
				projectId: PROJECT_ID,
				taskId: 'scope-1',
				phase: 'implementation',
			});

			await completeRun(older, {
				status: 'completed',
				planningScope: {
					whyOneTask: 'Older scope.',
					independentConcerns: ['older concern'],
					affectedAreas: ['older area'],
					outOfScope: [],
				},
			});
			await completeRun(newest, {
				status: 'completed',
				planningScope: {
					whyOneTask: 'Newest scope.',
					independentConcerns: ['worker change', 'dashboard change'],
					affectedAreas: ['worker', 'dashboard'],
					outOfScope: ['automatic splitting'],
				},
			});
			await completeRun(failed, {
				status: 'failed',
				planningScope: {
					whyOneTask: 'Failed scope.',
					independentConcerns: ['ignored concern'],
					affectedAreas: ['ignored area'],
					outOfScope: [],
				},
			});
			await completeRun(noScope, { status: 'completed' });
			await completeRun(otherPhase, {
				status: 'completed',
				planningScope: {
					whyOneTask: 'Wrong phase.',
					independentConcerns: ['ignored concern'],
					affectedAreas: ['ignored area'],
					outOfScope: [],
				},
			});

			await getDb()
				.update(runs)
				.set({ completedAt: new Date('2026-01-01T00:00:00.000Z') })
				.where(eq(runs.id, older));
			await getDb()
				.update(runs)
				.set({ completedAt: new Date('2026-01-02T00:00:00.000Z') })
				.where(eq(runs.id, newest));

			expect(await getLatestCompletedPlanningScope(PROJECT_ID, 'scope-1')).toMatchObject({
				whyOneTask: 'Newest scope.',
				independentConcerns: ['worker change', 'dashboard change'],
			});
			expect(await getLatestCompletedPlanningScope(PROJECT_ID, 'missing')).toBeUndefined();
		});
	});

	describe('hasCompletedRunForTask', () => {
		it('is true only when a completed row exists for the given project, task, and phase', async () => {
			await seedProject({ id: 'proj-other', repo: 'jkwiecien/other-repo' });
			const completed = await createRun({ projectId: PROJECT_ID, taskId: '50', phase: 'planning' });
			await completeRun(completed, { status: 'completed' });
			// Same task/phase, other project — must not count.
			const otherProjectRun = await createRun({
				projectId: 'proj-other',
				taskId: '50',
				phase: 'planning',
			});
			await completeRun(otherProjectRun, { status: 'completed' });
			// Same project/task, other phase — must not count.
			const otherPhaseRun = await createRun({
				projectId: PROJECT_ID,
				taskId: '50',
				phase: 'implementation',
			});
			await completeRun(otherPhaseRun, { status: 'completed' });

			expect(await hasCompletedRunForTask(PROJECT_ID, '50', 'planning')).toBe(true);
			expect(await hasCompletedRunForTask('proj-other', '50', 'planning')).toBe(true);
			expect(await hasCompletedRunForTask(PROJECT_ID, '50', 'implementation')).toBe(true);
			expect(await hasCompletedRunForTask(PROJECT_ID, '51', 'planning')).toBe(false);
		});

		it('is false for a failed Planning run', async () => {
			const failed = await createRun({ projectId: PROJECT_ID, taskId: '51', phase: 'planning' });
			await completeRun(failed, { status: 'failed', error: 'boom' });

			expect(await hasCompletedRunForTask(PROJECT_ID, '51', 'planning')).toBe(false);
		});

		it('is false for a deferred Planning run', async () => {
			const deferred = await createRun({ projectId: PROJECT_ID, taskId: '52', phase: 'planning' });
			await completeRun(deferred, { status: 'deferred', error: 'rate limited' });

			expect(await hasCompletedRunForTask(PROJECT_ID, '52', 'planning')).toBe(false);
		});

		it('is false when no run exists for the task', async () => {
			expect(await hasCompletedRunForTask(PROJECT_ID, 'missing', 'planning')).toBe(false);
		});

		it('is false while the run is still running', async () => {
			await createRun({ projectId: PROJECT_ID, taskId: '53', phase: 'planning' });

			expect(await hasCompletedRunForTask(PROJECT_ID, '53', 'planning')).toBe(false);
		});
	});

	describe('hasRunForTask (issue #397)', () => {
		it('is true for a still-running row — the Review trigger ownership gate case', async () => {
			// Implementation opens its PR from inside its own running process, so the
			// gate must see the row before it settles.
			await createRun({ projectId: PROJECT_ID, taskId: '60', phase: 'implementation' });

			expect(await hasRunForTask(PROJECT_ID, '60', 'implementation')).toBe(true);
			expect(await hasCompletedRunForTask(PROJECT_ID, '60', 'implementation')).toBe(false);
		});

		it('is true for a failed row (status-agnostic)', async () => {
			const failed = await createRun({
				projectId: PROJECT_ID,
				taskId: '61',
				phase: 'implementation',
			});
			await completeRun(failed, { status: 'failed', error: 'boom' });

			expect(await hasRunForTask(PROJECT_ID, '61', 'implementation')).toBe(true);
		});

		it('is scoped to the project, task, and phase', async () => {
			await seedProject({ id: 'proj-other-runs', repo: 'jkwiecien/other-runs-repo' });
			await createRun({ projectId: PROJECT_ID, taskId: '62', phase: 'implementation' });

			expect(await hasRunForTask('proj-other-runs', '62', 'implementation')).toBe(false);
			expect(await hasRunForTask(PROJECT_ID, '63', 'implementation')).toBe(false);
			expect(await hasRunForTask(PROJECT_ID, '62', 'review')).toBe(false);
		});

		it('does not require a worker id (NULL on every unfederated project)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '64', phase: 'implementation' });
			const row = await getRunByIdFromDb(id);

			expect(row?.workerId).toBeNull();
			expect(await hasRunForTask(PROJECT_ID, '64', 'implementation')).toBe(true);
		});
	});

	describe('storeRunLogs / getRunLogsFromDb', () => {
		it('persists stdout/stderr and reads them back', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '1', phase: 'review' });

			await storeRunLogs(id, 'the output', 'the errors');

			expect(await getRunLogsFromDb(id)).toEqual({ stdout: 'the output', stderr: 'the errors' });
		});

		it('upserts on a second store for the same run (one log row per run)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '1', phase: 'review' });

			await storeRunLogs(id, 'first', 'firsterr');
			await storeRunLogs(id, 'second', 'seconderr');

			expect(await getRunLogsFromDb(id)).toEqual({ stdout: 'second', stderr: 'seconderr' });
			const rows = await getDb().select().from(runLogs).where(eq(runLogs.runId, id));
			expect(rows).toHaveLength(1);
		});

		it('returns undefined for a run with no logs row', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '1', phase: 'review' });
			expect(await getRunLogsFromDb(id)).toBeUndefined();
		});
	});

	describe('listRunsFromDb', () => {
		// Insert rows directly with controlled startedAt so ordering/pagination is
		// deterministic (createRun stamps started_at with now()).
		async function seedRun(overrides: {
			projectId?: string;
			status?: string;
			phase?: string;
			startedAt: Date;
		}): Promise<void> {
			await getDb()
				.insert(runs)
				.values({
					projectId: overrides.projectId ?? PROJECT_ID,
					taskId: 't',
					phase: overrides.phase ?? 'review',
					status: overrides.status ?? 'running',
					startedAt: overrides.startedAt,
				});
		}

		it('filters by project, status, and phase, and counts the filtered set', async () => {
			await seedProject({ id: 'proj-other', repo: 'jkwiecien/other-repo' });
			await seedRun({ status: 'completed', phase: 'review', startedAt: new Date('2026-01-01') });
			await seedRun({ status: 'failed', phase: 'planning', startedAt: new Date('2026-01-02') });
			await seedRun({
				projectId: 'proj-other',
				status: 'completed',
				phase: 'review',
				startedAt: new Date('2026-01-03'),
			});

			const byProject = await listRunsFromDb({ projectId: PROJECT_ID, limit: 50, offset: 0 });
			expect(byProject.total).toBe(2);
			expect(byProject.data).toHaveLength(2);

			const byStatus = await listRunsFromDb({ status: 'completed', limit: 50, offset: 0 });
			expect(byStatus.total).toBe(2);

			const byPhase = await listRunsFromDb({ phase: 'planning', limit: 50, offset: 0 });
			expect(byPhase.total).toBe(1);
			expect(byPhase.data[0].phase).toBe('planning');

			const combined = await listRunsFromDb({
				projectId: PROJECT_ID,
				status: 'completed',
				limit: 50,
				offset: 0,
			});
			expect(combined.total).toBe(1);
		});

		it('orders by startedAt descending', async () => {
			await seedRun({ startedAt: new Date('2026-01-01') });
			await seedRun({ startedAt: new Date('2026-03-01') });
			await seedRun({ startedAt: new Date('2026-02-01') });

			const { data } = await listRunsFromDb({ limit: 50, offset: 0 });
			expect(data.map((r) => r.startedAt.getTime())).toEqual([
				new Date('2026-03-01').getTime(),
				new Date('2026-02-01').getTime(),
				new Date('2026-01-01').getTime(),
			]);
		});

		it('paginates with limit/offset while total reflects the full filtered count', async () => {
			for (let i = 0; i < 5; i++) {
				await seedRun({ startedAt: new Date(2026, 0, i + 1) });
			}

			const page1 = await listRunsFromDb({ limit: 2, offset: 0 });
			expect(page1.total).toBe(5);
			expect(page1.data).toHaveLength(2);
			expect(page1.data[0].startedAt.getTime()).toBe(new Date(2026, 0, 5).getTime());

			const page3 = await listRunsFromDb({ limit: 2, offset: 4 });
			expect(page3.total).toBe(5);
			expect(page3.data).toHaveLength(1);
			expect(page3.data[0].startedAt.getTime()).toBe(new Date(2026, 0, 1).getTime());
		});

		it('returns an empty page and zero total when nothing matches', async () => {
			const result = await listRunsFromDb({ projectId: 'nobody', limit: 10, offset: 0 });
			expect(result).toEqual({ data: [], total: 0 });
		});

		it('hides deferred attempts with waiting dispatches and keeps settled attempts visible', async () => {
			const rateLimitedRunId = await createRun({
				projectId: PROJECT_ID,
				taskId: 'rate-limited',
				phase: 'implementation',
			});
			await completeRun(rateLimitedRunId, { status: 'deferred', error: 'rate limited' });
			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: {
					...createMockScmWebhookJob(),
					projectId: PROJECT_ID,
					runId: rateLimitedRunId,
				} as SwarmJob,
				source: 'synthetic',
				waitReason: 'rate-limit',
				runId: rateLimitedRunId,
				state: 'retry-scheduled',
			});

			const capacityRunId = await createRun({
				projectId: PROJECT_ID,
				taskId: 'capacity',
				phase: 'review',
			});
			await completeRun(capacityRunId, { status: 'deferred', error: 'provider capacity' });
			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: {
					...createMockScmWebhookJob({ deliveryId: 'capacity-dispatch' }),
					projectId: PROJECT_ID,
					runId: capacityRunId,
				} as SwarmJob,
				source: 'synthetic',
				waitReason: 'project-capacity',
				runId: capacityRunId,
				state: 'pending',
			});

			// No runId means no attempt exists for Runs to display yet.
			const fresh = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: createMockScmWebhookJob({
					deliveryId: 'fresh-dispatch',
					projectId: PROJECT_ID,
				}),
				source: 'webhook',
			});

			const settledRunId = await createRun({
				projectId: PROJECT_ID,
				taskId: 'settled',
				phase: 'resolve-conflicts',
			});
			await completeRun(settledRunId, { status: 'deferred' });
			const settled = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: {
					...createMockScmWebhookJob({ deliveryId: 'settled-dispatch' }),
					projectId: PROJECT_ID,
					runId: settledRunId,
				} as SwarmJob,
				source: 'synthetic',
				runId: settledRunId,
				state: 'retry-scheduled',
			});
			await cancelWaitingDispatch(settled.dispatch.id, 'test settled dispatch');

			const all = await listRunsFromDb({ projectId: PROJECT_ID, limit: 50, offset: 0 });
			const ids = all.data.map((r) => r.id);
			expect(ids).toEqual([settledRunId]);
			expect(ids).not.toContain(rateLimitedRunId);
			expect(ids).not.toContain(capacityRunId);
			expect(all.total).toBe(1);

			const deferred = await listRunsFromDb({
				projectId: PROJECT_ID,
				status: 'deferred',
				limit: 50,
				offset: 0,
			});
			expect(deferred.data.map((run) => run.id)).toEqual([settledRunId]);
			expect(deferred.total).toBe(1);

			const queued = await listWaitingDispatches(PROJECT_ID);
			expect(queued.map((dispatch) => dispatch.runId)).toEqual(
				expect.arrayContaining([rateLimitedRunId, capacityRunId, null]),
			);
			expect(queued.map((dispatch) => dispatch.id)).toContain(fresh.dispatch.id);
			expect(queued.map((dispatch) => dispatch.runId)).not.toContain(settledRunId);
		});
	});

	describe('cascade delete', () => {
		it('removes a project’s runs (and their logs) when the project is deleted', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '1', phase: 'review' });
			await storeRunLogs(id, 'out', 'err');

			await deleteProjectFromDb(PROJECT_ID);

			expect(await getRunByIdFromDb(id)).toBeUndefined();
			expect(await getRunLogsFromDb(id)).toBeUndefined();
		});

		it('removes a run’s logs when the run itself is deleted', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '1', phase: 'review' });
			await storeRunLogs(id, 'out', 'err');

			await getDb().delete(runs).where(eq(runs.id, id));

			expect(await getRunLogsFromDb(id)).toBeUndefined();
		});
	});

	describe('failOrphanedRunningRuns', () => {
		it('reconciles only the authenticated worker or unfederated startup scope', async () => {
			const owner = await createUser({
				identifier: 'run-owner@example.com',
				displayName: 'Run Owner',
			});
			const workerA = await registerWorker({
				ownerUserId: owner.id,
				displayName: 'worker-a',
				capabilities: ['claude'],
			});
			const workerB = await registerWorker({
				ownerUserId: owner.id,
				displayName: 'worker-b',
				capabilities: ['claude'],
			});
			const unfederatedRun = await createRun({
				projectId: PROJECT_ID,
				taskId: 'local',
				phase: 'review',
			});
			const workerARun = await createRun({
				projectId: PROJECT_ID,
				taskId: 'worker-a',
				phase: 'implementation',
				workerId: workerA.worker.id,
			});
			const workerBRun = await createRun({
				projectId: PROJECT_ID,
				taskId: 'worker-b',
				phase: 'planning',
				workerId: workerB.worker.id,
			});
			const settledWorkerARun = await createRun({
				projectId: PROJECT_ID,
				taskId: 'worker-a-settled',
				phase: 'review',
				workerId: workerA.worker.id,
			});
			await completeRun(settledWorkerARun, { status: 'completed' });

			expect(await failOrphanedRunningRuns('worker A restarted', workerA.worker.id)).toBe(1);
			expect((await getRunByIdFromDb(workerARun))?.status).toBe('failed');
			expect((await getRunByIdFromDb(unfederatedRun))?.status).toBe('running');
			expect((await getRunByIdFromDb(workerBRun))?.status).toBe('running');
			expect((await getRunByIdFromDb(settledWorkerARun))?.status).toBe('completed');

			expect(await failOrphanedRunningRuns('local worker restarted', null)).toBe(1);
			expect((await getRunByIdFromDb(unfederatedRun))?.status).toBe('failed');
			expect((await getRunByIdFromDb(workerBRun))?.status).toBe('running');
		});

		it('returns 0 when there are no running rows', async () => {
			expect(await failOrphanedRunningRuns('nothing to do', null)).toBe(0);
		});
	});

	describe('failStaleRunningRuns', () => {
		it('fails only running rows older than the cutoff, sparing fresh and settled ones', async () => {
			const stale = await createRun({ projectId: PROJECT_ID, taskId: '20', phase: 'review' });
			const fresh = await createRun({ projectId: PROJECT_ID, taskId: '21', phase: 'planning' });
			const settledOld = await createRun({
				projectId: PROJECT_ID,
				taskId: '22',
				phase: 'implementation',
			});
			await completeRun(settledOld, { status: 'completed' });
			// Backdate the stale row and the settled row well past any plausible timeout.
			const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
			await getDb()
				.update(runs)
				.set({ startedAt: old })
				.where(inArray(runs.id, [stale, settledOld]));

			const count = await failStaleRunningRuns(60 * 60 * 1000, 0, 'reconciled as stale');

			expect(count).toBe(1);
			const staleRow = await getRunByIdFromDb(stale);
			expect(staleRow?.status).toBe('failed');
			expect(staleRow?.error).toBe('reconciled as stale');
			expect(staleRow?.completedAt).toBeInstanceOf(Date);
			// A running row inside the cutoff is a genuine in-flight run — untouched.
			expect((await getRunByIdFromDb(fresh))?.status).toBe('running');
			// A settled row is never rewritten, however old.
			expect((await getRunByIdFromDb(settledOld))?.status).toBe('completed');
		});

		it('returns 0 when no running row predates the cutoff', async () => {
			await createRun({ projectId: PROJECT_ID, taskId: '23', phase: 'review' });
			expect(await failStaleRunningRuns(60 * 60 * 1000, 0, 'noop')).toBe(0);
		});

		it('evaluates row-specific timeoutMs when reconciling stale runs', async () => {
			// A run with 2 hours timeout started 1.5 hours ago should NOT be failed.
			const longRun = await createRun({
				projectId: PROJECT_ID,
				taskId: '24',
				phase: 'implementation',
				timeoutMs: 2 * 60 * 60 * 1000, // 2 hours
			});
			// A run with 30 min timeout started 1 hour ago SHOULD be failed.
			const shortRun = await createRun({
				projectId: PROJECT_ID,
				taskId: '25',
				phase: 'implementation',
				timeoutMs: 30 * 60 * 1000, // 30 mins
			});

			const oldLong = new Date(Date.now() - 1.5 * 60 * 60 * 1000); // 1.5 hours ago
			const oldShort = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1 hour ago

			await getDb().update(runs).set({ startedAt: oldLong }).where(eq(runs.id, longRun));
			await getDb().update(runs).set({ startedAt: oldShort }).where(eq(runs.id, shortRun));

			const count = await failStaleRunningRuns(
				45 * 60 * 1000, // default timeout
				10 * 60 * 1000, // margin
				'reconciled as stale',
			);

			expect(count).toBe(1);
			expect((await getRunByIdFromDb(longRun))?.status).toBe('running');
			expect((await getRunByIdFromDb(shortRun))?.status).toBe('failed');
		});
	});

	describe('agentSessionId', () => {
		it('seeds agentSessionId with the run id on createRun and round-trips it', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '55', phase: 'planning' });
			const row = await getRunByIdFromDb(id);
			// createRun uses the row id as the deterministic Claude session handle.
			expect(row?.agentSessionId).toBe(id);
		});

		it('leaves agentSessionId intact when completeRun omits it (a resumable defer)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '55', phase: 'planning' });
			await completeRun(id, { status: 'deferred', engine: 'claude' });
			const row = await getRunByIdFromDb(id);
			expect(row?.agentSessionId).toBe(id);
		});

		it('clears agentSessionId when completeRun passes null (a non-resumable settle)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '55', phase: 'planning' });
			await completeRun(id, { status: 'failed', engine: 'claude', agentSessionId: null });
			const row = await getRunByIdFromDb(id);
			expect(row?.agentSessionId).toBeNull();
		});
	});

	describe('hasResumableDeferredRun', () => {
		it('is true for a claude PM-phase run deferred with its session preserved', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '80', phase: 'planning' });
			await completeRun(id, { status: 'deferred', engine: 'claude' });
			expect(await hasResumableDeferredRun(PROJECT_ID, '80')).toBe(true);
		});

		it('is false when the deferred run cleared its session (non-resumable)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '80', phase: 'implementation' });
			await completeRun(id, { status: 'deferred', engine: 'claude', agentSessionId: null });
			expect(await hasResumableDeferredRun(PROJECT_ID, '80')).toBe(false);
		});

		it('is true for a non-claude engine', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '80', phase: 'implementation' });
			await completeRun(id, { status: 'deferred', engine: 'antigravity' });
			expect(await hasResumableDeferredRun(PROJECT_ID, '80')).toBe(true);
		});

		it('is true for a non-PM phase (e.g. review)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '80', phase: 'review' });
			await completeRun(id, { status: 'deferred', engine: 'claude' });
			expect(await hasResumableDeferredRun(PROJECT_ID, '80')).toBe(true);
		});

		it('is false for a settled (non-deferred) run', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '80', phase: 'planning' });
			await completeRun(id, { status: 'completed', engine: 'claude' });
			expect(await hasResumableDeferredRun(PROJECT_ID, '80')).toBe(false);
		});

		it('is true for a failed run with its session preserved', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '80', phase: 'planning' });
			await completeRun(id, {
				status: 'failed',
				engine: 'claude',
				agentSessionId: '11111111-1111-4111-8111-111111111111',
			});
			expect(await hasResumableDeferredRun(PROJECT_ID, '80')).toBe(true);
		});

		it('scopes to the given project and task', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '80', phase: 'planning' });
			await completeRun(id, { status: 'deferred', engine: 'claude' });
			expect(await hasResumableDeferredRun(PROJECT_ID, '81')).toBe(false);
			expect(await hasResumableDeferredRun('proj-other', '80')).toBe(false);
		});
	});

	/**
	 * The `checkpointed` retry-pending status (issue #503). These run against real SQL
	 * because every one of them is a *query* claim: which rows the retention pin sees,
	 * which the runs list hides, and which columns survive a retry.
	 */
	describe('checkpointed runs (Tier 2, issue #503)', () => {
		const CHECKPOINT = {
			phase: 'implementation' as const,
			completed: ['Added the schema and its tests'],
			remaining: ['Update the docs', 'Run the focused tests'],
			decisions: [],
			workingTree: { modified: ['src/config/schema.ts'], added: [], deleted: [] },
		};

		async function checkpointedRun(taskId: string, continuationCount = 1): Promise<string> {
			const id = await createRun({ projectId: PROJECT_ID, taskId, phase: 'implementation' });
			await completeRun(id, {
				status: 'checkpointed',
				engine: 'claude',
				error: 'rate limited',
				agentSessionId: null,
				checkpoint: CHECKPOINT,
				continuationCount,
			});
			return id;
		}

		it('persists the checkpoint and the spent continuation count', async () => {
			const id = await checkpointedRun('120');

			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('checkpointed');
			expect(row?.agentSessionId).toBeNull();
			expect(row?.checkpoint).toEqual(CHECKPOINT);
			expect(row?.continuationCount).toBe(1);
		});

		// The retention pin cannot key on `agent_session_id` here: a checkpointed row has
		// none by design, and pruning its checkout would delete the tree its checkpoint
		// describes.
		it('pins the task checkout even though it holds no session id', async () => {
			await checkpointedRun('121');
			expect(await hasResumableDeferredRun(PROJECT_ID, '121')).toBe(true);
		});

		it('is hidden from the runs list while a dispatch is waiting on it, like a deferred row', async () => {
			const id = await checkpointedRun('122');
			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: {
					...createMockScmWebhookJob({ deliveryId: 'checkpointed-dispatch' }),
					projectId: PROJECT_ID,
					runId: id,
				} as SwarmJob,
				source: 'synthetic',
				waitReason: 'rate-limit',
				runId: id,
				state: 'retry-scheduled',
			});

			const { data } = await listRunsFromDb({ projectId: PROJECT_ID, limit: 50, offset: 0 });
			expect(data.map((row) => row.id)).not.toContain(id);
		});

		// The count is the bound on the fallback, so the very retry the fallback scheduled
		// must not reset it — otherwise the loop is unbounded.
		it('keeps the continuation count and checkpoint through a retry', async () => {
			const id = await checkpointedRun('123', 2);

			expect(await resetRunToRunning(id, undefined, 'checkpointed')).toBe(true);
			const row = await getRunByIdFromDb(id);
			expect(row?.status).toBe('running');
			expect(row?.continuationCount).toBe(2);
			expect(row?.checkpoint).toEqual(CHECKPOINT);
		});

		// "Reset & restart" is the one action that forgives the spent budget: it discards
		// the checkout, so the checkpoint describes a tree that no longer exists.
		it('clears both on a reset-and-restart', async () => {
			const id = await checkpointedRun('124', 2);

			await clearRunRecovery(id);
			const row = await getRunByIdFromDb(id);
			expect(row?.continuationCount).toBe(0);
			expect(row?.checkpoint).toBeNull();
		});

		it('can be terminated through the deferred-cancellation path, preserving no session', async () => {
			const id = await checkpointedRun('125');
			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: {
					...createMockScmWebhookJob({ deliveryId: 'checkpointed-cancel' }),
					projectId: PROJECT_ID,
					runId: id,
				} as SwarmJob,
				source: 'synthetic',
				waitReason: 'rate-limit',
				runId: id,
				state: 'retry-scheduled',
			});

			const result = await cancelDeferredRunInDb(id, 'Cancelled by user', {
				source: 'dashboard',
				requestedAt: new Date().toISOString(),
			});

			expect(result.success).toBe(true);
			expect(result.dispatch).not.toBeNull();
			expect(result.preservedSession).toBeNull();
			expect((await getRunByIdFromDb(id))?.status).toBe('failed');
		});
	});

	// The optional-`excludeRunId` form the provision-time lease-liveness check uses
	// (issue #427); the #424 reset path's always-excluded form is covered above.
	describe('hasLiveRunForTask without an excluded run (issue #427)', () => {
		it('is true while a run for the task is running', async () => {
			await createRun({ projectId: PROJECT_ID, taskId: '85', phase: 'review' });
			expect(await hasLiveRunForTask(PROJECT_ID, '85')).toBe(true);
		});

		it('is false once that run settles', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '85', phase: 'review' });
			await completeRun(id, { status: 'completed', engine: 'claude' });
			expect(await hasLiveRunForTask(PROJECT_ID, '85')).toBe(false);
		});

		it('is false when the only running run is the excluded asking run', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '85', phase: 'review' });
			expect(await hasLiveRunForTask(PROJECT_ID, '85', id)).toBe(false);
		});

		it('is true when another run for the task is running alongside the asking one', async () => {
			const mine = await createRun({ projectId: PROJECT_ID, taskId: '85', phase: 'review' });
			await createRun({ projectId: PROJECT_ID, taskId: '85', phase: 'respond-to-review' });
			expect(await hasLiveRunForTask(PROJECT_ID, '85', mine)).toBe(true);
		});

		it('scopes to the given project and task', async () => {
			await createRun({ projectId: PROJECT_ID, taskId: '85', phase: 'review' });
			expect(await hasLiveRunForTask(PROJECT_ID, '86')).toBe(false);
			expect(await hasLiveRunForTask('proj-other', '85')).toBe(false);
		});
	});

	describe('updateReviewMergeOutcome / getPendingReviewMergeFollowUps (issue #278)', () => {
		it('persists the outcome, message, attempt, and approved head', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '90', phase: 'review' });

			const updated = await updateReviewMergeOutcome(id, {
				status: 'not-ready',
				message: 'required checks are still pending',
				attempt: 0,
				approvedHeadSha: 'sha-1',
			});

			expect(updated).toBe(true);
			const row = await getRunByIdFromDb(id);
			expect(row?.reviewMergeOutcome).toBe('not-ready');
			expect(row?.reviewMergeMessage).toBe('required checks are still pending');
			expect(row?.reviewMergeAttempt).toBe(0);
			expect(row?.reviewMergeApprovedHeadSha).toBe('sha-1');
		});

		it('accepts a later attempt for the same approved head (same generation)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '91', phase: 'review' });
			await updateReviewMergeOutcome(id, {
				status: 'not-ready',
				message: 'first attempt',
				attempt: 0,
				approvedHeadSha: 'sha-1',
			});

			const updated = await updateReviewMergeOutcome(id, {
				status: 'merged',
				message: 'merged on retry',
				attempt: 1,
				approvedHeadSha: 'sha-1',
			});

			expect(updated).toBe(true);
			const row = await getRunByIdFromDb(id);
			expect(row?.reviewMergeOutcome).toBe('merged');
			expect(row?.reviewMergeAttempt).toBe(1);
		});

		it('rejects a write for a superseded approved-head generation (issue #278 dedup guard)', async () => {
			const id = await createRun({ projectId: PROJECT_ID, taskId: '92', phase: 'review' });
			await updateReviewMergeOutcome(id, {
				status: 'not-ready',
				message: 'first generation',
				attempt: 0,
				approvedHeadSha: 'sha-old',
			});
			// The row moved on to a new approval generation (e.g. a re-run Review),
			// which — like every real retry — resets through `resetRunToRunning`
			// first, clearing the guard column so the new generation can claim it.
			await resetRunToRunning(id);
			await updateReviewMergeOutcome(id, {
				status: 'not-ready',
				message: 'second generation',
				attempt: 0,
				approvedHeadSha: 'sha-new',
			});

			// A stale follow-up from the first generation must not clobber it.
			const stale = await updateReviewMergeOutcome(id, {
				status: 'merged',
				message: 'stale merge from the old generation',
				attempt: 3,
				approvedHeadSha: 'sha-old',
			});

			expect(stale).toBe(false);
			const row = await getRunByIdFromDb(id);
			expect(row?.reviewMergeOutcome).toBe('not-ready');
			expect(row?.reviewMergeMessage).toBe('second generation');
		});

		it('returns false for an unknown run id', async () => {
			expect(
				await updateReviewMergeOutcome('00000000-0000-0000-0000-000000000000', {
					status: 'merged',
					message: 'x',
					attempt: 0,
					approvedHeadSha: 'sha-1',
				}),
			).toBe(false);
		});

		it('lists only review runs whose merge outcome is durably pending (not-ready)', async () => {
			const pending = await createRun({ projectId: PROJECT_ID, taskId: '93', phase: 'review' });
			await updateReviewMergeOutcome(pending, {
				status: 'not-ready',
				message: 'waiting',
				attempt: 1,
				approvedHeadSha: 'sha-1',
			});
			const merged = await createRun({ projectId: PROJECT_ID, taskId: '94', phase: 'review' });
			await updateReviewMergeOutcome(merged, {
				status: 'merged',
				message: 'done',
				attempt: 0,
				approvedHeadSha: 'sha-2',
			});
			await createRun({ projectId: PROJECT_ID, taskId: '95', phase: 'implementation' });

			const rows = await getPendingReviewMergeFollowUps();

			expect(rows.map((r) => r.id)).toEqual([pending]);
		});
	});
});
