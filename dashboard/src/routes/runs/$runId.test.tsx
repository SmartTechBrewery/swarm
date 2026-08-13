// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRow } from '@/types/runs.js';

// The route module builds a real tRPC client at import time; the reset- and
// force-re-review-button tests below drive its mutations, so the whole module is
// stubbed here. Every other test in this file renders a pure callout that never
// touches it.
vi.mock('@/lib/trpc.js', () => ({
	trpcClient: {
		runs: {
			reset: { mutate: vi.fn() },
			forceReReview: { mutate: vi.fn() },
			retryNow: { mutate: vi.fn() },
			terminate: { mutate: vi.fn() },
		},
	},
	trpc: {
		runs: {
			getById: { queryKey: () => ['runs.getById'] },
			list: { queryKey: () => ['runs.list'] },
		},
	},
}));
vi.mock('@tanstack/react-router', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@tanstack/react-router')>();
	return {
		...actual,
		// biome-ignore lint/suspicious/noExplicitAny: simple test stub for Link
		Link: ({ children, to, className }: any) => (
			<a href={to} className={className}>
				{children}
			</a>
		),
	};
});

import { trpcClient } from '@/lib/trpc.js';
import {
	CheckpointedCallout,
	CheckpointPanel,
	FailureDiagnosisCallout,
	ForceReReviewButton,
	GitHubReferences,
	PreservedWorkerCallout,
	RecoverRunButton,
	RecoveryCallout,
	ResetRunButton,
	ReviewCapCallout,
	ReviewMergeCallout,
	RunAttributionFields,
	RunDetailHeader,
} from './$runId.js';

function makeReviewRun(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: 'run-1',
		projectId: 'project-1',
		repository: 'acme/demo',
		taskId: 'task-1',
		workItemId: null,
		workItemTitle: null,
		workItemUrl: null,
		prNumber: '42',
		prTitle: 'Some PR',
		producedPrUrl: null,
		phase: 'review',
		workerId: null,
		workerUserId: null,
		engine: 'claude',
		model: 'sonnet',
		reasoning: null,
		status: 'completed',
		reviewVerdict: 'request-changes',
		reviewOrdinal: 2,
		reviewAutomationOutcome: 'manual-intervention-required',
		reviewMergeOutcome: null,
		reviewMergeMessage: null,
		exitCode: 0,
		timedOut: false,
		error: null,
		startedAt: '2026-01-01T00:00:00.000Z',
		completedAt: '2026-01-01T00:05:00.000Z',
		nextRetryAt: null,
		durationMs: 1000,
		usage: null,
		jobPayload: null,
		agentSessionId: null,
		failureDiagnosis: null,
		...overrides,
	};
}

describe('FailureDiagnosisCallout (issue #269)', () => {
	it('shows the confidence label, diagnosis, and recovery guidance', () => {
		render(
			<FailureDiagnosisCallout
				diagnosis={{
					kind: 'likely-scope-exceeded',
					title: 'Likely scope exceeded',
					message:
						'The agent stalled after substantial progress. This task likely exceeds the single-task scope; narrow or split it before retrying.',
					recovery: 'Narrow or split the task before retrying.',
				}}
			/>,
		);

		expect(screen.getByRole('heading', { name: 'Likely scope exceeded' })).toBeDefined();
		expect(screen.getByText(/stalled after substantial progress/i)).toBeDefined();
		expect(screen.getByText(/recommended recovery/i)).toBeDefined();
	});

	it('renders nothing for an existing run without a diagnosis', () => {
		const { container } = render(<FailureDiagnosisCallout diagnosis={null} />);

		expect(container.firstChild).toBeNull();
	});
});

