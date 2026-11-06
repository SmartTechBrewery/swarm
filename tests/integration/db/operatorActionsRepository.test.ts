import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import {
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
});
