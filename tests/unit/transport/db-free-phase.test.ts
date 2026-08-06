import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import type { ScmDeliveryProvider } from '@/scm/delivery.js';
import { buildTaskAssignment } from '@/transport/assignment.js';
import { runAssignmentDbFree } from '@/transport/assignment-execution.js';
import type { AssignmentSink } from '@/transport/worker-client.js';
import { createMockProjectConfig, createMockTaskAssignmentInput } from '../../helpers/factories.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function agentResult(): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 1,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
	};
}

function delivery(): ScmDeliveryProvider {
	return {
		commitIdentity: { name: 'Remote Operator', email: 'remote@example.com' },
		findPullRequest: vi.fn(async () => undefined),
		createPullRequest: vi.fn(async () => ({ number: 1, url: 'https://example.test/pr/1' })),
		pushBranch: vi.fn(async () => {}),
		submitReview: vi.fn(async () => 1),
		postComment: vi.fn(async () => 1),
	};
}

describe('real DB-free phase worktree lifecycle', () => {
	let repoRoot: string | undefined;
	const isolatedGitEnv = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
	);

	function git(args: string[]): void {
		execFileSync('git', args, { cwd: repoRoot, env: isolatedGitEnv });
	}

	afterEach(() => {
		vi.unstubAllEnvs();
		if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
		repoRoot = undefined;
	});

	it('runs a real phase with a worker-local repoRoot and no database or Redis', async () => {
		repoRoot = mkdtempSync(join(tmpdir(), 'swarm-db-free-phase-'));
		git(['init', '-b', 'main']);
		git(['config', 'user.name', 'Test Worker']);
		git(['config', 'user.email', 'worker@example.com']);
		writeFileSync(join(repoRoot, 'README.md'), 'remote checkout\n');
		git(['add', 'README.md']);
		git(['commit', '-m', 'chore: seed remote checkout']);
		git(['branch', 'issue-17']);

		// Any accidental store-backed call must fail this test immediately.
		vi.stubEnv('DATABASE_URL', '');
		vi.stubEnv('SWARM_POSTGRES_HOST', '');
		vi.stubEnv('REDIS_URL', '');

		const assignment = buildTaskAssignment(
			createMockTaskAssignmentInput({
				project: createMockProjectConfig({ repoRoot: '/control-plane/swarm' }),
				phase: 'respond-to-ci',
				workItem: undefined,
				pr: { prNumber: '17', prBranch: 'issue-17', headSha: 'deadbeef' },
			}),
		);
		const sent: Array<Record<string, unknown>> = [];
		const sink: AssignmentSink = {
			send(frame) {
				sent.push(frame as unknown as Record<string, unknown>);
			},
		};
		const baseRunAgent = vi.fn<(options: RunAgentCliOptions) => Promise<AgentCliResult>>(
			async (options) => {
				expect(options.cwd.startsWith(repoRoot as string)).toBe(true);
				writeFileSync(
					join(options.cwd, 'respond_to_ci_handoff.json'),
					JSON.stringify({ outcome: 'no-fix', body: 'The failing check was transient.' }),
				);
				return agentResult();
			},
		);

		await runAssignmentDbFree(assignment, sink, {
			repoRoot,
			operatorToken: 'operator-token',
			controlPlaneUrl: 'https://swarm.example',
			workerCredential: 'worker-credential',
			deps: {
				baseRunAgent,
				buildDelivery: async () => delivery(),
				logger: silentLogger,
			},
		});

		expect(baseRunAgent).toHaveBeenCalledOnce();
		expect(sent.at(-1)).toMatchObject({
			type: 'task-execution-result',
			status: 'succeeded',
			phase: 'respond-to-ci',
		});
		expect(existsSync(join(repoRoot, '.swarm-workspaces', 'task-17'))).toBe(false);
	});
});
