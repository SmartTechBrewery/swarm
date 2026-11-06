import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import {
	findLatestOperatorAction,
	recordOperatorAction,
	settleOperatorAction,
} from '../../../src/db/repositories/operatorActionsRepository.js';
import { operatorActions } from '../../../src/db/schema/operatorActions.js';
import { truncateAll } from '../helpers/db.js';

const CALL = {
	userId: '22222222-2222-4222-8222-222222222222',
	userIdentifier: 'member@example.com',
	tool: 'run_reset',
	projectId: null,
	target: 'run-1',
	reason: 'wedged on a stale lease',
	dryRun: false,
	input: { runId: 'run-1' },
};

// issue #1346 — the audit trail of the operator MCP write tools. Only Postgres can
// prove the row is durable as written: no FK refuses an unknown user or project
// (the record must outlive both), and the settle lands on the row the insert made.
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('operatorActionsRepository', () => {
	beforeEach(async () => {
		await truncateAll();
	});

	it('inserts a pending row, then settles it with the outcome and the resolved project', async () => {
		const id = await recordOperatorAction(CALL);

		const [pending] = await getDb().select().from(operatorActions);
		expect(pending).toMatchObject({
			...CALL,
			id,
			outcome: 'pending',
			error: null,
			completedAt: null,
		});
		expect(pending?.startedAt).toBeInstanceOf(Date);

		await settleOperatorAction(id, {
			outcome: 'refused',
			error: 'FORBIDDEN: no',
			projectId: 'proj-gone',
		});

		const [settled] = await getDb().select().from(operatorActions);
		expect(settled).toMatchObject({
			outcome: 'refused',
			error: 'FORBIDDEN: no',
			projectId: 'proj-gone',
		});
		expect(settled?.completedAt).toBeInstanceOf(Date);
	});

	it('keeps an already-recorded project when the settle names none', async () => {
		const id = await recordOperatorAction({ ...CALL, projectId: 'proj-a' });

		await settleOperatorAction(id, { outcome: 'succeeded', error: null });

		const [row] = await getDb().select().from(operatorActions);
		expect(row).toMatchObject({ projectId: 'proj-a', outcome: 'succeeded' });
	});

	// issue #1349 — `phase_agents_restore` reads back what the latest real, successful
	// reorder of one project's phase recorded; nothing else may answer.
	it('finds the latest succeeded real call of a tool on a target, with its recorded detail', async () => {
		const REORDER = {
			...CALL,
			tool: 'phase_agents_reorder',
			projectId: 'proj-a',
			target: 'proj-a/review',
			input: { projectId: 'proj-a', phase: 'review', order: ['claude'] },
		};
		const settled = async (
			call: typeof REORDER,
			outcome: 'succeeded' | 'refused',
			detail: unknown,
		) => {
			const id = await recordOperatorAction(call);
			await settleOperatorAction(id, { outcome, error: null, projectId: call.projectId, detail });
			return id;
		};

		const older = await settled(REORDER, 'succeeded', { previous: ['older'] });
		const latest = await settled(REORDER, 'succeeded', { previous: ['latest'] });
		await settled({ ...REORDER, dryRun: true }, 'succeeded', { previous: ['dry'] });
		await settled(REORDER, 'refused', { previous: ['refused'] });
		await settled({ ...REORDER, target: 'proj-a/planning' }, 'succeeded', { previous: ['x'] });
		await settled({ ...REORDER, projectId: 'proj-b' }, 'succeeded', { previous: ['y'] });
		await settled({ ...REORDER, tool: 'phase_agents_restore' }, 'succeeded', { previous: ['z'] });

		const found = await findLatestOperatorAction({
			tool: 'phase_agents_reorder',
			projectId: 'proj-a',
			target: 'proj-a/review',
		});

		expect(found?.id).toBe(latest);
		expect(found?.id).not.toBe(older);
		expect(found?.detail).toEqual({ previous: ['latest'] });
		expect(
			await findLatestOperatorAction({
				tool: 'phase_agents_reorder',
				projectId: 'proj-a',
				target: 'proj-a/implementation',
			}),
		).toBeUndefined();
	});
});
