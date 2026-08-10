/**
 * Agent-CLI containment — how far outside its task worktree a run can reach.
 *
 * SWARM used to hard-code one answer per CLI: an unconditional permission
 * bypass (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`).
 * The justification was real — a run happens in a disposable worktree with
 * stdin closed (`stdio: ['ignore', …]` in `./agent-cli.ts`), so a permission
 * prompt can never be answered and a blocked run silently writes nothing — but
 * the consequence was that an agent held the worker user's whole filesystem and
 * network: `$HOME`, `~/.ssh`, every other repo on disk, and the persona
 * `GH_TOKEN` in its env. Nothing kept it inside the worktree but `cwd` and the
 * wording of the phase prompt (issue #614).
 *
 * This module turns that single hard-coded answer into a resolvable one. A run
 * names a {@link AgentContainment} mode; this module answers with the concrete
 * launch arguments for that (mode, CLI) pair. Two modes exist:
 *
 * - **`bypass`** — today's behavior, and the default, so an installation that
 *   has not proven containment on its own real runs keeps a working pipeline.
 * - **`worktree`** — the CLI's own OS-level sandbox, scoped to the run's `cwd`:
 *   writes land only inside the worktree, network egress is restricted, and no
 *   permission prompt is ever needed because the sandbox — not a human — is
 *   what makes a command safe to auto-allow.
 *
 * **Containment is not achievable for all three CLIs, and the differences were
 * measured rather than read off the flag names** (ai/RULES.md §6). The full
 * per-CLI record — what each sandbox costs, what it still cannot stop, and the
 * probe transcripts behind both — is `docs/agent-containment.md`; the short
 * version each builder below needs is inlined with it.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import type { AgentCli } from './agent-cli.js';

/**
 * How far outside its worktree an agent CLI run may reach.
 *
 * `bypass` is the coded default deliberately: issue #614's acceptance criteria
 * require that today's behavior stay available and stay what an installation
 * gets until *its own* six phases have been shown to pass contained, because a
 * containment that breaks a phase turns a working pipeline into a broken one.
 * Opt in per deployment with `SWARM_AGENT_CONTAINMENT`, or per run with
 * `RunAgentCliOptions.containment`.
 */
export const AgentContainmentSchema = z.enum(['bypass', 'worktree']);
export type AgentContainment = z.infer<typeof AgentContainmentSchema>;

/** Mode used when neither the env nor the caller names one. */
export const DEFAULT_AGENT_CONTAINMENT: AgentContainment = 'bypass';

/**
 * Domains a contained run may still reach. Every phase prompt performs network
 * work — `gh issue view` / `gh pr diff` / `gh api` / `gh pr checks` and
 * `git pull --ff-only origin` — and every one of the three sandboxes denies
 * network by default, so a contained run with no allowance fails every phase.
 * These two cover the `gh` API and git-over-HTTPS against github.com; a project
 * whose test suite fetches (an `npm install` on a cold cache, say) has to widen
 * the list with `SWARM_AGENT_CONTAINMENT_DOMAINS`.
 */
export const DEFAULT_CONTAINMENT_DOMAINS: readonly string[] = ['api.github.com', 'github.com'];

/**
 * Identifier of the codex permission profile SWARM defines for a contained run.
 * It is supplied entirely through `-c` overrides, so the operator's own
 * `~/.codex/config.toml` is never written to; the name is SWARM-specific so an
 * override cannot collide with a profile the operator already keeps there.
 */
export const CODEX_PERMISSION_PROFILE = 'swarm-worktree';

/**
 * The flags each CLI needs to run unattended with **no** containment: today's
 * behavior, preserved verbatim so `bypass` mode is byte-for-byte what SWARM has
 * always launched.
 *
 * claude and agy both call their bypass `--dangerously-skip-permissions`. Codex
 * calls it `--dangerously-bypass-approvals-and-sandbox` (confirmed via
 * `codex exec --help`; it has no `--dangerously-skip-permissions` at all).
 */
const BYPASS_ARGS: Record<AgentCli, readonly string[]> = {
	claude: ['--dangerously-skip-permissions'],
	antigravity: ['--dangerously-skip-permissions'],
	codex: ['--dangerously-bypass-approvals-and-sandbox'],
};

