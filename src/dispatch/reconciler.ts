/**
 * Dispatch reconciliation (issue #284, ADR-002) — the repair loop that makes
 * every hand-off boundary crash-safe:
 *
 *  - persist → publish: a dispatch whose wake-up never landed is re-published
 *    (deterministic wake ids make the re-add a queue no-op when it did land);
 *  - claim → run: a leased/running dispatch whose lease expired belongs to a
 *    dead process — fail it (and its still-`running` run row) visibly;
 *  - legacy shapes: Redis pending-continuation entries and `deferred` runs with
 *    no active dispatch (the exact #269/#279 orphans) are imported as durable
 *    dispatches once, at startup.
 *
 * Runs inside the worker: once at startup (after migrations, before serving
 * jobs) and periodically while serving. Every step is best-effort and logged —
 * reconciliation must never stop the worker from serving real work.
 */

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { ProjectConfig } from '../config/schema.js';
import {
	createDispatch,
	type DispatchRow,
	failExpiredDispatchLeases,
	failSupersededWorkerDispatchClaims,
	listDeferredRunsWithoutActiveDispatch,
	listProjectsWithCapacityPending,
	listWakeablePendingDispatches,
} from '../db/repositories/dispatchesRepository.js';
import { findProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import {
	failRunFromStatus,
	getPendingReviewMergeFollowUps,
} from '../db/repositories/runsRepository.js';
import { requireEnv } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';
import { type MergeAutomationJob, type SwarmJob, SwarmJobSchema } from '../queue/jobs.js';
import { priorityFor } from '../queue/producer.js';
import type { TriggerPhase } from '../triggers/types.js';
import { mergeDispatchDedupKey } from '../worker/merge-automation.js';
import { promoteNextCapacityDispatch, publishDispatchWakeUp } from './dispatcher.js';

/** The Redis namespace the retired pending-continuation registry lived under. */
const LEGACY_CONTINUATION_NS = 'swarm:pending-continuations:';
const LEGACY_CONTINUATION_CLAIM_NS = 'swarm:pending-continuation-claims:';

/** The retired standalone merge-follow-up queue (issue #278, folded into dispatches by #292). */
const LEGACY_MERGE_FOLLOW_UP_QUEUE = 'swarm-merge-follow-ups';

const DEAD_LEASE_REASON =
	'Worker lease expired without the dispatch settling — reconciled as failed (dead worker or crashed phase)';
const SUPERSEDED_WORKER_SESSION_REASON =
	'Worker session was superseded before the dispatch settled — reconciled as failed';

async function settleFailedDispatchRuns(failed: DispatchRow[]): Promise<void> {
	for (const dispatch of failed) {
		if (dispatch.runId) {
			await failRunFromStatus(
				dispatch.runId,
				dispatch.lastError ?? DEAD_LEASE_REASON,
				'running',
			).catch((err) =>
				logger.error('dispatch-reconciler: failed to settle run for dead worker claim', {
					runId: dispatch.runId,
					error: describeError(err),
				}),
			);
		}
	}
}

/**
 * Fail leased/running dispatches abandoned by a dead process, and settle their
 * still-`running` run rows the same way so the two records never disagree.
 * Only leases expired by `asOf` are reclaimed. A newly started federated worker
 * must not fail another host's still-live dispatch.
 */
async function reclaimDeadLeases(asOf: Date): Promise<number> {
	const failed = await failExpiredDispatchLeases(DEAD_LEASE_REASON, asOf);
	await settleFailedDispatchRuns(failed);
	return failed.length;
}

/** Reap claims left by this worker's older fenced session after re-acquisition. */
export async function reconcileSupersededWorkerClaims(
	workerId: string,
	activeFencingToken: number,
): Promise<number> {
	const failed = await failSupersededWorkerDispatchClaims(
		workerId,
		activeFencingToken,
		SUPERSEDED_WORKER_SESSION_REASON,
	);
	await settleFailedDispatchRuns(failed);
	return failed.length;
}

/** Re-publish wake-ups for every wakeable dispatch (idempotent by design). */
async function republishWakeUps(): Promise<number> {
	const wakeable = await listWakeablePendingDispatches();
	let published = 0;
	for (const dispatch of wakeable) {
		try {
			await publishDispatchWakeUp(dispatch);
			published += 1;
		} catch (err) {
			logger.warn('dispatch-reconciler: failed to re-publish wake-up', {
				dispatchId: dispatch.id,
				error: describeError(err),
			});
		}
	}
	return published;
}

/** Wake capacity-blocked work in every project that holds some. */
async function promoteCapacityPending(
	prioritizeContinuationsFor: (projectId: string) => boolean,
): Promise<void> {
	const projectIds = await listProjectsWithCapacityPending();
	for (const projectId of projectIds) {
		await promoteNextCapacityDispatch(projectId, prioritizeContinuationsFor(projectId));
	}
}

/** Parse a legacy pending-continuation entry; `undefined` for malformed values. */
function parseLegacyContinuation(raw: string):
	| {
			taskId: string;
			phase: string;
			job: SwarmJob;
			continuation: boolean;
	  }
	| undefined {
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		const job = SwarmJobSchema.safeParse(value.job);
		if (typeof value.taskId === 'string' && typeof value.phase === 'string' && job.success) {
			return {
				taskId: value.taskId,
				phase: value.phase,
				job: job.data,
				continuation: value.continuation === true,
			};
		}
	} catch {
		// fall through
	}
	return undefined;
}

