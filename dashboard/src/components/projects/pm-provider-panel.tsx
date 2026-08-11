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
 * where it used to live.
 *
 * Since issue #642 the control is **live**: picking another provider does not write
 * anything, it moves the tab into a client-held draft that walks the order the circular
 * dependency needs — supply the new provider's credentials, discover its boards and
 * states, map the canonical statuses, then save the whole `pm` member in one write.
 * Until that save the project keeps running on the provider it is persisted on, so
 * selecting the persisted provider again simply cancels.
 *
 * Nothing here names a provider of its own: the options and the prose both come from
 * the mapping catalogue, confirmed against the registry (`pm.listProviders`) so a
 * catalogue entry alone never offers a provider the backend can't serve.
 */

const SELECT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500';

interface PmProviderPanelProps {
	projectId: string;
	/** The provider the tab is currently scoped to — the draft one while switching. */
	providerId: string;
	/** The project's persisted `pm.type`; differs from {@link providerId} mid-switch. */
	persistedProviderId: string;
	onProviderChange: (providerId: string) => void;
	/** A config write is in flight, so the control is inert until it settles. */
	isPending: boolean;
}

export function PmProviderPanel({
	projectId,
	providerId,
	persistedProviderId,
	onProviderChange,
	isPending,
}: PmProviderPanelProps) {
	const provider = getPmMappingProvider(providerId);
	const persisted = getPmMappingProvider(persistedProviderId);
	const isSwitching = provider.id !== persisted.id;

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
							// Selectable when the registry serves it — a catalogue entry the backend
							// registers nothing for would offer a switch that could never discover a
							// board. The current selection stays selectable regardless, so the
							// control never holds a disabled value and a failed (or still loading)
							// `listProviders` degrades to "only the provider you are on", never to a
							// switch nothing can serve.
							disabled={p.id !== provider.id && !registeredIds.has(p.id)}
						>
							{p.label}
						</option>
					))}
				</select>
			</div>

			{isSwitching ? (
				<>
					<p className="text-xs text-zinc-400 mt-4">
						Switching this project from {persisted.label} to {provider.label}. Everything below is
						now scoped to {provider.label}: supply its credentials, pick a {provider.containerNoun},
						then map each SWARM status to one of its {provider.stateNounPlural}.
					</p>
					<p className="text-xs text-amber-300/80 mt-2">
						Nothing about this project changes until you save that mapping — {persisted.label} keeps
						running it until then, and its credentials are retained either way. Select{' '}
						{persisted.label} again to cancel.
					</p>
				</>
			) : (
				<>
					<p className="text-xs text-zinc-400 mt-4">
						This project's work items live on {provider.label}. Everything else on this tab — the
						credentials below, the {provider.containerNoun} they discover, and the status mapping —
						is scoped to that provider.
					</p>
					<p className="text-xs text-zinc-500 mt-2">
						Selecting another provider starts a switch here rather than changing anything at once:
						supply that provider's credentials, pick one of its boards, map the SWARM statuses, then
						save the new mapping in one go.
					</p>
				</>
			)}
		</div>
	);
}
