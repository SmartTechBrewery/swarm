import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Info, RefreshCw } from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_SCM_PROVIDER_ID, SCM_PROVIDERS, type ScmProviderId } from '@/lib/credentials.js';
import { parseRepoUrl } from '@/lib/parse-repo-url.js';
import { DEFAULT_BASE_BRANCH } from '@/lib/project-repository.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { Modal, ModalFooter } from '../ui/modal.js';

/** `owner/repo` — the shape both the Repo input's own `pattern` and `scm.defaultBranch` require. */
const REPO_SLUG = /^[^/]+\/[^/]+$/;

interface ProjectCreateDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function ProjectCreateDialog({ open, onOpenChange }: ProjectCreateDialogProps) {
	const queryClient = useQueryClient();
	const [id, setId] = useState('');
	const [name, setName] = useState('');
	const [repo, setRepo] = useState('');
	const [baseBranch, setBaseBranch] = useState(DEFAULT_BASE_BRANCH);
	const [repoRoot, setRepoRoot] = useState('');
	const [scm, setScm] = useState<ScmProviderId>(DEFAULT_SCM_PROVIDER_ID);
	const [repoUrl, setRepoUrl] = useState('');
	const [urlError, setUrlError] = useState('');
	const [baseBranchNote, setBaseBranchNote] = useState('');
	const [baseBranchDetectionFailed, setBaseBranchDetectionFailed] = useState(false);
	const [showPathHelp, setShowPathHelp] = useState(false);

	/**
	 * Whether the operator has typed in the Base Branch field. A ref rather than state
	 * because nothing renders it and {@link detectBaseBranch} reads it *after* an await:
	 * a detection that started before the first keystroke must still not overwrite what
	 * was typed while it was in flight (issue #884).
	 */
	const baseBranchTouched = useRef(false);

