import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { RefreshCw, Search, SearchX, Server } from 'lucide-react';
import { useState } from 'react';
import { buttonClass } from '@/components/ui/button.js';
import { WorkerUpdateDialog } from '@/components/workers/worker-update-dialog.js';
import { WorkersTable } from '@/components/workers/workers-table.js';
import { canViewInstanceWide } from '@/lib/instance-admin.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import { filterWorkersBySearch } from '@/lib/worker-search.js';
import { WORKERS_REFETCH_MS } from '@/lib/workers-refresh.js';
import type { WorkerRow } from '@/types/workers.js';

interface WorkersRosterProps {
	/**
	 * Scope the roster to one project (issue #574) — the project detail page's
	 * Workers tab. Omitted on `/workers`, which shows every machine the viewer may
	 * see. Scoping is the *server's* (`workers.list`'s optional `projectId`), so
	 * enrollments elsewhere, machines enrolled in no project at all, and an active
	 * job in another project never reach the browser — and a viewer who may not
	 * access the project gets NOT_FOUND rather than a roster.
	 */
	projectId?: string;
	/**
	 * Whether the viewer administers the scoped project — the server-declared
	 * `projects.viewerAccess` capability, passed by the route, which fails closed
	 * while it loads so nothing it gates ever flashes in for a non-administrator.
	 * Two offers turn on it: the project's worker-order controls (issue #750 phase
	 * 2) and the scoped update action. Both re-check `projectAdmin` server-side
	 * regardless. Ignored without a `projectId` — neither offer exists on the global
	 * screen, where the installation role decides instead.
	 *
	 * Named after the capability rather than after either use: it arrived as
	 * `canReorder`, which stopped being true of it the moment a second thing
	 * depended on it.
	 */
	canAdminister?: boolean;
}

/**
 * The worker roster body (issue #133) — the query plus its loading, error,
 * empty, and populated states — shared verbatim by the `/workers` screen and the
 * project detail page's Workers tab (issue #574). One component rather than two
 * panels, so the scoped view *is* the global experience (consent switch, current
 * job, capabilities, row navigation, poll cadence) rather than a re-implementation
 * of it that can drift.
 *
 * What the two views do *not* share is what a project administrator may do to the
 * project: the reorder mutation (issue #750 phase 2), which lives here rather than
 * in the table because this is the component that already knows the project and
 * owns the `workers.list` cache the new order lands in, and the scoped update
 * action in the toolbar. Both hang off one server-declared capability
 * (`canAdminister`), and the global screen answers to the installation role
 * instead — so the surfaces diverge exactly where the permissions do, and nowhere
 * else.
 *
 * The search box (issue #897) lives here for the same reason: this is the
 * component holding the rows, so both surfaces get it from one place and the
 * table stays presentational. It is a filter over an already-fetched list —
 * `workers.list` returns the whole visible roster in one response — so typing
 * issues no request and clearing restores the full list.
 *
 * Polling, not realtime — {@link WORKERS_REFETCH_MS} is comfortably below the
 * default 60s heartbeat TTL. Authorization lives entirely on the server
 * (`workers.list`/`roster`/`listMine`/`setConsent`/`reorderProjectWorker`); this
 * renders and mutates only what those procedures allow.
 */
