import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, ShieldCheck, Trash2, X } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import {
	CREDENTIAL_ROLE_LABELS,
	type CredentialEntry,
	type CredentialRole,
	DEFAULT_SCM_PROVIDER_ID,
	getScmProviderCopy,
	isVerifiableRole,
	maskedPreview,
	SCM_PROVIDERS,
	type ScmProviderId,
} from '@/lib/credentials.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { Modal, ModalFooter } from '../ui/modal.js';

const INPUT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono transition-shadow disabled:opacity-50 disabled:cursor-not-allowed';

const SECONDARY_BUTTON_CLASS =
	'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed';

const PRIMARY_BUTTON_CLASS =
	'inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed';

const SELECT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500';

/** Result shape of `scm.verifyGithubToken` (see `src/api/routers/scm.ts`). */
type VerifyResult = { valid: true; login: string } | { valid: false };

interface CredentialFieldEditorProps {
	entry: CredentialEntry;
	verifiable: boolean;
	verifyFailureMessage: string;
	value: string;
	isSaving: boolean;
	isVerifying: boolean;
	verifyResult: VerifyResult | undefined;
	verifyErrorMsg: string | undefined;
	saveErrorMsg: string | undefined;
	onValueChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
	onSave: () => void;
	onVerify: () => void;
	onCancel: () => void;
	onRequestRemove: (entry: CredentialEntry) => void;
}

/** The revealed input + Verify/Save/Cancel/Remove controls of a credential field. */
function CredentialFieldEditor({
	entry,
	verifiable,
	verifyFailureMessage,
	value,
	isSaving,
	isVerifying,
	verifyResult,
	verifyErrorMsg,
	saveErrorMsg,
	onValueChange,
	onSave,
	onVerify,
	onCancel,
	onRequestRemove,
}: CredentialFieldEditorProps) {
	const isBusy = isSaving || isVerifying;
	const canSubmit = !isBusy && value.trim().length > 0;
	const verified = verifyResult?.valid === true;

	return (
		<div className="space-y-3">
			<input
				type="password"
				aria-label={`${CREDENTIAL_ROLE_LABELS[entry.role]} value`}
				value={value}
				onChange={onValueChange}
				disabled={isBusy}
				autoComplete="off"
				placeholder={entry.isConfigured ? 'Enter a new value to replace' : 'Paste the secret'}
				className={INPUT_CLASS}
			/>

			{verifiable && verifyResult?.valid && (
				<p className="text-xs text-emerald-400 flex items-center gap-1.5">
					<Check className="w-3.5 h-3.5" />✓ Verified as @{verifyResult.login}
				</p>
			)}
			{verifiable && verifyResult && !verifyResult.valid && (
				<p className="text-xs text-red-400">{verifyFailureMessage}</p>
			)}
			{verifyErrorMsg && (
				<p className="text-xs text-red-400">Verification failed: {verifyErrorMsg}</p>
			)}
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
				{verifiable && (
					<button
						type="button"
						onClick={onVerify}
						disabled={!canSubmit}
						className={
							verified
								? 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed'
								: SECONDARY_BUTTON_CLASS
						}
					>
						<ShieldCheck className="w-3.5 h-3.5" />
						{isVerifying ? 'Verifying…' : 'Verify'}
					</button>
				)}
				{entry.isConfigured && (
					<button
						type="button"
						onClick={onCancel}
						disabled={isBusy}
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
						disabled={isBusy}
						className="ml-auto text-zinc-500 hover:text-red-400 p-1.5 rounded hover:bg-zinc-800/60 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
						aria-label={`Remove ${CREDENTIAL_ROLE_LABELS[entry.role]}`}
						title="Remove"
					>
						<Trash2 className="w-4 h-4" />
					</button>
				)}
			</div>
		</div>
	);
}

interface CredentialFieldPreviewProps {
	entry: CredentialEntry;
	verifiable: boolean;
	verifiedLogin: string | undefined;
	onEdit: () => void;
	onRequestRemove: (entry: CredentialEntry) => void;
}

