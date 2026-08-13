import { describe, expect, it } from 'vitest';
import type { AgentTarget } from '@/config/schema.js';
import type { AgentCli } from '@/harness/agent-cli.js';
import { selectTarget } from '@/worker/target-selection.js';

const CLAUDE: AgentTarget = { cli: 'claude', model: 'opus', reasoning: 'high' };
const CODEX: AgentTarget = { cli: 'codex', model: 'gpt-5.6-terra' };
const ANTIGRAVITY: AgentTarget = { cli: 'antigravity', model: 'gemini-3.5-flash' };

function available(...clis: AgentCli[]): ReadonlySet<AgentCli> {
	return new Set(clis);
}

describe('selectTarget', () => {
	it('selects the preferred target when this worker can run its CLI', () => {
		expect(selectTarget([CODEX, CLAUDE], available('codex', 'claude'))).toEqual({
			target: CODEX,
			index: 0,
			skipped: [],
			fallback: false,
		});
	});

	it('routes to the next target whose CLI is available, respecting list order', () => {
		expect(selectTarget([CODEX, ANTIGRAVITY, CLAUDE], available('claude', 'antigravity'))).toEqual({
			target: ANTIGRAVITY,
			index: 1,
			skipped: ['codex'],
			fallback: false,
		});
	});

	it('falls back to the preferred target when no target CLI is available', () => {
		// Today's fail-visibly behaviour: the phase still runs (and fails on spawn if
		// the binary is genuinely missing) rather than being silently skipped.
		expect(selectTarget([CODEX, CLAUDE], available('antigravity'))).toEqual({
			target: CODEX,
			index: 0,
			skipped: [],
			fallback: true,
		});
	});

	it('treats a target with no cli as always eligible (it runs on the phase coded default)', () => {
		const codedDefault: AgentTarget = { model: 'sonnet' };
		expect(selectTarget([CODEX, codedDefault], available('claude'))).toEqual({
			target: codedDefault,
			index: 1,
			skipped: ['codex'],
			fallback: false,
		});
	});

	// The branch the consumer's own fallback now always takes: the gate selected no
	// worker, so no executing host — and no CLI set — is known (issue #703).
	it('keeps the preferred target when worker capabilities are unknown', () => {
		expect(selectTarget([CODEX, CLAUDE], undefined)).toEqual({
			target: CODEX,
			index: 0,
			skipped: [],
			fallback: false,
		});
	});

	it('selects nothing when the phase configured no targets', () => {
		expect(selectTarget(undefined, available('claude'))).toBeUndefined();
		expect(selectTarget([], available('claude'))).toBeUndefined();
	});
});