export function WorkersRoster({ projectId, canAdminister = false }: WorkersRosterProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [search, setSearch] = useState('');
	const query = search.trim();
	// `undefined` rather than a no-argument call: the two variants stay on distinct
	// query keys, so a project tab never reads the global roster out of the cache.
	const workersQueryOptions = trpc.workers.list.queryOptions(projectId ? { projectId } : undefined);
	const workersQuery = useQuery({
		...workersQueryOptions,
		refetchInterval: WORKERS_REFETCH_MS,
	});

	// A row click opens that machine's detail view (issue #477). The selection is a
	// route param, not table state, so the deep link works and Back returns here.
	const openWorker = (workerId: string) => {
		navigate({ to: '/workers/$workerId', params: { workerId } });
	};

	const reorderMutation = useMutation({
		mutationFn: (variables: { workerId: string; direction: 'up' | 'down' }) => {
			if (!projectId) throw new Error('Reordering needs a project.');
			return trpcClient.workers.reorderProjectWorker.mutate({ projectId, ...variables });
		},
		onSuccess: (result) => {
			// Apply the order the server just returned before the refetch lands, so the
			// row visibly moves on click…
			queryClient.setQueryData<WorkerRow[]>(workersQueryOptions.queryKey, (old) =>
				old ? sortByWorkerIds(old, result.workerIds) : old,
			);
			// …then reconcile against the authoritative read model.
			queryClient.invalidateQueries({ queryKey: workersQueryOptions.queryKey });
		},
	});

	// Withheld unless all three hold: the global screen has no project order, a
	// non-administrator may not change one, and a *filtered* list is the wrong
	// thing to reorder against — a move is relative to the project's whole order,
	// so on a narrowed list the boundary arrows would disable against the wrong
	// rows and a move would step over a machine the viewer cannot see.
	const reorder =
		canAdminister && projectId && query === ''
			? {
					onMove: (workerId: string, direction: 'up' | 'down') =>
						reorderMutation.mutate({ workerId, direction }),
					pendingWorkerId: reorderMutation.isPending
						? reorderMutation.variables?.workerId
						: undefined,
					error:
						reorderMutation.isError && reorderMutation.variables
							? {
									workerId: reorderMutation.variables.workerId,
									message: reorderMutation.error.message,
								}
							: null,
				}
			: undefined;

	if (workersQuery.isLoading) {
		return <div className="text-sm text-zinc-400">Loading workers…</div>;
	}
	if (workersQuery.isError) {
		return (
			<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
				{workersQuery.error.message}
			</div>
		);
	}
	if (workersQuery.data && workersQuery.data.length > 0) {
		const workers = workersQuery.data as WorkerRow[];
		const visible = filterWorkersBySearch(workers, query);
		return (
			<div className="space-y-4">
				<RosterToolbar
					projectId={projectId}
					canAdminister={canAdminister}
					search={search}
					onSearchChange={setSearch}
				/>
				{visible.length > 0 ? (
					<WorkersTable
						workers={visible}
						refetchInterval={WORKERS_REFETCH_MS}
						onSelectWorker={openWorker}
						reorder={reorder}
					/>
				) : (
					<NoMatchingWorkers query={query} onClear={() => setSearch('')} />
				)}
			</div>
		);
	}
	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/20 p-8 text-center space-y-2">
			<Server className="w-12 h-12 stroke-1 text-zinc-700 mx-auto" />
			<p className="text-sm text-zinc-400">No workers to show.</p>
			<p className="text-xs text-zinc-500">
				A machine appears here once it is registered with{' '}
				<span className="font-mono">swarm workers register</span> and enrolled in{' '}
				{projectId ? 'this project' : 'a project you can access'}.
			</p>
		</div>
	);
}

/**
 * The row above the table: narrowing the list on the left, acting on the machines
 * it lists on the right, wrapping to two rows on a phone rather than crushing
 * either.
 *
 * It decides what it offers rather than being told. The update action exists on
 * both rosters, but they are **two different actions and two different
 * permissions**, which is why this is a branch rather than one button with a
 * flag threaded through:
 *
 * - Unscoped, it is installation-wide — every registered machine, including ones
 *   enrolled in no project at all — so it is an instance administrator's act. Asked
 *   for here rather than inferred from `/workers` already rendering behind that
 *   gate, so mounting the roster anywhere else can never hand the button to a
 *   viewer the gate would have refused. An unresolved viewer offers nothing, which
 *   is `canViewInstanceWide`'s own contract.
 * - Scoped, it reaches only the machines enrolled in *this* project, so the
 *   project's own administrator may ask for it — a narrower act, on machines they
 *   already administer here, needing no installation role. `canAdminister` is the
 *   server-declared capability and fails closed while it loads.
 *
 * Neither is ever offered in the other's place: a project administrator gets no
 * installation-wide button, and the scoped one never appears on `/workers`, where
 * "this project" names nothing. The server stays the enforcement point for both,
 * exactly as it is for the roster read itself.
 */
