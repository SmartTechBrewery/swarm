/**
 * SWARM project configuration — the single source of truth for a project's
 * shape (ai/CODING_STANDARDS.md "Zod is the source of truth"). Mirrors
 * Cascade's `src/config/schema.ts`: a central schema that composes each
 * provider's own schema *by import* rather than re-declaring its fields, so a
 * hand-written type and a hand-written validator can't quietly drift apart.
 *
 * Scope (SWARM-5, Phase 0): repo + worktree location, the GitHub Projects board
 * mapping, and credential *references*. The actual secrets are never stored
 * here — see `CredentialsSchema` below.
 */

import { z } from 'zod';
import { type AgentCli, AgentCliSchema } from '../harness/agent-cli.js';
import {
	AGENT_MODELS,
	ALL_AGENT_MODELS,
	ANTIGRAVITY_MODEL_SLUGS,
	capabilityFor,
	LEGACY_ANTIGRAVITY_DISPLAY_STRINGS,
	ReasoningLevelSchema,
	splitAntigravityModel,
} from '../harness/models.js';
import { githubProjectsConfigSchema } from '../integrations/pm/github-projects/config-schema.js';
import { jiraConfigSchema } from '../integrations/pm/jira/config-schema.js';
import { linearConfigSchema } from '../integrations/pm/linear/config-schema.js';
// Registry lookup only — `./registry.js` imports nothing at runtime, so this stays a
// leaf import rather than pulling the provider implementations in behind it.
import { getPMProvider } from '../integrations/pm/registry.js';
import { trelloConfigSchema } from '../integrations/pm/trello/config-schema.js';
// Registry lookup only, like the PM one above — `../integrations/scm/registry.js`
// imports nothing at runtime.
import { listSCMProviders } from '../integrations/scm/registry.js';
// The value list behind `PMType` — `../pm/types.js` imports nothing at runtime either.
import { PM_TYPES, type PMType } from '../pm/types.js';
// The Zod mirror of `ScmType`; `../scm/events.js` imports only zod plus a type-only
// `ScmType`, so this stays a leaf import too.
import { ScmProviderIdSchema } from '../scm/events.js';
// The value list behind `ScmType` — `../scm/types.js` imports nothing at runtime.
import { SCM_TYPES } from '../scm/types.js';
import { CUSTOM_PROMPT_MAX_LENGTH, normalizeCustomPrompt } from './custom-prompt.js';
import {
	adoptLegacyPmCredentials,
	PmCredentialReferencesByProviderSchema,
	PmProviderCredentialReferencesSchema,
} from './pm-credentials.js';
import {
	adoptLegacyScmCredentials,
	ScmCredentialReferencesByProviderSchema,
	ScmProviderCredentialReferencesSchema,
} from './scm-credentials.js';

/**
 * A model value is known when it's a logical id for its CLI (or the union, when
 * `cli` is omitted). Antigravity additionally accepts its combined `agy models`
 * slugs (`gemini-3.6-flash-high`) and the retired pre-1.1.5 display strings
 * (`"Gemini 3.5 Flash (High)"`) previous configs stored, so both validate
 * unchanged and are normalized to logical id + reasoning on parse.
 */
function isKnownModel(cli: AgentCli | undefined, model: string): boolean {
	const allowed = cli ? AGENT_MODELS[cli] : ALL_AGENT_MODELS;
	if ((allowed as readonly string[]).includes(model)) return true;
	if (cli === 'antigravity' || cli === undefined) {
		return (
			(ANTIGRAVITY_MODEL_SLUGS as readonly string[]).includes(model) ||
			Object.hasOwn(LEGACY_ANTIGRAVITY_DISPLAY_STRINGS, model)
		);
	}
	return false;
}

// The per-phase custom-prompt bound and normalizer live in a dependency-free
// leaf (issue #135) so the dashboard bundle can import them without pulling this
// schema's Node-only transitive deps; re-exported here for existing callers.
export { CUSTOM_PROMPT_MAX_LENGTH, normalizeCustomPrompt };

export const PROJECT_DEFAULTS = {
	baseBranch: 'main',
	branchPrefix: 'issue-',
	/** Mirrors the documented SWARM_WORKER_CONCURRENCY default. */
	maxConcurrentJobs: 1,
	/** Relative to `repoRoot`; matches the worktree lifecycle in ai/ARCHITECTURE.md. */
	worktreeRoot: '.swarm-workspaces',
	maxWorktrees: 10,
} as const;

/**
 * References to a project's *project-scoped* source-control credentials — the
 * reviewer persona token plus the webhook-verification secret — as the single
 * shared pair they were before issue #628.
 *
 * **Legacy shape, kept only so an old config still parses.** Both keys are now
 * optional on {@link CredentialsSchema} and are read by exactly one thing: the
 * adoption normalizer (`./scm-credentials.ts`), which copies them into
 * `credentials.scm[<the provider the project runs on>]`. Nothing resolves them at
 * runtime. The live shape is {@link ScmCredentialReferencesByProviderSchema}, one
 * block per provider, so a project can hold GitHub's and GitLab's credentials at
 * once instead of the two overwriting one pair.
 *
 * These are *references*, never the secret values: each is a key into the
 * secret store (the Postgres `project_credentials` table / an env var name),
 * resolved at runtime and scoped via `AsyncLocalStorage` (ai/CODING_STANDARDS.md
 * "Scope credentials with AsyncLocalStorage"). Storing the raw tokens in the
 * project config JSON would defeat that scoping and leak them into logs and
 * DB rows — PROJECT.md §6.1 keeps secrets out of config on purpose.
 *
 * The `implementer` persona is deliberately **not** here (issue #396): it is the
 * worker operator's own token, a worker-local `SWARM_OPERATOR_GH_TOKEN` env var
 * (`./operator-token.ts`), never persisted and never in this config. The
 * implementer/reviewer loop-prevention split (ai/CODING_STANDARDS.md "Loop
 * prevention") still holds — the two personas resolve to two distinct identities
 * (author = operator ≠ reviewer). This schema stays non-strict, so a legacy
 * `swarm.config.json` still carrying an `implementer` reference parses with the
 * key stripped, keeping `swarm config apply` idempotent.
 *
 * @deprecated Pre-#628 shared pair — use `credentials.scm[<providerId>]`.
 */
