import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import {
	createDispatch,
	listActiveDispatchTaskRefs,
} from '../../../src/db/repositories/dispatchesRepository.js';
import { listTaskActivitySince } from '../../../src/db/repositories/runsRepository.js';
import { runs } from '../../../src/db/schema/runs.js';
import {
	ITEM_ACTIVITY_LOOKBACK_MS,
	ITEM_STALL_AFTER_MS,
	type ItemLivenessPolicy,
	toStalledItems,
} from '../../../src/dispatch/item-liveness.js';
import type { SwarmJob } from '../../../src/queue/jobs.js';
import { createMockScmWebhookJob } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-liveness';
const REPO = 'jkwiecien/liveness-repo';

/** The pipeline's own defaults — what an unconfigured project actually does. */
const DEFAULT_POLICY: ItemLivenessPolicy = { planningAutoAdvance: false, autoMerge: false };

const HOUR_MS = 60 * 60 * 1000;

function job(overrides: Partial<SwarmJob> = {}): SwarmJob {
	return { ...createMockScmWebhookJob(), projectId: PROJECT_ID, ...overrides } as SwarmJob;
}

/** A run row at an explicit time, so the classification is not wall-clock dependent. */
async function seedRun(input: {
	taskId: string;
	phase: string;
	status?: string;
	startedAt: Date;
	completedAt?: Date;
	prNumber?: string;
	producedPrUrl?: string;
	reviewVerdict?: string;
	reviewMergeOutcome?: string;
}): Promise<string> {
	const rows = await getDb()
		.insert(runs)
		.values({
			projectId: PROJECT_ID,
			repository: REPO,
			taskId: input.taskId,
			phase: input.phase,
			status: input.status ?? 'completed',
			startedAt: input.startedAt,
			completedAt: input.completedAt,
			prNumber: input.prNumber,
			producedPrUrl: input.producedPrUrl,
			reviewVerdict: input.reviewVerdict,
			reviewMergeOutcome: input.reviewMergeOutcome,
		})
		.returning({ id: runs.id });
	return rows[0].id;
}

// issue #840 — the item-liveness read model end to end over real Postgres: the
// two bounded repository reads feeding the pure classifier, which is the seam a
// unit test cannot cover. `listTaskActivitySince`'s `lastActivityAt` is a SQL
// aggregate rather than a plain column, so only a real driver value proves it
// reaches `classifyItemLiveness` as a `Date` its arithmetic can use.
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('item liveness (integration)', () => {
	const NOW = new Date('2026-03-01T12:00:00Z');
	const since = new Date(NOW.getTime() - ITEM_ACTIVITY_LOOKBACK_MS);

	async function stalledNow() {
		const [activity, activeDispatches] = await Promise.all([
			listTaskActivitySince({ since, projectIds: [PROJECT_ID] }),
			listActiveDispatchTaskRefs([PROJECT_ID]),
		]);
		return toStalledItems(activity, activeDispatches, { [PROJECT_ID]: DEFAULT_POLICY }, NOW);
	}

	beforeEach(async () => {
		await truncateAll();
		await seedProject({ id: PROJECT_ID, repo: REPO });
	});

	it('reports a long-silent completed review, with real elapsed time', async () => {
		const runId = await seedRun({
			taskId: '92',
			phase: 'review',
			prNumber: '92',
			startedAt: new Date(NOW.getTime() - 6 * HOUR_MS),
			completedAt: new Date(NOW.getTime() - 5 * HOUR_MS),
		});

		const stalled = await stalledNow();

		expect(stalled).toHaveLength(1);
		expect(stalled[0]).toMatchObject({
			projectId: PROJECT_ID,
			repository: REPO,
			unit: 'pull-request',
			reference: '92',
			taskId: '92',
			phase: 'review',
			runId,
			runStatus: 'completed',
			prNumber: '92',
			// The aggregate decoded as a real timestamp, not a driver string.
			lastActivityAt: new Date(NOW.getTime() - 5 * HOUR_MS).toISOString(),
			stalledForMs: 5 * HOUR_MS,
		});
	});

	// The grace window is the one time-based rule, and it runs on the same
	// decoded aggregate.
	it('leaves a unit inside the stall window unreported', async () => {
		await seedRun({
			taskId: '93',
			phase: 'review',
			prNumber: '93',
			startedAt: new Date(NOW.getTime() - ITEM_STALL_AFTER_MS - HOUR_MS),
			completedAt: new Date(NOW.getTime() - ITEM_STALL_AFTER_MS + HOUR_MS),
		});

		expect(await stalledNow()).toEqual([]);
	});

	it('folds a PR’s suffixed task ids onto one unit and orders longest-silent first', async () => {
		// One pull request, two task ids — the Review run and its Respond-to-review
		// continuation. The unit dates from the newer of the two.
		await seedRun({
			taskId: '94',
			phase: 'review',
			prNumber: '94',
			startedAt: new Date(NOW.getTime() - 30 * HOUR_MS),
			completedAt: new Date(NOW.getTime() - 29 * HOUR_MS),
		});
		await seedRun({
			taskId: '94-respond',
			phase: 'respond-to-review',
			prNumber: '94',
			startedAt: new Date(NOW.getTime() - 10 * HOUR_MS),
			completedAt: new Date(NOW.getTime() - 9 * HOUR_MS),
		});
		await seedRun({
			taskId: '95',
			phase: 'review',
			prNumber: '95',
			startedAt: new Date(NOW.getTime() - 21 * HOUR_MS),
			completedAt: new Date(NOW.getTime() - 20 * HOUR_MS),
		});

		const stalled = await stalledNow();

		expect(stalled.map((item) => [item.reference, item.stalledForMs])).toEqual([
			['95', 20 * HOUR_MS],
			['94', 9 * HOUR_MS],
		]);
		expect(stalled[1].taskId).toBe('94-respond');
	});

	it('steps a unit back from stalled while a dispatch is still due for it', async () => {
		await seedRun({
			taskId: '96',
			phase: 'review',
			prNumber: '96',
			startedAt: new Date(NOW.getTime() - 6 * HOUR_MS),
			completedAt: new Date(NOW.getTime() - 5 * HOUR_MS),
		});
		expect(await stalledNow()).toHaveLength(1);

		await createDispatch({
			projectId: PROJECT_ID,
			jobPayload: job(),
			source: 'webhook',
			taskId: '96-respond',
			phase: 'respond-to-review',
		});

		expect(await stalledNow()).toEqual([]);
	});

	// A hand-off SWARM actually recorded explains the silence, so the unit is not
	// stalled however long it has been quiet.
	it('does not report a merged pull request', async () => {
		await seedRun({
			taskId: '97',
			phase: 'review',
			prNumber: '97',
			reviewVerdict: 'approve',
			reviewMergeOutcome: 'merged',
			startedAt: new Date(NOW.getTime() - 48 * HOUR_MS),
			completedAt: new Date(NOW.getTime() - 47 * HOUR_MS),
		});

		expect(await stalledNow()).toEqual([]);
	});
});