function RosterToolbar({
	projectId,
	canAdminister,
	search,
	onSearchChange,
}: {
	projectId?: string;
	canAdminister: boolean;
	search: string;
	onSearchChange: (next: string) => void;
}) {
	const currentUser = useCurrentUser();
	const canRequestFleetUpdate = !projectId && canViewInstanceWide(currentUser.data);

	// One line: the search field grows into the space up to `max-w-sm`, the action is
	// pushed to the right edge, and only a window too narrow for both drops the button
	// to a second row rather than squeezing the input below readable.
	return (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<WorkersSearchBox value={search} onChange={onSearchChange} />
			{canRequestFleetUpdate ? <UpdateWorkersButton scope="installation" /> : null}
			{projectId && canAdminister ? (
				<UpdateWorkersButton scope="project" projectId={projectId} />
			) : null}
		</div>
	);
}

/**
 * The roster's search box (issue #897) — rendered only once the roster has rows,
 * so the "no workers at all" state stays a plain explanation with nothing to type
 * into. The query is component state rather than a route search param: it is
 * transient, and the project detail page's own `?tab=` search already owns that
 * URL.
 */
function WorkersSearchBox({
	value,
	onChange,
}: {
	value: string;
	onChange: (next: string) => void;
}) {
	return (
		<div className="relative flex-1 min-w-[12rem] max-w-sm">
			<Search
				className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
				aria-hidden="true"
			/>
			{/* The design-system Input recipe with its left padding widened for the icon. */}
			<input
				type="search"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				aria-label="Search workers"
				placeholder="Search machine, owner, or repository…"
				className="block w-full py-2 pl-9 pr-3 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
			/>
		</div>
	);
}

/** The set each toolbar action names — the one phrase its title and its copy share. */
const INSTALLATION_SET = 'every registered machine on this installation';
const PROJECT_SET = 'every machine enrolled in this project';

/**
 * The roster's update action: ask the machines this roster lists to move to the
 * build the control plane is running.
 *
 * It sits in the toolbar rather than on the page header because it acts on the
 * thing below it, and it reads as one of the list's controls — the counterpart to
 * the search box, which narrows the same roster. `secondary` because the screen's
 * subject is the roster, and a filled violet button would read as the reason the
 * page exists — at the default `md`, because a button is sized by what it stands
 * next to and this one shares its row with the search input.
 *
 * **The label names the set, and the two sets are genuinely different**: every
 * registered machine on the installation, or only the ones enrolled in this
 * project. Neither is the *filtered* list — scoping an action with these
 * consequences to a transient text box would make the search mean two things — so
 * the copy names the whole set and the filter is left to do only what it looks
 * like it does.
 *
 * **Both are wired** — the installation-wide one by issue #1009, the project-scoped
 * one by issue #1010 — and neither fires on a single click: each opens
 * {@link WorkerUpdateDialog}, which names the build and its own set before anything
 * is asked and then renders the per-machine report. What either asks for is the
 * control plane's **own commit**, read from `workers.controlPlaneBuild` and never a
 * ref the browser invents — the same decision the one-machine button inherited from
 * issue #998, and for the same reason: that commit is the comparand a machine's
 * `Outdated` mark is judged against, so a successful update clears it, where `main`
 * would land the machine on whatever was on it at apply time. A control plane that
 * cannot read its own build therefore has nothing to offer, so the button is
 * `disabled` and its title says so rather than falling back to a ref. That read is
 * on the roster's polling cadence, so the commit the action names is the one the
 * live control plane is running now and not the one it was running when the page
 * was opened.
 *
 * The installation-wide one calls `requestUpdateForInstallation` rather than
 * `startFleetUpdate`: that one is **owner-scoped** (`listWorkersForOwner`), so it
 * cannot serve a button labelled "Update all workers" on an installation-wide
 * screen. The fan-out is safe to use unstaged for the reason the procedure itself
 * states — it asks only machines their owners have already drained, so it cannot
 * take the installation's capacity down. A *staged* installation-wide rollout stays
 * issue #922's open question and belongs in its own issue rather than in a widened
 * `startFleetUpdate`.
 *
 * The project-scoped one calls `requestUpdateForProject`, which is a third
 * *selection* over that same fan-out rather than the installation-wide procedure
 * with a project passed in: the two answer to different rules — `instanceAdmin`
 * there, `projectAdmin` here — and one procedure whose scope depended on whether an
 * argument was present would be one omitted field away from the wider act. Its own
 * copy carries the one thing only it has to say: an update moves a machine's SWARM
 * install root, so a machine this project shares with another is moved for both.
 *
 * The client-side gates stay at the call site — `canViewInstanceWide` for the
 * installation, the server-declared `canAdminister` capability for the project, each
 * a decision about what to *offer* rather than a copy of a server precondition — and
 * the refusal the server answers with is rendered verbatim in the dialog either way.
 *
 * The two stay separate components rather than one body with a `scope` flag: the
 * title, the confirmation copy, the modal heading and the procedure all differ, so a
 * single body would branch at every one of them. What they share they share
 * properly — one dialog, and one `controlPlaneBuild` query key, so the second reader
 * costs no second request.
 */
