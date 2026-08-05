# Work preservation across involuntary agent stops

This document describes how SWARM preserves and resumes an agent's work when a run is cut
short — by a rate limit, a timeout, or another involuntary stop — instead of discarding the
worktree and restarting the phase from scratch. It is a two-tier design:

1. **Primary — native CLI session resume. _Implemented._** Re-enter the same CLI session the
   run was using, so the agent keeps its own context. This now covers all three CLIs
   (`claude`, `agy`, `codex`), every pipeline phase, and both rate-limit and timeout stops.
2. **Fallback — a checkpoint file. _Artifact and continuation mechanism landed; nothing
   selects it yet._** A short, structured handoff written to the worktree for the cases native
   resume cannot cover (session expired/pruned, worktree survived but the session did not, or a
   continuation on a different CLI).

Tier 1 is live. Tier 2's *artifact* exists — the file, its schema, and the prompt that makes
the implementer phases keep it current (issue #299 phase 1/4) — and so does the *mechanism*
that continues a phase from one: the `checkpoint` recovery mode, its validation gate, the
guaranteed-fresh session, and the prompt that re-seeds it (phase 2/4). What is still missing is
the **policy**: nothing in production asks for `recoveryMode: 'checkpoint'`, so the path is not
yet reachable at runtime. The self-checkpoint *trigger* has been dropped from the design
(§ "Rejected"); the resume-from-preserved-state mechanics Tier 2 builds on are proven by Tier 1.

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
  output's `session_id`; the harness reads that (falling back to the assigned id). The run id
  is assigned by a *first* attempt only: `claude` refuses to open a second session under an id
  it already used, so an attempt that is not resuming assigns a freshly minted uuid instead —
  automatically in `deriveRetryJobPayload` and manually in `reconstructRetryJob`
  (`src/dispatch/retry-payload.ts`). Because the flag, not the column, says which meaning the
  id carries, the worker restores a run row's stored session onto a retry only when that retry
  is resuming it (`reuseRunRow`, `src/worker/consumer.ts`).
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

## Tier 2 — the checkpoint file (fallback; artifact and mechanism implemented)

Native resume covers the common case but not every case: the CLI session can expire or be
pruned, the worktree can survive when the session does not, or a continuation may need to
run on a different CLI than the one that started the work. For those, SWARM falls back to a
short, structured checkpoint file written to the worktree — a degraded path that re-seeds a
fresh session with a factual handoff rather than the agent's own context. The file is written
today and the continuation that consumes it is built; what still has to land is the policy that
*asks* for one (below).

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
when it does. Having the agent judge its own remaining budget is the rejected trigger below.

### It is a scratch artifact, never a commit

The filename is registered in `HANDOFF_FILENAMES` (`src/scm/delivery.ts`), which is what puts
it in `SCRATCH_PATHSPECS`: `validatePreparedTree` refuses to deliver a tree where the file is
tracked, `commitPreparedTree` unstages it after its `git add --all`, and worktree cleanliness
checks exclude it when deciding whether a checkout may be reclaimed, freshly retried, or pruned.
It is also listed in `.gitignore` alongside the phase hand-offs. So a checkpoint can never
reach a commit, a pushed branch, or a customer PR — and cannot keep a scratch-only checkout
from being cleaned up. The prompt tells the agent not to `git add` it either.

### Continuing from one — `recoveryMode: 'checkpoint'`

A continuation is the third value of the recovery mode a run carries
(`RecoveryModeSchema`, `src/queue/jobs.ts`), alongside Tier 1's `'resume'` and the
start-over `'fresh'`. **Tier 1 still wins whenever a session id is resumable**: `'checkpoint'`
is for the cases it cannot serve, and nothing selects it yet.

The recovery gate (`executeRecoveryGate`, `src/pipeline/resume.ts`) adopts the preserved
checkout for a continuation only after `validateCheckpointForContinuation`
(`src/pipeline/checkpoint.ts`) confirms three things — otherwise the run settles terminally with
a `BlockedRecoveryError`, having released the worktree lease first:

| Failure | Blocked reason |
| --- | --- |
| The checkout, or the checkpoint file in it, is absent | `missing-validation` |
| The file does not parse against `CheckpointSchema` | `checkpoint-divergent` |
| It names another phase (a task's checkout is reused across phases) | `checkpoint-divergent` |
| It records a path `git status --porcelain` no longer reports as changed | `checkpoint-divergent` |

**The working-tree rule is deliberately one-sided.** A *recorded* path missing from
`git status` blocks (as does a clean tree — the schema guarantees a checkpoint records at least
one path, so a clean tree contradicts it), and the error names the specific missing paths.
*Extra, unrecorded* paths do **not** block: the scratch and hand-off files are untracked, and an
agent enumerating its own edits does not do so perfectly. That fails in the safe direction —
never continue against a tree the checkpoint does not describe — without being brittle about an
honest under-report. The read uses `-z --untracked-files=all` so quoted paths compare literally
and a brand-new untracked directory isn't collapsed to `dir/`, and it scrubs inherited
`GIT_DIR`/`GIT_WORK_TREE`-style variables (`gitEnvironmentForCwd`, `src/scm/delivery.ts`) so
`cwd` alone decides which repository is read.

**A continuation always runs on a fresh session, and never resumes one.** `sessionRunArgs`
forces `{ sessionId, resumeSessionId: undefined }` for the mode unconditionally, and the gate
reports `resumed: false` because no session was re-entered. That is what makes Tier 2
**CLI-agnostic by construction**: with no session to carry, a continuation may run on a
different engine than the deferred run did — `claude` picking up what `agy` started.

The checkpoint's own contents are then the continuation's only context. The four implementer
phases splice `checkpointContinuationSection` (`src/pipeline/prompts/checkpoint.ts`) into their
prompt: the completed steps (not to be redone), the remaining ones in order, the settled
decisions, the working tree it will find, and the instruction that governs them — complete only
the remainder, and do not re-explore settled work unless verification requires it.

## Rejected: soft quota budgets and the self-checkpoint trigger

An earlier draft of this design proposed a second, *voluntary* mechanism: phases would run
with a soft quota budget and a completion reserve, and an agent reaching the soft threshold
would decide mid-run whether it could still finish, then either wind down normally or hand
off and exit at a safe boundary.

**This idea has been dropped and should not be re-proposed.** Both tiers here deliberately
handle only *involuntary* stops — the host cut the run short. The unproven half was the
trigger itself: an agent reliably judging its own remaining budget mid-run and choosing to
stop. Nothing in the two tiers depends on it, so it is not deferred work; it is out of
scope for the design.

## Required future work

**Tier 2 — fallback checkpoint file** (issue #299)

The artifact has landed (issue #299 phase 1/4) and so has the continuation mechanism
(phase 2/4): validation, the fresh sessionless run, and the prompt seeded from the checkpoint.
What still has to land before any of it runs:

- The policy that selects `recoveryMode: 'checkpoint'` — a `checkpointed` run status, preserving
  the worktree because a checkpoint exists, and dispatching the bounded continuation.
- Bound the fallback with a maximum continuation count.
- Add dashboard visibility and an operator action to continue or terminate a checkpointed run.
