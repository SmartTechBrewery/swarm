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
import { CUSTOM_PROMPT_MAX_LENGTH, normalizeCustomPrompt } from './custom-prompt.js';

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
 * References to a project's *project-scoped* GitHub credentials — the reviewer
 * persona token plus the webhook-verification secret.
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
 */
export const CredentialsSchema = z
	.object({
		/** Reference to the reviewer-persona GitHub token in the secret store. */
		reviewer: z.string().min(1),
		/** Reference to the GitHub webhook HMAC secret used to verify inbound events. */
		webhookSecret: z.string().min(1),
	})
	.describe('References to a project GitHub credentials (never the secrets themselves)');

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
 * (`decideCheckSuiteOutcome`, `src/triggers/handlers/check-suite-decision.ts`).
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

export const ProjectConfigSchema = z.object({
	/** Stable internal identifier for this SWARM project (one Postgres row per project). */
	id: z.string().min(1),

	/** Human-facing name — also the `{project-name}` in the worktree paths (PROJECT.md §4.1). */
	name: z.string().min(1),

	/** The GitHub repository this project operates on, as `owner/repo`. */
	repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be in format "owner/repo"'),

	/**
	 * Absolute path to the main repository checkout on the developer's machine
	 * (the "human workspace", `~/swarm/{project-name}/` in PROJECT.md §4.1). Task
	 * worktrees are created relative to this path.
	 */
	repoRoot: z.string().min(1),

	/**
	 * Directory under `repoRoot` where per-task git worktrees live
	 * (ai/ARCHITECTURE.md "Worktree lifecycle"). Relative, not absolute, so it
	 * travels with `repoRoot`.
	 */
	worktreeRoot: z.string().min(1).default(PROJECT_DEFAULTS.worktreeRoot),

	/** Branch task worktrees are cut from and PRs target. */
	baseBranch: z.string().min(1).default(PROJECT_DEFAULTS.baseBranch),

	/** Prefix for task branch names — SWARM's convention is `issue-<n>-<slug>`. */
	branchPrefix: z.string().default(PROJECT_DEFAULTS.branchPrefix),

	/** Maximum number of jobs this project may run concurrently. */
	maxConcurrentJobs: z.number().int().positive().default(PROJECT_DEFAULTS.maxConcurrentJobs),

	/** Discovery / open-join policy (`ProjectVisibilitySchema`); `private` by default. */
	visibility: ProjectVisibilitySchema.default('private'),

	/**
	 * PM provider discriminator. SWARM has exactly one provider for the MVP;
	 * the object shape (rather than a bare field) mirrors Cascade so a second
	 * provider could be added later without reshaping the config.
	 */
	pm: z
		.object({
			type: z.literal('github-projects').default('github-projects'),
		})
		.default({ type: 'github-projects' }),

	/** The GitHub Projects board mapping — composed from the provider's own schema. */
	githubProjects: githubProjectsConfigSchema,

	/** References to the project's GitHub credentials (see `CredentialsSchema`). */
	credentials: CredentialsSchema,

	/** Per-phase agent CLI/model overrides. Omit entirely to keep every phase's coded default. */
	agents: AgentsConfigSchema.optional(),

	/** Per-phase autonomous board-move control. Omit entirely to keep the coded defaults. */
	pipeline: PipelineConfigSchema.optional(),

	/** Per-project worktree retention policy (`WorktreeRetentionConfig`) — nullable: most projects omit it and use the coded default. */
	worktreeRetention: WorktreeRetentionConfigSchema.optional(),
});

export const SwarmConfigSchema = z.object({
	projects: z.array(ProjectConfigSchema).min(1),
});

export type Credentials = z.infer<typeof CredentialsSchema>;
export type AgentTarget = z.infer<typeof AgentTargetSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
export type WorktreeRetentionConfig = z.infer<typeof WorktreeRetentionConfigSchema>;
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
