// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRollout, WorkerRolloutMember } from '@/types/workers.js';

const { fleetUpdateStatusQueryFn, meQueryFn } = vi.hoisted(() => ({
	fleetUpdateStatusQueryFn: vi.fn(),
	meQueryFn: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		workers: {
			fleetUpdateStatusForInstallation: {
				queryOptions: () => ({
					queryKey: ['workers.fleetUpdateStatusForInstallation'],
					queryFn: fleetUpdateStatusQueryFn,
				}),
			},
		},
		auth: {
			me: { queryOptions: () => ({ queryKey: ['auth.me'], queryFn: meQueryFn }) },
		},
	},
}));

import { InstallationRolloutPanel } from './installation-rollout-panel.js';

function makeMember(overrides: Partial<WorkerRolloutMember> = {}): WorkerRolloutMember {
	return {
		workerId: 'worker-1',
		displayName: 'ada-laptop',
		owner: { userId: 'u1', identifier: 'ada@example.com', displayName: 'Ada Lovelace' },
		position: 0,
		state: 'queued',
		outcome: null,
		message: null,
		signalledAt: null,
		settledAt: null,
		...overrides,
	};
}

function makeRollout(overrides: Partial<WorkerRollout> = {}): WorkerRollout {
	return {
		id: 'rollout-1',
		target: 'abc1234def5678901234567890123456789abcde',
		waveSize: 1,
		status: 'in_progress',
		haltReason: null,
		createdAt: '2026-07-01T12:00:00.000Z',
		updatedAt: '2026-07-01T12:01:00.000Z',
		members: [makeMember()],
		...overrides,
	};
}

function renderPanel(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	fleetUpdateStatusQueryFn.mockReset();
	meQueryFn.mockReset();
	meQueryFn.mockResolvedValue({
		id: 'u1',
		identifier: 'ada@example.com',
		displayName: 'Ada Lovelace',
		instanceAdmin: true,
	});
});

describe('InstallationRolloutPanel offers nothing it should not (issue #1025)', () => {
	it('renders nothing at all when no rollout has ever run', async () => {
		fleetUpdateStatusQueryFn.mockResolvedValue({ rollout: null });
		const { container } = renderPanel(<InstallationRolloutPanel />);

		await vi.waitFor(() => expect(fleetUpdateStatusQueryFn).toHaveBeenCalled());
		expect(container.textContent).toBe('');
	});

	it('withholds the read from a viewer without the installation role', async () => {
		meQueryFn.mockResolvedValue({
			id: 'u2',
			identifier: 'grace@example.com',
			displayName: 'Grace Hopper',
			instanceAdmin: false,
		});
		fleetUpdateStatusQueryFn.mockResolvedValue({ rollout: makeRollout() });
		const { container } = renderPanel(<InstallationRolloutPanel />);

		await vi.waitFor(() => expect(meQueryFn).toHaveBeenCalled());
		expect(container.textContent).toBe('');
		// The server refuses this read outright, so a viewer who may not see it never
		// issues it — the gate is about what to offer, not a copy of the precondition.
		expect(fleetUpdateStatusQueryFn).not.toHaveBeenCalled();
	});

	it('fails closed while the viewer is still unresolved', async () => {
		meQueryFn.mockReturnValue(new Promise(() => {}));
		fleetUpdateStatusQueryFn.mockResolvedValue({ rollout: makeRollout() });
		const { container } = renderPanel(<InstallationRolloutPanel />);

		await vi.waitFor(() => expect(meQueryFn).toHaveBeenCalled());
		expect(container.textContent).toBe('');
		expect(fleetUpdateStatusQueryFn).not.toHaveBeenCalled();
	});

	it('renders the server’s refusal verbatim when it comes anyway', async () => {
		const forbidden =
			'Staging a fleet update across the installation is available to instance administrators only. Run `swarm workers update --status` for the machines you own.';
		fleetUpdateStatusQueryFn.mockRejectedValue(new Error(forbidden));
		renderPanel(<InstallationRolloutPanel />);

		expect(await screen.findByText(forbidden)).toBeDefined();
	});
});

