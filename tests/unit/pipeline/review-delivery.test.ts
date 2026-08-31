import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliResult } from '@/harness/agent-cli.js';
import { runReviewPhase } from '@/pipeline/review.js';
import { DeliveryDeferredError, type ScmDeliveryProvider } from '@/scm/delivery.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { readDeliveryId } from '../../helpers/delivery-sidecar.js';
import {
	createMockProjectConfig,
	createMockProjectRepositoryPair,
} from '../../helpers/factories.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agentResult(overrides: Partial<AgentCliResult> = {}): AgentCliResult {
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
		sessionId: 'session-1',
		...overrides,
	};
}

/** A valid structured hand-off (issue #470); `overrides` merge over the defaults. */
function structuredHandoff(overrides: Record<string, unknown> = {}) {
	return {
		verdict: 'approve',
		summary: 'Adds Bitbucket webhook signature verification.',
		verification: [{ command: 'npm run typecheck', outcome: 'passed' }],
		docsChecked: [{ path: 'README.md', status: 'not-applicable' }],
		...overrides,
	};
}

/**
 * Delivery-mode phase options (a `delivery` provider is present, so this is not
 * the legacy bare-verdict path), with the agent writing `handoff` to the worktree.
 * Pass an array to give successive agent runs different hand-offs — that is how
 * the repair pass is exercised, since it is a second run against the same
 * worktree; the last entry repeats once the array is exhausted.
 *
 * `agentOverrides` shapes the {@link AgentCliResult} those runs report, with the
 * same per-run array form. It is its own parameter rather than part of
 * `overrides`, because `agentResult()` is called inside the default `runAgent`
 * closure below: reaching it through `overrides` would mean replacing `runAgent`
 * wholesale and losing the hand-off writing this helper exists to provide.
 */
function deliveryDeps(
	handoff: unknown,
	overrides: Record<string, unknown> = {},
	agentOverrides: Partial<AgentCliResult> | Partial<AgentCliResult>[] = {},
) {
	const handoffs = Array.isArray(handoff) ? [...handoff] : [handoff];
	const agents = Array.isArray(agentOverrides) ? [...agentOverrides] : [agentOverrides];
	const path = mkdtempSync(join(tmpdir(), 'swarm-review-render-'));
	roots.push(path);
	const handle: WorktreeHandle = { taskId: 'review-42', path, branch: 'abc', detached: true };
	const worktrees = {
		provision: vi.fn(async () => handle),
		worktreePath: vi.fn(() => handle.path),
		reuse: vi.fn(async () => handle),
		cleanup: vi.fn(async () => undefined),
	} as unknown as GitWorktreeManager;
	// Typed so the assertions below can read the submitted body off `mock.calls`.
	const submitReview = vi.fn<
		(input: { prNumber: number; verdict: string; body: string }) => Promise<number>
	>(async () => 77);
	return {
		path,
		submitReview,
		options: {
			project: createMockProjectConfig(),
			// The repository the run recorded, fed explicitly rather than read off the
			// project config (issue #692).
			repository: 'SmartTechBrewery/run-repo',
			prNumber: '42',
			headSha: 'abc1234',
			taskId: 'review-42',
			worktrees,
			runAgent: vi.fn(async () => {
				const next = handoffs.length > 1 ? handoffs.shift() : handoffs[0];
				const agent = agents.length > 1 ? agents.shift() : agents[0];
				writeFileSync(join(path, 'review_handoff.json'), JSON.stringify(next));
				return agentResult(agent);
			}),
			graft: vi.fn(() => []),
			getToken: vi.fn(async () => 'review-token'),
			delivery: {
				commitIdentity: { name: 'reviewer', email: 'reviewer@users.noreply.github.com' },
				findPullRequest: vi.fn(),
				createPullRequest: vi.fn(),
				pushBranch: vi.fn(),
				submitReview,
				postComment: vi.fn(),
			} as unknown as ScmDeliveryProvider,
			markReviewVerdictSubmitted: vi.fn(async () => ({ id: 'verdict-1', ordinal: 1 })),
			abandonReviewVerdict: vi.fn(async () => undefined),
			getPriorSubmittedReview: vi.fn(async () => undefined),
			...overrides,
		},
	};
}