export const ScmCredentialReferencesSchema = z.object({
	/** Reference to the reviewer-persona token in the secret store. */
	reviewer: z.string().min(1),
	/** Reference to the secret inbound deliveries are authenticated with. */
	webhookSecret: z.string().min(1),
});

/**
 * A project's credential *references*, in three parts:
 *
 * - `scm` — one `{ reviewer?, webhookSecret? }` block **per SCM provider id** (issue
 *   #628), validated against the registered SCM manifests by
 *   {@link validateScmCredentialReferences}. Resolution reads only the provider it
 *   was asked for, so a project may retain a provider it is not currently running on
 *   without either provider's secret shadowing the other's.
 * - `reviewer` / `webhookSecret` — the **legacy** shared pair, now optional and read
 *   only by `adoptLegacyScmCredentials` (`./scm-credentials.ts`), which copies it into
 *   `scm` on parse. Kept (rather than deleted) so an old `swarm.config.json` still
 *   parses at all: a non-strict object would strip the keys and lose the reference
 *   names before the normalizer could adopt them.
 * - `pm` — one `role -> reference` block **per PM provider id** (issue #631),
 *   validated against the registered PM manifests by
 *   {@link validatePmCredentialRoles}. Resolution reads only the provider it was
 *   asked for, so a project may retain a provider it is not currently running on
 *   without either provider's secret shadowing the other's — the role names
 *   genuinely collide (`apiToken` is GitHub Projects' *and* Jira's). Optional and
 *   staying so deliberately: a provider whose roles all resolve from elsewhere needs
 *   no entry (GitHub Projects' webhook secret inherits the repo side's). A **legacy
 *   flat** `role -> reference` map is still accepted and nested under `pm.type` by
 *   `adoptLegacyPmCredentials` (`./pm-credentials.ts`) — a `z.preprocess` rather than
 *   the SCM side's output transform, because here the legacy and live shapes share
 *   this one key.
 *
 * Every field being optional means the whole block can legitimately be `{}` — a
 * project mid-provider-switch, or the DB-free worker's inert placeholder
 * (`src/transport/db-free-project.ts`).
 */
export const CredentialsSchema = z
	.object({
		/** @deprecated Pre-#628 shared reviewer reference; adopted into `scm` on parse. */
		reviewer: z.string().min(1).optional(),
		/** @deprecated Pre-#628 shared webhook-secret reference; adopted into `scm` on parse. */
		webhookSecret: z.string().min(1).optional(),
		scm: ScmCredentialReferencesByProviderSchema.optional(),
		pm: PmCredentialReferencesByProviderSchema.optional(),
	})
	.describe('References to a project credentials (never the secrets themselves)');

/**
 * One agent model target — a CLI, the logical model to run on it, and the
 * reasoning level to run it at. Every field is optional: omit `cli` to keep the
 * phase's own coded default (`DEFAULT_PLANNING_CLI` and friends,
 * `src/pipeline/*.ts`), omit `model` to run on that CLI's own default model,
 * omit `reasoning` to inherit the effective model's known default (the CLI's own
 * default when it controls it).
 *
 * `model`, when given, must be a *logical* model id for its CLI per
 * `AGENT_MODELS` (`src/harness/models.ts`) — `claude`'s aliases (`sonnet`, …),
 * `codex`'s short ids (`gpt-5.6-sol`, …), or an antigravity logical id
 * (`gemini-3.5-flash`, …). When `cli` is omitted, `model` is checked against the
 * union of all lists. A legacy combined antigravity string (`"Gemini 3.5 Flash
 * (High)"`) from a pre-#180 config is accepted and normalized on parse into the
 * logical id plus its `reasoning` level, so it keeps launching that exact
 * variant.
 *
 * `reasoning`, when given, must be a level the effective `(cli, model)` supports
 * (`ModelCapability.reasoningChoices`) — validated against the model, never as a
 * free-standing per-CLI string (issue #180).
 *
 * A phase holds these in priority order (`AgentConfigSchema.targets`).
 */
export const AgentTargetSchema = z
	.object({
		cli: AgentCliSchema.optional(),
		model: z.string().min(1).optional(),
		reasoning: ReasoningLevelSchema.optional(),
	})
	.transform((target) => {
		// Migrate a pre-#180 combined antigravity model string losslessly into
		// logical model + reasoning. An explicit `reasoning` already on the target
		// wins over the one recovered from the string. Mutate in place (rather than
		// spreading onto a fresh object) so the inferred output keeps every field
		// optional instead of widening into a union of two shapes.
		if (target.cli === 'antigravity' && target.model) {
			const split = splitAntigravityModel(target.model);
			if (split) {
				target.model = split.model;
				target.reasoning = target.reasoning ?? split.reasoning;
			}
		}
		return target;
	})
	.refine((target) => !target.model || isKnownModel(target.cli, target.model), {
		message: 'model must be one of the known models for its cli (src/harness/models.ts)',
	})
	.refine(
		(target) => {
			if (!target.reasoning) return true;
			// Can't validate reasoning without a concrete (cli, model) to check it against.
			if (!target.cli || !target.model) return false;
			const cap = capabilityFor(target.cli, target.model);
			if (!cap) return true; // legacy/unknown model — leave the value untouched
			return (cap.reasoningChoices as readonly string[]).includes(target.reasoning);
		},
		{ message: 'reasoning must be a level supported by the selected cli/model (issue #180)' },
	)
	.describe('One agent CLI/model/reasoning target a phase can run on');

/**
 * Per-phase agent override: an ordered list of model `targets` plus the
 * phase-level `timeoutMs`/`prompt`. Every field is optional; an empty object
 * keeps the phase entirely on its coded defaults.
 *
 * `targets` is a priority list — index 0 is the most preferred target, and at
 * most one entry may name any given CLI (a phase asks for "this model on codex",
 * not two). The worker runs the highest-priority target whose CLI it can
 * actually run, falling back to `targets[0]` when it can run none
 * (`src/worker/target-selection.ts`, issue #346).
 *
 * The top-level `cli`/`model`/`reasoning` fields are a **derived mirror of
 * `targets[0]`**, not independent settings: a config that sets only them (every
 * config written before `targets` existed, including one storing a legacy
 * combined antigravity model string) normalizes on parse into a one-element
 * `targets` list, and the mirror is rewritten from `targets[0]` whenever a list
 * is given. Readers that only understand a single selection — a per-run pinned
 * retry and the dashboard — therefore keep resolving the highest-priority
 * target unchanged.
 */
