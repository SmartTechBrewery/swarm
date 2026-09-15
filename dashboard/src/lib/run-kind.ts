/**
 * Pure view-logic for telling machine maintenance apart from pipeline work
 * (issue #974), split out of the runs surfaces the same way `./run-retry.ts`,
 * `./run-reset.ts` and `./run-recovery.ts` are — so it can be unit-tested without
 * a rendered component (the dashboard package tests helpers in a node
 * environment by default; see `dashboard/vitest.config.ts`).
 */

/**
 * The `kind` a pipeline run records — the web-side mirror of `PIPELINE_RUN_KIND`
 * (`src/db/repositories/runsRepository.ts`, issue #971). Stated rather than
 * imported: a browser bundle does not pull in the server's repository module.
 */
export const PIPELINE_RUN_KIND = 'pipeline';

/**
 * Whether this run is machine maintenance rather than pipeline work (issue #971).
 *
 * Reads the `kind` discriminator **positively**, exactly as every server-side
 * pipeline-scoped reader does, so a second maintenance kind is covered here
 * without this predicate — or any of its callers — being edited again. It never
 * tests a null `repository`/`taskId` and never tests `phase`: the null
 * coordinates are the *consequence* of the kind, and `phase` is free text.
 *
 * Takes the narrowest shape that answers the question rather than a whole
 * `RunRow`, so a surface with its own read model can ask it too.
 */
export function isMaintenanceRun(run: { kind: string }): boolean {
	return run.kind !== PIPELINE_RUN_KIND;
}
