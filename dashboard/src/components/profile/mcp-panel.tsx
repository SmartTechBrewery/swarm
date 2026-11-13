import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, ShieldOff } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Badge } from '@/components/ui/badge.js';
import { buttonClass } from '@/components/ui/button.js';
import { claudeCodeMcpCommand, mcpServerUrl } from '@/lib/agent-access.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import {
	type AgentAccessToken,
	hasAgentAccessTokenExpired,
	type IssueAgentAccessTokenInput,
	IssueAgentAccessTokenInputSchema,
	type IssuedAgentAccessToken,
} from '../../../../src/identity/agent-access-token.js';

/**
 * The profile's **MCP** tab (issue #1362): the signed-in user's own agent access
 * tokens — the list, issuing a new one with the one-time reveal of its raw value
 * and a ready `claude mcp add` command for this installation, and revoking one
 * after a confirmation. Ported from Under Control's „Dostęp agenta” screen, whose
 * behaviour it matches. Since issue #1457 every signed-in user may hold tokens, each
 * acting with exactly its holder's project roles.
 *
 * Shown only to those who may hold tokens (`isProfileTabVisibleTo`,
 * `lib/profile-nav.ts`); the `agentAccessTokens` API refuses everyone else too, so
 * the tab is never a promise the server would not keep.
 *
 * **The raw token lives in this panel's state and nowhere else**, and only while
 * the reveal is open: Close clears that state and resets the issuing mutation,
 * whose `gcTime: 0` then drops it from the mutation cache as well. The list never
 * carries it — its shape has no such field.
 *
 * **Scoped agent credentials** (issue #1386): the form's optional project picker
 * limits a token to the checked projects by sending `projectIds`; with none checked
 * the field is omitted and the token keeps its holder's full access. Every token's
 * scope is stated on its row and in the reveal, so a scoped one is told apart — and
 * revoked — on its own. A scope cannot be edited: issue a new token, revoke the old.
 */

const CARD_CLASS = 'border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm';
const LABEL_CLASS = 'block text-xs font-medium text-zinc-400 mb-1';
const INPUT_CLASS =
	'block w-full min-w-0 flex-[1_1_200px] px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed';
const ERROR_CLASS = 'p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded';
const CODE_CLASS =
	'block font-mono text-xs text-zinc-100 bg-zinc-900 border border-zinc-800 rounded p-3 break-all whitespace-pre-wrap';

function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString();
}

function formatDateTime(iso: string): string {
	return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/** A token's scope as a label: its project ids, or every project its holder reaches. */
function scopeLabel(projectIds: string[] | undefined): string {
	return projectIds === undefined ? 'All projects' : `Scoped: ${projectIds.join(', ')}`;
}

/**
 * A dialog whose overlay **closes nothing** — neither a click beside the card nor
 * Escape — so a stray click cannot throw away a token nobody has copied yet. Each
 * dialog states its own way out as a button.
 */
function Dialog({ id, title, children }: { id: string; title: string; children: ReactNode }) {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
			<div
				id={id}
				role="dialog"
				aria-modal="true"
				aria-labelledby={`${id}-title`}
				className="w-full max-w-lg max-h-full overflow-y-auto rounded-lg border border-zinc-800 bg-panel p-6 shadow-2xl space-y-4"
			>
				<h2 id={`${id}-title`} className="text-sm font-semibold text-zinc-200">
					{title}
				</h2>
				{children}
			</div>
		</div>
	);
}

type CopyStatus = 'token' | 'command' | 'failed' | null;

const COPY_STATUS_MESSAGE: Record<Exclude<CopyStatus, null>, string> = {
	token: 'Token copied',
	command: 'Command copied',
	failed: 'Could not copy — select the text and copy it manually.',
};

/**
 * The one moment the raw token is visible, together with the command connecting
 * Claude Code to **this** installation's MCP server. Nothing anywhere offers to
 * show the value again — the server keeps a hash alone.
 */