export const AgentConfigSchema = z
	.object({
		cli: AgentCliSchema.optional(),
		model: z.string().min(1).optional(),
		reasoning: ReasoningLevelSchema.optional(),
		/** Model targets in priority order, at most one per CLI (see above). */
		targets: z.array(AgentTargetSchema).optional(),
		/** A bounded per-phase timeout: 5–45 minutes, stored in milliseconds. */
		timeoutMs: z
			.number()
			.int()
			.min(5 * 60 * 1000)
			.max(45 * 60 * 1000)
			.optional(),
		/**
		 * Optional project-owned instructions appended to this phase's SWARM
		 * prompt (issue #135). Supplements — never replaces or weakens — the
		 * phase's static instructions and guards. Trimmed on parse; whitespace-only
		 * collapses to unset, and the composer adds nothing when it's absent, so a
		 * project without one produces exactly today's prompt.
		 */
		prompt: z.string().optional(),
	})
	.transform((agent, ctx) => {
		// Whitespace-only is not a meaningful override — normalize it away so it's
		// neither stored nor composed (issue #135). Mutate in place (rather than
		// spreading a `prompt` key onto the result) so the inferred output keeps
		// `prompt` optional, matching every other field.
		agent.prompt = normalizeCustomPrompt(agent.prompt);
		if (agent.targets === undefined) {
			// A config written before `targets` existed (or one the pre-list dashboard
			// saved): fold its single selection into the list so every reader sees one
			// shape. Parsing it through `AgentTargetSchema` keeps target validation —
			// including the legacy antigravity migration — in exactly one place.
			const legacy = AgentTargetSchema.safeParse({
				cli: agent.cli,
				model: agent.model,
				reasoning: agent.reasoning,
			});
			if (!legacy.success) {
				// `fatal` aborts the parse: without it the refinements below would still
				// run, on the `z.NEVER` this returns rather than on a config.
				for (const issue of legacy.error.issues) ctx.addIssue({ ...issue, fatal: true });
				return z.NEVER;
			}
			const { cli, model, reasoning } = legacy.data;
			if (cli || model || reasoning) agent.targets = [legacy.data];
			// An override that selects nothing stays on the coded defaults — no list, no mirror.
			else delete agent.targets;
		} else if (agent.targets.length === 0) {
			// An explicitly empty target list is an authoritative clear: delete all
			// targets and mirror fields so the parsed result has none.
			delete agent.targets;
			delete agent.cli;
			delete agent.model;
			delete agent.reasoning;
		}

		// The top-level fields are a derived mirror of the highest-priority target,
		// so single-selection readers (the worker, the dashboard) keep working
		// without knowing the list exists. Assigned unconditionally: a stale mirror
		// left beside an explicit `targets` list must be overwritten, not merged.
		const [primary] = agent.targets ?? [];
		if (primary) {
			if (primary.cli !== undefined) agent.cli = primary.cli;
			else delete agent.cli;
			if (primary.model !== undefined) agent.model = primary.model;
			else delete agent.model;
			if (primary.reasoning !== undefined) agent.reasoning = primary.reasoning;
			else delete agent.reasoning;
		} else {
			delete agent.cli;
			delete agent.model;
			delete agent.reasoning;
		}
		return agent;
	})
	.refine((agent) => !agent.prompt || agent.prompt.length <= CUSTOM_PROMPT_MAX_LENGTH, {
		message: `prompt must be at most ${CUSTOM_PROMPT_MAX_LENGTH} characters (issue #135)`,
		path: ['prompt'],
	})
	.refine(
		// A phase names each CLI at most once — two targets on the same CLI would be
		// an ambiguous priority rather than a fallback. `undefined` participates in
		// the same uniqueness check, so the coded-default-CLI entry is also unique.
		(agent) =>
			!agent.targets || new Set(agent.targets.map((t) => t.cli)).size === agent.targets.length,
		{
			message: 'targets must not name the same cli twice (at most one target per cli)',
			path: ['targets'],
		},
	)
	.describe('Per-phase agent override — an ordered list of CLI/model/reasoning targets');

/**
 * Per-CLI default model — the model used when a phase specifies (or falls back
 * to) a given CLI but doesn't set its own per-phase model override. Configuring
 * `defaults: { claude: "sonnet" }` means every claude-phase without an explicit
 * model runs on sonnet, rather than whatever the `claude` binary itself would
 * pick.
 *
 * Each key must be a known `AgentCli`, and the value must be valid for that CLI
 * per `AGENT_MODELS` — the same validation `AgentConfigSchema.model` uses, just
 * keyed by CLI instead of by phase. Defaults store a model only, never a
 * reasoning level: a per-CLI default reasoning can be invalid for another model
 * the phase selects, so reasoning is resolved against the *effective* model
 * (per-phase/per-run override → the model's own default), not defaulted per-CLI
 * (issue #180). A legacy combined antigravity string is still accepted.
 */
export const AgentDefaultsSchema = z
	.record(AgentCliSchema, z.string().min(1).optional())
	.refine(
		(defaults) => {
			for (const [cli, model] of Object.entries(defaults)) {
				if (!model) continue;
				if (!isKnownModel(cli as AgentCli, model)) return false;
			}
			return true;
		},
		{
			message:
				'each default model must be one of the known models for its cli (src/harness/models.ts)',
		},
	)
	.describe('Per-CLI default model — used when a phase omits its own model override');

/**
 * Per-phase agent overrides, keyed by the same phase names the trigger/worker
 * layer already uses (`TriggerResult['phase']`, `src/triggers/types.ts`) —
 * camelCased to match this config's other multi-word keys (`statusOptions`'s
 * `inProgress`/`inReview`) rather than the kebab-case wire form. Every key is
 * optional; an entirely absent `agents` block (or an absent phase within it)
 * means every phase keeps running on its coded default, unchanged from before
 * this existed.
 *
 * `defaults` sets a per-CLI default model (e.g. `{ claude: "sonnet" }`) — the
 * fallback when a phase specifies (or inherits) a CLI but doesn't set its own
 * `model`. Without it, the CLI runs with its own built-in default.
 *
 * `implementationUnplanned` is a config-only Implementation variant used when
 * there is no prior *completed* Planning run for the same work item — a
 * failed or deferred attempt does not count (issue #247). It falls back to
 * `implementation` when omitted; it is not a pipeline phase.
 */
