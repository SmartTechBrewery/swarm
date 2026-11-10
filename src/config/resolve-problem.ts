/**
 * The optional Resolve problem phase's project settings (issue #1384), read only
 * through these resolvers. A dependency-free leaf, like `./custom-prompt.ts`, so the
 * config schema (server) and the dashboard bundle can both import it.
 */

/** How many real (non-dry-run) MCP write calls one run may make when the project sets no cap. */
export const DEFAULT_RESOLVE_PROBLEM_MAX_WRITE_ACTIONS = 5;

/** The largest cap a project may set (`pipeline.resolveProblem.maxWriteActions`). */
export const RESOLVE_PROBLEM_MAX_WRITE_ACTIONS_LIMIT = 50;

/** The slice of `PipelineConfig` these resolvers read, stated structurally to stay dependency-free. */
export interface ResolveProblemPipeline {
	resolveProblem?: { enabled?: boolean; maxWriteActions?: number };
}

/**
 * Whether the phase runs for the project. Unlike the other phase toggles it is
 * **off** unless `pipeline.resolveProblem.enabled` is exactly `true`.
 */
export function isResolveProblemEnabled(pipeline: ResolveProblemPipeline | undefined): boolean {
	return pipeline?.resolveProblem?.enabled === true;
}

/** The per-run write-action cap: the project's own, else {@link DEFAULT_RESOLVE_PROBLEM_MAX_WRITE_ACTIONS}. */
export function resolveProblemMaxWriteActions(
	pipeline: ResolveProblemPipeline | undefined,
): number {
	return pipeline?.resolveProblem?.maxWriteActions ?? DEFAULT_RESOLVE_PROBLEM_MAX_WRITE_ACTIONS;
}
