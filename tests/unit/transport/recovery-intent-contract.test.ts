/**
 * **The joint nobody was testing** (issue #591).
 *
 * A run's recovery intent — which session to re-enter, which preserved checkout
 * to adopt, and under which contract — travels `SwarmJob` → `buildTaskAssignment`
 * → `TaskAssignmentSchema.parse` (the wire) → `phaseRecoveryFromAssignment` →
 * `AssignedPhaseInputs` → the phase. Every hop had a test. The *path* had none,
 * and that is exactly why `recoveryMode` could be written by three call sites,
 * dropped at the very first hop, and read by no executor at all while the whole
 * suite stayed green: `tests/unit/dispatch/retry-payload.test.ts` asserted the
 * payload *gets* `recoveryMode: 'checkpoint'`, and
 * `tests/unit/pipeline/implementation.test.ts` asserted the phase *honours* one
 * passed directly. Both halves covered, the seam between them not.
 *
 * What it cost: nine consecutive dispatches for two real runs (tasks #567 and
 * #553), each carrying `recoveryMode: 'checkpoint'`, each provisioning fresh over
 * a deliberately preserved checkout and re-doing work from zero — a 0% recovery
 * rate against 162/168 ordinary runs completing the same week.
 *
 * So this file walks that path and asserts the intent survives it, with two cases
 * driven by `Object.keys(RecoveryIntentSchema.shape)` rather than a hand-written
 * list: a member added to the intent and *not* carried through fails here rather
 * than degrading to "this attempt has no recovery intent".
 *
 * **What it does and does not span.** It calls `phaseRecoveryFromAssignment`
 * directly, which is the whole of what `buildDbFreePhaseInputs` does with the
 * intent (that function is not exported, and injecting a fake `runPhase` to
 * observe it is `assignment-execution.test.ts`'s job — see "reaches the phase with
 * the assignment's recovery mode" there). The hop *after* `AssignedPhaseInputs` —
 * `runAssignedPhase` forwarding each member to an orchestrator — has its own
 * exhaustiveness case in `tests/unit/worker/consumer.test.ts`. Between the three,
 * every hop from the job payload to a phase orchestrator is covered.
 */

import { describe, expect, it } from 'vitest';

import {
	type PhaseRecovery,
	phaseRecoveryFromAssignment,
	type RecoveryIntent,
	RecoveryIntentSchema,
	recoveryIntentFromJob,
	type SwarmJob,
} from '@/queue/jobs.js';
import { buildTaskAssignment } from '@/transport/assignment.js';
import { type TaskAssignment, TaskAssignmentSchema } from '@/transport/protocol.js';
import { createMockPmWebhookJob, createMockTaskAssignmentInput } from '../../helpers/factories.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A job carrying **every** member of the recovery intent — the shared premise of
 * the two exhaustiveness cases below, which is why a new member has to be added
 * here before either can pass.
 */
const FULLY_POPULATED_JOB = createMockPmWebhookJob({
	agentSessionId: SESSION_ID,
	resumeSession: true,
	resumeDelivery: true,
	implementationBranchProvisioned: true,
	recoveryMode: 'resume',
});

/**
 * The hand-off exactly as production performs it: the dispatcher derives the
 * intent from the job (`../../../src/router/dispatcher.ts`), the builder validates
 * the assembled frame against the wire schema, and the DB-free executor resolves
 * it back into the phase inputs (`../../../src/transport/assignment-execution.ts`).
 * Re-parsing the built frame is deliberate — it is what a worker actually receives,
 * so a member the schema would strip cannot pass this on the in-memory object.
 */
function carryAcrossTheWire(job: SwarmJob): {
	intent: RecoveryIntent;
	assignment: TaskAssignment;
	recovery: PhaseRecovery;
} {
	const intent = recoveryIntentFromJob(job);
	const built = buildTaskAssignment(createMockTaskAssignmentInput({ session: intent }));
	const assignment = TaskAssignmentSchema.parse(built);
	return { intent, assignment, recovery: phaseRecoveryFromAssignment(assignment) };
}

