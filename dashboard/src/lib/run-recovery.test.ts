import { describe, expect, it } from 'vitest';
import type { AgentCli } from '../../../src/harness/agent-cli.js';
import { capabilityFor, MODEL_CAPABILITIES } from '../../../src/harness/models.js';
import {
	canRecoverRun,
	defaultOverrideModel,
	type OverrideSelection,
	overrideSelectionChanged,
	recoverButtonLabel,
	recoveryChoices,
	recoveryOverrideSubmitLabel,
	recoveryRetryChoiceLabel,
	seedOverrideSelection,
} from './run-recovery.js';
import { retryButtonLabel } from './run-retry.js';

const AGENT_CLIS = ['claude', 'antigravity', 'codex'] as const satisfies readonly AgentCli[];

describe('recoveryChoices', () => {
	it('offers both a fresh retry and a reset for a plain failed run', () => {
		expect(recoveryChoices({ status: 'failed', agentSessionId: null })).toEqual({
			retry: 'retry',
			reset: true,
		});
	});

	it('names the retry choice by the run’s own recovery state', () => {
		expect(
			recoveryChoices({ status: 'failed', agentSessionId: null, recovery: { state: 'preserved' } })
				.retry,
		).toBe('resume');
		expect(
			recoveryChoices({ status: 'failed', agentSessionId: null, recovery: { state: 'blocked' } })
				.retry,
		).toBe('recheck');
	});

	it('offers a continuation for a checkpointed run', () => {
		expect(recoveryChoices({ status: 'checkpointed', agentSessionId: null })).toEqual({
			retry: 'continue',
			reset: true,
		});
	});

	it('offers nothing for a completed run, which has nothing to recover', () => {
		const choices = recoveryChoices({ status: 'completed', agentSessionId: null });
		expect(choices).toEqual({ retry: null, reset: false });
		expect(canRecoverRun(choices)).toBe(false);
	});

	// Issue #744: the server no longer refuses to reset a live row, and these rules
	// mirror the server rather than deciding anything. Which control an operator
	// actually sees is the route's call — the unified Recover trigger is still scoped
	// to the error states, so a running run keeps offering Terminate alone.
	it('reports reset as eligible for a running run, mirroring the server', () => {
		expect(recoveryChoices({ status: 'running', agentSessionId: null })).toEqual({
			retry: null,
			reset: true,
		});
	});

	it('is recoverable whenever at least one choice is eligible', () => {
		expect(canRecoverRun({ retry: 'retry', reset: true })).toBe(true);
		expect(canRecoverRun({ retry: null, reset: true })).toBe(true);
		expect(canRecoverRun({ retry: 'retry', reset: false })).toBe(true);
		expect(canRecoverRun({ retry: null, reset: false })).toBe(false);
	});
});

describe('recoverButtonLabel', () => {
	const both = { retry: 'retry', reset: true } as const;

	it('reads as the neutral opener while nothing is in flight', () => {
		expect(recoverButtonLabel(both, null)).toBe('Recover');
	});

	it.each([
		['retry', 'Retrying…'],
		['resume', 'Resuming…'],
		['recheck', 'Rechecking…'],
		['continue', 'Continuing…'],
	] as const)('names the %s choice while it is submitting', (kind, label) => {
		expect(recoverButtonLabel({ retry: kind, reset: true }, 'retry')).toBe(label);
	});

	it('names the reset choice while it is submitting', () => {
		expect(recoverButtonLabel(both, 'reset')).toBe('Resetting…');
	});

	it('lets the durable outstanding request win over the local pending state', () => {
		// The accepted restart is the fact a second viewer and a reloaded page both
		// see, so it must name the wait even while this browser's mutation is still
		// in flight — and for either choice, since both queue the same restart.
		expect(recoverButtonLabel(both, null, true)).toBe('Waiting to restart…');
		expect(recoverButtonLabel(both, 'retry', true)).toBe('Waiting to restart…');
		expect(recoverButtonLabel(both, 'reset', true)).toBe('Waiting to restart…');
	});

	it('falls back to the opener when a retry is pending but no retry choice exists', () => {
		expect(recoverButtonLabel({ retry: null, reset: true }, 'retry')).toBe('Recover');
	});
});

describe('overrideSelectionChanged', () => {
	const seeded: OverrideSelection = {
		cli: 'antigravity',
		model: 'gemini-3.8-flash',
		reasoning: 'high',
	};

	it('reports nothing changed while the fields still hold the run’s own settings', () => {
		expect(overrideSelectionChanged(seeded, { ...seeded })).toBe(false);
	});

	// The reported defect: only the model moved, within the same CLI (issue #989).
	it('reports a model-only edit, so a same-CLI downgrade still submits an override', () => {
		expect(overrideSelectionChanged(seeded, { ...seeded, model: 'gemini-3.7-flash' })).toBe(true);
	});

	it.each([
		['cli', { cli: 'claude' }],
		['reasoning', { reasoning: 'low' }],
	] as const)('reports a %s edit', (_field, patch) => {
		expect(overrideSelectionChanged(seeded, { ...seeded, ...patch })).toBe(true);
	});

	it('treats a run with no reasoning of its own as unchanged until one is picked', () => {
		const none: OverrideSelection = { cli: 'claude', model: 'opus', reasoning: '' };
		expect(overrideSelectionChanged(none, { ...none })).toBe(false);
		expect(overrideSelectionChanged(none, { ...none, reasoning: 'xhigh' })).toBe(true);
	});
});

