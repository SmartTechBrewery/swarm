/**
 * The framework every operator MCP **write tool** is registered through (issue
 * #1346) — a tool that changes the pipeline rather than reading it.
 *
 * {@link registerWriteTool} gives every such tool the same contract, so no later
 * operation can opt out of it:
 *
 *  - **A mandatory `reason`.** Every call states why, in the operator's words; a
 *    blank one is refused (and audited as refused).
 *  - **`dryRun`.** `true` reports what the call would change — the precondition
 *    verdict and the intended changes — and changes nothing: only the tool's
 *    `preview` runs, never its `apply`.
 *  - **Authorization before anything, dry run included.** `preview` is a dashboard
 *    procedure gated exactly as the write it describes, and it runs first on *every*
 *    call. A dry run therefore cannot tell a caller about state the real call would
 *    refuse to let them act on, and a real call is refused before its write is
 *    attempted. The write itself is still the dashboard's own procedure, which
 *    re-authorizes: nothing here relaxes or re-implements its access check.
 *  - **A durable audit row for every call** (`operator_actions`): inserted as
 *    `pending` *before* the tool does anything — so a call whose row cannot be
 *    written does nothing at all — and settled afterwards as `succeeded`, `refused`
 *    (the wrapped procedure declined to act: a client-class `TRPCError` such as
 *    `NOT_FOUND`, `FORBIDDEN` or `PRECONDITION_FAILED`) or `failed` (an internal
 *    error, including one the procedure reported as `INTERNAL_SERVER_ERROR`, after
 *    which the write may have half-happened). A row that
 *    cannot be settled is logged and the call's real result is still returned: the
 *    write happened, and reporting it as failed would invite a second one.
 *
 * Results are `{ dryRun: true, auditId, preview }` or `{ dryRun: false, auditId,
 * result }`; refusals and failures are `isError` results worded as {@link runTool}
 * words them.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
	recordOperatorAction,
	settleOperatorAction,
} from '../db/repositories/operatorActionsRepository.js';
import type { SwarmUser } from '../identity/schema.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
	callerFor,
	describeToolFailure,
	errorResult,
	jsonResult,
	type SwarmCaller,
} from './tool-helpers.js';

/** The two fields every write tool accepts on top of its own. */
export const WRITE_TOOL_INPUT = {
	reason: z
		.string()
		.min(1)
		.describe(
			'Why you are doing this, in a sentence. Mandatory; recorded with the call in the audit trail.',
		),
	dryRun: z
		.boolean()
		.default(false)
		.describe(
			'`true` reports what would change — the precondition verdict and the intended changes — without changing anything. Default `false`.',
		),
};

/**
 * What a write tool's `preview` resolves: the target's project and the dry-run
 * report. `projectId` is `null` for a target that belongs to no project — a worker
 * machine (issue #1350) — so its audit row names none.
 */
export interface WriteToolPreview {
	projectId: string | null;
	plan: unknown;
}

export interface WriteToolDefinition<Shape extends z.ZodRawShape> {
	name: string;
	title: string;
	description: string;
	/** The tool's own arguments; `reason` and `dryRun` are added to them. */
	inputSchema: Shape;
	/** Whether the write discards state (MCP's `destructiveHint`). */
	destructive: boolean;
	/** What the call acts on, recorded as the audit row's `target`. */
	targetOf: (input: z.objectOutputType<Shape, z.ZodTypeAny>) => string;
	/**
	 * Read-only, and authorized exactly as `apply` is. Runs first on every call; its
	 * `plan` is the dry run's answer.
	 */
	preview: (
		input: z.objectOutputType<Shape, z.ZodTypeAny>,
		caller: SwarmCaller,
	) => Promise<WriteToolPreview>;
	/** The write itself — the dashboard procedure the tool wraps. */
	apply: (input: z.objectOutputType<Shape, z.ZodTypeAny>, caller: SwarmCaller) => Promise<unknown>;
}

type WriteToolArgs<Shape extends z.ZodRawShape> = z.objectOutputType<Shape, z.ZodTypeAny> & {
	reason: string;
	dryRun: boolean;
};

/** Register one write tool on `server`, authorizing and auditing every call as `user`. */
export function registerWriteTool<Shape extends z.ZodRawShape>(
	server: McpServer,
	user: SwarmUser,
	definition: WriteToolDefinition<Shape>,
): void {
	// Widened to a plain shape: the SDK cannot resolve its callback type over a generic one.
	const inputSchema: z.ZodRawShape = { ...definition.inputSchema, ...WRITE_TOOL_INPUT };
	server.registerTool(
		definition.name,
		{
			title: definition.title,
			description: definition.description,
			inputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: definition.destructive,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		(args) => runWriteTool(definition, user, args as unknown as WriteToolArgs<Shape>),
	);
}

/** One write-tool call, start to settle. Exported for the framework's own tests. */
export async function runWriteTool<Shape extends z.ZodRawShape>(
	definition: WriteToolDefinition<Shape>,
	user: SwarmUser,
	args: WriteToolArgs<Shape>,
): Promise<CallToolResult> {
	const { reason, dryRun, ...rest } = args;
	const input = rest as unknown as z.objectOutputType<Shape, z.ZodTypeAny>;

	let auditId: string;
	try {
		auditId = await recordOperatorAction({
			userId: user.id,
			userIdentifier: user.identifier,
			tool: definition.name,
			projectId: null,
			target: definition.targetOf(input),
			reason,
			dryRun,
			input,
		});
	} catch (error) {
		const message = describeError(error);
		logger.error('operator MCP write tool refused: its audit record could not be written', {
			tool: definition.name,
			error: message,
		});
		return errorResult(
			`Tool "${definition.name}" did nothing: its audit record could not be written (${message}).`,
		);
	}

	let projectId: string | null = null;
	const settle = async (outcome: 'succeeded' | 'refused' | 'failed', error: string | null) => {
		try {
			await settleOperatorAction(auditId, { outcome, error, projectId });
		} catch (settleError) {
			logger.error('operator MCP write tool: could not settle its audit record', {
				tool: definition.name,
				auditId,
				outcome,
				error: describeError(settleError),
			});
		}
	};

	try {
		if (reason.trim().length === 0) {
			throw new TRPCError({
				code: 'BAD_REQUEST',
				message: 'A write tool needs a non-empty `reason`.',
			});
		}
		const caller = callerFor(user);
		const preview = await definition.preview(input, caller);
		projectId = preview.projectId;
		if (dryRun) {
			await settle('succeeded', null);
			return jsonResult({ dryRun: true, auditId, preview: preview.plan });
		}
		const result = await definition.apply(input, caller);
		await settle('succeeded', null);
		return jsonResult({ dryRun: false, auditId, result });
	} catch (error) {
		const failure = describeToolFailure(definition.name, error);
		await settle(failure.outcome, failure.message);
		return errorResult(failure.message);
	}
}
