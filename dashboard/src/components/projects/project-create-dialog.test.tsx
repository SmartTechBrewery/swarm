// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { createProject } = vi.hoisted(() => ({ createProject: vi.fn() }));

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: {
		projects: {
			create: { mutate: createProject },
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

describe('ProjectCreateDialog', () => {
	it('sends the selected SCM provider when creating a project', async () => {
		createProject.mockResolvedValue({});
		renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

		fireEvent.change(screen.getByLabelText(/^ID/), { target: { value: 'new-project' } });
		fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'New Project' } });
		fireEvent.change(screen.getByPlaceholderText('owner/repo'), {
			target: { value: 'team/new-project' },
		});
		fireEvent.change(screen.getByLabelText(/^Repo Local Path/), {
			target: { value: '/work/new-project' },
		});
		fireEvent.change(screen.getByRole('combobox'), {
			target: { value: 'bitbucket' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

		await waitFor(() =>
			expect(createProject).toHaveBeenCalledWith({
				id: 'new-project',
				name: 'New Project',
				repositories: [{ repo: 'team/new-project' }],
				repoRoot: '/work/new-project',
				scm: 'bitbucket',
			}),
		);
	});
});