/**
 * One-time import of the retired Redis pending-continuation registry into
 * capacity-pending dispatches. Each imported field is deleted from Redis only
 * after its dispatch exists (or is provably a duplicate); the whole step is
 * skipped silently when Redis has no legacy keys.
 */
async function backfillLegacyPendingContinuations(): Promise<number> {
	const redis = new Redis({
		...parseRedisUrl(requireEnv('REDIS_URL')),
		maxRetriesPerRequest: 1,
	});
	redis.on('error', (err) => {
		logger.warn('dispatch-reconciler: Redis connection error during legacy backfill', {
			error: String(err),
		});
	});
	let imported = 0;
	try {
		const keys = await redis.keys(`${LEGACY_CONTINUATION_NS}*`);
		for (const key of keys) {
			const projectId = key.slice(LEGACY_CONTINUATION_NS.length);
			const all = await redis.hgetall(key);
			for (const [field, raw] of Object.entries(all)) {
				const entry = parseLegacyContinuation(raw);
				if (!entry) {
					await redis.hdel(key, field);
					continue;
				}
				try {
					await createDispatch({
						projectId,
						jobPayload: entry.job,
						priority: priorityFor(entry.job) ?? 0,
						source: 'recovered',
						state: 'pending',
						waitReason: 'project-capacity',
						continuation: entry.continuation,
						runId: entry.job.runId,
						taskId: entry.taskId,
						attempt: entry.job.rateLimitRetryAttempt ?? 0,
					});
					imported += 1;
				} catch (err) {
					// Most likely the one-active-dispatch-per-run constraint: the run
					// already has durable intent (e.g. the deferred-run backfill won the
					// race) — the legacy entry is a duplicate and safe to drop.
					logger.warn('dispatch-reconciler: legacy continuation import refused', {
						projectId,
						field,
						error: describeError(err),
					});
				}
				await redis.hdel(key, field);
				await redis.del(`${LEGACY_CONTINUATION_CLAIM_NS}${projectId}:${field}`);
			}
		}
	} finally {
		try {
			await redis.quit();
		} catch {
			redis.disconnect();
		}
	}
	return imported;
}