describe('recoveryRetryChoiceLabel', () => {
	it.each([
		['retry', 'Retry now'],
		['resume', 'Resume'],
		['recheck', 'Recheck and retry'],
		['continue', 'Continue now'],
	] as const)('keeps the %s run’s own server semantics while the fields are untouched', (kind, label) => {
		expect(recoveryRetryChoiceLabel(kind, false)).toBe(label);
		// …which is the same wording the side-by-side buttons use for that kind.
		expect(recoveryRetryChoiceLabel(kind, false)).toBe(retryButtonLabel(kind, false));
	});

	it.each([
		['retry', 'Retry with these settings'],
		['resume', 'Retry with these settings'],
		['recheck', 'Recheck with these settings'],
		['continue', 'Continue with these settings'],
	] as const)('becomes the override submit for a %s run once a field is edited', (kind, label) => {
		expect(recoveryRetryChoiceLabel(kind, true)).toBe(label);
		expect(recoveryRetryChoiceLabel(kind, true)).toBe(recoveryOverrideSubmitLabel(kind));
	});
});

describe('recoveryOverrideSubmitLabel', () => {
	it('distinguishes the override submit from the plain retry choice it replaces', () => {
		for (const kind of ['retry', 'resume', 'recheck', 'continue'] as const) {
			expect(recoveryOverrideSubmitLabel(kind)).not.toBe(retryButtonLabel(kind, false));
		}
	});

	// An override changes which agent runs, never what the server does around it —
	// except for a resume, which it really does abandon.
	it('keeps each kind’s own verb, and drops it only for a resume', () => {
		expect(recoveryOverrideSubmitLabel('continue')).toBe('Continue with these settings');
		expect(recoveryOverrideSubmitLabel('recheck')).toBe('Recheck with these settings');
		expect(recoveryOverrideSubmitLabel('resume')).toBe('Retry with these settings');
		expect(recoveryOverrideSubmitLabel('retry')).toBe('Retry with these settings');
	});
});

describe('defaultOverrideModel', () => {
	// The reported defect (issue #994): the popup took `MODEL_CAPABILITIES[cli][0]`,
	// and the claude catalogue leads with Fable — so reaching for the Agent CLI
	// select armed a retry on a model the operator never chose. Asserting the id
	// rather than a list position is the point: reordering the catalogue (which is
	// the Model dropdown's display order) must not move this back.
	it('pre-selects Opus for claude, whatever order the catalogue lists', () => {
		expect(defaultOverrideModel('claude')).toBe('opus');
	});

	it('leaves the newest-first catalogues on their first entry', () => {
		expect(defaultOverrideModel('antigravity')).toBe(MODEL_CAPABILITIES.antigravity[0].id);
		expect(defaultOverrideModel('codex')).toBe(MODEL_CAPABILITIES.codex[0].id);
	});

	// A default the dropdown can't offer would render a select with no matching
	// option, so a retirement has to fail here rather than in the browser.
	it('names a model the live catalogue actually offers, for every CLI', () => {
		for (const cli of AGENT_CLIS) {
			expect(capabilityFor(cli, defaultOverrideModel(cli))).toBeDefined();
		}
	});
});

describe('seedOverrideSelection', () => {
	it('seeds from the run’s own engine/model/reasoning', () => {
		expect(seedOverrideSelection({ engine: 'claude', model: 'haiku', reasoning: null })).toEqual({
			cli: 'claude',
			model: 'haiku',
			reasoning: '',
		});
		expect(seedOverrideSelection({ engine: 'codex', model: 'gpt-5.5', reasoning: 'high' })).toEqual(
			{
				cli: 'codex',
				model: 'gpt-5.5',
				reasoning: 'high',
			},
		);
	});

	// A recognised claude model is still the run's own — this changed the default,
	// not the seed.
	it('keeps a recognised claude model rather than snapping it to the default', () => {
		expect(seedOverrideSelection({ engine: 'claude', model: 'fable', reasoning: null }).model).toBe(
			'fable',
		);
		expect(
			seedOverrideSelection({ engine: 'claude', model: 'sonnet', reasoning: null }).model,
		).toBe('sonnet');
	});

	it('decomposes a legacy combined antigravity model string (issue #180)', () => {
		expect(
			seedOverrideSelection({
				engine: 'antigravity',
				model: 'gemini-3.6-flash-high',
				reasoning: null,
			}),
		).toEqual({ cli: 'antigravity', model: 'gemini-3.6-flash', reasoning: 'high' });
	});

	// The second place the popup had to pick a claude model with nothing to go on,
	// which fell through to the first listed entry the same way (issue #994).
	it('falls back to the CLI’s default when the stored model isn’t in the catalogue', () => {
		expect(
			seedOverrideSelection({ engine: 'claude', model: 'claude-3-opus-20240229', reasoning: null })
				.model,
		).toBe('opus');
	});

	it('falls back to the CLI’s default when the run stored no model at all', () => {
		expect(seedOverrideSelection({ engine: 'claude', model: null, reasoning: null }).model).toBe(
			'opus',
		);
	});

	it('treats a missing or unrecognised engine as claude', () => {
		expect(seedOverrideSelection({ engine: null, model: null, reasoning: null })).toEqual({
			cli: 'claude',
			model: 'opus',
			reasoning: '',
		});
		expect(seedOverrideSelection({ engine: 'gemini', model: null, reasoning: null }).cli).toBe(
			'claude',
		);
	});

	// The seed is what `overrideSelectionChanged` compares against, so an operator
	// who opened the popup and touched nothing must submit no override.
	it('is unchanged against itself, so an untouched popup submits a plain retry', () => {
		const seeded = seedOverrideSelection({ engine: 'claude', model: null, reasoning: null });
		expect(overrideSelectionChanged(seeded, { ...seeded })).toBe(false);
	});
});
