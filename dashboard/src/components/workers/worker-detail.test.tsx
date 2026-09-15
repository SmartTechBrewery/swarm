// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerDetail, WorkerDetailEnrollment, WorkerUpdate } from '@/types/workers.js';

const {
	setConsentMutate,
	updateConstraintsMutate,
	approveMutate,
	setStatusMutate,
	renameMutate,
	setDeclaredCapabilitiesMutate,
	enrollMutate,
	removeMutate,
	setDrainingMutate,
	projectsListQueryFn,
	scmCredentialsListQueryFn,
	scmCredentialsSetMutate,
} = vi.hoisted(() => ({
	setConsentMutate: vi.fn(),
	updateConstraintsMutate: vi.fn(),
	approveMutate: vi.fn(),
	setStatusMutate: vi.fn(),
	renameMutate: vi.fn(),
	setDeclaredCapabilitiesMutate: vi.fn(),
	enrollMutate: vi.fn(),
	removeMutate: vi.fn(),
	setDrainingMutate: vi.fn(),
	projectsListQueryFn: vi.fn(),
	scmCredentialsListQueryFn: vi.fn(),
	scmCredentialsSetMutate: vi.fn(),
}));

// The enroll dialog (issue #764) is mounted for an owner — with its projects query
// disabled until it opens — so the mock carries `projects.list` and `workers.enroll`
// even though this file only asserts the entry point's gating.
vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		projects: {
			list: {
				queryOptions: () => ({ queryKey: ['projects.list'], queryFn: projectsListQueryFn }),
			},
		},
		// The operator-credential card (issue #766) is mounted for an owner and owns its
		// own query, so every case in this file needs it stubbed.
		workers: {
			scmCredentials: {
				list: {
					queryOptions: ({ workerId }: { workerId: string }) => ({
						queryKey: ['workers.scmCredentials.list', workerId],
						queryFn: () => scmCredentialsListQueryFn(workerId),
					}),
				},
			},
		},
	},
	trpcClient: {
		workers: {
			setConsent: { mutate: setConsentMutate },
			updateConstraints: { mutate: updateConstraintsMutate },
			approveEnrollment: { mutate: approveMutate },
			setStatus: { mutate: setStatusMutate },
			rename: { mutate: renameMutate },
			setDeclaredCapabilities: { mutate: setDeclaredCapabilitiesMutate },
			enroll: { mutate: enrollMutate },
			remove: { mutate: removeMutate },
			setDraining: { mutate: setDrainingMutate },
			scmCredentials: { set: { mutate: scmCredentialsSetMutate } },
		},
	},
}));

import { WorkerDetailView } from './worker-detail.js';

const NOW = new Date('2026-07-01T12:00:00.000Z');

function makeEnrollment(overrides: Partial<WorkerDetailEnrollment> = {}): WorkerDetailEnrollment {
	return {
		enrollmentId: 'enr-1',
		projectId: 'proj-a',
		status: 'active',
		allowedClis: ['claude'],
		allowedPhases: ['planning', 'implementation'],
		concurrencyAllocation: 2,
		sharingConsent: true,
		isRoutable: true,
		projectRepos: ['acme/frontend'],
		viewerCanAdminister: false,
		...overrides,
	};
}

function makeWorker(overrides: Partial<WorkerDetail> = {}): WorkerDetail {
	return {
		workerId: 'worker-1',
		displayName: 'ada-laptop',
		owner: {
			userId: 'u1',
			identifier: 'ada@example.com',
			displayName: 'Ada Lovelace',
		},
		ownerUserId: 'u1',
		// The effective set and the two facts it derives from (issue #783): nothing
		// declared, so it is the machine's own probe verbatim.
		capabilities: ['claude', 'codex'],
		declaredCapabilities: null,
		probedCapabilities: ['claude', 'codex'],
		// The comparand the row's `buildIsCurrent` was judged against (issue #925).
		controlPlaneBuild: { commit: 'abc1234def5678', dirty: false },
		supportedPhases: ['planning', 'implementation', 'review'],
		repository: 'acme/frontend',
		// The daemon's declared SWARM build and the server's verdict on it (issue #925).
		build: { commit: 'abc1234def5678', dirty: false },
		buildIsCurrent: true,
		connection: 'online',
		lastSeenAt: NOW.toISOString(),
		// In the dispatch pool — the Pool membership card offers the drain (issue #926).
		drainingSince: null,
		// No live CLI cool-down (issue #988) — the marked exception is a machine whose
		// own CLI reported a spent usage allowance.
		rateLimits: [],
		// Never asked to update: no pending request (issue #978) and no history (#977).
		update: null,
		currentRun: null,
		viewerIsOwner: true,
		enrollments: [makeEnrollment()],
		...overrides,
	};
}

/**
 * One section's card, so an assertion targets the axis it means: a CLI name appears
 * both as a declared capability and as an enrollment's allowed CLI.
 */
function section(name: string): HTMLElement {
	return screen.getByRole('heading', { name }).parentElement as HTMLElement;
}

/** The modal's copy of an action, when the card behind it has a same-named button. */
function confirmButton(name: string): HTMLElement {
	const buttons = screen.getAllByRole('button', { name });
	return buttons[buttons.length - 1];
}

const PROJECT_NAMES = new Map([['proj-a', 'Widgets']]);

const onChanged = vi.fn();
const onDeleted = vi.fn();