describe('ReviewCapCallout (issue #242)', () => {
	// The callout hosts the "Force re-review" action (issue #511), which owns a
	// mutation — so a capped callout needs the query client the app provides.
	// The `renders nothing` cases below return before that and stay provider-free.
	function renderCapCallout(
		run: RunRow = makeReviewRun(),
		project: {
			pipeline?: { respondToReview?: { enabled?: boolean } };
		} | null = {},
	) {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		return render(
			<QueryClientProvider client={queryClient}>
				<ReviewCapCallout run={run} project={project} />
			</QueryClientProvider>,
		);
	}

	it('explains the cap-stopping final verdict and cites its ordinal', () => {
		renderCapCallout();

		expect(screen.getByRole('heading', { name: 'Manual action required' })).toBeDefined();
		expect(screen.getByText(/last changes-requested verdict/i)).toBeDefined();
		expect(screen.getByText(/review 2 of this PR/i)).toBeDefined();
		expect(screen.getByText(/will not automatically enqueue another/i)).toBeDefined();
	});

	it('exposes the Force re-review action from the capped callout (issue #511)', () => {
		renderCapCallout();

		expect(screen.getByRole('button', { name: /force re-review/i })).toBeDefined();
	});

	it('withholds Force re-review when Respond-to-review is disabled', () => {
		renderCapCallout(makeReviewRun(), {
			pipeline: { respondToReview: { enabled: false } },
		});

		expect(screen.getByRole('heading', { name: 'Manual action required' })).toBeDefined();
		expect(screen.queryByRole('button', { name: /force re-review/i })).toBeNull();
	});

	it("links to the PR in the run's own repository (issue #691)", () => {
		// No project at all: the link is built from the run, so the project lookup the
		// pre-#691 code needed for it is beside the point.
		renderCapCallout(makeReviewRun({ repository: 'acme/api' }), null);

		const link = screen.getByRole('link', { name: /view pr #42/i }) as HTMLAnchorElement;
		expect(link.href).toBe('https://github.com/acme/api/pull/42');
	});

	it('omits the PR link when the run recorded no repository', () => {
		renderCapCallout(makeReviewRun({ repository: '' }));

		expect(screen.getByRole('heading', { name: 'Manual action required' })).toBeDefined();
		expect(screen.queryByRole('link', { name: /view pr/i })).toBeNull();
	});

	it('renders nothing for an ordinary first changes-requested verdict', () => {
		const { container } = render(
			<ReviewCapCallout run={makeReviewRun({ reviewOrdinal: 1, reviewAutomationOutcome: null })} />,
		);

		expect(container.firstChild).toBeNull();
	});

	it('renders nothing for an approval verdict even with the outcome field set', () => {
		const { container } = render(
			<ReviewCapCallout run={makeReviewRun({ reviewVerdict: 'approve' })} />,
		);

		expect(container.firstChild).toBeNull();
	});

	it('renders nothing for a non-Review phase', () => {
		const { container } = render(
			<ReviewCapCallout run={makeReviewRun({ phase: 'respond-to-review' })} />,
		);

		expect(container.firstChild).toBeNull();
	});

	it('renders nothing for a run still in progress', () => {
		const { container } = render(<ReviewCapCallout run={makeReviewRun({ status: 'running' })} />);

		expect(container.firstChild).toBeNull();
	});
});

function makeRecoveryRun(recovery: RunRow['recovery'], overrides: Partial<RunRow> = {}): RunRow {
	return makeReviewRun({
		status: 'failed',
		phase: 'implementation',
		reviewVerdict: null,
		reviewOrdinal: null,
		reviewAutomationOutcome: null,
		error: 'Worktree for task 1 is protected.',
		completedAt: '2026-01-01T00:05:00.000Z',
		recovery,
		...overrides,
	});
}

// The preserved-checkout pin's operator surface (issue #567). A pinned run waits
// with no timeout, so this callout is the only thing separating "waiting for
// m3_pro_tp" from "wedged" — its presence on the page is the thing worth pinning.
describe('PreservedWorkerCallout (issue #567)', () => {
	const pinned = (
		overrides: Partial<NonNullable<RunRow['preservedWorker']>> = {},
	): Partial<RunRow> => ({
		preservedWorker: {
			state: 'preserved',
			workerId: 'w-1',
			workerName: 'm3_pro_tp',
			waiting: true,
			...overrides,
		},
	});

	it('renders nothing for a run with no recorded machine', () => {
		const { container } = render(<PreservedWorkerCallout run={makeReviewRun()} />);
		expect(container.firstChild).toBeNull();
	});

	it('names the machine, the unbounded wait, and the way out while it is waiting', () => {
		render(<PreservedWorkerCallout run={makeReviewRun({ status: 'checkpointed', ...pinned() })} />);

		expect(screen.getByRole('heading', { name: /waiting for m3_pro_tp/i })).toBeDefined();
		expect(screen.getByText(/does not time out/i)).toBeDefined();
		expect(screen.getByText(/reset & restart/i)).toBeDefined();
	});

	it('states the machine without promising an unbounded wait when the pin is not what blocks it', () => {
		render(
			<PreservedWorkerCallout
				run={makeReviewRun({ status: 'deferred', ...pinned({ waiting: false }) })}
			/>,
		);

		expect(screen.getByRole('heading', { name: /preserved on m3_pro_tp/i })).toBeDefined();
		expect(screen.queryByText(/does not time out/i)).toBeNull();
	});

	it('reports after the fact that a restart discarded the preserved work', () => {
		render(
			<PreservedWorkerCallout
				run={makeReviewRun({
					status: 'running',
					...pinned({ state: 'abandoned', waiting: false }),
				})}
			/>,
		);

		expect(screen.getByRole('heading', { name: /preserved work was discarded/i })).toBeDefined();
		expect(screen.getByText(/m3_pro_tp/)).toBeDefined();
	});

	it('is wired into the run detail header, not just exported', () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={queryClient}>
				<RunDetailHeader
					run={makeReviewRun({ status: 'checkpointed', phase: 'implementation', ...pinned() })}
					project={null}
				/>
			</QueryClientProvider>,
		);

		expect(screen.getByRole('heading', { name: /waiting for m3_pro_tp/i })).toBeDefined();
	});
});

describe('RecoveryCallout (issue #368)', () => {
	it('renders nothing for an unrelated run with no recovery record', () => {
		const { container } = render(<RecoveryCallout run={makeReviewRun()} />);
		expect(container.firstChild).toBeNull();
	});

	it('shows the preserved state for a resumable run', () => {
		render(<RecoveryCallout run={makeRecoveryRun({ state: 'preserved' })} />);
		expect(screen.getByRole('heading', { name: /worktree preserved/i })).toBeDefined();
	});

	it('shows the recovered state', () => {
		render(<RecoveryCallout run={makeRecoveryRun({ state: 'recovered' })} />);
		expect(screen.getByRole('heading', { name: /successfully recovered/i })).toBeDefined();
	});

	it.each([
		['dirty', /uncommitted changes/i, /commit, stash, or discard/i],
		['unpushed', /never pushed/i, /push or discard those commits/i],
		['live-leased', /leased by another active run/i, /wait for that run to finish/i],
		[
			'resumable-owner',
			/pinned by another resumable run/i,
			/resume, finish, or deliberately terminate/i,
		],
		['missing-validation', /saved agent session is gone/i, /provision a fresh checkout/i],
		// Issue #502's continuation block: unlike the reasons above, no tidying of the
		// checkout restores the hand-off it no longer matches.
		[
			'checkpoint-divergent',
			/no longer describes the checkout/i,
			/start this phase over from a fresh checkout/i,
		],
	] as const)('explains the %s blocked reason and offers Recheck and retry', (blockedReason, conditionPattern, resolutionPattern) => {
		render(<RecoveryCallout run={makeRecoveryRun({ state: 'blocked', blockedReason })} />);

		expect(screen.getByRole('heading', { name: /recovery blocked/i })).toBeDefined();
		expect(screen.getByText(conditionPattern)).toBeDefined();
		expect(screen.getByText(resolutionPattern)).toBeDefined();
		expect(screen.getByText(/recheck and retry/i)).toBeDefined();
	});

	it('falls back to generic guidance for an unknown blocked reason', () => {
		render(
			<RecoveryCallout
				run={makeRecoveryRun({
					state: 'blocked',
					// A reason the union doesn't yet name must still render actionable guidance.
					blockedReason: 'something-new' as unknown as 'dirty',
				})}
			/>,
		);

		expect(screen.getByRole('heading', { name: /recovery blocked/i })).toBeDefined();
		expect(screen.getByText(/failed a safety check/i)).toBeDefined();
		expect(screen.getByText(/recheck and retry/i)).toBeDefined();
	});
});

// The Tier 2 checkpoint surface (issues #503, #504).
const CHECKPOINT: NonNullable<RunRow['checkpoint']> = {
	phase: 'implementation',
	completed: ['Added the schema field and its focused tests.'],
	remaining: ['Update the configuration table.', 'Run lint and the focused tests.'],
	decisions: ['Storage migration is out of scope.'],
	workingTree: {
		modified: ['src/config/schema.ts'],
		added: ['tests/unit/config/new.test.ts'],
		deleted: ['src/config/legacy.ts'],
	},
};

