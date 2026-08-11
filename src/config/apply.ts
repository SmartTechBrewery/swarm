/**
 * Config-file → DB loader (SWARM-56): the piece that turns a validated
 * `swarm.config.json` into the Postgres rows the router and worker actually read
 * from (`src/db/repositories/projectsRepository.ts`). Mirrors the intent of
 * Cascade's `tools/seed-config-from-json.ts`, adapted to SWARM's config shape
 * and credential model. `swarm config apply` / `npm run db:seed` are the two
 * front doors onto this function (`src/cli/commands/config.ts`).
 *
 * Two things are persisted per project:
 *   1. the project row itself (`upsertProjectToDb`), and
 *   2. its credentials — but the config only holds *references* (env-var keys),
 *      never the secrets (`src/config/schema.ts`, `CredentialsSchema`). So for
 *      each unique reference the loader reads `process.env[key]` and stores that
 *      value into `project_credentials`, encrypted at rest with the project id
 *      as AAD (`src/db/crypto.ts`), which is exactly what `resolveProjectCredential`
 *      reads back at runtime.
 *
 * Both writes are upserts keyed on stable ids, so `apply` is idempotent — a
 * re-run after editing the file reconciles rather than duplicating. A reference
 * whose env var is unset is warned-and-skipped rather than fatal: applying the
 * config before every secret is exported is a legitimate partial state, and the
 * skipped reference stays as documentation to be filled in on a later re-run.
 */

import { upsertCliQuota } from '../db/repositories/cliQuotasRepository.js';
import { writeProjectCredential } from '../db/repositories/credentialsRepository.js';
import { upsertProjectToDb } from '../db/repositories/projectsRepository.js';
import { discoverCliQuotas } from '../harness/quota-discovery.js';
import { listPmCredentialReferences } from './pm-credentials.js';
import type { SwarmConfig } from './schema.js';
import { listScmCredentialReferences } from './scm-credentials.js';

export interface ApplyResult {
	/** Ids of the projects upserted, in config order. */
	projects: string[];
	/** Number of credential references resolved from the environment and stored. */
	credentialsWritten: number;
	/**
	 * Credential references whose env var was unset, so nothing was stored.
	 * Formatted as `"<projectId>/<envVarKey>"` for a legible warning.
	 */
	credentialsSkipped: string[];
}

/**
 * Upsert every project in a validated config — and its referenced credentials —
 * into Postgres. The project row is written before its credentials so the
 * `project_credentials.project_id` foreign key is always satisfied. Returns a
 * summary of what was written for the caller to report.
 */
export async function applyConfig(config: SwarmConfig): Promise<ApplyResult> {
	const result: ApplyResult = { projects: [], credentialsWritten: 0, credentialsSkipped: [] };

	for (const project of config.projects) {
		await upsertProjectToDb(project);
		result.projects.push(project.id);

		// Three reference sources, two of them keyed per provider: the SCM map
		// (`credentials.scm`, issue #628), the legacy shared pair still carried beside it,
		// and the PM map (`credentials.pm`, issue #497 — per PM provider id since #631).
		// Both per-provider maps are read in full, so a project retaining an outgoing
		// provider's references still gets its secrets applied — which is what makes
		// switching back to it a config change rather than a re-entry. Distinct roles and
		// distinct providers may point at the same key — a project migrated from the legacy
		// pair does exactly that — so dedupe before writing to avoid redundant upserts and
		// double-counting.
		const { pm: _pmReferences, scm: _scmReferences, ...legacyReferences } = project.credentials;
		const references = new Set([
			...listScmCredentialReferences(project),
			...Object.values(legacyReferences).filter((key): key is string => key !== undefined),
			...listPmCredentialReferences(project),
		]);
		for (const envVarKey of references) {
			const value = process.env[envVarKey];
			if (value === undefined || value === '') {
				result.credentialsSkipped.push(`${project.id}/${envVarKey}`);
				continue;
			}
			await writeProjectCredential(project.id, envVarKey, value);
			result.credentialsWritten++;
		}
	}

	try {
		const snapshots = await discoverCliQuotas();
		for (const snapshot of snapshots) {
			await upsertCliQuota(snapshot.cli, snapshot.status, snapshot);
		}
	} catch (_err) {
		// Log but don't fail config apply
	}

	return result;
}
