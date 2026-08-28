import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, useNavigate } from '@tanstack/react-router';
import { Cpu, KeyRound, type LucideIcon, Monitor, Moon, Palette, Sun } from 'lucide-react';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { InstanceCredentialsPanel } from '@/components/settings/instance-credentials-panel.js';
import { useTheme } from '@/components/theme/theme-provider.js';
import {
	resolveActiveSettingsTab,
	type SettingsTab,
	settingsSearchSchema,
	settingsTabSearch,
	visibleSettingsTabs,
} from '@/lib/settings-nav.js';
import type { AppearanceTheme } from '@/lib/theme.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import type { AppSettings } from '../../../../src/config/app-settings.js';
import type { AgentDefaults } from '../../../../src/config/schema.js';
import type { AgentCli } from '../../../../src/harness/agent-cli.js';
import {
	capabilityFor,
	DEFAULT_MODEL_PER_CLI,
	MODEL_CAPABILITIES,
} from '../../../../src/harness/models.js';
import { rootRoute } from '../__root.js';

const CLIS = ['claude', 'antigravity', 'codex'] as const;

/**
 * Fallback merge base for `handleSubmit` when `settings` hasn't loaded yet — a
 * plain literal rather than importing `APP_SETTINGS_DEFAULTS` (`src/config/app-settings.js`),
 * which would pull that backend module's real (non-type) dependency chain —
 * down to `node:child_process` — into the browser bundle.
 */
const FALLBACK_SETTINGS: AppSettings = { appearance: { theme: 'dark' } };

const CLI_LABELS: Record<AgentCli, string> = {
	claude: 'Claude',
	antigravity: 'Antigravity',
	codex: 'Codex',
};

/**
 * Placeholder label for a CLI's "no global default" option, showing only the
 * coded model that applies when the global default is cleared (per-CLI, from
 * `DEFAULT_MODEL_PER_CLI`). Mirrors `getModelDefaultLabel` in
 * `routes/projects/$projectId.tsx`, but always resolves to the coded default —
 * global settings are the tier directly above it, so there's no higher default
 * to fall through to.
 */
function getGlobalModelDefaultLabel(cli: AgentCli): string {
	const defaultModel = DEFAULT_MODEL_PER_CLI[cli];
	return capabilityFor(cli, defaultModel)?.label ?? defaultModel;
}

/** Strip empty/undefined per-CLI entries so cleared defaults aren't persisted. */
function cleanDefaults(defaults: AgentDefaults): AgentDefaults | undefined {
	const clean: AgentDefaults = {};
	for (const cli of CLIS) {
		const model = defaults[cli];
		if (model) clean[cli] = model;
	}
	return Object.keys(clean).length > 0 ? clean : undefined;
}

interface DefaultModelsFormProps {
	defaults: AgentDefaults;
	handleModelChange: (cli: AgentCli, value: string) => void;
	handleSubmit: (e: React.FormEvent) => void;
	handleReset: () => void;
	isDirty: boolean;
	isPending: boolean;
	isSuccess: boolean;
	isError: boolean;
	errorMessage?: string;
}