export const AgentsConfigSchema = z
	.object({
		defaults: AgentDefaultsSchema.optional(),
		planning: AgentConfigSchema.optional(),
		implementation: AgentConfigSchema.optional(),
		implementationUnplanned: AgentConfigSchema.optional(),
		review: AgentConfigSchema.optional(),
		respondToReview: AgentConfigSchema.optional(),
		respondToCi: AgentConfigSchema.optional(),
		resolveConflicts: AgentConfigSchema.optional(),
	})
	.describe('Per-phase agent CLI/model overrides — omit any phase to keep its coded default');

/**
 * Review-trigger policy for a head SHA with zero registered checks
 * (`decideAggregateCheckOutcome`, `src/triggers/handlers/aggregate-check-decision.ts`).
 * `required` (the default) defers, treating zero checks the same as CI not
 * having caught up yet. `if-present` dispatches Review immediately on zero
 * checks — for projects with no CI at all — while still waiting on any
 * checks that are present and routing a failure to Respond-to-CI (issue #274).
 */
export const ReviewChecksPolicySchema = z.enum(['required', 'if-present']);
export type ReviewChecksPolicy = z.infer<typeof ReviewChecksPolicySchema>;

/**
 * Per-phase pipeline controls, plus the project-wide automation opt-in
 * (`automationLabel`). Planning can optionally move the board item to
 * "ToDo" after posting its plan. The SCM-event-driven Review,
 * Respond-to-review, and Respond-to-CI phases can each be disabled.
 * Implementation always reports pickup by moving to "In progress", then moves
 * to "In review" after delivery exactly when Review is enabled.
 */
export const PipelineBaseSchema = z.object({
	/**
	 * Whether Planning moves the item to "ToDo" once it posts the plan.
	 * Unset (or the whole `pipeline.planning` block omitted) defaults to
	 * `false`: a human reviews the plan and moves the item themselves to
	 * greenlight Implementation.
	 *
	 * `autoSplit` (default `true`) lets the planning agent decompose a task it
	 * judges too large for a single PR: the original item becomes the smaller
	 * first task (re-scoped, possibly renamed), and the remaining work is spawned
	 * as sibling items that are preplanned by the parent and never auto-advance to
	 * "ToDo" — a human moves those in the order they choose (`src/pipeline/planning.ts`).
	 *
	 * `maxConcerns` (default `1`, only used when `autoSplit` is on) is the
	 * single-task budget the deterministic post-plan guard enforces: the largest
	 * number of independent concerns an unsplit task may declare in
	 * `proposed_scope.json` before Planning fails and asks for a split or a
	 * narrower plan (issue #268). Raise it to loosen the guard.
	 */
	planning: z
		.object({
			autoAdvance: z.boolean().optional(),
			autoSplit: z.boolean().optional(),
			maxConcerns: z.number().int().positive().optional(),
		})
		.optional(),
	review: z
		.object({
			enabled: z.boolean().optional(),
			/** See {@link ReviewChecksPolicySchema}. Unset defaults to `required`. */
			checks: ReviewChecksPolicySchema.optional(),
		})
		.optional(),
	respondToReview: z
		.object({
			enabled: z.boolean().optional(),
			autoMerge: z.boolean().optional(),
			/** Skip approval/comment reviews so only requested changes consume a response run. */
			skipOnMinors: z.boolean().optional(),
		})
		.optional(),
	respondToCi: z.object({ enabled: z.boolean().optional() }).optional(),
	/**
	 * When a continuation of already-active pipeline work is blocked *solely* by
	 * this project's concurrency limit, prioritize it over fresh
	 * Planning/Implementation work once a slot frees, instead of sending it
	 * through the generic rate-limit retry delay (issue #214). Unset (or the
	 * whole `pipeline` block omitted) defaults to `true`; set `false` to preserve
	 * the prior best-effort/FIFO scheduling for maximum new-work throughput.
	 *
	 * Applies to Review, Respond-to-review, Respond-to-CI, and
	 * Resolve-conflicts; Planning and Implementation remain new board work.
	 */
	prioritizeContinuations: z.boolean().optional(),
	/**
	 * How many times one run may be continued from its Tier 2 checkpoint
	 * (`docs/CHECKPOINTS.md`) before the fallback gives up and the run fails
	 * terminally with a "continuation budget exhausted" reason. Unset (or the whole
	 * `pipeline` block omitted) defaults to
	 * `DEFAULT_MAX_CONTINUATIONS` (`src/pipeline/checkpoint.ts`).
	 *
	 * The bound matters because a checkpoint continuation re-seeds a *fresh* session
	 * from a degraded hand-off: a phase that keeps stopping involuntarily would
	 * otherwise hand itself off forever, each time paying for a new session that
	 * re-reads the same remainder. Counted per run row (`runs.continuation_count`)
	 * and cleared only by "Reset & restart", not by an ordinary retry.
	 */
	maxContinuations: z.number().int().positive().optional(),
	/**
	 * Label a work item must carry before SWARM starts a board-driven agent
	 * phase (Planning, Implementation) for it — the explicit, human-controlled
	 * automation opt-in (issue #131). Provider-neutral: it is a work-item label
	 * name resolved through `WorkItem.labels`, not a GitHub-specific concept
	 * (`src/pm/automation-label.ts`). Unset defaults to
	 * `DEFAULT_AUTOMATION_LABEL` (`swarm`); an explicitly empty string turns the
	 * gate off for the project.
	 *
	 * This is an opt-in marker, never an access-control mechanism: it cannot
	 * grant a user or a worker access to a project (ADR-001's authorization
	 * layers are separate and unaffected).
	 */
	automationLabel: z.string().trim().optional(),
});

