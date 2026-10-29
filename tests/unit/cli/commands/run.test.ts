import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResetRunResult } from '@/dispatch/run-reset.js';

const { resetRun, closeQueue, closeDb, closeCancellationRedis, RunResetError } = vi.hoisted(() => {
	// Stands in for the service's own class, so the command's `instanceof` refusal
	// check matches. Declared inside `vi.hoisted` because the mock factory below
	// runs before any module-level class declaration is initialized.
	class RunResetError extends Error {
		constructor(
			readonly reason: string,
			message: string,
		) {
			super(message);
			this.name = 'RunResetError';
		}
	}
	return {
		resetRun: vi.fn<(runId: string) => Promise<ResetRunResult>>(),
		closeQueue: vi.fn<() => Promise<void>>(),
		closeDb: vi.fn<() => Promise<void>>(),
		closeCancellationRedis: vi.fn<() => Promise<void>>(),
		RunResetError,
	};
});

// The read subcommands (issue #1182) go through the operator client, so that is the
// seam this suite drives for them — exactly as `workers.test.ts` does: one `query`
// answering per procedure path, with each call site's own `parse` invoked for real.
const { query, createOperatorClient, requireOperatorSession, OperatorApiError } = vi.hoisted(() => {
	class OperatorApiError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'OperatorApiError';
		}
	}
	return {
		query: vi.fn(),
		createOperatorClient: vi.fn(),
		requireOperatorSession: vi.fn(),
		OperatorApiError,
	};
});

vi.mock('@/cli/_shared/operator-client.js', () => ({
	createOperatorClient,
	requireOperatorSession,
	OperatorApiError,
}));
vi.mock('@/dispatch/run-reset.js', () => ({ resetRun, RunResetError }));
vi.mock('@/queue/producer.js', () => ({ closeQueue }));
vi.mock('@/db/client.js', () => ({ closeDb }));
vi.mock('@/queue/cancellation.js', () => ({
	closeRunCancellationRedis: closeCancellationRedis,
}));

import { resolveSince, run } from '@/cli/commands/run.js';

/** `runs.id` is a uuid column, and the command validates the shape before dialling out. */
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN_ID = '22222222-2222-4222-8222-222222222222';

/** The ordinary ending; the terminal one (issue #744) is built inline by its own test. */
type RestartedResult = Extract<ResetRunResult, { outcome: 'restarted' }>;

function resetResult(overrides: Partial<RestartedResult> = {}): RestartedResult {
	return {
		outcome: 'restarted',
		runId: RUN_ID,
		agentStop: 'not-running',
		dispatch: 'cancelled',
		cancellationCleared: true,
		worktree: { outcome: 'removed' },
		worktreeError: null,
		recoveryCleared: true,
		abandonedPreservedWorkerId: null,
		dispatchId: 'dispatch-9',
		...overrides,
	};
}

