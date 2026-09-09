import { describe, expect, it } from 'vitest';
import type { AgentConfig, AgentTarget } from '../../../src/config/schema.js';
import {
	addTarget,
	areTargetsDirty,
	availableClisFor,
	canAddTarget,
	cleanTargets,
	describeTarget,
	hasDuplicateCli,
	moveTarget,
	nextAvailableCli,
	patchTarget,
	removeTarget,
	summarizeTargets,
	targetKey,
	toTargetList,
} from './agent-targets.js';

describe('toTargetList', () => {
	it('reads a pre-targets config as its one-element priority list', () => {
		expect(toTargetList({ cli: 'claude', model: 'sonnet', reasoning: 'high' })).toEqual([
			{ cli: 'claude', model: 'sonnet', reasoning: 'high' },
		]);
	});

	it('splits a legacy combined antigravity model into a logical id plus reasoning', () => {
		expect(toTargetList({ cli: 'antigravity', model: 'Gemini 3.6 Flash (High)' })).toEqual([
			{ cli: 'antigravity', model: 'gemini-3.6-flash', reasoning: 'high' },
		]);
	});

	it('reads a retired antigravity model as its live replacement (issue #892)', () => {
		expect(toTargetList({ cli: 'antigravity', model: 'gemini-3.5-flash' })).toEqual([
			{ cli: 'antigravity', model: 'gemini-3.6-flash' },
		]);
		expect(toTargetList({ cli: 'antigravity', model: 'gemini-3.5-flash-low' })).toEqual([
			{ cli: 'antigravity', model: 'gemini-3.6-flash', reasoning: 'low' },
		]);
	});

	it('reads a stored antigravity model with no cli as an antigravity target', () => {
		// A pre-`targets` config could store `model` alone. The schema pins the CLI on
		// parse (issue #892); mirror it here, or the screen shows no CLI chosen and a
		// disabled Model selector for a phase that runs on antigravity.
		expect(toTargetList({ model: 'gemini-3.5-flash' })).toEqual([
			{ cli: 'antigravity', model: 'gemini-3.6-flash' },
		]);
		expect(toTargetList({ model: 'Gemini 3.5 Flash (High)' })).toEqual([
			{ cli: 'antigravity', model: 'gemini-3.6-flash', reasoning: 'high' },
		]);
		expect(toTargetList({ model: 'gemini-3.8-flash' })).toEqual([
			{ cli: 'antigravity', model: 'gemini-3.8-flash' },
		]);
	});

	it('leaves a stored claude model with no cli unpinned', () => {
		// Only antigravity values are pinned — a claude alias keeps reading as "no CLI
		// named", the phase's coded default.
		expect(toTargetList({ model: 'sonnet' })).toEqual([{ model: 'sonnet' }]);
	});

	it('normalizes every target of a stored list and keeps its order', () => {
		const config: AgentConfig = {
			cli: 'antigravity',
			model: 'gemini-3.1-pro',
			reasoning: 'low',
			targets: [
				{ cli: 'antigravity', model: 'Gemini 3.1 Pro (Low)' },
				{ cli: 'codex', model: 'gpt-5.6-terra', reasoning: 'high' },
			],
		};
		expect(toTargetList(config)).toEqual([
			{ cli: 'antigravity', model: 'gemini-3.1-pro', reasoning: 'low' },
			{ cli: 'codex', model: 'gpt-5.6-terra', reasoning: 'high' },
		]);
	});

	it('reads a config that selects nothing as an empty list', () => {
		expect(toTargetList(undefined)).toEqual([]);
		expect(toTargetList({})).toEqual([]);
		expect(toTargetList({ timeoutMs: 600_000 })).toEqual([]);
	});
});

