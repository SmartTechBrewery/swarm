import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import { AlertCircle, Calendar, Gauge, Info, RefreshCw, Server, ShieldAlert } from 'lucide-react';
import { buttonClass } from '@/components/ui/button.js';
import { trpc } from '@/lib/trpc.js';
import type { WorkerCliQuotaSnapshot } from '../../../src/db/repositories/cliQuotasRepository.js';
import { rootRoute } from './__root.js';

interface QuotaWindowProps {
	name: string;
	usedPercent?: number;
	durationMins?: number;
	resetsAt?: string;
}

/**
 * Urgency thresholds for the remaining-quota bar, both inclusive (issue #753).
 *
 * The bar reads *remaining* allowance rather than usage, so the colour steps
 * down as the number falls: amber once 30% or less is left, rose once 10% or
 * less is. They are named constants because the boundaries themselves are the
 * behaviour operators read the bar by.
 */
const QUOTA_WARNING_REMAINING_PERCENT = 30;
const QUOTA_CRITICAL_REMAINING_PERCENT = 10;

/** The bar's curated colour for a remaining-quota percentage. */
function quotaBarColor(remainingPercent: number): string {
	if (remainingPercent <= QUOTA_CRITICAL_REMAINING_PERCENT) return 'bg-rose-500';
	if (remainingPercent <= QUOTA_WARNING_REMAINING_PERCENT) return 'bg-amber-500';
	return 'bg-emerald-500';
}

export function QuotaWindowCard({
	name,
	usedPercent = 0,
	durationMins,
	resetsAt,
}: QuotaWindowProps) {
	const remainingPercent = Math.max(0, 100 - usedPercent);
	const durationText = durationMins
		? durationMins % 1440 === 0
			? `${durationMins / 1440}d`
			: durationMins % 60 === 0
				? `${durationMins / 60}h`
				: `${durationMins}m`
		: '';

	const progressColor = quotaBarColor(remainingPercent);

	const formatResetTime = (isoString?: string) => {
		if (!isoString) return '';
		try {
			const date = new Date(isoString);
			return date.toLocaleString();
		} catch {
			return isoString;
		}
	};

	return (
		<div className="border border-zinc-800/60 rounded bg-zinc-900/40 p-4 space-y-3">
			<div className="flex items-center justify-between">
				<span className="text-xs font-semibold text-zinc-300">
					{name} {durationText && `(${durationText})`}
				</span>
				<span className="text-xs font-mono font-medium text-zinc-400">
					{remainingPercent}% remaining
				</span>
			</div>

			<div className="w-full bg-zinc-800 h-2 rounded-full overflow-hidden">
				<div
					data-testid="quota-bar"
					className={`h-full ${progressColor} transition-all duration-550`}
					style={{ width: `${remainingPercent}%` }}
				/>
			</div>

			{resetsAt && (
				<div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
					<Calendar className="h-3 w-3 shrink-0" />
					<span>Resets: {formatResetTime(resetsAt)}</span>
				</div>
			)}
		</div>
	);
}

/**
 * Every worker sharing one machine, gathered under the machine they describe
 * (issue #823, widened by the hostname grouping below).
 */
interface MachineGroup {
	/**
	 * `hostname` when reported, else the sole worker's id — a React list key only,
	 * not a grouping key (`groupByMachine` groups hostname-keyed and worker-keyed
	 * machines in two separate maps, so this string's two possible origins can never
	 * collide with each other in a way that merges two machines).
	 */
	machineKey: string;
	/** The machine's self-reported hostname, or `null` for the per-worker fallback. */
	hostname: string | null;
	/** Every one of the owner's workers on this machine, sorted by name. */
	workerNames: string[];
	available: WorkerCliQuotaSnapshot[];
	unavailable: WorkerCliQuotaSnapshot[];
	lastUpdated: number | null;
}

