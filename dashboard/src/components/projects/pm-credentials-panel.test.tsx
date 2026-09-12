// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listPmFn, setPmMutate, deletePmMutate } = vi.hoisted(() => ({
	listPmFn: vi.fn(),
	setPmMutate: vi.fn(),
	deletePmMutate: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: {
		projects: {
			credentials: {
				setPm: { mutate: setPmMutate },
				deletePm: { mutate: deletePmMutate },
			},
		},
	},
	trpc: {
		projects: {
			credentials: {
				listPm: {
					queryOptions: (args: { projectId: string; providerId?: string }) => ({
						queryKey: ['projects.credentials.listPm', args],
						queryFn: () => listPmFn(args),
					}),
				},
			},
		},
		pm: {
			// The panel invalidates every `pm` discovery query after a write, by path.
			pathFilter: () => ({ queryKey: [['pm']] }),
		},
	},
}));

import { PmCredentialsPanel } from './pm-credentials-panel.js';

const API_TOKEN_ROLE = {
	role: 'apiToken',
	label: 'GitHub Projects API Token',
	description: 'Needs repo, project and read:org.',
	envVarKey: 'PM_GITHUB_PROJECTS_TOKEN',
	referenceKey: 'PM_GITHUB_PROJECTS_TOKEN',
	optional: false,
	isConfigured: false,
	maskedValue: 'not set',
};

// An inherited role as the server still reports it: it resolves through the project's
// shared `GITHUB_WEBHOOK_SECRET` rather than the neutral `SCM_WEBHOOK_SECRET` the
// manifest declares. Kept in the default `view()` so the omission below (issue #902) is
// asserted against the real response shape rather than against an empty one.
const WEBHOOK_ROLE = {
	role: 'webhookSecret',
	label: 'Webhook Secret',
	description: 'HMAC secret GitHub signs board deliveries with.',
	envVarKey: 'SCM_WEBHOOK_SECRET',
	referenceKey: 'GITHUB_WEBHOOK_SECRET',
	optional: false,
	inheritsSharedCredential: 'webhookSecret',
	isConfigured: true,
	maskedValue: '****',
};

function view(roles: unknown[] = [API_TOKEN_ROLE, WEBHOOK_ROLE]) {
	return {
		providerId: 'github-projects',
		providerLabel: 'GitHub Projects',
		providerRegistered: true,
		roles,
	};
}

