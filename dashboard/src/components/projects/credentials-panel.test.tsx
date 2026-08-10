// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The panel writes `project.scm` since issue #618, so the project read/update pair
// is part of its trpc surface now. Hoisted so a test can assert what was persisted.
const { updateProject, projectScm } = vi.hoisted(() => ({
	updateProject: vi.fn(),
	projectScm: { current: undefined as string | undefined },
}));

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: {
		scm: {
			verifyGithubToken: { mutate: vi.fn() },
			verifyBitbucketCredential: { mutate: vi.fn() },
		},
		projects: {
			update: { mutate: updateProject },
			credentials: {
				set: { mutate: vi.fn() },
				delete: { mutate: vi.fn() },
			},
		},
	},
	trpc: {
		projects: {
			list: { queryOptions: () => ({ queryKey: ['projects.list'] }) },
			getById: {
				queryOptions: ({ id }: { id: string }) => ({
					queryKey: ['projects.getById', id],
					queryFn: () => Promise.resolve({ id, scm: projectScm.current }),
				}),
			},
			credentials: {
				list: {
					queryOptions: ({ projectId }: { projectId: string }) => ({
						queryKey: ['projects.credentials.list', projectId],
						queryFn: () =>
							Promise.resolve([
								{
									role: 'reviewer' as const,
									envVarKey: 'REVIEWER_PAT',
									isConfigured: false,
									maskedValue: 'not set',
								},
								{
									role: 'webhookSecret' as const,
									envVarKey: 'WEBHOOK_SECRET',
									isConfigured: false,
									maskedValue: 'not set',
								},
							]),
					}),
				},
			},
		},
	},
}));

import { CredentialsPanel } from './credentials-panel.js';

function renderPanel(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('CredentialsPanel (issue #200 — Source Control tab)', () => {
	beforeEach(() => {
		updateProject.mockReset();
		updateProject.mockResolvedValue({});
		projectScm.current = undefined;
	});

	it('renders the Source Control heading with a provider selector', async () => {
		renderPanel(<CredentialsPanel projectId="proj-a" />);

		await waitFor(() => expect(screen.getByText('Source Control')).not.toBeNull());

		const select = screen.getByLabelText('Provider') as HTMLSelectElement;
		expect(select.value).toBe('github');
		expect(screen.getByRole('option', { name: 'GitHub' })).not.toBeNull();
		expect(screen.getByRole('option', { name: 'Bitbucket Cloud' })).not.toBeNull();
	});

	it('derives the intro and role copy from the selected GitHub provider, not a hard-coded path', async () => {
		renderPanel(<CredentialsPanel projectId="proj-a" />);

		await waitFor(() => expect(screen.getByText(/SWARM_OPERATOR_GH_TOKEN/)).not.toBeNull());
		expect(screen.getByText(/GitHub personal access token the reviewer persona/)).not.toBeNull();
	});

	// The selector was UI-only when it landed; issue #618 made it the operator's way
	// to put a project on Bitbucket without hand-editing `swarm.config.json`.
	it('seeds the selector from the project’s stored provider', async () => {
		projectScm.current = 'bitbucket';
		renderPanel(<CredentialsPanel projectId="proj-a" />);

		await waitFor(() =>
			expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('bitbucket'),
		);
		expect(screen.getByText(/SWARM_OPERATOR_BITBUCKET_TOKEN/)).not.toBeNull();
	});

	it('persists a picked provider to project.scm and switches the copy', async () => {
		renderPanel(<CredentialsPanel projectId="proj-a" />);
		await waitFor(() => expect(screen.getByLabelText('Provider')).not.toBeNull());

		fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'bitbucket' } });

		await waitFor(() =>
			expect(updateProject).toHaveBeenCalledWith({ id: 'proj-a', scm: 'bitbucket' }),
		);
		expect(screen.getByText(/SWARM_OPERATOR_BITBUCKET_TOKEN/)).not.toBeNull();
	});
});
