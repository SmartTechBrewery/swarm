// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { projectsListQueryFn, enrollMutate } = vi.hoisted(() => ({
	projectsListQueryFn: vi.fn(),
	enrollMutate: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		projects: {
			list: {
				queryOptions: () => ({ queryKey: ['projects.list'], queryFn: projectsListQueryFn }),
			},
		},
	},
	trpcClient: {
		workers: { enroll: { mutate: enrollMutate } },
	},
}));

import { WorkerEnrollDialog } from './worker-enroll-dialog.js';

const PROJECTS = [
	{ id: 'proj-a', name: 'Widgets', repositories: [{ repo: 'acme/frontend' }] },
	{ id: 'proj-b', name: 'Rover', repositories: [{ repo: 'acme/rover' }] },
];

const onOpenChange = vi.fn();
const onChanged = vi.fn();

function renderDialog(
	overrides: Partial<Parameters<typeof WorkerEnrollDialog>[0]> = {},
): ReturnType<typeof render> {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<WorkerEnrollDialog
				open
				onOpenChange={onOpenChange}
				workerId="worker-1"
				workerName="ada-laptop"
				capabilities={['claude', 'codex']}
				enrolledProjectIds={[]}
				onChanged={onChanged}
				{...overrides}
			/>
		</QueryClientProvider>,
	);
}

/** The project picker, once its options have arrived. */
async function projectSelect(): Promise<HTMLSelectElement> {
	const select = screen.getByLabelText(/^Project/) as HTMLSelectElement;
	await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
	return select;
}

async function pickProject(projectId: string): Promise<void> {
	fireEvent.change(await projectSelect(), { target: { value: projectId } });
}

function submit(): void {
	fireEvent.click(screen.getByRole('button', { name: 'Enroll worker' }));
}

beforeEach(() => {
	projectsListQueryFn.mockReset();
	projectsListQueryFn.mockResolvedValue(PROJECTS);
	enrollMutate.mockReset();
	enrollMutate.mockResolvedValue({});
	onOpenChange.mockReset();
	onChanged.mockReset();
});

describe('WorkerEnrollDialog project picker (issue #764)', () => {
	it('offers only accessible projects the worker is not already enrolled in', async () => {
		renderDialog({ enrolledProjectIds: ['proj-a'] });

		const select = await projectSelect();
		const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
		expect(options).toEqual(['Select a project…', 'Rover — acme/rover']);
	});

	it('names each project’s repository, so a mismatch is avoidable before submitting', async () => {
		renderDialog();

		const select = await projectSelect();
		expect(select.textContent).toContain('Widgets — acme/frontend');
	});

	it('says so — and disables submit — when every accessible project is already enrolled', async () => {
		renderDialog({ enrolledProjectIds: ['proj-a', 'proj-b'] });

		expect(
			await screen.findByText('This machine is already enrolled in every project you can see.'),
		).toBeDefined();
		expect(
			(screen.getByRole('button', { name: 'Enroll worker' }) as HTMLButtonElement).disabled,
		).toBe(true);
		submit();
		expect(enrollMutate).not.toHaveBeenCalled();
	});

	it('distinguishes having no projects at all from having enrolled in them all', async () => {
		projectsListQueryFn.mockResolvedValue([]);
		renderDialog();

		expect(
			await screen.findByText(
				'You are not a member of any project yet, so there is nothing to offer this machine to.',
			),
		).toBeDefined();
	});

	it('states a failed project lookup rather than rendering an empty picker', async () => {
		projectsListQueryFn.mockRejectedValue(new Error('Network down'));
		renderDialog();

		expect(await screen.findByText(/Could not load your projects: Network down/)).toBeDefined();
	});
});

