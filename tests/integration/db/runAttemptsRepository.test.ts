import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import {
	listRunAttempts,
	openRunAttempt,
	recordNextAttemptTrigger,
} from '../../../src/db/repositories/runAttemptsRepository.js';
import {
	appendRunOutputEvents,
	completeRun,
	createRun,
	failRunFromStatus,
	failStaleRunningRuns,
	getRunByIdFromDb,
	getRunOutputEvents,
	MAX_RUN_OUTPUT_BYTES,
	resetRunToRunning,
} from '../../../src/db/repositories/runsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { runAttempts } from '../../../src/db/schema/runs.js';
import { registerWorker } from '../../../src/identity/worker-service.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-attempts';
const REPO = 'jkwiecien/attempts-repo';

async function seedWorker(label: string): Promise<string> {
	const owner = await createUser({ identifier: `${label}@example.com`, displayName: label });
	const { worker } = await registerWorker({
		ownerUserId: owner.id,
		displayName: label,
		capabilities: ['claude', 'codex'],
	});
	return worker.id;
}

const line = (content: string) => ({ stream: 'stdout' as const, content, emittedAt: new Date() });

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('runAttemptsRepository (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
		await seedProject({ id: PROJECT_ID, repo: REPO });
	});

	it('keeps a rate-limit deferral and a later reset attempt’s fetch failure apart (issue #1400)', async () => {
		// The shape of run 667489fa: attempt 1 on one worker is deferred for a Codex usage
		// limit, an operator resets the run, and attempt 2 on another worker fails before
		// any agent ran.
		const workerA = await seedWorker('jacek_uc_platform');
		const workerB = await seedWorker('karolina_uc_platform');
		const firstDispatch = randomUUID();
		const resetDispatch = randomUUID();

		const runId = await createRun({
			projectId: PROJECT_ID,
			repository: REPO,
			taskId: '2113',
			phase: 'resolve-conflicts',
			workerId: workerA,
			engine: 'codex',
		});
		const first = await openRunAttempt(runId, firstDispatch);
		await appendRunOutputEvents(runId, [line('resolved the conflicts\n'), line('usage limit\n')], {
			dispatchId: firstDispatch,
			workerId: workerA,
		});
		const retryAt = new Date(Date.now() + 3_600_000);
		await completeRun(runId, {
			status: 'deferred',
			error: 'Phase stopped - Resolve-conflicts — rate-limited, deferring retry',
			nextRetryAt: retryAt,
		});

		await recordNextAttemptTrigger(runId, 'reset');
		expect((await getRunByIdFromDb(runId))?.nextAttemptTrigger).toBe('reset');
		await resetRunToRunning(
			runId,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			'claude',
			undefined,
			undefined,
			workerB,
		);
		const second = await openRunAttempt(runId, resetDispatch);
		await completeRun(runId, {
			status: 'failed',
			error: 'git worktree add … issue-2113 failed: fatal: invalid reference: issue-2113',
		});

		const { attempts, unattributedOutputEventCount } = await listRunAttempts(runId);
		expect(unattributedOutputEventCount).toBe(0);
		expect(attempts).toHaveLength(2);
		expect(attempts[0]).toMatchObject({
			id: first,
			seq: 1,
			dispatchId: firstDispatch,
			trigger: 'automatic',
			requestedAt: null,
			workerId: workerA,
			engine: 'codex',
			outcome: 'deferred',
			error: 'Phase stopped - Resolve-conflicts — rate-limited, deferring retry',
			nextRetryAt: retryAt,
			outputEventCount: 2,
		});
		expect(attempts[0].endedAt).toBeInstanceOf(Date);
		expect(attempts[1]).toMatchObject({
			id: second,
			seq: 2,
			dispatchId: resetDispatch,
			trigger: 'reset',
			workerId: workerB,
			engine: 'claude',
			outcome: 'failed',
			error: 'git worktree add … issue-2113 failed: fatal: invalid reference: issue-2113',
			outputEventCount: 0,
		});
		expect(attempts[1].requestedAt).toBeInstanceOf(Date);
		// The marker is consumed by the attempt it started.
		expect((await getRunByIdFromDb(runId))?.nextAttemptTrigger).toBeNull();

		const output = await getRunOutputEvents(runId, 0);
		expect(output.events.map((event) => event.attemptId)).toEqual([first, first]);
		expect((await getRunOutputEvents(runId, 0, second)).events).toEqual([]);
	});

	it('never rewrites a closed attempt when its retry-pending run is settled later', async () => {
		const runId = await createRun({
			projectId: PROJECT_ID,
			repository: REPO,
			taskId: '1',
			phase: 'review',
		});
		await openRunAttempt(runId, randomUUID());
		await completeRun(runId, { status: 'deferred', error: 'rate-limited' });
		await failRunFromStatus(runId, 'Reset & restart requested by an operator', 'deferred');

		const { attempts } = await listRunAttempts(runId);
		expect(attempts[0]).toMatchObject({ outcome: 'deferred', error: 'rate-limited' });
	});

	it('closes attempts a sweep fails and attempts a re-claim supersedes', async () => {
		const stale = await createRun({
			projectId: PROJECT_ID,
			repository: REPO,
			taskId: '2',
			phase: 'review',
			timeoutMs: 1,
		});
		await openRunAttempt(stale, randomUUID());
		await new Promise((resolve) => setTimeout(resolve, 20));
		await failStaleRunningRuns(1, 0, 'stale run reaped');
		expect((await listRunAttempts(stale)).attempts[0]).toMatchObject({
			outcome: 'failed',
			error: 'stale run reaped',
		});

		const reclaimed = await createRun({
			projectId: PROJECT_ID,
			repository: REPO,
			taskId: '3',
			phase: 'review',
		});
		await openRunAttempt(reclaimed, randomUUID());
		await resetRunToRunning(reclaimed);
		await openRunAttempt(reclaimed, randomUUID());
		const { attempts } = await listRunAttempts(reclaimed);
		expect(attempts.map((attempt) => attempt.outcome)).toEqual(['superseded', null]);
	});

	it('credits late output to the attempt that streamed it, not the newest one', async () => {
		const workerA = await seedWorker('lost');
		const workerB = await seedWorker('retry');
		const lostDispatch = randomUUID();
		const runId = await createRun({
			projectId: PROJECT_ID,
			repository: REPO,
			taskId: '4',
			phase: 'review',
			workerId: workerA,
		});
		const lost = await openRunAttempt(runId, lostDispatch);
		await completeRun(runId, { status: 'deferred', error: 'transport lost' });
		await resetRunToRunning(
			runId,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			workerB,
		);
		const retry = await openRunAttempt(runId, randomUUID());

		await appendRunOutputEvents(runId, [line('late line\n')], {
			dispatchId: lostDispatch,
			workerId: workerA,
		});
		await appendRunOutputEvents(runId, [line('control-plane note\n')]);
		await appendRunOutputEvents(runId, [line('unknown stream\n')], {
			dispatchId: randomUUID(),
			workerId: workerA,
		});

		const output = await getRunOutputEvents(runId, 0);
		expect(output.events.map((event) => [event.content, event.attemptId])).toEqual([
			['late line\n', lost],
			['control-plane note\n', retry],
			['unknown stream\n', null],
		]);
	});

	it('applies the retention cap per attempt, so a flooded attempt cannot silence the next', async () => {
		const runId = await createRun({
			projectId: PROJECT_ID,
			repository: REPO,
			taskId: '5',
			phase: 'review',
		});
		const first = await openRunAttempt(runId, randomUUID());
		await getDb()
			.update(runAttempts)
			.set({ outputBytes: MAX_RUN_OUTPUT_BYTES - 3 })
			.where(eq(runAttempts.id, first as string));
		await appendRunOutputEvents(runId, [line('abcdef')]);
		await completeRun(runId, { status: 'failed', error: 'boom' });

		await resetRunToRunning(runId);
		const second = await openRunAttempt(runId, randomUUID());
		await appendRunOutputEvents(runId, [line('second attempt\n')]);

		const output = await getRunOutputEvents(runId, 0);
		expect(output.events.map((event) => [event.content, event.attemptId])).toEqual([
			['abc', first],
			['second attempt\n', second],
		]);
		expect(output.truncated).toBe(true);
		const { attempts } = await listRunAttempts(runId);
		expect(attempts.map((attempt) => attempt.outputTruncated)).toEqual([true, false]);
	});
});