export const PipelineConfigSchema = PipelineBaseSchema.refine(
	(pipeline) => pipeline.review?.enabled !== false || pipeline.respondToReview?.enabled === false,
	{
		message: 'Respond-to-review cannot be enabled when Review is disabled',
		path: ['respondToReview', 'enabled'],
	},
).describe('Per-phase pipeline controls');

export const WorktreeRetentionConfigSchema = z
	.object({
		/**
		 * How many of the project's most-recently-active task-<id> worktrees to
		 * keep; the rest are candidates for pruning (subject to the in-flight and
		 * uncommitted-changes safety checks — see src/worktree/retention.ts).
		 */
		maxWorktrees: z.number().int().positive().default(PROJECT_DEFAULTS.maxWorktrees),
	})
	.describe('Retention policy for stale per-task worktrees under worktreeRoot');

/**
 * A project's discovery / open-join policy — the per-project visibility that
 * separates *seeing* a project from *belonging* to it (ADR-001, #281 task 5).
 *
 * - `private` (the default) — the project is visible only to its members and
 *   instance admins; task-4 authorization already hides it from everyone else.
 * - `discoverable` — additionally exposes a **limited** public read (id + name
 *   only, never credentials, config, repo, or run internals) to any
 *   authenticated user via `projects.listDiscoverable`, and lets them file a
 *   membership request (`projects.requestMembership`).
 *
 * Discoverability grants no access on its own: a request must be approved by a
 * `projectAdmin`/`instanceAdmin`, and approval grants only `contributor` (read).
 * It never grants worker registration or automatic task routing — those are
 * separate permissions (ADR-001 access model, out of scope for #281 task 5).
 */
export const ProjectVisibilitySchema = z.enum(['private', 'discoverable']);
export type ProjectVisibility = z.infer<typeof ProjectVisibilitySchema>;

/** Every visibility value — for CLI/dashboard copy and validation. */
export const PROJECT_VISIBILITIES = ProjectVisibilitySchema.options;

/**
 * The project's PM provider *and* that provider's own config, as one
 * discriminated union over `type` (issue #495). Each member is
 * `{ type: <provider id> } & <that provider's configSchema>` — composed by
 * import from the provider's `config-schema.ts`, which stays the single source of
 * truth for its own shape (ai/CODING_STANDARDS.md "Zod is the source of truth";
 * the same schema the provider declares on its manifest as `configSchema`).
 *
 * Why a union rather than a discriminator field beside a sibling provider block:
 * a board mapping is meaningless outside the provider it maps, so the config that
 * belongs to a provider lives under it. Adding a second provider (Jira, Linear,
 * Trello — `PMType`, `src/pm/types.ts`) is one new member here plus its manifest;
 * no other central shape, the `projects` table, the repository, or the
 * dashboard's provider-neutral board-mapping form changes.
 *
 * Narrowing a member back to a concrete provider's config is the *provider's* job
 * — `requireGitHubProjectsConfig`, `requireLinearConfig`, `requireJiraConfig`,
 * `requireTrelloConfig` — never a `pm.type` branch in shared code (ai/RULES.md §2).
 * The Jira and Trello members parse ahead of their manifests: each remains
 * unresolvable, and mounts no route, until that provider is complete and registered
 * (issue #490 phase 1/6 and issue #492 phase 1/6), exactly as the Linear member did
 * before issue #530.
 *
 * Routing the member list through the PM registry instead of importing each
 * provider's schema here stays deferred, exactly as `PMProviderManifest`'s own
 * doc-comment says: the manifest already declares `configSchema`, so the day that
 * indirection earns its keep this list is what it replaces.
 */
export const ProjectPmSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('github-projects') }).merge(githubProjectsConfigSchema),
	z.object({ type: z.literal('linear') }).merge(linearConfigSchema),
	z.object({ type: z.literal('jira') }).merge(jiraConfigSchema),
	z.object({ type: z.literal('trello') }).merge(trelloConfigSchema),
]);

/**
 * One repository a project owns, with the settings that are genuinely
 * per-repository (issue #684 phase 1): the coordinates themselves, the branch
 * worktrees are cut from, the task-branch prefix, and an optional SCM-provider
 * override for a project whose repositories don't all live on the same provider.
 *
 * These four fields used to sit at the top level of a project, where they were
 * indistinguishable from the genuinely shared settings beside them. They are the
 * entry of {@link ProjectRecordBaseSchema}'s `repositories` list now, and remain
 * flattened back onto {@link ProjectConfigBaseSchema} — the project *scoped to one
 * of its repositories*, which is what every runtime call site takes.
 */
export const ProjectRepositorySchema = z.object({
	/** The repository this entry names, as `owner/repo`. */
	repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be in format "owner/repo"'),

	/**
	 * The SCM provider *this repository* lives on, overriding the project-level
	 * `scm` default so a project can span two providers. Omit it — as a
	 * single-provider project does — and the project's own `scm` is what
	 * `requireProjectSCMProvider` resolves.
	 */
	scm: ScmProviderIdSchema.optional(),

	/** Branch task worktrees are cut from and PRs target. */
	baseBranch: z.string().min(1).default(PROJECT_DEFAULTS.baseBranch),

	/** Prefix for task branch names — SWARM's convention is `issue-<n>-<slug>`. */
	branchPrefix: z.string().default(PROJECT_DEFAULTS.branchPrefix),
});

/**
 * The **authored and persisted** project's field shape, without the cross-field
 * checks {@link ProjectRecordSchema} adds — the same base/refined split
 * `PipelineBaseSchema`/`PipelineConfigSchema` uses above.
 *
 * Everything genuinely shared across a project's repositories is stated once here;
 * everything genuinely per-repository is an entry of `repositories`. This is the
 * shape `swarm.config.json` authors, the `projects` table persists, and the projects
 * API reads and writes. Runtime code takes {@link ProjectConfigBaseSchema} instead —
 * this record narrowed to one of its repositories by `scopeProjectToRepository`
 * (`./project-repository.ts`).
 */