function makeCheckpointedRun(overrides: Partial<RunRow> = {}): RunRow {
	return makeReviewRun({
		status: 'checkpointed',
		phase: 'implementation',
		reviewVerdict: null,
		reviewOrdinal: null,
		reviewAutomationOutcome: null,
		error: 'Agent stopped: rate limit reached.',
		// A checkpointed row carries no session id by construction.
		agentSessionId: null,
		nextRetryAt: '2026-01-01T01:00:00.000Z',
		checkpoint: CHECKPOINT,
		continuationCount: 1,
		maxContinuations: 2,
		...overrides,
	});
}

describe('CheckpointPanel (issue #504)', () => {
	it('renders nothing for a run that never handed off', () => {
		const { container } = render(<CheckpointPanel run={makeReviewRun()} />);
		expect(container.firstChild).toBeNull();
	});

	it('shows the remaining work, completed steps, decisions, and recorded working tree', () => {
		render(<CheckpointPanel run={makeCheckpointedRun()} />);

		expect(screen.getByRole('heading', { name: /checkpoint hand-off/i })).toBeDefined();
		expect(screen.getByText('Update the configuration table.')).toBeDefined();
		expect(screen.getByText('Run lint and the focused tests.')).toBeDefined();
		expect(screen.getByText('Added the schema field and its focused tests.')).toBeDefined();
		expect(screen.getByText('Storage migration is out of scope.')).toBeDefined();
		expect(screen.getByText('src/config/schema.ts')).toBeDefined();
		expect(screen.getByText('tests/unit/config/new.test.ts')).toBeDefined();
		expect(screen.getByText('src/config/legacy.ts')).toBeDefined();
	});

	it('numbers the remaining work, because its order is the order a continuation works in', () => {
		const { container } = render(<CheckpointPanel run={makeCheckpointedRun()} />);
		const ordered = container.querySelector('ol');
		expect(ordered?.querySelectorAll('li')).toHaveLength(CHECKPOINT.remaining.length);
	});

	it("reads the spent continuation count against the project's configured ceiling", () => {
		render(<CheckpointPanel run={makeCheckpointedRun()} />);
		expect(screen.getByText('Continuation 1 of 2')).toBeDefined();
	});

	it('reports the count alone when the server could not resolve a ceiling', () => {
		render(<CheckpointPanel run={makeCheckpointedRun({ maxContinuations: null })} />);
		expect(screen.getByText('Continuation 1')).toBeDefined();
	});

	it('omits empty checkpoint groups rather than rendering an empty label', () => {
		render(
			<CheckpointPanel
				run={makeCheckpointedRun({
					checkpoint: {
						...CHECKPOINT,
						decisions: [],
						workingTree: { ...CHECKPOINT.workingTree, added: [], deleted: [] },
					},
				})}
			/>,
		);

		expect(screen.queryByText(/decisions carried over/i)).toBeNull();
		expect(screen.queryByText('Added')).toBeNull();
		expect(screen.queryByText('Deleted')).toBeNull();
		expect(screen.getByText('Modified')).toBeDefined();
	});

	it('still renders for a retried continuation, whose checkpoint records what it was seeded from', () => {
		// The column survives an ordinary retry, so a `running` continuation shows the
		// hand-off it is working through.
		render(<CheckpointPanel run={makeCheckpointedRun({ status: 'running' })} />);
		expect(screen.getByRole('heading', { name: /checkpoint hand-off/i })).toBeDefined();
	});
});

describe('RunDetailHeader for a checkpointed run (issue #504)', () => {
	function renderHeader(run: RunRow = makeCheckpointedRun()) {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		return render(
			<QueryClientProvider client={queryClient}>
				<RunDetailHeader run={run} />
			</QueryClientProvider>,
		);
	}

	it('explains it waits on a continuation rather than on quota', () => {
		renderHeader();

		const heading = screen.getByRole('heading', { name: /checkpointed — continuation scheduled/i });
		expect(heading.classList.contains('text-sky-200')).toBe(true);
		expect(screen.getByText(/not waiting on quota/i).classList.contains('text-sky-200/70')).toBe(
			true,
		);
		const callout = heading.parentElement?.parentElement;
		expect(callout?.classList.contains('bg-sky-950/20')).toBe(true);
		expect(callout?.classList.contains('border-sky-900/30')).toBe(true);
		// The badge next to the title states the same status.
		expect(screen.getByText('Checkpointed')).toBeDefined();
		// Never the amber deferred callout, which would claim a scheduled *retry*.
		expect(screen.queryByRole('heading', { name: /deferred/i })).toBeNull();
	});

	it('offers Continue now, Terminate, and Reset & restart', () => {
		renderHeader();

		expect(screen.getByRole('button', { name: /continue now/i })).toBeDefined();
		expect(screen.getByRole('button', { name: /^terminate$/i })).toBeDefined();
		expect(screen.getByRole('button', { name: /reset & restart/i })).toBeDefined();
		// A continuation is never labelled as a session resume.
		expect(screen.queryByRole('button', { name: /^resume$/i })).toBeNull();
	});

	it('fires runs.retryNow with no overrides when Continue now is clicked', async () => {
		const retryMutate = vi.mocked(trpcClient.runs.retryNow.mutate);
		retryMutate.mockReset();
		retryMutate.mockResolvedValue({ runId: 'run-1', status: 'retrying' });
		renderHeader();

		fireEvent.click(screen.getByRole('button', { name: /continue now/i }));

		// The server picks `recoveryMode: 'checkpoint'` off the row's status, so the
		// continuation is the *unchanged* retry mutation with no overrides.
		await waitFor(() => {
			expect(retryMutate).toHaveBeenCalledWith({
				runId: 'run-1',
				cli: undefined,
				model: undefined,
				reasoning: undefined,
			});
		});
	});

	it('warns in the terminate confirmation that the recorded remainder is abandoned', () => {
		renderHeader();

		fireEvent.click(screen.getByRole('button', { name: /^terminate$/i }));

		expect(screen.getByRole('heading', { name: /terminate run\?/i })).toBeDefined();
		expect(screen.getByText(/scheduled continuation/i)).toBeDefined();
	});

	it('renders the checkpoint panel alongside the callout', () => {
		renderHeader();
		expect(screen.getByRole('heading', { name: /checkpoint hand-off/i })).toBeDefined();
		expect(screen.getByText('Update the configuration table.')).toBeDefined();
	});

	it('is directly renderable as its own checkpoint-specific component', () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={queryClient}>
				<CheckpointedCallout run={makeCheckpointedRun()} onResetSuccess={vi.fn()} />
			</QueryClientProvider>,
		);

		expect(
			screen.getByRole('heading', { name: /checkpointed — continuation scheduled/i }),
		).toBeDefined();
	});
});

