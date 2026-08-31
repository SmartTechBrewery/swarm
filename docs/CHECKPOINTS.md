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
gate, the guaranteed-fresh session, and the prompt that re-seeds it (phase 2/4); the
*policy* that selects it — the `checkpointed` run status, worktree preservation on the strength
of a checkpoint, and the bounded continuation dispatch (phase 3/4, issue #503); and the
*operator surface* that makes it visible and actionable — the status badge, the checkpoint
panel, and the continue/terminate actions (phase 4/4, issue #504). Tier 2 is therefore complete.
The speculative self-checkpoint *trigger* (§ "Rejected") remains unimplemented; the
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
used: they resolve to the host's most-recent session globally, which is racy whenever
two runs overlap on one machine. SWARM always resumes by explicit id.

### (a) Capturing the session id — `src/harness/agent-cli.ts`, `usage.ts`, `antigravity-session.ts`

`AgentCliResult.sessionId` carries the id a run created, captured per CLI:

- **claude** — assigned up front as `--session-id <runId>` and echoed back in the JSON
  output's `session_id`; the harness reads that (falling back to the assigned id). The run id
  is assigned by a *first* attempt only: `claude` refuses to open a second session under an id
  it already used, so an attempt that is not resuming assigns a freshly minted uuid instead —
  automatically in `deriveRetryJobPayload`, and manually in `reconstructRetryJob` (a retry) or
  `reconstructResetJob` (a reset, which always mints one)
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

For the two CLIs that mint their own id, that id is read off the **live** stdout line stream
rather than out of the harness's captured text (`sessionIdFromLine`, `src/harness/usage.ts`,
issue #867), so it survives a run that floods its own output cap. Both announce the id in their
*first* event, while the harness's head buffer stops growing the moment `maxOutputBytes` is hit
and the rolling tail it parses instead — where a trailing usage summary lives — retains only the
*last* bytes: on a truncated run the two windows never overlap and the opening event falls
between them. Every line reaches the live callback exactly once whichever buffer later
truncates, so it is the only window guaranteed to see it; a codex run that logged a large test
suite therefore keeps its thread id instead of losing every downstream resume (the Review
hand-off repair pass, `resolve-conflicts`' migration-journal repair pass, and the
`agent_session_id` a deferred run persists for its retry). The captured text is still asked
first, so a resume run's re-emitted id wins and the non-truncated path is unchanged; a run that
genuinely emitted no opening event still reports **no** id rather than an invented one. `claude`
needs none of this — SWARM assigns its id up front.

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
(`RecoveryModeSchema`, `src/queue/jobs.ts`), alongside Tier 1's `'resume'`, the
start-over `'fresh'`, and — since issue #592 — `'discard'`, the reset intent that
removes a wedged checkout on whichever worker holds it. **Tier 1 still wins whenever a
session id is resumable**: `'checkpoint'` is only for the cases it cannot serve
(§ "When Tier 2 takes over").

A reset carries **no** mode it did not choose itself (issue #741). It restarts the phase as if
it had never run, so its replacement dispatch is built by `reconstructResetJob`
(`src/dispatch/retry-payload.ts`), which drops every member of `RecoveryIntentSchema` — the
session to re-enter, the delivery progress, the provisioned branch, and any stored mode — and
then sets `'discard'`, which since issue #744 is **every** reset's mode rather than a forced
variant's. That is keyed on the schema, so a latch added to the intent is dropped with no edit
there. It also sanitises the run row's stored `job_payload`,
because a reset discards resume intent held in that column as well as in the `recovery` one:
the two latch the same state, and leaving the payload alone let a second reset (or a later
"Retry now") replay it.

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

**A divergence says where the missing work went** (issue #705). The refusal above is correct
but used to be self-defeating: it named the mismatch and not its cause, so the one thing that
routinely causes it — an agent running `git stash` inside its own task worktree, to check
whether a failure predates its change, and being stopped before restoring it — read as
"28 recorded paths, clean tree" with nothing pointing at the stash. Every retry then failed
identically, and recovery meant reading the stash reflog by hand (run
`5a4b2090-46cc-4f5c-ac05-df60a97a2142`, task 699). Two halves close it, and neither touches the
refusal itself:

- **The prompt says not to.** `checkpointInstructions` (`src/pipeline/prompts/checkpoint.ts`)
  now tells the agent never to leave the worktree's changes stashed, gives the reason it cannot
  infer from inside one turn — the run can be stopped without warning and continued by a *fresh
  session in this same worktree* — and names the safe form of the technique: compare against a
  separate checkout rather than mutating this one. It rides with the checkpoint block, so it
  reaches exactly the four phases that write a checkpoint (including `resolve-conflicts`, which
  carries no `GH_IDENTITY_GUARD`) and no phase that does not.
- **The guard diagnoses it.** The two divergences that mean *the recorded work is not in the
  tree* — a clean tree, and recorded paths the tree no longer changes — append a stash report:
  which `refs/stash` entries could hold that work, how many of the checkpoint's paths each
  holds, and the exact `git -C <worktree> stash apply '<ref>'` that restores it. When nothing
  matches it says so plainly, so a stale unrelated stash is never presented as "your work is
  over here". The same finding is logged at `warn`. It runs only on those two branches: a parse
  failure and a wrong-phase checkpoint say nothing about missing work, and an unreadable
  `git status` means git is already broken, so that branch returns before the probe.

Three details of the probe are worth not re-deriving. **An entry matches on its branch *or* its
paths**, because each covers the other's blind spot — a checkout detached at `origin/<branch>`
(issue #558) stashes as `On (no branch)`, so only the paths identify it, while a stash taken
without `-u` holds none of the untracked `added` paths, so only the branch does. The branch it
compares against is the **caller's**, passed down from `adoptCheckpointContinuation`, for the
same reason `resolveReuseHandle` takes it rather than asking git. **It reports; it never acts** —
nothing here can know the stash is this checkpoint's work rather than something older, so
auto-applying could bury the tree under an unrelated diff; SWARM has no `git stash` anywhere in
`src/` other than these read-only probes. And it is **fail-soft**: every git call is wrapped, a
failure yields a clause saying the check could not run, path lists are read for the newest ten
entries only (with the truncation disclosed when it bites), and no path through it can change
the verdict or throw. The refusal is byte-for-byte what it always was — continuing onto a tree
the checkpoint does not describe is what would corrupt or duplicate the work.

The interaction that makes the failure possible is worth stating: `swarm_checkpoint.json` is
gitignored, and `git stash push -u` takes untracked files but not ignored ones — so the stash
swallows every recorded path and leaves the checkpoint behind, which is precisely the state the
guard refuses. `refs/stash` is a *shared* ref living in the main repository rather than in the
linked worktree, which is why the entry survives a pruned worktree and why one `git stash list`
run in the task worktree can find it.

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
(`shouldPreserveFailedCheckout`). The Tier 2 half reads the hand-off file and requires it to parse
and name this phase, matching the settle predicate so a checkout is never retained for a
continuation that will decline it. Comparing the checkpoint against the working tree remains the
continuation gate's job, because that requires git and a phase's `finally` block must not run git.

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

### The operator surface — seeing one and acting on it

A `checkpointed` run is not something to wait out silently: it holds a preserved checkout, has
recorded work left, and spends a bounded budget. So the dashboard renders it as its own state
(issue #504), never folded into `deferred`:

- **Its own badge.** A `Checkpointed` badge in the documented `sky` hue — the label, not the
  colour, carries the meaning (`ai/DESIGN_SYSTEM.md` §1) — with a tooltip saying it is waiting on
  a continuation rather than on quota. Both the Runs table and the run detail page use it, and
  the Status filter offers it. When the stop was a wall-clock kill (`timed_out`, issue #596) the
  same badge reads `Timed out · checkpointed`, keeping the hue and the "not waiting on quota"
  tooltip, so the runs list can answer *which runs hit the timeout* for the resumable statuses a
  timeout actually settles into (issue #600); `deferred` gets the equivalent `Timed out ·
  retrying`.
- **The hand-off itself.** The run detail page shows a **Checkpoint hand-off** panel: the
  remaining work numbered in the order a continuation works through it, what is already
  completed, the decisions carried over, and the working tree the checkpoint recorded — read off
  the persisted `checkpoint` column, so it renders for a federated worker's run too. The panel is
  gated on the checkpoint's *presence*, not on the status, because the column survives an
  ordinary retry as the record of what the current attempt was seeded from. Its spent
  `continuation_count` reads against the project's ceiling, which `runs.getById` resolves
  server-side (`maxContinuations`) so `pipeline.maxContinuations`'s default is never re-declared
  in the web bundle.
- **Continue now / Terminate / Reset & restart.** The same three actions a deferred run offers,
  relabelled for what they actually do here. "Continue now" fires the *existing* `runs.retryNow`
  mutation, which sends a `checkpointed` row through `recoveryMode: 'checkpoint'` unconditionally
  — so a CLI/model override composes with it rather than turning it into a fresh start.
  "Terminate" settles it down the same branch a deferred run takes (`isRetryPendingStatus`), and
  its confirmation says what that abandons. Every guard is server-side; the buttons only mirror
  it, so a hidden button is never the thing keeping an unsafe action from happening.
- **The `checkpoint-divergent` block** gets its own recovery copy in the run detail page's
  recovery callout: unlike a dirty or leased checkout, no amount of tidying restores a hand-off
  the tree no longer matches, so the guidance is to start the phase over rather than to resolve
  and recheck.

### A federated worker reports the same settle

The control plane owns the policy and the budget, but only the worker's host holds the worktree.
So a remote worker parses the checkpoint itself and attaches it to its deferral frame
(`checkpoint` on `TaskExecutionResult`, `src/transport/protocol.ts`); `adaptResultToPhaseRun`
carries it onto the rebuilt `AgentRunError`, and the shared deferral path then applies the
identical policy it applies in-process. The wire `status` stays `deferred` — a continuation *is*
a deferral whose retry happens to run from a checkpoint — so the frame change is additive and
needs no `TRANSPORT_PROTOCOL_VERSION` bump: an older worker simply omits the field.

**And the continuation travels back the same way** (issue #591). The deferral is only half the
split: the checkout the checkpoint describes stays on the worker's host, so the *gate that adopts
it* has to run there too. The control plane therefore sends the run's whole recovery intent —
`agentSessionId`, `resumeSession`, `resumeDelivery`, `implementationBranchProvisioned` and
`recoveryMode` — on the `TaskAssignment` itself, and the worker resolves it into the phase inputs
that reach `executeRecoveryGate` (`src/pipeline/resume.ts`). Additive in this direction too, so
again no version bump: an older router omits `recoveryMode` and an older worker ignores it.

Those five members are declared **once**, as `RecoveryIntentSchema` (`src/queue/jobs.ts`), and
spread into both the job payload and the assignment frame rather than restated on each. That is
deliberate and worth keeping: while they were four hand-maintained copies of each other,
`recoveryMode` was written by "Retry now", "Reset & restart" and the automatic deferral, dropped
at the very first hop, and read by no executor at all — every Tier 2 continuation provisioned
fresh over the preserved checkout and silently re-did the work, which the whole test suite
tolerated because each end was covered and the joint between them was not. The contract test
that now walks the whole hand-off (`tests/unit/transport/recovery-intent-contract.test.ts`)
fails if a member added to that schema does not reach a phase.

**Carrying the intent is necessary but not sufficient — it also has to be sent to the right
machine** (issue #567). The checkpoint file lives in one worker's `.swarm-workspaces/task-<id>`
and nowhere else, so the settle additionally records which machine it is on
(`runs.recovery.preservedWorkerId`) and the dispatch gate offers the continuation only there. If
that machine is unavailable the dispatch waits for it without a timeout rather than continuing
somewhere the checkpoint does not exist — which used to provision a fresh checkout and re-run the
phase from scratch, silently. "Reset & restart" is the deliberate way out: it discards the
checkpoint and the continuation budget as it always did, and now also releases the pin, recording
on the run that the preserved work was abandoned.

A phase that reaches `provisionFresh()` while a preserved checkout — or a checkpoint inside it —
still exists logs a `warn` naming the task, phase and run. That is the backstop for both halves
above: starting over is sometimes legitimate; being unable to tell that it happened is not.

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

**Tier 2 — fallback checkpoint file** (issue #299) — **complete.** The artifact (phase 1/4), the
continuation mechanism (phase 2/4), the policy that selects it (phase 3/4), and the operator
surface (phase 4/4) have all landed. Nothing is outstanding.

**Shared**

- Define phase-specific soft budgets and completion reserves. (The maximum continuation count
  landed with issue #503 as `pipeline.maxContinuations`.)
