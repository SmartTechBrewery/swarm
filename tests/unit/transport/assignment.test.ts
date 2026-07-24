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