describe('run command', () => {
	let logged: string[];
	let errored: string[];

	beforeEach(() => {
		logged = [];
		errored = [];
		resetRun.mockReset().mockResolvedValue(resetResult());
		closeQueue.mockReset().mockResolvedValue(undefined);
		closeDb.mockReset().mockResolvedValue(undefined);
		closeCancellationRedis.mockReset().mockResolvedValue(undefined);
		vi.spyOn(console, 'log').mockImplementation((line: string) => {
			logged.push(line);
		});
		vi.spyOn(console, 'warn').mockImplementation((line: string) => {
			logged.push(line);
		});
		vi.spyOn(console, 'error').mockImplementation((line: string) => {
			errored.push(line);
		});
	});

	it('resets the run, reports each step, and closes the connections', async () => {
		await expect(run(['reset', RUN_ID])).resolves.toBe(0);
		// Issue #744: the run id is the whole call — there is no flag to thread.
		expect(resetRun).toHaveBeenCalledExactlyOnceWith(RUN_ID);
		expect(closeQueue).toHaveBeenCalledOnce();
		expect(closeDb).toHaveBeenCalledOnce();
		expect(closeCancellationRedis).toHaveBeenCalledOnce();

		const report = logged.join('\n');
		// Stated up front, since there is no opt-in left to decline.
		expect(report).toContain('a reset discards');
		// A run that had no agent to stop claims no step for it.
		expect(report).not.toContain('agent:');
		expect(report).toContain('dispatch: the active dispatch was cancelled');
		expect(report).toContain('cancellation flag: cleared');
		expect(report).toContain('checkout: removed and its lease released');
		expect(report).toContain('restart intent: the worker holding the checkout discards it');
		expect(report).toContain('recovery record: cleared');
		expect(report).toContain('re-dispatched from scratch as dispatch dispatch-9');
	});

	it('reports a cancelled claimed dispatch and the work it discarded', async () => {
		resetRun.mockResolvedValue(
			resetResult({
				dispatch: 'cancelled-claimed',
				worktree: { outcome: 'removed', discarded: 'dirty', staleLeaseReleased: true },
			}),
		);

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);

		const report = logged.join('\n');
		expect(report).toContain('a dispatch a worker had already claimed was cancelled');
		// The caveat this used to carry is gone with issue #745 — a reset stops the
		// agent that dispatch spawned, so there is nothing left to terminate by hand.
		expect(report).not.toContain('is not stopped by a reset');
		expect(report).toContain('uncommitted changes discarded as requested');
		expect(report).toContain('a stale worktree lease no live run owned was released');
	});

	// Issue #745 — the step that ended the two-step "Terminate, then Reset" dance.
	it('reports the live agent it stopped before tearing anything down', async () => {
		resetRun.mockResolvedValue(resetResult({ agentStop: 'stopped' }));

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);

		const report = logged.join('\n');
		expect(report).toContain('agent: the running agent was asked to stop');
		expect(report).toContain('before anything was torn down');
	});

	it('warns when the agent never confirmed the stop, and still reports the restart', async () => {
		resetRun.mockResolvedValue(resetResult({ agentStop: 'timed-out' }));

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);

		const report = logged.join('\n');
		expect(report).toContain('had not confirmed within the wait');
		// Never a refusal: the checkout went and the phase restarted regardless.
		expect(report).toContain('re-dispatched from scratch as dispatch dispatch-9');
		expect(errored).toEqual([]);
	});

	// Issue #744: this teardown reaches only the control-plane host, so a throw is
	// reported rather than fatal — the restart's own discard intent settles the rest.
	it('reports a local teardown that failed and still reports the restart', async () => {
		resetRun.mockResolvedValue(resetResult({ worktree: null, worktreeError: 'git exploded' }));

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);

		const report = logged.join('\n');
		expect(report).toContain("checkout: this host's teardown failed — git exploded");
		expect(report).toContain('re-dispatched from scratch as dispatch dispatch-9');
	});

	// A run nothing can be re-dispatched from is settled rather than refused, so the
	// command reports it as an ordinary outcome and exits 0.
	it('reports a terminally settled run as a normal outcome', async () => {
		resetRun.mockResolvedValue({
			outcome: 'terminated',
			runId: RUN_ID,
			agentStop: 'not-running',
			dispatch: 'cancelled',
			cancellationCleared: true,
			worktree: null,
			worktreeError: null,
			recoveryCleared: true,
			abandonedPreservedWorkerId: null,
			reason: 'Reset could not restart this run: it was created without a job payload.',
		});

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);

		const report = logged.join('\n');
		expect(report).toContain('not restarted: Reset could not restart this run');
		expect(report).toContain('recovery record: cleared');
		// Nothing carries a restart intent when nothing restarted.
		expect(report).not.toContain('restart intent:');
		expect(errored).toEqual([]);
	});

	it('reports a retained checkout with its reason', async () => {
		resetRun.mockResolvedValue(
			resetResult({ worktree: { outcome: 'blocked', blockedReason: 'unpushed' } }),
		);

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);
		expect(logged.join('\n')).toContain('checkout: retained — unpushed commits');
	});

	it('reports a checkout retained by a lease another live run holds', async () => {
		resetRun.mockResolvedValue(
			resetResult({ worktree: { outcome: 'blocked', blockedReason: 'live-leased' } }),
		);

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);
		const report = logged.join('\n');
		expect(report).toContain('checkout: retained — a lease held by another live run');
		// The operator needs to know who settles it, not to be sent back with a flag
		// that no longer exists (issue #744).
		expect(report).toContain('the worker holding it discards it');
		expect(report).not.toContain('--force');
	});

	it('reports an absent checkout and a dispatch that was not active', async () => {
		resetRun.mockResolvedValue(
			resetResult({
				dispatch: 'none',
				cancellationCleared: false,
				worktree: { outcome: 'absent' },
				recoveryCleared: false,
			}),
		);

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);
		const report = logged.join('\n');
		expect(report).toContain('dispatch: none was active');
		// Issue #592: not "nothing to remove" — the checkout may be alive on another
		// worker, which is the case the operator is resetting.
		expect(report).toContain('checkout: none on this host');
		expect(report).not.toContain('nothing to remove');
		expect(report).toContain('leftover lease marker here was dropped');
		// Steps the service did not perform are not claimed.
		expect(report).not.toContain('cancellation flag:');
		expect(report).not.toContain('recovery record:');
	});

	it('leaves an unknown option for the CLI dispatcher to map to exit 1', async () => {
		// `parseArgs` throws on an unknown option rather than returning a code; the
		// mapping to exit 1 belongs to `src/cli/index.ts`, which catches it.
		await expect(run(['reset', RUN_ID, '--nope'])).rejects.toThrow();
		// The removed opt-in is now one of those unknown options (issue #744).
		await expect(run(['reset', RUN_ID, '--force'])).rejects.toThrow();
		expect(resetRun).not.toHaveBeenCalled();
	});

	it('prints a refusal verbatim and exits 1', async () => {
		const refusal = `Run "${RUN_ID}" is already being restarted.`;
		resetRun.mockRejectedValue(new RunResetError('already-resetting', refusal));

		await expect(run(['reset', RUN_ID])).resolves.toBe(1);
		expect(errored.join('\n')).toContain(refusal);
		expect(closeQueue).toHaveBeenCalledOnce();
		expect(closeDb).toHaveBeenCalledOnce();
	});

	it('exits 1 on an unexpected failure and still closes the connections', async () => {
		resetRun.mockRejectedValue(new Error('redis down'));

		await expect(run(['reset', RUN_ID])).resolves.toBe(1);
		expect(errored.join('\n')).toContain('run reset failed: redis down');
		expect(closeDb).toHaveBeenCalledOnce();
	});

	it('prints usage without opening connections', async () => {
		await expect(run([])).resolves.toBe(1);
		await expect(run(['--help'])).resolves.toBe(0);
		await expect(run(['reset', '--help'])).resolves.toBe(0);
		expect(resetRun).not.toHaveBeenCalled();
		expect(closeQueue).not.toHaveBeenCalled();
		expect(closeDb).not.toHaveBeenCalled();
	});

	it('rejects an unknown subcommand, a missing/extra id, and a malformed id without opening connections', async () => {
		await expect(run(['restart'])).resolves.toBe(1);
		await expect(run(['reset'])).resolves.toBe(1);
		await expect(run(['reset', RUN_ID, OTHER_RUN_ID])).resolves.toBe(1);
		// A typo'd id would otherwise surface as a raw Postgres uuid-cast error.
		await expect(run(['reset', 'not-a-uuid'])).resolves.toBe(1);
		expect(errored.join('\n')).toContain("'not-a-uuid' is not a valid run id");
		expect(resetRun).not.toHaveBeenCalled();
		expect(closeQueue).not.toHaveBeenCalled();
		expect(closeDb).not.toHaveBeenCalled();
	});
});

