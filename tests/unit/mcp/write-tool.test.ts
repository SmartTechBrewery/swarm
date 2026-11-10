import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * The audited write-tool framework (issue #1346) on its own: a mandatory reason, a
 * dry run that never reaches the write, authorization (the preview) before anything,
 * and exactly one audit row — inserted before acting, settled after — for every call.
 */
const { recordOperatorAction, settleOperatorAction, countRunBoundActions } = vi.hoisted(() => ({
	recordOperatorAction: vi.fn(),
	settleOperatorAction: vi.fn(),
	countRunBoundActions: vi.fn(),
}));
vi.mock('@/db/repositories/operatorActionsRepository.js', () => ({
	recordOperatorAction,
	settleOperatorAction,
	countRunBoundActions,
}));
vi.mock('@/lib/logger.js', async () => ({
	...(await vi.importActual<typeof import('@/lib/logger.js')>('@/lib/logger.js')),
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { SwarmUser } from '@/identity/schema.js';
import { scopedAgentPrincipal, type ToolContext } from '@/mcp/tool-access.js';
import { runWriteTool, type WriteToolDefinition } from '@/mcp/write-tool.js';

const USER: SwarmUser = {
	id: '22222222-2222-4222-8222-222222222222',
	identifier: 'member@example.com',
	displayName: 'member',
	instanceAdmin: false,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};

/**
 * `thing_do` has no `TOOL_ACCESS` entry, so it is default-denied to everyone below
 * an installation administrator; the framework's own behaviour is exercised at that
 * ceiling, and the role refusal on its own below.
 */
const CONTEXT: ToolContext = { user: USER, credential: { kind: 'user' }, ceiling: 'instanceAdmin' };

const TOKEN_ID = '33333333-3333-4333-8333-333333333333';

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
		apply: (input, caller, previewed) => apply(input, caller, previewed),
	};
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0]?.text ?? '';
}

beforeEach(() => {
	recordOperatorAction.mockReset().mockResolvedValue('audit-1');
	settleOperatorAction.mockReset().mockResolvedValue(undefined);
	countRunBoundActions.mockReset().mockResolvedValue(0);
	preview = vi.fn().mockResolvedValue({ projectId: 'proj-a', plan: { wouldRefuse: null } });
	apply = vi.fn().mockResolvedValue({ outcome: 'done' });
});

describe('runWriteTool', () => {
	it('records the call as pending before acting, then settles it succeeded', async () => {
		const result = await runWriteTool(definition(), CONTEXT, {
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
			credentialKind: 'user',
			agentTokenId: null,
			runId: null,
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

	// Issue #1349: what a preview records (the order a reorder replaced) lands on the
	// row, and the write is handed that same preview so it writes what was recorded.
	it("records the preview's detail on the row and hands the preview to the write", async () => {
		const previewed = {
			projectId: 'proj-a',
			plan: { before: ['codex'], after: ['claude'] },
			detail: { previous: ['codex'], next: ['claude'] },
		};
		preview.mockResolvedValue(previewed);

		await runWriteTool(definition(), CONTEXT, { runId: 'run-1', reason: 'reorder', dryRun: false });

		expect(apply).toHaveBeenCalledWith({ runId: 'run-1' }, expect.anything(), previewed);
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'succeeded',
			error: null,
			projectId: 'proj-a',
			detail: { previous: ['codex'], next: ['claude'] },
		});
	});

	// Issue #1359: a tool accepting a secret names it, and the audit row never holds it.
	it('records a secret input as [redacted] while the tool itself still receives it', async () => {
		const secretShape = { runId: z.string(), token: z.string().optional() };
		const withSecret: WriteToolDefinition<typeof secretShape> = {
			...(definition() as unknown as WriteToolDefinition<typeof secretShape>),
			inputSchema: secretShape,
			secretInputs: ['token'],
		};

		await runWriteTool(withSecret, CONTEXT, {
			runId: 'run-1',
			token: 'hunter2',
			reason: 'rotate',
			dryRun: false,
		});

		expect(recordOperatorAction).toHaveBeenCalledWith(
			expect.objectContaining({ input: { runId: 'run-1', token: '[redacted]' } }),
		);
		expect(JSON.stringify(recordOperatorAction.mock.calls)).not.toContain('hunter2');
		expect(apply).toHaveBeenCalledWith(
			{ runId: 'run-1', token: 'hunter2' },
			expect.anything(),
			expect.anything(),
		);
	});

	it('answers a dry run from the preview alone and never calls the write', async () => {
		const result = await runWriteTool(definition(), CONTEXT, {
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
		const result = await runWriteTool(definition(), CONTEXT, {
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

	// Issue #1382: a caller below the tool's TOOL_ACCESS role is refused after the row
	// is written, so the refusal is audited, and before the preview, so it learns nothing.
	it.each([
		[
			'an unlisted tool, default-denied',
			definition(),
			'projectAdmin' as const,
			'installation administrator',
		],
		[
			'a member-only tool',
			{ ...definition(), name: 'run_reset' },
			'contributor' as const,
			'member role',
		],
	])('refuses %s to a caller below its role, audited, touching nothing', async (_, tool, ceiling, needs) => {
		const result = await runWriteTool(
			tool,
			{ user: USER, credential: { kind: 'user' }, ceiling },
			{
				runId: 'run-1',
				reason: 'r',
				dryRun: true,
			},
		);

		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/^FORBIDDEN: Tool ".+" needs /);
		expect(text(result)).toContain(needs);
		expect(preview).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
		expect(recordOperatorAction).toHaveBeenCalledTimes(1);
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'refused',
			error: expect.stringMatching(/^FORBIDDEN: /),
			projectId: null,
		});
	});

	// Issue #1385: a scoped agent credential's calls are audited as its own, and a
	// tool outside its allowlist is refused (audited) whatever the ceiling.
	it('records a scoped agent credential and its token id on the audit row', async () => {
		const scoped = scopedAgentPrincipal(USER, TOKEN_ID, ['proj-a']);
		const result = await runWriteTool(
			{ ...definition(), name: 'run_reset' },
			{ ...scoped, ceiling: 'member' },
			{ runId: 'run-1', reason: 'r', dryRun: false },
		);

		expect(result.isError).toBeUndefined();
		expect(recordOperatorAction).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: USER.id,
				credentialKind: 'scoped-agent-token',
				agentTokenId: TOKEN_ID,
				runId: null,
			}),
		);
	});

	it('refuses a scoped agent credential a tool outside its allowlist, audited', async () => {
		const scoped = scopedAgentPrincipal(USER, TOKEN_ID, ['proj-a']);
		const result = await runWriteTool(
			{ ...definition(), name: 'project_update' },
			{ ...scoped, ceiling: 'projectAdmin' },
			{ runId: 'run-1', reason: 'r', dryRun: false },
		);

		expect(text(result)).toBe(
			'FORBIDDEN: Tool "project_update" is not available to a scoped agent credential.',
		);
		expect(preview).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'refused',
			error: expect.stringMatching(/^FORBIDDEN: /),
			projectId: null,
		});
	});

	it('runs a listed tool for a caller at exactly its role', async () => {
		const result = await runWriteTool(
			{ ...definition(), name: 'run_reset' },
			{ user: USER, credential: { kind: 'user' }, ceiling: 'member' },
			{ runId: 'run-1', reason: 'r', dryRun: false },
		);

		expect(result.isError).toBeUndefined();
		expect(apply).toHaveBeenCalled();
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

		const result = await runWriteTool(definition(), CONTEXT, {
			runId: 'run-1',
			reason: 'r',
			dryRun,
		});

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

		const result = await runWriteTool(definition(), CONTEXT, {
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

		const result = await runWriteTool(definition(), CONTEXT, {
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

		const result = await runWriteTool(definition(), CONTEXT, {
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

		const result = await runWriteTool(definition(), CONTEXT, {
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

		await runWriteTool(definition(), CONTEXT, { runId: 'run-1', reason: 'r', dryRun: false });

		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'refused',
			error: 'PRECONDITION_FAILED: Not retryable.',
			projectId: 'proj-a',
		});
	});

	it('does nothing at all when the audit row cannot be written', async () => {
		recordOperatorAction.mockRejectedValue(new Error('db down'));

		const result = await runWriteTool(definition(), CONTEXT, {
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

		const result = await runWriteTool(definition(), CONTEXT, {
			runId: 'run-1',
			reason: 'r',
			dryRun: false,
		});

		expect(result.isError).toBeUndefined();
		expect(apply).toHaveBeenCalledTimes(1);
	});

	// Issue #1393: a run-bound scoped credential's real writes are capped, must follow
	// a succeeded dry run of the same tool on the same target, and never repeat one.
	describe('run-bound credential guardrails', () => {
		const RUN_ID = '44444444-4444-4444-8444-444444444444';
		const runBound = (maxWriteActions: number): ToolContext => ({
			...scopedAgentPrincipal(USER, TOKEN_ID, ['proj-a'], { runId: RUN_ID, maxWriteActions }),
			ceiling: 'member',
		});
		const resetTool = () => ({ ...definition(), name: 'run_reset' });

		/** Answer each guardrail read: real calls spent, succeeded dry runs, prior applies. */
		function counts(answer: { spent?: number; dryRuns?: number; applied?: number }) {
			countRunBoundActions.mockImplementation(async (query: { dryRun: boolean; tool?: string }) => {
				if (query.dryRun) return answer.dryRuns ?? 1;
				return query.tool === undefined ? (answer.spent ?? 0) : (answer.applied ?? 0);
			});
		}

		function expectRefused(result: Awaited<ReturnType<typeof runWriteTool>>, message: string) {
			expect(result.isError).toBe(true);
			expect(text(result)).toBe(`FORBIDDEN: ${message}`);
			expect(preview).not.toHaveBeenCalled();
			expect(apply).not.toHaveBeenCalled();
			expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
				outcome: 'refused',
				error: `FORBIDDEN: ${message}`,
				projectId: null,
			});
		}

		it('runs a real call within the cap that follows a succeeded dry run', async () => {
			counts({ spent: 1, dryRuns: 1, applied: 0 });
			const result = await runWriteTool(resetTool(), runBound(2), {
				runId: 'run-1',
				reason: 'r',
				dryRun: false,
			});

			expect(result.isError).toBeUndefined();
			expect(apply).toHaveBeenCalledTimes(1);
			expect(countRunBoundActions).toHaveBeenCalledWith({
				runId: RUN_ID,
				dryRun: true,
				outcomes: ['succeeded'],
				tool: 'run_reset',
				target: 'run-1',
			});
			expect(countRunBoundActions).toHaveBeenCalledWith({
				runId: RUN_ID,
				dryRun: false,
				outcomes: ['pending', 'succeeded', 'failed'],
				tool: 'run_reset',
				target: 'run-1',
				excludeId: 'audit-1',
			});
		});

		// Review of #1405 (F1): a deferred run is retried under a freshly minted token, and
		// the earlier token is deleted — the ledger must follow the run, not the token.
		it('records the bound run on the audit row and shares one ledger across its tokens', async () => {
			counts({ applied: 1 });
			const retryToken = {
				...scopedAgentPrincipal(USER, '55555555-5555-4555-8555-555555555555', ['proj-a'], {
					runId: RUN_ID,
					maxWriteActions: 3,
				}),
				ceiling: 'member' as const,
			};
			const result = await runWriteTool(resetTool(), retryToken, {
				runId: 'run-1',
				reason: 'r',
				dryRun: false,
			});

			expect(recordOperatorAction).toHaveBeenCalledWith(
				expect.objectContaining({
					agentTokenId: '55555555-5555-4555-8555-555555555555',
					runId: RUN_ID,
				}),
			);
			for (const [query] of countRunBoundActions.mock.calls) {
				expect(query).toMatchObject({ runId: RUN_ID });
				expect(query).not.toHaveProperty('agentTokenId');
			}
			expectRefused(result, 'run_reset was already applied to run-1 in this run');
		});

		it('refuses a real call once the cap is spent, counting failed calls but not refused ones', async () => {
			counts({ spent: 2 });
			const result = await runWriteTool(resetTool(), runBound(2), {
				runId: 'run-1',
				reason: 'r',
				dryRun: false,
			});

			expectRefused(result, 'write-action cap of 2 reached for this run');
			expect(countRunBoundActions).toHaveBeenCalledWith({
				runId: RUN_ID,
				dryRun: false,
				outcomes: ['pending', 'succeeded', 'failed'],
				excludeId: 'audit-1',
			});
		});

		it('refuses a real call with no succeeded dry run of the same tool and target', async () => {
			counts({ dryRuns: 0 });
			const result = await runWriteTool(resetTool(), runBound(3), {
				runId: 'run-1',
				reason: 'r',
				dryRun: false,
			});

			expectRefused(result, 'dry run run_reset on run-1 first');
		});

		it('refuses a real call that repeats the same tool on the same target', async () => {
			counts({ applied: 1 });
			const result = await runWriteTool(resetTool(), runBound(3), {
				runId: 'run-1',
				reason: 'r',
				dryRun: false,
			});

			expectRefused(result, 'run_reset was already applied to run-1 in this run');
		});

		it('refuses a real call while the same tool on the same target is still pending', async () => {
			// Only another call's in-flight row is on the table: the asking call's own
			// row is excluded, and nothing has settled yet.
			countRunBoundActions.mockImplementation(
				async (query: {
					dryRun: boolean;
					tool?: string;
					outcomes: string[];
					excludeId?: string;
				}) => {
					if (query.dryRun) return 1;
					if (query.tool === undefined) return 1;
					return query.outcomes.includes('pending') && query.excludeId === 'audit-1' ? 1 : 0;
				},
			);
			const result = await runWriteTool(resetTool(), runBound(3), {
				runId: 'run-1',
				reason: 'r',
				dryRun: false,
			});

			expectRefused(result, 'run_reset was already applied to run-1 in this run');
		});

		it('refuses, rather than fails, when the guardrails cannot be read', async () => {
			countRunBoundActions.mockRejectedValue(new Error('connection reset'));
			const result = await runWriteTool(resetTool(), runBound(3), {
				runId: 'run-1',
				reason: 'r',
				dryRun: false,
			});

			expectRefused(result, "This run's write guardrails could not be checked (connection reset).");
		});

		it('never caps a dry run', async () => {
			counts({ spent: 5, dryRuns: 0, applied: 1 });
			const result = await runWriteTool(resetTool(), runBound(0), {
				runId: 'run-1',
				reason: 'r',
				dryRun: true,
			});

			expect(result.isError).toBeUndefined();
			expect(countRunBoundActions).not.toHaveBeenCalled();
			expect(preview).toHaveBeenCalledTimes(1);
			expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
				outcome: 'succeeded',
				error: null,
				projectId: 'proj-a',
			});
		});

		it('leaves an ordinary token and a scoped token without a run unaffected', async () => {
			counts({ spent: 5, dryRuns: 0, applied: 1 });
			const scoped = scopedAgentPrincipal(USER, TOKEN_ID, ['proj-a']);
			for (const context of [
				{ ...scoped, ceiling: 'member' as const },
				{ ...CONTEXT, ceiling: 'member' as const },
			]) {
				const result = await runWriteTool(resetTool(), context, {
					runId: 'run-1',
					reason: 'r',
					dryRun: false,
				});
				expect(result.isError).toBeUndefined();
			}
			expect(countRunBoundActions).not.toHaveBeenCalled();
			expect(apply).toHaveBeenCalledTimes(2);
		});
	});
});
