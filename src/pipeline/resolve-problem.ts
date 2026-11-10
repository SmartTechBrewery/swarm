/**
 * The Resolve problem phase (issue #1395) — the worker half. An agent with the
 * SWARM operator MCP server attached diagnoses one failed run and tries SWARM's
 * own recovery tools on it, then hands back a report.
 *
 * It is the one phase that touches no repository, and that is structural rather
 * than a rule the agent is asked to keep: the agent runs in a fresh `mkdtemp`
 * scratch directory, never in a worktree, so there is no checkout to change. It
 * holds no WIP slot and never moves the board card either (`processJob`,
 * `../worker/consumer.ts`).
 *
 * Its credential is the run-bound scoped agent token the control plane minted for
 * this run (issue #1393) and carried on the assignment (`TaskAssignment.swarmMcp`).
 * The server reachable with it is probed before the agent starts (issue #1394), and
 * a server that cannot be reached fails the run at once: an agent CLI that cannot
 * reach an attached server does not fail — it runs without the tools — so the
 * agent must never be started without them.
 *
 * What this module does **not** decide is whether the attempt succeeded: the
 * report rides back on the result frame, and the control plane — the side with a
 * database — checks it against the bug report the run must have filed
 * (`../dispatch/resolve-problem.ts`).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import {
	type AgentCli,
	type AgentCliResult,
	type AgentMcpServer,
	describeAgent,
	runAgentCli,
} from '../harness/agent-cli.js';
import { AgentRunError, agentRunError, agentRunFailed } from '../harness/agent-failure.js';
import { probeMcpServer } from '../harness/mcp-probe.js';
import type { ReasoningLevel } from '../harness/models.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { RESOLVE_PROBLEM_REPORT_FILENAME } from './prompts/resolve-problem.js';

export { RESOLVE_PROBLEM_REPORT_FILENAME };

/** Coded default CLI for the Resolve problem phase (mirrors the other phases). */
export const DEFAULT_RESOLVE_PROBLEM_CLI: AgentCli = 'claude';

/** The name the SWARM operator MCP server is attached under. */
export const SWARM_MCP_SERVER_NAME = 'swarm';

/**
 * The operator MCP tools the phase cannot work without: the reads it diagnoses
 * with, the one recovery write, and the bug-report tools the settle requires it
 * to have used. The probe fails the run by name when any is missing.
 */
export const RESOLVE_PROBLEM_REQUIRED_TOOLS: readonly string[] = [
	'run_get',
	'runs_list',
	'dispatch_history',
	'run_reset',
	'bug_reports_list',
	'bug_report_create',
	'bug_report_add_occurrence',
];

/** Upper bound on the MCP preflight. */
const MCP_PROBE_TIMEOUT_MS = 30_000;

/** The prefix of the failure a preflight that did not pass settles the run with. */
export const MCP_UNREACHABLE_PREFIX = 'SWARM operator MCP unreachable';

/** The hand-off the agent writes: what it concluded, and every real write it made. */
export const ResolveProblemReportSchema = z.object({
	outcome: z.enum(['resolved', 'unresolved']),
	bugReportId: z.string().min(1),
	actions: z.array(
		z.object({
			tool: z.string().min(1),
			target: z.string(),
			result: z.string(),
		}),
	),
	summary: z.string().trim().min(1),
});
export type ResolveProblemReport = z.infer<typeof ResolveProblemReportSchema>;

/** The SWARM operator MCP endpoint and the run-bound token the assignment carried. */
export interface SwarmMcpAccess {
	url: string;
	token: string;
}

export interface RunResolveProblemOptions {
	taskId: string;
	/** The prompt the control plane composed (it holds the failed run's record). */
	prompt: string;
	swarmMcp: SwarmMcpAccess;
	cli?: AgentCli;
	model?: string;
	reasoning?: ReasoningLevel;
	/** Assigned as claude's `--session-id` on a fresh run. */
	sessionId?: string;
	runId?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	runAgent?: typeof runAgentCli;
	probe?: typeof probeMcpServer;
	/** Where the scratch directory is created — the OS temp dir by default. */
	scratchRoot?: string;
}