/**
 * Why `agy` cannot be contained today. Recorded here, not silently left on the
 * bypass, because the acceptance criteria for issue #614 ask for the reason
 * wherever the flag is chosen.
 *
 * Measured on agy 1.1.11, in a real SWARM-shaped linked worktree:
 *
 * 1. `--sandbox` **together with** `--dangerously-skip-permissions` contains
 *    nothing — a command that must leave the sandbox raises a *distinct*
 *    `unsandboxed` permission, which the bypass auto-approves. Adding
 *    `--sandbox` alongside the bypass would look like a fix and buy nothing.
 * 2. `--sandbox` **alone** cannot run headless at all: `agy --sandbox --add-dir
 *    <worktree> -p "run git status"` produced
 *    `a tool required the "command" permission that headless mode cannot prompt
 *    for, so it was auto-denied`, and exited 0 having done nothing — the exact
 *    failure the bypass exists to prevent. Unlike claude (`--settings <json>`)
 *    and codex (`-c` overrides), `agy --help` exposes no per-invocation way to
 *    supply an allow-rule: the only remedy is editing the operator's own
 *    `~/.gemini/antigravity-cli/settings.json`, which SWARM must not mutate.
 * 3. Even past that, `--sandbox` denies reads outside the workspace, and a
 *    linked worktree's `.git` is a pointer file into `<repo>/.git/worktrees/<name>`
 *    — outside it. `git status`/`diff`/`log` are all denied, so the phase
 *    prompts' git work cannot run.
 */
const ANTIGRAVITY_UNAVAILABLE_REASON =
	"antigravity (agy) has no per-invocation permission allow-rule, and its --sandbox denies reads of the linked worktree's gitdir — see docs/agent-containment.md";

/** The resolved launch arguments for one (mode, CLI) pair. */
export interface AgentContainmentPlan {
	/**
	 * Arguments to insert immediately after the CLI's own subcommand args and
	 * ahead of everything else — the position today's bypass flag occupied.
	 */
	args: string[];
	/** The mode the caller asked for. */
	requested: AgentContainment;
	/**
	 * The mode actually in force. Differs from {@link requested} only when the
	 * CLI cannot be contained at all, in which case {@link unavailableReason}
	 * says why and the run falls back to `bypass` rather than failing — a
	 * deployment that mixes CLIs must not lose the CLIs it can still run.
	 */
	applied: AgentContainment;
	/** Present exactly when `applied !== requested`. */
	unavailableReason?: string;
}

/**
 * Read the deployment's containment mode from `SWARM_AGENT_CONTAINMENT`.
 *
 * Unset/empty keeps {@link DEFAULT_AGENT_CONTAINMENT}. An unrecognised value
 * throws rather than falling back: silently downgrading a deployment that asked
 * to be contained is the failure mode this whole module exists to remove.
 */
export function resolveAgentContainment(
	raw = process.env.SWARM_AGENT_CONTAINMENT,
): AgentContainment {
	const value = (raw ?? '').trim();
	if (value === '') return DEFAULT_AGENT_CONTAINMENT;
	const parsed = AgentContainmentSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(
			`Invalid SWARM_AGENT_CONTAINMENT: "${value}" (expected one of ${AgentContainmentSchema.options.join(', ')})`,
		);
	}
	return parsed.data;
}

/**
 * Read the contained run's network allowlist from
 * `SWARM_AGENT_CONTAINMENT_DOMAINS` (comma-separated). Unset/empty — or a value
 * that is only separators — keeps {@link DEFAULT_CONTAINMENT_DOMAINS}, because
 * an empty allowlist means "deny all network", which fails every phase.
 */
export function resolveContainmentDomains(
	raw = process.env.SWARM_AGENT_CONTAINMENT_DOMAINS,
): string[] {
	const domains = (raw ?? '')
		.split(',')
		.map((domain) => domain.trim())
		.filter((domain) => domain !== '');
	return domains.length > 0 ? domains : [...DEFAULT_CONTAINMENT_DOMAINS];
}

/**
 * The `-c` overrides that *define* SWARM's codex permission profile. Shared by
 * the harness (which then selects it with {@link codexProfileSelectionArgs})
 * and by the re-runnable containment check (`./containment-check.ts`, which
 * selects it with `codex sandbox -P <profile>`), so the check verifies the
 * profile the harness actually launches rather than a copy of it.
 *
 * `extends = ":workspace"` inherits codex's built-in workspace profile: the
 * Seatbelt/Landlock sandbox that makes `cwd` (plus `/tmp` and `TMPDIR`)
 * writable and everything else read-only. A linked worktree's `.git` pointer
 * targets metadata outside `cwd`, so the run's resolved common git directory
 * is an additional workspace root. That lets the phase's required `git pull`
 * create its FETCH_HEAD, refs, and objects while leaving every non-git path
 * outside the task worktree read-only.
 *
 * `network.enabled = true` re-opens egress, which `:workspace` denies. It has to
 * be a profile key: the legacy `sandbox_workspace_write.network_access` is
 * ignored once a permission profile is active. Egress is **not** scoped per
 * domain here — codex's `-c` dotted-path parser splits on `.`, so a domain key
 * cannot be expressed through an override, and the inline-table form that does
 * parse did not restrict anything when measured. The `allowedDomains` argument
 * therefore governs claude only; see `docs/agent-containment.md`.
 */
