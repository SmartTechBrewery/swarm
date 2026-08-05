# Work preservation across involuntary agent stops

This document describes how SWARM preserves and resumes an agent's work when a run is cut
short — by a rate limit, a timeout, or another involuntary stop — instead of discarding the
worktree and restarting the phase from scratch. It is a two-tier design:

1. **Primary — native CLI session resume. _Implemented._** Re-enter the same CLI session the
   run was using, so the agent keeps its own context. This now covers all three CLIs
   (`claude`, `agy`, `codex`), every pipeline phase, and both rate-limit and timeout stops.
2. **Fallback — a checkpoint file. _Implemented._** A short, structured handoff written to
   the worktree for the cases native resume cannot cover (session expired/pruned, worktree
   survived but the session did not, or a continuation on a different CLI).

Both tiers are live. Tier 2 arrived in phases: the *artifact* — the file, its schema, and the
prompt that makes the implementer phases keep it current (issue #299 phase 1/4); the
*mechanism* that continues a phase from one — the `checkpoint` recovery mode, its validation
gate, the guaranteed-fresh session, and the prompt that re-seeds it (phase 2/4); and now the
*policy* that selects it — the `checkpointed` run status, worktree preservation on the strength
of a checkpoint, and the bounded continuation dispatch (phase 3/4, issue #503). What is left is
operator surface only: dashboard rendering and a "continue or terminate" action (phase 4/4).
The speculative self-checkpoint *trigger* (§ "Soft budget") remains unimplemented; the
resume-from-preserved-state mechanics Tier 2 builds on are proven by Tier 1.

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

## Tier 2 — the checkpoint file (fallback; implemented)

Native resume covers the common case but not every case: the CLI session can expire or be
pruned, the worktree can survive when the session does not, or a continuation may need to
run on a different CLI than the one that started the work. For those, SWARM falls back to a
short, structured checkpoint file written to the worktree — a degraded path that re-seeds a
fresh session with a factual handoff rather than the agent's own context.

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

### Continuing from one — `recoveryMode: 'checkpoint'`

A continuation is the third value of the recovery mode a run carries
(`RecoveryModeSchema`, `src/queue/jobs.ts`), alongside Tier 1's `'resume'` and the
start-over `'fresh'`. **Tier 1 still wins whenever a session id is resumable**: `'checkpoint'`
is only for the cases it cannot serve (§ "When Tier 2 takes over").

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

### When Tier 2 takes over — `checkpointFallbackApplies`

The selection rule (`src/pipeline/resume.ts`, issue #503) has two conditions, and the first is
Tier 1's absolute priority:

1. The stop is one a continuation can pick up: the same `rate-limit` / `timeout` / `stalled` set
   `shouldPreserveForResume` accepts. Nothing else — a hard error, a worker-shutdown abort, a
   provider-capacity banner, a logged-out CLI — ever becomes a continuation.
2. Tier 1 cannot serve it, which is true in exactly two cases:
   - the run captured **no** session id, so there is nothing to resume; or
   - **this attempt was itself the resume** of one and failed anyway — the "session expired or
     was pruned" case. Every CLI reports back the id it was *asked* to resume
     (`resolveSessionId`, `src/harness/agent-cli.ts`), so once a resume has failed, a present id
     is no longer evidence that resuming works. Re-resuming would fail the same way, so the
     checkpoint takes over instead of the checkout being discarded.

A *first*, non-resume stop that did capture a session id is Tier 1's, unchanged — that ordering
is the regression the unit suite pins.

Each of the four implementer phases then keeps its checkout when *either* tier can use it
(`shouldPreserveFailedCheckout`). The Tier 2 half is deliberately shallow — it only asks whether
the file is *there*, because a phase's `finally` block must not run git: parsing is the settle
path's job and comparing against the tree is the continuation gate's.

### Settling `checkpointed`, and the bounded continuation

A selected fallback settles the run as its own retry-pending status rather than reusing
`deferred`, so every read model can tell "waiting to resume its session" from "waiting to
continue from a checkpoint":

| Column | On a `checkpointed` settle |
| --- | --- |
| `status` | `checkpointed` — retry-pending, **not** terminal |
| `agent_session_id` | `null` — there is deliberately no session to resume |
| `checkpoint` | the parsed hand-off, so the API/dashboard can show the remaining work without reading a (possibly remote) worker's filesystem |
| `continuation_count` | incremented; kept through an ordinary retry, cleared only by "Reset & restart" |
| `next_retry_at` | the scheduled continuation, exactly as for a deferral |

The continuation itself goes out through the **existing durable dispatch** — the same machinery
that carries `resumeSession` — with `recoveryMode: 'checkpoint'` and a freshly minted
`agentSessionId` (`deriveRetryJobPayload`, `src/dispatch/retry-payload.ts`). A stale
`'checkpoint'` mode is dropped from a retry that can resume a session again, so one continuation
cannot make every later attempt adopt a checkpoint.

Because a `checkpointed` row has no `agentSessionId`, anything that keyed retry-pendingness on
that column had to learn the status instead. The one that matters is **retention pinning**:
`hasResumableDeferredRun` (`src/db/repositories/runsRepository.ts`) now pins a checkout when a
session id *or* the `checkpointed` status says a run intends to come back — pruning it would
delete the very working tree the checkpoint describes, turning the continuation into a
`checkpoint-divergent` block.

**The fallback is bounded.** `pipeline.maxContinuations` (default 2, `docs/configuration.md`) is
the number of times one run may be continued this way; the count lives on the run row. Once it
is spent, the next involuntary stop is a terminal failure whose reason and
`FailureDiagnosis` both say the continuation budget was exhausted, rather than a further
hand-off. A continuation also consumes an ordinary rate-limit retry attempt, so the coarser
`MAX_RATE_LIMIT_RETRIES` cap still applies underneath.

### A federated worker reports the same settle

The control plane owns the policy and the budget, but only the worker's host holds the worktree.
So a remote worker parses the checkpoint itself and attaches it to its deferral frame
(`checkpoint` on `TaskExecutionResult`, `src/transport/protocol.ts`); `adaptResultToPhaseRun`
carries it onto the rebuilt `AgentRunError`, and the shared deferral path then applies the
identical policy it applies in-process. The wire `status` stays `deferred` — a continuation *is*
a deferral whose retry happens to run from a checkpoint — so the frame change is additive and
needs no `TRANSPORT_PROTOCOL_VERSION` bump: an older worker simply omits the field.

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

Tier 2 runs end to end as of issue #503 (phase 3/4): the artifact (phase 1/4), the continuation
mechanism (phase 2/4), and the policy that selects it. What is left is operator surface:

- Dashboard visibility for a `checkpointed` run — its recorded remainder, its spent continuation
  count — and an operator action to continue or terminate it (phase 4/4).

**Shared**

- Define phase-specific soft budgets and completion reserves. (The maximum continuation count
  landed with issue #503 as `pipeline.maxContinuations`.)
