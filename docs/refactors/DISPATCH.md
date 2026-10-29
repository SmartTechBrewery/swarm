# Durable dispatch refactor

## Purpose

PR #285 replaces the previous split representation of pending pipeline work
with one durable dispatch state machine. It addresses failures in which the
queue, a `runs` row, the Redis pending-continuation registry, and a GitHub
Projects status could disagree about whether work should still start.

The refactor is implemented by `dispatches` in Postgres. A BullMQ job is now a
wake-up for a dispatch record, not the source of truth for the intent to run a
phase.

The detailed state-machine decision and migration semantics are in
[`ADR-002`](../decisions/ADR-002-durable-dispatch-state-machine.md).

## Problems addressed

- A process stop between recording a deferred run and enqueueing its retry
  could leave a retryable run with no future job.
- Project-capacity waits lived in a Redis-only registry and were absent from
  the Queue UI.
- Cancelling queued work removed a BullMQ job but could not reliably prevent a
  retry, slot release, or redelivery from bringing it back.
- Queue state was inferred from several stores, making recovery and operator
  actions ambiguous after a crash or restart.

## Scope

The following paths create, transition, or wake a durable dispatch:

- incoming SCM and PM webhooks;
- synthetic PM dispatches after Planning auto-advances to Implementation and
  for Planning split children;
- follow-up Review after a Respond-to-review fix;
- coalesced Review/check-suite and conflict-resolution rechecks;
- project capacity waits and continuation priority (both retired by issue #1190,
  together with the project-wide job cap they served);
- agent/provider/delivery deferrals and their delayed retries;
- dashboard Retry now, Terminate, Put back, and `swarm queue clear`;
- startup and periodic reconciliation, including import of legacy deferred
  runs and pending continuations.

Every normal worker pickup atomically claims the dispatch before it resolves a
trigger or starts an agent. Terminal dispatches refuse late wake-ups, so an old
job cannot resurrect cancelled, completed, failed, or superseded work.

## Workflow behaviour preserved

This is an orchestration-durability refactor, not a change to pipeline policy.
The following existing options and branches keep their prior semantics:

- Planning `autoAdvance` behaviour and Implementation's Review-enabled status report;
- regular versus `implementationUnplanned` agent configuration, selected from
  whether Planning has already run for the work item;
- review checks policy (`required` and `if-present`);
- `respondToCi.enabled` and its bounded CI-fix loop;
- `respondToReview.skipOnMinors` and the review-verdict safety cap;
- per-project concurrency and optional continuation priority;
- phase/session resumption and the Implementation branch-provisioning
  checkpoint.

## Merge automation (updated by issue #292)

Originally the Review merge follow-up was left outside the
`SwarmJob`/`dispatches` model as a separate durable mechanism (its own
`swarm-merge-follow-ups` queue). Issue #292 folded it in: merge intent is now
a `merge-automation` dispatch (dedup key `merge:<reviewRunId>`, linked to the
approving Review run) executed by `src/worker/merge-automation.ts` as a
direct implementer-PAT merge through the provider-neutral `ScmMergeProvider`
— GitHub's native auto-merge is never requested. It remains the one dispatch
kind that never starts an agent phase; outcomes still persist on the Review
run's `review_merge_*` columns.

## Non-goals

This change does not implement multi-user authentication, federated-worker
routing, project memberships, worker enrollment, or worker-owner sharing
consent. Those are separate future work described by ADR-001 and issues
#130, #132, #281, and #282.