describe('run read subcommands (issue #1182)', () => {
	let logged: string[];
	let errored: string[];
	let written: string[];
	/** Each procedure path's payload; `query` hands it to the call site's own `parse`. */
	let answers: Record<string, unknown | ((input: unknown) => unknown)>;

	const NOW = new Date('2026-10-29T12:00:00.000Z');

	function row(overrides: Record<string, unknown> = {}) {
		return {
			id: RUN_ID,
			projectId: 'proj-a',
			phase: 'implementation',
			status: 'failed',
			startedAt: '2026-10-29T10:00:00.000Z',
			completedAt: '2026-10-29T10:05:00.000Z',
			durationMs: 300_000,
			error: 'Agent exited 1\nwith a long trace',
			workItemTitle: 'Fix the widget',
			workItemUrl: 'https://github.com/acme/widgets/issues/7',
			prNumber: null,
			prTitle: null,
			taskId: '7',
			repository: 'acme/widgets',
			engine: 'claude',
			model: 'opus',
			nextRetryAt: null,
			kind: 'pipeline',
			workerName: 'studio-mac',
			// A field the human view never reads: `--json` must still carry it.
			usage: { inputTokens: 12 },
			...overrides,
		};
	}

	beforeEach(() => {
		logged = [];
		errored = [];
		written = [];
		answers = {};
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		query.mockReset().mockImplementation(async (path: string, input: unknown, parse) => {
			const answer = answers[path];
			return parse(typeof answer === 'function' ? answer(input) : answer);
		});
		createOperatorClient.mockReset().mockReturnValue({ query, mutate: vi.fn() });
		requireOperatorSession.mockReset().mockReturnValue({
			session: { controlPlaneUrl: 'https://swarm.example.com', token: 't', identifier: 'ada' },
		});
		vi.spyOn(console, 'log').mockImplementation((line: string) => {
			logged.push(line);
		});
		vi.spyOn(console, 'warn').mockImplementation((line: string) => {
			logged.push(line);
		});
		vi.spyOn(console, 'error').mockImplementation((line: string) => {
			errored.push(line);
		});
		vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('list', () => {
		it('maps its flags onto the runs.list input', async () => {
			answers['runs.list'] = { data: [], total: 0 };

			await expect(
				run([
					'list',
					'--project',
					'proj-a',
					'--status',
					'failed',
					'--phase',
					'review',
					'--since',
					'24h',
					'--limit',
					'10',
					'--offset',
					'20',
				]),
			).resolves.toBe(0);

			expect(query).toHaveBeenCalledWith(
				'runs.list',
				{
					projectId: 'proj-a',
					status: 'failed',
					phase: 'review',
					since: '2026-10-28T12:00:00.000Z',
					limit: 10,
					offset: 20,
				},
				expect.any(Function),
			);
			expect(logged.join('\n')).toContain('no runs');
		});

		it('passes an ISO 8601 --since through unchanged', async () => {
			answers['runs.list'] = { data: [], total: 0 };

			await run(['list', '--since', '2026-10-01T00:00:00+02:00']);

			expect(query.mock.calls[0][1]).toMatchObject({ since: '2026-10-01T00:00:00+02:00' });
		});

		it.each([
			[['--status', 'broken'], '--status must be one of'],
			[['--phase', 'deploy'], '--phase must be one of'],
			[['--since', 'yesterday'], '--since must be a duration'],
			[['--limit', '0'], '--limit must be an integer from 1 to 200'],
			[['--limit', '500'], '--limit must be an integer from 1 to 200'],
			[['--offset=-1'], '--offset must be an integer'],
			[['--offset', 'two'], '--offset must be an integer'],
		])('refuses %j without calling the control plane', async (flags, message) => {
			await expect(run(['list', ...flags])).resolves.toBe(1);

			expect(errored.join('\n')).toContain(message);
			expect(query).not.toHaveBeenCalled();
		});

		it('prints one line per run with its status and the first line of its headline', async () => {
			answers['runs.list'] = { data: [row()], total: 1 };

			await expect(run(['list'])).resolves.toBe(0);

			const line = logged.find((entry) => entry.includes(RUN_ID)) ?? '';
			expect(line).toContain('failed');
			expect(line).toContain('Fix the widget');
			expect(line).toContain('Agent exited 1');
			expect(line).not.toContain('long trace');
			expect(logged.join('\n')).not.toContain('next page');
		});

		it('names the next page when the total exceeds this one', async () => {
			answers['runs.list'] = { data: [row()], total: 7 };

			await run(['list', '--limit', '1', '--offset', '3']);

			expect(logged.join('\n')).toContain('showing 4–4 of 7; next page: --offset 4');
		});

		it("prints the control plane's payload unabridged with --json", async () => {
			const payload = { data: [row()], total: 1 };
			answers['runs.list'] = payload;

			await expect(run(['list', '--json'])).resolves.toBe(0);

			expect(logged).toHaveLength(1);
			expect(JSON.parse(logged[0])).toEqual(payload);
		});
	});

	describe('show', () => {
		it('refuses a malformed run id without calling the control plane', async () => {
			await expect(run(['show', 'not-a-uuid'])).resolves.toBe(1);

			expect(errored.join('\n')).toContain("'not-a-uuid' is not a valid run id");
			expect(query).not.toHaveBeenCalled();
		});

		it('prints the headline, the failure cause and its recovery', async () => {
			answers['runs.getById'] = row({
				failureDiagnosis: {
					kind: 'agent-error',
					title: 'The agent failed',
					message: 'It exited non-zero.',
					recovery: 'Retry the run.',
				},
				attribution: { workerName: 'studio-mac', userDisplayName: 'Ada' },
			});

			await expect(run(['show', RUN_ID])).resolves.toBe(0);

			expect(query).toHaveBeenCalledWith('runs.getById', { id: RUN_ID }, expect.any(Function));
			const report = logged.join('\n');
			expect(report).toContain('Agent exited 1\nwith a long trace');
			expect(report).toContain('The agent failed: It exited non-zero.');
			expect(report).toContain('Retry the run.');
			expect(report).toContain('studio-mac (Ada)');
			expect(report).toContain('5m 0s');
		});

		it('passes the payload through with --json', async () => {
			const payload = row({ failureDiagnosis: null, attribution: null });
			answers['runs.getById'] = payload;

			await expect(run(['show', RUN_ID, '--json'])).resolves.toBe(0);

			expect(logged).toHaveLength(1);
			expect(JSON.parse(logged[0])).toEqual(payload);
		});

		it("prints the control plane's refusal and exits 1", async () => {
			query.mockRejectedValue(new OperatorApiError(`Run with ID "${RUN_ID}" not found`));

			await expect(run(['show', RUN_ID])).resolves.toBe(1);

			expect(errored.join('\n')).toContain(`Run with ID "${RUN_ID}" not found`);
		});
	});

	describe('logs', () => {
		function page(ids: number[], hasMore: boolean, extra: Record<string, unknown> = {}) {
			return {
				events: ids.map((id) => ({
					id,
					stream: 'stdout',
					content: `line ${id}\n`,
					emittedAt: '2026-10-29T10:00:00.000Z',
				})),
				nextCursor: ids.at(-1) ?? 0,
				hasMore,
				truncated: false,
				retentionBytes: 1000,
				...extra,
			};
		}

		it('pages the agent output in order, then prints the captured streams', async () => {
			answers['runs.getOutput'] = (input: unknown) =>
				(input as { after: number }).after === 0 ? page([1, 2], true) : page([3], false);
			answers['runs.getLogs'] = { stdout: 'captured out', stderr: 'captured err' };

			await expect(run(['logs', RUN_ID])).resolves.toBe(0);

			const outputCalls = query.mock.calls.filter(([path]) => path === 'runs.getOutput');
			expect(outputCalls.map(([, input]) => input)).toEqual([
				{ runId: RUN_ID, after: 0 },
				{ runId: RUN_ID, after: 2 },
			]);
			expect(written.join('')).toContain('line 1\nline 2\nline 3\n');
			expect(written.join('')).toContain('captured out\n');
			expect(written.join('')).toContain('captured err\n');
			expect(logged.join('\n')).toContain('--- captured stdout ---');
			expect(logged.join('\n')).toContain('--- captured stderr ---');
		});

		it('stops on a cursor that does not advance', async () => {
			answers['runs.getOutput'] = page([], true);
			answers['runs.getLogs'] = null;

			await expect(run(['logs', RUN_ID])).resolves.toBe(0);

			expect(query.mock.calls.filter(([path]) => path === 'runs.getOutput')).toHaveLength(1);
			expect(logged.join('\n')).toContain('no agent output captured');
			expect(logged.join('\n')).toContain('no captured stdout/stderr stored for this run');
		});

		it('warns when the output was truncated at the retention cap', async () => {
			answers['runs.getOutput'] = page([1], false, { truncated: true, retentionBytes: 4096 });
			answers['runs.getLogs'] = null;

			await run(['logs', RUN_ID]);

			expect(logged.join('\n')).toContain('truncated at the 4096 byte retention cap');
		});

		it('emits one {output, logs} document with --json', async () => {
			const only = page([1], false);
			answers['runs.getOutput'] = only;
			answers['runs.getLogs'] = { stdout: 'out', stderr: null };

			await expect(run(['logs', RUN_ID, '--json'])).resolves.toBe(0);

			expect(logged).toHaveLength(1);
			expect(JSON.parse(logged[0])).toEqual({
				output: { events: only.events, truncated: false, retentionBytes: 1000 },
				logs: { stdout: 'out', stderr: null },
			});
			expect(written).toEqual([]);
		});
	});

	it('prints the missing-session error and exits 1, while --help still answers', async () => {
		requireOperatorSession.mockReturnValue({ error: 'not signed in — run `swarm login`' });

		await expect(run(['list'])).resolves.toBe(1);
		await expect(run(['show', RUN_ID])).resolves.toBe(1);
		expect(errored.join('\n')).toContain('not signed in');
		expect(query).not.toHaveBeenCalled();

		await expect(run(['list', '--help'])).resolves.toBe(0);
		await expect(run(['show', '--help'])).resolves.toBe(0);
		await expect(run(['logs', '--help'])).resolves.toBe(0);
	});

	it('resolves a relative --since against now, and refuses anything else', () => {
		const now = Date.parse('2026-10-29T12:00:00.000Z');
		expect(resolveSince('30m', now)).toBe('2026-10-29T11:30:00.000Z');
		expect(resolveSince('7d', now)).toBe('2026-10-22T12:00:00.000Z');
		expect(resolveSince('2026-10-01T00:00:00Z', now)).toBe('2026-10-01T00:00:00Z');
		expect(resolveSince('1w', now)).toBeUndefined();
	});
});
