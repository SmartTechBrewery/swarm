import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2, X } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import {
	type CredentialRole,
	getScmProviderCopy,
	isVerifiableRole,
	maskedPreview,
	toSelectableScmProvider,
} from '@/lib/credentials.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { Modal, ModalFooter } from '../ui/modal.js';

const INPUT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono transition-shadow disabled:opacity-50 disabled:cursor-not-allowed';

const SECONDARY_BUTTON_CLASS =
	'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed';

const PRIMARY_BUTTON_CLASS =
	'inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed';

/**
 * The General Settings → **Credentials** tab (issue #769): one write-only masked-secret
 * field per `(SCM provider, role)` pair a provider declares eligible for an
 * instance-level default, adapted from `components/projects/credentials-panel.tsx`'s
 * `CredentialField` (the masked-secret pattern, `ai/DESIGN_SYSTEM.md` §4).
 *
 * Write-only in the strict sense: `settings.credentials.list` returns no value and no
 * masked echo, so a configured field collapses to a fixed marker this component renders
 * itself rather than to anything the server sent.
 *
 * The tab is offered only to an instance administrator (`INSTANCE_ADMIN_ONLY_TABS`,
 * `lib/settings-nav.ts`), and unlike the `agents` tab that is not the enforcement point:
 * every `settings.credentials` procedure is administrator-only in the router itself.
 */

/** One role from `settings.credentials.list` (see `src/api/routers/instanceCredentials.ts`). */
export interface InstanceCredentialEntry {
	providerId: string;
	providerLabel: string;
	role: CredentialRole;
	/**
	 * The provider's conventional key for the role, which at this tier really *is* the
	 * key: an instance default has no project and therefore no reference indirection, so
	 * this is deliberately not a `referenceKey` — don't "fix" it into one.
	 */
	envVarKey: string;
	isConfigured: boolean;
}

interface FieldEditorProps {
	entry: InstanceCredentialEntry;
	roleLabel: string;
	value: string;
	isSaving: boolean;
	saveErrorMsg: string | undefined;
	onValueChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
	onSave: () => void;
	onCancel: () => void;
	onRequestRemove: (entry: InstanceCredentialEntry) => void;
}

/** The revealed input + Save/Cancel/Remove controls of a field. */
function FieldEditor({
	entry,
	roleLabel,
	value,
	isSaving,
	saveErrorMsg,
	onValueChange,
	onSave,
	onCancel,
	onRequestRemove,
}: FieldEditorProps) {
	const canSubmit = !isSaving && value.trim().length > 0;

	return (
		<div className="space-y-3">
			<input
				type="password"
				aria-label={`${roleLabel} value`}
				value={value}
				onChange={onValueChange}
				disabled={isSaving}
				autoComplete="off"
				placeholder={entry.isConfigured ? 'Enter a new value to replace' : 'Paste the secret'}
				className={INPUT_CLASS}
			/>

			{saveErrorMsg && <p className="text-xs text-red-400">Failed to save: {saveErrorMsg}</p>}

			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={onSave}
					disabled={!canSubmit}
					className={PRIMARY_BUTTON_CLASS}
				>
					{isSaving ? 'Saving…' : 'Save'}
				</button>
				{entry.isConfigured && (
					<button
						type="button"
						onClick={onCancel}
						disabled={isSaving}
						className={SECONDARY_BUTTON_CLASS}
					>
						<X className="w-3.5 h-3.5" />
						Cancel
					</button>
				)}
				{entry.isConfigured && (
					<button
						type="button"
						onClick={() => onRequestRemove(entry)}
						disabled={isSaving}
						className="ml-auto text-zinc-500 hover:text-red-400 p-1.5 rounded hover:bg-zinc-800/60 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
						aria-label={`Remove ${roleLabel}`}
						title="Remove"
					>
						<Trash2 className="w-4 h-4" />
					</button>
				)}
			</div>
		</div>
	);
}

interface FieldPreviewProps {
	entry: InstanceCredentialEntry;
	roleLabel: string;
	onEdit: () => void;
	onRequestRemove: (entry: InstanceCredentialEntry) => void;
}