/**
 * The posted body is rendered by SWARM from the hand-off's fields (issue #470),
 * not authored by the agent — that is what makes a review's structure identical
 * whichever CLI produced it.
 */
describe('review body rendering', () => {
	it('posts a rendered body, not anything the agent formatted', async () => {
		const { submitReview, options } = deliveryDeps(
			structuredHandoff({ body: '## MY OWN HEADING\nplease keep this' }),
		);

		await runReviewPhase(options);

		const posted = submitReview.mock.calls[0][0].body;
		expect(posted).toContain('> **Review** · pass 1 of 3 · `approve` · head `abc1234`');
		expect(posted).toContain('## Scope');
		expect(posted).toContain('Adds Bitbucket webhook signature verification.');
		expect(posted).toContain('| `npm run typecheck` | passed |');
		// A stray `body` field the agent invents is discarded, not appended.
		expect(posted).not.toContain('MY OWN HEADING');
	});

	// The pass number comes from the ledger's ordinal, which already exists and was
	// previously discarded — never from an agent-side count, which a retry would
	// drift.
	it('derives the pass number from the prior submitted verdict', async () => {
		const { submitReview, options } = deliveryDeps(
			structuredHandoff({
				verdict: 'request-changes',
				findings: [
					{
						id: 'F1',
						title: 'Still wrong',
						severity: 'blocker',
						category: 'correctness',
						evidence: '`webhook.ts:245`.',
						failureScenario: 'Two keys for one commit.',
						impact: 'A duplicate reviewer run.',
						fixPlan: ['Abbreviate at the boundary.'],
						tests: 'Assert equality.',
					},
				],
			}),
			{
				getPriorSubmittedReview: vi.fn(async () => ({
					id: 'verdict-1',
					ordinal: 1,
					verdict: 'request-changes',
				})),
			},
		);

		await runReviewPhase(options);

		const posted = submitReview.mock.calls[0][0].body;
		expect(posted).toContain('**First re-review** · pass 2 of 3');
	});

	it('rejects a fresh run whose hand-off is the pre-#470 authored-body shape', async () => {
		const { options } = deliveryDeps({ verdict: 'approve', body: 'Looks good', findings: [] });

		await expect(runReviewPhase(options)).rejects.toThrow(/Invalid hand-off/);
		// The review was never submitted, so the run must not charge the PR one of
		// its three verdict slots (issue #235) — a malformed hand-off is a failed
		// attempt, not a spent verdict.
		expect(options.abandonReviewVerdict).toHaveBeenCalled();
		expect(options.markReviewVerdictSubmitted).not.toHaveBeenCalled();
	});

	// Without this the agent never learns why its hand-off was rejected: the phase
	// throws, the queue re-runs the whole review, and a model that mis-shapes the
	// JSON the same way each time burns every attempt.
	it('gives an invalid hand-off one repair pass carrying the validator’s complaint', async () => {
		const { submitReview, options } = deliveryDeps([
			structuredHandoff({ verdict: 'nonsense' }),
			structuredHandoff(),
		]);

		await runReviewPhase(options);

		const runAgent = options.runAgent as ReturnType<typeof vi.fn>;
		expect(runAgent).toHaveBeenCalledTimes(2);
		const repairPrompt = runAgent.mock.calls[1][0].args[0];
		expect(repairPrompt).toContain("failed SWARM's validation");
		expect(repairPrompt).toContain('Invalid hand-off review_handoff.json');
		expect(repairPrompt).toContain('this is a formatting repair, not a re-review');
		// It continues the review's own session, so the repair still has the diff in
		// context rather than re-deriving it.
		expect(runAgent.mock.calls[1][0].resumeSessionId).toBe('session-1');
		expect(submitReview).toHaveBeenCalledOnce();
	});

	it('fails with the original complaint when the repair pass does not fix it', async () => {
		const { submitReview, options } = deliveryDeps(structuredHandoff({ verdict: 'nonsense' }));

		await expect(runReviewPhase(options)).rejects.toThrow(/Invalid hand-off/);
		expect(options.runAgent).toHaveBeenCalledTimes(2);
		expect(submitReview).not.toHaveBeenCalled();
	});

	// Issue #865. Only `claude` is ever handed the id SWARM assigned (`--session-id`);
	// codex and agy mint their own, so `codex exec resume <swarm-id>` addresses a
	// thread that never existed and exits 1 in ~200 ms without reaching the model.
	describe('the id the repair pass resumes (issue #865)', () => {
		it('resumes the id the run reported, not the one SWARM assigned', async () => {
			const { options } = deliveryDeps(
				[structuredHandoff({ verdict: 'nonsense' }), structuredHandoff()],
				{ cli: 'codex', sessionId: '27b0dc2e-2509-4644-b2db-3d2b6c863fab' },
				{ cli: 'codex', sessionId: 'thread-9' },
			);

			await runReviewPhase(options);

			const runAgent = options.runAgent as ReturnType<typeof vi.fn>;
			expect(runAgent.mock.calls[1][0].resumeSessionId).toBe('thread-9');
		});

		it('resumes nothing on a self-minting CLI whose run reported no id', async () => {
			const { submitReview, options } = deliveryDeps(
				[structuredHandoff({ verdict: 'nonsense' }), structuredHandoff()],
				{ cli: 'codex', sessionId: '27b0dc2e-2509-4644-b2db-3d2b6c863fab' },
				{ cli: 'codex', sessionId: undefined },
			);

			await runReviewPhase(options);

			const runAgent = options.runAgent as ReturnType<typeof vi.fn>;
			// The pass still runs — the hand-off and the checkout its evidence came from
			// are both on disk — it just starts a fresh session instead of addressing
			// the run id, which is what died on PR #860.
			expect(runAgent).toHaveBeenCalledTimes(2);
			expect(runAgent.mock.calls[1][0].resumeSessionId).toBeUndefined();
			expect(submitReview).toHaveBeenCalledOnce();
		});

		it('still offers claude the assigned id when its run reported none', async () => {
			const { options } = deliveryDeps(
				[structuredHandoff({ verdict: 'nonsense' }), structuredHandoff()],
				{ cli: 'claude', sessionId: 'assigned-1' },
				{ cli: 'claude', sessionId: undefined },
			);

			await runReviewPhase(options);

			const runAgent = options.runAgent as ReturnType<typeof vi.fn>;
			expect(runAgent.mock.calls[1][0].resumeSessionId).toBe('assigned-1');
		});
	});

	// The two failures used to settle as the same string in `runs.error`, so an
	// operator could not tell a repair that never reached the model from one whose
	// model re-read the contract and still got the shape wrong (issue #865).
	describe('what the failure says the repair pass did (issue #865)', () => {
		it('says the pass never ran when the repair run exited non-zero', async () => {
			const { options } = deliveryDeps(
				structuredHandoff({ verdict: 'nonsense' }),
				{ cli: 'codex' },
				[{ cli: 'codex' }, { cli: 'codex', exitCode: 1, durationMs: 200 }],
			);

			const error = await runReviewPhase(options).catch((err: unknown) => err);

			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			// The original defect stays the head — it is what an operator reads first.
			expect(message).toMatch(/Invalid hand-off/);
			expect(message).toMatch(/the repair pass never ran/);
			expect(message).toContain('the codex repair run exited 1 after 200 ms');
		});

		it('says the pass ran and failed when the repair run exited zero', async () => {
			const { options } = deliveryDeps(structuredHandoff({ verdict: 'nonsense' }));

			const error = await runReviewPhase(options).catch((err: unknown) => err);

			const message = (error as Error).message;
			expect(message).toMatch(/Invalid hand-off/);
			expect(message).toMatch(/re-asked the agent in the review's own session/);
			expect(message).not.toMatch(/never ran/);
		});

		it('carries the original validation error on `cause`', async () => {
			const { options } = deliveryDeps(structuredHandoff({ verdict: 'nonsense' }));

			const error = await runReviewPhase(options).catch((err: unknown) => err);

			const cause = (error as Error).cause;
			expect(cause).toBeInstanceOf(Error);
			expect((cause as Error).message).toMatch(/Invalid hand-off/);
		});
	});

	// The body must not promise a follow-up that a disabled Respond-to-review will
	// never run, whatever `skipOnMinors` says.
	it('states that nothing will act on minors when Respond-to-review is off', async () => {
		const { submitReview, options } = deliveryDeps(
			structuredHandoff({
				findings: [
					{
						id: 'F1',
						title: 'naming',
						severity: 'nit',
						category: 'consistency',
						evidence: '`webhook.ts:337`.',
						suggestion: 'Rename for symmetry.',
					},
				],
			}),
			{
				project: createMockProjectConfig({
					pipeline: { respondToReview: { enabled: false, skipOnMinors: false } },
				}),
			},
		);

		await runReviewPhase(options);

		expect(submitReview.mock.calls[0][0].body).toContain('**no agent will act on them**');
	});

	// A worktree preserved by a half-failed submission may hold an older agent's
	// hand-off; without this fallback the retry would fail validation forever
	// instead of finishing the submission it had already started.
	it('accepts the legacy shape when resuming a delivery, posting its body verbatim', async () => {
		const legacy = { verdict: 'approve', body: 'Looks good', findings: [] };
		const { path, submitReview, options } = deliveryDeps(legacy);
		// Seed the delivery progress a half-failed submission would have left behind.
		writeFileSync(join(path, 'review_handoff.json'), JSON.stringify(legacy));

		await runReviewPhase({ ...options, resumeDelivery: true });

		expect(submitReview.mock.calls[0][0].body).toBe('Looks good');
	});

	it('refuses a resumed legacy hand-off carrying the removed comment verdict', async () => {
		const legacy = { verdict: 'comment', body: 'Some notes', findings: [] };
		const { path, options } = deliveryDeps(legacy);
		writeFileSync(join(path, 'review_handoff.json'), JSON.stringify(legacy));

		await expect(runReviewPhase({ ...options, resumeDelivery: true })).rejects.toThrow(
			/removed 'comment' verdict/,
		);
	});
});

/**
 * Two repositories of one project, one PR number (issue #685).
 *
 * The Review phase keys two things that must name the repository it ran in: the
 * delivery identity its progress sidecar is written under — a resume key, so a
 * project-wide one would let a preserved worktree in repository B adopt repository
 * A's half-finished submission — and its `review_verdicts` rows, whose cap would
 * otherwise be shared by two unrelated PRs that happen to carry the same number.
 */
describe('review delivery across two repositories of one project (issue #685)', () => {
	const [ANDROID, BACKEND] = createMockProjectRepositoryPair();

	it('keys the delivery sidecar and the verdict ledger on the repository it ran in', async () => {
		// Both runs keep `deliveryDeps`' own PR number and head SHA, so the repository
		// is the only thing that differs between them.
		const markAndroid = vi.fn(async () => ({ id: 'verdict-a', ordinal: 1 }));
		const markBackend = vi.fn(async () => ({ id: 'verdict-b', ordinal: 1 }));
		const android = deliveryDeps(structuredHandoff(), {
			project: ANDROID,
			repository: ANDROID.repo,
			markReviewVerdictSubmitted: markAndroid,
		});
		const backend = deliveryDeps(structuredHandoff(), {
			project: BACKEND,
			repository: BACKEND.repo,
			markReviewVerdictSubmitted: markBackend,
		});

		await runReviewPhase(android.options);
		await runReviewPhase(backend.options);

		expect(readDeliveryId(backend.path)).not.toBe(readDeliveryId(android.path));

		// The ledger key comes from `RunReviewPhaseOptions.repository` (issue #692),
		// the delivery identity from `project.repo`. Asserting both here is what pins
		// the invariant issue #699 relies on: the two are resolved from the job's own
		// repository, so they agree by construction rather than by coincidence.
		expect(markAndroid).toHaveBeenCalledWith(
			{ projectId: 'acme', repository: 'acme/android', prNumber: '42', headSha: 'abc1234' },
			expect.anything(),
		);
		expect(markBackend).toHaveBeenCalledWith(
			{ projectId: 'acme', repository: 'acme/backend', prNumber: '42', headSha: 'abc1234' },
			expect.anything(),
		);
	});
});

describe('review production delivery', () => {
	it('preserves progress after a step failure and resumes before the agent without duplicating delivery', async () => {
		const path = mkdtempSync(join(tmpdir(), 'swarm-review-delivery-'));
		roots.push(path);
		const handle: WorktreeHandle = { taskId: 'review-42', path, branch: 'abc', detached: true };
		const cleanup = vi.fn(async () => undefined);
		const worktrees = {
			provision: vi.fn(async () => handle),
			worktreePath: vi.fn(() => handle.path),
			reuse: vi.fn(async () => handle),
			cleanup,
		} as unknown as GitWorktreeManager;
		const runAgent = vi.fn(async () => {
			writeFileSync(
				join(path, 'review_handoff.json'),
				JSON.stringify({
					verdict: 'approve',
					summary: 'Adds a normalization helper.',
					verification: [{ command: 'npx vitest run tests/unit', outcome: 'passed' }],
					docsChecked: [{ path: 'README.md', status: 'not-applicable' }],
					findings: [],
				}),
			);
			return agentResult();
		});
		const submitReview = vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValue(77);
		const delivery = {
			commitIdentity: { name: 'reviewer', email: 'reviewer@users.noreply.github.com' },
			findPullRequest: vi.fn(),
			createPullRequest: vi.fn(),
			pushBranch: vi.fn(),
			submitReview,
			postComment: vi.fn(),
		} as unknown as ScmDeliveryProvider;
		const markReviewVerdictSubmitted = vi.fn(async () => ({ id: 'verdict-1', ordinal: 1 }));
		const abandonReviewVerdict = vi.fn(async () => undefined);
		// No prior submitted review → the first attempt runs as an initial review
		// (issue #328); stubbed so the phase never touches a real database here.
		const getPriorSubmittedReview = vi.fn(async () => undefined);
		const options = {
			project: createMockProjectConfig(),
			repository: 'SmartTechBrewery/run-repo',
			prNumber: '42',
			headSha: 'abc',
			taskId: 'review-42',
			worktrees,
			runAgent,
			graft: vi.fn(() => []),
			getToken: vi.fn(async () => 'review-token'),
			delivery,
			markReviewVerdictSubmitted,
			abandonReviewVerdict,
			getPriorSubmittedReview,
		};

		await expect(runReviewPhase(options)).rejects.toBeInstanceOf(DeliveryDeferredError);
		expect(cleanup).not.toHaveBeenCalled();
		expect(runAgent).toHaveBeenCalledTimes(1);
		// The failure happened after delivery progress existed (an ambiguous
		// mid-submission failure), so the reservation is preserved, not abandoned
		// (issue #235).
		expect(abandonReviewVerdict).not.toHaveBeenCalled();

		await expect(runReviewPhase({ ...options, resumeDelivery: true })).resolves.toMatchObject({
			verdict: 'approve',
			reviewOrdinal: 1,
		});
		expect(runAgent).toHaveBeenCalledTimes(1);
		expect(worktrees.reuse).toHaveBeenCalledWith('review-42', 'abc', true, expect.any(Function));
		expect(worktrees.provision).toHaveBeenCalledTimes(1);
		expect(submitReview).toHaveBeenCalledTimes(2);
		expect(cleanup).toHaveBeenCalledTimes(1);
		// Marked submitted exactly once, on the successful (resumed) attempt, with
		// the recovered review id.
		expect(markReviewVerdictSubmitted).toHaveBeenCalledTimes(1);
		expect(markReviewVerdictSubmitted).toHaveBeenCalledWith(
			{
				projectId: options.project.id,
				// The repository the run recorded, not the project's (issue #692).
				repository: options.repository,
				prNumber: '42',
				headSha: 'abc',
			},
			{ verdict: 'approve', reviewId: '77' },
		);
	});
});
