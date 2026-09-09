/**
 * Per-model capability metadata — the single source of truth for what
 * `AgentConfig.model` / `AgentConfig.reasoning` (`src/config/schema.ts`) accept,
 * and what the dashboard's per-phase Agent Configuration offers as choices
 * (the phase-6 dashboard backlog).
 *
 * Each logical model is described by a {@link ModelCapability}: a stable
 * configured id (what config stores), a user-facing label, the normalized
 * reasoning levels it supports, and — for `antigravity` — the exact `agy models`
 * variant string each reasoning level maps to. Reasoning is normalized to one
 * enum ({@link REASONING_LEVELS}, surfaced as "Reasoning" in the UI) but its
 * launch mapping stays per-CLI (`resolveModelLaunch`) — we never pretend the
 * CLIs share argument semantics or that a level means the same compute across
 * providers (issue #180).
 *
 * The three CLIs expose reasoning differently:
 *  - `claude`: a separate `--effort <low|medium|high|xhigh|max>` flag; the model
 *    is a short alias (`sonnet`, `opus`, …) that always resolves to the current
 *    model in that tier.
 *  - `codex`: a separate `model_reasoning_effort` config value passed as
 *    `-c model_reasoning_effort="<level>"`; models are short identifiers.
 *  - `antigravity` (agy 1.1.5+): the reasoning effort is part of the model
 *    *slug* `agy models` prints (`gemini-3.6-flash-high`) — the string `--model`
 *    pins reliably — so a logical model + reasoning maps back to that exact slug.
 *    agy also grew a separate `--effort low|medium|high` flag, but SWARM keeps
 *    driving it through the combined slug rather than the flag. Single-variant
 *    models (`claude-sonnet-4-6`, `gpt-oss-120b-medium`) expose no reasoning
 *    choice — their slug is fixed. Pre-1.1.5 agy printed parenthesized display
 *    strings (`"Gemini 3.6 Flash (High)"`) instead; those linger only as legacy
 *    config values (`LEGACY_ANTIGRAVITY_DISPLAY_STRINGS`), never a launch target.
 *
 * These are capability *inputs* observed on the current dev host, not a promise
 * that provider catalogs never change — hence the legacy back-compat sets
 * (§below) and `resolveModelLaunch`'s fail-visibly behavior. A provider that
 * *withdraws* a model is the same drift arriving from the other side, and it is
 * not cosmetic: `agy` rejects an unknown `--model` outright, so a config still
 * naming a retired model fails every launch before a turn runs. Retirements are
 * therefore recorded as data too ({@link RETIRED_ANTIGRAVITY_MODELS}), which is
 * what keeps those configs loading and re-points them at a model that exists.
 */

import { z } from 'zod';
import type { AgentCli } from './agent-cli.js';

/**
 * Normalized reasoning levels shown in the UI, ordered lightest → heaviest.
 * Claude's `--effort` enum verbatim; a superset the other CLIs draw a subset
 * from per-model. Not a claim that a level costs the same compute across CLIs.
 */
