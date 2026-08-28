import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliResult, RunAgentCliOptions } from '@/harness/agent-cli.js';
import type { ScmDeliveryProvider } from '@/scm/delivery.js';
import { buildTaskAssignment } from '@/transport/assignment.js';
import { runAssignmentDbFree } from '@/transport/assignment-execution.js';
import type { FetchLike } from '@/transport/delivery-client.js';
import type { AssignmentSink } from '@/transport/worker-client.js';
import {
	createMockProjectConfig,
	createMockTaskAssignmentInput,
	createMockWorkItem,
} from '../../helpers/factories.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** The run row a Planning delivery's idempotency marker is keyed on (`planDeliveryMarker`). */
const RUN_ID = '55555555-5555-4555-8555-555555555555';

function jsonResponse(body: unknown): Awaited<ReturnType<FetchLike>> {
	return { ok: true, status: 200, json: async () => body };
}

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

	/**
	 * The acceptance test for issue #536: the **real** `runPlanningPhase` body,
	 * including the task-splitting path, driven end to end on the DB-free executor
	 * with no `DATABASE_URL`/`REDIS_URL` and no PM credential anywhere on the worker.
	 * Every board operation is answered by a fake delivery API, which is what proves
	 * the phase's whole PM surface is actually covered — the previous test's phase
	 * (`respond-to-ci`) touches no board at all.
	 */
	it('runs a real Planning phase with a task split entirely over the delivery API', async () => {
		repoRoot = mkdtempSync(join(tmpdir(), 'swarm-db-free-planning-'));
		git(['init', '-b', 'main']);
		git(['config', 'user.name', 'Test Worker']);
		git(['config', 'user.email', 'worker@example.com']);
		writeFileSync(join(repoRoot, 'README.md'), 'remote checkout\n');
		git(['add', 'README.md']);
		git(['commit', '-m', 'chore: seed remote checkout']);

		vi.stubEnv('DATABASE_URL', '');
		vi.stubEnv('SWARM_POSTGRES_HOST', '');
		vi.stubEnv('REDIS_URL', '');

		const parent = createMockWorkItem({
			id: 'ITEM_60',
			title: 'Do a large thing',
			description: 'The original, oversized scope.',
			url: 'https://github.com/SmartTechBrewery/swarm/issues/60',
		});
		const assignment = buildTaskAssignment(
			createMockTaskAssignmentInput({
				project: createMockProjectConfig({ repoRoot: '/control-plane/swarm' }),
				phase: 'planning',
				taskId: '60',
				runId: RUN_ID,
				workItem: parent,
			}),
		);

		/** Every board call the phase makes, as `route → body`, in order. */
		const boardCalls: Array<{ route: string; body: Record<string, unknown> }> = [];
		const fetchImpl: FetchLike = async (url, init) => {
			const route = url.replace('https://swarm.example/worker/delivery', '');
			boardCalls.push({ route, body: JSON.parse(init.body) });
			// Only the worker's own credential authenticates these — never a project's.
			expect(init.headers.authorization).toBe('Bearer worker-credential');
			if (route === '/pm/find-comment') return jsonResponse({ commentId: null });
			// Nothing on the board carries this delivery's per-child marker yet — the
			// first attempt of a split, so every child is created rather than adopted.
			if (route === '/pm/find-item-by-marker') return jsonResponse({ item: null });
			if (route === '/pm/create-item')
				return jsonResponse({
					item: {
						id: 'ITEM_61',
						title: 'Large thing 2/2: The second half',
						url: 'https://github.com/SmartTechBrewery/swarm/issues/61',
					},
				});
			if (route === '/pm/comment') return jsonResponse({ commentId: `IC_${boardCalls.length}` });
			return jsonResponse({});
		};

		const sent: Array<Record<string, unknown>> = [];
		const sink: AssignmentSink = {
			send(frame) {
				sent.push(frame as unknown as Record<string, unknown>);
			},
		};
		const baseRunAgent = vi.fn<(options: RunAgentCliOptions) => Promise<AgentCliResult>>(
			async (options) => {
				// The plan, the scope declaration and the split contract are all written
				// into this host's own checkout — none of it crosses the wire.
				expect(options.cwd.startsWith(repoRoot as string)).toBe(true);
				writeFileSync(
					join(options.cwd, 'proposed_plan.md'),
					'## Scope gate\nOne cohesive concern.\n\n## Plan\nDo the first half.\n',
				);
				writeFileSync(
					join(options.cwd, 'proposed_scope.json'),
					JSON.stringify({
						whyOneTask: 'The first half stands alone.',
						independentConcerns: ['the first half'],
						affectedAreas: ['src/thing.ts'],
					}),
				);
				writeFileSync(
					join(options.cwd, 'proposed_split.json'),
					JSON.stringify({
						sharedName: 'Large thing',
						mainTask: {
							title: 'The first half',
							description: 'Narrowed to the first half.',
						},
						subTasks: [
							{
								title: 'The second half',
								description: 'The remaining work.',
								plan: '## Plan\nDo the second half.',
							},
						],
					}),
				);
				return agentResult();
			},
		);

		await runAssignmentDbFree(assignment, sink, {
			repoRoot,
			controlPlaneUrl: 'https://swarm.example',
			workerCredential: 'worker-credential',
			deps: {
				baseRunAgent,
				buildDelivery: async () => delivery(),
				fetchImpl,
				logger: silentLogger,
			},
		});

		expect(sent.at(-1)).toMatchObject({
			type: 'task-execution-result',
			status: 'succeeded',
			phase: 'planning',
		});

		// The whole split, in the order the phase performs it: check this delivery's
		// own marker, re-scope the parent, look for a child this delivery already
		// created (issue #543), create it, publish its preplan, embed the marker, mark
		// it planned, move it to Planning, chain its dependency edge, explain the
		// split, post the parent's plan, mark the parent planned. Ordering is
		// load-bearing (issues #431, #436, #737 — the label goes on *before* the move,
		// because that move is the event the Planning dispatch keys on), so it is
		// asserted rather than just the set of calls.
		expect(boardCalls.map((call) => call.route)).toEqual([
			'/pm/find-comment',
			'/pm/update-item',
			'/pm/find-item-by-marker',
			'/pm/create-item',
			'/pm/comment',
			'/pm/update-item',
			'/pm/label',
			'/pm/move',
			'/pm/blocked-by',
			'/pm/comment',
			'/pm/comment',
			'/pm/label',
		]);
		const byRoute = (route: string) => boardCalls.filter((call) => call.route === route);
		// The replay guard keys on *this* run's id, so a retry reuses its comment and
		// re-creates no children.
		expect(byRoute('/pm/find-comment')[0]?.body).toMatchObject({
			itemId: 'ITEM_60',
			marker: expect.stringContaining(RUN_ID),
		});
		// The child is created in Backlog carrying the parent's labels plus the
		// split-child one (issue #594), and `planned` deliberately not among them
		// (issue #436) — titled as its own phase of the split's shared name.
		expect(byRoute('/pm/create-item')[0]?.body).toMatchObject({
			projectId: 'swarm',
			title: 'Large thing 2/2: The second half',
			status: 'backlog',
			labels: ['swarm', 'swarm:split-child'],
		});
		// The original card is renamed to phase 1 of that same shared name, so the
		// board never shows a generic parent beside named children.
		expect(byRoute('/pm/update-item')[0]?.body).toMatchObject({
			itemId: 'ITEM_60',
			title: 'Large thing 1/2: The first half',
		});
		expect(byRoute('/pm/move')[0]?.body).toMatchObject({ itemId: 'ITEM_61', status: 'planning' });
		expect(byRoute('/pm/label').map((call) => call.body)).toMatchObject([
			{ itemId: 'ITEM_61', name: 'planned' },
			{ itemId: 'ITEM_60', name: 'planned' },
		]);
		expect(byRoute('/pm/blocked-by')[0]?.body).toMatchObject({
			itemId: 'ITEM_61',
			blockerId: 'ITEM_60',
		});
		// The child's body carries the parent-written plan as a validated preplan
		// marker — the artifact that suppresses a second Planning agent run.
		expect(byRoute('/pm/update-item')[1]?.body.description).toContain('swarm-preplan:v1');
		// The plan is a review artifact, so the detached checkout is thrown away.
		expect(existsSync(join(repoRoot, '.swarm-workspaces', 'task-60'))).toBe(false);
	});
});
