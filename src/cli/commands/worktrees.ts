import { parseArgs } from 'node:util';
import type { ProjectConfig } from '../../config/schema.js';
import { closeDb } from '../../db/client.js';
import {
	findProjectByIdFromDb,
	listAllProjectsFromDb,
} from '../../db/repositories/projectsRepository.js';
import { pruneStaleWorktrees } from '../../worktree/retention.js';
import * as out from '../_shared/output.js';

const USAGE = `swarm worktrees — retention and cleanup for stale worktrees under .swarm-workspaces/

Usage: swarm worktrees prune [--project <id>] [--dry-run]

  --project <id>   Only sweep this project (default: all configured projects)
  --dry-run        Report what would be pruned without removing anything

Requires DATABASE_URL (project config) in the environment — run via
\`npm run worktrees:prune\` (loads .env) or export it yourself first. The
in-flight check also needs REDIS_URL in SWARM_DISPATCH_MODE=in-process; in
transport mode it reads host-local \`.swarm-state\` leases instead.`;

/**
 * Print a labelled `<label>: <count>` line followed by each entry, or nothing
 * when the list is empty. `render` formats each entry line (defaults to
 * `out.info`) so the "dirty" category can warn with its clean-up hint.
 */
function reportList(
	label: string,
	items: string[],
	render: (line: string) => void = out.info,
): void {
	if (items.length === 0) return;
	out.info(`  ${label}: ${items.length}`);
	for (const p of items) render(`    - ${p}`);
}

async function sweepProject(project: ProjectConfig, dryRun: boolean): Promise<void> {
	out.step(`sweeping project '${project.name}' (${project.id})…`);
	const result = await pruneStaleWorktrees(project, { dryRun });

	out.info(`  kept: ${result.kept.length}`);
	if (result.pruned.length > 0) {
		out.info(`  ${dryRun ? 'would prune' : 'pruned'}: ${result.pruned.length} worktree(s)`);
		for (const p of result.pruned) out.info(`    - ${p}`);
	} else {
		out.info('  pruned: 0');
	}
	reportList('skipped (in-flight)', result.skippedInFlight);
	reportList('skipped (dirty)', result.skippedDirty, (line) =>
		out.warn(`${line} (has uncommitted changes — clean up manually if it's no longer needed)`),
	);
	reportList('skipped (unpushed)', result.skippedUnpushed, (line) =>
		out.warn(`${line} (has unpushed commits — push or discard them if it's no longer needed)`),
	);
	reportList('skipped (deferred session)', result.skippedDeferred);
	if (result.ignored.length > 0) {
		out.info(`  ignored: ${result.ignored.length}`);
	}
}

async function getProjects(projectId?: string): Promise<ProjectConfig[]> {
	if (projectId) {
		const project = await findProjectByIdFromDb(projectId);
		if (!project) {
			throw new Error(`Project with ID '${projectId}' not found in database.`);
		}
		return [project];
	}
	return listAllProjectsFromDb();
}

export async function run(argv: string[]): Promise<number> {
	const [subcommand, ...rest] = argv;

	if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
		out.info(USAGE);
		return subcommand ? 0 : 1;
	}

	if (subcommand !== 'prune') {
		out.error(`unknown worktrees subcommand '${subcommand}'`);
		out.info(USAGE);
		return 1;
	}

	const { values } = parseArgs({
		args: rest,
		options: {
			project: { type: 'string' },
			'dry-run': { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
		},
	});

	if (values.help) {
		out.info(USAGE);
		return 0;
	}

	const dryRun = values['dry-run'] ?? false;

	try {
		const projects = await getProjects(values.project);
		for (const project of projects) {
			await sweepProject(project, dryRun);
		}
		return 0;
	} catch (err) {
		out.error(`worktrees prune failed: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	} finally {
		await closeDb();
	}
}
