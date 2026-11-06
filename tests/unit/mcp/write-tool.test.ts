import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * The audited write-tool framework (issue #1346) on its own: a mandatory reason, a
 * dry run that never reaches the write, authorization (the preview) before anything,
 * and exactly one audit row — inserted before acting, settled after — for every call.
 */
const { recordOperatorAction, settleOperatorAction } = vi.hoisted(() => ({
	recordOperatorAction: vi.fn(),
	settleOperatorAction: vi.fn(),
}));
vi.mock('@/db/repositories/operatorActionsRepository.js', () => ({
	recordOperatorAction,
	settleOperatorAction,
}));
vi.mock('@/lib/logger.js', async () => ({
	...(await vi.importActual<typeof import('@/lib/logger.js')>('@/lib/logger.js')),
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { SwarmUser } from '@/identity/schema.js';
import { runWriteTool, type WriteToolDefinition } from '@/mcp/write-tool.js';

const USER: SwarmUser = {
	id: '22222222-2222-4222-8222-222222222222',
	identifier: 'member@example.com',
	displayName: 'member',
	instanceAdmin: false,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const shape = { runId: z.string() };
let preview: ReturnType<typeof vi.fn>;
let apply: ReturnType<typeof vi.fn>;

function definition(): WriteToolDefinition<typeof shape> {
	return {
		name: 'thing_do',
		title: 'Do the thing',
		description: 'Does the thing.',
		inputSchema: shape,
		destructive: true,
		targetOf: (input) => input.runId,
		preview: (input, caller) => preview(input, caller),
		apply: (input, caller) => apply(input, caller),
	};
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0]?.text ?? '';
}

beforeEach(() => {
	recordOperatorAction.mockReset().mockResolvedValue('audit-1');
	settleOperatorAction.mockReset().mockResolvedValue(undefined);
	preview = vi.fn().mockResolvedValue({ projectId: 'proj-a', plan: { wouldRefuse: null } });
	apply = vi.fn().mockResolvedValue({ outcome: 'done' });
});

describe('runWriteTool', () => {
	it('records the call as pending before acting, then settles it succeeded', async () => {
		const result = await runWriteTool(definition(), USER, {
			runId: 'run-1',
			reason: 'wedged since yesterday',
			dryRun: false,
		});

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			dryRun: false,
			auditId: 'audit-1',
			result: { outcome: 'done' },
		});
		expect(recordOperatorAction).toHaveBeenCalledWith({
			userId: USER.id,
			userIdentifier: USER.identifier,
			tool: 'thing_do',
			projectId: null,
			target: 'run-1',
			reason: 'wedged since yesterday',
			dryRun: false,
			input: { runId: 'run-1' },
		});
		expect(recordOperatorAction.mock.invocationCallOrder[0]).toBeLessThan(
			preview.mock.invocationCallOrder[0] ?? 0,
		);
		expect(preview.mock.invocationCallOrder[0]).toBeLessThan(
			apply.mock.invocationCallOrder[0] ?? 0,
		);
		expect(settleOperatorAction).toHaveBeenCalledTimes(1);
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'succeeded',
			error: null,
			projectId: 'proj-a',
		});
	});

	it('answers a dry run from the preview alone and never calls the write', async () => {
		const result = await runWriteTool(definition(), USER, {
			runId: 'run-1',
			reason: 'checking first',
			dryRun: true,
		});

		expect(result.structuredContent).toEqual({
			dryRun: true,
			auditId: 'audit-1',
			preview: { wouldRefuse: null },
		});
		expect(apply).not.toHaveBeenCalled();
		expect(recordOperatorAction).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'succeeded',
			error: null,
			projectId: 'proj-a',
		});
	});

	it.each([
		[''],
		['   '],
	])('refuses a blank reason %j, audited, touching nothing', async (reason) => {
		const result = await runWriteTool(definition(), USER, {
			runId: 'run-1',
			reason,
			dryRun: false,
		});

		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/^BAD_REQUEST: .*reason/);
		expect(preview).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
		expect(recordOperatorAction).toHaveBeenCalledTimes(1);
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'refused',
			error: expect.stringMatching(/^BAD_REQUEST: /),
			projectId: null,
		});
	});

	// The preview is the authorization: a denial there must stop the write, and a dry
	// run must not get past it either.
	it.each([
		[false],
		[true],
	])('stops at a denied preview (dryRun %s), audited as refused', async (dryRun) => {
		preview.mockRejectedValue(
			new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission.' }),
		);

		const result = await runWriteTool(definition(), USER, { runId: 'run-1', reason: 'r', dryRun });

		expect(result.isError).toBe(true);
		expect(text(result)).toBe('FORBIDDEN: You do not have permission.');
		expect(apply).not.toHaveBeenCalled();
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'refused',
			error: 'FORBIDDEN: You do not have permission.',
			projectId: null,
		});
	});

	it("audits the write's own refusal with the project the preview resolved", async () => {
		apply.mockRejectedValue(new TRPCError({ code: 'CONFLICT', message: 'Already retrying.' }));

		const result = await runWriteTool(definition(), USER, {
			runId: 'run-1',
			reason: 'r',
			dryRun: false,
		});

		expect(text(result)).toBe('CONFLICT: Already retrying.');
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'refused',
			error: 'CONFLICT: Already retrying.',
			projectId: 'proj-a',
		});
	});

	it('audits an unexpected throw as failed', async () => {
		apply.mockRejectedValue(new Error('connection reset'));

		const result = await runWriteTool(definition(), USER, {
			runId: 'run-1',
			reason: 'r',
			dryRun: false,
		});

		expect(text(result)).toBe('Tool "thing_do" failed: connection reset');
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'failed',
			error: 'Tool "thing_do" failed: connection reset',
			projectId: 'proj-a',
		});
	});

	// tRPC wraps every non-`TRPCError` a procedure throws as `INTERNAL_SERVER_ERROR`, and
	// `runs.reset` rethrows its own unexpected failures that way, so the class alone
	// cannot tell a refusal from a failure: the code does.
	it('audits an INTERNAL_SERVER_ERROR from the write as failed', async () => {
		apply.mockRejectedValue(
			new TRPCError({
				code: 'INTERNAL_SERVER_ERROR',
				message: 'Failed to reset run "run-1": connection reset',
			}),
		);

		const result = await runWriteTool(definition(), USER, {
			runId: 'run-1',
			reason: 'r',
			dryRun: false,
		});

		expect(result.isError).toBe(true);
		expect(text(result)).toBe(
			'INTERNAL_SERVER_ERROR: Failed to reset run "run-1": connection reset',
		);
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'failed',
			error: 'INTERNAL_SERVER_ERROR: Failed to reset run "run-1": connection reset',
			projectId: 'proj-a',
		});
	});

	it('audits a preview that broke, wrapped by tRPC, as failed rather than refused', async () => {
		preview.mockRejectedValue(
			new TRPCError({
				code: 'INTERNAL_SERVER_ERROR',
				message: 'db down',
				cause: new Error('db down'),
			}),
		);

		const result = await runWriteTool(definition(), USER, {
			runId: 'run-1',
			reason: 'r',
			dryRun: true,
		});

		expect(text(result)).toBe('INTERNAL_SERVER_ERROR: db down');
		expect(apply).not.toHaveBeenCalled();
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'failed',
			error: 'INTERNAL_SERVER_ERROR: db down',
			projectId: null,
		});
	});

	it("audits the write's PRECONDITION_FAILED as refused", async () => {
		apply.mockRejectedValue(
			new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Not retryable.' }),
		);

		await runWriteTool(definition(), USER, { runId: 'run-1', reason: 'r', dryRun: false });

		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'refused',
			error: 'PRECONDITION_FAILED: Not retryable.',
			projectId: 'proj-a',
		});
	});

	it('does nothing at all when the audit row cannot be written', async () => {
		recordOperatorAction.mockRejectedValue(new Error('db down'));

		const result = await runWriteTool(definition(), USER, {
			runId: 'run-1',
			reason: 'r',
			dryRun: false,
		});

		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/did nothing: its audit record could not be written \(db down\)/);
		expect(preview).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
		expect(settleOperatorAction).not.toHaveBeenCalled();
	});

	// The write happened; reporting it as failed would invite the operator to repeat it.
	it('still returns the real result when the audit row cannot be settled', async () => {
		settleOperatorAction.mockRejectedValue(new Error('db blip'));

		const result = await runWriteTool(definition(), USER, {
			runId: 'run-1',
			reason: 'r',
			dryRun: false,
		});

		expect(result.isError).toBeUndefined();
		expect(apply).toHaveBeenCalledTimes(1);
	});
});
