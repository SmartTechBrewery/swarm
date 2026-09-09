import { describe, expect, it } from 'vitest';
import {
	AGENT_MODELS,
	ALL_AGENT_MODELS,
	ANTIGRAVITY_MODEL_SLUGS,
	ANTIGRAVITY_MODELS,
	CLAUDE_MODELS,
	CODEX_MODELS,
	capabilityFor,
	DEFAULT_MODEL_PER_CLI,
	isAntigravityModelValue,
	LEGACY_ANTIGRAVITY_DISPLAY_STRINGS,
	migrateRetiredAntigravityModel,
	migrateRetiredCodexModel,
	normalizeModelSelection,
	pinnedCliForModel,
	REASONING_LEVELS,
	RETIRED_ANTIGRAVITY_MODELS,
	RETIRED_CODEX_MODELS,
	reasoningChoicesFor,
	resolveModelLaunch,
	splitAntigravityModel,
} from '@/harness/models.js';

describe('AGENT_MODELS', () => {
	it('keys exactly the three known CLIs', () => {
		expect(Object.keys(AGENT_MODELS).sort()).toEqual(['antigravity', 'claude', 'codex']);
	});

	it('maps each CLI to its own model list', () => {
		expect(AGENT_MODELS.claude).toBe(CLAUDE_MODELS);
		expect(AGENT_MODELS.antigravity).toBe(ANTIGRAVITY_MODELS);
		expect(AGENT_MODELS.codex).toBe(CODEX_MODELS);
	});

	it('has no overlap between any two lists (each model name is unambiguous per-cli)', () => {
		const all = [CLAUDE_MODELS, ANTIGRAVITY_MODELS, CODEX_MODELS] as const;
		for (let i = 0; i < all.length; i++) {
			for (let j = i + 1; j < all.length; j++) {
				const overlap = (all[i] as readonly string[]).filter((m) =>
					(all[j] as readonly string[]).includes(m),
				);
				expect(overlap).toEqual([]);
			}
		}
	});
});

describe('ALL_AGENT_MODELS', () => {
	it('is the union of all per-cli lists', () => {
		expect(ALL_AGENT_MODELS).toEqual([...CLAUDE_MODELS, ...ANTIGRAVITY_MODELS, ...CODEX_MODELS]);
	});
});

