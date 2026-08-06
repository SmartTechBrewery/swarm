// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerDetail, WorkerDetailEnrollment } from '@/types/workers.js';

const { setConsentMutate, updateConstraintsMutate, approveMutate, setStatusMutate, renameMutate } =
	vi.hoisted(() => ({
		setConsentMutate: vi.fn(),
		updateConstraintsMutate: vi.fn(),
		approveMutate: vi.fn(),
		setStatusMutate: vi.fn(),
		renameMutate: vi.fn(),
	}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {},
	trpcClient: {
		workers: {
			setConsent: { mutate: setConsentMutate },
			updateConstraints: { mutate: updateConstraintsMutate },
			approveEnrollment: { mutate: approveMutate },
			setStatus: { mutate: setStatusMutate },
			rename: { mutate: renameMutate },
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
			instanceAdmin: false,
		},
		ownerUserId: 'u1',
		capabilities: ['claude', 'codex'],
		supportedPhases: ['planning', 'implementation', 'review'],
		connection: 'online',
		lastSeenAt: NOW.toISOString(),
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
const PROJECT_REPOS = new Map([['proj-a', 'acme/widgets']]);

const onChanged = vi.fn();

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
			projectRepos={PROJECT_REPOS}
			projectDisabledPhases={disabledPhases}
			onChanged={onChanged}
		/>,
	);
}

/** The Allowed-pipeline-phases checkbox for one phase, by its rendered label. */
function phaseCheckbox(phase: string): HTMLInputElement {
	return screen.getByRole('checkbox', { name: phase }) as HTMLInputElement;
}

beforeEach(() => {
	setConsentMutate.mockReset();
	updateConstraintsMutate.mockReset();
	approveMutate.mockReset();
	setStatusMutate.mockReset();
	renameMutate.mockReset();
	onChanged.mockReset();
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

	it('reports both capability axes in full — every declared phase, not only planning', () => {
		renderWorker();

		const capabilities = within(section('Declared capabilities'));
		expect(capabilities.getByText('claude')).toBeDefined();
		expect(capabilities.getByText('codex')).toBeDefined();
		// The whole repertoire, where the table shows only the `planning` badge.
		expect(capabilities.getByText('planning')).toBeDefined();
		expect(capabilities.getByText('implementation')).toBeDefined();
		expect(capabilities.getByText('review')).toBeDefined();
	});

	it('offers no control for the self-declared capabilities, and says why', () => {
		renderWorker({ enrollments: [] });

		expect(screen.getByText(/never editable/)).toBeDefined();
		// Nothing editable at all on a machine with no visible enrollment.
		expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
		expect(screen.queryAllByRole('switch')).toHaveLength(0);
		expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
	});

	it('describes the active job the way /runs does, linking to the run', () => {
		renderWorker({
			currentRun: {
				runId: 'run-7',
				projectId: 'proj-a',
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

	it('keeps enrolling into a new project off the view, naming the flow that owns it', () => {
		renderWorker({ enrollments: [] });
		expect(screen.getByText('swarm workers enroll')).toBeDefined();
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

	it('cannot select planning on a worker whose owner is not an instance admin, and says so', () => {
		// The daemon declares planning and the project allows it — only ownership blocks it.
		renderWorker({ enrollments: [makeEnrollment({ allowedPhases: ['implementation'] })] });

		const planning = phaseCheckbox('planning');
		expect(planning.checked).toBe(false);
		expect(planning.disabled).toBe(true);
		expect(planning.getAttribute('title')).toMatch(/instance admin/);
		expect(screen.getAllByText(/instance admin/).length).toBeGreaterThan(0);
		fireEvent.click(planning);
		expect(updateConstraintsMutate).not.toHaveBeenCalled();
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

	it('keeps planning’s accent tone in the read-only allowed-phases badges, same as the declared Capabilities column', () => {
		renderWorker({
			viewerIsOwner: false,
			owner: {
				userId: 'u1',
				identifier: 'ada@example.com',
				displayName: 'Ada Lovelace',
				instanceAdmin: true,
			},
		});

		const enrollments = within(section('Project enrollments'));
		const [planningBadge] = enrollments.getAllByText('planning');
		expect(planningBadge.className).toContain('text-violet-300');
		const [implementationBadge] = enrollments.getAllByText('implementation');
		expect(implementationBadge.className).not.toContain('text-violet-300');
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

	it('shows the state but no approval control to a viewer who does not administer the project', () => {
		renderWorker({
			enrollments: [makeEnrollment({ status: 'pending', isRoutable: false })],
		});

		expect(screen.getByText('Pending approval')).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Approve enrollment' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Suspend enrollment' })).toBeNull();
		expect(screen.getByText(/Only an administrator of Widgets/)).toBeDefined();
	});

	it('surfaces a rejected suspension inside the confirmation it was started from', async () => {
		setStatusMutate.mockRejectedValue(new Error('Enrollment with ID "enr-1" not found'));
		renderWorker({ enrollments: [makeEnrollment({ viewerCanAdminister: true })] });

		fireEvent.click(screen.getByRole('button', { name: 'Suspend enrollment' }));
		fireEvent.click(confirmButton('Suspend enrollment'));

		expect(await screen.findByText('Enrollment with ID "enr-1" not found')).toBeDefined();
	});
});
