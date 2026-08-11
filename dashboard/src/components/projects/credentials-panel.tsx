import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, ShieldCheck, Trash2, X } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import {
	type CredentialEntry,
	type CredentialRole,
	getScmProviderCopy,
	isVerifiableRole,
	maskedPreview,
	SCM_PROVIDERS,
	type ScmProviderId,
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

const SELECT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500';

/**
 * The Source Control tab's provider selector + credential fields (issue #200).
 *
 * Everything below is scoped to the **selected provider** (issue #632): the `list`
 * query carries its id, so switching the selector refetches that provider's own state
 * — unconfigured where nothing was saved, the previously saved values again on
 * switching back — and `set`/`delete` name `(providerId, role)` rather than a
 * secret-store key, so saving under one provider cannot touch another's stored secret.
 * The key each field displays is the one the project *resolves* the role through
 * (`referenceKey`), never the manifest's conventional `envVarKey`: the two commonly
 * differ (a project created since issue #290 resolves the neutral `SCM_TOKEN_REVIEWER`),
 * and naming the convention would tell the operator to set a variable nothing reads.
 * Role labels are per provider too — GitHub's PAT is Bitbucket's app password.
 */

/** Result shape of the `scm.verify…` procedures (see `src/api/routers/scm.ts`). */
type VerifyResult = { valid: true; login: string } | { valid: false };

/**
 * Verify a pasted secret against the selected provider. One procedure per provider
 * rather than one generalised call: there is no project yet to resolve an
 * `SCMProvider` from, which is why `src/api/routers/scm.ts` keeps them separate.
 */
function verifyScmCredential(providerId: ScmProviderId, secret: string): Promise<VerifyResult> {
	switch (providerId) {
		case 'bitbucket':
			return trpcClient.scm.verifyBitbucketCredential.mutate({ credential: secret });
		case 'gitlab':
			return trpcClient.scm.verifyGitLabToken.mutate({ token: secret });
		default:
			return trpcClient.scm.verifyGithubToken.mutate({ token: secret });
	}
}

interface CredentialFieldEditorProps {
	entry: CredentialEntry;
	/** The selected provider's own name for this role (see `ScmProviderCopy.roleLabels`). */
	roleLabel: string;
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
	roleLabel,
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
				aria-label={`${roleLabel} value`}
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

interface CredentialFieldPreviewProps {
	entry: CredentialEntry;
	roleLabel: string;
	verifiable: boolean;
	verifiedLogin: string | undefined;
	onEdit: () => void;
	onRequestRemove: (entry: CredentialEntry) => void;
}

/** The collapsed masked-preview row shown for an already-configured credential. */
function CredentialFieldPreview({
	entry,
	roleLabel,
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
				aria-label={`Remove ${roleLabel}`}
				title="Remove"
			>
				<Trash2 className="w-4 h-4" />
			</button>
		</div>
	);
}

interface CredentialFieldProps {
	projectId: string;
	providerId: ScmProviderId;
	entry: CredentialEntry;
	roleLabel: string;
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
	providerId,
	entry,
	roleLabel,
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
		mutationFn: (secret: string) => verifyScmCredential(providerId, secret),
		onSuccess: (result) => {
			onVerified(entry.role, result.valid ? result.login : undefined);
		},
	});

	const saveMutation = useMutation({
		// `(providerId, role)`, never a store key: the server resolves the reference this
		// provider's role writes to, so this cannot land on another provider's row.
		mutationFn: (secret: string) =>
			trpcClient.projects.credentials.set.mutate({
				projectId,
				providerId,
				role: entry.role,
				value: secret,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: trpc.projects.credentials.list.queryOptions({ projectId, providerId }).queryKey,
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
					<span className="text-sm font-medium text-zinc-200">{roleLabel}</span>
					{/* The key this project resolves the role through, not the provider's
					    conventional default: it is the only key setting a value acts on, and it is
					    what `isConfigured`/the masked preview beside it already describe. */}
					<span className="text-xs text-zinc-500 font-mono select-all">{entry.referenceKey}</span>
				</div>
				<p className="text-xs text-zinc-500 mt-1">{roleDescription}</p>
			</div>

			{editing ? (
				<CredentialFieldEditor
					entry={entry}
					roleLabel={roleLabel}
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
					roleLabel={roleLabel}
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

interface ScmProviderSelectProps {
	selectedProviderId: ScmProviderId | undefined;
	/** What the project actually stores, so an unofferable value can be named. */
	storedScm: string | undefined;
	isSaving: boolean;
	saveErrorMsg: string | undefined;
	onSelect: (providerId: ScmProviderId) => void;
}

/** The provider selector, its save error, and the "nothing selected" warning. */
function ScmProviderSelect({
	selectedProviderId,
	storedScm,
	isSaving,
	saveErrorMsg,
	onSelect,
}: ScmProviderSelectProps) {
	return (
		<div className="max-w-xs">
			<label htmlFor="scm-provider" className="block text-xs font-medium text-zinc-400 mb-1.5">
				Provider
			</label>
			<select
				id="scm-provider"
				value={selectedProviderId ?? ''}
				disabled={isSaving}
				onChange={(e) => onSelect(e.target.value as ScmProviderId)}
				className={SELECT_CLASS}
			>
				<option value="" disabled>
					Select a provider
				</option>
				{SCM_PROVIDERS.map((provider) => (
					<option key={provider.id} value={provider.id} disabled={!provider.available}>
						{provider.label}
					</option>
				))}
			</select>
			{saveErrorMsg && (
				<p className="text-xs text-red-400 mt-1.5">Failed to save the provider: {saveErrorMsg}</p>
			)}
			{!selectedProviderId && (
				<p className="text-xs text-amber-400 mt-1.5">
					{storedScm
						? `The saved provider “${storedScm}” is not available in this dashboard.`
						: 'No provider is saved. Select one before this project can run.'}
				</p>
			)}
		</div>
	);
}

export function CredentialsPanel({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();

	// The selector was UI-only when it landed (issue #200) because nothing selected a
	// project's SCM provider. It writes `project.scm` since issue #618, which is what
	// lets an operator put a project on Bitbucket without hand-editing
	// `swarm.config.json`. The stored value seeds it; `pendingProviderId` holds an
	// unsaved pick so the copy switches immediately while the mutation is in flight.
	const projectQuery = useQuery(trpc.projects.getById.queryOptions({ id: projectId }));
	const [pendingProviderId, setPendingProviderId] = useState<ScmProviderId | null>(null);
	const storedProviderId = toSelectableScmProvider(projectQuery.data?.scm ?? undefined);
	const selectedProviderId = pendingProviderId ?? storedProviderId;
	const providerCopy = selectedProviderId ? getScmProviderCopy(selectedProviderId) : undefined;

	// Keyed by the selected provider (issue #632), so switching refetches that
	// provider's own credential state instead of re-rendering the outgoing one's. Held
	// until a provider is known: there are no fields to render without one, and asking
	// for the server's default only to discard it would be a wasted round trip.
	const credentialsQuery = useQuery({
		...trpc.projects.credentials.list.queryOptions({ projectId, providerId: selectedProviderId }),
		enabled: !!selectedProviderId,
	});

	// The optimistic pick outlives the mutation deliberately: it is dropped only once
	// the refetched project agrees with it, so the selector and its copy never flick
	// back to the old provider in the window before the read catches up. A failed save
	// drops it immediately, reverting to what is actually stored.
	useEffect(() => {
		if (pendingProviderId !== null && storedProviderId === pendingProviderId) {
			setPendingProviderId(null);
		}
	}, [pendingProviderId, storedProviderId]);

	const providerMutation = useMutation({
		mutationFn: (scm: ScmProviderId) => trpcClient.projects.update.mutate({ id: projectId, scm }),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: trpc.projects.getById.queryOptions({ id: projectId }).queryKey,
			});
			queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryOptions().queryKey });
		},
		onError: () => setPendingProviderId(null),
	});

	// Session-only record of the login each reviewer credential last verified to; drives
	// the per-field "✓ @login" preview. Never persisted — the plaintext token is gone
	// once saved, so this is best-effort within a session.
	//
	// Keyed by provider *and* role: a login belongs to the provider it was verified
	// against, so keying on the role alone would show GitLab's account beside GitHub's
	// field after a switch.
	const [verifiedLogins, setVerifiedLogins] = useState<Record<string, string>>({});
	const [removeTarget, setRemoveTarget] = useState<CredentialEntry | null>(null);

	const verifiedLoginKey = (role: CredentialRole) => `${selectedProviderId}:${role}`;

	const handleVerified = (role: CredentialRole, login: string | undefined) => {
		const key = verifiedLoginKey(role);
		setVerifiedLogins((prev) => {
			if (login === undefined) {
				const { [key]: _removed, ...rest } = prev;
				return rest;
			}
			return { ...prev, [key]: login };
		});
	};

	const removeMutation = useMutation({
		mutationFn: (entry: CredentialEntry) => {
			// Unreachable in practice — the fields that open this modal only render under a
			// selected provider — but naming the provider is what keeps the delete off
			// another one's row, so it is never defaulted here.
			if (!selectedProviderId) throw new Error('No source-control provider is selected.');
			return trpcClient.projects.credentials.delete.mutate({
				projectId,
				providerId: selectedProviderId,
				role: entry.role,
			});
		},
		onSuccess: (_data, entry) => {
			queryClient.invalidateQueries({
				queryKey: trpc.projects.credentials.list.queryOptions({
					projectId,
					providerId: selectedProviderId,
				}).queryKey,
			});
			handleVerified(entry.role, undefined);
			setRemoveTarget(null);
		},
	});

	// The project read too, not just the credentials: the selected provider comes from it,
	// so rendering before it lands would flash "no provider is saved" at a project that
	// has one.
	if (projectQuery.isLoading || credentialsQuery.isLoading) {
		return <div className="text-sm text-zinc-400">Loading credentials…</div>;
	}

	if (credentialsQuery.isError) {
		return (
			<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
				Failed to load credentials: {credentialsQuery.error.message}
			</div>
		);
	}

	const view = credentialsQuery.data;
	const entries = view?.roles ?? [];

	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm space-y-6">
			<div>
				<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
					Source Control
				</h2>

				<ScmProviderSelect
					selectedProviderId={selectedProviderId}
					storedScm={projectQuery.data?.scm ?? undefined}
					isSaving={providerMutation.isPending}
					saveErrorMsg={providerMutation.isError ? providerMutation.error.message : undefined}
					onSelect={(next) => {
						setPendingProviderId(next);
						providerMutation.mutate(next);
					}}
				/>

				{providerCopy && <p className="text-xs text-zinc-400 mt-4">{providerCopy.intro}</p>}
			</div>

			{/* The selector's catalogue is hand-kept in the browser bundle, so it can name a
			    provider this installation has not registered (or has registered but not made
			    runtime-ready). The server says so rather than throwing, and there is nothing
			    to configure for such a provider. */}
			{selectedProviderId && view && !view.providerRegistered && (
				<div className="p-3 bg-amber-950/20 border border-amber-900/30 text-xs text-amber-200 rounded">
					No integration is registered for provider '{view.providerId}' in this installation, so it
					declares no credentials to configure.
				</div>
			)}

			{selectedProviderId && providerCopy && (
				<div className="space-y-4">
					{entries.map((entry) => (
						<CredentialField
							// Keyed by provider *and* role: both providers spell the roles the same, so
							// keying on the role alone would have React reuse the field across a switch
							// and carry its edit state — an unconfigured credential rendered as a masked
							// preview, or a value typed for one provider left in the other's input.
							key={`${selectedProviderId}:${entry.role}`}
							projectId={projectId}
							providerId={selectedProviderId}
							entry={entry}
							roleLabel={providerCopy.roleLabels[entry.role]}
							roleDescription={providerCopy.roleDescriptions[entry.role]}
							verifyFailureMessage={providerCopy.verifyFailureMessage}
							verifiedLogin={verifiedLogins[verifiedLoginKey(entry.role)]}
							onVerified={handleVerified}
							onRequestRemove={setRemoveTarget}
						/>
					))}
				</div>
			)}

			<RemoveCredentialModal
				target={removeTarget}
				roleLabel={removeTarget && providerCopy ? providerCopy.roleLabels[removeTarget.role] : ''}
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

interface RemoveCredentialModalProps {
	/** The credential being cleared, or `null` when the modal is closed. */
	target: CredentialEntry | null;
	roleLabel: string;
	isRemoving: boolean;
	removeErrorMsg: string | undefined;
	onConfirm: () => void;
	onClose: () => void;
}

/** Remove confirmation, naming the role and the store key the secret is cleared from. */
function RemoveCredentialModal({
	target,
	roleLabel,
	isRemoving,
	removeErrorMsg,
	onConfirm,
	onClose,
}: RemoveCredentialModalProps) {
	return (
		<Modal open={!!target} onClose={onClose} title="Remove credential">
			<div className="space-y-4">
				<p className="text-sm text-zinc-300">
					This clears the stored secret for{' '}
					<span className="font-semibold text-zinc-200">{roleLabel}</span> (
					<span className="font-mono text-zinc-300">{target?.referenceKey}</span>). The pipeline
					will have no token for this persona until you set a new one.
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
