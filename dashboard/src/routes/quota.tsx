import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import { AlertCircle, Calendar, Gauge, Info, RefreshCw, ShieldAlert } from 'lucide-react';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { rootRoute } from './__root.js';

interface QuotaWindowProps {
	name: string;
	usedPercent?: number;
	durationMins?: number;
	resetsAt?: string;
}

function QuotaWindowCard({ name, usedPercent = 0, durationMins, resetsAt }: QuotaWindowProps) {
	const remainingPercent = Math.max(0, 100 - usedPercent);
	const durationText = durationMins
		? durationMins >= 1440
			? `${Math.round(durationMins / 1440)}d`
			: `${Math.round(durationMins / 60)}h`
		: '';

	// Curated HSL colors matching styling rules
	const progressColor =
		remainingPercent > 50
			? 'bg-emerald-500'
			: remainingPercent > 20
				? 'bg-amber-500'
				: 'bg-rose-500';

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

function QuotaRouteComponent() {
	const queryClient = useQueryClient();
	const quotasQuery = useQuery(trpc.quota.getQuotas.queryOptions());

	const refreshMutation = useMutation({
		mutationFn: () => trpcClient.quota.refreshQuotas.mutate(),
		onSuccess: () => {
			return queryClient.invalidateQueries({
				queryKey: trpc.quota.getQuotas.queryOptions().queryKey,
			});
		},
	});

	const formatTime = (isoString?: string) => {
		if (!isoString) return 'Never';
		try {
			return new Date(isoString).toLocaleString();
		} catch {
			return isoString;
		}
	};

	const list = quotasQuery.data || [];
	const availableQuotas = list.filter((q) => q.status === 'available');
	const unavailableQuotas = list.filter((q) => q.status !== 'available');

	const lastCheckedTime = list.length
		? new Date(Math.max(...list.map((q) => new Date(q.lastUpdated).getTime()))).toLocaleString()
		: null;

	const handleRefresh = () => {
		refreshMutation.mutate();
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
						Status, rate limits, and remaining allowance for host-installed agent CLIs.
					</p>
				</div>
				<div className="flex items-center gap-3">
					{lastCheckedTime && (
						<span className="text-[11px] text-zinc-500 font-mono">
							Last updated: {lastCheckedTime}
						</span>
					)}
					<button
						type="button"
						onClick={handleRefresh}
						disabled={refreshMutation.isPending}
						className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-semibold text-zinc-200 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-md transition-colors disabled:opacity-50"
					>
						<RefreshCw
							className={`h-4 w-4 ${refreshMutation.isPending ? 'animate-spin text-violet-400' : ''}`}
						/>
						{refreshMutation.isPending ? 'Refreshing…' : 'Refresh'}
					</button>
				</div>
			</div>

			{quotasQuery.isError && (
				<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex flex-col gap-2">
					<h3 className="text-sm font-semibold text-red-200">Error Loading Quotas</h3>
					<p className="text-xs text-red-400/80 font-mono">{quotasQuery.error.message}</p>
				</div>
			)}

			{/* Active Quota Cards */}
			<div className="space-y-4">
				<h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
					Active Quotas
				</h2>

				{availableQuotas.length === 0 ? (
					<div className="border border-zinc-850 rounded-lg p-6 bg-zinc-900/20 text-center space-y-2">
						<ShieldAlert className="h-8 w-8 text-zinc-650 mx-auto" />
						<p className="text-sm text-zinc-400">No active, usable agent CLIs discovered.</p>
						<p className="text-xs text-zinc-500">
							Check that the agent binaries are installed and logged in on the host, then click
							Refresh.
						</p>
					</div>
				) : (
					<div className="grid gap-6 md:grid-cols-2">
						{availableQuotas.map((q) => {
							const nameLabel =
								q.cli === 'claude'
									? 'Claude Code'
									: q.cli === 'antigravity'
										? 'Antigravity (Gemini)'
										: 'Codex';

							return (
								<div
									key={q.cli}
									className="border border-zinc-800 rounded-lg bg-panel/45 p-6 space-y-6 flex flex-col justify-between"
								>
									<div className="space-y-4">
										{/* Card Header */}
										<div className="flex items-center justify-between">
											<div>
												<h3 className="text-base font-semibold text-zinc-200">{nameLabel}</h3>
												<span className="text-xs text-zinc-500 font-mono font-light">{q.cli}</span>
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

										{/* Description / Plan / Credits Info */}
										<div className="grid grid-cols-2 gap-4 border-t border-zinc-850 pt-4 text-xs">
											<div>
												<span className="text-zinc-500 block">Plan Tier</span>
												<span className="text-zinc-300 font-medium capitalize">
													{q.plan || 'Standard'}
												</span>
											</div>
											{q.credits && (
												<div>
													<span className="text-zinc-500 block">Credits / Resets</span>
													<span className="text-zinc-300 font-medium font-mono">{q.credits}</span>
												</div>
											)}
										</div>

										{/* Windows & Usage */}
										{q.windows && q.windows.length > 0 ? (
											<div className="space-y-3 pt-2">
												<span className="text-xs text-zinc-400 font-medium block">
													Usage Windows
												</span>
												<div className="space-y-3">
													{q.windows.map((w) => (
														<QuotaWindowCard
															// Names are derived from the reported duration (issue #669), so the
															// reset time is what keeps two same-length windows apart.
															key={`${w.name}-${w.resetsAt ?? ''}`}
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
															Exhaustion was hit recently. The limit is scheduled to reset around{' '}
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
														<div>
															No recent rate limits or live quota data available. Usage is tracked
															dynamically from run outcomes.
														</div>
													</div>
												)}
											</div>
										)}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>

			{/* Diagnostics / Unavailable Section */}
			{unavailableQuotas.length > 0 && (
				<div className="space-y-4 pt-4">
					<h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
						Diagnostics
					</h2>
					<div className="border border-zinc-850 rounded-lg overflow-hidden bg-zinc-900/10">
						<div className="divide-y divide-zinc-850">
							{unavailableQuotas.map((q) => {
								const nameLabel =
									q.cli === 'claude'
										? 'Claude Code'
										: q.cli === 'antigravity'
											? 'Antigravity (Gemini)'
											: 'Codex';

								return (
									<div
										key={q.cli}
										className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-zinc-900/20 transition-colors"
									>
										<div className="space-y-1">
											<div className="flex items-center gap-2">
												<span className="text-sm font-semibold text-zinc-300">{nameLabel}</span>
												<span className="text-[10px] font-mono text-zinc-500">({q.cli})</span>
											</div>
											<p className="text-xs text-zinc-500 font-mono max-w-xl">
												{q.error || 'Executable is missing or unauthenticated.'}
											</p>
										</div>
										<div className="flex items-center gap-2 shrink-0">
											<span className="px-2.5 py-0.5 text-[10px] font-semibold text-red-400 bg-red-950/20 border border-red-900/30 rounded-full flex items-center gap-1">
												<AlertCircle className="h-3 w-3" />
												Unavailable
											</span>
										</div>
									</div>
								);
							})}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

export const quotaRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/quota',
	component: QuotaRouteComponent,
});