/** The collapsed masked-preview row shown for an already-configured credential. */
function CredentialFieldPreview({
	entry,
	verifiable,
	verifiedLogin,
	onEdit,
	onRequestRemove,
}: CredentialFieldPreviewProps) {
	return (
		<div className="flex items-center gap-2">
			<div className="flex-1 px-3 py-2 border border-zinc-800/85 bg-zinc-900/40 rounded text-sm font-mono text-zinc-400">
				{maskedPreview(entry.maskedValue)}
			</div>
			{verifiable && verifiedLogin && (
				<span className="text-xs text-emerald-400 flex items-center gap-1.5 whitespace-nowrap">
					<Check className="w-3.5 h-3.5" />@{verifiedLogin}
				</span>
			)}
			<button type="button" onClick={onEdit} className={SECONDARY_BUTTON_CLASS}>
				<Pencil className="w-3.5 h-3.5" />
				Edit
			</button>
			<button
				type="button"
				onClick={() => onRequestRemove(entry)}
				className="text-zinc-500 hover:text-red-400 p-1.5 rounded hover:bg-zinc-800/60 transition-colors"
				aria-label={`Remove ${CREDENTIAL_ROLE_LABELS[entry.role]}`}
				title="Remove"
			>
				<Trash2 className="w-4 h-4" />
			</button>
		</div>
	);
}

interface CredentialFieldProps {
	projectId: string;
	entry: CredentialEntry;
	roleDescription: string;
	verifyFailureMessage: string;
	verifiedLogin: string | undefined;
	onVerified: (role: CredentialRole, login: string | undefined) => void;
	onRequestRemove: (entry: CredentialEntry) => void;
}

/**
 * One credential reference rendered as the masked-secret (+ optional verify)
 * pattern from `ai/DESIGN_SYSTEM.md` §4. Owns its own edit/input/verify/save
 * state; the parent owns the cross-field verified-login map (for the same-login
 * warning) and the remove confirmation.
 */
function CredentialField({
	projectId,
	entry,
	roleDescription,
	verifyFailureMessage,
	verifiedLogin,
	onVerified,
	onRequestRemove,
}: CredentialFieldProps) {
	const queryClient = useQueryClient();
	const verifiable = isVerifiableRole(entry.role);
	// An unconfigured credential opens straight into the input — there is no
	// masked value to collapse to.
	const [editing, setEditing] = useState(!entry.isConfigured);
	const [value, setValue] = useState('');

	const verifyMutation = useMutation({
		mutationFn: (token: string) => trpcClient.scm.verifyGithubToken.mutate({ token }),
		onSuccess: (result) => {
			onVerified(entry.role, result.valid ? result.login : undefined);
		},
	});

	const saveMutation = useMutation({
		mutationFn: (secret: string) =>
			trpcClient.projects.credentials.set.mutate({
				projectId,
				envVarKey: entry.envVarKey,
				value: secret,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: trpc.projects.credentials.list.queryOptions({ projectId }).queryKey,
			});
			setValue('');
			setEditing(false);
		},
	});

	const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setValue(e.target.value);
		// A changed value invalidates any prior verification result.
		verifyMutation.reset();
		saveMutation.reset();
		onVerified(entry.role, undefined);
	};

	const handleCancel = () => {
		setEditing(false);
		setValue('');
		verifyMutation.reset();
		saveMutation.reset();
	};

	return (
		<div className="border border-zinc-800/85 rounded-md bg-panel/20 p-4 space-y-3">
			<div>
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium text-zinc-200">
						{CREDENTIAL_ROLE_LABELS[entry.role]}
					</span>
					<span className="text-xs text-zinc-500 font-mono select-all">{entry.envVarKey}</span>
				</div>
				<p className="text-xs text-zinc-500 mt-1">{roleDescription}</p>
			</div>

			{editing ? (
				<CredentialFieldEditor
					entry={entry}
					verifiable={verifiable}
					verifyFailureMessage={verifyFailureMessage}
					value={value}
					isSaving={saveMutation.isPending}
					isVerifying={verifyMutation.isPending}
					verifyResult={verifyMutation.data}
					verifyErrorMsg={verifyMutation.isError ? verifyMutation.error.message : undefined}
					saveErrorMsg={saveMutation.isError ? saveMutation.error.message : undefined}
					onValueChange={handleValueChange}
					// Trim PATs (pasted tokens often carry a stray newline/space) but
					// save the webhook secret verbatim — it is an arbitrary HMAC secret
					// whose surrounding bytes are significant to signature verification.
					onSave={() => saveMutation.mutate(verifiable ? value.trim() : value)}
					onVerify={() => verifyMutation.mutate(value.trim())}
					onCancel={handleCancel}
					onRequestRemove={onRequestRemove}
				/>
			) : (
				<CredentialFieldPreview
					entry={entry}
					verifiable={verifiable}
					verifiedLogin={verifiedLogin}
					onEdit={() => {
						setEditing(true);
						setValue('');
						// Mirror handleCancel: a prior Save leaves verifyMutation.data
						// intact, which would render a stale "✓ Verified as @login" label
						// and a success-styled Verify button over the now-empty input.
						verifyMutation.reset();
						saveMutation.reset();
					}}
					onRequestRemove={onRequestRemove}
				/>
			)}
		</div>
	);
}

