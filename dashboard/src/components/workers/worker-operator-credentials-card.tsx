import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getScmProviderCopy, maskedPreview, toSelectableScmProvider } from '@/lib/credentials.js';
import { formatRelativeTime } from '@/lib/format.js';
import { trpc, trpcClient } from '@/lib/trpc.js';

/**
 * **Operator source-control credential** (issue #766) — the worker owner's own way
 * to set and rotate the identity this machine commits, pushes, opens pull requests
 * and posts implementer-side comments as, one field per SCM provider the machine
 * actually needs one for.
 *
 * Adapted from `components/settings/instance-credentials-panel.tsx` (the write-only
 * masked-secret pattern, `ai/DESIGN_SYSTEM.md` §4) rather than from the project
 * Credentials panel: that one still renders a server-sent masked value and offers a
 * separate client-side Verify button, and this surface has neither. There is **no
 * reveal affordance anywhere** — `workers.scmCredentials.list` sends no value and no
 * masked echo, so a configured slot collapses to a marker this component renders
 * itself, and the only thing an owner can do to a stored value is replace it.
 *
 * Verification happens server-side as part of the save, so an invalid credential is
 * refused with nothing stored instead of failing at dispatch time.
 *
 * Deliberately **not** polled: unlike the surrounding page this is not liveness
 * data, and a refetch under an open editor would only cost a DB read per tick and
 * risk fighting a half-typed paste. The query is invalidated on a successful save.
 */

const INPUT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono transition-shadow disabled:opacity-50 disabled:cursor-not-allowed';

const SECONDARY_BUTTON_CLASS =
	'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed';

const PRIMARY_BUTTON_CLASS =
	'inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed';

/** One provider slot from `workers.scmCredentials.list`. */
export interface WorkerOperatorCredentialSlot {
	providerId: string;
	providerLabel: string;
	isConfigured: boolean;
	/** ISO timestamp of the last write, or `null` when nothing is stored. */
	updatedAt: string | null;
}

interface SlotFieldProps {
	workerId: string;
	slot: WorkerOperatorCredentialSlot;
	operatorLabel: string;
	operatorDescription: string;
	/** The provider's own wording for a secret that resolves to no account. */
	verifyFailureHint: string;
}

/**
 * One provider's field. Owns its own edit/input/save state; an unconfigured slot
 * opens straight into the input, since there is nothing to collapse.
 */
function SlotField({
	workerId,
	slot,
	operatorLabel,
	operatorDescription,
	verifyFailureHint,
}: SlotFieldProps) {
	const queryClient = useQueryClient();
	const [editing, setEditing] = useState(!slot.isConfigured);
	const [value, setValue] = useState('');
	const [savedLogin, setSavedLogin] = useState<string | null>(null);
	useEffect(() => {
		setEditing(!slot.isConfigured);
		setValue('');
	}, [slot.isConfigured]);

	const saveMutation = useMutation({
		mutationFn: (secret: string) =>
			trpcClient.workers.scmCredentials.set.mutate({
				workerId,
				providerId: slot.providerId,
				value: secret,
			}),
		onSuccess: (result: { login: string }) => {
			queryClient.invalidateQueries({
				queryKey: trpc.workers.scmCredentials.list.queryOptions({ workerId }).queryKey,
			});
			setSavedLogin(result.login);
			setValue('');
			setEditing(false);
		},
	});

	return (
		<div className="border border-zinc-800/85 rounded-md bg-panel/20 p-4 space-y-3">
			<div>
				<span className="text-sm font-medium text-zinc-200">
					{slot.providerLabel} — {operatorLabel}
				</span>
				<p className="text-xs text-zinc-500 mt-1">{operatorDescription}</p>
			</div>

			{editing ? (
				<div className="space-y-3">
					<input
						type="password"
						aria-label={`${slot.providerLabel} ${operatorLabel} value`}
						value={value}
						onChange={(event) => {
							setValue(event.target.value);
							saveMutation.reset();
						}}
						disabled={saveMutation.isPending}
						autoComplete="off"
						placeholder={slot.isConfigured ? 'Enter a new value to replace' : 'Paste the secret'}
						className={INPUT_CLASS}
					/>
					<p className="text-xs text-zinc-500">{verifyFailureHint}</p>
					{saveMutation.isError && (
						<p className="text-xs text-red-400">Failed to save: {saveMutation.error.message}</p>
					)}
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() =>
								// Trimmed on the same rule the other credential panels apply: this value
								// maps to a provider identity, and a pasted token routinely carries a
								// stray newline.
								saveMutation.mutate(value.trim())
							}
							disabled={saveMutation.isPending || value.trim().length === 0}
							className={PRIMARY_BUTTON_CLASS}
						>
							{saveMutation.isPending ? 'Saving…' : 'Save'}
						</button>
						{slot.isConfigured && (
							<button
								type="button"
								onClick={() => {
									setEditing(false);
									setValue('');
									saveMutation.reset();
								}}
								disabled={saveMutation.isPending}
								className={SECONDARY_BUTTON_CLASS}
							>
								Cancel
							</button>
						)}
					</div>
				</div>
			) : (
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<div className="flex-1 px-3 py-2 border border-zinc-800/85 bg-zinc-900/40 rounded text-sm font-mono text-zinc-400">
							{/* The server sends no value at all, masked or otherwise — the marker is
							    this component's own. */}
							{maskedPreview('')}
						</div>
						<button
							type="button"
							onClick={() => {
								setEditing(true);
								setValue('');
								saveMutation.reset();
							}}
							className={SECONDARY_BUTTON_CLASS}
						>
							<Pencil className="w-3.5 h-3.5" />
							Replace
						</button>
					</div>
					{savedLogin ? (
						<p className="text-xs text-emerald-400">✓ Saved — verified as @{savedLogin}</p>
					) : slot.updatedAt ? (
						<p className="text-xs text-zinc-500" title={new Date(slot.updatedAt).toLocaleString()}>
							Set {formatRelativeTime(slot.updatedAt)}
						</p>
					) : null}
				</div>
			)}
		</div>
	);
}