export const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** Zod enum for a normalized reasoning level — the boundary validator (issue #180). */
export const ReasoningLevelSchema = z.enum(REASONING_LEVELS);

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
	return typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * One logical model a phase/run can be configured to use.
 *
 * `id` is the stable value stored in config (`AgentConfig.model`) — a claude
 * alias, a codex short id, or a *logical* antigravity name (`gemini-3.6-flash`,
 * not the combined `"Gemini 3.6 Flash (High)"` display string). `label` is what
 * the dashboard's Model selector shows.
 *
 * `reasoningChoices` are the normalized levels the user may pick; an empty list
 * means the model exposes no reasoning choice (an antigravity single-variant
 * model, or any model whose CLI we don't drive with a level). `defaultReasoning`
 * is the level used when none is chosen and it is discoverable — `null` when the
 * CLI controls the default itself (claude) or none is reliably known.
 *
 * `variantByReasoning` / `fixedVariant` are antigravity-only: they carry the
 * exact `agy models` string each reasoning level maps to (`variantByReasoning`)
 * or the single fixed variant (`fixedVariant`). Absent for claude/codex, whose
 * `id` is passed to `--model` directly.
 */
export interface ModelCapability {
	cli: AgentCli;
	id: string;
	label: string;
	reasoningChoices: readonly ReasoningLevel[];
	defaultReasoning: ReasoningLevel | null;
	/** antigravity: normalized level → exact `agy models` variant string. */
	variantByReasoning?: Partial<Record<ReasoningLevel, string>>;
	/** antigravity single-variant models: the one exact `agy models` string. */
	fixedVariant?: string;
}

const CLAUDE_EFFORTS = REASONING_LEVELS;

/**
 * Per-model reasoning support is a **hand-maintained catalog**, not something the
 * CLIs expose a clean machine-readable list for. Update the `choices`/`default`
 * below when a provider's model lineup or its reasoning knobs change. A model
 * with an empty `choices` list exposes **no reasoning control** — the config
 * schema rejects a reasoning level for it and the dashboard shows the selector
 * disabled ("Fixed"), the same as an antigravity single-variant model.
 *
 * Sources (verified 2026-07, links in PR): Claude effort matrix
 * (platform.claude.com/docs/build-with-claude/effort — effort supported by
 * Fable 5 / Opus 4.8 / Sonnet 5, default `high`; **Haiku 4.5 does NOT support
 * the effort parameter** — it only does budget-based thinking, which SWARM's
 * `--effort` harness can't drive, so it is non-reasoning here); Codex effort
 * levels (OpenAI GPT-5.6 Sol/Terra/Luna expose none→max; GPT-5.5/5.4 up to
 * xhigh; GPT-5.4 mini caps at high).
 */

/** `claude --model <alias> --effort <level>`. Effort defaults to `high` where supported. */
const CLAUDE_CAPABILITIES: readonly ModelCapability[] = [
	{ id: 'fable', label: 'Fable', choices: CLAUDE_EFFORTS, default: 'high' as const },
	{ id: 'opus', label: 'Opus', choices: CLAUDE_EFFORTS, default: 'high' as const },
	{ id: 'sonnet', label: 'Sonnet', choices: CLAUDE_EFFORTS, default: 'high' as const },
	// Haiku 4.5 has no `--effort` control (budget-based thinking only) → no reasoning.
	{ id: 'haiku', label: 'Haiku', choices: [], default: null },
].map(({ id, label, choices, default: def }) => ({
	cli: 'claude' as const,
	id,
	label,
	reasoningChoices: choices as readonly ReasoningLevel[],
	defaultReasoning: def,
}));

/**
 * `codex --model <id> -c model_reasoning_effort="<level>"`. Codex defaults to
 * `medium`; supported sets are model-specific (the GPT-5.6 family exposes the
 * widest range up to `max`, GPT-5.5/5.4 up to `xhigh`, mini caps at `high`).
 */
const CODEX_CAPABILITIES: readonly ModelCapability[] = [
	{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', choices: REASONING_LEVELS },
	{ id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', choices: REASONING_LEVELS },
	{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', choices: REASONING_LEVELS },
	{ id: 'gpt-5.5', label: 'GPT-5.5', choices: ['low', 'medium', 'high', 'xhigh'] },
	{ id: 'gpt-5.4', label: 'GPT-5.4', choices: ['low', 'medium', 'high', 'xhigh'] },
	{ id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', choices: ['low', 'medium', 'high'] },
].map(({ id, label, choices }) => ({
	cli: 'codex' as const,
	id,
	label,
	reasoningChoices: choices as readonly ReasoningLevel[],
	defaultReasoning: 'medium' as const,
}));

/**
 * A Gemini Flash tier, which every version of it exposes identically: low /
 * medium / high, each folding back into the `gemini-<version>-flash-<level>`
 * slug `agy models` prints. Spelled once rather than per version so adding the
 * next Flash release can't accidentally state a different tier set for it.
 */
function geminiFlashTier(version: string): ModelCapability {
	return {
		cli: 'antigravity',
		id: `gemini-${version}-flash`,
		label: `Gemini ${version} Flash`,
		reasoningChoices: ['low', 'medium', 'high'],
		defaultReasoning: 'medium',
		variantByReasoning: {
			low: `gemini-${version}-flash-low`,
			medium: `gemini-${version}-flash-medium`,
			high: `gemini-${version}-flash-high`,
		},
	};
}

/**
 * `agy --model <slug>`. The logical model + reasoning re-combine into the exact
 * `agy models` slug (`gemini-3.6-flash-high`). Flash/Pro expose reasoning tiers;
 * the Claude/GPT-OSS entries are single fixed slugs (no reasoning choice).
 *
 * Listed in the order `agy models` prints them (newest Flash first), which is
 * also the order the dashboard's Model selector offers. Verified against agy
 * 1.1.28; Gemini 3.5 Flash was withdrawn by that release and lives on only in
 * {@link RETIRED_ANTIGRAVITY_MODELS} (issue #892).
 */
const ANTIGRAVITY_CAPABILITIES: readonly ModelCapability[] = [
	geminiFlashTier('3.8'),
	geminiFlashTier('3.7'),
	geminiFlashTier('3.6'),
	{
		cli: 'antigravity',
		id: 'gemini-3.1-pro',
		label: 'Gemini 3.1 Pro',
		reasoningChoices: ['low', 'high'],
		// Pro exposes no medium tier; default to high (the heavier tier) so an
		// un-reasoned Pro selection still launches a real, documented variant.
		defaultReasoning: 'high',
		variantByReasoning: {
			low: 'gemini-3.1-pro-low',
			high: 'gemini-3.1-pro-high',
		},
	},
	{
		cli: 'antigravity',
		id: 'claude-sonnet-4.6',
		label: 'Claude Sonnet 4.6',
		reasoningChoices: [],
		defaultReasoning: null,
		fixedVariant: 'claude-sonnet-4-6',
	},
	{
		cli: 'antigravity',
		id: 'claude-opus-4.6',
		label: 'Claude Opus 4.6',
		reasoningChoices: [],
		defaultReasoning: null,
		fixedVariant: 'claude-opus-4-6-thinking',
	},
	{
		cli: 'antigravity',
		id: 'gpt-oss-120b',
		label: 'GPT-OSS 120B',
		reasoningChoices: [],
		defaultReasoning: null,
		fixedVariant: 'gpt-oss-120b-medium',
	},
];

/** Every logical model, keyed by CLI. The catalog the whole app reads. */
export const MODEL_CAPABILITIES: Readonly<Record<AgentCli, readonly ModelCapability[]>> = {
	claude: CLAUDE_CAPABILITIES,
	antigravity: ANTIGRAVITY_CAPABILITIES,
	codex: CODEX_CAPABILITIES,
};

/** `claude --model <alias>` — always resolves to the current model in that tier. */
export const CLAUDE_MODELS = CLAUDE_CAPABILITIES.map((m) => m.id);
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

/** `agy --model "<name>"` — the *logical* model ids (reasoning is chosen separately). */
export const ANTIGRAVITY_MODELS = ANTIGRAVITY_CAPABILITIES.map((m) => m.id);
export type AntigravityModel = (typeof ANTIGRAVITY_MODELS)[number];

/** `codex --model <name>` — short identifiers from the Codex models list. */
export const CODEX_MODELS = CODEX_CAPABILITIES.map((m) => m.id);
export type CodexModel = (typeof CODEX_MODELS)[number];

/** Per-CLI known logical-model ids, keyed the same way `DEFAULT_COMMAND` is. */
export const AGENT_MODELS: Readonly<Record<AgentCli, readonly string[]>> = {
	claude: CLAUDE_MODELS,
	antigravity: ANTIGRAVITY_MODELS,
	codex: CODEX_MODELS,
};

/** Every known logical model across all CLIs — used when a config doesn't pin `cli`. */
export const ALL_AGENT_MODELS: readonly string[] = [
	...CLAUDE_MODELS,
	...ANTIGRAVITY_MODELS,
	...CODEX_MODELS,
];

/**
 * Coded default logical model per agent CLI when no configuration overrides it.
 *
 * Antigravity's is the same model a retired selection migrates onto
 * ({@link RETIRED_ANTIGRAVITY_MODELS}) rather than the newest Flash tier: it is
 * the Flash release SWARM has actually run whole phases on, and the default is
 * what every unconfigured phase inherits, so it moves on evidence from real runs
 * rather than on a model's arrival in `agy models` (issue #892). 3.7/3.8 Flash
 * are selectable per phase from the day they are listed.
 */
export const DEFAULT_MODEL_PER_CLI: Record<AgentCli, string> = {
	claude: 'sonnet',
	antigravity: 'gemini-3.6-flash',
	codex: 'gpt-5.6-terra',
};

/**
 * Every combined `agy models` slug SWARM can launch (`gemini-3.6-flash-high`,
 * `claude-sonnet-4-6`, …) — the exact strings agy 1.1.5+ accepts on `--model`.
 * Derived from the capabilities so it can't drift from what `resolveModelLaunch`
 * emits; `splitAntigravityModel` decomposes any of them back into logical model
 * + reasoning. A retired model's slugs are therefore absent by construction —
 * they are recognized on the way *in* ({@link RETIRED_ANTIGRAVITY_MODELS}) but
 * are never a launch target.
 */
export const ANTIGRAVITY_MODEL_SLUGS: readonly string[] = ANTIGRAVITY_CAPABILITIES.flatMap((m) =>
	m.fixedVariant ? [m.fixedVariant] : Object.values(m.variantByReasoning ?? {}),
);

/**
 * Retired pre-1.1.5 agy display strings (`"Gemini 3.5 Flash (High)"`) that
 * pre-#180 SWARM configs stored in `AgentConfig.model` before reasoning became a
 * separate field. agy's model list no longer contains them, so they are never a
 * launch target — but the config schema still accepts them and
 * `splitAntigravityModel` migrates them losslessly to logical model + reasoning
 * (which then launches today's slug), so those configs keep working (issue #180,
 * #409). A string naming a model the provider has since retired keeps its entry
 * here and picks up the replacement on the second hop — the two sets compose
 * rather than each restating the other's mapping.
 */
export const LEGACY_ANTIGRAVITY_DISPLAY_STRINGS: Readonly<
	Record<string, { model: string; reasoning?: ReasoningLevel }>
> = {
	'Gemini 3.5 Flash (Low)': { model: 'gemini-3.5-flash', reasoning: 'low' },
	'Gemini 3.5 Flash (Medium)': { model: 'gemini-3.5-flash', reasoning: 'medium' },
	'Gemini 3.5 Flash (High)': { model: 'gemini-3.5-flash', reasoning: 'high' },
	'Gemini 3.6 Flash (Low)': { model: 'gemini-3.6-flash', reasoning: 'low' },
	'Gemini 3.6 Flash (Medium)': { model: 'gemini-3.6-flash', reasoning: 'medium' },
	'Gemini 3.6 Flash (High)': { model: 'gemini-3.6-flash', reasoning: 'high' },
	'Gemini 3.1 Pro (Low)': { model: 'gemini-3.1-pro', reasoning: 'low' },
	'Gemini 3.1 Pro (High)': { model: 'gemini-3.1-pro', reasoning: 'high' },
	'Claude Sonnet 4.6 (Thinking)': { model: 'claude-sonnet-4.6' },
	'Claude Opus 4.6 (Thinking)': { model: 'claude-opus-4.6' },
	'GPT-OSS 120B (Medium)': { model: 'gpt-oss-120b' },
};

/**
 * A stored antigravity model value resolved to a *live* logical selection.
 * `retiredFrom` names the retired model the value came from, when it named one —
 * present so a caller can report the substitution instead of silently running a
 * different model.
 */
export interface AntigravitySelection {
	model: string;
	reasoning?: ReasoningLevel;
	retiredFrom?: string;
}

/**
 * One antigravity model the *provider* has withdrawn, plus the live model a
 * stored selection naming it migrates onto.
 *
 * `id` is the logical id configs stored, `variantByReasoning`/`fixedVariant` the
 * combined slugs it used to launch — kept so a config that stored the combined
 * string rather than the logical id migrates the same way.
 */
export interface RetiredAntigravityModel {
	id: string;
	/** The live logical model this selection resolves to instead. */
	replacedBy: string;
	/** The retired model's own `agy` slugs, by the reasoning level each carried. */
	variantByReasoning?: Partial<Record<ReasoningLevel, string>>;
	/** A retired single-variant model's one slug. */
	fixedVariant?: string;
}

/**
 * Antigravity models `agy models` no longer lists — the *third* back-compat set,
 * and the one with teeth. The two above are strings agy stopped *printing* while
 * still accepting the model behind them; these name models agy stopped serving,
 * and print mode rejects an unknown `--model` outright (`invalid model
 * selection`, `status: ERROR`, zero turns), so a config still naming one fails
 * every launch before a turn runs (issue #892 — SWARM's own coded default was
 * `gemini-3.5-flash` when agy 1.1.28 withdrew it).
 *
 * Deleting the entry instead was not an option: `isKnownModel`
 * (`src/config/schema.ts`) rejects a model outside the catalog, so a project,
 * phase, or global default still storing the retired id would stop the whole
 * stored config from parsing. Recording the retirement keeps those configs
 * loading *and* lands them on a model that exists — `splitAntigravityModel`
 * migrates the value everywhere it is read (config parse, the dashboard's
 * selectors, `resolveModelLaunch`), and the launch reports the substitution
 * rather than quietly running a different model ({@link ModelLaunch.retiredModel}).
 *
 * Pick `replacedBy` as the nearest surviving model, so the reasoning level a
 * config already stores survives the hop: 3.5 Flash and 3.6 Flash expose the
 * same low/medium/high tiers. `tests/unit/harness/models.test.ts` holds that
 * requirement as a catalog invariant, so a future retirement can't be pointed at
 * a model with narrower tiers and reintroduce a failing launch.
 */
export const RETIRED_ANTIGRAVITY_MODELS: readonly RetiredAntigravityModel[] = [
	{
		id: 'gemini-3.5-flash',
		replacedBy: 'gemini-3.6-flash',
		variantByReasoning: {
			low: 'gemini-3.5-flash-low',
			medium: 'gemini-3.5-flash-medium',
			high: 'gemini-3.5-flash-high',
		},
	},
];

/**
 * The live selection a retired antigravity value migrates to — matching either a
 * retired logical id (`gemini-3.5-flash`) or one of that model's retired slugs
 * (`gemini-3.5-flash-high`, whose reasoning level carries over). `null` when the
 * value names nothing retired, which is every current model and every unknown
 * string.
 */
export function migrateRetiredAntigravityModel(model: string): AntigravitySelection | null {
	for (const retired of RETIRED_ANTIGRAVITY_MODELS) {
		if (retired.id === model || retired.fixedVariant === model) {
			return { model: retired.replacedBy, retiredFrom: retired.id };
		}
		for (const [level, variant] of Object.entries(retired.variantByReasoning ?? {})) {
			if (variant !== model) continue;
			return {
				model: retired.replacedBy,
				reasoning: level as ReasoningLevel,
				retiredFrom: retired.id,
			};
		}
	}
	return null;
}

/**
 * Whether a stored model value can *only* be an antigravity selection — a live
 * logical id (`gemini-3.6-flash`), one of today's combined slugs
 * (`gemini-3.6-flash-high`), a pre-1.1.5 display string, or a model the provider
 * has retired. The three CLI catalogs share no id, so a value this recognizes
 * names no claude or codex model.
 *
 * That disjointness is what lets a stored target which omits `cli` be pinned to
 * antigravity instead of falling through to the phase's coded default CLI (which
 * is `claude` for every phase): the config schema accepts such a value on a
 * `cli`-less target (`isKnownModel`, `src/config/schema.ts`), and without the pin
 * it would reach `claude --model gemini-3.6-flash` — a launch that can never
 * succeed, and, for a retired value, one that dispatches the withdrawn string the
 * retirement exists to keep out of a launch (issue #892).
 */
export function isAntigravityModelValue(model: string): boolean {
	return (
		(ANTIGRAVITY_MODELS as readonly string[]).includes(model) ||
		(ANTIGRAVITY_MODEL_SLUGS as readonly string[]).includes(model) ||
		// `Object.hasOwn` rather than a bare lookup for the same reason
		// `splitAntigravityModel` uses it: an inherited `Object.prototype` name in a
		// config value must not masquerade as a known display string.
		Object.hasOwn(LEGACY_ANTIGRAVITY_DISPLAY_STRINGS, model) ||
		migrateRetiredAntigravityModel(model) !== null
	);
}

/** Look up a logical model's capability, or `undefined` if unknown for that CLI. */
export function capabilityFor(cli: AgentCli, model: string): ModelCapability | undefined {
	return MODEL_CAPABILITIES[cli]?.find((m) => m.id === model);
}

/** The normalized reasoning levels a (cli, model) supports — empty if none/unknown. */
export function reasoningChoicesFor(cli: AgentCli, model: string): readonly ReasoningLevel[] {
	return capabilityFor(cli, model)?.reasoningChoices ?? [];
}

/**
 * Resolve a stored antigravity model value that isn't already a live logical id
 * into the `{ model, reasoning? }` selection it means. Recognizes today's
 * `agy models` slug (`gemini-3.6-flash-high`), the retired pre-1.1.5 display
 * string (`"Gemini 3.6 Flash (High)"`) a legacy config may still carry, and a
 * retired model's id or slugs — which resolve to that model's live replacement
 * (`RETIRED_ANTIGRAVITY_MODELS`), tagged with `retiredFrom`. Returns `null` when
 * the value is none of those — a current logical id, or a string we don't know —
 * so callers keep treating it as an already-logical id.
 *
 * Every reader of a stored antigravity model goes through here (the config
 * schema's parse-time migration, the dashboard's selectors, `resolveModelLaunch`)
 * precisely so no call site can forget one of these hops.
 */
export function splitAntigravityModel(model: string): AntigravitySelection | null {
	for (const cap of ANTIGRAVITY_CAPABILITIES) {
		if (cap.fixedVariant === model) return { model: cap.id };
		for (const [level, variant] of Object.entries(cap.variantByReasoning ?? {})) {
			if (variant === model) return { model: cap.id, reasoning: level as ReasoningLevel };
		}
	}
	// `Object.hasOwn` (not `model in …` / a bare lookup) so an inherited
	// `Object.prototype` name (`"toString"`, `"constructor"`, …) in a config value
	// can't masquerade as a known display string.
	const legacy = Object.hasOwn(LEGACY_ANTIGRAVITY_DISPLAY_STRINGS, model)
		? LEGACY_ANTIGRAVITY_DISPLAY_STRINGS[model]
		: undefined;
	// A display string can name a model that has since been retired ("Gemini 3.5
	// Flash (High)"), so the two hops compose: decompose first, then migrate the
	// logical id it decomposed to, keeping the level the string carried.
	if (legacy) {
		const retired = migrateRetiredAntigravityModel(legacy.model);
		return retired
			? { ...retired, reasoning: legacy.reasoning ?? retired.reasoning }
			: { ...legacy };
	}
	return migrateRetiredAntigravityModel(model);
}

/**
 * Normalize a stored `(cli, model)` selection into `{ model: logicalId, reasoning? }`.
 * For antigravity this decomposes a legacy combined string and re-points a retired
 * model at its live replacement; for every other case the model passes through
 * unchanged and no reasoning is inferred. Used by the config schema and the
 * dashboard so old blobs and new selections share one shape.
 */
export function normalizeModelSelection(
	cli: AgentCli | undefined,
	model: string,
): AntigravitySelection {
	if (cli === 'antigravity') {
		const split = splitAntigravityModel(model);
		if (split) return split;
	}
	return { model };
}

/** The concrete launch parameters for a (cli, model, reasoning) selection. */
export interface ModelLaunch {
	/** Value passed to `--model`. */
	model: string;
	/** Extra provider args (`--effort …`, `-c model_reasoning_effort=…`), possibly empty. */
	providerArgs: string[];
	/**
	 * The retired antigravity model the requested selection named, when it named
	 * one — this launch runs its replacement instead
	 * (`RETIRED_ANTIGRAVITY_MODELS`). Set so the harness logs the substitution:
	 * a config left on a withdrawn model is a configuration problem the operator
	 * has to fix, not something to bury.
	 */
	retiredModel?: string;
}

/**
 * The antigravity half of {@link resolveModelLaunch} — reasoning is encoded in
 * the model slug, never a flag, so the whole resolution is a single `--model`
 * value. Kept a separate function because it is the only per-CLI branch with
 * real logic (three back-compat hops plus the tier lookup), and inlining it puts
 * `resolveModelLaunch` over the cognitive-complexity budget.
 */
function resolveAntigravityLaunch(
	model: string,
	reasoning: ReasoningLevel | undefined,
): ModelLaunch {
	// If `model` is itself a combined string (today's slug or a legacy display
	// string), decompose it so a retired display string re-resolves to the current
	// slug; an explicit combined string wins over a separately-passed reasoning
	// level. A retired model resolves to its replacement here too, and the
	// substitution travels with the launch as `retiredModel`.
	const stored = splitAntigravityModel(model);
	const logicalId = stored?.model ?? model;
	const level = stored?.reasoning ?? reasoning;
	const retired = stored?.retiredFrom ? { retiredModel: stored.retiredFrom } : {};
	const cap = capabilityFor('antigravity', logicalId);
	if (!cap) return { model, providerArgs: [] };
	if (cap.fixedVariant) return { model: cap.fixedVariant, providerArgs: [], ...retired };
	const chosen = level ?? cap.defaultReasoning ?? undefined;
	const slug = chosen ? cap.variantByReasoning?.[chosen] : undefined;
	if (!slug) {
		throw new Error(
			`antigravity model '${logicalId}' has no variant for reasoning '${chosen ?? 'default'}'`,
		);
	}
	return { model: slug, providerArgs: [], ...retired };
}

/**
 * Resolve how a `(cli, model, reasoning)` selection launches — the per-CLI
 * boundary where the normalized reasoning level becomes provider-specific argv.
 *
 * - claude → `{ model, providerArgs: reasoning ? ['--effort', level] : [] }`
 * - codex  → `{ model, providerArgs: reasoning ? ['-c', 'model_reasoning_effort="level"'] : [] }`
 * - antigravity → the combined `agy models` slug in `model`, no provider args.
 *   A combined string already in `model` — today's slug, or a retired pre-1.1.5
 *   display string a legacy config carries — is decomposed and re-resolved to the
 *   current slug, so we never send agy a name its model list no longer contains.
 *   A selection naming a model the *provider* has retired resolves to that
 *   model's live replacement and reports it as `retiredModel`, for the same
 *   reason: agy rejects a withdrawn slug outright. Otherwise the logical id +
 *   reasoning (or the model's default / fixed variant) re-combine; an unknown
 *   logical id falls through to `model` verbatim so `agy` itself fails visibly
 *   rather than us silently substituting.
 *
 * Throws only when an antigravity logical model is known but the requested
 * reasoning maps to no real variant — failing visibly per issue #180 rather
 * than launching a different model.
 */
export function resolveModelLaunch(
	cli: AgentCli,
	model: string | undefined,
	reasoning: ReasoningLevel | undefined,
): ModelLaunch {
	if (!model) return { model: '', providerArgs: [] };

	if (cli === 'claude') {
		return { model, providerArgs: reasoning ? ['--effort', reasoning] : [] };
	}
	if (cli === 'codex') {
		return {
			model,
			providerArgs: reasoning ? ['-c', `model_reasoning_effort="${reasoning}"`] : [],
		};
	}
	return resolveAntigravityLaunch(model, reasoning);
}