function IssuedTokenDialog({
	issued,
	onClose,
}: {
	issued: IssuedAgentAccessToken;
	onClose: () => void;
}) {
	const command = claudeCodeMcpCommand(mcpServerUrl(window.location.origin), issued.token);
	const [copyStatus, setCopyStatus] = useState<CopyStatus>(null);

	// A missing `navigator.clipboard` (an insecure origin) throws on the call just as
	// a refused permission rejects — both end in the same invitation to copy by hand.
	const copy = async (value: string, kind: 'token' | 'command') => {
		try {
			await navigator.clipboard.writeText(value);
			setCopyStatus(kind);
		} catch {
			setCopyStatus('failed');
		}
	};

	return (
		<Dialog id="mcp-issued-dialog" title="Token issued">
			<p className="text-xs font-semibold text-zinc-200">
				This is the only time this token is shown. Copy it now — once this window is closed it
				cannot be shown again.
			</p>

			<div className="space-y-1.5">
				<p className={LABEL_CLASS}>Token</p>
				<code id="mcp-issued-token" className={CODE_CLASS}>
					{issued.token}
				</code>
				<button
					type="button"
					onClick={() => void copy(issued.token, 'token')}
					className={buttonClass('secondary', 'sm')}
				>
					<Copy className="h-4 w-4 text-violet-400" aria-hidden="true" />
					Copy token
				</button>
			</div>

			<div className="space-y-1.5">
				<p className={LABEL_CLASS}>Command for Claude Code</p>
				<pre id="mcp-issued-command" className={CODE_CLASS}>
					{command}
				</pre>
				<button
					type="button"
					onClick={() => void copy(command, 'command')}
					className={buttonClass('secondary', 'sm')}
				>
					<Copy className="h-4 w-4 text-violet-400" aria-hidden="true" />
					Copy command
				</button>
			</div>

			<div className="space-y-1.5">
				<p className={LABEL_CLASS}>Scope</p>
				<p id="mcp-issued-scope" className="text-xs text-zinc-300">
					{issued.projectIds === undefined
						? 'All projects — the token acts with your full access.'
						: `Limited to ${issued.projectIds.join(', ')} — the token reaches only these projects, with the read tools and the recovery tools alone.`}
				</p>
			</div>

			<p className="text-xs text-zinc-500">
				The token works only on the installation that issued it.
			</p>

			{/* In the tree from the start, so a screen reader hears every change of it. */}
			<div role="status" className="empty:hidden">
				{copyStatus !== null && (
					<p
						className={
							copyStatus === 'failed'
								? 'text-xs font-semibold text-red-400'
								: 'text-xs font-semibold text-emerald-400'
						}
					>
						{COPY_STATUS_MESSAGE[copyStatus]}
					</p>
				)}
			</div>

			<div className="flex justify-end">
				<button type="button" onClick={onClose} className={buttonClass('primary', 'sm')}>
					Close
				</button>
			</div>
		</Dialog>
	);
}