/**
 * The provider's own operator copy, or `null` for a provider the dashboard's
 * hand-kept catalogue (`lib/credentials.ts`) cannot narrow — one registered
 * server-side but absent from the browser bundle's list. Naming it with GitHub's
 * words would be worse than saying nothing.
 */
function copyFor(slot: WorkerOperatorCredentialSlot) {
	const selectable = toSelectableScmProvider(slot.providerId);
	if (!selectable) return null;
	const copy = getScmProviderCopy(selectable);
	return {
		label: copy.operatorLabel,
		description: copy.operatorDescription,
		verifyFailureHint: copy.verifyFailureMessage,
	};
}

export function WorkerOperatorCredentialsCard({ workerId }: { workerId: string }) {
	const listQuery = useQuery(trpc.workers.scmCredentials.list.queryOptions({ workerId }));

	if (listQuery.isLoading) {
		return <div className="text-sm text-zinc-400">Loading credentials…</div>;
	}

	if (listQuery.isError) {
		return (
			<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
				Failed to load operator credentials: {listQuery.error.message}
			</div>
		);
	}

	const slots = (listQuery.data?.providers ?? []) as WorkerOperatorCredentialSlot[];

	return (
		<div className="space-y-4">
			{slots.length === 0 ? (
				<p className="text-sm text-zinc-400">
					This machine is not enrolled in any project yet, so there is no source-control provider to
					configure a credential for. Offer it to a project first — the provider that project runs
					on then appears here.
				</p>
			) : (
				slots.map((slot) => {
					const copy = copyFor(slot);
					if (!copy) {
						return (
							<div
								key={slot.providerId}
								className="p-3 bg-amber-950/20 border border-amber-900/30 text-xs text-amber-200 rounded"
							>
								Provider '{slot.providerId}' is not available in this dashboard, so its operator
								credential cannot be set here.
							</div>
						);
					}
					return (
						<SlotField
							key={slot.providerId}
							workerId={workerId}
							slot={slot}
							operatorLabel={copy.label}
							operatorDescription={copy.description}
							verifyFailureHint={copy.verifyFailureHint}
						/>
					);
				})
			)}
			<p className="text-xs text-zinc-500">
				This is the account every commit, push, pull request and implementer-side comment from this
				machine is authored as — one credential per source-control provider it works with, distinct
				from each project's own reviewer credential. The value is verified against the provider
				before it is stored, then encrypted and never returned to the browser, not even as a masked
				preview. A saved value takes effect on the <strong>next dispatch</strong>: the control plane
				reads it per run, so nothing needs restarting here.
			</p>
		</div>
	);
}
