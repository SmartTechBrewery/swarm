import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import {
	countRunBoundActions,
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

	// issue #1385 — a scoped agent credential's call is told apart from its holder's own.
	it("records the credential kind, defaulting to the account's own, and a scoped token's id", async () => {
		await recordOperatorAction(CALL);
		const TOKEN_ID = '33333333-3333-4333-8333-333333333333';
		await recordOperatorAction({
			...CALL,
			credentialKind: 'scoped-agent-token',
			agentTokenId: TOKEN_ID,
		});

		const rows = await getDb().select().from(operatorActions);
		expect(rows.map((row) => [row.credentialKind, row.agentTokenId]).sort()).toEqual([
			['scoped-agent-token', TOKEN_ID],
			['user', null],
		]);
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

	// Issue #1393: the read behind a run-bound credential's guardrails — keyed on the
	// run since issue #1395, so every token minted for it shares one ledger.
	it("counts one run's calls by dry/real, outcome, tool and target, across its tokens", async () => {
		const RUN = '44444444-4444-4444-8444-444444444444';
		const TOKEN = '33333333-3333-4333-8333-333333333333';
		const RETRY_TOKEN = '55555555-5555-4555-8555-555555555555';
		const call = async (
			over: Partial<typeof CALL>,
			outcome: 'succeeded' | 'refused' | 'failed' | 'pending',
			bound: { agentTokenId: string; runId: string } | null = { agentTokenId: TOKEN, runId: RUN },
		) => {
			const id = await recordOperatorAction({
				...CALL,
				...over,
				credentialKind: bound ? 'scoped-agent-token' : 'user',
				agentTokenId: bound?.agentTokenId ?? null,
				runId: bound?.runId ?? null,
			});
			if (outcome !== 'pending') await settleOperatorAction(id, { outcome, error: null });
			return id;
		};
		await call({ dryRun: true }, 'succeeded');
		await call({ dryRun: true, target: 'run-2' }, 'refused');
		await call({}, 'failed');
		await call({ target: 'run-2' }, 'refused');
		// The run's retry, under a freshly minted token: its calls count with the first's.
		const asking = await call({ target: 'run-3' }, 'pending', {
			agentTokenId: RETRY_TOKEN,
			runId: RUN,
		});
		await call({}, 'succeeded', null);
		// Another run's call is never this run's.
		await call({}, 'succeeded', {
			agentTokenId: '66666666-6666-4666-8666-666666666666',
			runId: '77777777-7777-4777-8777-777777777777',
		});

		const real = { runId: RUN, dryRun: false };
		expect(
			await countRunBoundActions({ ...real, outcomes: ['pending', 'succeeded', 'failed'] }),
		).toBe(2);
		expect(
			await countRunBoundActions({
				...real,
				outcomes: ['pending', 'succeeded', 'failed'],
				excludeId: asking,
			}),
		).toBe(1);
		expect(
			await countRunBoundActions({
				...real,
				outcomes: ['succeeded', 'failed'],
				tool: 'run_reset',
				target: 'run-1',
			}),
		).toBe(1);
		expect(
			await countRunBoundActions({
				runId: RUN,
				dryRun: true,
				outcomes: ['succeeded'],
				tool: 'run_reset',
				target: 'run-2',
			}),
		).toBe(0);
		expect(
			await countRunBoundActions({
				runId: RUN,
				dryRun: true,
				outcomes: ['succeeded'],
				tool: 'run_reset',
				target: 'run-1',
			}),
		).toBe(1);
	});

	// Issue #1393 review: the no-repeat read sees another call still in flight on the
	// same tool and target, but never the asking call's own pending row.
	it('counts an in-flight real call on the same tool and target, leaving out the excluded row', async () => {
		const RUN = '44444444-4444-4444-8444-444444444444';
		const pending = () =>
			recordOperatorAction({
				...CALL,
				credentialKind: 'scoped-agent-token',
				agentTokenId: '33333333-3333-4333-8333-333333333333',
				runId: RUN,
			});
		const inFlight = await pending();
		const asking = await pending();
		const query = {
			runId: RUN,
			dryRun: false,
			outcomes: ['pending', 'succeeded', 'failed'] as const,
			tool: 'run_reset',
			target: 'run-1',
		};

		expect(await countRunBoundActions(query)).toBe(2);
		expect(await countRunBoundActions({ ...query, excludeId: asking })).toBe(1);
		expect(await countRunBoundActions({ ...query, excludeId: inFlight })).toBe(1);
		await settleOperatorAction(inFlight, { outcome: 'refused', error: null });
		expect(await countRunBoundActions({ ...query, excludeId: asking })).toBe(0);
	});
});