/**
 * Gather snapshots under the *machine* that reported them rather than the worker
 * alone (issue #703, re-keyed onto the worker by #823, grouped onto the machine
 * here): several of an owner's workers can be the same physical machine — the
 * worker's display name is chosen at registration and cannot tell two workers on
 * one box apart from two on separate ones — and each independently discovers and
 * reports what is, for a machine-local CLI login, the *same* real allowance. Left
 * grouped by worker alone, the page showed that one allowance once per worker
 * sharing it, which reads as N independent quotas rather than one shared machine's.
 *
 * A worker with no reported hostname (a daemon that predates the `workers.hostname`
 * column) groups alone, exactly as grouping on `workerId` alone always did — kept
 * in a *separate* map from the hostname-keyed groups below, rather than a shared
 * map with a `worker:<id>`-prefixed fallback key, because `hostname` is a fully
 * unauthenticated, unconstrained string (`z.string().min(1)`, no format check): a
 * daemon could self-report exactly that shape and silently merge into an unrelated
 * ungrouped worker's section. Two separate maps make that impossible rather than
 * merely unlikely.
 *
 * Within a machine, snapshots are deduplicated per CLI, keeping the most recently
 * reported one — never merged or averaged. This assumes what the operator who
 * asked for this page confirmed directly: co-located workers share one real CLI
 * login, so two reports for the same CLI can only disagree by being differently
 * stale, and the freshest is the most honest single answer to show. It does mean a
 * workers pair that is *not* actually sharing one CLI account (a hostname collision,
 * or two logins deliberately kept separate on one box) has its older, possibly
 * still-accurate report silently dropped rather than surfaced as a conflict — accepted
 * here because the whole feature exists to collapse what is normally the same
 * allowance, and the corrected `machineKey` above already closes the one collision
 * this page could itself cause.
 *
 * `hostname` is diagnostic and unauthenticated (`src/db/schema/workers.ts`
 * "Diagnostic only" note) so this grouping is display only: it changes nothing
 * about which rows a viewer is scoped to see (`listCliQuotasForOwner` already did
 * that on `worker_id`), only how the rows this viewer already owns are presented.
 */
function groupByMachine(quotas: WorkerCliQuotaSnapshot[]): MachineGroup[] {
	interface Building {
		hostname: string | null;
		workerNames: Set<string>;
		byCli: Map<string, WorkerCliQuotaSnapshot>;
		lastUpdated: number | null;
	}
	// Keyed separately so a self-reported hostname can never collide with the other
	// map's per-worker fallback key — see the docstring above.
	const byHostname = new Map<string, Building>();
	const byWorkerId = new Map<string, Building>();

	for (const quota of quotas) {
		const groups = quota.workerHostname !== null ? byHostname : byWorkerId;
		const key = quota.workerHostname ?? quota.workerId;
		let group = groups.get(key);
		if (!group) {
			group = {
				hostname: quota.workerHostname,
				workerNames: new Set(),
				byCli: new Map(),
				lastUpdated: null,
			};
			groups.set(key, group);
		}
		group.workerNames.add(quota.workerName);

		const updated = new Date(quota.lastUpdated).getTime();
		const existing = group.byCli.get(quota.cli);
		const existingUpdated = existing ? new Date(existing.lastUpdated).getTime() : Number.NaN;
		// A malformed `lastUpdated` on the first report for a CLI must not permanently
		// block every later, valid report from replacing it (`x > NaN` is always false).
		if (!existing || Number.isNaN(existingUpdated) || updated > existingUpdated) {
			group.byCli.set(quota.cli, quota);
		}

		if (!Number.isNaN(updated) && (group.lastUpdated === null || updated > group.lastUpdated)) {
			group.lastUpdated = updated;
		}
	}

	function toMachineGroup(key: string, group: Building): MachineGroup {
		const available: WorkerCliQuotaSnapshot[] = [];
		const unavailable: WorkerCliQuotaSnapshot[] = [];
		for (const q of group.byCli.values()) {
			(q.status === 'available' ? available : unavailable).push(q);
		}
		return {
			machineKey: key,
			hostname: group.hostname,
			workerNames: [...group.workerNames].sort((a, b) => a.localeCompare(b)),
			available,
			unavailable,
			lastUpdated: group.lastUpdated,
		};
	}

	return [
		...[...byHostname.entries()].map(([key, group]) => toMachineGroup(key, group)),
		...[...byWorkerId.entries()].map(([key, group]) => toMachineGroup(key, group)),
	].sort((a, b) => (a.hostname ?? a.workerNames[0]).localeCompare(b.hostname ?? b.workerNames[0]));
}

/** The display name for a CLI identifier. */
function cliLabel(cli: string): string {
	if (cli === 'claude') return 'Claude Code';
	if (cli === 'antigravity') return 'Antigravity (Gemini)';
	return 'Codex';
}