/** The collapsed masked row shown for a slot that already holds a default. */
function FieldPreview({ entry, roleLabel, onEdit, onRequestRemove }: FieldPreviewProps) {
	return (
		<div className="flex items-center gap-2">
			<div className="flex-1 px-3 py-2 border border-zinc-800/85 bg-zinc-900/40 rounded text-sm font-mono text-zinc-400">
				{/* The server sends no value at all, masked or otherwise — the marker is this
				    component's own. */}
				{maskedPreview('')}
			</div>
			<button type="button" onClick={onEdit} className={SECONDARY_BUTTON_CLASS}>
				<Pencil className="w-3.5 h-3.5" />
				Edit
			</button>
			<button
				type="button"
				onClick={() => onRequestRemove(entry)}
				className="text-zinc-500 hover:text-red-400 p-1.5 rounded hover:bg-zinc-800/60 transition-colors"
				aria-label={`Remove ${roleLabel}`}
				title="Remove"
			>
				<Trash2 className="w-4 h-4" />
			</button>
		</div>
	);
}

interface InstanceCredentialFieldProps {
	entry: InstanceCredentialEntry;
	roleLabel: string;
	roleDescription: string;
	onRequestRemove: (entry: InstanceCredentialEntry) => void;
}

/**
 * One eligible slot. Owns its own edit/input/save state; the parent owns the remove
 * confirmation.
 */
function InstanceCredentialField({
	entry,
	roleLabel,
	roleDescription,
	onRequestRemove,
}: InstanceCredentialFieldProps) {
	const queryClient = useQueryClient();
	// A slot with no default opens straight into the input — there is nothing to collapse.
	const [editing, setEditing] = useState(!entry.isConfigured);
	const [value, setValue] = useState('');
	useEffect(() => {
		setEditing(!entry.isConfigured);
		setValue('');
	}, [entry.isConfigured]);

	const saveMutation = useMutation({
		mutationFn: (secret: string) =>
			trpcClient.settings.credentials.set.mutate({
				providerId: entry.providerId,
				role: entry.role,
				value: secret,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: trpc.settings.credentials.list.queryOptions().queryKey,
			});
			setValue('');
			setEditing(false);
		},
	});

	return (
		<div className="border border-zinc-800/85 rounded-md bg-panel/20 p-4 space-y-3">
			<div>
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium text-zinc-200">
						{entry.providerLabel} — {roleLabel}
					</span>
					<span className="text-xs text-zinc-500 font-mono select-all">{entry.envVarKey}</span>
				</div>
				<p className="text-xs text-zinc-500 mt-1">{roleDescription}</p>
			</div>

			{editing ? (
				<FieldEditor
					entry={entry}
					roleLabel={roleLabel}
					value={value}
					isSaving={saveMutation.isPending}
					saveErrorMsg={saveMutation.isError ? saveMutation.error.message : undefined}
					onValueChange={(e) => {
						setValue(e.target.value);
						saveMutation.reset();
					}}
					// Trimmed on the same rule the project panel applies: a role that maps to a
					// provider identity is a pasted token, which routinely carries a stray
					// newline. A webhook secret would be saved verbatim — and can never be
					// eligible for an instance default anyway.
					onSave={() => saveMutation.mutate(isVerifiableRole(entry.role) ? value.trim() : value)}
					onCancel={() => {
						setEditing(false);
						setValue('');
						saveMutation.reset();
					}}
					onRequestRemove={onRequestRemove}
				/>
			) : (
				<FieldPreview
					entry={entry}
					roleLabel={roleLabel}
					onEdit={() => {
						setEditing(true);
						setValue('');
						saveMutation.reset();
					}}
					onRequestRemove={onRequestRemove}
				/>
			)}
		</div>
	);
}

/**
 * The per-provider copy for one eligible slot, or `null` for a provider the dashboard's
 * hand-kept catalogue (`lib/credentials.ts`) cannot narrow — a provider registered
 * server-side but absent from the browser bundle's list. Naming its role with GitHub's
 * words would be worse than saying nothing, so the panel renders a note instead.
 */
function copyFor(entry: InstanceCredentialEntry) {
	const selectable = toSelectableScmProvider(entry.providerId);
	if (!selectable) return null;
	const copy = getScmProviderCopy(selectable);
	return { label: copy.roleLabels[entry.role], description: copy.roleDescriptions[entry.role] };
}