	// Close the path-help popover on Escape without also dismissing the whole
	// Modal. The Modal registers a bubble-phase window keydown listener that
	// closes it on Escape (ui/modal.tsx); registering here in the capture phase
	// runs first, and stopImmediatePropagation() prevents the Modal's listener
	// from firing so only the popover closes.
	useEffect(() => {
		if (!showPathHelp) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopImmediatePropagation();
				setShowPathHelp(false);
			}
		};
		window.addEventListener('keydown', onKey, { capture: true });
		return () => window.removeEventListener('keydown', onKey, { capture: true });
	}, [showPathHelp]);

	const mutation = useMutation({
		mutationFn: (newProject: {
			id: string;
			name: string;
			repositories: Array<{ repo: string; baseBranch: string }>;
			repoRoot: string;
			scm: ScmProviderId;
		}) => trpcClient.projects.create.mutate(newProject),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: trpc.projects.list.queryOptions().queryKey,
			});
			setId('');
			setName('');
			setRepo('');
			setBaseBranch(DEFAULT_BASE_BRANCH);
			baseBranchTouched.current = false;
			setBaseBranchNote('');
			setBaseBranchDetectionFailed(false);
			setRepoRoot('');
			setScm(DEFAULT_SCM_PROVIDER_ID);
			setRepoUrl('');
			setUrlError('');
			setShowPathHelp(false);
			onOpenChange(false);
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		// A new project starts on one repository; further ones are added afterwards on the
		// Source Control tab's repository list (issues #684 phase 3, #729), so this stays
		// single-entry rather than growing a second form. Its base branch is submitted
		// explicitly (issue #883): the create schema would otherwise fill in
		// `PROJECT_DEFAULTS.baseBranch` unseen, so a repository whose default branch is not
		// `main` was silently configured against a branch nobody chose. `branchPrefix` keeps
		// taking that default — a task branch prefix is SWARM's own naming convention rather
		// than a property of the repository, so nothing about it can be silently wrong.
		mutation.mutate({ id, name, repositories: [{ repo, baseBranch }], repoRoot, scm });
	};

	const handleClose = () => {
		mutation.reset();
		setRepoUrl('');
		setUrlError('');
		setBaseBranchNote('');
		setBaseBranchDetectionFailed(false);
		setShowPathHelp(false);
		onOpenChange(false);
	};

	/**
	 * Pre-fill Base Branch with the repository's *real* default branch (issue #884), so
	 * a project created for a repository whose default is `develop` operates on
	 * `develop` from the start instead of on the `main` this field starts with.
	 *
	 * Never blocks or fails creation: a repository the installation's credential cannot
	 * read — and a transport failure, which takes the same path as `{ branch: null }` —
	 * leaves the field's current value alone and says so, because the operator can fix
	 * a wrong branch and cannot fix a refused dialog.
	 *
	 * `repoSlug` and `provider` are arguments rather than state reads: `handleAutofill`
	 * calls this in the same tick it sets `repo`, before that state has re-rendered.
	 */
	const detectBaseBranch = async (repoSlug: string, provider: ScmProviderId) => {
		if (!REPO_SLUG.test(repoSlug) || baseBranchTouched.current) return;
		setBaseBranchDetectionFailed(false);
		setBaseBranchNote(`Reading ${repoSlug}'s default branch…`);
		try {
			const { branch } = await trpcClient.scm.defaultBranch.query({
				scm: provider,
				repo: repoSlug,
			});
			if (baseBranchTouched.current) return;
			if (branch) {
				setBaseBranch(branch);
				setBaseBranchNote(`Detected ${repoSlug}'s default branch.`);
				return;
			}
		} catch {
			// Same degraded outcome as an answer naming no branch — see above.
		}
		if (baseBranchTouched.current) return;
		setBaseBranchDetectionFailed(true);
		setBaseBranchNote(
			`Couldn't read ${repoSlug}'s default branch — using ${baseBranch}. Change it if that's wrong.`,
		);
	};

	const handleAutofill = () => {
		if (!repoUrl) {
			setUrlError('Please enter a repository URL.');
			return;
		}
		const parsed = parseRepoUrl(repoUrl);
		if (parsed) {
			setId(parsed.id);
			setName(parsed.name);
			setRepo(parsed.repo);
			setUrlError('');
			void detectBaseBranch(parsed.repo, scm);
		} else {
			setUrlError('Invalid repository URL format.');
		}
	};

	return (
		<Modal open={open} onClose={handleClose} title="New Project">
			<form onSubmit={handleSubmit} className="space-y-4">
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div className="md:col-span-2">
						<label htmlFor="project-url" className="block text-xs font-medium text-zinc-400 mb-1">
							Repository URL
						</label>
						<div className="flex gap-2 items-center">
							<input
								type="text"
								id="project-url"
								value={repoUrl}
								onChange={(e) => {
									setRepoUrl(e.target.value);
									setUrlError('');
								}}
								placeholder="https://github.com/owner/repo"
								className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono"
							/>
							<button
								type="button"
								onClick={handleAutofill}
								className="text-zinc-500 hover:text-violet-400 p-1.5 rounded hover:bg-zinc-800/60 transition-colors shrink-0"
								aria-label="Autofill from repository URL"
							>
								<RefreshCw className="w-4 h-4" />
							</button>
						</div>
						{urlError && <p className="mt-1 text-xs text-red-400">{urlError}</p>}
					</div>
					<div>
						<label htmlFor="project-id" className="block text-xs font-medium text-zinc-400 mb-1">
							ID <span className="text-red-500">*</span>
						</label>
						<input
							type="text"
							id="project-id"
							value={id}
							onChange={(e) => setId(e.target.value)}
							required
							pattern="[a-z0-9-]+"
							placeholder="my-project"
							className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono"
						/>
					</div>
					<div>
						<label htmlFor="project-name" className="block text-xs font-medium text-zinc-400 mb-1">
							Name <span className="text-red-500">*</span>
						</label>
						<input
							type="text"
							id="project-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
							placeholder="My Project"
							className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
						/>
					</div>
					<div>
						<label htmlFor="project-repo" className="block text-xs font-medium text-zinc-400 mb-1">
							Repo <span className="text-red-500">*</span>
						</label>
						<input
							type="text"
							id="project-repo"
							value={repo}
							onChange={(e) => setRepo(e.target.value)}
							onBlur={() => void detectBaseBranch(repo, scm)}
							required
							pattern="[^/]+/[^/]+"
							placeholder="owner/repo"
							className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono"
						/>
					</div>
					<div>
						<label
							htmlFor="project-base-branch"
							className="block text-xs font-medium text-zinc-400 mb-1"
						>
							Base Branch <span className="text-red-500">*</span>
						</label>
						<input
							type="text"
							id="project-base-branch"
							value={baseBranch}
							onChange={(e) => {
								baseBranchTouched.current = true;
								setBaseBranch(e.target.value);
							}}
							required
							placeholder="main"
							className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono"
						/>
						<p className="mt-1 text-xs text-zinc-500">
							Task branches are cut from this branch and pull requests target it. Editable later on
							the project's Source Control tab.
						</p>
						{baseBranchNote && (
							<p
								className={`mt-1 text-xs ${baseBranchDetectionFailed ? 'text-amber-300/80' : 'text-zinc-400'}`}
							>
								{baseBranchNote}
							</p>
						)}
					</div>
					<div>
						<label htmlFor="project-scm" className="block text-xs font-medium text-zinc-400 mb-1">
							Source Control Provider <span className="text-red-500">*</span>
						</label>
						<select
							id="project-scm"
							value={scm}
							onChange={(e) => {
								// A repo slug means different things to different providers, so a
								// provider change invalidates a detection made under the old one.
								const next = e.target.value as ScmProviderId;
								setScm(next);
								void detectBaseBranch(repo, next);
							}}
							className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
						>
							{SCM_PROVIDERS.map((provider) => (
								<option key={provider.id} value={provider.id} disabled={!provider.available}>
									{provider.label}
								</option>
							))}
						</select>
					</div>
					<div>
						<div className="relative flex items-center gap-1.5 mb-1">
							<label htmlFor="project-reporoot" className="block text-xs font-medium text-zinc-400">
								Repo Local Path <span className="text-red-500">*</span>
							</label>
							<button
								type="button"
								onClick={() => setShowPathHelp((v) => !v)}
								className="text-zinc-500 hover:text-violet-400 p-0.5 rounded hover:bg-zinc-800/60 transition-colors"
								aria-label="How to find the repo's local path"
								aria-expanded={showPathHelp}
							>
								<Info className="w-3.5 h-3.5" />
							</button>

							{showPathHelp && (
								<>
									{/* Click-outside backdrop */}
									<button
										type="button"
										className="fixed inset-0 z-40 cursor-default focus:outline-none"
										onClick={() => setShowPathHelp(false)}
										aria-label="Close help"
									/>

									{/* The actual popover */}
									<div className="absolute left-0 md:left-auto md:right-0 top-full mt-2 z-50 w-72 bg-zinc-900 border border-zinc-850 rounded-lg shadow-2xl p-4 animate-in fade-in slide-in-from-top-2 duration-150">
										<h4 className="text-xs font-semibold text-zinc-300 mb-3 tracking-wide uppercase">
											Find your repo's local path
										</h4>
										<div className="space-y-3 text-left text-xs text-zinc-400">
											<div>
												<p className="text-zinc-300 mb-1">macOS / Linux</p>
												<p>
													<code className="font-mono text-zinc-200 bg-zinc-950 px-1 py-0.5 rounded">
														cd
													</code>{' '}
													into the repo, then run{' '}
													<code className="font-mono text-zinc-200 bg-zinc-950 px-1 py-0.5 rounded">
														pwd
													</code>{' '}
													and copy the output.
												</p>
											</div>
											<div>
												<p className="text-zinc-300 mb-1">Windows (PowerShell)</p>
												<p>
													<code className="font-mono text-zinc-200 bg-zinc-950 px-1 py-0.5 rounded">
														cd
													</code>{' '}
													into the repo, then run{' '}
													<code className="font-mono text-zinc-200 bg-zinc-950 px-1 py-0.5 rounded">
														pwd
													</code>{' '}
													and copy the output.
												</p>
											</div>
											<div>
												<p className="text-zinc-300 mb-1">Windows (Command Prompt)</p>
												<p>
													<code className="font-mono text-zinc-200 bg-zinc-950 px-1 py-0.5 rounded">
														cd
													</code>{' '}
													into the repo, then run{' '}
													<code className="font-mono text-zinc-200 bg-zinc-950 px-1 py-0.5 rounded">
														cd
													</code>{' '}
													with no arguments or{' '}
													<code className="font-mono text-zinc-200 bg-zinc-950 px-1 py-0.5 rounded">
														echo %cd%
													</code>
													.
												</p>
											</div>
										</div>
									</div>
								</>
							)}
						</div>
						<input
							type="text"
							id="project-reporoot"
							value={repoRoot}
							onChange={(e) => setRepoRoot(e.target.value)}
							required
							placeholder="/Users/you/code/my-repo"
							className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono"
						/>
					</div>
				</div>

				{mutation.isError && (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						{mutation.error.message}
					</div>
				)}

				<ModalFooter
					primary={
						<button
							type="submit"
							disabled={mutation.isPending}
							className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{mutation.isPending ? 'Creating…' : 'Create Project'}
						</button>
					}
					secondary={
						<button
							type="button"
							onClick={handleClose}
							className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors"
						>
							Cancel
						</button>
					}
				/>
			</form>
		</Modal>
	);
}
