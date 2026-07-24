// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: {
		scm: { verifyGithubToken: { mutate: vi.fn() } },
		projects: {
			credentials: {
				set: { mutate: vi.fn() },
				delete: { mutate: vi.fn() },
			},
		},
	},
	trpc: {
		projects: {
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
	it('renders the Source Control heading with a GitHub provider selector', async () => {
		renderPanel(<CredentialsPanel projectId="proj-a" />);

		await waitFor(() => expect(screen.getByText('Source Control')).not.toBeNull());

		const select = screen.getByLabelText('Provider') as HTMLSelectElement;
		expect(select.value).toBe('github');
		expect(screen.getByRole('option', { name: 'GitHub' })).not.toBeNull();
	});

	it('derives the intro and role copy from the selected GitHub provider, not a hard-coded path', async () => {
		renderPanel(<CredentialsPanel projectId="proj-a" />);

		await waitFor(() => expect(screen.getByText(/SWARM_OPERATOR_GH_TOKEN/)).not.toBeNull());
		expect(screen.getByText(/GitHub personal access token the reviewer persona/)).not.toBeNull();
	});
});