export function InstanceCredentialsPanel() {
	const queryClient = useQueryClient();
	const listQuery = useQuery(trpc.settings.credentials.list.queryOptions());
	const [removeTarget, setRemoveTarget] = useState<InstanceCredentialEntry | null>(null);

	const removeMutation = useMutation({
		mutationFn: (entry: InstanceCredentialEntry) =>
			trpcClient.settings.credentials.delete.mutate({
				providerId: entry.providerId,
				role: entry.role,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: trpc.settings.credentials.list.queryOptions().queryKey,
			});
			setRemoveTarget(null);
		},
	});

	if (listQuery.isLoading) {
		return <div className="text-sm text-zinc-400">Loading credentials…</div>;
	}

	if (listQuery.isError) {
		return (
			<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
				Failed to load instance credentials: {listQuery.error.message}
			</div>
		);
	}

	const entries = (listQuery.data?.roles ?? []) as InstanceCredentialEntry[];

	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm space-y-6">
			<div>
				<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
					Instance Default Credentials
				</h2>
				{/* Both halves matter and neither may be dropped: a default *is* consumed now
				    (phase 2/2 copies it into projects created from here on), and it is still
				    only ever a copy made at creation — never a fallback an existing project
				    silently starts resolving through. */}
				<p className="text-xs text-zinc-400">
					The installation's default identity for source-control roles one account normally serves
					across every project. Only roles a provider declares installation-wide are offered here —
					a project's webhook secret, for instance, is tied to that project's own endpoint and never
					appears. A default is copied into each new project created from the dashboard, so new
					projects are seeded and ready to run without pasting the secret again. Existing projects
					are unaffected: setting or clearing a default here changes nothing for one, whose own
					credential stays authoritative and stays editable on its Source Control tab. Secrets are
					stored encrypted and never returned to the browser, not even as a masked preview.
				</p>
			</div>

			{entries.length === 0 && (
				<div className="p-3 bg-amber-950/20 border border-amber-900/30 text-xs text-amber-200 rounded">
					No registered source-control provider declares a role eligible for an instance-level
					default, so there is nothing to configure here.
				</div>
			)}

			<div className="space-y-4">
				{entries.map((entry) => {
					const copy = copyFor(entry);
					if (!copy) {
						return (
							<div
								key={`${entry.providerId}:${entry.role}`}
								className="p-3 bg-amber-950/20 border border-amber-900/30 text-xs text-amber-200 rounded"
							>
								Provider '{entry.providerId}' is not available in this dashboard, so its '
								{entry.role}' default cannot be edited here.
							</div>
						);
					}
					return (
						<InstanceCredentialField
							key={`${entry.providerId}:${entry.role}`}
							entry={entry}
							roleLabel={copy.label}
							roleDescription={copy.description}
							onRequestRemove={setRemoveTarget}
						/>
					);
				})}
			</div>

			<RemoveInstanceCredentialModal
				target={removeTarget}
				roleLabel={removeTarget ? (copyFor(removeTarget)?.label ?? removeTarget.role) : ''}
				isRemoving={removeMutation.isPending}
				removeErrorMsg={removeMutation.isError ? removeMutation.error.message : undefined}
				onConfirm={() => removeTarget && removeMutation.mutate(removeTarget)}
				onClose={() => {
					setRemoveTarget(null);
					removeMutation.reset();
				}}
			/>
		</div>
	);
}

interface RemoveInstanceCredentialModalProps {
	/** The default being cleared, or `null` when the modal is closed. */
	target: InstanceCredentialEntry | null;
	roleLabel: string;
	isRemoving: boolean;
	removeErrorMsg: string | undefined;
	onConfirm: () => void;
	onClose: () => void;
}

/** Remove confirmation, in the spirit of the project panel's `RemoveCredentialModal`. */
function RemoveInstanceCredentialModal({
	target,
	roleLabel,
	isRemoving,
	removeErrorMsg,
	onConfirm,
	onClose,
}: RemoveInstanceCredentialModalProps) {
	return (
		<Modal open={!!target} onClose={onClose} title="Remove instance default">
			<div className="space-y-4">
				<p className="text-sm text-zinc-300">
					This clears the installation's default for{' '}
					<span className="font-semibold text-zinc-200">
						{target?.providerLabel} — {roleLabel}
					</span>
					. No project loses a credential: each project's own value is what the pipeline resolves,
					and nothing falls back to this one.
				</p>
				{removeErrorMsg && (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						{removeErrorMsg}
					</div>
				)}
				<ModalFooter
					primary={
						<button
							type="button"
							onClick={onConfirm}
							disabled={isRemoving}
							className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-md hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
						>
							{isRemoving ? 'Removing…' : 'Remove'}
						</button>
					}
					secondary={
						<button
							type="button"
							onClick={onClose}
							disabled={isRemoving}
							className={SECONDARY_BUTTON_CLASS}
						>
							Cancel
						</button>
					}
				/>
			</div>
		</Modal>
	);
}
