/**
 * `swarm init` — bootstrap the two pieces of local config a developer needs
 * before starting the stack:
 *
 *   1. `.env`             — stack settings (ports, DB/Redis URLs, credential
 *                           master key), copied from `.env.docker.example`.
 *   2. `swarm.config.json`— the project config (`SwarmConfigSchema` shape): repo
 *                           + worktree location, the GitHub Projects board
 *                           mapping, and credential *references* (env-var keys,
 *                           never secrets — see `CredentialsSchema`).
 *
 * Both are created only when absent — `init` never clobbers an edited config. If
 * `swarm.config.json` already exists it's validated instead, so a re-run is a
 * cheap "is my config still well-formed?" check.
 *
 * `init` only scaffolds and validates the file — it doesn't touch the DB. Once
 * the file is filled in, `swarm config apply` (a.k.a. `npm run db:seed`) loads
 * its projects and referenced credentials into Postgres (`src/cli/commands/config.ts`).
 */

import { access, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PROJECT_DEFAULTS, validateConfig } from '../../config/schema.js';
import * as out from '../_shared/output.js';
import { REPO_ROOT } from '../_shared/paths.js';

const ENV_FILE = '.env';
const ENV_EXAMPLE_FILE = '.env.docker.example';
const CONFIG_FILE = 'swarm.config.json';

/**
 * Placeholder project config in `SwarmConfigSchema` shape for the user to fill in.
 *
 * Exported for its own test: `ensureConfigFile` below validates an *existing* file but
 * not the template it writes, so nothing else would catch a template that
 * `swarm config apply` then rejects.
 */
export const CONFIG_TEMPLATE = {
	projects: [
		{
			id: 'my-project',
			name: 'My Project',
			repo: 'owner/repo',
			// Required in practice since issue #618 (`github` / `bitbucket` / `gitlab`),
			// and since issue #628 also the key `credentials.scm` below is keyed by.
			scm: 'github',
			repoRoot: '/absolute/path/to/your/repo/checkout',
			worktreeRoot: PROJECT_DEFAULTS.worktreeRoot,
			baseBranch: PROJECT_DEFAULTS.baseBranch,
			branchPrefix: PROJECT_DEFAULTS.branchPrefix,
			// `pm` carries the provider id *and* that provider's own config — for
			// GitHub Projects the board mapping below (`ProjectPmSchema`).
			pm: {
				type: 'github-projects',
				projectId: 'PVT_xxxxxxxxxxxxxxxxxxxx',
				statusFieldId: 'PVTSSF_xxxxxxxxxxxxxxxxxxxx',
				statusOptions: {
					backlog: 'REPLACE_WITH_OPTION_ID',
					planning: 'REPLACE_WITH_OPTION_ID',
					todo: 'REPLACE_WITH_OPTION_ID',
					inProgress: 'REPLACE_WITH_OPTION_ID',
					inReview: 'REPLACE_WITH_OPTION_ID',
					done: 'REPLACE_WITH_OPTION_ID',
				},
			},
			// References (env-var keys), never the secrets themselves — see CredentialsSchema.
			// The implementer persona is NOT a project credential: it is the worker
			// operator's own token, set as SWARM_OPERATOR_GH_TOKEN in `.env` on each host
			// that runs implementer phases (issue #396).
			//
			// Both maps hold one reference per role, *per provider* — `scm` since issue
			// #628 and `pm` since #631 — so a project can carry a second provider's
			// credentials without either overwriting the other (PM role names collide
			// outright: `apiToken` is GitHub Projects' and Jira's). Only the provider
			// named by `scm` / `pm.type` above is ever resolved. A `pm` block holds one
			// reference per credential role that *PM provider* declares (issue #497);
			// GitHub Projects declares `apiToken` — the board's own GitHub token, required
			// and never the operator's (issue #537) — while its webhook secret inherits
			// the repo side's, so it needs no entry here.
			credentials: {
				scm: {
					github: {
						reviewer: 'GITHUB_TOKEN_REVIEWER',
						webhookSecret: 'GITHUB_WEBHOOK_SECRET',
					},
				},
				pm: {
					'github-projects': {
						apiToken: 'PM_GITHUB_PROJECTS_TOKEN',
					},
				},
			},
		},
	],
};

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function ensureEnvFile(): Promise<void> {
	const dest = resolve(REPO_ROOT, ENV_FILE);
	if (await exists(dest)) {
		out.info(`${ENV_FILE} already exists — left untouched`);
		return;
	}
	await copyFile(resolve(REPO_ROOT, ENV_EXAMPLE_FILE), dest);
	out.info(`created ${ENV_FILE} from ${ENV_EXAMPLE_FILE} — review its values`);
}

/** Returns `true` if the existing config is valid or a fresh template was written. */
async function ensureConfigFile(): Promise<boolean> {
	const dest = resolve(REPO_ROOT, CONFIG_FILE);
	if (await exists(dest)) {
		try {
			validateConfig(JSON.parse(await readFile(dest, 'utf8')));
			out.info(`${CONFIG_FILE} already exists and is valid`);
			return true;
		} catch (err) {
			out.error(
				`${CONFIG_FILE} exists but is invalid: ${err instanceof Error ? err.message : err}`,
			);
			return false;
		}
	}
	await writeFile(dest, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`);
	out.info(
		`created ${CONFIG_FILE} template — fill in your repo, board IDs, and credential references`,
	);
	return true;
}

export async function run(_argv: string[]): Promise<number> {
	out.step('initializing local config…');
	await ensureEnvFile();
	const configOk = await ensureConfigFile();
	if (!configOk) {
		return 1;
	}
	out.info(
		'done. Next: edit the two files above, then `swarm start` and `swarm config apply` (npm run db:seed).',
	);
	return 0;
}
