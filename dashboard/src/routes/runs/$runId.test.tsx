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
	trpcClient: { runs: { reset: { mutate: vi.fn() }, forceReReview: { mutate: vi.fn() } } },
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
	FailureDiagnosisCallout,
	ForceReReviewButton,
	GitHubReferences,
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
			name: string;
			repo: string;
			pipeline?: { respondToReview?: { enabled?: boolean } };
		} | null = { name: 'Demo', repo: 'acme/demo' },
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
			name: 'Demo',
			repo: 'acme/demo',
			pipeline: { respondToReview: { enabled: false } },
		});

		expect(screen.getByRole('heading', { name: 'Manual action required' })).toBeDefined();
		expect(screen.queryByRole('button', { name: /force re-review/i })).toBeNull();
	});

	it('links to the PR when the project repo is known', () => {
		renderCapCallout();

		const link = screen.getByRole('link', { name: /view pr #42/i }) as HTMLAnchorElement;
		expect(link.href).toBe('https://github.com/acme/demo/pull/42');
	});

	it('omits the PR link when no project is known', () => {
		renderCapCallout(makeReviewRun(), null);

		expect(screen.getByRole('heading', { name: 'Manual action required' })).toBeDefined();
		expect(screen.queryByRole('link', { name: /view pr/i })).toBeNull();
	});

	it('renders nothing for an ordinary first changes-requested verdict', () => {
		const { container } = render(
			<ReviewCapCallout
				run={makeReviewRun({ reviewOrdinal: 1, reviewAutomationOutcome: null })}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(container.firstChild).toBeNull();
	});

	it('renders nothing for an approval verdict even with the outcome field set', () => {
		const { container } = render(
			<ReviewCapCallout
				run={makeReviewRun({ reviewVerdict: 'approve' })}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(container.firstChild).toBeNull();
	});

	it('renders nothing for a non-Review phase', () => {
		const { container } = render(
			<ReviewCapCallout
				run={makeReviewRun({ phase: 'respond-to-review' })}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(container.firstChild).toBeNull();
	});

	it('renders nothing for a run still in progress', () => {
		const { container } = render(
			<ReviewCapCallout
				run={makeReviewRun({ status: 'running' })}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

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

describe('ReviewMergeCallout (issue #278)', () => {
	it('renders nothing when no merge automation ran', () => {
		const { container } = render(
			<ReviewMergeCallout
				run={makeReviewRun({ reviewMergeOutcome: null })}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(container.firstChild).toBeNull();
	});

	it('renders nothing for a non-Review phase even with an outcome set', () => {
		const { container } = render(
			<ReviewMergeCallout
				run={makeReviewRun({ phase: 'respond-to-review', reviewMergeOutcome: 'merged' })}
				project={{ name: 'Demo', repo: 'acme/demo' }}
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
				project={{ name: 'Demo', repo: 'acme/demo' }}
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
				project={{ name: 'Demo', repo: 'acme/demo' }}
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
				project={{ name: 'Demo', repo: 'acme/demo' }}
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
				project={{ name: 'Demo', repo: 'acme/demo' }}
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
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(screen.getByRole('link', { name: /pr opened by this run/i })).toBeDefined();
		const actedOn = screen.getByRole('link', { name: /^PR #42$/ }) as HTMLAnchorElement;
		expect(actedOn.href).toBe('https://github.com/acme/demo/pull/42');
	});

	it('still renders the neutral dash for a run with no references at all', () => {
		const { container } = render(
			<GitHubReferences
				run={makeReviewRun({ prNumber: null, prTitle: null })}
				project={{ name: 'Demo', repo: 'acme/demo' }}
			/>,
		);

		expect(container.textContent).toBe('—');
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
			recoveryCleared: true,
			dispatchId: 'dispatch-9',
		});
		openConfirm();
		expect(screen.getByText(/are kept/i)).toBeDefined();

		confirm();

		await waitFor(() => {
			expect(resetMutate).toHaveBeenCalledWith({ runId: 'run-1', force: false });
		});
	});

	it('maps the discard opt-in to the force variant and warns it is unrecoverable', async () => {
		resetMutate.mockResolvedValue({
			runId: 'run-1',
			forced: true,
			dispatch: 'cancelled',
			cancellationCleared: true,
			worktree: { outcome: 'removed', discarded: 'dirty' },
			recoveryCleared: true,
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
			recoveryCleared: true,
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
			recoveryCleared: true,
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
