# Agent-CLI containment

How far outside its task worktree a SWARM agent run can reach, why the answer
differs per CLI, and what it costs to tighten it.

**Short version:** the default is unchanged — every CLI still launches with its
permission bypass, exactly as SWARM has always run. Two of the three CLIs can be
confined to the task worktree by an OS-level sandbox instead; that is opt-in per
host via `SWARM_AGENT_CONTAINMENT=worktree`, and you should prove it on your own
runs before turning it on. The third (`agy`) cannot be confined today, and the
reason is recorded below rather than left implied by the flag.

Source of truth for the arguments: `src/harness/containment.ts`. Everything in
this document was **measured** on macOS against `claude` 2.1.226, `codex-cli`
0.146.1 and `agy` 1.1.11, in a real SWARM-shaped linked git worktree (its `.git`
a pointer file into `<repo>/.git/worktrees/<name>`) — not inferred from flag
names or docs (`ai/RULES.md` §6).

## Why a bypass was there in the first place

Every run happens in a disposable worktree with **stdin closed**
(`stdio: ['ignore', …]` in `src/harness/agent-cli.ts`), so no permission prompt
can ever be answered. Without something that makes tool calls run unattended, a
run that needs to write a file simply stalls: confirmed live, a Planning run
produced a complete plan, reported the write to `proposed_plan.md` as "blocked
pending your permission approval", and exited **0** having written nothing.