describe('one target per CLI', () => {
	const targets: AgentTarget[] = [{ cli: 'claude' }, { cli: 'codex' }];

	it('offers a row its own CLI plus the unclaimed ones', () => {
		expect(availableClisFor(targets, 0)).toEqual(['claude', 'antigravity']);
		expect(availableClisFor(targets, 1)).toEqual(['antigravity', 'codex']);
	});

	it('adds a target on the first unused CLI and stops once all three are used', () => {
		expect(nextAvailableCli(targets)).toBe('antigravity');
		expect(addTarget(targets)).toEqual([
			{ cli: 'claude' },
			{ cli: 'codex' },
			{ cli: 'antigravity' },
		]);

		const full = addTarget(targets);
		expect(canAddTarget(full)).toBe(false);
		expect(addTarget(full)).toBe(full);
	});

	it('detects the duplicate the schema rejects', () => {
		expect(hasDuplicateCli(targets)).toBe(false);
		expect(hasDuplicateCli([{ cli: 'claude' }, { cli: 'claude', model: 'opus' }])).toBe(true);
	});

	it('keys rows by CLI, disambiguating a duplicate that arrived from outside the UI', () => {
		expect(targets.map((_, i) => targetKey(targets, i))).toEqual(['claude', 'codex']);
		const duplicated: AgentTarget[] = [{ cli: 'claude' }, { cli: 'claude', model: 'opus' }, {}];
		expect(duplicated.map((_, i) => targetKey(duplicated, i))).toEqual([
			'claude',
			'claude-1',
			'unset',
		]);
	});
});

describe('reordering', () => {
	const targets: AgentTarget[] = [{ cli: 'claude' }, { cli: 'codex' }, { cli: 'antigravity' }];

	it('swaps a target with its neighbour', () => {
		expect(moveTarget(targets, 1, 'up')).toEqual([
			{ cli: 'codex' },
			{ cli: 'claude' },
			{ cli: 'antigravity' },
		]);
		expect(moveTarget(targets, 1, 'down')).toEqual([
			{ cli: 'claude' },
			{ cli: 'antigravity' },
			{ cli: 'codex' },
		]);
	});

	it('leaves the list untouched at either end', () => {
		expect(moveTarget(targets, 0, 'up')).toBe(targets);
		expect(moveTarget(targets, 2, 'down')).toBe(targets);
	});

	it('removes by position', () => {
		expect(removeTarget(targets, 1)).toEqual([{ cli: 'claude' }, { cli: 'antigravity' }]);
	});
});

