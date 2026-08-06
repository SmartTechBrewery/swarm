import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Pencil, Trash2, X } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { maskedPreview } from '@/lib/credentials.js';
import {
	isPmRoleEditable,
	missingRequiredPmRoles,
	type PmCredentialEntry,
	pmRoleInheritanceNote,
	pmRoleStatusLabel,
} from '@/lib/pm-credentials.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { Modal, ModalFooter } from '../ui/modal.js';

/**
 * The Project Management tab's provider + credentials section (issue #537).
 *
 * Board authentication is a **project** credential now, not a worker's SCM
 * identity: the roles rendered here are whatever the project's PM provider
 * declares on its manifest (served by `projects.credentials.listPm`), and the
 * secret is stored encrypted server-side with the same masked-preview guarantees as
 * the Source Control tab — the browser posts a plaintext value once and never
 * receives one back.
 *
 * Nothing here names GitHub Projects: the provider label, each role's label, and
 * its permission guidance all come from the manifest, so a second provider's
 * different credential shape renders without a change to this component.
 *
 * Saving invalidates the board-discovery queries as well as the credential list, so
 * the board picker below immediately retries with the new credential — that retry
 * *is* the verification affordance (it either lists real boards or reports an
 * actionable, secret-free provider error).
 */

const INPUT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono transition-shadow disabled:opacity-50 disabled:cursor-not-allowed';

const SECONDARY_BUTTON_CLASS =
	'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed';

const PRIMARY_BUTTON_CLASS =
	'inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed';

interface PmCredentialEditorProps {
	entry: PmCredentialEntry;
	value: string;
	isSaving: boolean;
	saveErrorMsg: string | undefined;
	onValueChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
	onSave: () => void;
	onCancel: () => void;
	onRequestRemove: (entry: PmCredentialEntry) => void;
}

/** The revealed input + Save/Cancel/Remove controls of one PM credential role. */
function PmCredentialEditor({
	entry,
	value,
	isSaving,
	saveErrorMsg,
	onValueChange,
	onSave,
	onCancel,
	onRequestRemove,
}: PmCredentialEditorProps) {
	return (
		<div className="space-y-3">
			<input
				type="password"
				aria-label={`${entry.label} value`}
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
					disabled={isSaving || value.trim().length === 0}
					className={PRIMARY_BUTTON_CLASS}
				>
					{isSaving ? 'Saving…' : 'Save'}
				</button>
				{entry.isConfigured && (
					<>
						<button
							type="button"
							onClick={onCancel}
							disabled={isSaving}
							className={SECONDARY_BUTTON_CLASS}
						>
							<X className="w-3.5 h-3.5" />
							Cancel
						</button>
						<button
							type="button"
							onClick={() => onRequestRemove(entry)}
							disabled={isSaving}
							className="ml-auto text-zinc-500 hover:text-red-400 p-1.5 rounded hover:bg-zinc-800/60 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
							aria-label={`Remove ${entry.label}`}
							title="Remove"
						>
							<Trash2 className="w-4 h-4" />
						</button>
					</>
				)}
			</div>
		</div>
	);
}

interface PmCredentialPreviewProps {
	entry: PmCredentialEntry;
	onEdit: () => void;
	onRequestRemove: (entry: PmCredentialEntry) => void;
}

/** The collapsed masked-preview row shown for an already-configured role. */
function PmCredentialPreview({ entry, onEdit, onRequestRemove }: PmCredentialPreviewProps) {
	return (
		<div className="flex items-center gap-2">
			<div className="flex-1 px-3 py-2 border border-zinc-800/85 bg-zinc-900/40 rounded text-sm font-mono text-zinc-400">
				{maskedPreview(entry.maskedValue)}
			</div>
			<button type="button" onClick={onEdit} className={SECONDARY_BUTTON_CLASS}>
				<Pencil className="w-3.5 h-3.5" />
				Edit
			</button>
			<button
				type="button"
				onClick={() => onRequestRemove(entry)}
				className="text-zinc-500 hover:text-red-400 p-1.5 rounded hover:bg-zinc-800/60 transition-colors"
				aria-label={`Remove ${entry.label}`}
				title="Remove"
			>
				<Trash2 className="w-4 h-4" />
			</button>
		</div>
	);
}

interface PmCredentialFieldProps {
	projectId: string;
	entry: PmCredentialEntry;
	onSaved: () => void;
	onRequestRemove: (entry: PmCredentialEntry) => void;
}

/**
 * One provider-declared role as the masked-secret pattern from
 * `ai/DESIGN_SYSTEM.md` §4: a collapsed preview for a configured credential, the
 * input revealed on Edit (or straight away when unset), and Remove behind the
 * parent's confirmation modal.
 */