export const ProjectRecordBaseSchema = z.object({
	/** Stable internal identifier for this SWARM project (one Postgres row per project). */
	id: z.string().min(1),

	/** Human-facing name — also the `{project-name}` in the worktree paths (PROJECT.md §4.1). */
	name: z.string().min(1),

	/**
	 * The repositories this project operates on ({@link ProjectRepositorySchema}).
	 *
	 * **Capped at exactly one entry in issue #684 phase 1.** The list is the durable
	 * shape — the schema, the `projects.repositories` column, and the repository
	 * lookups all speak it — but a *second* repository is not routable until phase 2
	 * threads the chosen repository from the queue job through to the worker.
	 * Accepting one before then would let a webhook from repository B resolve the
	 * project and then run the phase against repository A. Phase 2 lifts the cap in
	 * the same change that closes that gap.
	 */
	repositories: z
		.array(ProjectRepositorySchema)
		.min(1)
		.max(1, {
			message:
				'A project owns exactly one repository for now — several repositories per ' +
				'project land with issue #684 phase 2',
		}),

	/**
	 * The SCM provider this project's repositories live on by default — the
	 * discriminator `requireProjectSCMProvider` (`src/integrations/scm/registry.ts`)
	 * resolves, and the SCM twin of `pm`'s `type` (issue #478). An entry's `repo` is
	 * the coordinates *this* provider interprets (`owner/repo`, a Bitbucket
	 * `workspace/repo_slug`, a GitLab `namespace/project`), which is why the
	 * discriminator is stated rather than inferred from the repo string: there is
	 * nothing in a bare `owner/repo` to tell two providers apart. A repository that
	 * lives elsewhere states its own `scm` and overrides this.
	 *
	 * **Optional in shape, required in practice since issue #618.** Absence means "the
	 * sole runtime-ready registered provider", which was the back-compat path for
	 * projects written before this field existed — and it stopped resolving the moment
	 * Bitbucket became the second runtime-ready provider. Absence is not a silent pick:
	 * with zero — or two or more — runtime-ready providers registered, the lookup
	 * throws and names this field, so an existing project must now state `"scm":
	 * "github"` (one field, then `swarm config apply`). Naming a provider that is
	 * unregistered, or registered but not runtime-ready
	 * (`SCMProviderManifest.runtimeReady`), also throws rather than falling back to
	 * another provider. The field stays optional rather than gaining a `github`
	 * default, because a default would silently route a Bitbucket or GitLab project's
	 * operations onto GitHub instead of failing loudly.
	 *
	 * A bare provider id rather than a `pm`-style discriminated union on purpose: an
	 * SCM manifest declares no `configSchema` (a project's SCM config is `repo` +
	 * `credentials`, shared by every provider — issue #290), so there is no
	 * provider-owned block for a discriminator to sit beside. If one ever appears,
	 * this field is what becomes that union's `type`.
	 *
	 * Deliberately *not* cross-checked against the registry here: a config may be
	 * parsed by a surface that never loaded `src/integrations/entrypoint.js` (a
	 * dashboard bundle, a focused unit test, the DB-free worker's
	 * `reconstructProjectConfig`), and validation must not depend on which modules a
	 * process happens to import — the same reasoning `validatePmCredentialRoles`
	 * below applies to `pm.type`. The enum is the boundary validation; the registry
	 * check is the lookup's loud error.
	 */
	scm: ScmProviderIdSchema.optional(),

	/**
	 * Absolute path to the main repository checkout on the developer's machine
	 * (the "human workspace", `~/swarm/{project-name}/` in PROJECT.md §4.1). Task
	 * worktrees are created relative to this path.
	 */
	repoRoot: z.string().min(1),

	/**
	 * Directory under `repoRoot` where per-task git worktrees live
	 * (ai/ARCHITECTURE.md "Worktree lifecycle"). Relative, not absolute, so the
	 * same value is meaningful beneath each execution host's own `repoRoot`.
	 */
	worktreeRoot: z.string().min(1).default(PROJECT_DEFAULTS.worktreeRoot),

	/** Maximum number of jobs this project may run concurrently. */
	maxConcurrentJobs: z.number().int().positive().default(PROJECT_DEFAULTS.maxConcurrentJobs),

	/** Discovery / open-join policy (`ProjectVisibilitySchema`); `private` by default. */
	visibility: ProjectVisibilitySchema.default('private'),

	/**
	 * The project's PM provider and its board mapping (`ProjectPmSchema`) —
	 * **required**, and carrying no default: the provider that owns a project's
	 * board is a deliberate choice, and its mapping (opaque board/state ids) has no
	 * sensible default to fall back on.
	 */
	pm: ProjectPmSchema,

	/** References to the project's credentials (see `CredentialsSchema`). */
	credentials: CredentialsSchema,

	/** Per-phase agent CLI/model overrides. Omit entirely to keep every phase's coded default. */
	agents: AgentsConfigSchema.optional(),

	/** Per-phase autonomous board-move control. Omit entirely to keep the coded defaults. */
	pipeline: PipelineConfigSchema.optional(),

	/** Per-project worktree retention policy (`WorktreeRetentionConfig`) — nullable: most projects omit it and use the coded default. */
	worktreeRetention: WorktreeRetentionConfigSchema.optional(),
});

/**
 * A project **scoped to one of its repositories** — the project's shared settings
 * with one `repositories` entry flattened over them — without the cross-field checks
 * {@link ProjectConfigSchema} adds.
 *
 * This is the shape every runtime call site takes, and it is deliberately unchanged
 * by issue #684: the four per-repository fields are still `project.repo`,
 * `project.baseBranch`, `project.branchPrefix` and `project.scm`, so the pipeline
 * phases, the triggers, the SCM provider contract and the worker keep reading a
 * project exactly as they did. What changed is where it comes from —
 * `scopeProjectToRepository` (`./project-repository.ts`) narrows a
 * {@link ProjectRecordSchema} down to it — and what it *cannot* carry: a scoped
 * config has no `repositories` list in it, so no call site can accidentally act on a
 * repository other than the one its task names.
 *
 * Derived by merge rather than restated so the two shapes can't drift: the entry's
 * `scm` member wins over the project-level default, which is what
 * `scopeProjectToRepository` resolves before it builds one.
 *
 * `.pick()`/`.omit()` are `z.object` methods, and `.merge()` of two `z.object`s is
 * another — so the worker-safe projection (`./worker-config.ts`), the non-secret
 * transport slice (`./project-config-slice.ts`), and the projects API's write input
 * all keep deriving narrower schemas from these fields. Parse
 * **`ProjectConfigSchema`**, not this, when validating a whole scoped config.
 */
