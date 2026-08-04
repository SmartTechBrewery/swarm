# ADR-002: One durable dispatch state machine for orchestration

- **Status**: accepted
- **Issue**: [#284](https://github.com/SmartTechBrewery/swarm/issues/284)
- **Date**: 2026-07-18

## Context

SWARM modelled one logical unit of work ("start or resume a pipeline phase") across four
partly independent stores: BullMQ job state, `runs` rows, a Redis pending-continuation
registry used only for project-capacity waits, and the GitHub Projects card status. No
store was canonical, state changes spanned them without an atomic protocol, and a process
stop, queue removal, race, or partial write produced ambiguous orphans that neither the
worker nor the dashboard could explain or repair (issues #269, #279: deferred runs whose
retry job vanished, `running` runs with no live job or worker, queued work invisible to
the Queue UI, `queue:clear` that could not truthfully clear all future work).

## Decision

Introduce a durable, Postgres-backed **dispatch** record (`dispatches` table) as the
single source of truth for every attempt to start or resume a pipeline phase. BullMQ
becomes a delivery/wake-up mechanism only; Redis remains an implementation detail for
locks and queue transport but is never the only durable record of dispatch intent.

### The state machine

```
                       ┌──────────────────────────────┐
   create (outbox) ───▶│           pending            │◀────────┐
                       └──────────────┬───────────────┘         │
                          claim       │                         │ capacity re-defer /
                          (worker)    ▼                         │ manual retry
                       ┌──────────────────────────────┐         │
              ┌────────│            leased            │         │
              │        └──────────────┬───────────────┘         │
              │           run row     │                         │
              │           created    ▼                         │
              │        ┌──────────────────────────────┐         │
              │        │            running           │─────────┤
              │        └──────┬───────────┬───────────┘         │
              │               │           │      defer          │
              ▼               ▼           ▼    (rate-limit,     │
        completed          failed     retry-scheduled ──────────┘
        (also: no-trigger,            (delayed wake-up;          wake-up claims again
        skipped-duplicate,             reconciler repairs
        superseded)                    a lost delayed job)

        pending | retry-scheduled ──cancel──▶ cancelled   (terminal; claims refuse it)
```

Every state transition is a conditional `UPDATE … WHERE state IN (…) RETURNING` — the
row's current state is the only arbiter, so two racing actors (a wake-up job and a manual
retry, a cancel and a slot release) resolve to exactly one winner.

### Key mechanics

- **Identity / idempotency.** `dedup_key` (unique) carries webhook delivery ids
  (`delivery:<X-GitHub-Delivery>`) and deterministic synthetic identities (e.g. the
  follow-up-review hash), so a redelivered webhook or a crash-retried synthetic enqueue
  can never create a second dispatch. A partial unique index allows **at most one
  non-terminal dispatch per `run_id`**, which is the durable duplicate-retry guard: a
  double-clicked "Retry now" or a backfill racing a legacy delayed job hits a constraint,
  not a heuristic.
- **Transactional-outbox hand-off.** Creating a dispatch persists the full validated
  `SwarmJob` payload first; publishing the BullMQ wake-up happens after and is repairable.
  Wake-up job ids are deterministic per (dispatch, wake sequence): every transition back
  into a wakeable state bumps `wake_seq`, so a re-publish is a BullMQ no-op while a
  *stale* completed wake-up id can never suppress a fresh one. A stale wake-up that fires
  anyway is harmless: claiming is atomic and only an eligible `pending`/`retry-scheduled`
  dispatch can be claimed.
- **Leases.** A worker may mark work `running` only after it durably claimed the dispatch
  (`leased`, with `lease_owner` + `lease_expires_at` derived from the effective agent
  timeout plus margin). Startup and periodic reconciliation fail dispatches whose lease
  expired, alongside the existing
  `runs`-row sweeps.
- **Project concurrency** is scheduling on a pending dispatch (`wait_reason =
  'project-capacity'`), not a separate Redis registry. A freed slot selects the next
  eligible dispatch under the existing continuation-priority policy and publishes its
  wake-up; the worker re-checks the slot on claim and re-defers if it lost the race.
- **Retries.** Rate-limit/capacity/timeout/abort/delivery deferrals derive the next
  attempt's payload (session resume, PM dispatch intent, attempt counter) **inside the
  worker's settle path** and persist it on the dispatch as `retry-scheduled` before any
  queue work happens — a crash between settle and enqueue leaves durable, visible,
  reconciler-repairable intent instead of a lost retry. Manual "Retry now" transitions
  the same dispatch back to `pending` (attempt reset, overrides applied to the stored
  payload) and never flips the run row itself — the run flips to `running` only when the
  worker actually claims and starts it, so a failed enqueue can no longer strand a false
  `running` run.
