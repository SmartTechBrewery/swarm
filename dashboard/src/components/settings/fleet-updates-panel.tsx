import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ToggleSwitch } from '@/components/ui/toggle-switch.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import type { AppSettings } from '../../../../src/config/app-settings.js';

/**
 * The Fleet tab (issue #1284): whether the control plane rolls its workers onto its
 * own version after an upgrade (`workers.followInstallationVersion`).
 *
 * Saved on the click, like Appearance, and merged onto the whole loaded blob so it
 * can never drop `agents.defaults` or the theme. Only an instance administrator sees
 * the tab; `settings.update` refuses anyone else's change to this key regardless.
 */
export function FleetUpdatesPanel({ settings }: { settings: AppSettings }) {
	const queryClient = useQueryClient();
	const updateMutation = useMutation({
		mutationFn: (variables: AppSettings) => trpcClient.settings.update.mutate(variables),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryOptions().queryKey }),
	});
	const following = settings.workers.followInstallationVersion;

	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm">
			<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
				Worker Updates
			</h2>
			<div className="flex items-start justify-between gap-6">
				<div>
					<p className="text-sm font-medium text-zinc-200">
						Keep workers on this installation's version
					</p>
					<p className="text-xs text-zinc-400 mt-1">
						About two minutes after the control plane starts on a version its workers are not on, it
						starts one staged installation-wide rollout to that version — one machine at a time,
						each drained once idle, halting on a bad build. A halted rollout is not retried, and a
						worker that cannot take the version is reported in the Workers screen's rollout panel.
						Turn this off to update workers by hand. On by default.
					</p>
				</div>
				<ToggleSwitch
					checked={following}
					label="Keep workers on this installation's version"
					disabled={updateMutation.isPending}
					onChange={() =>
						updateMutation.mutate({
							...settings,
							workers: { ...settings.workers, followInstallationVersion: !following },
						})
					}
				/>
			</div>

			{updateMutation.isError && (
				<div className="mt-4 p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					Failed to save: {updateMutation.error.message}
				</div>
			)}
		</div>
	);
}