export function CredentialsPanel({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();
	const credentialsQuery = useQuery(trpc.projects.credentials.list.queryOptions({ projectId }));

	// UI-only selected-provider state (issue #200). GitHub is the sole working
	// provider; the selector exists so the panel's copy is data-driven off a
	// selected provider rather than embedded GitHub literals throughout.
	const [selectedProviderId, setSelectedProviderId] =
		useState<ScmProviderId>(DEFAULT_SCM_PROVIDER_ID);
	const providerCopy = getScmProviderCopy(selectedProviderId);

	// Session-only record of the login each PAT last verified to; drives the
	// per-field "✓ @login" preview. Never persisted — the plaintext token is gone
	// once saved, so this is best-effort within a session.
	const [verifiedLogins, setVerifiedLogins] = useState<Partial<Record<CredentialRole, string>>>({});
	const [removeTarget, setRemoveTarget] = useState<CredentialEntry | null>(null);

	const handleVerified = (role: CredentialRole, login: string | undefined) => {
		setVerifiedLogins((prev) => {
			if (login === undefined) {
				const { [role]: _removed, ...rest } = prev;
				return rest;
			}
			return { ...prev, [role]: login };
		});
	};

	const removeMutation = useMutation({
		mutationFn: (entry: CredentialEntry) =>
			trpcClient.projects.credentials.delete.mutate({
				projectId,
				envVarKey: entry.envVarKey,
			}),
		onSuccess: (_data, entry) => {
			queryClient.invalidateQueries({
				queryKey: trpc.projects.credentials.list.queryOptions({ projectId }).queryKey,
			});
			handleVerified(entry.role, undefined);
			setRemoveTarget(null);
		},
	});

	if (credentialsQuery.isLoading) {
		return <div className="text-sm text-zinc-400">Loading credentials…</div>;
	}

	if (credentialsQuery.isError) {
		return (
			<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
				Failed to load credentials: {credentialsQuery.error.message}
			</div>
		);
	}

	const entries = credentialsQuery.data ?? [];

	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm space-y-6">
			<div>
				<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
					Source Control
				</h2>

				<div className="max-w-xs">
					<label htmlFor="scm-provider" className="block text-xs font-medium text-zinc-400 mb-1.5">
						Provider
					</label>
					<select
						id="scm-provider"
						value={selectedProviderId}
						onChange={(e) => setSelectedProviderId(e.target.value as ScmProviderId)}
						className={SELECT_CLASS}
					>
						{SCM_PROVIDERS.map((provider) => (
							<option key={provider.id} value={provider.id} disabled={!provider.available}>
								{provider.label}
							</option>
						))}
					</select>
				</div>

				<p className="text-xs text-zinc-400 mt-4">{providerCopy.intro}</p>
			</div>

			<div className="space-y-4">
				{entries.map((entry) => (
					<CredentialField
						key={entry.role}
						projectId={projectId}
						entry={entry}
						roleDescription={providerCopy.roleDescriptions[entry.role]}
						verifyFailureMessage={providerCopy.verifyFailureMessage}
						verifiedLogin={verifiedLogins[entry.role]}
						onVerified={handleVerified}
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
						<span className="font-semibold text-zinc-200">
							{removeTarget ? CREDENTIAL_ROLE_LABELS[removeTarget.role] : ''}
						</span>{' '}
						(<span className="font-mono text-zinc-300">{removeTarget?.envVarKey}</span>). The
						pipeline will have no token for this persona until you set a new one.
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