describe('ReviewMergeCallout (issue #278)', () => {
	it('renders nothing when no merge automation ran', () => {
		const { container } = render(
			<ReviewMergeCallout run={makeReviewRun({ reviewMergeOutcome: null })} />,
		);

		expect(container.firstChild).toBeNull();
	});

	it('renders nothing for a non-Review phase even with an outcome set', () => {
		const { container } = render(
			<ReviewMergeCallout
				run={makeReviewRun({ phase: 'respond-to-review', reviewMergeOutcome: 'merged' })}
			/>,
		);

		expect(container.firstChild).toBeNull();
	});

	it('shows a merged callout with the PR link', () => {
		render(
			<ReviewMergeCallout
				run={makeReviewRun({
					reviewMergeOutcome: 'merged',
					reviewMergeMessage: 'Pull Request successfully merged',
				})}
			/>,
		);

		expect(screen.getByRole('heading', { name: 'Merged automatically' })).toBeDefined();
		expect(screen.getByText('Pull Request successfully merged')).toBeDefined();
		const link = screen.getByRole('link', { name: /view pr #42/i }) as HTMLAnchorElement;
		expect(link.href).toBe('https://github.com/acme/demo/pull/42');
	});

	it('shows a waiting callout for a not-ready outcome', () => {
		render(
			<ReviewMergeCallout
				run={makeReviewRun({
					reviewMergeOutcome: 'not-ready',
					reviewMergeMessage: 'required checks are still pending',
				})}
			/>,
		);

		expect(
			screen.getByRole('heading', { name: /waiting — retrying automatically/i }),
		).toBeDefined();
		expect(screen.getByText('required checks are still pending')).toBeDefined();
	});

	it.each([
		['not-eligible', 'No longer eligible for automatic merge'],
		['policy-blocked', 'Blocked by repository policy'],
		['unsupported', 'Merge automation unsupported'],
		['provider-error', 'Merge automation hit a provider error'],
		['retry-exhausted', 'Automatic merge retry budget exhausted'],
	])('shows a terminal callout for %s', (outcome, heading) => {
		render(
			<ReviewMergeCallout
				run={makeReviewRun({ reviewMergeOutcome: outcome, reviewMergeMessage: 'details here' })}
			/>,
		);

		expect(screen.getByRole('heading', { name: heading })).toBeDefined();
		expect(screen.getByText('details here')).toBeDefined();
	});
});

describe('RunAttributionFields (issue #446)', () => {
	it('names the worker and its owning SWARM user', () => {
		render(
			<RunAttributionFields
				run={makeReviewRun({
					workerId: 'worker-1',
					workerUserId: 'user-1',
					attribution: {
						workerId: 'worker-1',
						workerName: 'alice-macbook',
						userId: 'user-1',
						userDisplayName: 'Alice Example',
					},
				})}
			/>,
		);

		expect(screen.getByText('Worker')).toBeDefined();
		expect(screen.getByText('alice-macbook')).toBeDefined();
		expect(screen.getByText('Worker owner')).toBeDefined();
		expect(screen.getByText('Alice Example')).toBeDefined();
		// Neither id is exposed once both names resolve.
		expect(screen.queryByText('worker-1')).toBeNull();
		expect(screen.queryByText('user-1')).toBeNull();
	});

	it('renders the neutral dash — never an id — for a run with no recorded worker', () => {
		render(<RunAttributionFields run={makeReviewRun({ attribution: null })} />);

		expect(screen.getAllByText('—')).toHaveLength(2);
	});

	it('renders the neutral dash for a pre-existing row that carries no attribution field', () => {
		render(<RunAttributionFields run={makeReviewRun()} />);

		expect(screen.getAllByText('—')).toHaveLength(2);
	});

	it('falls back to the recorded ids when the worker/user rows no longer resolve', () => {
		render(
			<RunAttributionFields
				run={makeReviewRun({
					workerId: 'worker-gone',
					workerUserId: 'user-gone',
					attribution: {
						workerId: 'worker-gone',
						workerName: null,
						userId: 'user-gone',
						userDisplayName: null,
					},
				})}
			/>,
		);

		expect(screen.getByText('worker-gone')).toBeDefined();
		expect(screen.getByText('user-gone')).toBeDefined();
		expect(screen.queryByText('—')).toBeNull();
	});
});

describe('GitHubReferences produced-PR link (issue #446)', () => {
	it('links the PR this run opened, labelled apart from the PR it acted on', () => {
		render(
			<GitHubReferences
				run={makeReviewRun({
					phase: 'implementation',
					prNumber: null,
					prTitle: null,
					producedPrUrl: 'https://github.com/acme/demo/pull/77',
				})}
			/>,
		);

		const link = screen.getByRole('link', { name: /pr opened by this run/i }) as HTMLAnchorElement;
		expect(link.href).toBe('https://github.com/acme/demo/pull/77');
		// A run whose only reference is the PR it produced no longer reads as empty.
		expect(screen.queryByText('—')).toBeNull();
	});

	it('distinguishes the produced PR from the PR a review run acted on', () => {
		render(
			<GitHubReferences
				run={makeReviewRun({ producedPrUrl: 'https://github.com/acme/demo/pull/77' })}
			/>,
		);

		expect(screen.getByRole('link', { name: /pr opened by this run/i })).toBeDefined();
		const actedOn = screen.getByRole('link', { name: /^PR #42$/ }) as HTMLAnchorElement;
		expect(actedOn.href).toBe('https://github.com/acme/demo/pull/42');
	});

	it('still renders the neutral dash for a run with no references at all', () => {
		const { container } = render(
			<GitHubReferences run={makeReviewRun({ prNumber: null, prTitle: null })} />,
		);

		expect(container.textContent).toBe('—');
	});
});

// issue #691 — every PR link on the run detail page resolves its repository from
// the run row. The components take no project at all anymore, so a run whose
// repository differs from the one its project would have supplied still links right.
describe("run-detail PR links follow the run's repository (issue #691)", () => {
	const onOtherRepo = makeReviewRun({
		repository: 'acme/api',
		reviewMergeOutcome: 'merged',
	});

	it('builds the GitHub References PR link from the run repository', () => {
		render(<GitHubReferences run={onOtherRepo} />);

		const link = screen.getByRole('link', { name: /^PR #42$/ }) as HTMLAnchorElement;
		expect(link.href).toBe('https://github.com/acme/api/pull/42');
	});

	it('builds the merge callout PR link from the run repository', () => {
		render(<ReviewMergeCallout run={onOtherRepo} />);

		const link = screen.getByRole('link', { name: /view pr #42/i }) as HTMLAnchorElement;
		expect(link.href).toBe('https://github.com/acme/api/pull/42');
	});

	it('leaves the PR number unlinked when the run recorded no repository', () => {
		render(<GitHubReferences run={makeReviewRun({ repository: '' })} />);

		expect(screen.queryByRole('link', { name: /^PR #42$/ })).toBeNull();
		expect(screen.getByText('PR #42')).toBeDefined();
	});
});

describe('ResetRunButton (issue #428)', () => {
	const resetMutate = vi.mocked(trpcClient.runs.reset.mutate);

	beforeEach(() => {
		resetMutate.mockReset();
	});

	function renderResetButton(run: RunRow) {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		return render(
			<QueryClientProvider client={queryClient}>
				<ResetRunButton run={run} />
			</QueryClientProvider>,
		);
	}

	/** Open the confirmation modal from the run-detail callout's button. */
	function openConfirm(run: RunRow = makeReviewRun({ status: 'failed', phase: 'implementation' })) {
		renderResetButton(run);
		fireEvent.click(screen.getByRole('button', { name: /reset & restart/i }));
	}

	function confirm() {
		const buttons = screen.getAllByRole('button', { name: /reset & restart/i });
		// The trigger renders first; the modal's confirm button is the last one.
		fireEvent.click(buttons[buttons.length - 1]);
	}

	it('resets without force until the discard opt-in is ticked', async () => {
		resetMutate.mockResolvedValue({
			runId: 'run-1',
			forced: false,
			dispatch: 'cancelled',
			cancellationCleared: true,
			worktree: { outcome: 'blocked', blockedReason: 'dirty' },
			worktreeIntent: 'reclaim',
			recoveryCleared: true,
			abandonedPreservedWorkerId: null,
			dispatchId: 'dispatch-9',
		});
		openConfirm();
		expect(screen.getByText(/are kept/i)).toBeDefined();

		confirm();

		await waitFor(() => {
			expect(resetMutate).toHaveBeenCalledWith({ runId: 'run-1', force: false });
		});
	});

	it('names the machine whose preserved work the restart abandons (issue #567)', () => {
		openConfirm(
			makeReviewRun({
				status: 'checkpointed',
				phase: 'implementation',
				preservedWorker: {
					state: 'preserved',
					workerId: 'w-1',
					workerName: 'm3_pro_tp',
					waiting: true,
				},
			}),
		);

		expect(screen.getByText(/work preserved on m3_pro_tp is abandoned/i)).toBeDefined();
		// The escape hatch is offered precisely when that machine is unreachable, so the
		// copy has to say it does not depend on it.
		expect(screen.getByText(/whether or not m3_pro_tp is currently reachable/i)).toBeDefined();
	});

	it('warns about no machine for a run whose preserved work was already discarded', () => {
		openConfirm(
			makeReviewRun({
				status: 'failed',
				phase: 'implementation',
				preservedWorker: {
					state: 'abandoned',
					workerId: 'w-1',
					workerName: 'm3_pro_tp',
					waiting: false,
				},
			}),
		);

		expect(screen.queryByText(/is abandoned/i)).toBeNull();
	});

	it('maps the discard opt-in to the force variant and warns it is unrecoverable', async () => {
		resetMutate.mockResolvedValue({
			runId: 'run-1',
			forced: true,
			dispatch: 'cancelled',
			cancellationCleared: true,
			worktree: { outcome: 'removed', discarded: 'dirty' },
			worktreeIntent: 'discard',
			recoveryCleared: true,
			abandonedPreservedWorkerId: null,
			dispatchId: 'dispatch-9',
		});
		openConfirm();

		fireEvent.click(screen.getByRole('checkbox'));
		expect(screen.getByText(/discarded permanently/i)).toBeDefined();

		confirm();

		await waitFor(() => {
			expect(resetMutate).toHaveBeenCalledWith({ runId: 'run-1', force: true });
		});
	});

	it('renders the per-step report on success', async () => {
		resetMutate.mockResolvedValue({
			runId: 'run-1',
			forced: false,
			dispatch: 'force-cancelled-claimed',
			cancellationCleared: true,
			worktree: { outcome: 'blocked', blockedReason: 'live-leased' },
			worktreeIntent: 'reclaim',
			recoveryCleared: true,
			abandonedPreservedWorkerId: null,
			dispatchId: 'dispatch-9',
		});
		openConfirm();
		confirm();

		await waitFor(() => {
			expect(screen.getByRole('heading', { name: 'Reset complete' })).toBeDefined();
		});
		expect(screen.getByText(/worker-claimed dispatch was force-cancelled/i)).toBeDefined();
		expect(
			screen.getByText(/Checkout: retained — a lease held by another live run/i),
		).toBeDefined();
		expect(screen.getByText(/dispatch dispatch-9/i)).toBeDefined();
		// The modal closed, so its confirm button is gone.
		expect(screen.queryByRole('checkbox')).toBeNull();
	});

	it("renders the server's refusal message inline", async () => {
		resetMutate.mockRejectedValue(new Error('Run "run-1" is already being restarted.'));
		openConfirm();
		confirm();

		await waitFor(() => {
			expect(screen.getByText('Run "run-1" is already being restarted.')).toBeDefined();
		});
		// A refused reset keeps the modal open so the operator can adjust and retry.
		expect(screen.getByRole('checkbox')).toBeDefined();
	});

	it('preserves the success report in RunDetailHeader post-invalidation when status transitions to running', async () => {
		resetMutate.mockResolvedValue({
			runId: 'run-1',
			forced: false,
			dispatch: 'cancelled',
			cancellationCleared: true,
			worktree: { outcome: 'removed' },
			worktreeIntent: 'reclaim',
			recoveryCleared: true,
			abandonedPreservedWorkerId: null,
			dispatchId: 'dispatch-9',
		});

		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const failedRun = makeReviewRun({
			status: 'failed',
			phase: 'implementation',
			error: 'some error',
		});

		const { rerender } = render(
			<QueryClientProvider client={queryClient}>
				<RunDetailHeader run={failedRun} />
			</QueryClientProvider>,
		);

		// A failed run reaches Reset through the unified Recover control (issue #593).
		fireEvent.click(screen.getByRole('button', { name: 'Recover' }));
		fireEvent.click(screen.getByRole('button', { name: /reset & restart/i }));
		const buttons = screen.getAllByRole('button', { name: /reset & restart/i });
		fireEvent.click(buttons[buttons.length - 1]);

		await waitFor(() => {
			expect(screen.getByRole('heading', { name: 'Reset complete' })).toBeDefined();
		});

		// Simulate background worker claiming new dispatch and updating run status to running
		const runningRun = makeReviewRun({ status: 'running', phase: 'implementation', error: null });

		rerender(
			<QueryClientProvider client={queryClient}>
				<RunDetailHeader run={runningRun} />
			</QueryClientProvider>,
		);

		// The success report should still be visible even though run status is running and ResetRunButton unmounted
		expect(screen.getByRole('heading', { name: 'Reset complete' })).toBeDefined();
		expect(screen.getByText(/dispatch dispatch-9/i)).toBeDefined();
	});
});

// An accepted Terminate / Reset request that hasn't taken effect (issue #561):
// the button must be disabled, relabelled to the wait, and explained — driven by
// the run-scoped `pendingRequest` the server resolves, not by the mutation's own
// lifetime, so it reads the same after a reload and for a second viewer.
describe('outstanding request state (issue #561)', () => {
	const terminateMutate = vi.mocked(trpcClient.runs.terminate.mutate);
	const resetMutate = vi.mocked(trpcClient.runs.reset.mutate);

	beforeEach(() => {
		terminateMutate.mockReset();
		resetMutate.mockReset();
	});

	function renderHeader(run: RunRow) {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		return render(
			<QueryClientProvider client={queryClient}>
				<RunDetailHeader run={run} />
			</QueryClientProvider>,
		);
	}

	it('disables Terminate, names the wait, and explains it for a running run', () => {
		renderHeader(
			makeReviewRun({
				status: 'running',
				phase: 'implementation',
				completedAt: null,
				pendingRequest: {
					action: 'terminate',
					requestedAt: '2026-01-01T00:02:00.000Z',
					waitUntil: '2026-01-01T00:30:00.000Z',
				},
			}),
		);

		const button = screen.getByRole('button', { name: /waiting to stop/i });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		expect(screen.queryByRole('button', { name: /^terminate$/i })).toBeNull();
		expect(screen.getByText(/takes effect once the run’s worker sees it/i)).toBeDefined();
		expect(screen.getByText(/outer bound on that wait/i)).toBeDefined();
	});

	it('does not issue a second termination while one is outstanding', () => {
		renderHeader(
			makeReviewRun({
				status: 'running',
				phase: 'implementation',
				completedAt: null,
				pendingRequest: { action: 'terminate', requestedAt: null, waitUntil: null },
			}),
		);

		fireEvent.click(screen.getByRole('button', { name: /waiting to stop/i }));

		// No confirmation modal, and nothing recorded.
		expect(screen.queryByRole('heading', { name: /terminate run\?/i })).toBeNull();
		expect(terminateMutate).not.toHaveBeenCalled();
	});

	it('a settled run shows no wait copy and the terminal status’s own actions', () => {
		const view = renderHeader(
			makeReviewRun({
				status: 'running',
				phase: 'implementation',
				completedAt: null,
				pendingRequest: { action: 'terminate', requestedAt: null, waitUntil: null },
			}),
		);

		expect(screen.getByRole('button', { name: /waiting to stop/i })).toBeDefined();

		view.rerender(
			<QueryClientProvider
				client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
			>
				<RunDetailHeader
					run={makeReviewRun({
						status: 'failed',
						phase: 'implementation',
						error: 'boom',
						pendingRequest: null,
					})}
				/>
			</QueryClientProvider>,
		);

		// A failed run's terminal action is the unified Recover control (issue #593).
		expect(screen.getByRole('button', { name: 'Recover' })).toBeDefined();
		expect(screen.queryByText(/waiting to stop/i)).toBeNull();
		expect(screen.queryByText(/takes effect once/i)).toBeNull();
	});

	it('disables Recover and explains the queued restart for a failed run', () => {
		renderHeader(
			makeReviewRun({
				status: 'failed',
				phase: 'implementation',
				error: 'boom',
				pendingRequest: {
					action: 'restart',
					requestedAt: '2026-01-01T00:03:00.000Z',
					waitUntil: null,
				},
			}),
		);

		const button = screen.getByRole('button', { name: /waiting to restart/i });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		expect(screen.queryByRole('button', { name: 'Recover' })).toBeNull();
		expect(screen.queryByRole('button', { name: /reset & restart/i })).toBeNull();
		expect(screen.getByText(/queued as a fresh dispatch/i)).toBeDefined();

		fireEvent.click(button);
		expect(screen.queryByRole('heading', { name: /reset & restart run\?/i })).toBeNull();
		expect(resetMutate).not.toHaveBeenCalled();
	});

	it('keeps Terminate live for a deferred run with an outstanding restart — the escape hatch', () => {
		// Terminating cancels the dispatch the restart is waiting on, so this is the
		// one way out of a restart nothing has claimed. Only Reset is blocked.
		renderHeader(
			makeReviewRun({
				status: 'deferred',
				phase: 'implementation',
				nextRetryAt: '2026-01-01T01:00:00.000Z',
				pendingRequest: { action: 'restart', requestedAt: null, waitUntil: null },
			}),
		);

		expect(
			(screen.getByRole('button', { name: /^terminate$/i }) as HTMLButtonElement).disabled,
		).toBe(false);
		expect(
			(screen.getByRole('button', { name: /waiting to restart/i }) as HTMLButtonElement).disabled,
		).toBe(true);
	});
});

// The unified recovery control (issue #593). An errored run used to expose Retry
// and Reset & restart as two live buttons against the same row, so both could be
// submitted while the first was unresolved; these pin the one-button layout, the
// popup's choices, and the mutual exclusion that replaces it.
describe('RecoverRunButton (issue #593)', () => {
	const retryMutate = vi.mocked(trpcClient.runs.retryNow.mutate);
	const resetMutate = vi.mocked(trpcClient.runs.reset.mutate);

	/** A mutation that never settles — pins the in-flight state for an assertion. */
	const neverSettles = () => new Promise<never>(() => {});

	const RESET_REPORT = {
		runId: 'run-1',
		forced: false,
		dispatch: 'cancelled' as const,
		cancellationCleared: true,
		worktree: { outcome: 'removed' as const },
		worktreeIntent: 'reclaim' as const,
		recoveryCleared: true,
		abandonedPreservedWorkerId: null,
		dispatchId: 'dispatch-9',
	};

	beforeEach(() => {
		retryMutate.mockReset();
		resetMutate.mockReset();
	});

	function failedRun(overrides: Partial<RunRow> = {}): RunRow {
		return makeReviewRun({
			status: 'failed',
			phase: 'implementation',
			reviewVerdict: null,
			reviewOrdinal: null,
			reviewAutomationOutcome: null,
			error: 'boom',
			...overrides,
		});
	}

	function renderRecover(run: RunRow = failedRun()) {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		return render(
			<QueryClientProvider client={queryClient}>
				<RecoverRunButton run={run} />
			</QueryClientProvider>,
		);
	}

	function renderHeader(run: RunRow) {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		return render(
			<QueryClientProvider client={queryClient}>
				<RunDetailHeader run={run} />
			</QueryClientProvider>,
		);
	}

	/** Render, then open the recovery popup from the single trigger. */
	function openRecover(run?: RunRow) {
		renderRecover(run);
		fireEvent.click(screen.getByRole('button', { name: 'Recover' }));
	}

	it('renders one Recover button on a failed run, not the separate recovery actions', () => {
		renderHeader(failedRun());

		expect(screen.getAllByRole('button', { name: 'Recover' })).toHaveLength(1);
		expect(screen.queryByRole('button', { name: /retry now/i })).toBeNull();
		expect(screen.queryByRole('button', { name: /reset & restart/i })).toBeNull();
		expect(screen.queryByRole('button', { name: /^resume$/i })).toBeNull();
		expect(screen.queryByRole('button', { name: /recheck and retry/i })).toBeNull();
	});

	it('opens a popup carrying the eligible recovery actions and the override fields', () => {
		openRecover();

		expect(screen.getByRole('button', { name: /retry now/i })).toBeDefined();
		expect(screen.getByRole('button', { name: /reset & restart/i })).toBeDefined();
		expect(screen.getByLabelText('Agent CLI')).toBeDefined();
		expect(screen.getByLabelText('Model')).toBeDefined();
		expect(screen.getByLabelText('Reasoning')).toBeDefined();
		// The override submit never collides with the plain retry choice beside it.
		expect(screen.getByRole('button', { name: /retry with these settings/i })).toBeDefined();
	});

	it.each([
		['preserved', /^resume$/i],
		['blocked', /recheck and retry/i],
	] as const)('names the %s run’s retry choice by its server semantics', (state, label) => {
		openRecover(failedRun({ recovery: { state } }));

		expect(screen.getByRole('button', { name: label })).toBeDefined();
	});

	it('closes the popup and submits only the chosen retry', async () => {
		retryMutate.mockResolvedValue({ runId: 'run-1', status: 'retrying' });
		openRecover();

		fireEvent.click(screen.getByRole('button', { name: /retry now/i }));

		await waitFor(() => {
			expect(retryMutate).toHaveBeenCalledWith({
				runId: 'run-1',
				cli: undefined,
				model: undefined,
				reasoning: undefined,
			});
		});
		expect(resetMutate).not.toHaveBeenCalled();
		// The popup closed with the choice, so no alternate action is still offered.
		expect(screen.queryByRole('button', { name: /reset & restart/i })).toBeNull();
	});

	it('submits the popup’s agent/model overrides with the retry', async () => {
		retryMutate.mockResolvedValue({ runId: 'run-1', status: 'retrying' });
		openRecover();

		fireEvent.change(screen.getByLabelText('Agent CLI'), { target: { value: 'codex' } });
		fireEvent.click(screen.getByRole('button', { name: /retry with these settings/i }));

		await waitFor(() => {
			expect(retryMutate).toHaveBeenCalledWith(
				expect.objectContaining({ runId: 'run-1', cli: 'codex' }),
			);
		});
		expect(resetMutate).not.toHaveBeenCalled();
	});

	it('routes the reset choice through its own confirmation before submitting', async () => {
		resetMutate.mockResolvedValue(RESET_REPORT);
		openRecover();

		fireEvent.click(screen.getByRole('button', { name: /reset & restart/i }));

		// The popup closed and the destructive action still confirms first.
		expect(screen.getByRole('heading', { name: /reset & restart run\?/i })).toBeDefined();
		expect(screen.queryByRole('button', { name: /retry now/i })).toBeNull();
		expect(resetMutate).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('checkbox'));
		const confirms = screen.getAllByRole('button', { name: /reset & restart/i });
		fireEvent.click(confirms[confirms.length - 1]);

		await waitFor(() => {
			expect(resetMutate).toHaveBeenCalledWith({ runId: 'run-1', force: true });
		});
		expect(retryMutate).not.toHaveBeenCalled();
	});

	it('becomes a disabled pending label naming the retry in flight', async () => {
		retryMutate.mockReturnValue(neverSettles());
		openRecover();

		fireEvent.click(screen.getByRole('button', { name: /retry now/i }));

		await waitFor(() => {
			expect(
				(screen.getByRole('button', { name: /retrying…/i }) as HTMLButtonElement).disabled,
			).toBe(true);
		});
		expect(screen.queryByRole('button', { name: 'Recover' })).toBeNull();
		// The chosen action is not left exposed as a second active button either.
		expect(screen.queryByRole('button', { name: /^retry now$/i })).toBeNull();
		expect(screen.queryByRole('button', { name: /reset & restart/i })).toBeNull();
	});

	it('becomes a disabled pending label naming the reset in flight', async () => {
		resetMutate.mockReturnValue(neverSettles());
		openRecover();

		fireEvent.click(screen.getByRole('button', { name: /reset & restart/i }));
		const confirms = screen.getAllByRole('button', { name: /reset & restart/i });
		fireEvent.click(confirms[confirms.length - 1]);

		await waitFor(() => {
			// The trigger relabels; the still-open modal's confirm relabels with it.
			// Both are disabled, so a second reset can't be issued from either.
			const pendingButtons = screen.getAllByRole('button', { name: /resetting…/i });
			expect(pendingButtons).toHaveLength(2);
			expect(pendingButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
		});
		expect(screen.queryByRole('button', { name: 'Recover' })).toBeNull();
	});

	it('blocks both choices while a restart is outstanding for every viewer', () => {
		// The durable, server-derived fact — not this browser's mutation — so a
		// second viewer and a reloaded page see the same blocked control.
		renderRecover(
			failedRun({
				pendingRequest: {
					action: 'restart',
					requestedAt: '2026-01-01T00:03:00.000Z',
					waitUntil: null,
				},
			}),
		);

		const button = screen.getByRole('button', { name: /waiting to restart/i });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText(/queued as a fresh dispatch/i)).toBeDefined();

		fireEvent.click(button);

		expect(screen.queryByRole('button', { name: /retry now/i })).toBeNull();
		expect(screen.queryByRole('button', { name: /reset & restart/i })).toBeNull();
		expect(retryMutate).not.toHaveBeenCalled();
		expect(resetMutate).not.toHaveBeenCalled();
	});

	it('disables the choices in a popup left open when a restart becomes outstanding', () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { rerender } = render(
			<QueryClientProvider client={queryClient}>
				<RecoverRunButton run={failedRun()} />
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByRole('button', { name: 'Recover' }));

		// A background refetch surfaces the request another viewer just made.
		rerender(
			<QueryClientProvider client={queryClient}>
				<RecoverRunButton
					run={failedRun({
						pendingRequest: { action: 'restart', requestedAt: null, waitUntil: null },
					})}
				/>
			</QueryClientProvider>,
		);

		const retryChoice = screen.getByRole('button', { name: /retry now/i }) as HTMLButtonElement;
		const resetChoice = screen.getByRole('button', {
			name: /reset & restart/i,
		}) as HTMLButtonElement;
		expect(retryChoice.disabled).toBe(true);
		expect(resetChoice.disabled).toBe(true);

		fireEvent.click(retryChoice);
		fireEvent.click(resetChoice);
		expect(retryMutate).not.toHaveBeenCalled();
		expect(resetMutate).not.toHaveBeenCalled();
	});

	it('returns to an enabled Recover and reports a rejected retry', async () => {
		retryMutate.mockRejectedValue(new Error('Run "run-1" is already being restarted.'));
		openRecover();

		fireEvent.click(screen.getByRole('button', { name: /retry now/i }));

		await waitFor(() => {
			expect(screen.getByText('Run "run-1" is already being restarted.')).toBeDefined();
		});
		expect((screen.getByRole('button', { name: 'Recover' }) as HTMLButtonElement).disabled).toBe(
			false,
		);
	});

	it('keeps the reset confirmation open with the server’s refusal', async () => {
		resetMutate.mockRejectedValue(new Error('Run "run-1" is already being restarted.'));
		openRecover();

		fireEvent.click(screen.getByRole('button', { name: /reset & restart/i }));
		const confirms = screen.getAllByRole('button', { name: /reset & restart/i });
		fireEvent.click(confirms[confirms.length - 1]);

		await waitFor(() => {
			expect(screen.getByText('Run "run-1" is already being restarted.')).toBeDefined();
		});
		// The operator can adjust and retry from the still-open modal.
		expect(screen.getByRole('checkbox')).toBeDefined();
	});

	it('re-enables once the outstanding restart resolves', () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { rerender } = render(
			<QueryClientProvider client={queryClient}>
				<RecoverRunButton
					run={failedRun({
						pendingRequest: { action: 'restart', requestedAt: null, waitUntil: null },
					})}
				/>
			</QueryClientProvider>,
		);
		expect(screen.getByRole('button', { name: /waiting to restart/i })).toBeDefined();

		rerender(
			<QueryClientProvider client={queryClient}>
				<RecoverRunButton run={failedRun({ pendingRequest: null })} />
			</QueryClientProvider>,
		);

		expect((screen.getByRole('button', { name: 'Recover' }) as HTMLButtonElement).disabled).toBe(
			false,
		);
		expect(screen.queryByText(/queued as a fresh dispatch/i)).toBeNull();
	});

	it('renders nothing for a run with no eligible recovery action', () => {
		const { container } = renderRecover(makeReviewRun());

		expect(container.firstChild).toBeNull();
	});

	it('leaves the non-error recovery states with their existing side-by-side controls', () => {
		renderHeader(
			makeReviewRun({
				status: 'deferred',
				phase: 'implementation',
				error: 'rate limited',
				nextRetryAt: '2026-01-01T01:00:00.000Z',
			}),
		);

		expect(screen.getByRole('button', { name: /retry now/i })).toBeDefined();
		expect(screen.getByRole('button', { name: /^terminate$/i })).toBeDefined();
		expect(screen.getByRole('button', { name: /reset & restart/i })).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Recover' })).toBeNull();
	});
});

describe('ForceReReviewButton (issue #511)', () => {
	const forceMutate = vi.mocked(trpcClient.runs.forceReReview.mutate);

	beforeEach(() => {
		forceMutate.mockReset();
	});

	function renderButton(run: RunRow = makeReviewRun()) {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		return render(
			<QueryClientProvider client={queryClient}>
				<ForceReReviewButton run={run} />
			</QueryClientProvider>,
		);
	}

	/** Open the confirmation modal from the callout's trigger button. */
	function openConfirm(run?: RunRow) {
		renderButton(run);
		fireEvent.click(screen.getByRole('button', { name: /force re-review/i }));
	}

	function confirm() {
		const buttons = screen.getAllByRole('button', { name: /force re-review/i });
		// The trigger renders first; the modal's confirm button is the last one.
		fireEvent.click(buttons[buttons.length - 1]);
	}

	const scheduled = {
		runId: 'run-1',
		prNumber: '42',
		headSha: 'cafebabe',
		capOverride: 'granted' as const,
		dispatch: 'scheduled' as const,
		dispatchId: 'dispatch-9',
	};

	it('confirms before scheduling anything', async () => {
		forceMutate.mockResolvedValue(scheduled);
		openConfirm();

		expect(screen.getByRole('heading', { name: 'Force re-review?' })).toBeDefined();
		expect(screen.getByText(/bypasses SWARM's review safety cap for PR #42/i)).toBeDefined();
		expect(forceMutate).not.toHaveBeenCalled();

		confirm();

		await waitFor(() => {
			expect(forceMutate).toHaveBeenCalledWith({ runId: 'run-1' });
		});
	});

	it('renders the per-step report on success', async () => {
		forceMutate.mockResolvedValue(scheduled);
		openConfirm();
		confirm();

		await waitFor(() => {
			expect(screen.getByRole('heading', { name: 'Re-review scheduled' })).toBeDefined();
		});
		expect(screen.getByText(/one extra review slot granted/i)).toBeDefined();
		expect(screen.getByText(/scheduled for PR #42 as dispatch dispatch-9/i)).toBeDefined();
	});

	it('reports a repeated force as duplicating nothing', async () => {
		forceMutate.mockResolvedValue({
			...scheduled,
			capOverride: 'already-granted',
			dispatch: 'already-scheduled',
		});
		openConfirm();
		confirm();

		await waitFor(() => {
			expect(screen.getByText(/nothing duplicated/i)).toBeDefined();
		});
	});

	it("renders the server's refusal message and keeps the modal open", async () => {
		forceMutate.mockRejectedValue(
			new Error('Run "run-1" is not a completed Review run stopped by the review cap.'),
		);
		openConfirm();
		confirm();

		await waitFor(() => {
			expect(
				screen.getByText('Run "run-1" is not a completed Review run stopped by the review cap.'),
			).toBeDefined();
		});
		expect(screen.getByRole('heading', { name: 'Force re-review?' })).toBeDefined();
	});
});