/**
 * Import `deferred` runs with no active dispatch as `retry-scheduled`
 * dispatches — the durable repair for a retry whose delayed job vanished (the
 * exact #269/#279 orphan shapes). The run row's persisted `jobPayload` is the
 * retry intent; its recorded `nextRetryAt` (or now) is the schedule. A run
 * without a payload cannot be reconstructed and is surfaced for operator
 * action instead of being silently discarded.
 */
async function backfillOrphanedDeferredRuns(): Promise<number> {
	const orphans = await listDeferredRunsWithoutActiveDispatch();
	let imported = 0;
	for (const run of orphans) {
		if (!run.jobPayload) {
			logger.warn(
				'dispatch-reconciler: deferred run has no stored job payload — leave for operator action (Retry now cannot rebuild it either)',
				{ runId: run.id, projectId: run.projectId, taskId: run.taskId, phase: run.phase },
			);
			continue;
		}
		const parsed = SwarmJobSchema.safeParse(run.jobPayload);
		if (!parsed.success) {
			logger.warn('dispatch-reconciler: deferred run payload failed validation — skipping', {
				runId: run.id,
				error: parsed.error.message,
			});
			continue;
		}
		const job: SwarmJob = { ...parsed.data, runId: run.id };
		try {
			const { dispatch } = await createDispatch({
				projectId: run.projectId,
				jobPayload: job,
				priority: priorityFor(job) ?? 0,
				source: 'recovered',
				state: 'retry-scheduled',
				waitReason: 'recovered',
				availableAt: run.nextRetryAt ?? new Date(),
				runId: run.id,
				taskId: run.taskId,
				phase: run.phase as TriggerPhase,
				attempt: job.rateLimitRetryAttempt ?? 0,
			});
			await publishDispatchWakeUp(dispatch);
			imported += 1;
		} catch (err) {
			logger.warn('dispatch-reconciler: deferred-run import refused', {
				runId: run.id,
				error: describeError(err),
			});
		}
	}
	return imported;
}

/**
 * One-time import of durable merge intent left behind by the retired
 * standalone merge-follow-up queue (issue #278 → #292): Review runs whose last
 * recorded merge outcome is still the transient `not-ready` get a
 * merge-automation dispatch, eligible immediately. The dispatch dedup key
 * (`merge:<runId>`) makes re-running this on every startup safe — a run whose
 * dispatch already exists (active *or* settled/cancelled) is skipped, so a
 * cancelled merge is never resurrected. The retired BullMQ queue itself is
 * then drained best-effort; its delayed jobs carried no state Postgres doesn't
 * already hold.
 */
async function backfillLegacyMergeFollowUps(): Promise<number> {
	const pending = await getPendingReviewMergeFollowUps();
	let imported = 0;
	for (const run of pending) {
		if (!run.prNumber || !run.reviewMergeApprovedHeadSha) continue;
		// Scoped to the repository the *run* recorded, not the project's default entry
		// (issue #684 phase 2), so the imported intent merges the pull request the Review
		// actually approved. A run whose project no longer exists — or no longer owns
		// that repository — is skipped with a warning rather than throwing: this is a
		// best-effort one-time import running at startup, and an unimportable legacy row
		// must not stop the reconciler from doing the rest of its work.
		let project: ProjectConfig;
		try {
			const scoped = await findProjectByIdFromDb(run.projectId, run.repository);
			if (!scoped) throw new Error(`project '${run.projectId}' no longer exists`);
			project = scoped;
		} catch (err) {
			logger.warn('dispatch-reconciler: pending merge follow-up cannot be scoped — skipping', {
				runId: run.id,
				projectId: run.projectId,
				repository: run.repository,
				error: describeError(err),
			});
			continue;
		}
		const job: MergeAutomationJob = {
			type: 'merge-automation',
			projectId: run.projectId,
			reviewRunId: run.id,
			repo: project.repo,
			prNumber: run.prNumber,
			approvedHeadSha: run.reviewMergeApprovedHeadSha,
		};
		try {
			const { dispatch, created } = await createDispatch({
				projectId: run.projectId,
				jobPayload: job,
				dedupKey: mergeDispatchDedupKey(run.id),
				source: 'recovered',
				waitReason: 'recovered',
				runId: run.id,
				taskId: run.taskId ?? undefined,
				phase: 'merge-automation',
				attempt: (run.reviewMergeAttempt ?? 0) + 1,
			});
			if (!created) continue;
			await publishDispatchWakeUp(dispatch);
			imported += 1;
		} catch (err) {
			logger.warn('dispatch-reconciler: legacy merge follow-up import refused', {
				runId: run.id,
				error: describeError(err),
			});
		}
	}
	// Drain regardless of what was imported: a stale delayed job whose run row
	// has since moved past `not-ready` matches no import but must still never
	// fire (nothing consumes this queue anymore — this is just Redis hygiene).
	await drainLegacyMergeFollowUpQueue();
	return imported;
}