describe('recovery intent: job → assignment → wire → phase inputs', () => {
	it("carries a Tier 2 continuation's mode to the phase that runs the gate", () => {
		// What "Continue now" enqueues for a `checkpointed` run: the checkpoint mode,
		// a freshly minted session, and deliberately no resume (`runs.retryNow`).
		const job = createMockPmWebhookJob({
			recoveryMode: 'checkpoint',
			agentSessionId: SESSION_ID,
			runId: 'run-1',
		});

		const { assignment, recovery } = carryAcrossTheWire(job);

		// The hop that was missing: the mode reaches the wire at all.
		expect(assignment.recoveryMode).toBe('checkpoint');
		// And the phase gets it, so `executeRecoveryGate` adopts the preserved
		// checkout instead of `provisionFresh()` colliding with it.
		expect(recovery.recoveryMode).toBe('checkpoint');
		// A continuation resumes no session — its hand-off is the checkpoint file —
		// so the minted id is *assigned*, never handed back as a resume id.
		expect(recovery.sessionId).toBe(SESSION_ID);
		expect(recovery.resumeSessionId).toBeUndefined();
	});

	it('carries a resume retry as a resume id, and a fresh retry as its own mode', () => {
		const resumed = carryAcrossTheWire(
			createMockPmWebhookJob({
				recoveryMode: 'resume',
				resumeSession: true,
				agentSessionId: SESSION_ID,
			}),
		);
		expect(resumed.assignment.recoveryMode).toBe('resume');
		expect(resumed.recovery.resumeSessionId).toBe(SESSION_ID);
		expect(resumed.recovery.sessionId).toBeUndefined();

		// A `'fresh'` retry reclaims a clean preserved checkout rather than colliding
		// with it — which it can only do if the mode arrives.
		const fresh = carryAcrossTheWire(
			createMockPmWebhookJob({ recoveryMode: 'fresh', agentSessionId: SESSION_ID }),
		);
		expect(fresh.assignment.recoveryMode).toBe('fresh');
		expect(fresh.recovery.recoveryMode).toBe('fresh');
	});

	it('carries the delivery and branch-provisioning flags the same way', () => {
		const { assignment, recovery } = carryAcrossTheWire(
			createMockPmWebhookJob({ resumeDelivery: true, implementationBranchProvisioned: true }),
		);
		expect(assignment.resumeDelivery).toBe(true);
		expect(assignment.implementationBranchProvisioned).toBe(true);
		expect(recovery.resumeDelivery).toBe(true);
		expect(recovery.resumeExistingBranch).toBe(true);
	});

	it('resolves an ordinary first attempt to "nothing to recover" without inventing a mode', () => {
		const { assignment, recovery } = carryAcrossTheWire(createMockPmWebhookJob());
		expect(assignment.recoveryMode).toBeUndefined();
		expect(recovery).toEqual({
			sessionId: undefined,
			resumeSessionId: undefined,
			resumeDelivery: false,
			resumeExistingBranch: false,
			recoveryMode: undefined,
		});
	});

	/**
	 * The exhaustiveness gate. Driven by the schema's own keys, so it covers a
	 * member that does not exist yet: add one to `RecoveryIntentSchema` without
	 * carrying it across the wire and this fails naming it, rather than the member
	 * silently defaulting three layers away — the failure mode this whole issue is
	 * about.
	 */
	it('carries every member of RecoveryIntentSchema across the wire', () => {
		const { intent, assignment } = carryAcrossTheWire(FULLY_POPULATED_JOB);

		// The premise: the fixture sets every member, so anything missing from the
		// frame below is the wire dropping it rather than the fixture omitting it.
		const unset = Object.keys(RecoveryIntentSchema.shape).filter((m) => !(m in intent));
		expect(
			unset,
			`FULLY_POPULATED_JOB does not set ${unset.join(', ')} — a new intent member must be set there, then carried through both executors`,
		).toEqual([]);

		for (const member of Object.keys(intent)) {
			expect(
				assignment,
				`TaskAssignmentSchema drops '${member}' — spread RecoveryIntentSchema.shape rather than restating members`,
			).toHaveProperty(member, intent[member as keyof RecoveryIntent]);
		}
	});

	/**
	 * The far side of the same gate: a member can reach the frame and still never
	 * reach a phase, because `PhaseRecovery` deliberately *renames* rather than
	 * mirrors — one `agentSessionId` resolves to `sessionId` **or**
	 * `resumeSessionId` depending on `resumeSession`, and
	 * `implementationBranchProvisioned` becomes `resumeExistingBranch`. So this
	 * asserts against an explicit "where each member lands" map: a new member fails
	 * here until someone states where it goes, instead of being carried across the
	 * wire and then quietly dropped by the resolver.
	 *
	 * Deliberately a **soft** gate: a member mapped lazily onto an existing key
	 * (`newThing: ['recoveryMode']`) satisfies it without being wired. Tightening
	 * that would mean asserting per-member values, which is what the named cases
	 * above already do. What this buys is that the author is *asked* the question at
	 * the point of adding the member, by an error message that says what to do.
	 */
	it('resolves every member of RecoveryIntentSchema into the phase recovery', () => {
		const LANDS_ON: Record<keyof RecoveryIntent, (keyof PhaseRecovery)[]> = {
			agentSessionId: ['sessionId', 'resumeSessionId'],
			resumeSession: ['sessionId', 'resumeSessionId'],
			resumeDelivery: ['resumeDelivery'],
			implementationBranchProvisioned: ['resumeExistingBranch'],
			recoveryMode: ['recoveryMode'],
		};

		expect(
			Object.keys(RecoveryIntentSchema.shape)
				.filter((m) => !(m in LANDS_ON))
				.sort(),
			'a member of RecoveryIntentSchema has no stated landing in PhaseRecovery — resolve it in phaseRecoveryFromAssignment and name it here',
		).toEqual([]);

		// Every stated landing is real, so the map cannot drift from the resolver.
		const { recovery } = carryAcrossTheWire(FULLY_POPULATED_JOB);
		for (const field of Object.values(LANDS_ON).flat()) {
			expect(recovery).toHaveProperty(field);
		}
	});

	/**
	 * The other half of the same gate, on the far side of the wire: a member that
	 * reaches the frame but is never resolved into `PhaseRecovery` still never
	 * reaches a phase. `AssignedPhaseInputs.recovery` being one **required** value
	 * is what makes that a compile error at every construction site; this pins the
	 * resolution itself, which the two executors used to duplicate by hand.
	 */
	it('resolves the whole intent into the phase recovery, with no member left behind', () => {
		const { recovery } = carryAcrossTheWire(FULLY_POPULATED_JOB);

		expect(recovery).toEqual({
			sessionId: undefined,
			resumeSessionId: SESSION_ID,
			resumeDelivery: true,
			resumeExistingBranch: true,
			recoveryMode: 'resume',
		});
	});
});