function UpdateWorkersButton(
	props: { scope: 'installation' } | { scope: 'project'; projectId: string },
) {
	return props.scope === 'installation' ? (
		<UpdateAllWorkersButton />
	) : (
		<UpdateProjectWorkersButton projectId={props.projectId} />
	);
}

/**
 * The project-scoped action (issue #1010) — see {@link UpdateWorkersButton} for why
 * it is its own component and why it calls its own procedure.
 *
 * The set is the project's *enrolled* machines, which the server resolves from the
 * project's own configured order — never the rows the search box happens to be
 * showing, which is why the copy names the whole set rather than a count.
 */
function UpdateProjectWorkersButton({ projectId }: { projectId: string }) {
	const [confirming, setConfirming] = useState(false);
	// The same query key the installation-wide action reads, so the two never disagree
	// about the build and only one request is in flight for both.
	const buildQuery = useQuery({
		...trpc.workers.controlPlaneBuild.queryOptions(),
		refetchInterval: WORKERS_REFETCH_MS,
	});
	const target = buildQuery.data?.build?.commit ?? null;

	return (
		<>
			<button
				type="button"
				onClick={() => setConfirming(true)}
				disabled={!target}
				title={updateActionTitle(PROJECT_SET, buildQuery.isPending, target)}
				className={buttonClass('secondary')}
			>
				<RefreshCw className="h-4 w-4" aria-hidden="true" />
				Update project workers
			</button>
			{target ? (
				<WorkerUpdateDialog
					open={confirming}
					onClose={() => setConfirming(false)}
					title="Update every worker enrolled in this project?"
					confirmCopy={
						<strong className="text-zinc-200">
							{PROJECT_SET}, including machines you do not own,
						</strong>
					}
					scopeNote={
						// The mechanism has no per-enrollment SWARM to move, so this says what the
						// action actually does rather than implying a semantics it does not have.
						<>
							A machine enrolled in other projects as well is moved for all of them: an update moves
							its SWARM install root and restarts its daemon, not one enrollment.
						</>
					}
					target={target}
					requestUpdate={() =>
						trpcClient.workers.requestUpdateForProject.mutate({ projectId, target })
					}
				/>
			) : null}
		</>
	);
}

