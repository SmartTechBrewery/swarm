import { useQuery } from '@tanstack/react-query';
import { getPmMappingProvider, PM_MAPPING_PROVIDERS } from '@/lib/board-mapping.js';
import { trpc } from '@/lib/trpc.js';

/**
 * The Project Management tab's Provider section (issue #630) — the tab's first
 * card, above Credentials and the board mapping.
 *
 * The provider scopes every other setting on the tab (which credential roles are
 * declared, which boards are discovered, which states a status can map to), so it
 * is stated *before* those settings rather than half-way down the mapping form
 * where it used to live. The control is deliberately display-only: switching
 * provider replaces the project's whole `pm` union member with a mapping the
 * dashboard cannot assemble until that provider's credentials and discovery exist,
 * so the copy below sends the operator to `swarm.config.json` (issue #631 makes
 * the switch live here).
 *
 * Nothing here names a provider: the options and the prose both come from the
 * mapping catalogue, confirmed against the registry (`pm.listProviders`) so a
 * catalogue entry alone never offers a provider the backend can't serve.
 */

const SELECT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500';

interface PmProviderPanelProps {
	projectId: string;
	/** The persisted provider — the project's `pm.type`, via the mapping form. */
	providerId: string;
	onProviderChange: (providerId: string) => void;
	/** A config write is in flight, so the control is inert until it settles. */
	isPending: boolean;
}

export function PmProviderPanel({
	projectId,
	providerId,
	onProviderChange,
	isPending,
}: PmProviderPanelProps) {
	const provider = getPmMappingProvider(providerId);

	// The registered providers confirm which catalogue entries are actually
	// selectable — a catalogue entry alone never offers a provider the backend
	// can't discover. A contributor whose `listProviders` query fails degrades to
	// catalogue-only disabling rather than to an empty control.
	const providersQuery = useQuery(trpc.pm.listProviders.queryOptions({ projectId }));
	const registeredIds = new Set<string>((providersQuery.data ?? []).map((p) => p.id));

	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm">
			<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
				Provider
			</h2>

			<div className="max-w-xs">
				{/* The card heading is the visible label; this one supplies the accessible
				    name without printing "Provider" twice above the same control. */}
				<label htmlFor="pm-provider" className="sr-only">
					Provider
				</label>
				<select
					id="pm-provider"
					value={providerId}
					onChange={(e) => onProviderChange(e.target.value)}
					disabled={isPending}
					className={SELECT_CLASS}
				>
					{PM_MAPPING_PROVIDERS.map((p) => (
						<option
							key={p.id}
							value={p.id}
							// Changing providers requires credentials and discovery for that
							// provider, so the tab stays scoped to the persisted one and this
							// control is display-only until issue #631 makes the switch live.
							disabled={
								p.id !== providerId || (providersQuery.isSuccess && !registeredIds.has(p.id))
							}
						>
							{p.label}
						</option>
					))}
				</select>
			</div>

			<p className="text-xs text-zinc-400 mt-4">
				This project's work items live on {provider.label}. Everything else on this tab — the
				credentials below, the {provider.containerNoun} they discover, and the status mapping — is
				scoped to that provider.
			</p>
			<p className="text-xs text-zinc-500 mt-2">
				The other options are disabled because switching provider replaces this project's whole
				board mapping, and the dashboard cannot assemble the new one before that provider's
				credentials and discovery exist. To move this project, set{' '}
				<code className="font-mono">pm.type</code> in{' '}
				<code className="font-mono">swarm.config.json</code> and run{' '}
				<code className="font-mono">swarm config apply</code>.
			</p>
		</div>
	);
}