function renderDetail(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function renderWorker(
	overrides: Partial<WorkerDetail> = {},
	disabledPhases: Map<string, string[]> = new Map(),
) {
	return renderDetail(
		<WorkerDetailView
			worker={makeWorker(overrides)}
			projectNames={PROJECT_NAMES}
			projectDisabledPhases={disabledPhases}
			onChanged={onChanged}
			onDeleted={onDeleted}
		/>,
	);
}

/** The declared-CLI checkbox for one CLI, by the control's own accessible name. */
function declaredCliCheckbox(cli: string): HTMLInputElement {
	return screen.getByRole('checkbox', { name: `Declare ${cli}` }) as HTMLInputElement;
}

/** The Allowed-pipeline-phases checkbox for one phase, by its rendered label. */
function phaseCheckbox(phase: string): HTMLInputElement {
	return screen.getByRole('checkbox', { name: phase }) as HTMLInputElement;
}

/**
 * The declared Pipeline-phases badges in the order they render. Scoped to that one
 * field, since the same section also stamps the declared agent CLIs.
 */
function declaredPhaseBadges(): string[] {
	const value = screen.getByText('Pipeline phases').nextElementSibling as HTMLElement;
	return Array.from(value.querySelectorAll('span')).map((badge) => badge.textContent ?? '');
}

beforeEach(() => {
	setConsentMutate.mockReset();
	updateConstraintsMutate.mockReset();
	approveMutate.mockReset();
	setStatusMutate.mockReset();
	renameMutate.mockReset();
	setDeclaredCapabilitiesMutate.mockReset();
	enrollMutate.mockReset();
	removeMutate.mockReset();
	removeMutate.mockResolvedValue({ workerId: 'worker-1' });
	setDrainingMutate.mockReset();
	setDrainingMutate.mockResolvedValue({
		workerId: 'worker-1',
		displayName: 'ada-laptop',
		drainingSince: NOW.toISOString(),
		busy: false,
		currentRunId: null,
	});
	projectsListQueryFn.mockReset();
	projectsListQueryFn.mockResolvedValue([]);
	scmCredentialsListQueryFn.mockReset();
	scmCredentialsListQueryFn.mockResolvedValue({ providers: [] });
	scmCredentialsSetMutate.mockReset();
	onChanged.mockReset();
	onDeleted.mockReset();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('WorkerDetailView sections (issue #477)', () => {
	it('reports identity and owner, including the worker id the table drops', () => {
		renderWorker();

		// The owner sees the Machine name as an editable field (issue below), not
		// plain text — its value is what carries the name here.
		expect((screen.getByRole('textbox', { name: 'Machine name' }) as HTMLInputElement).value).toBe(
			'ada-laptop',
		);
		expect(screen.getByText('worker-1')).toBeDefined();
		expect(screen.getByText('Ada Lovelace')).toBeDefined();
		expect(screen.getByText('ada@example.com')).toBeDefined();
	});

	it('reports connectivity with the last-seen time and the exact timestamp as a title', () => {
		const lastSeenAt = new Date(NOW.getTime() - 5 * 60_000).toISOString();
		renderWorker({ connection: 'offline', lastSeenAt });

		expect(screen.getByText('Offline')).toBeDefined();
		expect(screen.getByText('5m ago').getAttribute('title')).toBe(
			new Date(lastSeenAt).toLocaleString(),
		);
	});

	it('says a machine that never connected has no last-seen value', () => {
		renderWorker({ connection: 'offline', lastSeenAt: null });
		expect(screen.getByText('Never connected')).toBeDefined();
	});

	it('reports both capability axes in full — the whole declared repertoire', () => {
		renderWorker();

		const capabilities = within(section('Declared by the daemon'));
		expect(capabilities.getByText('claude')).toBeDefined();
		expect(capabilities.getByText('codex')).toBeDefined();
		// The whole repertoire; the table itself lists no phase at all (issue #542).
		expect(capabilities.getByText('planning')).toBeDefined();
		expect(capabilities.getByText('implementation')).toBeDefined();
		expect(capabilities.getByText('review')).toBeDefined();
	});

	// Issue #548: a remote DB-free daemon declares `[...SUPPORTED_DB_FREE_PHASES]`,
	// whose `Set` order is written for its own doc comment, while a same-host worker
	// declares `ALL_TRIGGER_PHASES` — the screen must read the same either way.
	it('renders the declared phases in the pipeline’s own order, however they arrived', () => {
		renderWorker({
			supportedPhases: [
				'respond-to-ci',
				'resolve-conflicts',
				'implementation',
				'review',
				'respond-to-review',
				'planning',
			],
		});

		expect(declaredPhaseBadges()).toEqual([
			'planning',
			'implementation',
			'review',
			'respond to review',
			'respond to ci',
			'resolve conflicts',
		]);
	});

	it('renders a declared subset in canonical relative order, with no placeholders', () => {
		renderWorker({ supportedPhases: ['resolve-conflicts', 'implementation'] });
		expect(declaredPhaseBadges()).toEqual(['implementation', 'resolve conflicts']);
	});

	it('offers no control for the facts the daemon states, and says why', () => {
		// The CLI axis is the owner's to pin (issue #787) and has its own suite below;
		// the phase repertoire and the checkout repository stay reported-only.
		renderWorker({ enrollments: [], viewerIsOwner: false });

		expect(screen.getByText(/never editable/)).toBeDefined();
		// Nothing editable at all for a non-owner on a machine with no visible enrollment.
		expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
		expect(screen.queryAllByRole('switch')).toHaveLength(0);
		expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
	});

	it('describes the active job the way /runs does, linking to the run', () => {
		renderWorker({
			currentRun: {
				runId: 'run-7',
				projectId: 'proj-a',
				repository: 'acme/widgets',
				taskId: '42',
				phase: 'implementation',
				workItemId: 'I_kwitem',
				workItemTitle: 'Teach the dispatcher to count',
				workItemUrl: 'https://github.com/acme/widgets/issues/42',
				prNumber: null,
				prTitle: null,
			},
		});

		expect(
			screen.getByRole('link', { name: 'Teach the dispatcher to count' }).getAttribute('href'),
		).toBe('/runs/run-7');
		expect(screen.getByRole('link', { name: /Issue: #42/ })).toBeDefined();
	});

	it('says an idle machine is idle rather than leaving the section blank', () => {
		renderWorker();
		expect(screen.getByText(/Idle/)).toBeDefined();
	});

	it('points an un-enrolled machine’s owner at the action that offers it (issue #764)', () => {
		renderWorker({ enrollments: [] });
		expect(screen.getByText(/Offer it to one with Enroll in a project/)).toBeDefined();
	});

	it('tells a non-owner whose action offering the machine is, with no button', () => {
		renderWorker({ enrollments: [], viewerIsOwner: false });
		expect(screen.getByText(/is its owner’s action/)).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Enroll in a project' })).toBeNull();
	});
});

/**
 * The machine-scoped update action, in Connectivity. Its gate is the strict
 * `viewerIsOwner` every other machine-scoped control on this screen uses, so a
 * viewer who may not restart someone else's daemon is never offered the button
 * that would.
 */
describe('WorkerDetailView update action', () => {
	it('offers the machine’s owner an Update worker action in Connectivity', () => {
		renderWorker();

		const button = within(section('Connectivity')).getByRole('button', {
			name: 'Update worker',
		}) as HTMLButtonElement;
		// Inert until it is wired, rather than a live control that swallows a click.
		expect(button.disabled).toBe(true);
		expect(button.title).toContain('Not wired up yet');
	});

	it('withholds it from a viewer who does not own the machine', () => {
		// An administrator reaching someone else's machine keeps the CLI, exactly as
		// drain, delete, and the operator credential say on this same screen.
		renderWorker({ viewerIsOwner: false });

		expect(screen.queryByRole('button', { name: 'Update worker' })).toBeNull();
	});
});

describe('WorkerDetailView enroll entry point (issue #764)', () => {
	it('offers the worker’s owner an Enroll in a project action', () => {
		renderWorker({ enrollments: [] });
		expect(
			within(section('Project enrollments')).getByRole('button', { name: 'Enroll in a project' }),
		).toBeDefined();
	});

	it('withholds it from a viewer who does not own the machine', () => {
		renderWorker({ enrollments: [], viewerIsOwner: false });
		expect(screen.queryByRole('button', { name: 'Enroll in a project' })).toBeNull();
	});

	it('opens the enrollment form, which names the machine and starts closed', () => {
		renderWorker({ enrollments: [] });

		expect(screen.queryByRole('button', { name: 'Enroll worker' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Enroll in a project' }));

		expect(screen.getByRole('heading', { name: 'Enroll ada-laptop in a project' })).toBeDefined();
		expect(screen.getByRole('button', { name: 'Enroll worker' })).toBeDefined();
	});

	// issue #789 — the machine's checkout pairs it with one repository for life, so
	// once it holds any enrollment there is no second project the server would accept
	// and the affordance is withdrawn rather than left to be refused.
	it('withholds the action once the machine holds an enrollment', () => {
		renderWorker();
		expect(screen.queryByRole('button', { name: 'Enroll in a project' })).toBeNull();
	});

	it.each([
		'pending',
		'suspended',
	] as const)('withholds it for a %s enrollment too — any enrollment is the pairing', (status) => {
		renderWorker({ enrollments: [makeEnrollment({ status })] });

		expect(screen.queryByRole('button', { name: 'Enroll in a project' })).toBeNull();
		expect(screen.queryByRole('heading', { name: 'Enroll ada-laptop in a project' })).toBeNull();
	});

	it('keeps offering it to an owner whose machine is enrolled nowhere', () => {
		renderWorker({ enrollments: [] });
		expect(screen.getByRole('button', { name: 'Enroll in a project' })).toBeDefined();
	});
});

/**
 * Draining is machine-scoped owner state, gated by the same strict `viewerIsOwner`
 * flag as the delete card and the operator credential (issue #926). The card's own
 * behaviour is covered in `worker-drain-card.test.tsx`; what matters here is the
 * gate, and that the card reads the machine's *own* active job.
 */
describe('WorkerDetailView pool membership (issue #926)', () => {
	it('renders the section for the worker’s owner', () => {
		renderWorker();
		expect(screen.getByRole('heading', { name: 'Pool membership' })).toBeDefined();
		expect(
			within(section('Pool membership')).getByRole('button', { name: 'Drain worker' }),
		).toBeDefined();
	});

	it('omits it for a viewer who does not own the machine', () => {
		renderWorker({ viewerIsOwner: false });
		expect(screen.queryByRole('heading', { name: 'Pool membership' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Drain worker' })).toBeNull();
	});

	it('drains the machine and reports it, so the view refetches', async () => {
		renderWorker();

		fireEvent.click(
			within(section('Pool membership')).getByRole('button', { name: 'Drain worker' }),
		);

		await waitFor(() =>
			expect(setDrainingMutate).toHaveBeenCalledWith({ workerId: 'worker-1', draining: true }),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	// A drained machine is still Online — the two facts are independent, and the
	// connectivity card must not start reading as an outage.
	it('leaves the connection reading Online for a drained machine', () => {
		renderWorker({ drainingSince: NOW.toISOString() });

		expect(screen.getByText('Online')).toBeDefined();
		expect(
			within(section('Pool membership')).getByRole('button', { name: 'Return to the pool' }),
		).toBeDefined();
	});

	// The regression this card exists to avoid: a PR-driven phase (review,
	// respond-to-review, respond-to-ci, resolve-conflicts) has no backing board card,
	// so `workItemTitle` is null while the machine is very much running. Restart
	// safety must come from the run's *presence*, or the card invites the restart
	// that kills the agent and fails the run.
	it('says to wait for a running PR-driven run that has no work-item title', () => {
		renderWorker({
			drainingSince: NOW.toISOString(),
			currentRun: {
				runId: 'run-9',
				projectId: 'proj-a',
				repository: 'acme/widgets',
				taskId: '42',
				phase: 'respond-to-review',
				workItemId: null,
				workItemTitle: null,
				workItemUrl: null,
				prNumber: '77',
				prTitle: null,
			},
		});

		const pool = within(section('Pool membership'));
		expect(pool.getByText(/Still running a job/)).toBeDefined();
		expect(pool.queryByText(/safe to restart now/)).toBeNull();
	});

	// And when the PR-driven run *does* carry a title it is the PR's, named exactly
	// as the Active job section above names it.
	it('names a running PR-driven run by its pull-request title', () => {
		renderWorker({
			drainingSince: NOW.toISOString(),
			currentRun: {
				runId: 'run-9',
				projectId: 'proj-a',
				repository: 'acme/widgets',
				taskId: '42',
				phase: 'review',
				workItemId: null,
				workItemTitle: null,
				workItemUrl: null,
				prNumber: '77',
				prTitle: 'Teach the dispatcher to count',
			},
		});

		expect(
			within(section('Pool membership')).getByText(/Still running “Teach the dispatcher to count”/),
		).toBeDefined();
	});
});

describe('WorkerDetailView delete worker (issue #789)', () => {
	it('renders the section for the worker’s owner', () => {
		renderWorker();
		expect(screen.getByRole('heading', { name: 'Delete worker' })).toBeDefined();
	});

	it('omits it for a viewer who does not own the machine', () => {
		renderWorker({ viewerIsOwner: false });
		expect(screen.queryByRole('heading', { name: 'Delete worker' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Delete worker' })).toBeNull();
	});

	it('reports the deletion to the caller once it lands', async () => {
		renderWorker();

		fireEvent.click(
			within(section('Delete worker')).getByRole('button', { name: 'Delete worker' }),
		);
		fireEvent.click(confirmButton('Delete worker'));

		await waitFor(() => expect(removeMutate).toHaveBeenCalledWith({ workerId: 'worker-1' }));
		await waitFor(() => expect(onDeleted).toHaveBeenCalled());
	});
});

describe('WorkerDetailView enrollment blocks', () => {
	it('shows the approval state, allowed CLIs, allowed phases, allocation, consent, and routability per project', () => {
		renderWorker();

		expect(screen.getByRole('link', { name: 'Widgets' }).getAttribute('href')).toBe(
			'/projects/proj-a',
		);
		expect(screen.getByText('Approved')).toBeDefined();
		expect(screen.getByText('Routable')).toBeDefined();
		expect(screen.getByRole('switch', { name: 'Share ada-laptop with Widgets' })).toBeDefined();
		expect((screen.getByRole('checkbox', { name: 'claude' }) as HTMLInputElement).checked).toBe(
			true,
		);
		// One checkbox per pipeline phase, so "not offered here" is distinguishable
		// from "does not exist" (issue #509).
		expect(phaseCheckbox('planning').checked).toBe(true);
		expect(phaseCheckbox('review').checked).toBe(false);
		expect(phaseCheckbox('resolve conflicts')).toBeDefined();
		expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('2');
	});

	it('answers "why is this machine not taking work here?" with both unmet conditions', () => {
		renderWorker({
			enrollments: [
				makeEnrollment({ status: 'pending', sharingConsent: false, isRoutable: false }),
			],
		});

		expect(screen.getByText('Not routable')).toBeDefined();
		expect(screen.getByText(/awaiting a project administrator/)).toBeDefined();
		expect(screen.getByText(/has not shared this machine/)).toBeDefined();
	});

	// Issue #690 — the reason an enrollment was refused or suspended, read off the
	// live repositories rather than a sentence stored when it was detected. Widened by
	// issue #946: the project side is every repository the project declares.
	describe('a checkout that is not one of the project’s repositories', () => {
		it('names both repositories on a suspended mismatched enrollment', () => {
			renderWorker({
				repository: 'acme/frontend',
				enrollments: [
					makeEnrollment({
						status: 'suspended',
						isRoutable: false,
						projectRepos: ['acme/backend'],
					}),
				],
			});

			const reason = screen.getByText(/This machine's checkout is/);
			expect(reason.textContent).toContain('acme/frontend');
			expect(reason.textContent).toContain('acme/backend');
		});

		it('says nothing when the machine’s checkout is the project’s repository', () => {
			renderWorker({
				repository: 'acme/frontend',
				enrollments: [makeEnrollment({ projectRepos: ['acme/frontend'] })],
			});

			expect(screen.queryByText(/This machine's checkout is/)).toBeNull();
		});

		// The roster issue #946 unlocked: one worker per repository, several per project.
		// The second entry is a correct enrollment and must not be warned about.
		it('says nothing when the machine holds the project’s second repository', () => {
			renderWorker({
				repository: 'acme/frontend',
				enrollments: [makeEnrollment({ projectRepos: ['acme/backend', 'acme/frontend'] })],
			});

			expect(screen.queryByText(/This machine's checkout is/)).toBeNull();
		});

		// A genuine mismatch on a multi-repository project names every repository it owns,
		// so an operator can tell a typo from a repository the project does not have.
		it('names every project repository on a genuine multi-repository mismatch', () => {
			renderWorker({
				repository: 'acme/docs',
				enrollments: [
					makeEnrollment({
						status: 'suspended',
						isRoutable: false,
						projectRepos: ['acme/backend', 'acme/frontend'],
					}),
				],
			});

			const reason = screen.getByText(/This machine's checkout is/);
			expect(reason.textContent).toContain('acme/docs');
			expect(reason.textContent).toContain('acme/backend');
			expect(reason.textContent).toContain('acme/frontend');
			expect(reason.textContent).toContain('one of those repositories');
		});

		// An unidentifiable checkout is not a wrong one — the same rule the server applies.
		it('says nothing when the machine declared no repository', () => {
			renderWorker({
				repository: null,
				enrollments: [makeEnrollment({ projectRepos: ['acme/backend'] })],
			});

			expect(screen.queryByText(/This machine's checkout is/)).toBeNull();
		});

		// The project no longer resolves: nothing to disagree with, so no banner.
		it('says nothing when the project declares no repository the view can read', () => {
			renderWorker({
				repository: 'acme/frontend',
				enrollments: [makeEnrollment({ projectRepos: [] })],
			});

			expect(screen.queryByText(/This machine's checkout is/)).toBeNull();
		});

		it('reports the declared checkout repository beside the two capability axes', () => {
			renderWorker({ repository: 'acme/frontend', enrollments: [] });

			const declared = within(section('Declared by the daemon'));
			expect(declared.getByText('Checkout repository')).toBeDefined();
			expect(declared.getByText('acme/frontend')).toBeDefined();
		});
	});

	// Issue #925 — the fact that answers "is this machine running the fix?".
	describe('the declared SWARM build', () => {
		const CONTROL_PLANE = { commit: 'abc1234def5678', dirty: false };

		/**
		 * One labelled field's rendered value in the daemon card — the field itself,
		 * never the card's prose, which names the control plane's build too.
		 */
		function declaredFieldValue(label: string): string {
			const field = within(section('Declared by the daemon')).getByText(label).parentElement;
			return (field?.textContent ?? '').replace(label, '').trim();
		}

		it('renders the short commit the daemon declared', () => {
			renderWorker({ build: { commit: 'fedcba9876543210', dirty: false }, enrollments: [] });

			expect(declaredFieldValue('SWARM build')).toBe('fedcba9');
		});

		it('marks a dirty checkout, because the running code is not that commit', () => {
			renderWorker({ build: { commit: 'fedcba9876543210', dirty: true }, enrollments: [] });

			expect(declaredFieldValue('SWARM build')).toBe('fedcba9+dirty');
		});

		it('renders an em dash for a machine that declared no build', () => {
			renderWorker({ build: null, buildIsCurrent: null, enrollments: [] });

			expect(declaredFieldValue('SWARM build')).toBe('—');
		});

		it('shows the mark when the build is not the control plane’s, naming what it differs from', () => {
			renderWorker({
				build: { commit: 'fedcba9876543210', dirty: false },
				buildIsCurrent: false,
				controlPlaneBuild: CONTROL_PLANE,
				enrollments: [],
			});

			// By its tooltip rather than its word: the card's own prose names the mark too,
			// and this assertion is about the badge.
			const badge = screen.getByTitle(/differs from the control plane/);
			expect(badge.textContent).toBe('Outdated');
			expect(badge.getAttribute('title')).toContain('abc1234');
		});

		it('shows no mark when the build is the control plane’s own', () => {
			renderWorker({
				build: CONTROL_PLANE,
				buildIsCurrent: true,
				controlPlaneBuild: CONTROL_PLANE,
				enrollments: [],
			});

			expect(screen.queryByTitle(/differs from the control plane/)).toBeNull();
		});

		// The case a regression gets wrong: an unknown comparand is "no answer", not
		// "stale" — the Compose router image has no `.git` to resolve one from.
		it('shows no mark when the control plane cannot resolve its own build', () => {
			renderWorker({
				build: { commit: 'fedcba9876543210', dirty: false },
				buildIsCurrent: null,
				controlPlaneBuild: null,
				enrollments: [],
			});

			expect(screen.queryByTitle(/differs from the control plane/)).toBeNull();
			// …and the card says so, rather than silently comparing nothing.
			expect(screen.getByText(/cannot read its own build/)).toBeDefined();
		});

		// Issue #978 — the second mark on the same field. It answers "somebody has
		// acted", which the staleness mark beside it cannot.
		describe('and the update in flight beside it (issue #978)', () => {
			const UPDATING = /asked to move to/;
			const OUTDATED = /differs from the control plane/;

			/** A machine's update state as `workers.getById` serializes it (issue #933). */
			function makeUpdate(overrides: Partial<WorkerUpdate> = {}): WorkerUpdate {
				return {
					// Non-null: the machine still owes an answer.
					requestId: 'a1b2c3d4-0000-4000-8000-000000000000',
					target: 'main',
					requestedAt: NOW.toISOString(),
					requestedByUserId: 'u1',
					status: null,
					message: null,
					reportedAt: null,
					...overrides,
				};
			}

			/** The SWARM build field itself, so a mark is asserted on that field, not on the card. */
			function buildField(): HTMLElement {
				return within(section('Declared by the daemon')).getByText('SWARM build')
					.parentElement as HTMLElement;
			}

			it('marks an outstanding request, naming the build and when it was asked', () => {
				renderWorker({ update: makeUpdate(), enrollments: [] });

				const badge = within(buildField()).getByTitle(UPDATING);
				expect(badge.textContent).toBe('Updating');
				expect(badge.getAttribute('title')).toContain('main');
				expect(badge.getAttribute('title')).toContain(NOW.toLocaleString());
			});

			it('stops marking one that has reported — the request id is the pending marker', () => {
				renderWorker({
					update: makeUpdate({
						requestId: null,
						status: 'applied',
						reportedAt: NOW.toISOString(),
					}),
					enrollments: [],
				});

				expect(screen.queryByTitle(UPDATING)).toBeNull();
			});

			it('marks nothing for a machine nobody has ever asked', () => {
				renderWorker({ update: null, enrollments: [] });

				expect(screen.queryByTitle(UPDATING)).toBeNull();
			});

			// The regression this phase exists to prevent.
			it('shows both marks, distinctly, for a machine that is outdated and updating', () => {
				renderWorker({
					build: { commit: 'fedcba9876543210', dirty: false },
					buildIsCurrent: false,
					controlPlaneBuild: CONTROL_PLANE,
					update: makeUpdate(),
					enrollments: [],
				});

				const updating = screen.getByTitle(UPDATING);
				const outdated = screen.getByTitle(OUTDATED);
				expect(updating.textContent).toBe('Updating');
				expect(outdated.textContent).toBe('Outdated');
				expect(updating.getAttribute('title')).not.toBe(outdated.getAttribute('title'));
				// Both on the SWARM build field, as two marks rather than one combined
				// pill, with the more recent fact first.
				expect(declaredFieldValue('SWARM build')).toBe('fedcba9UpdatingOutdated');
			});

			// A staleness verdict with no answer says nothing about a request in flight.
			it('keeps the mark when the control plane cannot resolve its own build', () => {
				renderWorker({
					build: { commit: 'fedcba9876543210', dirty: false },
					buildIsCurrent: null,
					controlPlaneBuild: null,
					update: makeUpdate(),
					enrollments: [],
				});

				expect(screen.getByTitle(UPDATING).textContent).toBe('Updating');
				expect(screen.queryByTitle(OUTDATED)).toBeNull();
			});

			// A daemon too old to declare a build can still be asked to move to one.
			it('marks a machine that declared no build at all', () => {
				renderWorker({
					build: null,
					buildIsCurrent: null,
					update: makeUpdate(),
					enrollments: [],
				});

				const field = within(buildField());
				expect(field.getByTitle(UPDATING).textContent).toBe('Updating');
				// …and the field still says it declared nothing, rather than going blank.
				expect(field.getByText('—')).toBeDefined();
			});

			it('says in the card’s own prose that the two marks are different facts', () => {
				renderWorker({ enrollments: [] });

				expect(screen.getByText(/has been asked to move to a named build/)).toBeDefined();
			});
		});
	});

	it('renders one block per enrollment', () => {
		renderWorker({
			enrollments: [
				makeEnrollment(),
				makeEnrollment({ enrollmentId: 'enr-2', projectId: 'proj-b', sharingConsent: false }),
			],
		});

		expect(screen.getByRole('switch', { name: 'Share ada-laptop with Widgets' })).toBeDefined();
		// An unresolved project name degrades to its id rather than going blank.
		expect(screen.getByRole('switch', { name: 'Share ada-laptop with proj-b' })).toBeDefined();
	});

	it('scopes the phase selection to its own enrollment (issue #509)', async () => {
		updateConstraintsMutate.mockResolvedValue({});
		renderWorker({
			enrollments: [
				makeEnrollment({ allowedPhases: ['implementation'] }),
				makeEnrollment({
					enrollmentId: 'enr-2',
					projectId: 'proj-b',
					allowedPhases: ['planning', 'implementation', 'review'],
				}),
			],
		});

		// Each block shows its own selection: the same machine is offered different
		// phase sets in the two projects.
		const [widgets, other] = screen.getAllByRole('checkbox', { name: 'review' }) as [
			HTMLInputElement,
			HTMLInputElement,
		];
		expect(widgets.checked).toBe(false);
		expect(other.checked).toBe(true);

		fireEvent.click(widgets);

		// ...and a change names only that enrollment.
		await waitFor(() =>
			expect(updateConstraintsMutate).toHaveBeenCalledWith({
				enrollmentId: 'enr-1',
				allowedPhases: ['implementation', 'review'],
			}),
		);
	});
});

describe('WorkerDetailView owner-controlled values (issue #282 authorization)', () => {
	it('applies a widened allowed-CLI set immediately and reports the outcome in place', async () => {
		updateConstraintsMutate.mockResolvedValue({});
		renderWorker();

		fireEvent.click(screen.getByRole('checkbox', { name: 'codex' }));

		expect(await screen.findByText('Saved')).toBeDefined();
		expect(updateConstraintsMutate).toHaveBeenCalledWith({
			enrollmentId: 'enr-1',
			allowedClis: ['claude', 'codex'],
		});
		expect(onChanged).toHaveBeenCalled();
	});

	it('shows the server’s rejection verbatim — an allowed CLI beyond the machine’s capabilities', async () => {
		updateConstraintsMutate.mockRejectedValue(
			new Error('Worker "worker-1" cannot run: antigravity'),
		);
		renderWorker();

		fireEvent.click(screen.getByRole('checkbox', { name: 'codex' }));

		expect(await screen.findByText('Worker "worker-1" cannot run: antigravity')).toBeDefined();
	});

	it('refuses to leave an enrollment with no allowed CLI, instead of a request that must fail', () => {
		renderWorker();

		const onlyAllowed = screen.getByRole('checkbox', { name: 'claude' }) as HTMLInputElement;
		expect(onlyAllowed.disabled).toBe(true);
		expect(onlyAllowed.getAttribute('title')).toMatch(/At least one CLI/);
		fireEvent.click(onlyAllowed);
		expect(updateConstraintsMutate).not.toHaveBeenCalled();
	});

	it('applies a widened phase selection immediately, in the pipeline’s own order', async () => {
		updateConstraintsMutate.mockResolvedValue({});
		renderWorker();

		fireEvent.click(phaseCheckbox('review'));

		expect(await screen.findByText('Saved')).toBeDefined();
		expect(updateConstraintsMutate).toHaveBeenCalledWith({
			enrollmentId: 'enr-1',
			allowedPhases: ['planning', 'implementation', 'review'],
		});
		expect(onChanged).toHaveBeenCalled();
	});

	it('drops a phase from the selection without touching the other constraints', async () => {
		updateConstraintsMutate.mockResolvedValue({});
		renderWorker();

		fireEvent.click(phaseCheckbox('planning'));

		await waitFor(() =>
			expect(updateConstraintsMutate).toHaveBeenCalledWith({
				enrollmentId: 'enr-1',
				allowedPhases: ['implementation'],
			}),
		);
	});

	it('shows the server’s rejection of a phase selection verbatim', async () => {
		updateConstraintsMutate.mockRejectedValue(new Error('At least one phase must be allowed'));
		renderWorker();

		fireEvent.click(phaseCheckbox('review'));

		expect(await screen.findByText('At least one phase must be allowed')).toBeDefined();
	});

	it('refuses to leave an enrollment with no allowed phase', () => {
		renderWorker({ enrollments: [makeEnrollment({ allowedPhases: ['implementation'] })] });

		const onlyAllowed = phaseCheckbox('implementation');
		expect(onlyAllowed.disabled).toBe(true);
		expect(onlyAllowed.getAttribute('title')).toMatch(/At least one pipeline phase/);
		fireEvent.click(onlyAllowed);
		expect(updateConstraintsMutate).not.toHaveBeenCalled();
	});

	it('cannot select a phase the machine’s daemon does not declare, and says so', () => {
		// The worker declares planning/implementation/review — `respond to ci` is absent.
		renderWorker();

		const undeclared = phaseCheckbox('respond to ci');
		expect(undeclared.checked).toBe(false);
		expect(undeclared.disabled).toBe(true);
		expect(undeclared.getAttribute('title')).toMatch(/does not declare this phase/);
		// ...and the reason is spelled out beside the group, not only in a tooltip.
		expect(screen.getAllByText(/does not declare this phase/).length).toBeGreaterThan(0);
		fireEvent.click(undeclared);
		expect(updateConstraintsMutate).not.toHaveBeenCalled();
	});

	// Issue #542: the owner of this machine is an ordinary user, and planning is
	// selectable anyway — the enrollment's own phase selection is the whole decision.
	it('lets an ordinary owner add planning, with no ownership explanation anywhere', async () => {
		updateConstraintsMutate.mockResolvedValue({});
		renderWorker({ enrollments: [makeEnrollment({ allowedPhases: ['implementation'] })] });

		const planning = phaseCheckbox('planning');
		expect(planning.checked).toBe(false);
		expect(planning.disabled).toBe(false);
		expect(planning.getAttribute('title')).toBeNull();
		expect(screen.queryByText(/instance admin/)).toBeNull();

		fireEvent.click(planning);

		await waitFor(() =>
			expect(updateConstraintsMutate).toHaveBeenCalledWith({
				enrollmentId: 'enr-1',
				allowedPhases: ['planning', 'implementation'],
			}),
		);
	});

	it('cannot select a phase the project has turned off, and says so', () => {
		renderWorker({}, new Map([['proj-a', ['review']]]));

		const disabledByProject = phaseCheckbox('review');
		expect(disabledByProject.disabled).toBe(true);
		expect(disabledByProject.getAttribute('title')).toMatch(/turned off for every worker/);
		expect(screen.getByText(/turned off for every worker/)).toBeDefined();
		fireEvent.click(disabledByProject);
		expect(updateConstraintsMutate).not.toHaveBeenCalled();
	});

	it('still lets the owner give up a phase that has become unavailable', async () => {
		// The daemon narrowed its repertoire after the selection was stored: `planning`
		// stays permitted here and must remain removable, or the owner would be stuck.
		updateConstraintsMutate.mockResolvedValue({});
		renderWorker({ supportedPhases: ['implementation', 'review'] });

		const stale = phaseCheckbox('planning');
		expect(stale.checked).toBe(true);
		expect(stale.disabled).toBe(false);
		fireEvent.click(stale);

		await waitFor(() =>
			expect(updateConstraintsMutate).toHaveBeenCalledWith({
				enrollmentId: 'enr-1',
				allowedPhases: ['implementation'],
			}),
		);
	});

	it('applies a concurrency allocation on demand', async () => {
		updateConstraintsMutate.mockResolvedValue({});
		renderWorker();

		const input = screen.getByRole('spinbutton');
		fireEvent.change(input, { target: { value: '4' } });
		fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
		await waitFor(() =>
			expect(updateConstraintsMutate).toHaveBeenCalledWith({
				enrollmentId: 'enr-1',
				concurrencyAllocation: 4,
			}),
		);
	});

	it('treats an emptied allocation as a validation error, never a silent clear (issue #480)', () => {
		renderWorker();

		fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });

		expect(screen.getByText(/whole number of 1 or more/)).toBeDefined();
		expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect(updateConstraintsMutate).not.toHaveBeenCalled();
	});

	it('blocks an out-of-range allocation client-side, with the reason', () => {
		renderWorker();

		fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });

		expect(screen.getByText(/whole number of 1 or more/)).toBeDefined();
		expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it('confirms before revoking sharing, and never mutates until confirmed', async () => {
		setConsentMutate.mockResolvedValue({});
		renderWorker();

		fireEvent.click(screen.getByRole('switch', { name: 'Share ada-laptop with Widgets' }));

		expect(screen.getByRole('heading', { name: 'Stop sharing this worker?' })).toBeDefined();
		expect(screen.getByText(/does not stop a run already in progress/)).toBeDefined();
		expect(setConsentMutate).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));

		await waitFor(() =>
			expect(setConsentMutate).toHaveBeenCalledWith({
				enrollmentId: 'enr-1',
				sharingConsent: false,
			}),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it('grants sharing directly — enabling has no destructive consequence', async () => {
		setConsentMutate.mockResolvedValue({});
		renderWorker({ enrollments: [makeEnrollment({ sharingConsent: false, isRoutable: false })] });

		fireEvent.click(screen.getByRole('switch', { name: 'Share ada-laptop with Widgets' }));

		expect(screen.queryByRole('button', { name: 'Stop sharing' })).toBeNull();
		await waitFor(() =>
			expect(setConsentMutate).toHaveBeenCalledWith({
				enrollmentId: 'enr-1',
				sharingConsent: true,
			}),
		);
	});

	it('shows a non-owner every value, with no control that would be rejected', () => {
		renderWorker({ viewerIsOwner: false });

		// The Machine name is plain text for a non-owner, not the editable field.
		expect(screen.queryByRole('textbox', { name: 'Machine name' })).toBeNull();
		expect(screen.getByText('ada-laptop')).toBeDefined();

		const readOnly = screen.getByRole('switch', { name: 'Sharing of ada-laptop with Widgets' });
		expect((readOnly as HTMLButtonElement).disabled).toBe(true);
		expect(readOnly.getAttribute('title')).toContain('Ada Lovelace');
		// The values are still stated — as badges and text rather than as controls.
		const enrollments = within(section('Project enrollments'));
		expect(enrollments.getByText('claude')).toBeDefined();
		expect(enrollments.getByText('2')).toBeDefined();
		// Including the allowed phases: stated, and only the allowed ones.
		expect(enrollments.getAllByText('planning').length).toBeGreaterThan(0);
		expect(enrollments.queryByText('respond to ci')).toBeNull();
		expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
		expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
		fireEvent.click(readOnly);
		expect(setConsentMutate).not.toHaveBeenCalled();
	});

	// Issue #542: the caution amber states that an allowed phase cannot currently take
	// work — it never promotes one phase over the rest, planning included.
	it('gives planning the same badge tone as every other allowed phase', () => {
		renderWorker({ viewerIsOwner: false });

		const enrollments = within(section('Project enrollments'));
		const [planningBadge] = enrollments.getAllByText('planning');
		const [implementationBadge] = enrollments.getAllByText('implementation');
		expect(planningBadge.className).not.toContain('text-amber-200');
		expect(planningBadge.className).toBe(implementationBadge.className);
	});

	it('still cautions an allowed phase the machine stopped declaring', () => {
		renderWorker({ viewerIsOwner: false, supportedPhases: ['implementation', 'review'] });

		const enrollments = within(section('Project enrollments'));
		const [planningBadge] = enrollments.getAllByText('planning');
		expect(planningBadge.className).toContain('text-amber-200');
	});

	it('states the default allocation of 1 to a non-owner, with no "No limit" wording', () => {
		renderWorker({
			viewerIsOwner: false,
			enrollments: [makeEnrollment({ concurrencyAllocation: 1 })],
		});

		expect(within(section('Project enrollments')).getByText('1')).toBeDefined();
		expect(screen.queryByText('No limit')).toBeNull();
	});
});

describe('WorkerDetailView machine name (owner-only rename)', () => {
	it('lets the owner rename the machine, applying it and reporting the outcome', async () => {
		renameMutate.mockResolvedValue({});
		renderWorker();

		const input = screen.getByRole('textbox', { name: 'Machine name' }) as HTMLInputElement;
		fireEvent.change(input, { target: { value: 'ada-desktop' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() =>
			expect(renameMutate).toHaveBeenCalledWith({
				workerId: 'worker-1',
				displayName: 'ada-desktop',
			}),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it('disables Save until the draft actually changes', () => {
		renderWorker();

		expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('disables Save for an empty draft rather than sending it', () => {
		renderWorker();

		const input = screen.getByRole('textbox', { name: 'Machine name' }) as HTMLInputElement;
		fireEvent.change(input, { target: { value: '   ' } });

		expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('shows the server’s rejection verbatim — a duplicate name', async () => {
		renameMutate.mockRejectedValue(new Error('You already have a worker with this name.'));
		renderWorker();

		const input = screen.getByRole('textbox', { name: 'Machine name' }) as HTMLInputElement;
		fireEvent.change(input, { target: { value: 'ada-desktop' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(await screen.findByText('You already have a worker with this name.')).toBeDefined();
	});
});

/**
 * The owner's durable CLI declaration (issue #787 over issue #783's seam) — the one
 * fact in the "Declared by the daemon" card that is not the daemon's alone. The
 * server's two guards are what decide a save; nothing here pre-empts them beyond
 * refusing to *express* a declaration it already knows would be refused.
 */
describe('WorkerDetailView declared agent CLIs (owner-only, issue #787)', () => {
	it('shows a non-owner the effective set as badges, with no control', () => {
		renderWorker({ viewerIsOwner: false, enrollments: [] });

		const declared = within(section('Declared by the daemon'));
		expect(declared.getByText('claude')).toBeDefined();
		expect(declared.getByText('codex')).toBeDefined();
		expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
		expect(screen.queryByRole('button', { name: 'Save CLIs' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Use auto-detected CLIs' })).toBeNull();
	});

	// One checkbox per *probed* CLI, never per effective one: the server refuses a
	// declaration naming a CLI the machine never reported, so an unprobed option
	// would be an option that fails.
	it('offers the owner one checkbox per CLI the machine reported', () => {
		renderWorker({
			capabilities: ['claude'],
			declaredCapabilities: ['claude'],
			probedCapabilities: ['claude', 'codex'],
		});

		expect(declaredCliCheckbox('claude').checked).toBe(true);
		expect(declaredCliCheckbox('codex').checked).toBe(false);
		expect(screen.queryByRole('checkbox', { name: 'Declare antigravity' })).toBeNull();
	});

	it('refuses to leave the machine with no declared CLI, instead of a request that must fail', () => {
		renderWorker({
			capabilities: ['claude'],
			declaredCapabilities: ['claude'],
			probedCapabilities: ['claude', 'codex'],
		});

		const onlyDeclared = declaredCliCheckbox('claude');
		expect(onlyDeclared.disabled).toBe(true);
		expect(onlyDeclared.getAttribute('title')).toMatch(/At least one CLI/);
		fireEvent.click(onlyDeclared);
		expect(setDeclaredCapabilitiesMutate).not.toHaveBeenCalled();
	});

	it('saves the selected set on demand rather than per click', async () => {
		setDeclaredCapabilitiesMutate.mockResolvedValue({});
		renderWorker();

		fireEvent.click(declaredCliCheckbox('codex'));
		expect(setDeclaredCapabilitiesMutate).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Save CLIs' }));

		await waitFor(() =>
			expect(setDeclaredCapabilitiesMutate).toHaveBeenCalledWith({
				workerId: 'worker-1',
				capabilities: ['claude'],
			}),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it('disables Save until the selection differs from what is in force', () => {
		renderWorker();

		expect((screen.getByRole('button', { name: 'Save CLIs' }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it('clears the declaration back to auto-detection, and offers that only when there is one', async () => {
		setDeclaredCapabilitiesMutate.mockResolvedValue({});
		const { unmount } = renderWorker();
		// Nothing declared — auto-detection is already what is in force.
		expect(screen.queryByRole('button', { name: 'Use auto-detected CLIs' })).toBeNull();
		unmount();

		renderWorker({
			capabilities: ['claude'],
			declaredCapabilities: ['claude'],
			probedCapabilities: ['claude', 'codex'],
		});
		fireEvent.click(screen.getByRole('button', { name: 'Use auto-detected CLIs' }));

		await waitFor(() =>
			expect(setDeclaredCapabilitiesMutate).toHaveBeenCalledWith({
				workerId: 'worker-1',
				capabilities: null,
			}),
		);
	});

	it('shows the server’s rejection verbatim — a CLI an enrollment still requires', async () => {
		setDeclaredCapabilitiesMutate.mockRejectedValue(
			new Error('existing enrollment(s) require CLIs not in updated capabilities: codex'),
		);
		renderWorker();

		fireEvent.click(declaredCliCheckbox('codex'));
		fireEvent.click(screen.getByRole('button', { name: 'Save CLIs' }));

		expect(
			await screen.findByText(
				'existing enrollment(s) require CLIs not in updated capabilities: codex',
			),
		).toBeDefined();
	});

	// Issue #783 logs the drift server-side and routes on the intersection; the card
	// says so rather than showing a set that quietly lost a CLI.
	it('flags a declaration the machine’s latest probe no longer backs', () => {
		renderWorker({
			capabilities: ['claude'],
			declaredCapabilities: ['claude', 'codex'],
			probedCapabilities: ['claude'],
		});

		expect(screen.getByText(/Declared but no longer reported/).textContent).toContain('codex');
	});

	it('lets the owner save the probed subset to correct a drifted declaration', async () => {
		setDeclaredCapabilitiesMutate.mockResolvedValue({});
		renderWorker({
			capabilities: ['claude'],
			declaredCapabilities: ['claude', 'codex'],
			probedCapabilities: ['claude'],
		});

		const save = screen.getByRole('button', { name: 'Save CLIs' }) as HTMLButtonElement;
		expect(save.disabled).toBe(false);
		fireEvent.click(save);

		await waitFor(() =>
			expect(setDeclaredCapabilitiesMutate).toHaveBeenCalledWith({
				workerId: 'worker-1',
				capabilities: ['claude'],
			}),
		);
	});

	it('says nothing about drift when every declared CLI is still reported', () => {
		renderWorker({
			capabilities: ['claude'],
			declaredCapabilities: ['claude'],
			probedCapabilities: ['claude', 'codex'],
		});

		expect(screen.queryByText(/Declared but no longer reported/)).toBeNull();
	});

	it('states the drift to a non-owner too, who has no control to fix it with', () => {
		renderWorker({
			viewerIsOwner: false,
			capabilities: ['claude'],
			declaredCapabilities: ['claude', 'codex'],
			probedCapabilities: ['claude'],
		});

		expect(screen.getByText(/Declared but no longer reported/).textContent).toContain('codex');
		expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
	});
});

describe('WorkerDetailView project-administrator actions', () => {
	it('lets an administrator approve a pending enrollment, reporting the outcome in place', async () => {
		approveMutate.mockResolvedValue({});
		renderWorker({
			enrollments: [
				makeEnrollment({ status: 'pending', isRoutable: false, viewerCanAdminister: true }),
			],
		});

		fireEvent.click(screen.getByRole('button', { name: 'Approve enrollment' }));

		expect(await screen.findByText('Saved')).toBeDefined();
		expect(approveMutate).toHaveBeenCalledWith({ enrollmentId: 'enr-1' });
	});

	it('confirms a suspension, then sets the status', async () => {
		setStatusMutate.mockResolvedValue({});
		renderWorker({ enrollments: [makeEnrollment({ viewerCanAdminister: true })] });

		fireEvent.click(screen.getByRole('button', { name: 'Suspend enrollment' }));
		expect(screen.getByRole('heading', { name: 'Suspend this enrollment?' })).toBeDefined();
		expect(setStatusMutate).not.toHaveBeenCalled();

		fireEvent.click(confirmButton('Suspend enrollment'));

		await waitFor(() =>
			expect(setStatusMutate).toHaveBeenCalledWith({
				enrollmentId: 'enr-1',
				status: 'suspended',
			}),
		);
	});

	it('offers reactivation for a suspended enrollment, applied without a confirmation', async () => {
		setStatusMutate.mockResolvedValue({});
		renderWorker({
			enrollments: [
				makeEnrollment({ status: 'suspended', isRoutable: false, viewerCanAdminister: true }),
			],
		});

		fireEvent.click(screen.getByRole('button', { name: 'Reactivate enrollment' }));

		await waitFor(() =>
			expect(setStatusMutate).toHaveBeenCalledWith({ enrollmentId: 'enr-1', status: 'active' }),
		);
	});

	it('omits the Approval section entirely for a viewer who does not administer the project', () => {
		renderWorker({
			enrollments: [makeEnrollment({ status: 'pending', isRoutable: false })],
		});

		// The state still reads off the enrollment header's badge — only the section
		// whose whole content is an administrator's controls goes away (issue #652).
		expect(screen.getByText('Pending approval')).toBeDefined();
		expect(screen.queryByText('Approval')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Approve enrollment' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Suspend enrollment' })).toBeNull();
		expect(screen.queryByText(/Only an administrator of Widgets/)).toBeNull();
	});

	it('keeps the rest of the enrollment readable for a non-administrator', () => {
		renderWorker({
			enrollments: [makeEnrollment({ status: 'pending', isRoutable: false })],
		});

		expect(screen.getByText('Sharing consent')).toBeDefined();
		expect(screen.getByText('Allowed agent CLIs')).toBeDefined();
		expect(screen.getByText('Allowed pipeline phases')).toBeDefined();
		expect(screen.getByText('Concurrency allocation')).toBeDefined();
	});

	it('renders the Approval section for an administrator', () => {
		renderWorker({
			enrollments: [
				makeEnrollment({ status: 'pending', isRoutable: false, viewerCanAdminister: true }),
			],
		});

		expect(screen.getByText('Approval')).toBeDefined();
		expect(screen.getByRole('button', { name: 'Approve enrollment' })).toBeDefined();
		expect(screen.getByRole('button', { name: 'Suspend enrollment' })).toBeDefined();
	});

	it('surfaces a rejected suspension inside the confirmation it was started from', async () => {
		setStatusMutate.mockRejectedValue(new Error('Enrollment with ID "enr-1" not found'));
		renderWorker({ enrollments: [makeEnrollment({ viewerCanAdminister: true })] });

		fireEvent.click(screen.getByRole('button', { name: 'Suspend enrollment' }));
		fireEvent.click(confirmButton('Suspend enrollment'));

		expect(await screen.findByText('Enrollment with ID "enr-1" not found')).toBeDefined();
	});
});

/**
 * The operator credential is worker-owner state, gated by the same strict
 * `viewerIsOwner` flag as the rename field and the enroll entry point (issue #766).
 * The card's own behaviour is covered in
 * `worker-operator-credentials-card.test.tsx`; what matters here is the gate.
 */
describe('WorkerDetailView — operator source-control credential (issue #766)', () => {
	it('renders the section for the worker’s owner', async () => {
		renderWorker({ viewerIsOwner: true });

		expect(screen.getByText('Operator source-control credential')).toBeDefined();
		await waitFor(() => expect(scmCredentialsListQueryFn).toHaveBeenCalledWith('worker-1'));
	});

	it('omits the section, and its query, for a non-owner', () => {
		renderWorker({ viewerIsOwner: false });

		expect(screen.queryByText('Operator source-control credential')).toBeNull();
		expect(scmCredentialsListQueryFn).not.toHaveBeenCalled();
	});
});
