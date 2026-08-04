# Work preservation across involuntary agent stops

This document describes how SWARM preserves and resumes an agent's work when a run is cut
short — by a rate limit, a timeout, or another involuntary stop — instead of discarding the
worktree and restarting the phase from scratch. It is a two-tier design:

1. **Primary — native CLI session resume. _Implemented._** Re-enter the same CLI session the
   run was using, so the agent keeps its own context. This now covers all three CLIs
   (`claude`, `agy`, `codex`), every pipeline phase, and both rate-limit and timeout stops.
2. **Fallback — a checkpoint file. _Deferred._** A short, structured handoff written to the
   worktree for the cases native resume cannot cover (session expired/pruned, worktree
   survived but the session did not, or a continuation on a different CLI).

Tier 1 is live. Tier 2 and the speculative self-checkpoint *trigger* (§ "Soft budget")
remain unimplemented; the resume-from-preserved-state mechanics Tier 2 would build on are
proven by Tier 1.

## Tier 1 — native CLI session resume (implemented)

All three agent CLIs support non-interactive session resume — verified live against each
CLI's `--help` and by an end-to-end resume:

| CLI | Non-interactive resume | Resume by explicit ID | Assign ID upfront |
| --- | --- | --- | --- |
| `claude` | `claude -p --resume <id>` | yes: `--resume <id>` | yes: `--session-id <uuid>` |
| `agy` (Antigravity) | `agy --print --conversation <id>` | yes: `--conversation <id>` | no upfront flag |
| `codex` | `codex exec resume <id> <prompt>` | yes: positional `SESSION_ID` | no upfront flag |

The "most recent" shortcuts (`codex --last`, `agy -c`/`--continue`) are deliberately **not**
used: they resolve to the host's most-recent session globally, which is racy under
concurrent workers (`SWARM_WORKER_CONCURRENCY > 1`). SWARM always resumes by explicit id.

### (a) Capturing the session id — `src/harness/agent-cli.ts`, `usage.ts`, `antigravity-session.ts`

`AgentCliResult.sessionId` carries the id a run created, captured per CLI:

- **claude** — assigned up front as `--session-id <runId>` and echoed back in the JSON
  output's `session_id`; the harness reads that (falling back to the assigned id).
- **codex** — `codex exec --json` emits `{"type":"thread.started","thread_id":"…"}` as its
  first stdout line; `parseAgentOutput` lifts the `thread_id`. A resume re-emits the same id.
- **agy** — has no assign flag, but `agy --output-format stream-json` prints a
  `conversation_id` in its opening `init` event and repeats it on every record after, so
  `parseAgentOutput` lifts it from there (issue #465). The empty string a *failed* run
  reports is rejected, so a failure falls back to the id its `init` event named.
  `antigravity-session.ts` is now the **fallback** for the two cases that stream can't
  cover — an `agy` predating `--output-format` (1.1.3), and a run killed before its opening
  event was captured. It snapshots the conversation store
  (`~/.gemini/antigravity-cli/conversations/<id>.db`, overridable via
  `SWARM_ANTIGRAVITY_CONVERSATIONS_DIR`) immediately before spawn and diffs it at close; the
  new `.db` basename is the conversation id. Concurrent runs are **not** disambiguated: more
  than one new `.db` makes the diff ambiguous and capture deliberately gives up rather than
  guess, since resuming a sibling task's session is worse than starting fresh.

### (b) Per-CLI resume-arg shape — `buildSessionArgs` in `agent-cli.ts`

The CLIs don't share flag semantics (`ai/RULES.md §6`), so resume is shaped per CLI:

- **claude / agy insert a flag** — `--resume <id>` / `--conversation <id>`.
- **codex changes the argv shape** — `codex exec resume <id> …` replaces `codex exec …`.
  Resume is a *subcommand*, not a flag.

### (c) Preserve, persist, resume — the phase + worker path

- Each phase (via the shared `src/pipeline/resume.ts`) keeps its worktree instead of
  cleaning it up when a run fails on a `rate-limit`, a `stalled` response, or a genuinely-interrupted `timeout`
  **and** captured a session id (`shouldPreserveForResume`); it reuses that checkout on the
  retry so partial edits and the session carry over.
- `src/worker/consumer.ts` persists the captured id on the deferred `runs` row
  (`agent_session_id`), the deferral carries a `resumeSession` flag, and the retry threads
  the id back as the CLI's resume id across every phase.
- Retention (`hasResumableDeferredRun`) pins any deferred run's checkout — any phase, any
  engine — until the retry runs; a pruned checkout or an uncaptured session falls back to a
  fresh invocation.

A timeout that trapped SIGTERM and still exited 0 is the one exception: its phase already
finished and cleaned up its worktree, so it stays a terminal failure rather than resuming
onto a checkout that no longer exists.

## Tier 2 — the checkpoint file (fallback, deferred)

Native resume covers the common case but not every case: the CLI session can expire or be
pruned, the worktree can survive when the session does not, or a continuation may need to
run on a different CLI than the one that started the work. For those, SWARM should fall back
to a short, structured checkpoint file written to the worktree — a degraded path that
re-seeds a fresh session with a factual handoff rather than the agent's own context.

The checkpoint is a safe handoff point, not a hard token-limit termination: the agent writes
it and exits cleanly at a safe boundary (never in the middle of an edit or command). A
continuation validates the actual worktree, reads the checkpoint first, and completes only
the recorded remainder — it must not re-explore or redesign completed work unless
verification shows it is necessary.

### Checkpoint contents

The handoff should be short and factual:

```md
# Implementation checkpoint

## Completed
- Added `ProjectConfigSchema.retryPolicy` and focused validation tests.

## Remaining
- Update the README configuration table.
- Run lint, type-check, and `tests/unit/config/schema.test.ts`.
- Commit, push, and open the PR.

## Decisions / caveats
- Storage-migration coverage is out of scope for this item.

## Working-tree state
- Modified: `src/config/schema.ts`, `tests/unit/config/schema.test.ts`
```

## Soft budget, completion reserve, self-checkpoint trigger (speculative)

Tier 1 covers *involuntary* stops (the host cut the run short). A separate, more speculative
idea is to have an agent *voluntarily* wind down before a budget is exhausted:

1. A phase runs with a soft quota budget and a small completion reserve.
2. At the soft threshold, the agent stops starting broad investigation, refactors, or new
   optional work, and decides whether it can finish verification and its phase handoff
   within the reserve.
3. If it can, it receives one bounded grace period and completes normally. If it cannot, it
   either lets the session be preserved for native resume (Tier 1) or writes a checkpoint
   file (Tier 2) and exits at a safe boundary.

The **self-checkpoint trigger** — an agent reliably deciding mid-run to wind down and hand
off — is the unproven part of this design. The *resume-from-preserved-state* half is not:
it now ships as Tier 1. Treat the trigger as a later experiment.

## Required future work

**Tier 2 — fallback checkpoint file**

- Define a checkpointed run status and a durable continuation job for the fallback path.
- Validate the checkpoint file and working tree before a fallback continuation.
- Support a cross-CLI continuation seeded from the checkpoint file.

**Shared**

- Define phase-specific soft budgets, reserves, and a maximum continuation count.
- Add dashboard visibility and an operator action to continue or terminate a checkpointed run.