function PmCredentialField({ projectId, entry, onSaved, onRequestRemove }: PmCredentialFieldProps) {
	const editable = isPmRoleEditable(entry);
	const inheritanceNote = pmRoleInheritanceNote(entry);
	// An unconfigured credential opens straight into the input — there is no masked
	// value to collapse to. A read-only (inherited) role never opens one.
	const [editing, setEditing] = useState(editable && !entry.isConfigured);
	const [value, setValue] = useState('');

	const saveMutation = useMutation({
		mutationFn: (secret: string) =>
			trpcClient.projects.credentials.setPm.mutate({ projectId, role: entry.role, value: secret }),
		onSuccess: () => {
			setValue('');
			setEditing(false);
			onSaved();
		},
	});

	const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setValue(e.target.value);
		saveMutation.reset();
	};

	return (
		<div className="border border-zinc-800/85 rounded-md bg-panel/20 p-4 space-y-3">
			<div>
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium text-zinc-200">{entry.label}</span>
					<span className="text-xs text-zinc-500 font-mono select-all">{entry.envVarKey}</span>
					<span
						className={
							entry.isConfigured
								? 'text-xs text-emerald-400 ml-auto'
								: entry.optional
									? 'text-xs text-zinc-500 ml-auto'
									: 'text-xs text-amber-300 ml-auto'
						}
					>
						{pmRoleStatusLabel(entry)}
					</span>
				</div>
				{entry.description && <p className="text-xs text-zinc-500 mt-1">{entry.description}</p>}
				{inheritanceNote && (
					<p className="text-xs text-zinc-400 mt-1 flex items-center gap-1.5">
						<Lock className="w-3.5 h-3.5 shrink-0" />
						{inheritanceNote}
					</p>
				)}
			</div>

			{!editable ? null : editing ? (
				<PmCredentialEditor
					entry={entry}
					value={value}
					isSaving={saveMutation.isPending}
					saveErrorMsg={saveMutation.isError ? saveMutation.error.message : undefined}
					onValueChange={handleValueChange}
					// Trim: pasted tokens routinely carry a stray newline or space, and every
					// PM credential declared so far is a token/key rather than an HMAC secret
					// whose surrounding bytes matter (the one such role — the inherited webhook
					// secret — is not editable here).
					onSave={() => saveMutation.mutate(value.trim())}
					onCancel={() => {
						setEditing(false);
						setValue('');
						saveMutation.reset();
					}}
					onRequestRemove={onRequestRemove}
				/>
			) : (
				<PmCredentialPreview
					entry={entry}
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

export function PmCredentialsPanel({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();
	const credentialsQuery = useQuery(trpc.projects.credentials.listPm.queryOptions({ projectId }));
	const [removeTarget, setRemoveTarget] = useState<PmCredentialEntry | null>(null);

	/**
	 * Refresh the credential list *and* the board/state discovery queries: a newly
	 * saved credential is exactly what makes those succeed, so the pickers below must
	 * not keep showing a stale "no credential" error.
	 */
	const invalidateAfterWrite = () => {
		queryClient.invalidateQueries({
			queryKey: trpc.projects.credentials.listPm.queryOptions({ projectId }).queryKey,
		});
		// Every `pm` discovery query at once (boards *and* the selected board's states),
		// by path filter rather than by key: the states query is keyed by a container id
		// this panel doesn't know.
		queryClient.invalidateQueries(trpc.pm.pathFilter());
	};

	const removeMutation = useMutation({
		mutationFn: (entry: PmCredentialEntry) =>
			trpcClient.projects.credentials.deletePm.mutate({ projectId, role: entry.role }),
		onSuccess: () => {
			invalidateAfterWrite();
			setRemoveTarget(null);
		},
	});

	if (credentialsQuery.isLoading) {
		return (
			<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm text-sm text-zinc-400">
				Loading credentials…
			</div>
		);
	}

	if (credentialsQuery.isError) {
		return (
			<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm">
				<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					Failed to load project-management credentials: {credentialsQuery.error.message}
				</div>
			</div>
		);
	}

	const view = credentialsQuery.data;
	const missing = missingRequiredPmRoles(view);

	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm space-y-6">
			<div>
				<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
					Credentials
				</h2>
				<p className="text-xs text-zinc-400">
					{view?.providerLabel} authenticates to this project's board with the credentials below.
					They are project-scoped and resolved only server-side — never sent to a worker, and never
					returned to the browser once saved.
				</p>
			</div>

			{view && !view.providerRegistered && (
				<div className="p-3 bg-amber-950/20 border border-amber-900/30 text-xs text-amber-200 rounded">
					No integration is registered for provider '{view.providerId}', so it declares no
					credentials to configure.
				</div>
			)}

			{missing.length > 0 && (
				<div className="p-3 bg-amber-950/20 border border-amber-900/30 text-xs text-amber-200 rounded">
					Board discovery and every board read/write need{' '}
					{missing.map((entry) => entry.label).join(', ')}. Set{' '}
					{missing.length === 1 ? 'it' : 'them'} below to finish the setup.
				</div>
			)}

			<div className="space-y-4">
				{(view?.roles ?? []).map((entry) => (
					<PmCredentialField
						key={entry.role}
						projectId={projectId}
						entry={entry}
						onSaved={invalidateAfterWrite}
						onRequestRemove={setRemoveTarget}
					/>
				))}
			</div>

			<Modal
				open={!!removeTarget}
				onClose={() => {
					setRemoveTarget(null);
					removeMutation.reset();
				}}
				title="Remove credential"
			>
				<div className="space-y-4">
					<p className="text-sm text-zinc-300">
						This clears the stored secret for{' '}
						<span className="font-semibold text-zinc-200">{removeTarget?.label}</span> and stops
						this project resolving it. Board reads, writes, and discovery will fail with an
						actionable error until you set a new one.
					</p>
					{removeMutation.isError && (
						<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
							{removeMutation.error.message}
						</div>
					)}
					<ModalFooter
						primary={
							<button
								type="button"
								onClick={() => removeTarget && removeMutation.mutate(removeTarget)}
								disabled={removeMutation.isPending}
								className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-md hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
							>
								{removeMutation.isPending ? 'Removing…' : 'Remove'}
							</button>
						}
						secondary={
							<button
								type="button"
								onClick={() => {
									setRemoveTarget(null);
									removeMutation.reset();
								}}
								disabled={removeMutation.isPending}
								className={SECONDARY_BUTTON_CLASS}
							>
								Cancel
							</button>
						}
					/>
				</div>
			</Modal>
		</div>
	);
}
