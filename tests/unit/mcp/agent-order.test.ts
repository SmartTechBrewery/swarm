import { describe, expect, it } from 'vitest';

import type { AgentTarget } from '@/config/schema.js';
import { reorderTargets, restoreOrder, targetKey } from '@/mcp/agent-order.js';

/**
 * The pure half of `phase_agents_reorder` / `phase_agents_restore` (issue #1349): a
 * reorder may only permute a phase's targets, and a recorded order is re-applied
 * only while it is still a permutation of the current list.
 */
const CODEX: AgentTarget = { cli: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' };
const CLAUDE: AgentTarget = { cli: 'claude', model: 'opus' };
const AGY: AgentTarget = { cli: 'antigravity' };
const TARGETS = [CODEX, CLAUDE, AGY];

describe('targetKey', () => {
	it('names a target <cli>/<model>, its CLI alone without a model, and `default` without a CLI', () => {
		expect(targetKey(CODEX)).toBe('codex/gpt-5.6-sol');
		expect(targetKey(AGY)).toBe('antigravity');
		expect(targetKey({ model: 'sonnet' })).toBe('default/sonnet');
	});
});

describe('reorderTargets', () => {
	it('permutes the same target objects by full key or bare CLI', () => {
		const result = reorderTargets(TARGETS, ['claude', 'antigravity', 'codex/gpt-5.6-sol']);

		expect(result).toEqual({ ok: true, targets: [CLAUDE, AGY, CODEX] });
		if (result.ok) expect(result.targets[0]).toBe(CLAUDE);
	});

	it.each([
		[['claude', 'codex', 'gemini'], /"gemini" names none of the phase's targets/],
		[['claude/sonnet', 'codex', 'antigravity'], /"claude\/sonnet" names none/],
		[['claude', 'claude/opus', 'codex'], /already placed \(claude\/opus\)/],
		[['claude', 'codex'], /leaves out antigravity/],
	])('refuses %j, which is not a permutation of the current targets', (order, reason) => {
		const result = reorderTargets(TARGETS, order);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(reason);
	});

	it('refuses a phase with no targets', () => {
		expect(reorderTargets([], ['claude'])).toEqual({
			ok: false,
			reason: 'The phase has no targets to reorder.',
		});
	});
});

describe('restoreOrder', () => {
	it('re-applies a recorded order that is still a permutation, returning the current objects', () => {
		const result = restoreOrder([CLAUDE, AGY, CODEX], [{ ...CODEX }, { ...CLAUDE }, { ...AGY }]);

		expect(result).toEqual({ ok: true, targets: [CODEX, CLAUDE, AGY] });
		if (result.ok) expect(result.targets[1]).toBe(CLAUDE);
	});

	it.each([
		['a model changed', [CODEX, { cli: 'claude', model: 'sonnet' }, AGY]],
		['a reasoning level changed', [{ ...CODEX, reasoning: 'low' }, CLAUDE, AGY]],
		['a target was added', [CODEX, CLAUDE]],
		['a target was removed', [...TARGETS, { cli: 'codex' as const, model: 'gpt-5.6-terra' }]],
	])('refuses when %s since the order was recorded', (_case, recorded) => {
		const result = restoreOrder(TARGETS, recorded);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/no longer a permutation/);
	});
});
