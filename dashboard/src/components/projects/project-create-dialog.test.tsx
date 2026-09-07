// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createProject, defaultBranchQuery } = vi.hoisted(() => ({
	createProject: vi.fn(),
	defaultBranchQuery: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: {
		projects: {
			create: { mutate: createProject },
		},
		scm: {
			defaultBranch: { query: defaultBranchQuery },
		},
	},
	trpc: {
		projects: {
			list: { queryOptions: () => ({ queryKey: ['projects.list'] }) },
		},
	},
}));

import { ProjectCreateDialog } from './project-create-dialog.js';

function renderDialog(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

/** Fill everything the form requires, leaving the pre-filled base branch alone. */
function fillRequiredFields() {
	fireEvent.change(screen.getByLabelText(/^ID/), { target: { value: 'new-project' } });
	fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'New Project' } });
	fireEvent.change(screen.getByPlaceholderText('owner/repo'), {
		target: { value: 'team/new-project' },
	});
	fireEvent.change(screen.getByLabelText(/^Repo Local Path/), {
		target: { value: '/work/new-project' },
	});
}

describe('ProjectCreateDialog', () => {
	beforeEach(() => {
		createProject.mockReset();
		// Detection answering nothing is the neutral default: it leaves the field alone,
		// so a test that is not about the pre-fill sees phase 1's behaviour unchanged.
		defaultBranchQuery.mockReset();
		defaultBranchQuery.mockResolvedValue({ branch: null });
	});

	it('sends the selected SCM provider when creating a project', async () => {
		createProject.mockResolvedValue({});
		renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

		fillRequiredFields();
		fireEvent.change(screen.getByRole('combobox'), {
			target: { value: 'bitbucket' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

		await waitFor(() =>
			expect(createProject).toHaveBeenCalledWith({
				id: 'new-project',
				name: 'New Project',
				repositories: [{ repo: 'team/new-project', baseBranch: 'main' }],
				repoRoot: '/work/new-project',
				scm: 'bitbucket',
			}),
		);
	});

	it('pre-fills the base branch so the operator sees what the project will use', () => {
		renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

		const input = screen.getByLabelText(/^Base Branch/) as HTMLInputElement;
		expect(input.value).toBe('main');
	});

	it('submits an operator-chosen base branch instead of the default', async () => {
		createProject.mockResolvedValue({});
		renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

		fillRequiredFields();
		fireEvent.change(screen.getByLabelText(/^Base Branch/), { target: { value: 'develop' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

		await waitFor(() =>
			expect(createProject).toHaveBeenCalledWith(
				expect.objectContaining({
					repositories: [{ repo: 'team/new-project', baseBranch: 'develop' }],
				}),
			),
		);
	});

	// Issue #884: the value the field starts on is the repository's *real* default
	// branch, read once the operator has named a repository — so a project for a
	// `develop` repository is created against `develop` with no manual edit.
	describe('base-branch detection', () => {
		it("pre-fills and submits the repository's detected default branch", async () => {
			createProject.mockResolvedValue({});
			defaultBranchQuery.mockResolvedValue({ branch: 'develop' });
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

			fillRequiredFields();
			fireEvent.blur(screen.getByPlaceholderText('owner/repo'));

			await waitFor(() =>
				expect((screen.getByLabelText(/^Base Branch/) as HTMLInputElement).value).toBe('develop'),
			);
			expect(defaultBranchQuery).toHaveBeenCalledWith({
				scm: 'github',
				repo: 'team/new-project',
			});
			expect(screen.getByText(/Detected team\/new-project's default branch/)).toBeTruthy();

			fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

			await waitFor(() =>
				expect(createProject).toHaveBeenCalledWith(
					expect.objectContaining({
						repositories: [{ repo: 'team/new-project', baseBranch: 'develop' }],
					}),
				),
			);
		});

		// The read failing must never fail creation: the field keeps the value it had and
		// the dialog says which branch it settled on.
		it('keeps the current value and states the read failed when the branch cannot be read', async () => {
			createProject.mockResolvedValue({});
			defaultBranchQuery.mockResolvedValue({ branch: null });
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

			fillRequiredFields();
			fireEvent.blur(screen.getByPlaceholderText('owner/repo'));

			await waitFor(() =>
				expect(screen.getByText(/Couldn't read team\/new-project's default branch/)).toBeTruthy(),
			);
			expect((screen.getByLabelText(/^Base Branch/) as HTMLInputElement).value).toBe('main');

			fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

			await waitFor(() =>
				expect(createProject).toHaveBeenCalledWith(
					expect.objectContaining({
						repositories: [{ repo: 'team/new-project', baseBranch: 'main' }],
					}),
				),
			);
		});

		// A transport failure is the same degraded outcome as an answer naming no branch.
		it('treats a rejected query as an unreadable branch rather than surfacing an error', async () => {
			defaultBranchQuery.mockRejectedValue(new Error('offline'));
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

			fillRequiredFields();
			fireEvent.blur(screen.getByPlaceholderText('owner/repo'));

			await waitFor(() =>
				expect(screen.getByText(/Couldn't read team\/new-project's default branch/)).toBeTruthy(),
			);
			expect((screen.getByLabelText(/^Base Branch/) as HTMLInputElement).value).toBe('main');
		});

		it('does not overwrite a branch the operator has already typed', async () => {
			defaultBranchQuery.mockResolvedValue({ branch: 'develop' });
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

			fillRequiredFields();
			fireEvent.change(screen.getByLabelText(/^Base Branch/), { target: { value: 'release' } });
			fireEvent.blur(screen.getByPlaceholderText('owner/repo'));

			await waitFor(() => expect(defaultBranchQuery).not.toHaveBeenCalled());
			expect((screen.getByLabelText(/^Base Branch/) as HTMLInputElement).value).toBe('release');
		});

		// A repo slug means different things to different providers, so a provider change
		// invalidates a detection made under the old one.
		it('re-detects under the newly selected provider', async () => {
			defaultBranchQuery.mockResolvedValue({ branch: 'develop' });
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

			fillRequiredFields();
			fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gitlab' } });

			await waitFor(() =>
				expect(defaultBranchQuery).toHaveBeenCalledWith({
					scm: 'gitlab',
					repo: 'team/new-project',
				}),
			);
		});

		it('does not query for a repo that is not owner/repo yet', async () => {
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

			fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'team' } });
			fireEvent.blur(screen.getByPlaceholderText('owner/repo'));

			await waitFor(() => expect(defaultBranchQuery).not.toHaveBeenCalled());
		});
	});
});