describe('WorkerEnrollDialog submission', () => {
	it('sends the worker, project and every declared CLI, with no concurrency and no phases', async () => {
		renderDialog();
		await pickProject('proj-b');
		submit();

		await waitFor(() =>
			expect(enrollMutate).toHaveBeenCalledWith({
				workerId: 'worker-1',
				projectId: 'proj-b',
				allowedClis: ['claude', 'codex'],
			}),
		);
	});

	it('sends the concurrency allocation when one is entered', async () => {
		renderDialog();
		await pickProject('proj-a');
		fireEvent.change(screen.getByLabelText('Concurrency allocation'), { target: { value: '3' } });
		submit();

		await waitFor(() =>
			expect(enrollMutate).toHaveBeenCalledWith({
				workerId: 'worker-1',
				projectId: 'proj-a',
				allowedClis: ['claude', 'codex'],
				concurrencyAllocation: 3,
			}),
		);
	});

	it('rejects a non-positive allocation client-side instead of sending it', async () => {
		renderDialog();
		await pickProject('proj-a');
		fireEvent.change(screen.getByLabelText('Concurrency allocation'), { target: { value: '0' } });

		expect(screen.getByText(/Enter a whole number of 1 or more/)).toBeDefined();
		expect(
			(screen.getByRole('button', { name: 'Enroll worker' }) as HTMLButtonElement).disabled,
		).toBe(true);
		submit();
		expect(enrollMutate).not.toHaveBeenCalled();
	});

	it('sends only the CLIs left checked', async () => {
		renderDialog();
		await pickProject('proj-a');
		fireEvent.click(screen.getByRole('checkbox', { name: 'codex' }));
		submit();

		await waitFor(() =>
			expect(enrollMutate).toHaveBeenCalledWith({
				workerId: 'worker-1',
				projectId: 'proj-a',
				allowedClis: ['claude'],
			}),
		);
	});

	it('offers exactly the declared capabilities as CLI checkboxes, all checked', async () => {
		renderDialog({ capabilities: ['claude'] });

		const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
		expect(checkboxes.map((box) => box.checked)).toEqual([true]);
		expect(screen.queryByRole('checkbox', { name: 'codex' })).toBeNull();
	});

	it('disables submit when no CLI is left checked, rather than sending an empty set', async () => {
		renderDialog();
		await pickProject('proj-a');
		fireEvent.click(screen.getByRole('checkbox', { name: 'claude' }));
		fireEvent.click(screen.getByRole('checkbox', { name: 'codex' }));

		expect(
			(screen.getByRole('button', { name: 'Enroll worker' }) as HTMLButtonElement).disabled,
		).toBe(true);
		submit();
		expect(enrollMutate).not.toHaveBeenCalled();
	});

	it('explains a machine that declared no CLI and offers no submit', async () => {
		renderDialog({ capabilities: [] });

		expect(screen.getByText(/has not declared any agent CLI/)).toBeDefined();
		expect(
			(screen.getByRole('button', { name: 'Enroll worker' }) as HTMLButtonElement).disabled,
		).toBe(true);
		submit();
		expect(enrollMutate).not.toHaveBeenCalled();
	});

	it('closes and refetches once the enrollment lands', async () => {
		renderDialog();
		await pickProject('proj-a');
		submit();

		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(onChanged).toHaveBeenCalled();
		expect(enrollMutate).toHaveBeenCalledTimes(1);
	});

	it('says the enrollment starts pending with sharing off', () => {
		renderDialog();

		expect(screen.getByText(/awaiting approval/)).toBeDefined();
		expect(screen.getByText(/sharing off/)).toBeDefined();
	});
});

describe('WorkerEnrollDialog rejections (surfaced inline, verbatim)', () => {
	it('shows the allowed-CLIs-not-capable message and keeps the dialog open', async () => {
		enrollMutate.mockRejectedValue(
			new Error(
				"Worker 'ada-laptop' cannot run: antigravity. Declared capabilities: claude, codex.",
			),
		);
		renderDialog();
		await pickProject('proj-a');
		submit();

		expect(
			await screen.findByText(
				"Worker 'ada-laptop' cannot run: antigravity. Declared capabilities: claude, codex.",
			),
		).toBeDefined();
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Enroll worker' })).toBeDefined();
	});

	it('shows the repository-mismatch message', async () => {
		enrollMutate.mockRejectedValue(
			new Error(
				"Worker 'ada-laptop' is checked out from acme/frontend, but project 'proj-b' is acme/rover.",
			),
		);
		renderDialog();
		await pickProject('proj-b');
		submit();

		expect(
			await screen.findByText(
				"Worker 'ada-laptop' is checked out from acme/frontend, but project 'proj-b' is acme/rover.",
			),
		).toBeDefined();
	});

	it('shows the duplicate-enrollment CONFLICT', async () => {
		enrollMutate.mockRejectedValue(new Error('This worker is already enrolled in this project.'));
		renderDialog();
		await pickProject('proj-a');
		submit();

		expect(
			await screen.findByText('This worker is already enrolled in this project.'),
		).toBeDefined();
	});

	it('drops a stale rejection when the dialog is dismissed', async () => {
		enrollMutate.mockRejectedValue(new Error('This worker is already enrolled in this project.'));
		renderDialog();
		await pickProject('proj-a');
		submit();
		await screen.findByText('This worker is already enrolled in this project.');

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		await waitFor(() =>
			expect(screen.queryByText('This worker is already enrolled in this project.')).toBeNull(),
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
