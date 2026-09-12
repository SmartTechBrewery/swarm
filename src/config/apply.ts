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
 *      reads back at runtime. With one exception, {@link NEVER_SEEDED_ROLE}: a
 *      reference named only by a `webhookSecret` role is never read and never
 *      stored, because one project's webhook secret is essentially never another's.
 *
 * Both writes are upserts keyed on stable ids, so `apply` is idempotent — a
 * re-run after editing the file reconciles rather than duplicating. A reference
 * whose env var is unset is warned-and-skipped rather than fatal: applying the
 * config before every secret is exported is a legitimate partial state, and the
 * skipped reference stays as documentation to be filled in on a later re-run.
 */

import { writeProjectCredential } from '../db/repositories/credentialsRepository.js';
import { upsertProjectToDb } from '../db/repositories/projectsRepository.js';
import { PM_WEBHOOK_SECRET_ROLE } from '../integrations/pm/manifest.js';
import type { ScmCredentialRole } from '../scm/types.js';
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
	/**
	 * Webhook-secret references deliberately *not* seeded from this host's environment
	 * ({@link NEVER_SEEDED_ROLE}). Formatted as `"<projectId>/<envVarKey> (<config
	 * path>)"`, so the warning names both the key that was held back and the block to
	 * fix it in.
	 *
	 * A field of its own rather than a reuse of {@link ApplyResult.credentialsSkipped}:
	 * "your env var is unset, export it and re-run" and "SWARM will never seed this,
	 * enter it where that project's webhook is configured" are different instructions
	 * and must not read as the same warning.
	 */
	credentialsHeldBack: string[];
}

/**
 * The one credential role `swarm config apply` never seeds from this host's
 * environment (issue #900).
 *
 * A webhook secret must match the secret set on *that project's own* webhook, so a
 * value correct for one project is essentially never correct for another — which is
 * why it is never seeded at project-creation time either: `requireInstanceScmDefaults`
 * seeds only `instanceDefault`-eligible roles, and "`webhookSecret` can never declare
 * it, so it is never required and never seeded" (`src/api/routers/projects.ts`). Before
 * this, `config apply` was the other write path and did not honour that rule: a project
 * naming a key some other project already used got that shared `.env` value copied in,
 * indistinguishable in the dashboard from one an operator verified — and a wrong secret
 * fails only as a 401 inside `authenticatePmWebhook`, with nothing operator-facing.
 *
 * Typed as `ScmCredentialRole` but initialised from `PM_WEBHOOK_SECRET_ROLE` so the two
 * vocabularies are asserted equal at compile time: renaming either side fails the
 * typecheck here rather than silently seeding that side again. The rule covers both
 * maps deliberately — `webhookSecret` is the *receiver's* own vocabulary on the PM side
 * too (it is the role resolved into `PmWebhookVerification.secret`), so holding back
 * GitHub's key while seeding Linear's or Jira's would re-create the same silent failure
 * one provider over.
 *
 * Both `src/integrations/pm/manifest.ts` and `src/scm/types.ts` are type-plus-constant
 * modules, so this adds no provider-registration dependency to the loader.
 */
const NEVER_SEEDED_ROLE: ScmCredentialRole = PM_WEBHOOK_SECRET_ROLE;

/** One reference a project declares, with where it came from, for the rule below. */
interface DeclaredReference {
	/** Dotted path into the project's `credentials` block, for the operator warning. */
	readonly configPath: string;
	readonly role: string;
	readonly reference: string;
}

/** A project as this module reads it — the shape `config.projects` holds. */
type ConfiguredProject = SwarmConfig['projects'][number];

/**
 * Every reference one project declares, flattened across its three sources and tagged
 * with the role and config path behind each.
 *
 * Three sources, two of them keyed per provider: the SCM map (`credentials.scm`, issue
 * #628), the legacy shared pair still carried beside it, and the PM map
 * (`credentials.pm`, issue #497 — per PM provider id since #631). Both per-provider maps
 * are read in full, so a project retaining an outgoing provider's references still gets
 * its secrets applied — which is what makes switching back to it a config change rather
 * than a re-entry. Undeduped and in source order, which is what
 * {@link partitionDeclaredReferences} needs to decide the rule.
 */
function declaredReferences(project: ConfiguredProject): DeclaredReference[] {
	const { pm: _pmReferences, scm: _scmReferences, ...legacyReferences } = project.credentials;
	return [
		...listScmCredentialReferences(project).map(({ providerId, role, reference }) => ({
			configPath: `credentials.scm.${providerId}.${role}`,
			role,
			reference,
		})),
		...Object.entries(legacyReferences)
			.filter((entry): entry is [string, string] => entry[1] !== undefined)
			.map(([role, reference]) => ({ configPath: `credentials.${role}`, role, reference })),
		...listPmCredentialReferences(project).map(({ providerId, role, reference }) => ({
			configPath: `credentials.pm.${providerId}.${role}`,
			role,
			reference,
		})),
	];
}

/**
 * Split a project's declared references into the keys to seed and the webhook secrets
 * to hold back ({@link NEVER_SEEDED_ROLE}).
 *
 * Distinct roles and distinct providers may point at the same key — a project migrated
 * from the legacy pair does exactly that — so `seedable` is a set: one write per key,
 * no double-counting.
 *
 * A reference is seedable when at least one role naming it is *not* the webhook secret.
 * That is not a loophole to close: `project_credentials` is keyed by `(projectId,
 * envVarKey)` rather than by role, so a config pointing `reviewer` *and* `webhookSecret`
 * at one key has already collapsed them into a single row — writing it for `reviewer`
 * while claiming the webhook secret was held back would misdescribe what is now stored
 * under that key.
 *
 * `heldBack` maps each held-back reference to the **first** config path naming it, which
 * collapses a migrated project's double-naming (the legacy key plus the adopted
 * `credentials.scm.<id>` copy) into one report line rather than two.
 */
function partitionDeclaredReferences(declared: DeclaredReference[]): {
	seedable: Set<string>;
	heldBack: Map<string, string>;
} {
	const seedable = new Set(
		declared.filter((entry) => entry.role !== NEVER_SEEDED_ROLE).map((entry) => entry.reference),
	);
	const heldBack = new Map<string, string>();
	for (const entry of declared) {
		if (entry.role !== NEVER_SEEDED_ROLE || seedable.has(entry.reference)) continue;
		if (!heldBack.has(entry.reference)) heldBack.set(entry.reference, entry.configPath);
	}
	return { seedable, heldBack };
}

/**
 * Upsert every project in a validated config — and its referenced credentials —
 * into Postgres. The project row is written before its credentials so the
 * `project_credentials.project_id` foreign key is always satisfied. Returns a
 * summary of what was written for the caller to report.
 */
export async function applyConfig(config: SwarmConfig): Promise<ApplyResult> {
	const result: ApplyResult = {
		projects: [],
		credentialsWritten: 0,
		credentialsSkipped: [],
		credentialsHeldBack: [],
	};

	for (const project of config.projects) {
		await upsertProjectToDb(project);
		result.projects.push(project.id);

		const { seedable, heldBack } = partitionDeclaredReferences(declaredReferences(project));
		for (const [reference, configPath] of heldBack) {
			result.credentialsHeldBack.push(`${project.id}/${reference} (${configPath})`);
		}

		for (const envVarKey of seedable) {
			const value = process.env[envVarKey];
			if (value === undefined || value === '') {
				result.credentialsSkipped.push(`${project.id}/${envVarKey}`);
				continue;
			}
			await writeProjectCredential(project.id, envVarKey, value);
			result.credentialsWritten++;
		}
	}

	return result;
}