export const ProjectConfigBaseSchema = ProjectRecordBaseSchema.omit({
	repositories: true,
}).merge(ProjectRepositorySchema);

/**
 * The slice of a project the two credential refinements below read — the record and
 * the scoped config alike, since neither check looks at a repository.
 */
interface CredentialRefinementInput {
	pm: z.infer<typeof ProjectPmSchema>;
	credentials: z.infer<typeof CredentialsSchema>;
}

/**
 * Validate `credentials.pm` against the registered PM manifests (issues #497, #631) —
 * the cross-field check neither schema can make alone, since the roles live on each
 * provider's manifest and the references live under `credentials`.
 *
 * Three rules, all aimed at the operator who mistyped a key or forgot a role:
 *
 * 1. **Every key must be a known PM provider id** (`PM_TYPES`), so a typo'd key is
 *    caught rather than silently holding credentials nothing will ever read. Checked
 *    against the *value list*, not the registry, for the reason
 *    {@link validateScmCredentialReferences} gives: a config may be parsed by a
 *    surface that never loaded `src/integrations/entrypoint.js`, and validity must not
 *    depend on which modules a process imported.
 * 2. **Every role under a registered provider's block must be one that provider
 *    declares** — a reference for an undeclared role is an error naming the roles it
 *    does declare, since silently ignoring it would leave the operator believing they
 *    configured a credential that will never be read. This half needs the manifest, so
 *    it is skipped for a provider that is not registered here; `requireProjectPMProvider`
 *    (`src/integrations/pm/registry.ts`) is the loud check for that.
 * 3. **Every non-optional role of `project.pm.type` must be configured** — in that
 *    provider's own block. A role that declares `inheritsSharedCredential` is exempt:
 *    it already resolves without an entry. `credentials.pm` therefore remains optional
 *    for a provider whose roles are all optional or inherited, and a provider with a
 *    non-optional, non-inherited role still requires it even when the whole map is
 *    absent.
 *
 * Rule 3 is where this **deliberately diverges** from the SCM twin, which has no
 * presence check because `project.scm` is switchable from the dashboard's Source
 * Control tab and "provider selected, credentials not yet entered" is a state one
 * click legitimately creates. The PM switch flow works the other way round — the
 * incoming provider's credentials are entered *before* the `pm` member is written — so
 * a half-switched config is never something a save produces, and rule 3 is precisely
 * what makes one unparseable. Only rule 3 is scoped to `pm.type`; the other two apply
 * to every block, including one retained for a provider the project is not running on.
 * (`upsertProjectToDb` does not parse, so this is a `validateConfig` / `swarm config
 * apply` gate rather than an API one.)
 */
function validatePmCredentialRoles(
	// Only the two fields it reads, rather than a whole project: it refines both
	// `ProjectRecordSchema` and `ProjectConfigSchema`, and naming either inferred type
	// here would make the inference circular anyway.
	project: CredentialRefinementInput,
	ctx: z.RefinementCtx,
): void {
	const references = project.credentials.pm ?? {};
	for (const [providerId, roles] of Object.entries(references)) {
		validatePmCredentialBlock(providerId, roles, ctx);
	}
	validateCurrentPmProviderRoles(project.pm.type, references[project.pm.type] ?? {}, ctx);
}

/** Rules 1 and 2 of {@link validatePmCredentialRoles}, for one provider's block. */
function validatePmCredentialBlock(
	providerId: string,
	roles: Record<string, string>,
	ctx: z.RefinementCtx,
): void {
	if (!(PM_TYPES as readonly string[]).includes(providerId)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['credentials', 'pm', providerId],
			message:
				`'${providerId}' is not a PM provider id, so credentials stored under it would ` +
				`never be read — the provider ids are: ${PM_TYPES.join(', ')}`,
		});
		return;
	}

	const manifest = getPMProvider(providerId);
	if (!manifest) return;

	const declaredNames: readonly string[] = manifest.credentialRoles.map((spec) => spec.role);
	for (const role of Object.keys(roles)) {
		if (declaredNames.includes(role)) continue;
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['credentials', 'pm', providerId, role],
			message:
				`PM provider '${manifest.id}' declares no credential role '${role}' — ` +
				(declaredNames.length
					? `its roles are: ${declaredNames.join(', ')}`
					: 'it declares no credential roles'),
		});
	}
}

/** Rule 3 of {@link validatePmCredentialRoles} — presence, for `pm.type`'s block alone. */
function validateCurrentPmProviderRoles(
	providerId: PMType,
	configured: Record<string, string>,
	ctx: z.RefinementCtx,
): void {
	const manifest = getPMProvider(providerId);
	if (!manifest) return;

	for (const spec of manifest.credentialRoles) {
		if (spec.optional || spec.inheritsSharedCredential) continue;
		if (configured[spec.role]) continue;
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['credentials', 'pm', providerId, spec.role],
			message:
				`PM provider '${manifest.id}' requires the '${spec.role}' credential (${spec.label}): ` +
				`set credentials.pm.${providerId}.${spec.role} to the secret-store reference ` +
				`holding it (conventionally '${spec.envVarKey}', which is also the host env var it ` +
				'falls back to)',
		});
	}
}

