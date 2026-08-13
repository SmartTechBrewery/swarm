// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The panel writes `project.scm` since issue #618, so the project read/update pair
// is part of its trpc surface now. Hoisted so a test can assert what was persisted.
// `credentials.list` is addressed per provider since issue #632, so the fixture is a
// provider → view map and `listedProviderIds` records which ones were queried.
const {
	updateProject,
	projectScm,
	verifyGithubToken,
	verifyGitLabToken,
	setCredential,
	deleteCredential,
	listedProviderIds,
	unservedProviderIds,
	credentialViews,
} = vi.hoisted(() => ({
	updateProject: vi.fn(),
	projectScm: { current: undefined as string | undefined },
	verifyGithubToken: vi.fn(),
	verifyGitLabToken: vi.fn(),
	setCredential: vi.fn(),
	deleteCredential: vi.fn(),
	listedProviderIds: { current: [] as (string | undefined)[] },
	/** Providers this installation serves no credentials for — see the last test. */
	unservedProviderIds: { current: [] as string[] },
	credentialViews: {
		current: {
			// GitHub configured, and — the common case since issue #290 — resolving through
			// reference names that are *not* its manifest's conventional keys.
			github: {
				providerId: 'github',
				providerLabel: 'GitHub',
				providerRegistered: true,
				roles: [
					{
						role: 'reviewer',
						envVarKey: 'GITHUB_TOKEN_REVIEWER',
						referenceKey: 'SCM_TOKEN_REVIEWER',
						isConfigured: true,
						maskedValue: '****',
					},
					{
						role: 'webhookSecret',
						envVarKey: 'GITHUB_WEBHOOK_SECRET',
						referenceKey: 'SCM_WEBHOOK_SECRET',
						isConfigured: true,
						maskedValue: '****',
					},
				],
			},
			// Nothing saved for GitLab yet — the state a first switch lands in.
			gitlab: {
				providerId: 'gitlab',
				providerLabel: 'GitLab',
				providerRegistered: true,
				roles: [
					{
						role: 'reviewer',
						envVarKey: 'GITLAB_TOKEN_REVIEWER',
						referenceKey: 'GITLAB_TOKEN_REVIEWER',
						isConfigured: false,
						maskedValue: 'not set',
					},
					{
						role: 'webhookSecret',
						envVarKey: 'GITLAB_WEBHOOK_SECRET',
						referenceKey: 'GITLAB_WEBHOOK_SECRET',
						isConfigured: false,
						maskedValue: 'not set',
					},
				],
			},
			bitbucket: {
				providerId: 'bitbucket',
				providerLabel: 'Bitbucket Cloud',
				providerRegistered: true,
				roles: [
					{
						role: 'reviewer',
						envVarKey: 'BITBUCKET_TOKEN_REVIEWER',
						referenceKey: 'BITBUCKET_TOKEN_REVIEWER',
						isConfigured: false,
						maskedValue: 'not set',
					},
					{
						role: 'webhookSecret',
						envVarKey: 'BITBUCKET_WEBHOOK_SECRET',
						referenceKey: 'BITBUCKET_WEBHOOK_SECRET',
						isConfigured: false,
						maskedValue: 'not set',
					},
				],
			},
		} as Record<string, unknown>,
	},
}));

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: {
		scm: {
			verifyGithubToken: { mutate: verifyGithubToken },
			verifyBitbucketCredential: { mutate: vi.fn() },
			verifyGitLabToken: { mutate: verifyGitLabToken },
		},
		projects: {
			update: { mutate: updateProject },
			credentials: {
				set: { mutate: setCredential },
				delete: { mutate: deleteCredential },
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
					queryOptions: ({
						projectId,
						providerId,
					}: {
						projectId: string;
						providerId?: string;
					}) => ({
						// The provider is part of the key, which is what makes a switch refetch.
						queryKey: ['projects.credentials.list', projectId, providerId],
						queryFn: () => {
							listedProviderIds.current.push(providerId);
							const view =
								providerId && !unservedProviderIds.current.includes(providerId)
									? credentialViews.current[providerId]
									: undefined;
							return Promise.resolve(
								view ?? {
									providerId: providerId ?? '',
									providerLabel: providerId ?? '',
									providerRegistered: false,
									roles: [],
								},
							);
						},
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
		verifyGithubToken.mockReset();
		verifyGithubToken.mockResolvedValue({ valid: false });
		verifyGitLabToken.mockReset();
		verifyGitLabToken.mockResolvedValue({ valid: true, login: 'reviewer-bot' });
		setCredential.mockReset();
		setCredential.mockResolvedValue(undefined);
		deleteCredential.mockReset();
		deleteCredential.mockResolvedValue(undefined);
		listedProviderIds.current = [];
		unservedProviderIds.current = [];
		projectScm.current = undefined;
	});

	it('shows an unset provider as unsaved and persists a GitHub selection', async () => {
		renderPanel(<CredentialsPanel projectId="proj-a" />);

		await waitFor(() => expect(screen.getByText('Source Control')).not.toBeNull());

		const select = screen.getByLabelText('Provider') as HTMLSelectElement;
		expect(select.value).toBe('');
		expect(screen.getByText(/No provider is saved/)).not.toBeNull();
		expect(screen.getByRole('option', { name: 'GitHub' })).not.toBeNull();
		expect(screen.getByRole('option', { name: 'Bitbucket Cloud' })).not.toBeNull();
		expect(screen.getByRole('option', { name: 'GitLab' })).not.toBeNull();

		fireEvent.change(select, { target: { value: 'github' } });
		await waitFor(() =>
			expect(updateProject).toHaveBeenCalledWith({ id: 'proj-a', scm: 'github' }),
		);
	});

	it('derives the intro and role copy from the selected GitHub provider, not a hard-coded path', async () => {
		projectScm.current = 'github';
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
		projectScm.current = 'github';
		renderPanel(<CredentialsPanel projectId="proj-a" />);
		await waitFor(() => expect(screen.getByLabelText('Provider')).not.toBeNull());

		fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'bitbucket' } });

		await waitFor(() =>
			expect(updateProject).toHaveBeenCalledWith({ id: 'proj-a', scm: 'bitbucket' }),
		);
		expect(screen.getByText(/SWARM_OPERATOR_BITBUCKET_TOKEN/)).not.toBeNull();
	});

	// Issue #734: this write shares `projects.update` with the Source Control tab's
	// Repositories Save (and every other route-level write), so it must be disabled —
	// not just by its own `providerMutation.isPending` — while any of those is in flight,
	// or the two can land on the same read-merge-upsert and clobber each other.
	it('stays disabled and does not fire its write while an external config write is in flight', async () => {
		projectScm.current = 'github';
		renderPanel(<CredentialsPanel projectId="proj-a" externalWriteInFlight={true} />);

		const select = (await screen.findByLabelText('Provider')) as HTMLSelectElement;
		expect(select.disabled).toBe(true);

		fireEvent.change(select, { target: { value: 'bitbucket' } });
		expect(updateProject).not.toHaveBeenCalled();
	});

	// The route folds this write's own pending state into its single serialization gate
	// (`isConfigWriteInFlight` in `$projectId.tsx`) via this callback.
	it('reports its own write pending state up on every change', async () => {
		projectScm.current = 'github';
		const onProviderWriteChange = vi.fn();
		renderPanel(
			<CredentialsPanel projectId="proj-a" onProviderWriteChange={onProviderWriteChange} />,
		);
		await waitFor(() => expect(screen.getByLabelText('Provider')).not.toBeNull());
		onProviderWriteChange.mockClear();

		fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'bitbucket' } });

		expect(onProviderWriteChange).toHaveBeenCalledWith(true);
		await waitFor(() => expect(onProviderWriteChange).toHaveBeenCalledWith(false));
	});

	// Issue #619 made GitLab selectable too, which means Verify has to reach *its*
	// procedure: there is no project yet to resolve a provider from, so the panel
	// dispatches on the selected id (`src/api/routers/scm.ts`).
	it('verifies a reviewer secret against the selected provider’s own procedure', async () => {
		projectScm.current = 'gitlab';
		renderPanel(<CredentialsPanel projectId="proj-a" />);

		await waitFor(() => expect(screen.getByText(/SWARM_OPERATOR_GITLAB_TOKEN/)).not.toBeNull());

		fireEvent.change(screen.getByLabelText('Reviewer Access Token value'), {
			target: { value: 'glpat-secret' },
		});
		fireEvent.click(screen.getAllByRole('button', { name: /Verify/ })[0]);

		await waitFor(() => expect(verifyGitLabToken).toHaveBeenCalledWith({ token: 'glpat-secret' }));
		expect(verifyGithubToken).not.toHaveBeenCalled();
		expect(await screen.findByText(/Verified as @reviewer-bot/)).not.toBeNull();
	});

	// Issue #632: the fields belong to the selected provider, and the key each one names
	// is the one this project *resolves* it through — showing the manifest's conventional
	// `envVarKey` instead would tell the operator to set a variable nothing here reads.
	it('names the key the credential resolves through, not the provider’s conventional one', async () => {
		projectScm.current = 'github';
		renderPanel(<CredentialsPanel projectId="proj-a" />);

		await waitFor(() => expect(screen.getByText('Reviewer PAT')).not.toBeNull());
		expect(screen.getByText('SCM_TOKEN_REVIEWER')).not.toBeNull();
		expect(screen.queryByText('GITHUB_TOKEN_REVIEWER')).toBeNull();
		expect(listedProviderIds.current).toContain('github');
	});

	it('requeries on a provider switch and renders the new provider’s own state', async () => {
		projectScm.current = 'github';
		renderPanel(<CredentialsPanel projectId="proj-a" />);
		await waitFor(() => expect(screen.getByText('Reviewer PAT')).not.toBeNull());

		fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'gitlab' } });

		// GitLab's own label, its own reference names, and its own (unconfigured) state —
		// the outgoing provider's configured fields are gone rather than relabelled.
		await waitFor(() => expect(screen.getByText('Reviewer Access Token')).not.toBeNull());
		expect(listedProviderIds.current).toEqual(['github', 'gitlab']);
		expect(screen.getByText('GITLAB_TOKEN_REVIEWER')).not.toBeNull();
		expect(screen.getByText('Secret Token')).not.toBeNull();
		expect(screen.queryByText('Reviewer PAT')).toBeNull();
		expect(screen.queryByText('SCM_TOKEN_REVIEWER')).toBeNull();
		// Unconfigured, so the input is revealed rather than a masked preview.
		expect(screen.getByLabelText('Reviewer Access Token value')).not.toBeNull();
	});

	// Both providers spell the roles the same way, so the fields have to be remounted per
	// provider: otherwise switching back finds GitHub's configured credential rendered as
	// an open input still holding the value typed for GitLab.
	it('carries nothing from one provider’s field into another’s on a switch back', async () => {
		projectScm.current = 'github';
		renderPanel(<CredentialsPanel projectId="proj-a" />);
		await waitFor(() => expect(screen.getByText('Reviewer PAT')).not.toBeNull());
		// Configured: collapsed to a masked preview, with no input revealed.
		expect(screen.queryByLabelText('Reviewer PAT value')).toBeNull();

		fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'gitlab' } });
		await waitFor(() =>
			expect(screen.getByLabelText('Reviewer Access Token value')).not.toBeNull(),
		);
		fireEvent.change(screen.getByLabelText('Reviewer Access Token value'), {
			target: { value: 'glpat-secret' },
		});
		fireEvent.click(screen.getAllByRole('button', { name: /Verify/ })[0]);
		await waitFor(() => expect(screen.getByText(/Verified as @reviewer-bot/)).not.toBeNull());

		// Back to GitHub — served from cache, so no loading state remounts the fields for us.
		fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'github' } });

		await waitFor(() => expect(screen.getByText('Reviewer PAT')).not.toBeNull());
		expect(screen.queryByLabelText('Reviewer PAT value')).toBeNull();
		expect(screen.queryByDisplayValue('glpat-secret')).toBeNull();
		expect(screen.queryByText(/reviewer-bot/)).toBeNull();
	});

	it('saves by naming (provider, role) and never a secret-store key', async () => {
		projectScm.current = 'gitlab';
		renderPanel(<CredentialsPanel projectId="proj-a" />);
		await waitFor(() =>
			expect(screen.getByLabelText('Reviewer Access Token value')).not.toBeNull(),
		);

		fireEvent.change(screen.getByLabelText('Reviewer Access Token value'), {
			target: { value: 'glpat-secret ' },
		});
		fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);

		await waitFor(() =>
			expect(setCredential).toHaveBeenCalledWith({
				projectId: 'proj-a',
				providerId: 'gitlab',
				role: 'reviewer',
				value: 'glpat-secret',
			}),
		);
	});

	it('removes by naming (provider, role), showing the resolved key in the confirmation', async () => {
		projectScm.current = 'github';
		renderPanel(<CredentialsPanel projectId="proj-a" />);
		await waitFor(() => expect(screen.getByText('Reviewer PAT')).not.toBeNull());

		fireEvent.click(screen.getByRole('button', { name: 'Remove Reviewer PAT' }));
		const confirmation = await screen.findByText(/This clears the stored secret for/);
		expect(confirmation.textContent).toContain('Reviewer PAT');
		expect(confirmation.textContent).toContain('SCM_TOKEN_REVIEWER');
		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

		await waitFor(() =>
			expect(deleteCredential).toHaveBeenCalledWith({
				projectId: 'proj-a',
				providerId: 'github',
				role: 'reviewer',
			}),
		);
	});

	// The selector's catalogue is hand-kept in the browser bundle, so it can name a
	// provider this installation has not registered as runtime-ready.
	it('reports a provider the server serves no credentials for', async () => {
		projectScm.current = 'github';
		unservedProviderIds.current = ['github'];
		renderPanel(<CredentialsPanel projectId="proj-a" />);

		await waitFor(() =>
			expect(screen.getByText(/No integration is registered for provider/)).not.toBeNull(),
		);
		expect(screen.queryByText('Reviewer PAT')).toBeNull();
	});
});
