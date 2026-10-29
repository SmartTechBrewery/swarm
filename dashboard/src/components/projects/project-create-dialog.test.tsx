// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/** A branch answer the test resolves by hand, so two detections can complete out of order. */
function deferredBranch() {
	let resolve!: (answer: { branch: string | null }) => void;
	const promise = new Promise<{ branch: string | null }>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Let a just-resolved detection's `await` continuation run (or be dropped). */
const flush = () => act(async () => {});

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

		// Detections are independent requests and can complete out of order, so the
		// field must belong to the *selected* repo and provider rather than to whichever
		// answer arrives last.
		it("ignores the previous provider's answer when it lands after the new one", async () => {
			createProject.mockResolvedValue({});
			const github = deferredBranch();
			const gitlab = deferredBranch();
			defaultBranchQuery.mockImplementation(({ scm }: { scm: string }) =>
				scm === 'github' ? github.promise : gitlab.promise,
			);
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

			fillRequiredFields();
			fireEvent.blur(screen.getByPlaceholderText('owner/repo'));
			await waitFor(() =>
				expect(defaultBranchQuery).toHaveBeenCalledWith({
					scm: 'github',
					repo: 'team/new-project',
				}),
			);

			fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gitlab' } });
			await waitFor(() =>
				expect(defaultBranchQuery).toHaveBeenCalledWith({
					scm: 'gitlab',
					repo: 'team/new-project',
				}),
			);

			gitlab.resolve({ branch: 'develop' });
			await waitFor(() =>
				expect((screen.getByLabelText(/^Base Branch/) as HTMLInputElement).value).toBe('develop'),
			);

			github.resolve({ branch: 'main' });
			await flush();

			expect((screen.getByLabelText(/^Base Branch/) as HTMLInputElement).value).toBe('develop');
			expect(screen.getByText(/Detected team\/new-project's default branch/)).toBeTruthy();

			fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

			await waitFor(() =>
				expect(createProject).toHaveBeenCalledWith(
					expect.objectContaining({
						repositories: [{ repo: 'team/new-project', baseBranch: 'develop' }],
						scm: 'gitlab',
					}),
				),
			);
		});

		it("ignores a previous repository's late answer and its note", async () => {
			const stale = deferredBranch();
			const current = deferredBranch();
			defaultBranchQuery.mockImplementation(({ repo }: { repo: string }) =>
				repo === 'team/old' ? stale.promise : current.promise,
			);
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

			const repoInput = screen.getByPlaceholderText('owner/repo');
			fireEvent.change(repoInput, { target: { value: 'team/old' } });
			fireEvent.blur(repoInput);
			await waitFor(() =>
				expect(defaultBranchQuery).toHaveBeenCalledWith({ scm: 'github', repo: 'team/old' }),
			);

			fireEvent.change(repoInput, { target: { value: 'team/new' } });
			fireEvent.blur(repoInput);
			await waitFor(() =>
				expect(defaultBranchQuery).toHaveBeenCalledWith({ scm: 'github', repo: 'team/new' }),
			);

			current.resolve({ branch: 'develop' });
			await waitFor(() =>
				expect((screen.getByLabelText(/^Base Branch/) as HTMLInputElement).value).toBe('develop'),
			);

			// The stale detection answering nothing would otherwise replace the current
			// detection's note with a failure naming the repository nobody selected.
			stale.resolve({ branch: null });
			await flush();

			expect((screen.getByLabelText(/^Base Branch/) as HTMLInputElement).value).toBe('develop');
			expect(screen.queryByText(/Couldn't read team\/old's default branch/)).toBeNull();
			expect(screen.getByText(/Detected team\/new's default branch/)).toBeTruthy();
		});

		it('does not query for a repo that is not owner/repo yet', async () => {
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

			fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'team' } });
			fireEvent.blur(screen.getByPlaceholderText('owner/repo'));

			await waitFor(() => expect(defaultBranchQuery).not.toHaveBeenCalled());
		});
	});

	// Issue #1089 phase 6/6: an Azure DevOps repository has three segments, so the Repo
	// field validates per the selected provider's coordinates rather than `owner/repo`.
	describe('Azure DevOps repositories', () => {
		it('autofills an Azure DevOps URL as organization/project/repository and detects under it', async () => {
			createProject.mockResolvedValue({});
			defaultBranchQuery.mockResolvedValue({ branch: 'develop' });
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

			fireEvent.change(screen.getByRole('combobox'), { target: { value: 'azure-devops' } });
			expect(
				screen.getByPlaceholderText('https://dev.azure.com/organization/project/_git/repository'),
			).toBeTruthy();
			const repoInput = screen.getByPlaceholderText(
				'organization/project/repository',
			) as HTMLInputElement;
			expect(repoInput.getAttribute('pattern')).toBe('[^/]+/[^/]+/[^/]+');

			fireEvent.change(screen.getByLabelText('Repository URL'), {
				target: { value: 'https://Fabrikam@dev.azure.com/Fabrikam/Fiber%20Project/_git/Web' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Autofill from repository URL' }));

			expect(repoInput.value).toBe('Fabrikam/Fiber Project/Web');
			await waitFor(() =>
				expect(defaultBranchQuery).toHaveBeenCalledWith({
					scm: 'azure-devops',
					repo: 'Fabrikam/Fiber Project/Web',
				}),
			);
			await waitFor(() =>
				expect((screen.getByLabelText(/^Base Branch/) as HTMLInputElement).value).toBe('develop'),
			);

			fireEvent.change(screen.getByLabelText(/^Repo Local Path/), {
				target: { value: '/work/web' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

			await waitFor(() =>
				expect(createProject).toHaveBeenCalledWith(
					expect.objectContaining({
						repositories: [{ repo: 'Fabrikam/Fiber Project/Web', baseBranch: 'develop' }],
						scm: 'azure-devops',
					}),
				),
			);
		});

		it('does not query for a two-segment repository under Azure DevOps', async () => {
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

			fireEvent.change(screen.getByPlaceholderText('owner/repo'), {
				target: { value: 'team/new-project' },
			});
			fireEvent.change(screen.getByRole('combobox'), { target: { value: 'azure-devops' } });

			await flush();
			expect(defaultBranchQuery).not.toHaveBeenCalled();
		});
	});

	// Issue #1181: autofill used to leave Source Control Provider on its GitHub default, so
	// an Azure DevOps URL filled a three-segment Repo that creation then refused under it.
	describe('provider autofill', () => {
		/** Paste `url` into Repository URL and press autofill. */
		function autofill(url: string) {
			fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: url } });
			fireEvent.click(screen.getByRole('button', { name: 'Autofill from repository URL' }));
		}

		const providerSelect = () => screen.getByRole('combobox') as HTMLSelectElement;

		it('selects the provider an Azure DevOps URL belongs to and creates the project on it', async () => {
			createProject.mockResolvedValue({});
			defaultBranchQuery.mockResolvedValue({ branch: 'develop' });
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);
			expect(providerSelect().value).toBe('github');

			autofill('https://dev.azure.com/core3pl/KV-TMS/_git/VikingKurier');

			expect(providerSelect().value).toBe('azure-devops');
			expect(
				(screen.getByPlaceholderText('organization/project/repository') as HTMLInputElement).value,
			).toBe('core3pl/KV-TMS/VikingKurier');
			// Detection runs under the provider autofill selected, never the one it replaced.
			await waitFor(() =>
				expect(defaultBranchQuery).toHaveBeenCalledWith({
					scm: 'azure-devops',
					repo: 'core3pl/KV-TMS/VikingKurier',
				}),
			);
			expect(defaultBranchQuery).not.toHaveBeenCalledWith(
				expect.objectContaining({ scm: 'github' }),
			);
			await waitFor(() =>
				expect((screen.getByLabelText(/^Base Branch/) as HTMLInputElement).value).toBe('develop'),
			);

			fireEvent.change(screen.getByLabelText(/^Repo Local Path/), {
				target: { value: '/work/viking-kurier' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

			await waitFor(() =>
				expect(createProject).toHaveBeenCalledWith(
					expect.objectContaining({
						repositories: [{ repo: 'core3pl/KV-TMS/VikingKurier', baseBranch: 'develop' }],
						scm: 'azure-devops',
					}),
				),
			);
		});

		it.each([
			['git@bitbucket.org:workspace/repo.git', 'bitbucket'],
			['https://gitlab.com/namespace/project', 'gitlab'],
		])('selects the provider %s belongs to', async (url, provider) => {
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

			autofill(url);

			expect(providerSelect().value).toBe(provider);
			await waitFor(() =>
				expect(defaultBranchQuery).toHaveBeenCalledWith(expect.objectContaining({ scm: provider })),
			);
		});

		it('selects GitHub again for a github.com URL after another provider was chosen', async () => {
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);
			fireEvent.change(providerSelect(), { target: { value: 'gitlab' } });

			autofill('git@github.com:owner/repo.git');

			expect(providerSelect().value).toBe('github');
			await waitFor(() =>
				expect(defaultBranchQuery).toHaveBeenCalledWith({ scm: 'github', repo: 'owner/repo' }),
			);
		});

		it('keeps the selected provider for a host that does not tell which one it is', async () => {
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);
			fireEvent.change(providerSelect(), { target: { value: 'gitlab' } });
			defaultBranchQuery.mockClear();

			autofill('https://gitlab.example.com/group/project.git');

			expect(providerSelect().value).toBe('gitlab');
			expect((screen.getByPlaceholderText('namespace/project') as HTMLInputElement).value).toBe(
				'group/project',
			);
			await waitFor(() =>
				expect(defaultBranchQuery).toHaveBeenCalledWith({ scm: 'gitlab', repo: 'group/project' }),
			);
		});

		it('lets the operator change the provider by hand after autofill', async () => {
			createProject.mockResolvedValue({});
			renderDialog(<ProjectCreateDialog open onOpenChange={vi.fn()} />);

			autofill('https://github.com/owner/repo');
			expect(providerSelect().value).toBe('github');

			fireEvent.change(providerSelect(), { target: { value: 'bitbucket' } });
			expect(providerSelect().value).toBe('bitbucket');
			await waitFor(() =>
				expect(defaultBranchQuery).toHaveBeenCalledWith({ scm: 'bitbucket', repo: 'owner/repo' }),
			);

			fireEvent.change(screen.getByLabelText(/^Repo Local Path/), {
				target: { value: '/work/repo' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

			await waitFor(() =>
				expect(createProject).toHaveBeenCalledWith(
					expect.objectContaining({
						repositories: [{ repo: 'owner/repo', baseBranch: 'main' }],
						scm: 'bitbucket',
					}),
				),
			);
		});
	});
});