export function QuotaRouteComponent() {
	const queryClient = useQueryClient();
	const quotasQuery = useQuery(trpc.quota.getQuotas.queryOptions());

	const formatTime = (isoString?: string) => {
		if (!isoString) return 'Never';
		try {
			return new Date(isoString).toLocaleString();
		} catch {
			return isoString;
		}
	};

	const machineGroups = groupByMachine(quotasQuery.data || []);

	// Re-reads the stored snapshots. There is no probe to trigger from here: a
	// machine's allowance is discovered by the worker that runs on it, not by the
	// process serving this page (issue #823).
	const handleRefresh = () => {
		void queryClient.invalidateQueries({
			queryKey: trpc.quota.getQuotas.queryOptions().queryKey,
		});
	};

	if (quotasQuery.isLoading) {
		return <div className="text-sm text-zinc-400">Loading CLI quotas…</div>;
	}

	return (
		<div className="space-y-6 max-w-5xl">
			{/* Page Header */}
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-5">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
						<Gauge className="h-6 w-6 text-violet-400" />
						CLI Quotas & Capabilities
					</h1>
					<p className="text-xs text-zinc-500 mt-1">
						Status, rate limits, and remaining allowance for the agent CLIs on the workers you own.
					</p>
				</div>
				<div className="flex items-center gap-3">
					<button
						type="button"
						onClick={handleRefresh}
						disabled={quotasQuery.isFetching}
						className={buttonClass('secondary')}
					>
						<RefreshCw
							className={`h-4 w-4 ${quotasQuery.isFetching ? 'animate-spin text-violet-400' : ''}`}
						/>
						{quotasQuery.isFetching ? 'Refreshing…' : 'Refresh'}
					</button>
				</div>
			</div>

			{/* The page reads stored snapshots (`quota.getQuotas`), never live figures, so the
			    freshness limitation is stated once here — unconditionally, so a populated card
			    carries the same caveat as an empty one — rather than repeated per placeholder. */}
			<div className="p-3 bg-zinc-900/50 border border-zinc-800 rounded flex items-start gap-3">
				<Info className="h-5 w-5 text-zinc-500 shrink-0 mt-0.5" aria-hidden="true" />
				<p className="text-sm text-zinc-300">
					Quota data is read from the last stored snapshot for each worker, so it may be out of
					date. Refresh re-reads the latest stored snapshot.
				</p>
			</div>

			{quotasQuery.isError && (
				<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex flex-col gap-2">
					<h3 className="text-sm font-semibold text-red-200">Error Loading Quotas</h3>
					<p className="text-xs text-red-400/80 font-mono">{quotasQuery.error.message}</p>
				</div>
			)}

			{machineGroups.length === 0 ? (
				/* One state covers both cases — owning no worker, and owning a worker that has
				   not reported — because the page has no way to tell an operator apart from
				   the other and the remedy is the same. */
				<div className="border border-zinc-850 rounded-lg p-6 bg-zinc-900/20 text-center space-y-2">
					<ShieldAlert className="h-8 w-8 text-zinc-650 mx-auto" />
					<p className="text-sm text-zinc-400">
						No CLI quota has been reported for any worker you own.
					</p>
					<p className="text-xs text-zinc-500">
						This page shows only your own registered machines.
					</p>
				</div>
			) : (
				machineGroups.map((group) => (
					<div key={group.machineKey} className="space-y-4">
						{/* Machine header — every allowance below belongs to this machine alone,
						    shared by every worker on it listed beside the name. */}
						<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-850 pb-2">
							<h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
								<Server className="h-4 w-4 text-zinc-500" />
								<span className="font-mono">{group.hostname ?? group.workerNames[0]}</span>
								{group.workerNames.length > 1 && (
									<span className="text-[11px] font-mono text-zinc-500 font-normal">
										(workers: {group.workerNames.join(', ')})
									</span>
								)}
							</h2>
							{group.lastUpdated !== null && (
								<span className="text-[11px] text-zinc-500 font-mono">
									Last updated: {new Date(group.lastUpdated).toLocaleString()}
								</span>
							)}
						</div>

						{/* Active Quota Cards */}
						<div className="space-y-4">
							<h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
								Active Quotas
							</h3>

							{group.available.length === 0 ? (
								<div className="border border-zinc-850 rounded-lg p-6 bg-zinc-900/20 text-center space-y-2">
									<ShieldAlert className="h-8 w-8 text-zinc-650 mx-auto" />
									<p className="text-sm text-zinc-400">
										No quota data is available for this worker.
									</p>
								</div>
							) : (
								<div className="grid gap-6 md:grid-cols-2">
									{group.available.map((q) => (
										<div
											key={`${group.machineKey}:${q.cli}`}
											className="border border-zinc-800 rounded-lg bg-panel/45 p-6 space-y-6 flex flex-col justify-between"
										>
											<div className="space-y-4">
												{/* Card Header */}
												<div className="flex items-center justify-between">
													<div>
														<h4 className="text-base font-semibold text-zinc-200">
															{cliLabel(q.cli)}
														</h4>
														<span className="text-xs text-zinc-500 font-mono font-light">
															{q.cli}
														</span>
													</div>
													<div className="flex items-center gap-2">
														{q.source === 'live' ? (
															<span className="px-2 py-0.5 text-[10px] font-semibold text-emerald-400 bg-emerald-950/20 border border-emerald-900/30 rounded-full">
																Live Data
															</span>
														) : (
															<span className="px-2 py-0.5 text-[10px] font-semibold text-amber-400 bg-amber-950/20 border border-amber-900/30 rounded-full">
																Fallback Status
															</span>
														)}
														<span className="px-2 py-0.5 text-[10px] font-semibold text-violet-400 bg-violet-950/20 border border-violet-900/30 rounded-full">
															Available
														</span>
													</div>
												</div>

												{/* Credits Info — the plan tier this row used to share is deliberately
												    not shown (issue #679): it is account/product detail, not a quota. */}
												{q.credits && (
													<div className="grid grid-cols-2 gap-4 border-t border-zinc-850 pt-4 text-xs">
														<div>
															<span className="text-zinc-500 block">Credits / Resets</span>
															<span className="text-zinc-300 font-medium font-mono">
																{q.credits}
															</span>
														</div>
													</div>
												)}

												{/* Windows & Usage */}
												{q.windows && q.windows.length > 0 ? (
													<div className="space-y-3 pt-2">
														<span className="text-xs text-zinc-400 font-medium block">
															Usage Windows
														</span>
														<div className="space-y-3">
															{q.windows.map((w, index) => (
																<QuotaWindowCard
																	key={w.sourceSlot ?? index}
																	name={w.name}
																	usedPercent={w.usedPercent}
																	durationMins={w.durationMins}
																	resetsAt={w.resetsAt}
																/>
															))}
														</div>
													</div>
												) : (
													<div className="pt-2">
														{q.resetTime ? (
															<div className="p-3.5 bg-amber-950/10 border border-amber-900/20 rounded-md text-xs text-amber-400 space-y-1">
																<div className="font-semibold flex items-center gap-1.5">
																	<AlertCircle className="h-4 w-4" />
																	Rate Limit Exhaustion Detected
																</div>
																<p className="text-amber-400/80">
																	Exhaustion was hit recently. The limit is scheduled to reset
																	around{' '}
																	<span className="font-semibold font-mono">
																		{formatTime(q.resetTime)}
																	</span>
																	.
																</p>
																{q.error && (
																	<p className="text-[11px] text-amber-500/70 border-t border-amber-900/10 pt-1.5 mt-1.5 font-mono truncate">
																		{q.error}
																	</p>
																)}
															</div>
														) : (
															<div className="p-3 bg-zinc-900/20 border border-zinc-850 rounded-md text-xs text-zinc-400 flex items-start gap-2">
																<Info className="h-4 w-4 text-zinc-500 shrink-0 mt-0.5" />
																<div>No usage window data is available for this CLI.</div>
															</div>
														)}
													</div>
												)}
											</div>
										</div>
									))}
								</div>
							)}
						</div>

						{/* Diagnostics / Unavailable Section */}
						{group.unavailable.length > 0 && (
							<div className="space-y-4 pt-4">
								<h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
									Diagnostics
								</h3>
								<div className="border border-zinc-850 rounded-lg overflow-hidden bg-zinc-900/10">
									<div className="divide-y divide-zinc-850">
										{group.unavailable.map((q) => (
											<div
												key={`${group.machineKey}:${q.cli}`}
												className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-zinc-900/20 transition-colors"
											>
												<div className="space-y-1">
													<div className="flex items-center gap-2">
														<span className="text-sm font-semibold text-zinc-300">
															{cliLabel(q.cli)}
														</span>
														<span className="text-[10px] font-mono text-zinc-500">({q.cli})</span>
													</div>
													{/* The badge beside this row already says the CLI is unavailable; with no
													    reported detail the row states that absence rather than asserting a
													    cause the snapshot never gave (issue #754). */}
													<p className="text-xs text-zinc-500 font-mono max-w-xl">
														{q.error || 'No error detail is available for this CLI.'}
													</p>
												</div>
												<div className="flex items-center gap-2 shrink-0">
													<span className="px-2.5 py-0.5 text-[10px] font-semibold text-red-400 bg-red-950/20 border border-red-900/30 rounded-full flex items-center gap-1">
														<AlertCircle className="h-3 w-3" />
														Unavailable
													</span>
												</div>
											</div>
										))}
									</div>
								</div>
							</div>
						)}
					</div>
				))
			)}
		</div>
	);
}

export const quotaRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/quota',
	component: QuotaRouteComponent,
});
