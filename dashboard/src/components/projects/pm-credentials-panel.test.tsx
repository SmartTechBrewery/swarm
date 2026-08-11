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
					queryOptions: (args: { projectId: string }) => ({
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

// The shape issue #630 reports: the role inherits the shared SCM reference, so it
// resolves through the project's `GITHUB_WEBHOOK_SECRET` rather than the neutral
// `SCM_WEBHOOK_SECRET` the manifest declares. The description is the provider's own.
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

		renderPanel(<PmCredentialsPanel projectId="proj-a" />);

		await waitFor(() => expect(screen.getByText('GitHub Projects API Token')).not.toBeNull());
		expect(screen.getByText('Needs repo, project and read:org.')).not.toBeNull();
		expect(screen.getByText('PM_GITHUB_PROJECTS_TOKEN')).not.toBeNull();
		// This role resolves through the provider's own default, so the card gains no
		// key-divergence note — the common case stays noise-free (issue #630).
		expect(screen.queryByText(/not the provider's default/)).toBeNull();
		// Provider terminology comes from the server, not from a table in the dashboard.
		expect(screen.getByText(/GitHub Projects authenticates/)).not.toBeNull();
	});

	// Issue #630: the panel used to print the manifest's declared `envVarKey`, telling
	// the operator to set a variable nothing in the installation reads.
	it('names the key an inherited role actually resolves through', async () => {
		listPmFn.mockResolvedValue(view());

		renderPanel(<PmCredentialsPanel projectId="proj-a" />);

		await waitFor(() => expect(screen.getByText('GITHUB_WEBHOOK_SECRET')).not.toBeNull());
		expect(screen.queryByText('SCM_WEBHOOK_SECRET')).toBeNull();
		// The resolved key and where it lives, plus the provider's own rationale for the
		// sharing — which stays manifest copy rather than entering this component.
		expect(
			screen.getByText(
				/resolves it through GITHUB_WEBHOOK_SECRET, configured on the Source Control/,
			),
		).not.toBeNull();
		expect(screen.getByText(/HMAC secret GitHub signs board deliveries with/)).not.toBeNull();
	});

	it('explains a non-inherited role whose resolved key diverges from the default', async () => {
		listPmFn.mockResolvedValue(
			view([{ ...API_TOKEN_ROLE, referenceKey: 'GH_PROJECTS_PAT' }, WEBHOOK_ROLE]),
		);

		renderPanel(<PmCredentialsPanel projectId="proj-a" />);

		await waitFor(() => expect(screen.getByText('GH_PROJECTS_PAT')).not.toBeNull());
		expect(
			screen.getByText(
				/resolves it through GH_PROJECTS_PAT, not the provider's default PM_GITHUB_PROJECTS_TOKEN/,
			),
		).not.toBeNull();
	});

	it('warns that discovery needs the unconfigured required role', async () => {
		listPmFn.mockResolvedValue(view());

		renderPanel(<PmCredentialsPanel projectId="proj-a" />);

		await waitFor(() =>
			expect(screen.getByText(/Board discovery and every board read\/write need/)).not.toBeNull(),
		);
	});

	it('posts a plaintext value once, keyed by role rather than by store key', async () => {
		listPmFn.mockResolvedValue(view());
		setPmMutate.mockResolvedValue(undefined);

		renderPanel(<PmCredentialsPanel projectId="proj-a" />);

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
				role: 'apiToken',
				// Trimmed — a pasted token routinely carries surrounding whitespace.
				value: 'ghp_board_token',
			}),
		);
	});

	it('renders an inherited role read-only, pointing at where it is configured', async () => {
		listPmFn.mockResolvedValue(view());

		renderPanel(<PmCredentialsPanel projectId="proj-a" />);

		await waitFor(() => expect(screen.getByText('Webhook Secret')).not.toBeNull());
		expect(screen.getByText(/configured on the Source Control tab/)).not.toBeNull();
		expect(screen.queryByLabelText('Webhook Secret value')).toBeNull();
		expect(screen.queryByLabelText('Remove Webhook Secret')).toBeNull();
	});

	it('clears a configured role through the confirmation modal', async () => {
		listPmFn.mockResolvedValue(
			view([{ ...API_TOKEN_ROLE, isConfigured: true, maskedValue: '****' }]),
		);
		deletePmMutate.mockResolvedValue(undefined);

		renderPanel(<PmCredentialsPanel projectId="proj-a" />);

		fireEvent.click(await waitFor(() => screen.getByLabelText('Remove GitHub Projects API Token')));
		fireEvent.click(await waitFor(() => screen.getByText('Remove')));

		await waitFor(() =>
			expect(deletePmMutate).toHaveBeenCalledWith({ projectId: 'proj-a', role: 'apiToken' }),
		);
	});

	it('surfaces a failed load without claiming there are no credentials', async () => {
		listPmFn.mockRejectedValue(new Error('boom'));

		renderPanel(<PmCredentialsPanel projectId="proj-a" />);

		await waitFor(() =>
			expect(screen.getByText(/Failed to load project-management credentials/)).not.toBeNull(),
		);
	});
});
