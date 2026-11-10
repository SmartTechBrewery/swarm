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
 *  - **The tool's role, then the procedure's.** A caller below the tool's
 *    `TOOL_ACCESS` role (`./tool-access.ts`, issue #1382) — or a scoped agent
 *    credential calling a tool outside its allowlist (issue #1385) — is refused
 *    with `FORBIDDEN` right after the audit row is written, so the refusal is
 *    audited and neither `preview` nor `apply` runs.
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
 *  - **An optional recorded `detail`.** A `preview` may return a `detail` the row
 *    keeps when the call settles (issue #1349) — what the change replaced, say, so a
 *    later tool can undo it (`phase_agents_restore` reads the `{ previous, next }`
 *    order `phase_agents_reorder` records). `apply` is handed the very preview it was
 *    authorized by, so what it writes is what the row says it wrote.
 *  - **Which credential acted.** The row records the request's credential kind —
 *    `user`, or `scoped-agent-token` with the token's id (issue #1385) — so an
 *    agent's calls read apart from its holder's own.
 *  - **A run-bound credential's guardrails** (issue #1393). A *real* call made with
 *    a scoped agent credential minted for one run is refused with `FORBIDDEN`
 *    (audited `refused`, before `preview`) when the token has already made its
 *    `maxWriteActions` real calls — every audited real call that was not refused
 *    counts, failed ones included — when no earlier dry run of the same tool on the
 *    same target *succeeded* with it, or when it already applied the same tool to
 *    the same target (a `succeeded` or `failed` real call, or one still `pending` —
 *    so a retry or parallel call racing an in-flight apply is refused too). Dry
 *    runs are never capped, and no other credential is affected.
 *  - **No secret in the audit trail.** A tool that accepts a secret names the field in
 *    `secretInputs`, and the row records it as `[redacted]` (issue #1359).
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
	countRunBoundActions,
	recordOperatorAction,
	settleOperatorAction,
} from '../db/repositories/operatorActionsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { assertToolAccess, type McpCredential, type ToolContext } from './tool-access.js';
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
	/**
	 * What the audit row records about this change when the call settles (its
	 * `detail` column); omitted, the column stays `null`.
	 */
	detail?: unknown;
}

export interface WriteToolDefinition<
	Shape extends z.ZodRawShape,
	Preview extends WriteToolPreview = WriteToolPreview,
> {
	name: string;
	title: string;
	description: string;
	/** The tool's own arguments; `reason` and `dryRun` are added to them. */
	inputSchema: Shape;
	/** Whether the write discards state (MCP's `destructiveHint`). */
	destructive: boolean;
	/**
	 * Input fields that carry a **secret** (issue #1359: a credential value, a reviewer
	 * token). The audit row records each present one as {@link REDACTED} instead of its
	 * value, so a secret accepted as input is never written to `operator_actions`. Keep
	 * secrets out of {@link targetOf} and every result as well; nothing here can.
	 */
	secretInputs?: readonly (keyof Shape & string)[];
	/** What the call acts on, recorded as the audit row's `target`. */
	targetOf: (input: z.objectOutputType<Shape, z.ZodTypeAny>) => string;
	/**
	 * Read-only, and authorized exactly as `apply` is. Runs first on every call; its
	 * `plan` is the dry run's answer.
	 */
	preview: (
		input: z.objectOutputType<Shape, z.ZodTypeAny>,
		caller: SwarmCaller,
	) => Promise<Preview>;
	/**
	 * The write itself — the dashboard procedure the tool wraps. Handed the preview
	 * this call was authorized by, so it can write exactly what that preview recorded.
	 */
	apply: (
		input: z.objectOutputType<Shape, z.ZodTypeAny>,
		caller: SwarmCaller,
		preview: Preview,
	) => Promise<unknown>;
}

/** What the audit row records in place of a {@link WriteToolDefinition.secretInputs} value. */
export const REDACTED = '[redacted]';

/** `input` with every present secret field replaced by {@link REDACTED}. */
function auditableInput(input: Record<string, unknown>, secretInputs: readonly string[] = []) {
	const recorded = { ...input };
	for (const key of secretInputs) {
		if (recorded[key] !== undefined) recorded[key] = REDACTED;
	}
	return recorded;
}

type WriteToolArgs<Shape extends z.ZodRawShape> = z.objectOutputType<Shape, z.ZodTypeAny> & {
	reason: string;
	dryRun: boolean;
};

/** Register one write tool on `server`, authorizing and auditing every call as `context`'s user. */
export function registerWriteTool<
	Shape extends z.ZodRawShape,
	Preview extends WriteToolPreview = WriteToolPreview,
>(server: McpServer, context: ToolContext, definition: WriteToolDefinition<Shape, Preview>): void {
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
		(args) => runWriteTool(definition, context, args as unknown as WriteToolArgs<Shape>),
	);
}

/** One write-tool call, start to settle. Exported for the framework's own tests. */
export async function runWriteTool<
	Shape extends z.ZodRawShape,
	Preview extends WriteToolPreview = WriteToolPreview,
>(
	definition: WriteToolDefinition<Shape, Preview>,
	context: ToolContext,
	args: WriteToolArgs<Shape>,
): Promise<CallToolResult> {
	const { user, credential } = context;
	const { reason, dryRun, ...rest } = args;
	const input = rest as unknown as z.objectOutputType<Shape, z.ZodTypeAny>;

	let auditId: string;
	let target: string;
	try {
		target = definition.targetOf(input);
		auditId = await recordOperatorAction({
			userId: user.id,
			userIdentifier: user.identifier,
			tool: definition.name,
			projectId: null,
			target,
			reason,
			dryRun,
			input: auditableInput(input, definition.secretInputs),
			credentialKind: credential.kind,
			agentTokenId: credential.kind === 'scoped-agent-token' ? credential.tokenId : null,
			runId: credential.kind === 'scoped-agent-token' ? (credential.runId ?? null) : null,
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
	let detail: unknown;
	const settle = async (outcome: 'succeeded' | 'refused' | 'failed', error: string | null) => {
		try {
			await settleOperatorAction(auditId, {
				outcome,
				error,
				projectId,
				...(detail !== undefined ? { detail } : {}),
			});
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
		// After the row is written, so a caller below the tool's role is audited as
		// refused — and before anything else, so they learn nothing more.
		assertToolAccess(definition.name, context);
		if (reason.trim().length === 0) {
			throw new TRPCError({
				code: 'BAD_REQUEST',
				message: 'A write tool needs a non-empty `reason`.',
			});
		}
		if (!dryRun) await assertRunGuardrails(definition.name, target, credential, auditId);
		const caller = callerFor(user);
		const preview = await definition.preview(input, caller);
		projectId = preview.projectId;
		detail = preview.detail;
		if (dryRun) {
			await settle('succeeded', null);
			return jsonResult({ dryRun: true, auditId, preview: preview.plan });
		}
		const result = await definition.apply(input, caller, preview);
		await settle('succeeded', null);
		return jsonResult({ dryRun: false, auditId, result });
	} catch (error) {
		const failure = describeToolFailure(definition.name, error);
		await settle(failure.outcome, failure.message);
		return errorResult(failure.message);
	}
}

/**
 * Throw `FORBIDDEN` when a **real** call made with a run-bound scoped agent
 * credential (issue #1393) breaks one of its run's guardrails, in this order: the
 * run has used up its write cap, it never dry-ran this tool on this target
 * successfully, or it already applied this tool to this target. Any other
 * credential passes untouched. `auditId` is the asking call's own, still-pending
 * row, which neither the cap nor the no-repeat read may count.
 *
 * Every read is keyed on the credential's **run**, never its token (issue #1395):
 * a deferred run is retried under a freshly minted token while the earlier one is
 * deleted, so a per-token count would hand each retry a fresh cap and a clean
 * no-repeat ledger.
 *
 * Both of those count `pending` real rows as well as settled ones, so a call that
 * races another in flight — an MCP client retrying after its own timeout, two
 * parallel tool calls — sees it. Two racing calls on the same tool and target
 * each see the other's row and are both refused, which fails closed.
 *
 * A guardrail that cannot be read refuses the call too — nothing has been written
 * yet, and a `failed` row would spend the run's cap and block the target for good.
 */
async function assertRunGuardrails(
	tool: string,
	target: string,
	credential: McpCredential,
	auditId: string,
): Promise<void> {
	if (credential.kind !== 'scoped-agent-token' || credential.runId === undefined) return;
	const runId = credential.runId;
	const cap = credential.maxWriteActions ?? 0;

	let spent: number;
	let dryRunsSucceeded: number;
	let applied: number;
	try {
		[spent, dryRunsSucceeded, applied] = await Promise.all([
			countRunBoundActions({
				runId,
				dryRun: false,
				outcomes: ['pending', 'succeeded', 'failed'],
				excludeId: auditId,
			}),
			countRunBoundActions({
				runId,
				dryRun: true,
				outcomes: ['succeeded'],
				tool,
				target,
			}),
			countRunBoundActions({
				runId,
				dryRun: false,
				outcomes: ['pending', 'succeeded', 'failed'],
				tool,
				target,
				excludeId: auditId,
			}),
		]);
	} catch (error) {
		throw new TRPCError({
			code: 'FORBIDDEN',
			message: `This run's write guardrails could not be checked (${describeError(error)}).`,
		});
	}

	if (spent >= cap) {
		throw new TRPCError({
			code: 'FORBIDDEN',
			message: `write-action cap of ${cap} reached for this run`,
		});
	}
	if (dryRunsSucceeded === 0) {
		throw new TRPCError({ code: 'FORBIDDEN', message: `dry run ${tool} on ${target} first` });
	}
	if (applied > 0) {
		throw new TRPCError({
			code: 'FORBIDDEN',
			message: `${tool} was already applied to ${target} in this run`,
		});
	}
}