export function codexPermissionProfileArgs(cwd?: string): string[] {
	const args = [
		'-c',
		`permissions.${CODEX_PERMISSION_PROFILE}.extends=":workspace"`,
		'-c',
		`permissions.${CODEX_PERMISSION_PROFILE}.network.enabled=true`,
	];
	const gitCommonDir = resolveGitCommonDir(cwd);
	if (gitCommonDir) {
		args.push(
			'-c',
			`permissions.${CODEX_PERMISSION_PROFILE}.workspace_roots={${JSON.stringify(gitCommonDir)}=true}`,
		);
	}
	return args;
}

/** Resolve a worktree's shared git directory without spawning a second process. */
function resolveGitCommonDir(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;

	const dotGit = join(cwd, '.git');
	try {
		if (statSync(dotGit).isDirectory()) return dotGit;

		const gitDirMatch = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
		if (!gitDirMatch) return undefined;
		const gitDir = isAbsolute(gitDirMatch[1]) ? gitDirMatch[1] : resolve(cwd, gitDirMatch[1]);
		const commonDirFile = join(gitDir, 'commondir');
		if (!existsSync(commonDirFile)) return gitDir;

		const commonDir = readFileSync(commonDirFile, 'utf8').trim();
		return isAbsolute(commonDir) ? commonDir : resolve(gitDir, commonDir);
	} catch {
		return undefined;
	}
}

/**
 * The `-c` override that makes SWARM's profile the active one for a
 * `codex exec` run. Deliberately not `-s workspace-write`: codex rejects
 * `sandbox_mode` and `default_permissions` set together, and `codex exec`
 * exposes neither `-P/--permission-profile` nor `-a/--ask-for-approval`
 * (verified against `codex exec --help`, 0.146.1) — `exec` is non-interactive
 * and never asks.
 */
export function codexProfileSelectionArgs(): string[] {
	return ['-c', `default_permissions="${CODEX_PERMISSION_PROFILE}"`];
}

/**
 * The `sandbox` settings blob claude is launched with in `worktree` mode,
 * delivered as a `--settings '<json>'` string so nothing is written to the
 * operator's disk.
 *
 * - `failIfUnavailable` — refuse to run unsandboxed on a host whose sandbox
 *   can't start, instead of quietly reverting to full access.
 * - `allowUnsandboxedCommands: false` — the model cannot ask to step outside.
 * - `autoAllowBashIfSandboxed: true` — the principled replacement for the
 *   bypass: bash is auto-allowed *because* it is sandboxed, so a stdin-closed
 *   run needs no prompt. Paired with `--permission-mode acceptEdits` for the
 *   file-editing tools.
 * - `network.allowedDomains` — claude's sandbox denies all egress by default,
 *   so the phases' `gh`/`git` work needs this allowance (see
 *   {@link DEFAULT_CONTAINMENT_DOMAINS}). Wildcards such as `*.npmjs.org` are
 *   accepted.
 */
function claudeSandboxSettings(allowedDomains: readonly string[]): string {
	return JSON.stringify({
		sandbox: {
			enabled: true,
			failIfUnavailable: true,
			allowUnsandboxedCommands: false,
			autoAllowBashIfSandboxed: true,
			network: { allowedDomains: [...allowedDomains] },
		},
	});
}

/**
 * Resolve the launch arguments that put one run of `cli` under `mode`.
 *
 * Never throws and never returns nothing: a CLI that cannot be contained falls
 * back to `bypass` with {@link AgentContainmentPlan.unavailableReason} set, so
 * the caller can say so in its log rather than the operator believing a run was
 * contained when it wasn't.
 */
export function resolveContainmentPlan(options: {
	cli: AgentCli;
	mode?: AgentContainment;
	allowedDomains?: readonly string[];
	/** The run's worktree, used to allow its linked git metadata under codex. */
	cwd?: string;
}): AgentContainmentPlan {
	const requested = options.mode ?? DEFAULT_AGENT_CONTAINMENT;
	const bypass = (unavailableReason?: string): AgentContainmentPlan => ({
		args: [...BYPASS_ARGS[options.cli]],
		requested,
		applied: 'bypass',
		...(unavailableReason ? { unavailableReason } : {}),
	});

	if (requested === 'bypass') return bypass();

	const allowedDomains = options.allowedDomains ?? resolveContainmentDomains();
	switch (options.cli) {
		case 'claude':
			return {
				args: [
					'--settings',
					claudeSandboxSettings(allowedDomains),
					'--permission-mode',
					'acceptEdits',
				],
				requested,
				applied: 'worktree',
			};
		case 'codex':
			return {
				args: [...codexPermissionProfileArgs(options.cwd), ...codexProfileSelectionArgs()],
				requested,
				applied: 'worktree',
			};
		case 'antigravity':
			return bypass(ANTIGRAVITY_UNAVAILABLE_REASON);
	}
}
