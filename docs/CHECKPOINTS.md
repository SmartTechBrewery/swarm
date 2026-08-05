# Work preservation across involuntary agent stops

This document describes how SWARM preserves and resumes an agent's work when a run is cut
short — by a rate limit, a timeout, or another involuntary stop — instead of discarding the
worktree and restarting the phase from scratch. It is a two-tier design:

1. **Primary — native CLI session resume. _Implemented._** Re-enter the same CLI session the
   run was using, so the agent keeps its own context. This now covers all three CLIs
   (`claude`, `agy`, `codex`), every pipeline phase, and both rate-limit and timeout stops.
2. **Fallback — a checkpoint file. _Artifact landed; continuation deferred._** A short,
   structured handoff written to the worktree for the cases native resume cannot cover
   (session expired/pruned, worktree survived but the session did not, or a continuation on a
   different CLI).

Tier 1 is live. Tier 2's *artifact* now exists — the file, its schema, and the prompt that
makes the implementer phases keep it current (issue #299 phase 1/4, below); nothing reads it
yet, so the continuation path is still to build. The speculative self-checkpoint *trigger*
(§ "Soft budget") remains unimplemented; the resume-from-preserved-state mechanics Tier 2
builds on are proven by Tier 1.

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

## Tier 2 — the checkpoint file (fallback; artifact implemented)

Native resume covers the common case but not every case: the CLI session can expire or be
pruned, the worktree can survive when the session does not, or a continuation may need to
run on a different CLI than the one that started the work. For those, SWARM falls back to a
short, structured checkpoint file written to the worktree — a degraded path that re-seeds a
fresh session with a factual handoff rather than the agent's own context. The file is written
today; the continuation that consumes it is the remaining work (below).

The checkpoint is kept current at safe boundaries (never in the middle of an edit or command),
not written as a wind-down step before the agent exits. That way an involuntary stop finds an
up-to-date handoff. A continuation validates the actual worktree, reads the checkpoint first,
and completes only the recorded remainder — it must not re-explore or redesign completed work
unless verification shows it is necessary.

### Checkpoint contents

The handoff is `swarm_checkpoint.json` at the worktree root — short, factual, and validated by
`CheckpointSchema` (`src/pipeline/checkpoint.ts`):

```json
{
  "phase": "implementation",
  "completed": ["Added `ProjectConfigSchema.retryPolicy` and focused validation tests."],
  "remaining": [
    "Update the README configuration table.",
    "Run lint, type-check, and `tests/unit/config/schema.test.ts`.",
    "Write the implementation hand-off file."
  ],
  "decisions": ["Storage-migration coverage is out of scope for this item."],
  "workingTree": {
    "modified": ["src/config/schema.ts", "tests/unit/config/schema.test.ts"],
    "added": [],
    "deleted": []
  }
}
```

Three constraints are deliberate. `phase` is required because a task's checkout is reused
across phases, so a continuation can reject a checkpoint another phase left behind. `remaining`
must be non-empty — a phase with nothing left finished, and wrote its real hand-off instead.
`workingTree` must name at least one path: it is what a continuation compares against
`git status --porcelain`, and a checkpoint describing an empty tree describes nothing worth
continuing. `decisions` and the three `workingTree` arrays default to empty.

### Which phases write it

The four phases that edit a worktree — **Implementation**, **Respond-to-review**,
**Respond-to-CI**, and **Resolve-conflicts** — carry one shared instruction block
(`src/pipeline/prompts/checkpoint.ts`) telling the agent to rewrite the file at every safe
boundary. **Planning** and **Review** do not: Planning has no partial-edit state to hand over,
and Review makes no worktree edits.

The instruction is deliberately a *rolling* one rather than a wind-down the agent decides to
perform — an involuntary stop arrives without warning, so the file has to already be current
when it does. Having the agent judge its own remaining budget is the speculative trigger below.

### It is a scratch artifact, never a commit

The filename is registered in `HANDOFF_FILENAMES` (`src/scm/delivery.ts`), which is what puts
it in `SCRATCH_PATHSPECS`: `validatePreparedTree` refuses to deliver a tree where the file is
tracked, `commitPreparedTree` unstages it after its `git add --all`, and worktree cleanliness
checks exclude it when deciding whether a checkout may be reclaimed, freshly retried, or pruned.
It is also listed in `.gitignore` alongside the phase hand-offs. So a checkpoint can never
reach a commit, a pushed branch, or a customer PR — and cannot keep a scratch-only checkout
from being cleaned up. The prompt tells the agent not to `git add` it either.

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

The artifact itself has landed (issue #299 phase 1/4): the file, its schema and reader, and the
implementer-phase prompts that keep it current. What still reads and acts on it:

- Validate the checkpoint file and working tree before a fallback continuation, and support a
  cross-CLI continuation seeded from it.
- Define a checkpointed run status, preserve the worktree because a checkpoint exists, and
  dispatch the bounded continuation.

**Shared**

- Define phase-specific soft budgets, reserves, and a maximum continuation count.
- Add dashboard visibility and an operator action to continue or terminate a checkpointed run.