/**
 * Obliterate the retired merge-follow-up queue so its delayed jobs can't linger
 * in Redis. Only obliterates when the queue actually holds jobs: nothing
 * consumes it anymore, so this is pure hygiene, and skipping the write once the
 * queue is empty stops every subsequent startup from re-obliterating an
 * already-drained queue.
 */
async function drainLegacyMergeFollowUpQueue(): Promise<void> {
	const queue = new Queue(LEGACY_MERGE_FOLLOW_UP_QUEUE, {
		connection: parseRedisUrl(requireEnv('REDIS_URL')),
	});
	try {
		const counts = await queue.getJobCounts();
		const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
		if (total > 0) await queue.obliterate({ force: true });
	} catch (err) {
		logger.warn('dispatch-reconciler: failed to drain the retired merge-follow-up queue', {
			error: describeError(err),
		});
	} finally {
		await queue.close().catch(() => {});
	}
}

/**
 * Startup reconciliation — run after migrations and the orphaned-run sweep,
 * before the worker serves jobs. Order matters: dead leases are settled first
 * so their runs can be re-imported cleanly if they were deferred; legacy
 * registries are imported before wake-ups are re-published so the fresh
 * dispatches get their wake-ups in the same pass.
 */
export async function reconcileDispatchesAtStartup(): Promise<void> {
	try {
		const reclaimed = await reclaimDeadLeases(new Date());
		const legacy = await backfillLegacyPendingContinuations();
		const orphans = await backfillOrphanedDeferredRuns();
		const merges = await backfillLegacyMergeFollowUps();
		const republished = await republishWakeUps();
		if (reclaimed > 0 || legacy > 0 || orphans > 0 || merges > 0 || republished > 0) {
			logger.info('dispatch-reconciler: startup reconciliation complete', {
				deadLeases: reclaimed,
				legacyContinuationsImported: legacy,
				orphanedDeferredRunsImported: orphans,
				legacyMergeFollowUpsImported: merges,
				wakeUpsRepublished: republished,
			});
		}
	} catch (err) {
		logger.error('dispatch-reconciler: startup reconciliation failed (continuing)', {
			error: describeError(err),
		});
	}
}

/**
 * Periodic reconciliation while serving jobs: reclaim expired leases,
 * re-publish any wake-up a crash window lost, and nudge capacity-blocked work
 * whose slot-release wake-up went missing.
 */
export async function reconcileDispatchesPeriodically(
	prioritizeContinuationsFor: (projectId: string) => boolean,
): Promise<void> {
	try {
		const reclaimed = await reclaimDeadLeases(new Date());
		const republished = await republishWakeUps();
		await promoteCapacityPending(prioritizeContinuationsFor);
		if (reclaimed > 0) {
			logger.warn('dispatch-reconciler: reclaimed expired dispatch leases', {
				count: reclaimed,
				wakeUpsRepublished: republished,
			});
		}
	} catch (err) {
		logger.error('dispatch-reconciler: periodic reconciliation failed (continuing)', {
			error: describeError(err),
		});
	}
}
