/**
 * `swarm config apply` — load the local `swarm.config.json` into Postgres
 * (SWARM-56). `swarm init` scaffolds and validates that file, but nothing read
 * it into the DB the router/worker resolve from; this is that loader. It's also
 * wired as `npm run db:seed` (same code path, `--env-file=.env` for the
 * credentials + `DATABASE_URL`).
 *
 * This command is the thin file/CLI shell around `applyConfig`
 * (`src/config/apply.ts`), which does the DB work: read the file, validate it
 * against `SwarmConfigSchema`, apply it, report a summary. A malformed config or
 * missing file throws and is surfaced by the top-level dispatcher
 * (`src/cli/index.ts`) as a non-zero exit.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyConfig } from '../../config/apply.js';
import { validateConfig } from '../../config/schema.js';
import { closeDb } from '../../db/client.js';
// Side-effect import: registers every provider manifest, so `validateConfig` can
// check each project's `credentials.pm` references against the roles its PM provider
// declares (issue #497) instead of skipping that check.
import '../../integrations/entrypoint.js';
import * as out from '../_shared/output.js';
import { REPO_ROOT } from '../_shared/paths.js';

const CONFIG_FILE = 'swarm.config.json';

const USAGE = `swarm config — load swarm.config.json into Postgres

Usage: swarm config apply [--config <path>]

  apply             Upsert the config's projects and referenced credentials into the DB
  --config <path>   Path to the config file (default: <repo-root>/swarm.config.json)

Credential values are read from the environment by the reference (env-var key)
named in each project's "credentials" block — a reference whose env var is unset
is skipped with a warning, not written.`;

export async function run(argv: string[]): Promise<number> {
	const [subcommand, ...rest] = argv;

	if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
		out.info(USAGE);
		// No subcommand is a usage error; an explicit --help is not.
		return subcommand ? 0 : 1;
	}

	if (subcommand !== 'apply') {
		out.error(`unknown config subcommand '${subcommand}'`);
		out.info(USAGE);
		return 1;
	}

	const { values } = parseArgs({
		args: rest,
		options: { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}
	const configPath = values.config ? resolve(values.config) : resolve(REPO_ROOT, CONFIG_FILE);

	out.step(`applying ${configPath}…`);
	const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));

	try {
		const result = await applyConfig(config);
		out.info(`upserted ${result.projects.length} project(s): ${result.projects.join(', ')}`);
		out.info(`stored ${result.credentialsWritten} credential(s) from the environment`);
		for (const skipped of result.credentialsSkipped) {
			out.warn(`credential reference not set in environment, skipped: ${skipped}`);
		}
		return 0;
	} finally {
		await closeDb();
	}
}