describe('InstallationRolloutPanel readout (issue #1025)', () => {
	it('names the target, the status and the wave size', async () => {
		fleetUpdateStatusQueryFn.mockResolvedValue({ rollout: makeRollout({ waveSize: 3 }) });
		renderPanel(<InstallationRolloutPanel />);

		expect(await screen.findByText('Installation fleet update')).toBeDefined();
		expect(screen.getByText('In progress')).toBeDefined();
		expect(screen.getByText(/abc1234/)).toBeDefined();
		expect(screen.getByText(/3 machines per wave/)).toBeDefined();
	});

	it('gives every machine a line with its owner and its state', async () => {
		fleetUpdateStatusQueryFn.mockResolvedValue({
			rollout: makeRollout({
				waveSize: 2,
				members: [
					makeMember({ position: 0, state: 'done' }),
					makeMember({
						workerId: 'worker-2',
						displayName: 'grace-box',
						owner: {
							userId: 'u2',
							identifier: 'grace@example.com',
							displayName: 'Grace Hopper',
						},
						position: 1,
						state: 'verifying',
						outcome: 'applied',
					}),
				],
			}),
		});
		renderPanel(<InstallationRolloutPanel />);

		expect(await screen.findByText('ada-laptop')).toBeDefined();
		expect(screen.getByText('Done')).toBeDefined();
		expect(screen.getByText('grace-box')).toBeDefined();
		expect(screen.getByText('grace@example.com')).toBeDefined();
		expect(screen.getByText('Verifying')).toBeDefined();
		// The tally, so a fleet reads without counting rows.
		expect(screen.getByText(/2 machines: 1 Verifying, 1 Done/)).toBeDefined();
	});

	it('reads a machine the rollout could not move as skipped, with its own reason', async () => {
		// A machine enrolled in no project or running under no process supervisor
		// settles `skipped`; calling that `done` would report a fleet as updated when
		// two of its machines are still on the old build.
		fleetUpdateStatusQueryFn.mockResolvedValue({
			rollout: makeRollout({
				members: [
					makeMember({
						state: 'skipped',
						message: 'enrolled in no project, so there is nowhere to record the update',
					}),
				],
			}),
		});
		renderPanel(<InstallationRolloutPanel />);

		expect(await screen.findByText('Skipped')).toBeDefined();
		expect(screen.queryByText('Done')).toBeNull();
		expect(screen.getByText(/enrolled in no project/)).toBeDefined();
	});

	it('names the machine’s own words beside its reported outcome', async () => {
		fleetUpdateStatusQueryFn.mockResolvedValue({
			rollout: makeRollout({
				members: [
					makeMember({
						state: 'failed',
						outcome: 'failed',
						// Cut to its first line here; the tail belongs under the list.
						message: 'npm ci failed\n  npm ERR! code ELIFECYCLE\n  npm ERR! errno 1',
					}),
				],
			}),
		});
		renderPanel(<InstallationRolloutPanel />);

		expect(await screen.findByText('Failed')).toBeDefined();
		expect(screen.getByText('failed: npm ci failed')).toBeDefined();
		expect(screen.queryByText(/ELIFECYCLE/)).toBeNull();
	});

	it('says why a halted rollout stopped, and that there is no resume', async () => {
		fleetUpdateStatusQueryFn.mockResolvedValue({
			rollout: makeRollout({
				status: 'halted',
				haltReason: 'ada-laptop reported failed: npm run build failed',
				members: [makeMember({ state: 'failed', outcome: 'failed' })],
			}),
		});
		renderPanel(<InstallationRolloutPanel />);

		expect(await screen.findByText('Halted')).toBeDefined();
		expect(screen.getByText('ada-laptop reported failed: npm run build failed')).toBeDefined();
		expect(screen.getByText(/no resume/)).toBeDefined();
	});

	it('keeps the server’s own word for a state this build has never heard of', async () => {
		// A newer control plane's eighth state still gets its machine a line — one
		// missing from the readout would read as a machine the rollout never named.
		fleetUpdateStatusQueryFn.mockResolvedValue({
			rollout: makeRollout({ members: [makeMember({ state: 'quarantined' })] }),
		});
		renderPanel(<InstallationRolloutPanel />);

		expect(await screen.findByText('quarantined')).toBeDefined();
		expect(screen.getByText('ada-laptop')).toBeDefined();
	});

	it('lists the machines in the rollout’s own order, not the array’s', async () => {
		fleetUpdateStatusQueryFn.mockResolvedValue({
			rollout: makeRollout({
				members: [
					makeMember({ workerId: 'worker-2', displayName: 'grace-box', position: 1 }),
					makeMember({ position: 0 }),
				],
			}),
		});
		renderPanel(<InstallationRolloutPanel />);

		await screen.findByText('ada-laptop');
		expect(
			screen.getAllByRole('listitem').map((item) => item.querySelector('p')?.textContent),
		).toEqual(['ada-laptop', 'grace-box']);
	});
});

/**
 * A finished rollout has nothing left to watch, so it folds to its own heading — but
 * the fold is a *default*, and the operator's own choice has to outlive the poll that
 * refetches under them.
 */
describe('InstallationRolloutPanel folds a finished rollout away', () => {
	it('collapses a completed rollout to its report heading', async () => {
		fleetUpdateStatusQueryFn.mockResolvedValue({
			rollout: makeRollout({ status: 'completed' }),
		});
		renderPanel(<InstallationRolloutPanel />);

		expect(await screen.findByText('Last fleet update report')).toBeDefined();
		// The machines are folded away, not gone: the heading is the handle to them.
		expect(screen.queryByText('ada-laptop')).toBeNull();
		expect(screen.getByRole('button', { expanded: false })).toBeDefined();
	});

	it('opens a completed rollout again, and folds it back', async () => {
		fleetUpdateStatusQueryFn.mockResolvedValue({
			rollout: makeRollout({ status: 'completed' }),
		});
		renderPanel(<InstallationRolloutPanel />);

		const toggle = await screen.findByRole('button', { expanded: false });
		fireEvent.click(toggle);
		expect(await screen.findByText('ada-laptop')).toBeDefined();

		fireEvent.click(screen.getByRole('button', { expanded: true }));
		expect(screen.queryByText('ada-laptop')).toBeNull();
	});

	it('leaves a rollout that is still moving open', async () => {
		fleetUpdateStatusQueryFn.mockResolvedValue({ rollout: makeRollout() });
		renderPanel(<InstallationRolloutPanel />);

		expect(await screen.findByText('Installation fleet update')).toBeDefined();
		expect(screen.getByText('ada-laptop')).toBeDefined();
	});

	// A halt is the one terminal status somebody still has to act on, so it is never
	// the thing that folds itself out of sight.
	it('leaves a halted rollout open, with its reason showing', async () => {
		fleetUpdateStatusQueryFn.mockResolvedValue({
			rollout: makeRollout({ status: 'halted', haltReason: 'grace-box never came back' }),
		});
		renderPanel(<InstallationRolloutPanel />);

		expect(await screen.findByText('grace-box never came back')).toBeDefined();
		expect(screen.getByText('Installation fleet update')).toBeDefined();
	});
});