describe('patchTarget', () => {
	it('drops a model the newly selected CLI does not offer, and always clears reasoning', () => {
		const targets: AgentTarget[] = [{ cli: 'claude', model: 'sonnet', reasoning: 'high' }];
		expect(patchTarget(targets, 0, { cli: 'codex' })).toEqual([{ cli: 'codex' }]);
	});

	it('keeps a model the new CLI still offers but re-picks reasoning', () => {
		const targets: AgentTarget[] = [{ cli: 'codex', model: 'gpt-5.6-sol', reasoning: 'max' }];
		// No model id is shared across CLIs today, so a CLI change always clears it.
		expect(patchTarget(targets, 0, { cli: 'claude' })).toEqual([{ cli: 'claude' }]);
	});

	it('keeps a reasoning level the new model still supports', () => {
		const targets: AgentTarget[] = [{ cli: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' }];
		expect(patchTarget(targets, 0, { model: 'gpt-5.4' })).toEqual([
			{ cli: 'codex', model: 'gpt-5.4', reasoning: 'high' },
		]);
	});

	it('clears a reasoning level the new model does not support', () => {
		const targets: AgentTarget[] = [{ cli: 'codex', model: 'gpt-5.6-sol', reasoning: 'max' }];
		expect(patchTarget(targets, 0, { model: 'gpt-5.4-mini' })).toEqual([
			{ cli: 'codex', model: 'gpt-5.4-mini', reasoning: undefined },
		]);
	});

	it('sets reasoning without touching the rest, and ignores an unknown row', () => {
		const targets: AgentTarget[] = [{ cli: 'claude' }, { cli: 'codex', model: 'gpt-5.5' }];
		expect(patchTarget(targets, 1, { reasoning: 'xhigh' })).toEqual([
			{ cli: 'claude' },
			{ cli: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' },
		]);
		expect(patchTarget(targets, 5, { reasoning: 'low' })).toBe(targets);
	});

	it('leaves other rows untouched', () => {
		const targets: AgentTarget[] = [{ cli: 'claude', model: 'opus' }, { cli: 'codex' }];
		expect(patchTarget(targets, 0, { model: 'sonnet' })).toEqual([
			{ cli: 'claude', model: 'sonnet' },
			{ cli: 'codex' },
		]);
	});
});

describe('cleanTargets', () => {
	it('drops rows that select nothing', () => {
		expect(cleanTargets([{ cli: 'claude' }, {}, { cli: 'codex' }])).toEqual([
			{ cli: 'claude', model: undefined, reasoning: undefined },
			{ cli: 'codex', model: undefined, reasoning: undefined },
		]);
	});

	it('drops a reasoning level left without a model to validate it against', () => {
		expect(cleanTargets([{ cli: 'claude', reasoning: 'high' }])).toEqual([
			{ cli: 'claude', model: undefined, reasoning: undefined },
		]);
	});
});

describe('areTargetsDirty', () => {
	const stored: AgentConfig = {
		cli: 'claude',
		model: 'sonnet',
		reasoning: 'high',
		targets: [
			{ cli: 'claude', model: 'sonnet', reasoning: 'high' },
			{ cli: 'codex', model: 'gpt-5.6-terra' },
		],
	};

	it('is clean for the list the stored config projects to', () => {
		expect(areTargetsDirty(toTargetList(stored), stored)).toBe(false);
	});

	it('is dirty when the order changes, since order is priority', () => {
		expect(areTargetsDirty(moveTarget(toTargetList(stored), 1, 'up'), stored)).toBe(true);
	});

	it('is dirty when a target is added, removed, or edited', () => {
		expect(areTargetsDirty(addTarget(toTargetList(stored)), stored)).toBe(true);
		expect(areTargetsDirty(removeTarget(toTargetList(stored), 1), stored)).toBe(true);
		expect(areTargetsDirty(patchTarget(toTargetList(stored), 0, { model: 'opus' }), stored)).toBe(
			true,
		);
	});

	it('compares a legacy single selection against its one-element list', () => {
		const legacy: AgentConfig = { cli: 'antigravity', model: 'Gemini 3.6 Flash (High)' };
		expect(areTargetsDirty(toTargetList(legacy), legacy)).toBe(false);
		expect(areTargetsDirty([{ cli: 'antigravity', model: 'gemini-3.6-flash' }], legacy)).toBe(true);
	});

	it('ignores rows that select nothing on either side', () => {
		expect(areTargetsDirty([{}], {})).toBe(false);
	});
});

describe('summaries', () => {
	it('describes one target as CLI, model, and reasoning', () => {
		expect(describeTarget({ cli: 'claude', model: 'sonnet', reasoning: 'high' })).toBe(
			'Claude · Sonnet · High',
		);
		expect(describeTarget({ cli: 'codex' })).toBe('Codex');
		expect(describeTarget({})).toBe('');
	});

	it('falls back to the raw id for a model outside the catalog', () => {
		expect(describeTarget({ cli: 'claude', model: 'claude-3-5-sonnet' })).toBe(
			'Claude · claude-3-5-sonnet',
		);
	});

	it('joins the list in priority order', () => {
		expect(
			summarizeTargets([
				{ cli: 'claude', model: 'sonnet', reasoning: 'high' },
				{ cli: 'codex', model: 'gpt-5.6-terra' },
			]),
		).toBe('Claude · Sonnet · High ▸ Codex · GPT-5.6 Terra');
		expect(summarizeTargets([])).toBe('');
	});
});