/** The installation-wide action — see {@link UpdateWorkersButton} for why it is shaped this way. */
function UpdateAllWorkersButton() {
	const [confirming, setConfirming] = useState(false);
	// One value for the whole installation, so it is its own query rather than a
	// roster row field: `workers.list` answers with a bare array, and repeating the
	// comparand on every row would say nothing the `Outdated` mark does not.
	//
	// On the roster's own cadence, because the control plane resolves this from the
	// process it is running in: redeploy it and a page left open would otherwise
	// keep offering — and name — the build it read at mount, rolling every machine
	// onto a commit the live server has already moved off. The one-machine button
	// reads the same value off `workers.getById`, which polls at this interval too, so
	// both surfaces answer with the same build at the same age.
	const buildQuery = useQuery({
		...trpc.workers.controlPlaneBuild.queryOptions(),
		refetchInterval: WORKERS_REFETCH_MS,
	});
	const target = buildQuery.data?.build?.commit ?? null;

	return (
		<>
			<button
				type="button"
				onClick={() => setConfirming(true)}
				disabled={!target}
				title={updateActionTitle(INSTALLATION_SET, buildQuery.isPending, target)}
				className={buttonClass('secondary')}
			>
				<RefreshCw className="h-4 w-4" aria-hidden="true" />
				Update all workers
			</button>
			{target ? (
				<WorkerUpdateDialog
					open={confirming}
					onClose={() => setConfirming(false)}
					title="Update every worker on this installation?"
					confirmCopy={
						<strong className="text-zinc-200">
							{INSTALLATION_SET}, including machines you do not own,
						</strong>
					}
					target={target}
					requestUpdate={() => trpcClient.workers.requestUpdateForInstallation.mutate({ target })}
				/>
			) : null}
		</>
	);
}

/**
 * A toolbar action's own title: what the click will ask for, or why there is nothing
 * to ask for yet. A module-level helper rather than a ternary in the attribute, so
 * each disabled case stays one readable sentence — the shape the worker detail
 * view's own title helper uses.
 *
 * `set` is the only part that differs between the two actions: both read the same
 * build the same way, so both explain an unreadable one in the same words rather
 * than in two copies that can drift.
 */
function updateActionTitle(set: string, loading: boolean, target: string | null): string {
	if (target) {
		return `Asks ${set} to move its SWARM install root to ${target.slice(0, 7)} — the build this control plane is running — and restart its daemon.`;
	}
	return loading
		? 'Reading the build this control plane is running…'
		: 'This control plane cannot read its own build, so there is no build to ask these machines to move to.';
}

/**
 * A search that matched nothing, deliberately distinct from the empty-roster
 * state above: that one means no machine is enrolled and tells the operator how
 * one gets here, while this one means the roster is populated and the query is
 * what hid it — so it names the query, says what is matched, and offers the way
 * back to the full list.
 */
function NoMatchingWorkers({ query, onClear }: { query: string; onClear: () => void }) {
	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/20 p-8 text-center space-y-2">
			<SearchX className="w-12 h-12 stroke-1 text-zinc-700 mx-auto" />
			<p className="text-sm text-zinc-400">No workers match “{query}”.</p>
			<p className="text-xs text-zinc-500">
				Search matches a machine’s name, its owner, and the repository it declared.
			</p>
			<button type="button" onClick={onClear} className={`${buttonClass('secondary', 'sm')} mt-2`}>
				Clear search
			</button>
		</div>
	);
}

/**
 * Re-sequence the cached rows to the worker-id order `reorderProjectWorker`
 * returned. A row the response doesn't name keeps its relative position at the
 * end rather than vanishing — the two lists come from the same project, so that
 * only happens if the roster changed under the move, and the invalidation right
 * after settles it either way.
 */
function sortByWorkerIds(rows: WorkerRow[], workerIds: string[]): WorkerRow[] {
	const rank = new Map(workerIds.map((workerId, index) => [workerId, index]));
	return [...rows].sort(
		(a, b) =>
			(rank.get(a.workerId) ?? Number.MAX_SAFE_INTEGER) -
			(rank.get(b.workerId) ?? Number.MAX_SAFE_INTEGER),
	);
}
