import { useQuery } from '@tanstack/react-query';
import type React from 'react';
import { useEffect } from 'react';
import {
	type BoardMappingForm,
	canSaveBoardMapping,
	getPmMappingProvider,
	PM_MAPPING_PROVIDERS,
	STATUS_KEY_LABELS,
	STATUS_KEYS,
} from '@/lib/board-mapping.js';
import { trpc } from '@/lib/trpc.js';
import type { PmStatusKey } from '../../../../src/pm/pipeline.js';

/**
 * Provider-neutral Board Mapping panel (issue #201). Replaces the old GitHub
 * Projects raw-ID form: the operator picks a PM provider, then a discovered
 * board, then maps each canonical SWARM pipeline status to one of that board's
 * discovered states. Opaque IDs stay option values and persisted data — never
 * something to type. Boards/states are discovered through the `pm` API using the
 * implementer persona's token (the worker operator's own `SWARM_OPERATOR_GH_TOKEN`,
 * resolved server-side — issue #396); the browser never handles a credential.
 *
 * The owning route holds the form state and the save/reset handlers (so the save
 * goes through the same serialized `projects.update` write as the other tabs);
 * this panel owns only the discovery queries and their loading/error/empty
 * presentation.
 */
interface BoardMappingPanelProps {
	projectId: string;
	form: BoardMappingForm;
	onProviderChange: (providerId: string) => void;
	onSelectContainer: (containerId: string) => void;
	onStatusOptionChange: (key: PmStatusKey, value: string) => void;
	/** Record the opaque provider context (GitHub's Status field id) from state discovery. */
	onStatesContext: (context: Record<string, string>) => void;
	handleSubmit: (e: React.FormEvent) => void;
	handleReset: () => void;
	isDirty: boolean;
	isPending: boolean;
	isSuccess: boolean;
	isError: boolean;
	errorMessage?: string;
}

const SELECT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500';

const LABEL_CLASS = 'block text-xs font-medium text-zinc-400 mb-1';

const NEUTRAL_UNAVAILABLE = 'Configured value (unavailable)';

/** Whether a tRPC error is the "no implementer token" precondition (actionable). */
function isMissingCredentialError(message: string | undefined): boolean {
	return !!message && /SWARM_OPERATOR_GH_TOKEN/i.test(message);
}

interface StateOption {
	value: string;
	label: string;
}

/**
 * Build the option list for one status selector: an "Unmapped" choice, the
 * discovered states, and — when the stored value can't be rediscovered — a
 * neutral placeholder that preserves it until the operator deliberately changes
 * it (never a raw-ID fallback).
 */
function stateOptionsFor(
	states: Array<{ id: string; name: string }>,
	currentValue: string,
): StateOption[] {
	const options: StateOption[] = [{ value: '', label: 'Unmapped' }];
	if (currentValue && !states.some((s) => s.id === currentValue)) {
		options.push({ value: currentValue, label: NEUTRAL_UNAVAILABLE });
	}
	for (const s of states) {
		options.push({ value: s.id, label: s.name });
	}
	return options;
}