function renderPanel(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('PmCredentialsPanel (issue #537 — Project Management credentials)', () => {
	beforeEach(() => {
		listPmFn.mockReset();
		setPmMutate.mockReset();
		deletePmMutate.mockReset();
	});

	it("renders the provider's declared roles with their own labels and guidance", async () => {
		listPmFn.mockResolvedValue(view());

		renderPanel(<PmCredentialsPanel projectId="proj-a" providerId="github-projects" />);

		await waitFor(() => expect(screen.getByText('GitHub Projects API Token')).not.toBeNull());
		expect(screen.getByText('Needs repo, project and read:org.')).not.toBeNull();
		expect(screen.getByText('PM_GITHUB_PROJECTS_TOKEN')).not.toBeNull();
		// This role resolves through the provider's own default, so the card gains no
		// key-divergence note — the common case stays noise-free (issue #630).
		expect(screen.queryByText(/not the provider's default/)).toBeNull();
		// Provider terminology comes from the server, not from a table in the dashboard.
		expect(screen.getByText(/GitHub Projects authenticates/)).not.toBeNull();
	});

	it('explains a non-inherited role whose resolved key diverges from the default', async () => {
		listPmFn.mockResolvedValue(
			view([{ ...API_TOKEN_ROLE, referenceKey: 'GH_PROJECTS_PAT' }, WEBHOOK_ROLE]),
		);

		renderPanel(<PmCredentialsPanel projectId="proj-a" providerId="github-projects" />);

		await waitFor(() => expect(screen.getByText('GH_PROJECTS_PAT')).not.toBeNull());
		expect(
			screen.getByText(
				/resolves it through GH_PROJECTS_PAT, not the provider's default PM_GITHUB_PROJECTS_TOKEN/,
			),
		).not.toBeNull();
	});

	it('warns that discovery needs the unconfigured required role', async () => {
		listPmFn.mockResolvedValue(view());

		renderPanel(<PmCredentialsPanel projectId="proj-a" providerId="github-projects" />);

		await waitFor(() =>
			expect(screen.getByText(/Board discovery and every board read\/write need/)).not.toBeNull(),
		);
	});

	it('posts a plaintext value once, keyed by role rather than by store key', async () => {
		listPmFn.mockResolvedValue(view());
		setPmMutate.mockResolvedValue(undefined);

		renderPanel(<PmCredentialsPanel projectId="proj-a" providerId="github-projects" />);

		const input = (await waitFor(() =>
			screen.getByLabelText('GitHub Projects API Token value'),
		)) as HTMLInputElement;
		// The secret is never rendered back: the field is a password input.
		expect(input.type).toBe('password');

		fireEvent.change(input, { target: { value: '  ghp_board_token  ' } });
		fireEvent.click(screen.getByText('Save'));

		await waitFor(() =>
			expect(setPmMutate).toHaveBeenCalledWith({
				projectId: 'proj-a',
				providerId: 'github-projects',
				role: 'apiToken',
				// Trimmed — a pasted token routinely carries surrounding whitespace.
				value: 'ghp_board_token',
			}),
		);
	});

	// Issue #902: the response still carries the inherited role (the server reports it,
	// with `inheritsSharedCredential` set) — nothing about it may reach this tab. It *is*
	// the Source Control tab's credential, and mirroring it here was the second place an
	// operator read a value only that tab can fix (the confusion traced in issue #900).
	it('omits an inherited role entirely rather than mirroring it read-only', async () => {
		listPmFn.mockResolvedValue(view());

		renderPanel(<PmCredentialsPanel projectId="proj-a" providerId="github-projects" />);

		await waitFor(() => expect(screen.getByText('GitHub Projects API Token')).not.toBeNull());
		expect(screen.queryByText('Webhook Secret')).toBeNull();
		expect(screen.queryByText('GITHUB_WEBHOOK_SECRET')).toBeNull();
		expect(screen.queryByText(/configured on the Source Control tab/)).toBeNull();
		expect(screen.queryByLabelText('Webhook Secret value')).toBeNull();
		expect(screen.queryByLabelText('Remove Webhook Secret')).toBeNull();
	});

	it('clears a configured role through the confirmation modal', async () => {
		listPmFn.mockResolvedValue(
			view([{ ...API_TOKEN_ROLE, isConfigured: true, maskedValue: '****' }]),
		);
		deletePmMutate.mockResolvedValue(undefined);

		renderPanel(<PmCredentialsPanel projectId="proj-a" providerId="github-projects" />);

		fireEvent.click(await waitFor(() => screen.getByLabelText('Remove GitHub Projects API Token')));
		fireEvent.click(await waitFor(() => screen.getByText('Remove')));

		await waitFor(() =>
			expect(deletePmMutate).toHaveBeenCalledWith({
				projectId: 'proj-a',
				providerId: 'github-projects',
				role: 'apiToken',
			}),
		);
	});

	// Issue #642: mid-switch the tab hands down the *draft* provider, so the panel reads
	// and writes that provider's own block — the outgoing provider's is never addressed.
	it('reads and writes the provider it is handed, not the persisted one', async () => {
		listPmFn.mockResolvedValue({
			providerId: 'linear',
			providerLabel: 'Linear',
			providerRegistered: true,
			roles: [
				{
					role: 'apiKey',
					label: 'Linear API Key',
					envVarKey: 'LINEAR_API_KEY',
					referenceKey: 'LINEAR_API_KEY',
					optional: false,
					isConfigured: false,
					maskedValue: 'not set',
				},
			],
		});
		setPmMutate.mockResolvedValue(undefined);

		renderPanel(<PmCredentialsPanel projectId="proj-a" providerId="linear" />);

		await waitFor(() =>
			expect(listPmFn).toHaveBeenCalledWith({ projectId: 'proj-a', providerId: 'linear' }),
		);
		fireEvent.change(await waitFor(() => screen.getByLabelText('Linear API Key value')), {
			target: { value: 'lin_api_key' },
		});
		fireEvent.click(screen.getByText('Save'));

		await waitFor(() =>
			expect(setPmMutate).toHaveBeenCalledWith({
				projectId: 'proj-a',
				providerId: 'linear',
				role: 'apiKey',
				value: 'lin_api_key',
			}),
		);
	});

	it('surfaces a failed load without claiming there are no credentials', async () => {
		listPmFn.mockRejectedValue(new Error('boom'));

		renderPanel(<PmCredentialsPanel projectId="proj-a" providerId="github-projects" />);

		await waitFor(() =>
			expect(screen.getByText(/Failed to load project-management credentials/)).not.toBeNull(),
		);
	});
});