The blanket bypass fixed that and paid for it with everything else: the agent
held the worker user's whole filesystem and network — `$HOME`, `~/.ssh`,
`~/.aws`, every other repo on disk — plus the persona `GH_TOKEN` in its env.
Nothing kept it inside the worktree but `cwd` and the wording of the phase
prompt: convention, not enforcement (issue #614).

Containment replaces the *reason* a tool call is allowed rather than removing
it. Under `worktree`, bash is auto-allowed **because** it is sandboxed.

## Per-CLI verdict

| CLI | Contained? | How | What it costs |
| --- | --- | --- | --- |
| `codex` | **Yes** | A SWARM-owned permission profile supplied through `-c` overrides: `permissions.swarm-worktree.extends=":workspace"` + `.network.enabled=true`, selected with `-c default_permissions="swarm-worktree"`. Its resolved common `.git` directory is an additional workspace root so `git pull` works in a linked worktree. | The task's shared Git metadata is writable, so the agent could alter refs or objects even though every phase prompt forbids committing or pushing. Network is all-or-nothing — no per-domain scoping. Reads outside the worktree stay allowed. |
| `claude` | **Yes** | `--settings '<sandbox json>'` (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed`, `network.allowedDomains`) plus `--permission-mode acceptEdits` | Network is an allowlist, so anything not in `SWARM_AGENT_CONTAINMENT_DOMAINS` fails — an `npm install` on a cold cache included. `/tmp` is not writable (only the session temp dir). Reads outside the worktree stay allowed. |
| `agy` (antigravity) | **No** | — keeps the bypass, and logs a `agent run is not contained` warning when a contained run was requested | See below. |

Codex is the strongest of the three despite its flag being the scariest-sounding
one: it is the only CLI with a real OS-level sandbox (Seatbelt on macOS,
Landlock/bubblewrap on Linux), and
`--dangerously-bypass-approvals-and-sandbox` explicitly switches that sandbox
off. Its own help says the flag is "intended solely for running in environments
that are externally sandboxed" — which an operator's laptop is not.

### Why `agy` cannot be contained

Three separate measurements, all in the linked worktree:

1. **`--sandbox` together with `--dangerously-skip-permissions` contains
   nothing.** A command that must leave the sandbox raises a *distinct*
   `unsandboxed` permission, which the bypass auto-approves. Every capability
   stays allowed, identical to the uncontained baseline. Adding `--sandbox`
   alongside the bypass would look like a fix and buy nothing.
2. **`--sandbox` alone cannot run headless at all.** `agy --sandbox --add-dir
   <worktree> -p "run git status …"` returned:

   > no output produced — a tool required the "command" permission that headless
   > mode cannot prompt for, so it was auto-denied. Add an allow-rule under
   > permissions.allow in settings.json … Alternatively, re-run with
   > `--dangerously-skip-permissions` …

   and exited 0 having done nothing — the exact failure the bypass exists to
   prevent. Unlike claude (`--settings <json>`) and codex (`-c` overrides),
   `agy --help` exposes **no per-invocation way to supply an allow-rule**: the
   only remedy is editing the operator's own
   `~/.gemini/antigravity-cli/settings.json`, which SWARM must not mutate.
3. **Even past that, `--sandbox` denies reads outside the workspace**, and a
   linked worktree's `.git` is a pointer into `<repo>/.git/worktrees/<name>` —
   outside it. `git status`, `git diff` and `git log` are all denied, so the
   phase prompts' git work cannot run.

Worth revisiting if `agy` gains either a per-invocation allow-rule flag or a
read allowance covering the worktree's gitdir target.

## What containment does **not** stop

Containment as adopted is **write-only**. Private ssh keys, `~/.codex/auth.json`,
other repos on disk, and the parent checkout's `.env` all stay *readable* under
both codex (`:workspace` sets a global read root) and claude. So a contained
agent cannot modify anything outside its worktree, and can still read
credentials it has no business reading. Closing that is separate work — claude
exposes `sandbox.filesystem.denyRead`, and codex would need a custom profile's
`filesystem` section.

The persona `GH_TOKEN` is likewise still in the run's env
(`src/harness/agent-cli.ts` passes `{ ...process.env, ...options.env }`); the
sandbox governs the filesystem and the network, not the environment block.

## Network

All three sandboxes deny network by default, and as-is that breaks **every**
phase: each phase prompt runs `gh` reads (`gh issue view`, `gh pr view` /
`gh pr diff`, `gh api`, `gh pr checks`) and most run `git pull --ff-only origin`.
So a contained run re-opens egress deliberately:

- **claude** takes a per-domain allowlist —
  `SWARM_AGENT_CONTAINMENT_DOMAINS`, default `api.github.com,github.com`.
  Wildcards such as `*.npmjs.org` are accepted. A project whose tests fetch
  anything has to widen the list, or those commands fail inside the sandbox.
- **codex** takes all-or-nothing. Its `-c` dotted-path parser splits keys on `.`,
  so a domain key cannot be written as an override at all, and the inline-table
  form that *does* parse did not restrict egress when measured. The domain
  setting therefore has no effect on codex runs.

Note also that codex's legacy `sandbox_workspace_write.network_access` is
**ignored** once a permission profile is active — the profile's own
`network.enabled` is what works.

## Enabling it

1. **Run the check** on the host against a linked task worktree:

   ```bash
   npm run check:containment -- /path/to/.swarm-workspaces/task-123
   ```

   It applies the exact permission profile `src/harness/containment.ts` builds
   for a real run and asserts that a write inside the worktree succeeds, that a
   write to the main checkout and to `$HOME` both fail, and that `git fetch` and
   `api.github.com` still work. It rejects the main checkout rather than giving
   a misleading pass: a linked worktree is where a phase actually runs. It
   drives `codex sandbox -P <profile>`, which runs an ordinary command under the
   sandbox with **no model in the loop** — deterministic, instant, and free — so
   it is re-runnable as often as you like and is the thing to re-run after a CLI
   upgrade. Anything other than a clean pass (including `codex` not being
   installed) exits non-zero.

2. **Set the mode** on the worker host and restart the worker:

   ```bash
   SWARM_AGENT_CONTAINMENT=worktree
   SWARM_AGENT_CONTAINMENT_DOMAINS=api.github.com,github.com   # optional
   ```

   Both are documented in [`docs/configuration.md`](./configuration.md).

3. **Watch a full pipeline.** Containment is a per-host setting precisely so it
   can be adopted one machine at a time: run all six phases on a real item and
   confirm each still completes before rolling it out. A contained run that hits
   a wall fails visibly (a denied write, a refused domain), not silently — but
   an installation whose test suite reaches the network needs its domain list
   widened first.

`SWARM_AGENT_CONTAINMENT` is unset by default, which means `bypass` — today's
behavior — so an installation that does none of the above is unaffected.

## Related

- `src/harness/containment.ts` — the resolved arguments, with the measurement
  behind each one in its comments.
- `src/harness/containment-check.ts` — the re-runnable check above.
- [`docs/decisions/ADR-005`](./decisions/ADR-005-dashboard-chat-with-worker-agent-clis.md)
  — dashboard chat, which has no worktree at all and named these hard-coded
  flags as a prerequisite. `RunAgentCliOptions.containment` is what it opts into.