export function BoardMappingPanel({
	projectId,
	form,
	onProviderChange,
	onSelectContainer,
	onStatusOptionChange,
	onStatesContext,
	handleSubmit,
	handleReset,
	isDirty,
	isPending,
	isSuccess,
	isError,
	errorMessage,
}: BoardMappingPanelProps) {
	const provider = getPmMappingProvider(form.providerId);

	// The registered providers confirm which catalogue entries are actually
	// selectable — a catalogue entry alone never offers a provider the backend
	// can't discover.
	const providersQuery = useQuery(trpc.pm.listProviders.queryOptions({ projectId }));
	const registeredIds = new Set<string>((providersQuery.data ?? []).map((p) => p.id));
	const providerSelectable = registeredIds.has(form.providerId);

	const containersQuery = useQuery({
		...trpc.pm.discoverContainers.queryOptions({ projectId }),
		enabled: providerSelectable,
		retry: false,
	});

	const statesQuery = useQuery({
		...trpc.pm.discoverStates.queryOptions({ projectId, containerId: form.containerId }),
		enabled: providerSelectable && !!form.containerId,
		retry: false,
	});

	// Thread the discovered Status-field context back into the form so it is saved
	// alongside the option IDs. Guarded on a real change so it doesn't re-fire.
	const discoveredContext = statesQuery.data?.providerContext;
	const discoveredFieldId = discoveredContext?.statusFieldId;
	useEffect(() => {
		if (
			discoveredContext &&
			discoveredFieldId &&
			discoveredFieldId !== form.providerContext.statusFieldId
		) {
			onStatesContext(discoveredContext);
		}
	}, [discoveredContext, discoveredFieldId, form.providerContext.statusFieldId, onStatesContext]);

	const containers = containersQuery.data?.containers ?? [];
	const states = statesQuery.data?.states ?? [];
	const boardUnavailable =
		!!form.containerId &&
		!containersQuery.isLoading &&
		!containers.some((c) => c.id === form.containerId);
	const statesReady = statesQuery.isSuccess && states.length > 0;
	const statusSelectorsDisabled = isPending || !form.containerId || !statesReady;

	const containerErr = containersQuery.isError ? containersQuery.error?.message : undefined;
	const statesErr = statesQuery.isError ? statesQuery.error?.message : undefined;
	const canSave = canSaveBoardMapping(form);

	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm">
			<form onSubmit={handleSubmit} className="space-y-6">
				<div>
					<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
						Board Mapping
					</h2>

					<div className="max-w-xs">
						<label htmlFor="pm-provider" className={LABEL_CLASS}>
							Provider
						</label>
						<select
							id="pm-provider"
							value={form.providerId}
							onChange={(e) => onProviderChange(e.target.value)}
							disabled={isPending}
							className={SELECT_CLASS}
						>
							{PM_MAPPING_PROVIDERS.map((p) => (
								<option
									key={p.id}
									value={p.id}
									// Providers not yet in the registry are shown but not selectable.
									disabled={providersQuery.isSuccess && !registeredIds.has(p.id)}
								>
									{p.label}
								</option>
							))}
						</select>
					</div>

					<p className="text-xs text-zinc-400 mt-4">{provider.intro}</p>
				</div>

				{/* Board / container picker */}
				<div>
					<label htmlFor="pm-container" className={LABEL_CLASS}>
						{provider.label} {provider.containerNoun}
					</label>

					{isMissingCredentialError(containerErr) ? (
						<div className="p-3 bg-amber-950/20 border border-amber-900/30 text-xs text-amber-200 rounded">
							{containerErr}
						</div>
					) : (
						<>
							<select
								id="pm-container"
								value={form.containerId}
								onChange={(e) => onSelectContainer(e.target.value)}
								disabled={isPending || containersQuery.isLoading || !providerSelectable}
								className={SELECT_CLASS}
							>
								<option value="">
									{containersQuery.isLoading
										? `Discovering ${provider.containerNoun}s…`
										: `Select a ${provider.containerNoun}…`}
								</option>
								{boardUnavailable && (
									<option
										value={form.containerId}
									>{`Configured ${provider.containerNoun} (unavailable)`}</option>
								)}
								{containers.map((c) => (
									<option key={c.id} value={c.id}>
										{c.name}
									</option>
								))}
							</select>
							{containersQuery.isSuccess && containers.length === 0 && (
								<p className="text-xs text-zinc-500 mt-1">
									No {provider.containerNoun}s were found for the configured token.
								</p>
							)}
							{boardUnavailable && containersQuery.isSuccess && (
								<p className="text-xs text-amber-300/80 mt-1">
									The saved {provider.containerNoun} could not be rediscovered; its mapping is
									preserved until you pick another.
								</p>
							)}
							{containerErr && !isMissingCredentialError(containerErr) && (
								<p className="text-xs text-red-400 mt-1">
									Failed to load {provider.containerNoun}s: {containerErr}
								</p>
							)}
						</>
					)}
				</div>

				{/* Status → state mapping */}
				<div>
					<h3 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-1">
						Status mapping
					</h3>
					<p className="text-xs text-zinc-400 mb-4">
						Map each SWARM pipeline status to one of the {provider.containerNoun}'s{' '}
						{provider.stateNoun}es. Leave a status unmapped if the {provider.containerNoun} has no
						matching {provider.stateNoun}.
					</p>

					{statesQuery.isLoading && form.containerId && (
						<p className="text-xs text-zinc-500 mb-3">Discovering {provider.stateNoun}es…</p>
					)}
					{statesErr && (
						<p className="text-xs text-red-400 mb-3">
							Failed to load {provider.stateNoun}es: {statesErr}
						</p>
					)}

					<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
						{STATUS_KEYS.map((key) => {
							const value = form.statusOptions[key] ?? '';
							const options = stateOptionsFor(states, value);
							return (
								<div key={key}>
									<label htmlFor={`status-${key}`} className={LABEL_CLASS}>
										{STATUS_KEY_LABELS[key]}
									</label>
									<select
										id={`status-${key}`}
										aria-label={`${STATUS_KEY_LABELS[key]} ${provider.stateNoun}`}
										value={value}
										onChange={(e) => onStatusOptionChange(key, e.target.value)}
										disabled={statusSelectorsDisabled}
										className={SELECT_CLASS}
									>
										{options.map((o) => (
											<option key={o.value || 'unmapped'} value={o.value}>
												{o.label}
											</option>
										))}
									</select>
								</div>
							);
						})}
					</div>
				</div>

				{isSuccess && (
					<div className="p-3 bg-emerald-950/20 border border-emerald-900/30 text-sm text-emerald-400 rounded">
						Board mapping saved successfully.
					</div>
				)}

				{isError && (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						Failed to save board mapping: {errorMessage}
					</div>
				)}

				<div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
					<button
						type="submit"
						disabled={isPending || !isDirty || !canSave}
						className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed"
					>
						{isPending ? 'Saving…' : 'Save Changes'}
					</button>
					<button
						type="button"
						onClick={handleReset}
						disabled={isPending || !isDirty}
						className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
					>
						Reset
					</button>
				</div>
			</form>
		</div>
	);
}