/**
 * Validate `credentials.scm` against the registered SCM manifests (issue #628) — the
 * SCM twin of {@link validatePmCredentialRoles}, and, like it, the cross-field check
 * neither schema can make alone.
 *
 * It checks **structure only**, in two halves that are deliberately validated against
 * different things:
 *
 * 1. **Every key must be a known provider id** (`ScmProviderIdSchema` — the same closed
 *    enum `scm` itself uses), so a typo'd key is caught rather than silently holding
 *    credentials nothing will ever read. Checked against the *enum*, not the registry,
 *    for the reason the `scm` field's own doc gives: a config may be parsed by a surface
 *    that never loaded `src/integrations/entrypoint.js` (a dashboard bundle, a focused
 *    unit test), and validity must not depend on which modules a process imported.
 *    `requireProjectSCMProvider` (`src/integrations/scm/registry.ts`) stays the loud
 *    check for a provider that is unregistered or not runtime-ready.
 * 2. **Every role must be one the named provider declares**, which does need the
 *    manifest — so it is skipped for a provider that is not registered here, exactly as
 *    {@link validatePmCredentialRoles} is skipped for an unregistered `pm.type`.
 *
 * It deliberately does *not* require the provider named by `project.scm` to have its two
 * references, and that divergence from the PM check is the point: `project.scm` is
 * switchable from the dashboard's Source Control tab while `pm.type` is not, so
 * "provider selected, credentials not yet entered" is a state one click legitimately
 * creates. A parse-time presence error would leave that project readable at runtime (the
 * DB read path does not validate) yet rejected by `validateConfig` / `swarm config
 * apply`, with no way for the operator to avoid it. Presence is enforced instead by
 * `requireScmCredential` (`./provider.ts`), which fires when the credential is actually
 * needed and names the project, provider, role, and conventional env var key.
 */
function validateScmCredentialReferences(
	project: CredentialRefinementInput,
	ctx: z.RefinementCtx,
): void {
	const references = project.credentials.scm;
	if (!references) return;

	const manifests = listSCMProviders();

	for (const [providerId, roles] of Object.entries(references)) {
		if (!(SCM_TYPES as readonly string[]).includes(providerId)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['credentials', 'scm', providerId],
				message:
					`'${providerId}' is not an SCM provider id, so credentials stored under it would ` +
					`never be read — the provider ids are: ${SCM_TYPES.join(', ')}`,
			});
			continue;
		}

		const manifest = manifests.find((candidate) => candidate.id === providerId);
		if (!manifest) continue;

		const declaredNames: readonly string[] = (manifest.credentialRoles ?? []).map(
			(spec) => spec.role,
		);
		for (const role of Object.keys(roles)) {
			if (declaredNames.includes(role)) continue;
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['credentials', 'scm', providerId, role],
				message:
					`SCM provider '${manifest.id}' declares no credential role '${role}' — ` +
					(declaredNames.length
						? `its roles are: ${declaredNames.join(', ')}`
						: 'it declares no credential roles'),
			});
		}
	}
}

/**
 * A whole project config: {@link ProjectConfigBaseSchema}'s fields, the two legacy
 * credential adoptions, and the two cross-field credential checks. This is what
 * `validateConfig` and every config-parsing call site uses.
 *
 * The adoptions run **before** the refinements on purpose, so both checks — and every
 * later reader — see one shape: a pre-#628 config's bare `{ reviewer, webhookSecret }`
 * pair is adopted into `credentials.scm`, and a pre-#631 config's flat
 * `credentials.pm` role map into `credentials.pm[<pm.type>]`.
 *
 * The PM one is a `z.preprocess` — before *field* validation, not just before the
 * refinements — because the legacy and live shapes share the one `credentials.pm` key
 * (issue #631), unlike the SCM side's sibling keys: a flat map would otherwise be
 * rejected by `PmCredentialReferencesByProviderSchema` before anything could adopt it.
 */
export const ProjectConfigSchema = z
	.preprocess(adoptLegacyPmCredentials, ProjectConfigBaseSchema)
	.transform(adoptLegacyScmCredentials)
	.superRefine(validatePmCredentialRoles)
	.superRefine(validateScmCredentialReferences);

/**
 * A whole project **record** — {@link ProjectRecordBaseSchema}'s fields plus exactly
 * the same adoptions and cross-field checks {@link ProjectConfigSchema} applies,
 * since neither reads a repository. This is what `validateConfig` /
 * `swarm config apply` parse and what the `projects` table persists.
 */
export const ProjectRecordSchema = z
	.preprocess(adoptLegacyPmCredentials, ProjectRecordBaseSchema)
	.transform(adoptLegacyScmCredentials)
	.superRefine(validatePmCredentialRoles)
	.superRefine(validateScmCredentialReferences);

export const SwarmConfigSchema = z.object({
	projects: z.array(ProjectRecordSchema).min(1),
});

export type Credentials = z.infer<typeof CredentialsSchema>;
/** @deprecated Pre-#628 shared pair — see {@link ScmCredentialReferencesSchema}. */
export type ScmCredentialReferences = z.infer<typeof ScmCredentialReferencesSchema>;
export type {
	PmCredentialReferencesByProvider,
	PmProviderCredentialReferences,
} from './pm-credentials.js';
export type {
	ScmCredentialReferencesByProvider,
	ScmProviderCredentialReferences,
} from './scm-credentials.js';
// Re-exported so both credential maps' shapes are reachable from the one module every
// config consumer already imports, while the schemas themselves stay in their leaves.
export {
	PmCredentialReferencesByProviderSchema,
	PmProviderCredentialReferencesSchema,
	ScmCredentialReferencesByProviderSchema,
	ScmProviderCredentialReferencesSchema,
};
export type AgentTarget = z.infer<typeof AgentTargetSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
export type WorktreeRetentionConfig = z.infer<typeof WorktreeRetentionConfigSchema>;
export type ProjectPm = z.infer<typeof ProjectPmSchema>;

/**
 * The *config half* of a `pm` member — the union with its `type` discriminator
 * dropped, distributed per member so it stays a union rather than collapsing into
 * the members' shared keys. This is what the `projects.pm_config` jsonb column
 * holds: `pm` is persisted split into `pm_type` + this blob, so the table carries
 * one generic column per project instead of one column per provider
 * (`src/db/schema/projects.ts`).
 */
export type ProjectPmConfig = ProjectPm extends infer Member
	? Member extends { type: unknown }
		? Omit<Member, 'type'>
		: never
	: never;

/** One entry of a project's repository list (issue #684). */
export type ProjectRepository = z.infer<typeof ProjectRepositorySchema>;

/** The authored and persisted project — shared settings plus its repository list. */
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

/** A project scoped to one of its repositories — what every runtime call site takes. */
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;

/**
 * Parse and validate an untrusted config value. Throws `ZodError` on invalid
 * input — a malformed config is a deployment error, not a "not found" lookup,
 * so it throws rather than returning null (ai/CODING_STANDARDS.md "Error handling").
 */
export function validateConfig(config: unknown): SwarmConfig {
	return SwarmConfigSchema.parse(config);
}
