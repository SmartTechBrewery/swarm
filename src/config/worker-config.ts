/**
 * Worker-safe projection of a project config (issue #393, ADR-004 §1).
 *
 * A pipeline phase reads project config from the DB while it runs in-process,
 * with the full `ProjectConfig` — including the `credentials` block (references
 * into the encrypted secret store, `src/config/schema.ts`) and provider-specific
 * board/field IDs. A future *remote* worker (ADR-004 split delivery) has no DB
 * access and must never receive server-side secrets.
 *
 * This module is the single enforcement point for that boundary: an **allowlist**
 * projection `toWorkerConfig(project)` that yields only the fields explicitly
 * marked worker-safe. An allowlist (not a blocklist) is deliberate — a field is
 * excluded from the worker payload unless it is named in `WORKER_SAFE_KEYS`, so a
 * future secret-bearing `ProjectConfig` field is excluded *by default* rather than
 * leaking until someone remembers to omit it.
 *
 * The two key sets drive both the Zod projection schema and the drift-guard test
 * (`tests/unit/config/worker-config.test.ts`), so every `ProjectConfig` field must
 * be classified as one or the other and the boundary stays honest as the schema
 * grows.
 */

import type { z } from 'zod';
import { type ProjectConfig, ProjectConfigBaseSchema } from './schema.js';

/**
 * Fields safe and meaningful to travel to a worker inside a task assignment:
 * project identity and the worktree/branch/agent settings shared across hosts,
 * plus `scm` — the project's SCM provider discriminator (issue #478), which is
 * non-secret and is what lets a DB-free worker resolve its own provider through
 * `requireProjectSCMProvider` (`src/transport/assignment-execution.ts`).
 */
export const WORKER_SAFE_KEYS = [
	'id',
	'name',
	'repo',
	'scm',
	'worktreeRoot',
	'baseBranch',
	'branchPrefix',
	'agents',
	'worktreeRetention',
] as const;

/**
 * Fields that never leave the control plane: the host-specific `repoRoot`, the
 * secret-bearing `credentials` block (persona token references + webhook secret — the hard exclusion the
 * acceptance criteria require), plus control-plane-only policy and
 * provider-specific IDs (pipeline board-move policy, visibility, the scheduler
 * concurrency knob, and `pm` — which since issue #495 is the provider
 * discriminator *and* its board/field IDs in one union, so excluding the block
 * excludes the mapping with it) that a remote worker cannot act on and does not
 * need.
 */
export const SERVER_ONLY_KEYS = [
	'credentials',
	'repoRoot',
	'pm',
	'pipeline',
	'visibility',
	'maxConcurrentJobs',
] as const;

const workerSafeMask = Object.fromEntries(WORKER_SAFE_KEYS.map((k) => [k, true as const])) as {
	[K in (typeof WORKER_SAFE_KEYS)[number]]: true;
};

/**
 * The worker-safe slice of a project config. Built from `ProjectConfigBaseSchema`
 * via `.pick()` so each safe field keeps its own validation — the base is the bare
 * `z.object` `.pick()` requires, and `ProjectConfigSchema`'s cross-field check
 * (`credentials.pm` against the PM manifest) reads only fields this projection
 * drops, so picking from the base loses no validation.
 */
export const WorkerProjectConfigSchema = ProjectConfigBaseSchema.pick(workerSafeMask).describe(
	'Worker-safe projection of a project config — no secrets, no server-only policy',
);

export type WorkerProjectConfig = z.infer<typeof WorkerProjectConfigSchema>;

/**
 * Project the full config down to its worker-safe slice — the *only* sanctioned
 * way to produce a worker-bound config object. Parsing through the picked schema
 * strips every unlisted key (Zod objects drop unknown keys by default), so every
 * server-only field — `credentials` above all — is dropped by construction. The
 * returned object is fresh: the input `project` is not mutated and retains its
 * full config, so the local / single-user path is unaffected.
 */
export function toWorkerConfig(project: ProjectConfig): WorkerProjectConfig {
	return WorkerProjectConfigSchema.parse(project);
}
