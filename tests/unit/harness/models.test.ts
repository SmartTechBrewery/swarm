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
	migrateRetiredAntigravityModel,
	normalizeModelSelection,
	RETIRED_ANTIGRAVITY_MODELS,
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

	it('normalizes only antigravity legacy strings, leaving other selections untouched', () => {
		expect(normalizeModelSelection('antigravity', 'Gemini 3.6 Flash (Low)')).toEqual({
			model: 'gemini-3.6-flash',
			reasoning: 'low',
		});
		expect(normalizeModelSelection('claude', 'sonnet')).toEqual({ model: 'sonnet' });
		expect(normalizeModelSelection('codex', 'gpt-5.6-sol')).toEqual({ model: 'gpt-5.6-sol' });
	});
});

describe('capabilityFor', () => {
	it('reports the known/default reasoning per model', () => {
		expect(capabilityFor('claude', 'sonnet')?.defaultReasoning).toBe('high');
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