/** The confirmation before a revoke, which cannot be undone. A refusal stays in it. */
function RevokeTokenDialog({
	token,
	error,
	isSubmitting,
	onCancel,
	onConfirm,
}: {
	token: AgentAccessToken;
	error: string | null;
	isSubmitting: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	return (
		<Dialog id="mcp-revoke-dialog" title="Revoke token?">
			<p className="text-xs text-zinc-300">
				The agent using the token “{token.name}” will be rejected by the MCP server immediately.
				This cannot be undone.
			</p>
			<div role="status" className="empty:hidden">
				{error !== null && <p className={ERROR_CLASS}>{error}</p>}
			</div>
			<div className="flex flex-row-reverse gap-2">
				<button
					type="button"
					onClick={onConfirm}
					disabled={isSubmitting}
					aria-busy={isSubmitting}
					className={buttonClass('danger', 'sm')}
				>
					{isSubmitting ? 'Revoking…' : 'Revoke token'}
				</button>
				<button type="button" onClick={onCancel} className={buttonClass('secondary', 'sm')}>
					Cancel
				</button>
			</div>
		</Dialog>
	);
}

/** One of the viewer's tokens: its name, its dates, and the revoke. */
function TokenRow({
	token,
	now,
	onRevoke,
}: {
	token: AgentAccessToken;
	now: number;
	onRevoke: (token: AgentAccessToken) => void;
}) {
	const expired = hasAgentAccessTokenExpired(token, now);

	return (
		<li className="border border-zinc-800 rounded-lg bg-panel/20 p-4 flex flex-wrap items-center justify-between gap-3">
			<div className="min-w-0 space-y-1">
				<div className="flex flex-wrap items-center gap-2">
					<p className="text-sm font-semibold text-zinc-200 break-words">{token.name}</p>
					<Badge>{scopeLabel(token.projectIds)}</Badge>
					{expired && <Badge tone="negative">Expired</Badge>}
				</div>
				<p className="text-xs text-zinc-500">
					Issued {formatDate(token.createdAt)} · {expired ? 'Expired' : 'Expires'}{' '}
					{formatDateTime(token.expiresAt)} ·{' '}
					{token.lastUsedAt === undefined
						? 'Not used yet'
						: `Last used ${formatDateTime(token.lastUsedAt)}`}
				</p>
			</div>
			<button
				type="button"
				onClick={() => onRevoke(token)}
				aria-label={`Revoke token ${token.name}`}
				className={buttonClass('dangerOutline', 'sm')}
			>
				<ShieldOff className="h-4 w-4" aria-hidden="true" />
				Revoke
			</button>
		</li>
	);
}

const CHECKBOX_CLASS =
	'h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-violet-600 focus:ring-1 focus:ring-violet-500 disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * The issue form's optional project picker: the projects the viewer can see
 * (`projects.list`), any of which limits the token to them. Its loading and
 * failure say what an issue made meanwhile gets — a full-access token — rather
 * than blocking the form, since no project is needed to issue one.
 */
function ProjectScopePicker({
	projects,
	loading,
	loadError,
	selected,
	disabled,
	onChange,
}: {
	projects: { id: string; name: string }[];
	loading: boolean;
	loadError: string | null;
	selected: string[];
	disabled: boolean;
	onChange: (projectIds: string[]) => void;
}) {
	const toggle = (projectId: string) =>
		onChange(
			selected.includes(projectId)
				? selected.filter((id) => id !== projectId)
				: projects.map((p) => p.id).filter((id) => id === projectId || selected.includes(id)),
		);

	return (
		<fieldset className="mt-4" aria-describedby="mcp-scope-help">
			<legend className={LABEL_CLASS}>Limit to projects (optional)</legend>
			<p id="mcp-scope-help" className="text-xs text-zinc-500 mb-2">
				Leave every project unchecked for a token with your full access. Check some to issue a
				scoped agent credential: it reaches only those projects, with the read tools and the
				recovery tools alone. You can limit a token only to projects where you hold at least the
				member role.
			</p>
			{loading ? (
				<p className="text-xs text-zinc-500">Loading projects…</p>
			) : loadError !== null ? (
				<p className={ERROR_CLASS}>
					Projects could not be loaded ({loadError}). A token issued now has your full access.
				</p>
			) : projects.length === 0 ? (
				<p className="text-xs text-zinc-500">There is no project to limit a token to.</p>
			) : (
				<div className="flex flex-wrap gap-x-4 gap-y-2">
					{projects.map((project) => (
						<label
							key={project.id}
							className="inline-flex items-center gap-2 text-sm text-zinc-300"
						>
							<input
								type="checkbox"
								checked={selected.includes(project.id)}
								disabled={disabled}
								onChange={() => toggle(project.id)}
								className={CHECKBOX_CLASS}
							/>
							<span>{project.name}</span>
							<span className="font-mono text-xs text-zinc-500">{project.id}</span>
						</label>
					))}
				</div>
			)}
		</fieldset>
	);
}

function LoadingSkeleton() {
	return (
		<div data-testid="mcp-skeleton" aria-busy="true" className="space-y-3 animate-pulse">
			<div className="h-24 rounded-lg bg-zinc-900" />
			{[0, 1, 2].map((row) => (
				<div key={row} className="h-16 rounded-lg bg-zinc-900" />
			))}
		</div>
	);
}

export function McpPanel() {
	const queryClient = useQueryClient();
	const listQueryOptions = trpc.agentAccessTokens.list.queryOptions();
	const read = useQuery(listQueryOptions);
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const invalidateList = () =>
		queryClient.invalidateQueries({ queryKey: listQueryOptions.queryKey });

	const issue = useMutation({
		mutationFn: (input: IssueAgentAccessTokenInput) =>
			trpcClient.agentAccessTokens.issue.mutate(input),
		// The answer carries the raw token: once the reveal is closed and the
		// mutation reset, nothing may keep it in the cache.
		gcTime: 0,
		onSuccess: () => invalidateList(),
	});
	const revoke = useMutation({
		mutationFn: (tokenId: string) => trpcClient.agentAccessTokens.revoke.mutate({ tokenId }),
		onSuccess: () => invalidateList(),
	});

	const [name, setName] = useState('');
	const [scopeProjectIds, setScopeProjectIds] = useState<string[]>([]);
	const [issueError, setIssueError] = useState<string | null>(null);
	const [issued, setIssued] = useState<IssuedAgentAccessToken | null>(null);
	const [revoking, setRevoking] = useState<AgentAccessToken | null>(null);
	const [revokeError, setRevokeError] = useState<string | null>(null);

	if (read.isPending) return <LoadingSkeleton />;

	if (read.isError) {
		return (
			<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex flex-col items-start gap-2">
				<h2 className="text-sm font-semibold text-red-200">Agent access tokens are unavailable</h2>
				<p className="text-xs text-red-400/80 font-mono">{read.error.message}</p>
				<button
					type="button"
					onClick={() => void read.refetch()}
					disabled={read.isFetching}
					className={buttonClass('secondary', 'sm')}
				>
					{read.isFetching ? 'Retrying…' : 'Retry'}
				</button>
			</div>
		);
	}

	const tokens = read.data;
	const now = Date.now();

	// The shared input schema settles a blank name, so nothing is sent; any other
	// refusal is the server's own sentence, with the name kept.
	const submitIssue = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (issue.isPending) return;

		// No project checked omits `projectIds`, which is what keeps the token full-access:
		// the schema refuses an empty list rather than reading it as either.
		const parsed = IssueAgentAccessTokenInputSchema.safeParse(
			scopeProjectIds.length === 0 ? { name } : { name, projectIds: scopeProjectIds },
		);
		if (!parsed.success) {
			setIssueError(parsed.error.issues[0]?.message ?? 'A token name is required.');
			return;
		}

		setIssueError(null);
		issue.mutate(parsed.data, {
			onSuccess: (token) => {
				setName('');
				setScopeProjectIds([]);
				setIssued(token);
			},
			onError: (error) => setIssueError(error.message),
		});
	};

	const closeIssued = () => {
		setIssued(null);
		issue.reset();
	};

	const openRevoke = (token: AgentAccessToken) => {
		setRevokeError(null);
		setRevoking(token);
	};

	const confirmRevoke = () => {
		if (revoking === null || revoke.isPending) return;
		revoke.mutate(revoking.id, {
			onSuccess: () => setRevoking(null),
			onError: (error) => setRevokeError(error.message),
		});
	};

	return (
		<div className="space-y-6">
			<div>
				<h2 className="text-lg font-semibold text-zinc-100">MCP</h2>
				<p className="text-xs text-zinc-500 mt-1">
					Tokens your agent uses to connect to this installation's MCP server. A token acts with
					your own project roles, so it reaches nothing you could not reach yourself. Each token
					expires by itself, and a revoked one stops working immediately.
				</p>
			</div>

			<form onSubmit={submitIssue} noValidate className={CARD_CLASS}>
				<label htmlFor="mcp-token-name" className={LABEL_CLASS}>
					Token name
				</label>
				<div className="flex flex-wrap gap-2">
					<input
						id="mcp-token-name"
						type="text"
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="e.g. office laptop"
						aria-describedby={issueError === null ? undefined : 'mcp-issue-error'}
						className={INPUT_CLASS}
					/>
					<button
						type="submit"
						disabled={issue.isPending}
						aria-busy={issue.isPending}
						className={buttonClass('primary')}
					>
						<KeyRound className="h-4 w-4" aria-hidden="true" />
						{issue.isPending ? 'Issuing…' : 'Issue token'}
					</button>
				</div>
				<ProjectScopePicker
					projects={projectsQuery.data ?? []}
					loading={projectsQuery.isPending}
					loadError={projectsQuery.error?.message ?? null}
					selected={scopeProjectIds}
					disabled={issue.isPending}
					onChange={setScopeProjectIds}
				/>
				<div role="status" className="empty:hidden mt-3">
					{issueError !== null && (
						<p id="mcp-issue-error" className={ERROR_CLASS}>
							{issueError}
						</p>
					)}
				</div>
			</form>

			{tokens.length === 0 ? (
				<div className="border border-zinc-800 rounded-lg bg-panel/20 p-8 text-center space-y-2">
					<KeyRound className="w-12 h-12 stroke-1 text-zinc-700 mx-auto" aria-hidden="true" />
					<h3 className="text-sm text-zinc-400">You have no token yet</h3>
					<p className="text-xs text-zinc-500">
						Issue one with the form above to connect an agent to this installation's MCP server.
					</p>
				</div>
			) : (
				<ul className="space-y-3">
					{tokens.map((token) => (
						<TokenRow key={token.id} token={token} now={now} onRevoke={openRevoke} />
					))}
				</ul>
			)}

			{issued !== null && <IssuedTokenDialog issued={issued} onClose={closeIssued} />}
			{revoking !== null && (
				<RevokeTokenDialog
					token={revoking}
					error={revokeError}
					isSubmitting={revoke.isPending}
					onCancel={() => setRevoking(null)}
					onConfirm={confirmRevoke}
				/>
			)}
		</div>
	);
}
