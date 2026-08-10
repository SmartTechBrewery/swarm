import { describe, expect, it } from 'vitest';

import {
	CODEX_PERMISSION_PROFILE,
	DEFAULT_AGENT_CONTAINMENT,
	DEFAULT_CONTAINMENT_DOMAINS,
	resolveAgentContainment,
	resolveContainmentDomains,
	resolveContainmentPlan,
} from '@/harness/containment.js';

/** The `--settings` JSON claude is launched with, parsed back out of a plan. */
const claudeSandboxSettings = (args: string[]): Record<string, unknown> => {
	const index = args.indexOf('--settings');
	expect(index).toBeGreaterThanOrEqual(0);
	return JSON.parse(args[index + 1]) as Record<string, unknown>;
};

describe('resolveAgentContainment', () => {
	it('defaults to bypass when unset or empty, so an unconfigured install keeps working', () => {
		// Issue #614 acceptance criterion: today's behavior stays what an
		// installation gets until it has proven containment on its own runs.
		expect(DEFAULT_AGENT_CONTAINMENT).toBe('bypass');
		expect(resolveAgentContainment(undefined)).toBe('bypass');
		expect(resolveAgentContainment('')).toBe('bypass');
		expect(resolveAgentContainment('   ')).toBe('bypass');
	});

	it('reads a configured mode, trimming surrounding whitespace', () => {
		expect(resolveAgentContainment('worktree')).toBe('worktree');
		expect(resolveAgentContainment(' worktree ')).toBe('worktree');
		expect(resolveAgentContainment('bypass')).toBe('bypass');
	});

	it('throws on an unrecognised mode rather than silently downgrading', () => {
		// Falling back to `bypass` here would hand an operator who asked to be
		// contained an uncontained pipeline, silently — the exact failure the
		// setting exists to remove.
		expect(() => resolveAgentContainment('sandbox')).toThrow(/SWARM_AGENT_CONTAINMENT/);
		expect(() => resolveAgentContainment('true')).toThrow(/expected one of bypass, worktree/);
	});
});

describe('resolveContainmentDomains', () => {
	it('falls back to the GitHub defaults when unset, empty, or only separators', () => {
		// An empty allowlist means "deny all network", which fails every phase:
		// each one runs `gh` reads and `git pull`.
		expect(resolveContainmentDomains(undefined)).toEqual([...DEFAULT_CONTAINMENT_DOMAINS]);
		expect(resolveContainmentDomains('')).toEqual([...DEFAULT_CONTAINMENT_DOMAINS]);
		expect(resolveContainmentDomains(' , , ')).toEqual([...DEFAULT_CONTAINMENT_DOMAINS]);
	});

	it('splits a comma-separated list and trims each entry', () => {
		expect(resolveContainmentDomains('api.github.com, github.com ,*.npmjs.org')).toEqual([
			'api.github.com',
			'github.com',
			'*.npmjs.org',
		]);
	});
});

describe('resolveContainmentPlan — bypass', () => {
	it("reproduces each CLI's historical flag exactly", () => {
		// These three strings are what SWARM has always launched; `bypass` must
		// stay byte-for-byte identical so enabling nothing changes nothing.
		expect(resolveContainmentPlan({ cli: 'claude', mode: 'bypass' }).args).toEqual([
			'--dangerously-skip-permissions',
		]);
		expect(resolveContainmentPlan({ cli: 'antigravity', mode: 'bypass' }).args).toEqual([
			'--dangerously-skip-permissions',
		]);
		expect(resolveContainmentPlan({ cli: 'codex', mode: 'bypass' }).args).toEqual([
			'--dangerously-bypass-approvals-and-sandbox',
		]);
	});

	it('defaults to bypass when the caller names no mode', () => {
		const plan = resolveContainmentPlan({ cli: 'claude' });
		expect(plan.requested).toBe('bypass');
		expect(plan.applied).toBe('bypass');
		expect(plan.unavailableReason).toBeUndefined();
	});
});

describe('resolveContainmentPlan — worktree', () => {
	it('launches claude with a sandbox settings blob and acceptEdits instead of the bypass', () => {
		const plan = resolveContainmentPlan({
			cli: 'claude',
			mode: 'worktree',
			allowedDomains: ['api.github.com'],
		});

		expect(plan.applied).toBe('worktree');
		expect(plan.args).not.toContain('--dangerously-skip-permissions');
		expect(plan.args).toEqual([
			'--settings',
			expect.any(String),
			'--permission-mode',
			'acceptEdits',
		]);
		expect(claudeSandboxSettings(plan.args)).toEqual({
			sandbox: {
				enabled: true,
				failIfUnavailable: true,
				allowUnsandboxedCommands: false,
				autoAllowBashIfSandboxed: true,
				network: { allowedDomains: ['api.github.com'] },
			},
		});
	});

	it("takes claude's network allowlist from the env when the caller passes none", () => {
		const plan = resolveContainmentPlan({ cli: 'claude', mode: 'worktree' });
		const settings = claudeSandboxSettings(plan.args) as {
			sandbox: { network: { allowedDomains: string[] } };
		};
		expect(settings.sandbox.network.allowedDomains).toEqual([...DEFAULT_CONTAINMENT_DOMAINS]);
	});

	it('defines and selects a SWARM-owned codex permission profile without touching config.toml', () => {
		const plan = resolveContainmentPlan({ cli: 'codex', mode: 'worktree' });

		expect(plan.applied).toBe('worktree');
		expect(plan.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
		expect(plan.args).toEqual([
			'-c',
			`permissions.${CODEX_PERMISSION_PROFILE}.extends=":workspace"`,
			'-c',
			`permissions.${CODEX_PERMISSION_PROFILE}.network.enabled=true`,
			'-c',
			`default_permissions="${CODEX_PERMISSION_PROFILE}"`,
		]);
		// `-s`/`sandbox_mode` is deliberately absent: codex rejects `sandbox_mode`
		// and `default_permissions` set together.
		expect(plan.args).not.toContain('-s');
	});

	it('falls back to bypass for antigravity and says why', () => {
		// agy cannot be contained today: no per-invocation allow-rule flag, and
		// its --sandbox hides the linked worktree's gitdir (docs/agent-containment.md).
		const plan = resolveContainmentPlan({ cli: 'antigravity', mode: 'worktree' });

		expect(plan.requested).toBe('worktree');
		expect(plan.applied).toBe('bypass');
		expect(plan.args).toEqual(['--dangerously-skip-permissions']);
		expect(plan.unavailableReason).toMatch(/docs\/agent-containment\.md/);
	});
});