function DefaultModelsForm({
	defaults,
	handleModelChange,
	handleSubmit,
	handleReset,
	isDirty,
	isPending,
	isSuccess,
	isError,
	errorMessage,
}: DefaultModelsFormProps) {
	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm">
			<form onSubmit={handleSubmit} className="space-y-6">
				<div>
					<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
						Default Agent Models
					</h2>
					<p className="text-xs text-zinc-400 mb-4">
						The default model each agent CLI uses across all projects, when neither a pipeline phase
						nor a project sets one. Leaving a CLI on its default option falls back to the coded
						default.
					</p>

					<div className="border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm">
						<table className="w-full text-left border-collapse">
							<thead>
								<tr className="bg-zinc-800/30 border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-400 font-semibold">
									<th className="px-4 py-3">Agent CLI</th>
									<th className="px-4 py-3">Default Model</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-zinc-800/60">
								{CLIS.map((cli) => {
									const selectedModel = defaults[cli];
									const modelOptions = MODEL_CAPABILITIES[cli].map((m) => ({
										id: m.id,
										label: m.label,
									}));
									// A pre-#180 config may hold a legacy combined antigravity string; keep
									// it selectable so it stays visible and isn't silently dropped on save.
									if (selectedModel && !modelOptions.some((m) => m.id === selectedModel)) {
										modelOptions.push({ id: selectedModel, label: selectedModel });
									}

									return (
										<tr key={cli} className="hover:bg-zinc-800/40 transition-colors">
											<td className="px-4 py-3.5">
												<div className="text-sm font-medium text-zinc-200">{CLI_LABELS[cli]}</div>
												<div className="text-xs text-zinc-500 font-mono select-all">{cli}</div>
											</td>
											<td className="px-4 py-3.5">
												<select
													value={selectedModel ?? ''}
													onChange={(e) => handleModelChange(cli, e.target.value)}
													disabled={isPending}
													className="block w-full max-w-[390px] px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500 font-mono transition-shadow"
												>
													<option value="">{getGlobalModelDefaultLabel(cli)}</option>
													{modelOptions.map((model) => (
														<option key={model.id} value={model.id}>
															{model.label}
														</option>
													))}
												</select>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</div>

				{/* Feedback Banners */}
				{isSuccess && (
					<div className="p-3 bg-emerald-950/20 border border-emerald-900/30 text-sm text-emerald-400 rounded">
						Default models saved successfully.
					</div>
				)}

				{isError && (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						Failed to save settings: {errorMessage}
					</div>
				)}

				{/* Action Buttons */}
				<div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
					<button
						type="submit"
						disabled={isPending || !isDirty}
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

const THEME_OPTIONS: Array<{
	value: AppearanceTheme;
	label: string;
	description: string;
	icon: typeof Sun;
}> = [
	{
		value: 'dark',
		label: 'Dark',
		description: "The dashboard's original dark palette.",
		icon: Moon,
	},
	{
		value: 'light',
		label: 'Light',
		description: 'A light palette for bright rooms and daytime use.',
		icon: Sun,
	},
	{
		value: 'system',
		label: 'System default',
		description:
			"Follows your OS/browser's color-scheme preference and switches automatically when it changes.",
		icon: Monitor,
	},
];

/**
 * The Appearance tab (issue #250): a radio group over the three theme choices,
 * backed by `useTheme` rather than its own settings mutation — the provider
 * already owns loading the saved choice, applying it dashboard-wide, and
 * persisting a selection (merged onto the full settings object so it can't
 * drop `agents.defaults`).
 */
export function AppearancePanel() {
	const { preference, setTheme, isPending, isError, errorMessage } = useTheme();

	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm">
			<div>
				<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
					Theme
				</h2>
				<p className="text-xs text-zinc-400 mb-4">
					The dashboard's color theme. Changes apply immediately and are saved automatically —
					there's nothing else to submit.
				</p>
			</div>

			<fieldset className="space-y-2">
				<legend className="sr-only">Theme</legend>
				{THEME_OPTIONS.map(({ value, label, description, icon: Icon }) => {
					const checked = preference === value;
					return (
						<label
							key={value}
							className={`flex items-start gap-3 p-4 border rounded-md cursor-pointer transition-colors ${
								checked
									? 'border-violet-500 bg-zinc-800/20'
									: 'border-zinc-800 bg-panel/20 hover:bg-zinc-800/20'
							}`}
						>
							<input
								type="radio"
								name="theme"
								value={value}
								checked={checked}
								disabled={isPending}
								onChange={() => setTheme(value)}
								className="mt-0.5 h-4 w-4 accent-violet-600 disabled:opacity-50"
							/>
							<Icon className="h-4 w-4 text-violet-400 mt-0.5 shrink-0" />
							<span>
								<span className="block text-sm font-medium text-zinc-200">{label}</span>
								<span className="block text-xs text-zinc-400 mt-1">{description}</span>
							</span>
						</label>
					);
				})}
			</fieldset>

			{isError && (
				<div className="mt-4 p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					Failed to save appearance: {errorMessage}
				</div>
			)}
		</div>
	);
}

/**
 * The General Settings tabs in display order, each with the icon and label it
 * renders. Ordered to match `SETTINGS_TABS` (`lib/settings-nav.ts`), which is the
 * URL vocabulary — a test asserts the two agree, so the rendered order and the
 * `?tab=` values can't drift apart. Mirrors `PROJECT_TAB_ITEMS` in
 * `routes/projects/$projectId.tsx`.
 */
const SETTINGS_TAB_ITEMS: ReadonlyArray<{ tab: SettingsTab; label: string; icon: LucideIcon }> = [
	{ tab: 'agents', label: 'Agent Defaults', icon: Cpu },
	{ tab: 'credentials', label: 'Credentials', icon: KeyRound },
	{ tab: 'appearance', label: 'Appearance', icon: Palette },
];

/**
 * The horizontal tab bar, rendered from {@link SETTINGS_TAB_ITEMS} narrowed to the
 * tabs this viewer may see (`visibleSettingsTabs`) — a non-administrator is offered
 * neither Agent Defaults (issue #666) nor Credentials (issue #769).
 */
export function SettingsTabBar({
	tabs,
	activeTab,
	onSelect,
}: {
	tabs: readonly SettingsTab[];
	activeTab: SettingsTab;
	onSelect: (tab: SettingsTab) => void;
}) {
	return (
		<div className="flex border-b border-zinc-800">
			{SETTINGS_TAB_ITEMS.filter(({ tab }) => tabs.includes(tab)).map(
				({ tab, label, icon: Icon }) => (
					<button
						key={tab}
						type="button"
						onClick={() => onSelect(tab)}
						className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all border-b-2 ${
							activeTab === tab
								? 'border-violet-500 text-zinc-100 bg-zinc-800/20'
								: 'border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
						}`}
					>
						<Icon className="h-4 w-4 text-violet-400" />
						{label}
					</button>
				),
			)}
		</div>
	);
}

function SettingsRouteComponent() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const search = settingsRoute.useSearch();
	// Agent defaults and the instance default credentials are installation-wide, so both
	// sections are shown only to an instance administrator (issues #666, #769) —
	// including on a direct `?tab=agents` / `?tab=credentials` link, which
	// `resolveActiveSettingsTab` degrades to a tab the viewer may see. For the
	// credentials tab that is courtesy on top of the router's own enforcement.
	const viewer = useCurrentUser().data;
	const tabs = visibleSettingsTabs(viewer);
	const activeTab = resolveActiveSettingsTab(search, viewer);
	const goToTab = (tab: SettingsTab) => {
		navigate({ to: '/settings', search: settingsTabSearch(tab) });
	};

	const settingsQuery = useQuery(trpc.settings.get.queryOptions());

	const [defaults, setDefaults] = useState<AgentDefaults>({});
	const [isInitialized, setIsInitialized] = useState(false);

	const settings = settingsQuery.data;
	const dbDefaults = useMemo<AgentDefaults>(() => settings?.agents?.defaults ?? {}, [settings]);

	const isDirty = useMemo(() => {
		return CLIS.some((cli) => (defaults[cli] ?? '') !== (dbDefaults[cli] ?? ''));
	}, [defaults, dbDefaults]);

	useEffect(() => {
		if (!isInitialized && settings) {
			setDefaults(dbDefaults);
			setIsInitialized(true);
		} else if (isInitialized && !isDirty) {
			setDefaults(dbDefaults);
		}
	}, [dbDefaults, isDirty, isInitialized, settings]);

	const updateMutation = useMutation({
		mutationFn: (variables: AppSettings) => trpcClient.settings.update.mutate(variables),
		onSuccess: () => {
			return queryClient.invalidateQueries({
				queryKey: trpc.settings.get.queryOptions().queryKey,
			});
		},
	});

	const handleModelChange = (cli: AgentCli, value: string) => {
		setDefaults((prev) => ({
			...prev,
			[cli]: value || undefined,
		}));
		updateMutation.reset();
	};

	const handleReset = () => {
		setDefaults(dbDefaults);
		updateMutation.reset();
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const cleaned = cleanDefaults(defaults);
		// Merge onto the full loaded settings (not just `{ agents }`) so saving
		// model defaults can never drop a previously saved theme. `settings` is
		// always loaded by the time this can fire (the loading/error states
		// return before this form renders); the fallback is just for the type.
		updateMutation.mutate({
			...(settings ?? FALLBACK_SETTINGS),
			agents: cleaned ? { defaults: cleaned } : undefined,
		});
	};

	// Both states gate the **Agent Defaults** panel alone: it is the only tab that reads
	// `AppSettings`, so a failing `settings.get` must not blank Credentials or Appearance,
	// neither of which asks for it.
	if (activeTab === 'agents' && settingsQuery.isLoading) {
		return <div className="text-sm text-zinc-400">Loading settings…</div>;
	}

	if (activeTab === 'agents' && settingsQuery.isError) {
		return (
			<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex flex-col gap-2">
				<h3 className="text-sm font-semibold text-red-200">Error Loading Settings</h3>
				<p className="text-xs text-red-400/80 font-mono">{settingsQuery.error.message}</p>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Page Title */}
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Settings</h1>
				<p className="text-xs text-zinc-500 mt-1">Application-wide SWARM configuration.</p>
			</div>

			{/* Horizontal Tab Bar */}
			<SettingsTabBar tabs={tabs} activeTab={activeTab} onSelect={goToTab} />

			{activeTab === 'agents' && (
				<DefaultModelsForm
					defaults={defaults}
					handleModelChange={handleModelChange}
					handleSubmit={handleSubmit}
					handleReset={handleReset}
					isDirty={isDirty}
					isPending={updateMutation.isPending}
					isSuccess={updateMutation.isSuccess}
					isError={updateMutation.isError}
					errorMessage={updateMutation.error?.message}
				/>
			)}

			{activeTab === 'credentials' && <InstanceCredentialsPanel />}

			{activeTab === 'appearance' && <AppearancePanel />}
		</div>
	);
}

export const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/settings',
	validateSearch: (search) => settingsSearchSchema.parse(search),
	component: SettingsRouteComponent,
});