/** Read and validate the agent's hand-off, naming what was wrong with it. */
async function readReport(scratchDir: string): Promise<ResolveProblemReport> {
	const file = path.join(scratchDir, RESOLVE_PROBLEM_REPORT_FILENAME);
	let raw: string;
	try {
		raw = await readFile(file, 'utf8');
	} catch {
		throw new Error(`Agent did not write required hand-off ${RESOLVE_PROBLEM_REPORT_FILENAME}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`Hand-off ${RESOLVE_PROBLEM_REPORT_FILENAME} is not valid JSON: ${describeError(err)}`,
		);
	}
	const result = ResolveProblemReportSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(
			`Hand-off ${RESOLVE_PROBLEM_REPORT_FILENAME} is invalid: ${result.error.issues
				.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
				.join('; ')}`,
		);
	}
	return result.data;
}

/**
 * Run the Resolve problem agent: create the scratch directory, probe the SWARM
 * operator MCP server, run the agent with it attached, and read back its report.
 *
 * A failed probe throws a terminal `AgentRunError` (`kind: 'error'`) naming the
 * cause — `SWARM operator MCP unreachable: <reason>` — and the agent never starts;
 * that kind is never deferred, so the run is not retried. The scratch directory is
 * removed however the run ends.
 *
 * A retry never resumes an earlier session: each attempt gets a fresh scratch
 * directory, which a CLI's session store keys on, so there is nothing to resume.
 */
export async function runResolveProblem(
	options: RunResolveProblemOptions,
): Promise<{ agent: AgentCliResult; report: ResolveProblemReport }> {
	const {
		taskId,
		prompt,
		swarmMcp,
		cli = DEFAULT_RESOLVE_PROBLEM_CLI,
		model,
		reasoning,
		sessionId,
		runId,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		probe = probeMcpServer,
		scratchRoot = tmpdir(),
	} = options;
	logger.info(`Phase started - Resolve problem — running ${describeAgent(cli, model, reasoning)}`, {
		taskId,
		runId,
	});
	const server: AgentMcpServer = {
		name: SWARM_MCP_SERVER_NAME,
		url: swarmMcp.url,
		bearerToken: swarmMcp.token,
		requiredTools: [...RESOLVE_PROBLEM_REQUIRED_TOOLS],
	};
	const scratchDir = await mkdtemp(path.join(scratchRoot, 'swarm-resolve-problem-'));
	try {
		const preflight = await probe({
			url: server.url,
			bearerToken: server.bearerToken,
			requiredTools: server.requiredTools,
			timeoutMs: MCP_PROBE_TIMEOUT_MS,
		});
		if (!preflight.ok) {
			throw new AgentRunError(`${MCP_UNREACHABLE_PREFIX}: ${preflight.reason}`, { kind: 'error' });
		}
		const agent = await runAgent({
			cli,
			model,
			reasoning,
			sessionId,
			cwd: scratchDir,
			args: [prompt],
			mcpServer: server,
			maxOutputBytes: 1_000_000,
			logContext: { taskId, phase: 'resolve-problem', runId },
			timeoutMs,
			signal,
		});
		if (agentRunFailed(agent)) {
			throw agentRunError(
				agent,
				`Resolve problem agent (${cli}) exited with code ${agent.exitCode}`,
				` for task '${taskId}'`,
			);
		}
		const report = await readReport(scratchDir);
		logger.info('Phase finished - Resolve problem', {
			taskId,
			runId,
			outcome: report.outcome,
			bugReportId: report.bugReportId,
			actions: report.actions.length,
		});
		return { agent, report };
	} finally {
		await rm(scratchDir, { recursive: true, force: true }).catch((err) => {
			logger.warn('Could not remove the Resolve problem scratch directory', {
				scratchDir,
				error: describeError(err),
			});
		});
	}
}
