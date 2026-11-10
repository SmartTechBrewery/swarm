/**
 * Shared plumbing for the operator MCP server's tools (issue #1338).
 *
 * **A tool calls the dashboard's own tRPC procedure, never a repository.**
 * {@link callerFor} builds a server-side caller over `appRouter` for the user the
 * request's bearer resolved to, so a tool reaches exactly the procedure object the
 * dashboard calls — with its `assertProjectAccess`, its `accessibleProjectScope`
 * bound and its existence-hiding `NOT_FOUND` — and project roles cannot diverge
 * between the two surfaces. A tool that re-implemented a read against the
 * repository would have to re-implement that authorization too, and the first
 * time the two disagreed an MCP client would read what the dashboard hides.
 *
 * The caller spans `appRouter`, but only the procedures a *registered tool*
 * actually calls are reachable: an MCP client names a tool, never a procedure.
 * Registering a tool is therefore the deliberate act that publishes a procedure on
 * this internet-exposed surface, exactly as adding a namespace to
 * `../api/operator-router.ts` is for `/operator/trpc`.
 *
 * {@link runTool} first refuses a caller whose role ceiling is below the tool's
 * `TOOL_ACCESS` role (`./tool-access.ts`, issue #1382) — or a scoped agent
 * credential calling a tool outside its allowlist (issue #1385) — with
 * `FORBIDDEN`, then turns a tool body's outcome into the MCP result shape: the value
 * as pretty-printed JSON text (what every client renders) plus the same value as
 * `structuredContent` when it is an object, and a refusal or failure as an
 * `isError` result rather than a JSON-RPC error, so the calling model sees the
 * reason and can act on it.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TRPCError } from '@trpc/server';

import { appRouter } from '../api/router.js';
import { createCallerFactory } from '../api/trpc.js';
import type { SwarmUser } from '../identity/schema.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { assertToolAccess, type ToolContext } from './tool-access.js';

const createCaller = createCallerFactory(appRouter);

/** The server-side tRPC caller a tool reads through. */
export type SwarmCaller = ReturnType<typeof createCaller>;

/**
 * A caller bound to `user` — the same `{ user }` context the dashboard's and the
 * operator API's `createContext` build — so every procedure authorizes the MCP
 * request exactly as it authorizes that user in the browser.
 */
export function callerFor(user: SwarmUser): SwarmCaller {
	return createCaller({ user });
}

/**
 * Render a tool's return value as an MCP result. Round-tripping through JSON makes
 * `structuredContent` exactly what the text says (a `Date` becomes its ISO string in
 * both), and `structuredContent` is set only for a plain object because the MCP
 * schema requires one there.
 */
export function jsonResult(value: unknown): CallToolResult {
	const text = JSON.stringify(value ?? null, null, 2);
	const structured: unknown = JSON.parse(text);
	const isObject =
		typeof structured === 'object' && structured !== null && !Array.isArray(structured);
	return {
		content: [{ type: 'text', text }],
		...(isObject ? { structuredContent: structured as Record<string, unknown> } : {}),
	};
}

/** An `isError` result carrying `message` as its only content. */
export function errorResult(message: string): CallToolResult {
	return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * Run a tool body as `context`'s caller and map its outcome to an MCP result. A
 * caller below the tool's `TOOL_ACCESS` role is refused with `FORBIDDEN` and the
 * body never runs. A `TRPCError` is reported
 * verbatim as `<code>: <message>`, which is the same wording the dashboard shows —
 * whether it is the procedure's own refusal (`NOT_FOUND`, `FORBIDDEN`,
 * `PRECONDITION_FAILED`, …) or an internal error (`INTERNAL_SERVER_ERROR`, …), which
 * is also logged. Anything else is unexpected: it is logged with the tool's name —
 * never the request's bearer, which nothing here holds — and reported as its
 * described error.
 */
export async function runTool(
	context: ToolContext,
	tool: string,
	body: () => Promise<unknown>,
): Promise<CallToolResult> {
	try {
		assertToolAccess(tool, context);
		return jsonResult(await body());
	} catch (error) {
		return errorResult(describeToolFailure(tool, error).message);
	}
}

/**
 * The `TRPCError` codes that mean the procedure **broke**, not that it declined: the
 * server-class codes, plus `TIMEOUT`, after which a write may have half-happened.
 * tRPC wraps every non-`TRPCError` a procedure throws as `INTERNAL_SERVER_ERROR`, and
 * procedures such as `runs.reset` rethrow their own unexpected failures that way too,
 * so the error's class alone cannot tell a refusal from a failure.
 */
const FAILURE_CODES: ReadonlySet<TRPCError['code']> = new Set<TRPCError['code']>([
	'INTERNAL_SERVER_ERROR',
	'NOT_IMPLEMENTED',
	'BAD_GATEWAY',
	'SERVICE_UNAVAILABLE',
	'GATEWAY_TIMEOUT',
	'TIMEOUT',
]);

/**
 * How a tool body's throw reads: a `TRPCError` with a client-class code
 * (`NOT_FOUND`, `FORBIDDEN`, `PRECONDITION_FAILED`, `CONFLICT`, `BAD_REQUEST`, …) is
 * the procedure's own **refusal**, reported as `<code>: <message>`. Anything else is
 * an unexpected **failure**, logged with the tool's name: a `TRPCError` with a
 * {@link FAILURE_CODES} code — an internal error, including one tRPC or the
 * procedure wrapped as `INTERNAL_SERVER_ERROR` — keeps the same `<code>: <message>`
 * wording, and any other throw is reported as its described error. {@link runTool}'s
 * mapping, exposed so the write-tool framework (`./write-tool.ts`) can audit which
 * of the two a call ended in.
 */
export function describeToolFailure(
	tool: string,
	error: unknown,
): { outcome: 'refused' | 'failed'; message: string } {
	if (error instanceof TRPCError) {
		const message = `${error.code}: ${error.message}`;
		if (!FAILURE_CODES.has(error.code)) return { outcome: 'refused', message };
		logger.warn('operator MCP tool failed', {
			tool,
			error: message,
			...(error.cause ? { cause: describeError(error.cause) } : {}),
		});
		return { outcome: 'failed', message };
	}
	const message = describeError(error);
	logger.warn('operator MCP tool failed', { tool, error: message });
	return { outcome: 'failed', message: `Tool "${tool}" failed: ${message}` };
}
