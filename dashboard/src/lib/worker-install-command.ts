/**
 * The one command that turns a machine into a worker (issues #1314, #1324): the
 * installation's own installer (`src/router/install-script.ts`), run in the project
 * checkout the worker is to serve — `install.ps1` through PowerShell on Windows,
 * `install.sh` through `sh` everywhere else. The dashboard has no step in adding a
 * worker, so its empty worker lists show this rather than an operator-CLI command,
 * for the platform the viewer is on. Built from the dashboard's own
 * `window.location.origin` at the call site — the dashboard and the installers
 * share one origin on a deployed installation. Pure so it can be tested without one.
 */

/** Which installer a viewer's machine runs. */
export type ViewerPlatform = 'windows' | 'posix';

export function workerInstallCommandFor(origin: string, platform: ViewerPlatform): string {
	return platform === 'windows'
		? `irm ${origin}/install.ps1 | iex`
		: `curl -fsSL ${origin}/install.sh | sh`;
}

/** The parts of `navigator` that name the viewer's OS; `userAgentData` is Chromium's. */
export interface PlatformHints {
	userAgentData?: { platform?: string };
	platform?: string;
}

/** `windows` when the browser says it runs on Windows, `posix` otherwise. */
export function detectViewerPlatform(nav: PlatformHints): ViewerPlatform {
	const platform = nav.userAgentData?.platform || nav.platform || '';
	return /^win/i.test(platform) ? 'windows' : 'posix';
}

/** The command for the viewer of this page. */
export function viewerWorkerInstallCommand(): string {
	return workerInstallCommandFor(window.location.origin, detectViewerPlatform(window.navigator));
}