- **Cancellation** (`terminate` on a deferred run, "Put back", `queue clear`) transitions
  the canonical record to `cancelled` first; wake-up removal is best-effort because every
  future delivery path re-checks the state at claim time and refuses terminal dispatches.
  The Redis run-cancellation marker remains for aborting an agent that is already
  executing.
- **Read models.** Queue (`runs.queued`) is dispatch-centric and reads every canonical
  `pending` + `retry-scheduled` dispatch — phase, priority, wait reason, scheduled time,
  linked run — never a BullMQ snapshot. Runs (`runs.list`) is run-centric and reads
  persisted attempt/audit rows by their normal lifecycle, but hides a `deferred` attempt
  linked to a pending or retry-scheduled dispatch to avoid displaying a duplicate row
  (issues #279/#316). A dispatch without a `runId` remains Queue-only because it has not
  created an attempt yet.
- **PM board status** stays an external workflow signal: phases keep reporting card moves,
  but nothing infers dispatch existence from the board.

### Migration / backfill

On worker startup (after schema migration, before serving jobs), reconciliation:

1. fails `leased`/`running` dispatches left by a dead process (their linked runs are
   settled by the existing orphaned/stale run sweeps);
2. imports legacy Redis `swarm:pending-continuations:*` entries as capacity-pending
   dispatches, then deletes the Redis keys;
3. creates `retry-scheduled` dispatches for `deferred` runs that have no active dispatch
   (the stored `job_payload` is the retry intent — this repairs the exact #269/#279
   orphans), scheduled at their recorded `next_retry_at` or now;
4. re-publishes wake-ups for every due `pending`/`retry-scheduled` dispatch (deterministic
   ids make this idempotent).

Legacy BullMQ jobs enqueued before the deploy carry no `dispatchId`; the worker adopts
them at dequeue — claiming the run's active dispatch when one exists (so a backfilled
dispatch and a surviving legacy delayed job resolve to one run), otherwise creating the
dispatch record in `leased` directly.

### Retired

- `src/worker/pending-continuations.ts` (Redis pending-continuation registry, claims and
  lease Lua scripts) — absorbed by capacity-pending dispatches.
- `src/worker/deferred-retry.ts` — retry-payload derivation moved into the worker's
  dispatch settle path; the enqueue-time cancellation double-checks are unnecessary now
  that claims refuse cancelled dispatches.
- BullMQ-snapshot queue introspection as the Queue API source
  (`listPendingJobs`/`toQueuedRuns` from job data), `promoteRetryForRun`,
  `removePendingRetryForRun`, `enqueuePendingDispatch`, `scheduleCoalescedJob`,
  `enqueueDelayedRetry` — replaced by dispatch transitions plus one deterministic wake-up
  publisher.
- `swarm queue clear` now cancels canonical dispatches (and clears their wake-ups); the
  old BullMQ-only behavior is gone because it could not truthfully clear durable intent.

### Out of scope (for this change)

The Review merge-follow-up queue (issue #278) already satisfies the dispatch invariants
on its own: durable intent lives in `runs.review_merge_*` columns, wake-ups use
deterministic job ids, and startup recovery re-publishes lost jobs. It never starts an
agent, so it stays a separate small mechanism rather than being forced through the
`SwarmJob` dispatch model; folding it in remains possible later.

> **Superseded by issue #292.** Merge automation is now a first-class dispatch kind:
> a `merge-automation` `SwarmJob` (dedup key `merge:<reviewRunId>`, linked to the
> approving Review run) is persisted by the worker's Review success path and executed —
> as a direct PAT merge through the provider-neutral `ScmMergeProvider`, never GitHub's
> native auto-merge — by `processMergeAutomationDispatch` (`src/worker/merge-automation.ts`),
> with transient `not-ready` outcomes retried via `retry-scheduled`. The standalone
> `swarm-merge-follow-ups` queue and its worker are retired; startup reconciliation
> imports leftover `not-ready` intent as merge dispatches and drains the old queue.

## Consequences

- It is impossible to observe a normal `running` run without a corresponding
  `leased`/`running` dispatch (worker creates/resets run rows only after a claim), except
  within the bounded window a lease expiry + sweep repairs.
- Every pending/retryable unit of work is one queryable row with an explicit state and
  wait reason; the Queue UI can explain all of it.
- A process kill at any hand-off boundary (persist→enqueue, dequeue→claim, claim→run,
  defer→reschedule, cancel→remove) is recovered deterministically: either the durable
  state was already written (reconciler re-publishes) or it was not (the previous durable
  state still governs), and duplicate agent invocation is excluded by atomic claims and
  the one-active-dispatch-per-run constraint.
- The router does not run migrations; if the `dispatches` table is unavailable it falls
  back to enqueueing a legacy (dispatch-less) job, which the worker adopts — a webhook is
  never dropped because the dispatch layer was mid-deploy.
