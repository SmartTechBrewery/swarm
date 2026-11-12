import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import { AgentRunError } from '@/harness/agent-failure.js';
import type { ProbeMcpServerOptions, ProbeMcpServerResult } from '@/harness/mcp-probe.js';
import {
	RESOLVE_PROBLEM_REPORT_FILENAME,
	RESOLVE_PROBLEM_REQUIRED_TOOLS,
	type ResolveProblemReport,
	runResolveProblem,
} from '@/pipeline/resolve-problem.js';

function agentResult(overrides: Partial<AgentCliResult> = {}): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 42,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
		...overrides,
	};
}

const REPORT: ResolveProblemReport = {
	outcome: 'resolved',
	bugReportId: '6f1f7d4e-0d5c-4b9b-8b4e-1d2f3a4b5c6d',
	actions: [{ tool: 'run_reset', target: 'run-failed', result: 'restarted' }],
	summary: 'The worker lost its transport; a reset restarted the phase.',
};

let scratchRoot: string;

beforeEach(async () => {
	scratchRoot = await mkdtemp(join(tmpdir(), 'resolve-problem-test-'));
});

afterEach(async () => {
	await rm(scratchRoot, { recursive: true, force: true });
});

/** A fake agent that writes `report` (when given) into its working directory. */
function fakeAgent(report: unknown, result: Partial<AgentCliResult> = {}) {
	return vi.fn(async (options: RunAgentCliOptions) => {
		if (report !== undefined) {
			await writeFile(
				join(options.cwd, RESOLVE_PROBLEM_REPORT_FILENAME),
				typeof report === 'string' ? report : JSON.stringify(report),
			);
		}
		return agentResult(result);
	});
}

function okProbe() {
	return vi.fn(
		async (_options: ProbeMcpServerOptions): Promise<ProbeMcpServerResult> => ({ ok: true }),
	);
}

function run(overrides: Partial<Parameters<typeof runResolveProblem>[0]> = {}) {
	return runResolveProblem({
		taskId: '1395',
		prompt: 'Resolve run run-failed.',
		swarmMcp: { url: 'https://swarm.example.com/operator/mcp', token: 'run-bound-token' },
		runId: 'run-resolve',
		scratchRoot,
		runAgent: fakeAgent(REPORT),
		probe: okProbe(),
		...overrides,
	});
}

describe('runResolveProblem (issue #1395)', () => {
	it('probes the MCP server, runs the agent with it attached in a scratch dir, and returns the report', async () => {
		const probe = okProbe();
		const runAgent = fakeAgent(REPORT);
		const { report } = await run({ probe, runAgent });

		expect(report).toEqual(REPORT);
		expect(probe).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'https://swarm.example.com/operator/mcp',
				bearerToken: 'run-bound-token',
				requiredTools: [...RESOLVE_PROBLEM_REQUIRED_TOOLS],
			}),
		);
		const options = runAgent.mock.calls[0][0];
		expect(options.args).toEqual(['Resolve run run-failed.']);
		expect(options.mcpServer).toEqual({
			name: 'swarm',
			url: 'https://swarm.example.com/operator/mcp',
			bearerToken: 'run-bound-token',
			requiredTools: [...RESOLVE_PROBLEM_REQUIRED_TOOLS],
		});
		// A fresh scratch directory, never a worktree — and removed afterwards.
		expect(options.cwd.startsWith(join(scratchRoot, 'swarm-resolve-problem-'))).toBe(true);
		expect(existsSync(options.cwd)).toBe(false);
	});

	it('requires the seven recovery and bug-report tools', () => {
		expect([...RESOLVE_PROBLEM_REQUIRED_TOOLS].sort()).toEqual(
			[
				'bug_report_add_occurrence',
				'bug_report_create',
				'bug_reports_list',
				'dispatch_history',
				'run_get',
				'run_reset',
				'runs_list',
			].sort(),
		);
	});

	it('fails at once with a terminal error, and never runs the agent, when the preflight fails', async () => {
		const runAgent = fakeAgent(REPORT);
		const probe = vi.fn(
			async (): Promise<ProbeMcpServerResult> => ({
				ok: false,
				reason: 'HTTP 401: the MCP server rejected the credential',
			}),
		);
		const error = await run({ probe, runAgent }).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(AgentRunError);
		expect((error as AgentRunError).message).toBe(
			'SWARM operator MCP unreachable: HTTP 401: the MCP server rejected the credential',
		);
		// `error` is the one kind no executor defers, so the run is not retried.
		expect((error as AgentRunError).failure.kind).toBe('error');
		expect(runAgent).not.toHaveBeenCalled();
		expect(await readdir(scratchRoot)).toEqual([]);
	});

	it('fails when the agent run fails', async () => {
		await expect(run({ runAgent: fakeAgent(REPORT, { exitCode: 1 }) })).rejects.toThrow(
			/Resolve problem agent \(claude\) exited with code 1/,
		);
	});

	it('fails when the agent wrote no report', async () => {
		await expect(run({ runAgent: fakeAgent(undefined) })).rejects.toThrow(
			`Agent did not write required hand-off ${RESOLVE_PROBLEM_REPORT_FILENAME}`,
		);
	});

	it('accepts an already-resolved report (issue #1441)', async () => {
		const alreadyResolved: ResolveProblemReport = {
			...REPORT,
			outcome: 'already-resolved',
			actions: [],
			summary: 'PR #2219 was merged outside SWARM.',
		};
		const { report } = await run({ runAgent: fakeAgent(alreadyResolved) });
		expect(report).toEqual(alreadyResolved);
	});

	it('fails on a report that does not match the contract', async () => {
		await expect(run({ runAgent: fakeAgent('{not json') })).rejects.toThrow(/not valid JSON/);
		await expect(run({ runAgent: fakeAgent({ ...REPORT, outcome: 'maybe' }) })).rejects.toThrow(
			/is invalid: outcome/,
		);
	});
});
