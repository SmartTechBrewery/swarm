/**
 * The one command that turns a machine into a worker (issue #1314): the
 * installation's own `install.sh` (`src/router/install-script.ts`), run in the
 * project checkout the worker is to serve. The dashboard has no step in adding a
 * worker, so its empty worker lists show this rather than an operator-CLI command.
 * Built from the dashboard's own `window.location.origin` at the call site — the
 * dashboard and `/install.sh` share one origin on a deployed installation. Pure so
 * it can be tested without one.
 */
export function workerInstallCommand(origin: string): string {
	return `curl -fsSL ${origin}/install.sh | sh`;
}