describe('REASONING_LEVELS', () => {
	it('is the union across CLIs, with ultra above max', () => {
		expect(REASONING_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
	});

	it('offers ultra only on the codex models that accept it (issue #893)', () => {
		// `ultra` is a codex level; claude's `--effort` has no such value, so a claude
		// model offering it would launch a flag value the CLI rejects. The two codex
		// entries below cap lower than their siblings and must not gain it either.
		for (const model of CLAUDE_MODELS) {
			expect(reasoningChoicesFor('claude', model), model).not.toContain('ultra');
		}
		for (const model of ANTIGRAVITY_MODELS) {
			expect(reasoningChoicesFor('antigravity', model), model).not.toContain('ultra');
		}
		const withUltra = CODEX_MODELS.filter((model) =>
			reasoningChoicesFor('codex', model).includes('ultra'),
		);
		expect(withUltra).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra']);
	});
});

describe('reasoningChoicesFor', () => {
	it('exposes claude effort levels for effort-capable models', () => {
		expect(reasoningChoicesFor('claude', 'sonnet')).toEqual([
			'low',
			'medium',
			'high',
			'xhigh',
			'max',
		]);
	});

	it('exposes each codex model’s own range and default (issue #893)', () => {
		// Verified against codex-cli 0.153.4's embedded catalog. Both halves are
		// per-model: SWARM used to hardcode `medium` for every entry, running Astra
		// and Sol heavier than the CLI itself would.
		const expected = {
			'gpt-6-astra': { choices: REASONING_LEVELS, default: 'low' },
			'gpt-5.6-sol': { choices: REASONING_LEVELS, default: 'low' },
			'gpt-5.6-terra': { choices: REASONING_LEVELS, default: 'medium' },
			'gpt-5.6-luna': { choices: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' },
			'gpt-5.5': { choices: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
		} as const;
		// The catalog offers exactly these ids, so a retirement or an addition that
		// forgets this table fails here rather than in a 400 at launch.
		expect(CODEX_MODELS).toEqual(Object.keys(expected));
		for (const [model, { choices, default: def }] of Object.entries(expected)) {
			expect(reasoningChoicesFor('codex', model), model).toEqual(choices);
			expect(capabilityFor('codex', model)?.defaultReasoning, model).toBe(def);
		}
	});

	it('exposes no reasoning for Haiku (no --effort support)', () => {
		expect(reasoningChoicesFor('claude', 'haiku')).toEqual([]);
		expect(capabilityFor('claude', 'haiku')?.defaultReasoning).toBeNull();
	});

	it('exposes the per-model antigravity tiers, empty for single-variant models', () => {
		for (const flash of ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']) {
			expect(reasoningChoicesFor('antigravity', flash)).toEqual(['low', 'medium', 'high']);
		}
		expect(reasoningChoicesFor('antigravity', 'gemini-3.1-pro')).toEqual(['low', 'high']);
		expect(reasoningChoicesFor('antigravity', 'claude-sonnet-4.6')).toEqual([]);
		expect(reasoningChoicesFor('antigravity', 'gpt-oss-120b')).toEqual([]);
	});

	it('returns an empty list for an unknown model', () => {
		expect(reasoningChoicesFor('claude', 'nonsense')).toEqual([]);
	});
});

describe('resolveModelLaunch', () => {
	it('maps claude reasoning to a separate --effort flag', () => {
		expect(resolveModelLaunch('claude', 'sonnet', 'high')).toEqual({
			model: 'sonnet',
			providerArgs: ['--effort', 'high'],
		});
	});

	it('omits the claude effort flag when no reasoning is set', () => {
		expect(resolveModelLaunch('claude', 'sonnet', undefined)).toEqual({
			model: 'sonnet',
			providerArgs: [],
		});
	});

	it('maps codex reasoning to a -c model_reasoning_effort config override', () => {
		expect(resolveModelLaunch('codex', 'gpt-5.6-terra', 'xhigh')).toEqual({
			model: 'gpt-5.6-terra',
			providerArgs: ['-c', 'model_reasoning_effort="xhigh"'],
		});
	});

	it('carries ultra through to codex as its own effort value (issue #893)', () => {
		// The level codex accepts above `max`, and the reason `REASONING_LEVELS` is no
		// longer claude's enum. It must reach the CLI verbatim, not clamp to `max`.
		expect(resolveModelLaunch('codex', 'gpt-6-astra', 'ultra')).toEqual({
			model: 'gpt-6-astra',
			providerArgs: ['-c', 'model_reasoning_effort="ultra"'],
		});
	});

	it('folds antigravity reasoning into the combined --model slug, no flag', () => {
		expect(resolveModelLaunch('antigravity', 'gemini-3.8-flash', 'high')).toEqual({
			model: 'gemini-3.8-flash-high',
			providerArgs: [],
		});
	});

	it('folds each live Flash tier’s reasoning into its exact agy --model slug', () => {
		// 3.7 and 3.8 Flash are the tiers agy 1.1.28 added (issue #892); 3.6 is the
		// one that was already here, re-checked against the same `agy models`.
		for (const version of ['3.8', '3.7', '3.6']) {
			expect(resolveModelLaunch('antigravity', `gemini-${version}-flash`, 'low').model).toBe(
				`gemini-${version}-flash-low`,
			);
			expect(resolveModelLaunch('antigravity', `gemini-${version}-flash`, 'high').model).toBe(
				`gemini-${version}-flash-high`,
			);
		}
	});

	it('falls back to the antigravity model default slug when reasoning is omitted', () => {
		expect(resolveModelLaunch('antigravity', 'gemini-3.6-flash', undefined).model).toBe(
			'gemini-3.6-flash-medium',
		);
	});

	it('uses the fixed slug for a single-variant antigravity model', () => {
		expect(resolveModelLaunch('antigravity', 'claude-sonnet-4.6', undefined).model).toBe(
			'claude-sonnet-4-6',
		);
	});

	it('re-emits a slug already in model verbatim', () => {
		expect(resolveModelLaunch('antigravity', 'gemini-3.6-flash-high', undefined)).toEqual({
			model: 'gemini-3.6-flash-high',
			providerArgs: [],
		});
	});

	it('translates a retired display string to today’s slug (back-compat)', () => {
		expect(resolveModelLaunch('antigravity', 'Gemini 3.1 Pro (High)', undefined)).toEqual({
			model: 'gemini-3.1-pro-high',
			providerArgs: [],
		});
	});

	it('fails visibly when an antigravity model has no variant for the requested reasoning', () => {
		// Gemini 3.1 Pro exposes only low/high — medium maps to no real variant.
		expect(() => resolveModelLaunch('antigravity', 'gemini-3.1-pro', 'medium')).toThrow(/variant/);
	});
});

describe('splitAntigravityModel / normalizeModelSelection', () => {
	it('decomposes both slugs and retired display strings into a logical id + reasoning', () => {
		expect(splitAntigravityModel('gemini-3.6-flash-high')).toEqual({
			model: 'gemini-3.6-flash',
			reasoning: 'high',
		});
		expect(splitAntigravityModel('claude-opus-4-6-thinking')).toEqual({
			model: 'claude-opus-4.6',
		});
		expect(splitAntigravityModel('Gemini 3.6 Flash (Low)')).toEqual({
			model: 'gemini-3.6-flash',
			reasoning: 'low',
		});
		expect(splitAntigravityModel('Claude Opus 4.6 (Thinking)')).toEqual({
			model: 'claude-opus-4.6',
		});
		// A live logical id is already the shape callers want — nothing to resolve.
		expect(splitAntigravityModel('gemini-3.6-flash')).toBeNull();
	});

	it('does not treat an Object.prototype name as a recognized display string', () => {
		for (const proto of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf']) {
			expect(splitAntigravityModel(proto)).toBeNull();
		}
	});

	it('round-trips every slug back to the same launch slug', () => {
		for (const slug of ANTIGRAVITY_MODEL_SLUGS) {
			const split = splitAntigravityModel(slug);
			expect(split).not.toBeNull();
			const launched = resolveModelLaunch('antigravity', split?.model as string, split?.reasoning);
			expect(launched.model).toBe(slug);
		}
	});

	it('normalizes legacy/retired values, leaving live selections untouched', () => {
		expect(normalizeModelSelection('antigravity', 'Gemini 3.6 Flash (Low)')).toEqual({
			model: 'gemini-3.6-flash',
			reasoning: 'low',
		});
		expect(normalizeModelSelection('codex', 'gpt-5.4')).toEqual({
			model: 'gpt-5.5',
			retiredFrom: 'gpt-5.4',
		});
		expect(normalizeModelSelection('claude', 'sonnet')).toEqual({ model: 'sonnet' });
		expect(normalizeModelSelection('codex', 'gpt-5.6-sol')).toEqual({ model: 'gpt-5.6-sol' });
	});
});

describe('capabilityFor', () => {
	it('reports the known/default reasoning per model', () => {
		expect(capabilityFor('claude', 'sonnet')?.defaultReasoning).toBe('high');
		expect(capabilityFor('codex', 'gpt-6-astra')?.defaultReasoning).toBe('low');
		expect(capabilityFor('codex', 'gpt-5.6-terra')?.defaultReasoning).toBe('medium');
		expect(capabilityFor('antigravity', 'gemini-3.8-flash')?.defaultReasoning).toBe('medium');
		expect(capabilityFor('antigravity', 'gemini-3.7-flash')?.defaultReasoning).toBe('medium');
		expect(capabilityFor('antigravity', 'gemini-3.6-flash')?.defaultReasoning).toBe('medium');
	});
});

describe('DEFAULT_MODEL_PER_CLI', () => {
	it('names a model the CLI’s own catalog still lists', () => {
		// The defect behind issue #892: the coded antigravity default outlived the
		// model it named, so every phase falling through to it failed on spawn.
		for (const [cli, model] of Object.entries(DEFAULT_MODEL_PER_CLI)) {
			expect(capabilityFor(cli as keyof typeof DEFAULT_MODEL_PER_CLI, model)).toBeDefined();
		}
	});
});

describe('RETIRED_ANTIGRAVITY_MODELS', () => {
	it('covers Gemini 3.5 Flash, which agy 1.1.28 withdrew', () => {
		expect(RETIRED_ANTIGRAVITY_MODELS.map((m) => m.id)).toContain('gemini-3.5-flash');
		// Retired means gone from every list SWARM can select or launch from.
		expect(ANTIGRAVITY_MODELS).not.toContain('gemini-3.5-flash');
		expect(capabilityFor('antigravity', 'gemini-3.5-flash')).toBeUndefined();
		for (const slug of ANTIGRAVITY_MODEL_SLUGS) {
			expect(slug).not.toMatch(/^gemini-3\.5-flash/);
		}
	});

	it('replaces each retired model with a live one that keeps its reasoning tiers', () => {
		// A replacement with narrower tiers would make a stored level resolve to no
		// variant, which `resolveModelLaunch` throws on — i.e. the same failing
		// launch this set exists to prevent.
		for (const retired of RETIRED_ANTIGRAVITY_MODELS) {
			const replacement = capabilityFor('antigravity', retired.replacedBy);
			expect(replacement).toBeDefined();
			for (const level of Object.keys(retired.variantByReasoning ?? {})) {
				expect(replacement?.reasoningChoices).toContain(level);
			}
		}
	});

	it('migrates the retired id, its slugs, and its legacy display strings alike', () => {
		expect(migrateRetiredAntigravityModel('gemini-3.5-flash')).toEqual({
			model: 'gemini-3.6-flash',
			retiredFrom: 'gemini-3.5-flash',
		});
		expect(splitAntigravityModel('gemini-3.5-flash-low')).toEqual({
			model: 'gemini-3.6-flash',
			reasoning: 'low',
			retiredFrom: 'gemini-3.5-flash',
		});
		expect(splitAntigravityModel('Gemini 3.5 Flash (High)')).toEqual({
			model: 'gemini-3.6-flash',
			reasoning: 'high',
			retiredFrom: 'gemini-3.5-flash',
		});
		expect(migrateRetiredAntigravityModel('gemini-3.6-flash')).toBeNull();
	});

	it('launches the replacement for every retired value, and reports the substitution', () => {
		const retiredValues = [
			'gemini-3.5-flash',
			'gemini-3.5-flash-low',
			'gemini-3.5-flash-medium',
			'gemini-3.5-flash-high',
			'Gemini 3.5 Flash (Low)',
			'Gemini 3.5 Flash (Medium)',
			'Gemini 3.5 Flash (High)',
		];
		for (const value of retiredValues) {
			const launch = resolveModelLaunch('antigravity', value, undefined);
			// Nothing SWARM dispatches may emit a withdrawn slug on `--model`.
			expect(launch.model).not.toMatch(/^gemini-3\.5-flash/);
			expect(ANTIGRAVITY_MODEL_SLUGS).toContain(launch.model);
			expect(launch.retiredModel).toBe('gemini-3.5-flash');
		}
		// The stored reasoning level survives the hop rather than resetting to the
		// replacement's default.
		expect(resolveModelLaunch('antigravity', 'gemini-3.5-flash-low', undefined).model).toBe(
			'gemini-3.6-flash-low',
		);
		expect(resolveModelLaunch('antigravity', 'gemini-3.5-flash', 'high').model).toBe(
			'gemini-3.6-flash-high',
		);
	});

	it('reports no substitution for a live selection', () => {
		expect(
			resolveModelLaunch('antigravity', 'gemini-3.8-flash', 'high').retiredModel,
		).toBeUndefined();
		expect(resolveModelLaunch('claude', 'sonnet', 'high').retiredModel).toBeUndefined();
	});
});

describe('RETIRED_CODEX_MODELS', () => {
	it('covers both GPT-5.4 entries, retired 2026-08-31', () => {
		expect(RETIRED_CODEX_MODELS.map((m) => m.id)).toEqual(['gpt-5.4', 'gpt-5.4-mini']);
		// Retired means gone from every list SWARM can select or launch from — the API
		// answers either id with a 400, so offering one is offering a dead phase.
		for (const retired of RETIRED_CODEX_MODELS) {
			expect(CODEX_MODELS).not.toContain(retired.id);
			expect(ALL_AGENT_MODELS).not.toContain(retired.id);
			expect(capabilityFor('codex', retired.id)).toBeUndefined();
		}
	});

	it('replaces each retired model with a live one that still accepts its levels', () => {
		// A replacement with a narrower range would send codex an effort it rejects —
		// i.e. the same failing launch this set exists to prevent.
		for (const retired of RETIRED_CODEX_MODELS) {
			const replacement = capabilityFor('codex', retired.replacedBy);
			expect(replacement, retired.replacedBy).toBeDefined();
			for (const level of retired.reasoningChoices) {
				expect(replacement?.reasoningChoices, `${retired.id} → ${level}`).toContain(level);
			}
		}
	});

	it('migrates a retired id and leaves a live one alone', () => {
		expect(migrateRetiredCodexModel('gpt-5.4')).toEqual({
			model: 'gpt-5.5',
			retiredFrom: 'gpt-5.4',
		});
		expect(migrateRetiredCodexModel('gpt-5.4-mini')).toEqual({
			model: 'gpt-5.5',
			retiredFrom: 'gpt-5.4-mini',
		});
		expect(migrateRetiredCodexModel('gpt-5.5')).toBeNull();
		expect(migrateRetiredCodexModel('gpt-6-astra')).toBeNull();
	});

	it('launches the replacement for every retired id, reporting the substitution', () => {
		for (const retired of RETIRED_CODEX_MODELS) {
			const launch = resolveModelLaunch('codex', retired.id, 'high');
			// Nothing SWARM dispatches may put a withdrawn id on `--model`.
			expect(launch.model).toBe(retired.replacedBy);
			expect(CODEX_MODELS).toContain(launch.model);
			expect(launch.retiredModel).toBe(retired.id);
			// The stored level survives the hop rather than resetting to a default.
			expect(launch.providerArgs).toEqual(['-c', 'model_reasoning_effort="high"']);
		}
	});

	it('reports no substitution for a live codex selection', () => {
		expect(resolveModelLaunch('codex', 'gpt-6-astra', 'ultra').retiredModel).toBeUndefined();
		expect(resolveModelLaunch('codex', 'gpt-5.5', undefined).retiredModel).toBeUndefined();
	});

	it('passes an unknown codex id through so codex itself fails visibly', () => {
		expect(resolveModelLaunch('codex', 'gpt-9.9-nonsense', undefined)).toEqual({
			model: 'gpt-9.9-nonsense',
			providerArgs: [],
		});
	});
});

describe('pinnedCliForModel', () => {
	it('pins antigravity for every form it can store', () => {
		for (const value of [
			...ANTIGRAVITY_MODELS,
			...ANTIGRAVITY_MODEL_SLUGS,
			...Object.keys(LEGACY_ANTIGRAVITY_DISPLAY_STRINGS),
			...RETIRED_ANTIGRAVITY_MODELS.map((retired) => retired.id),
		]) {
			expect(pinnedCliForModel(value), value).toBe('antigravity');
		}
	});

	it('pins codex for a retired codex id, so the migration is not bypassed', () => {
		// Without the pin the value runs on the phase's coded default CLI (`claude`
		// for every phase), which both skips the hop onto the replacement and takes
		// the withdrawn id to `claude --model`.
		for (const retired of RETIRED_CODEX_MODELS) {
			expect(pinnedCliForModel(retired.id), retired.id).toBe('codex');
		}
	});

	it('pins nothing for a claude alias, a live codex id, or an unknown string', () => {
		// claude is already every phase's coded default, so its aliases need no pin;
		// a live codex id keeps running on that default exactly as it did before
		// issue #893 — the pin is scoped to the values a retirement has to migrate.
		for (const value of [...CLAUDE_MODELS, ...CODEX_MODELS, 'gemini-9.9-flash', '', 'toString']) {
			expect(pinnedCliForModel(value), value).toBeUndefined();
		}
	});
});

describe('isAntigravityModelValue', () => {
	it('recognizes every antigravity form a config can store', () => {
		// The predicate a `cli`-less target is pinned by: logical ids, today's
		// combined slugs, the pre-1.1.5 display strings, and a retired model's id and
		// slugs must all be recognized, or such a target falls through to the coded
		// default CLI (claude) and fails on spawn.
		for (const value of [
			...ANTIGRAVITY_MODELS,
			...ANTIGRAVITY_MODEL_SLUGS,
			...Object.keys(LEGACY_ANTIGRAVITY_DISPLAY_STRINGS),
			...RETIRED_ANTIGRAVITY_MODELS.flatMap((retired) => [
				retired.id,
				...(retired.fixedVariant ? [retired.fixedVariant] : []),
				...Object.values(retired.variantByReasoning ?? {}),
			]),
		]) {
			expect(isAntigravityModelValue(value), value).toBe(true);
		}
	});

	it('claims no claude or codex model, and no unknown string', () => {
		// The pin is only safe because the catalogs are disjoint (asserted above for
		// `AGENT_MODELS`), so a claude alias or a codex id — retired ones included,
		// which are still stored by configs and pin `codex` instead — must never match.
		for (const value of [
			...CLAUDE_MODELS,
			...CODEX_MODELS,
			...RETIRED_CODEX_MODELS.map((retired) => retired.id),
		]) {
			expect(isAntigravityModelValue(value), value).toBe(false);
		}
		expect(isAntigravityModelValue('gemini-9.9-flash')).toBe(false);
		expect(isAntigravityModelValue('')).toBe(false);
		// An inherited `Object.prototype` name must not read as a display string.
		expect(isAntigravityModelValue('toString')).toBe(false);
		expect(isAntigravityModelValue('constructor')).toBe(false);
	});
});
