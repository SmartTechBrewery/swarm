import { describe, expect, it } from 'vitest';

import { buildTaskAssignment } from '@/transport/assignment.js';
import { TaskAssignmentSchema } from '@/transport/protocol.js';
import { createMockProjectConfig, createMockTaskAssignmentInput } from '../../helpers/factories.js';

describe('buildTaskAssignment', () => {
	it('builds a schema-valid task-assignment frame', () => {
		const assignment = buildTaskAssignment(createMockTaskAssignmentInput());
		expect(assignment.type).toBe('task-assignment');
		expect(TaskAssignmentSchema.safeParse(assignment).success).toBe(true);
	});

	describe('secret hygiene (the security boundary)', () => {
		it('never lets a credential reference reach the frame', () => {
			const project = createMockProjectConfig({
				credentials: {
					reviewer: 'SENTINEL_REVIEWER_TOKEN',
					webhookSecret: 'SENTINEL_WEBHOOK_SECRET',
				},
			});
			const assignment = buildTaskAssignment(createMockTaskAssignmentInput({ project }));

			// No `credentials` property anywhere in the embedded config slice.
			expect('credentials' in assignment.projectConfig).toBe(false);

			// And no sentinel survives a full serialization of the whole frame.
			const serialized = JSON.stringify(assignment);
			expect(serialized).not.toContain('SENTINEL_REVIEWER_TOKEN');
			expect(serialized).not.toContain('SENTINEL_WEBHOOK_SECRET');
		});

		// The one secret that *does* travel, deliberately (issue #765): the receiving
		// worker's own operator identity, without which it cannot commit or push. It is
		// not a project credential, so the boundary above is unchanged — and the input
		// field is required, so a frame cannot be assembled without one having been
		// resolved.
		it('carries the worker operator credential it was given', () => {
			const assignment = buildTaskAssignment(
				createMockTaskAssignmentInput({ operatorCredential: 'worker-operator-secret' }),
			);
			expect(assignment.operatorCredential).toBe('worker-operator-secret');
		});

		it('refuses to assemble a frame with an empty operator credential', () => {
			expect(() =>
				buildTaskAssignment(createMockTaskAssignmentInput({ operatorCredential: '' })),
			).toThrow();
		});
	});

	describe('per-phase inputs', () => {
		it('populates workItem for planning/implementation and omits PR fields', () => {
			const assignment = buildTaskAssignment(
				createMockTaskAssignmentInput({ phase: 'implementation' }),
			);
			expect(assignment.workItem).toBeDefined();
			expect(assignment.workItem?.id).toBe(createMockTaskAssignmentInput().workItem?.id);
			expect(assignment.prNumber).toBeUndefined();
			expect(assignment.reviewId).toBeUndefined();
			expect(assignment.baseBranch).toBeUndefined();
		});

		it('populates PR fields for review and omits workItem', () => {
			const assignment = buildTaskAssignment(
				createMockTaskAssignmentInput({
					phase: 'review',
					workItem: undefined,
					pr: { prNumber: '42', headSha: 'abc123' },
				}),
			);
			expect(assignment.workItem).toBeUndefined();
			expect(assignment.prNumber).toBe('42');
			expect(assignment.headSha).toBe('abc123');
			expect(assignment.reviewId).toBeUndefined();
		});

		it('carries reviewId only for respond-to-review', () => {
			const assignment = buildTaskAssignment(
				createMockTaskAssignmentInput({
					phase: 'respond-to-review',
					workItem: undefined,
					pr: { prNumber: '42', prBranch: 'issue-42', headSha: 'abc123', reviewId: '9001' },
				}),
			);
			expect(assignment.reviewId).toBe('9001');
			expect(assignment.baseBranch).toBeUndefined();
		});

		// The card the DB-free worker cannot look up for itself (issue #498).
		it('carries the control-plane-resolved board item id for respond-to-review', () => {
			const assignment = buildTaskAssignment(
				createMockTaskAssignmentInput({
					phase: 'respond-to-review',
					workItem: undefined,
					pr: { prNumber: '42', prBranch: 'issue-42', headSha: 'abc123', reviewId: '9001' },
					boardItemId: 'ITEM_42',
				}),
			);
			expect(assignment.boardItemId).toBe('ITEM_42');
			expect(TaskAssignmentSchema.safeParse(assignment).success).toBe(true);
		});

		it('omits the board item id when the control plane resolved none', () => {
			const assignment = buildTaskAssignment(
				createMockTaskAssignmentInput({
					phase: 'respond-to-review',
					workItem: undefined,
					pr: { prNumber: '42', prBranch: 'issue-42', headSha: 'abc123', reviewId: '9001' },
				}),
			);
			expect(assignment.boardItemId).toBeUndefined();
		});

		// The repository the run acts on, which the DB-free worker cannot read off the
		// run row for itself (issue #692) — Review keys its verdict ledger on it.
		it('carries the control-plane-resolved repository', () => {
			const assignment = buildTaskAssignment(
				createMockTaskAssignmentInput({
					phase: 'review',
					workItem: undefined,
					pr: { prNumber: '42', headSha: 'abc123' },
					repository: 'SmartTechBrewery/run-repo',
				}),
			);
			expect(assignment.repository).toBe('SmartTechBrewery/run-repo');
			expect(TaskAssignmentSchema.safeParse(assignment).success).toBe(true);
		});

		it('omits the repository when the caller resolved none (older-router skew)', () => {
			const assignment = buildTaskAssignment(
				createMockTaskAssignmentInput({
					phase: 'review',
					workItem: undefined,
					pr: { prNumber: '42', headSha: 'abc123' },
				}),
			);
			expect(assignment.repository).toBeUndefined();
			expect(TaskAssignmentSchema.safeParse(assignment).success).toBe(true);
		});

		// `taskRef` is the provider's own card→artifact answer, so it has to survive
		// the wire for a federated planning/implementation run (issue #498) — and it
		// must not cross without the repository that makes a bare number placeable
		// (issue #710).
		it('round-trips the work item taskRef and the repository it numbers', () => {
			const assignment = buildTaskAssignment(
				createMockTaskAssignmentInput({ phase: 'implementation' }),
			);
			const source = createMockTaskAssignmentInput().workItem;
			expect(assignment.workItem?.taskRef).toBe(source?.taskRef);
			expect(assignment.workItem?.taskRef).toBeDefined();
			expect(assignment.workItem?.taskRepository).toBe(source?.taskRepository);
			expect(assignment.workItem?.taskRepository).toBeDefined();
			expect(TaskAssignmentSchema.safeParse(assignment).success).toBe(true);
		});

		it('carries baseBranch/baseSha only for resolve-conflicts', () => {
			const assignment = buildTaskAssignment(
				createMockTaskAssignmentInput({
					phase: 'resolve-conflicts',
					workItem: undefined,
					pr: {
						prNumber: '42',
						prBranch: 'issue-42',
						headSha: 'abc123',
						baseBranch: 'main',
						baseSha: 'def456',
					},
				}),
			);
			expect(assignment.baseBranch).toBe('main');
			expect(assignment.baseSha).toBe('def456');
			expect(assignment.reviewId).toBeUndefined();
		});
	});

	describe('session threading', () => {
		it('round-trips the resume fields', () => {
			const assignment = buildTaskAssignment(
				createMockTaskAssignmentInput({
					session: {
						agentSessionId: 'sess-1',
						resumeSession: true,
						resumeDelivery: true,
						implementationBranchProvisioned: true,
					},
				}),
			);
			expect(assignment.agentSessionId).toBe('sess-1');
			expect(assignment.resumeSession).toBe(true);
			expect(assignment.resumeDelivery).toBe(true);
			expect(assignment.implementationBranchProvisioned).toBe(true);
		});

		it('carries the recovery mode onto the frame (issue #591)', () => {
			// Without this the worker sees no recovery intent at all and provisions
			// fresh over the very checkout the continuation was meant to adopt.
			const assignment = buildTaskAssignment(
				createMockTaskAssignmentInput({
					session: { recoveryMode: 'checkpoint', agentSessionId: 'sess-1' },
				}),
			);
			expect(assignment.recoveryMode).toBe('checkpoint');
		});

		it('omits recoveryMode entirely when the run has no recovery intent', () => {
			// An ordinary first attempt must not assert a mode — `undefined` is what
			// makes the phase's worktree gate stay out of the way.
			const assignment = buildTaskAssignment(createMockTaskAssignmentInput({ session: {} }));
			expect(assignment.recoveryMode).toBeUndefined();
			expect('recoveryMode' in assignment).toBe(false);
		});
	});

	describe('validation at the seam', () => {
		it('throws on an empty system prompt', () => {
			expect(() =>
				buildTaskAssignment(createMockTaskAssignmentInput({ systemPrompt: '' })),
			).toThrow();
		});

		it('throws on an empty target branch', () => {
			expect(() =>
				buildTaskAssignment(createMockTaskAssignmentInput({ targetBranch: '' })),
			).toThrow();
		});

		it('throws on a non-UUID dispatchId', () => {
			expect(() =>
				buildTaskAssignment(createMockTaskAssignmentInput({ dispatchId: 'not-a-uuid' })),
			).toThrow();
		});
	});
});
