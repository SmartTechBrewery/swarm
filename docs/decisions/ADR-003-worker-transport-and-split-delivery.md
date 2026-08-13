# ADR-003: Worker↔control-plane transport (WebSocket + HTTP), and split delivery

- **Status:** Accepted
- **Issue:** [#391](https://github.com/SmartTechBrewery/swarm/issues/391)
- **Date:** 2026-07-24
- **Decision owners:** SWARM maintainers

> **ADR numbering note (corrected 2026-07-25).** This file's original note claimed
> the transport design "had no ADR of its own". That was already wrong when written:
> [ADR-004](./ADR-004-worker-transport-and-split-delivery.md) — filed the same day
> as `ADR-002-worker-transport-and-split-delivery.md`, and since renumbered out of
> its collision with [ADR-002: durable dispatch state machine](./ADR-002-durable-dispatch-state-machine.md)
> — **is** the decision record issue #391 points at.
>
> So the two files divide as follows, and the numbers are chronological rather than
> a dependency order: **ADR-004 is the decision** (§1 transport, §2 split delivery,
> §3 review-trigger re-basing, §4 attribution); **this record is its implementation
> log**, documenting how §1–§2 were built phase by phase and what each phase
> actually shipped. A citation of "ADR-003 §2" means the implementation of split
> delivery; "ADR-004 §2" means the decision that governs it.

## Context

PROJECT.md §3 specifies a future cloud/local split: a hosted control plane
coordinates work without seeing source, and independently operated local daemons
(`swarm-cli`) execute agent CLIs on their operators' machines. That spec pins the
wire protocol to **gRPC** — a single `ConnectAgent` bidirectional stream carrying
`AgentMessage`/`CloudMessage` frames (`HandshakeRequest`, `Heartbeat`,
`TaskAssignment`, `TaskExecutionResult`, `StreamLog`, …). Issue #300 ("gRPC
Bidirectional Control Plane & Local Daemon Client") tracked building that.

The MVP already has everything the *first* slice of that split needs, in-process:

- A worker identity + credential (`src/identity/worker-service.ts`, ADR-001).
- A fenced, TTL-based session lease with heartbeat/release
  (`src/identity/worker-session-service.ts`) — the exact liveness signal the
  eligibility gate (`src/identity/worker-eligibility.ts`, #130) consumes to drop a
  disconnected worker.
- A Cloudflare-tunnel-fronted **router** process that already holds
  `DATABASE_URL` (`docker-compose` `router` service, `docs/cloudflare-tunnel.md`).

What was missing was only the *transport*: a way for a **remote** daemon to reach
that credential→session→heartbeat service over the network instead of calling it
in-process. Standing up a full gRPC stack (protobuf toolchain, a new server
surface, HTTP/2 plumbing through the tunnel) for that one slice is disproportionate
to the MVP, and gRPC's streaming/codegen weight buys nothing the lease liveness
signal requires.

## Decision

### §1 — Transport: authenticated worker-session endpoint on the router (this phase)

Expose the worker transport as **two routes on the existing router Hono app**,
carried over **HTTP + WebSocket** rather than gRPC, reusing the in-process session
service verbatim:

- **`POST /worker/session`** — the handshake (request/response): validate
  `SWARM_WORKER_CREDENTIAL` against the worker roster
  (`resolveWorkerByCredential`), acquire the fenced `worker_sessions` lease
  (`acquireSession`), persist the daemon's declared CLIs
  (`refreshWorkerCapabilities`), and return the session (`sessionId`,
  `fencingToken`, `heartbeatTtlMs`). The request may also carry an optional
  `reclaim` — the `sessionId`/`fencingToken` this daemon already holds (issue
  #608) — which lets it take its *own* live lease back (token still bumped, run
  pointer still cleared) instead of being refused; a caller that presents no
  matching proof still gets `worker session already held`.
- **`GET /worker/stream`** — a WebSocket (via `@hono/node-ws`) carrying periodic
  worker→cloud `heartbeat` frames that refresh the lease (`heartbeat`), and
  releasing the lease on disconnect (`releaseSession`). An ungraceful drop still
  expires via the heartbeat TTL — the existing mechanism — except when the *control
  plane* is what dropped the socket: the returning daemon reclaims its own lease at
  the handshake, so a router restart no longer costs it the TTL (issue #608).

HTTP carries the request/response handshake; the WebSocket carries the
long-lived, low-latency heartbeat stream. The raw credential travels only in the
handshake body and the stream's `Authorization: Bearer` header — never in a URL,
never logged, never reflected in a response body (the `worker-service.ts`
credential contract).

The wire messages get **Zod schemas** (`src/transport/protocol.ts`), the source of
truth per ai/CODING_STANDARDS.md. Their names track PROJECT.md §3's
`AgentMessage`/`CloudMessage` payloads (`HandshakeRequest`/`HandshakeResponse`/
`Heartbeat`) so a later gRPC engine can adopt the same vocabulary. A
`TRANSPORT_PROTOCOL_VERSION` is exchanged both ways so a mismatch is a clean
rejection rather than a silent misparse.

**No scheduler/eligibility/dispatch behavior changes.** The transport only keeps
the existing `worker_sessions` liveness signal fresh over the wire; the
eligibility gate already consumes that signal. When this shipped, the in-process
host worker was untouched and kept calling the session service directly — the
transport was a second front door to the same service. It is now the only one:
issue #553 deleted that worker, and every worker acquires its session through the
handshake (`src/router/worker-transport.ts` → `src/identity/worker-session-service.ts`).

### §2 — Split delivery (implemented — issues #392, #405, #406, #407, #394, #417, #418, #536, #551, #544, #718)

The rest of PROJECT.md §3 — the control plane assigning jobs and the daemon
running them without direct Redis access (`TaskAssignment` →
`TaskExecutionResult`/`StreamLog`) — is now built, and since issue #544 it is how
**every** dispatch runs; there is no mode and no alternative executor. It landed
across the following phases:

1. **#392** — the `TaskAssignment` frame + a non-secret payload builder
   (`src/transport/assignment.ts`): the frame carries the non-secret project-config
   slice, resolved target branch, and composed system prompt — never a persona
   token.
2. **#405** — the connected-worker registry + server→worker push primitive
   (`src/router/worker-connections.ts`): `registerConnection`/`isWorkerConnected`/
   `sendToWorker`, keyed by the live `/worker/stream` socket.
3. **#406** — the worker-side phase runner (`src/worker/transport-client.ts`):
   receive a pushed `TaskAssignment`, run the phase via the shared `runAssignedPhase`
   switch, stream `StreamLog`/`TaskProgress`, and report a terminal
   `TaskExecutionResult`. (**Deleted by issue #551**, item 10 below: the DB-free
   executor from #394/#417/#418 subsumed it, and the control-plane host's worker now
   runs that one over loopback. Its framing helpers had already moved to
   `src/transport/assignment-execution.ts`.)
4. **#407** — the **control-plane dispatcher** (`src/router/dispatcher.ts`): the
   router hosts the BullMQ consumer + ADR-001 eligibility gate and, on selecting a
   connected eligible worker, composes the prompt/branch server-side, pushes the
   assignment, and settles the durable dispatch on the worker's result. `processJob`
   (`src/worker/consumer.ts`) is split into a shared dispatcher half and a pluggable
   phase-execution step (`ProcessJobDeps`), so the in-process and transport paths
   share claim → gate → bind → run-row → settle verbatim; only the execution step
   (run locally vs. push-and-await) and the worker-bind identity differ. With no
   eligible/connected worker the dispatch stays durably `pending` via the existing
   `WorkerIneligibleError` token-free deferral.

All frames now populate the two Zod unions in `src/transport/protocol.ts`
(`WorkerStreamMessageSchema` / `ControlPlaneMessageSchema`). The worker-side
session client (connect with only the credential, reconnect, local CLI discovery)
and the tunnel/env-var docs (`SWARM_CONTROL_PLANE_URL`) shipped as Phase 2 of issue
#391.

The **DB-less remote worker** — once listed here as out of scope — then landed in
three further phases, splitting each phase's delivery by which identity (or which
server-side store) it needs:

5. **#394** — the DB-free executor (`src/transport/assignment-execution.ts`
   `runAssignmentDbFree`): reconstruct the project from the assignment's non-secret
   slice, run source-carrying delivery under the operator's own token
   (`SWARM_OPERATOR_GH_TOKEN`), stream output over the transport only, and cancel
   off the shutdown signal — no `DATABASE_URL`/`REDIS_URL`. A supported-phase gate
   admitted only the two fully-worker-side phases (`respond-to-ci`,
   `resolve-conflicts`).
6. **#417** — everything a DB-free worker cannot perform itself now travels to the
   control plane's delivery API (`src/router/worker-delivery.ts`) through one
   shared client (`src/transport/delivery-client.ts`), authenticated by the
   worker's own credential. Two kinds of thing stay server-side, for two different
   reasons:
   - **Credentials** (ADR-004 §2): **Implementation**'s two board writes and its
     `listBlockers` dependency lookup run under the project's PM credential;
     **Review**'s `submitReview` runs under its reviewer PAT.
   - **The database**: Review's three review-verdict ledger calls
     (`/worker/delivery/review-ledger/prior|mark|abandon`) front the
     `review_verdicts` table, so the review-verdict cap (#235) and the re-review
     signal (#328) keep working on a worker with no `DATABASE_URL` — skipping them
     would silently disable both.

   Both phases join the supported set, so a DB-free worker runs four of the six.
   Then #418 below takes it to five.
   The bounded dependency-recheck deferral is carried over too (**#438**), on the
   same report-and-rebuild split: `classifyDeferrable` maps a `DependencyBlockedError`
   to a `deferred` frame with `failureKind: 'dependency'` plus the still-open
   blockers, and the control plane's result adaptation
   (`adaptResultToPhaseRun`, `src/router/dispatcher.ts`) rebuilds the error from
   them — so the budget stays where the dispatch record is
   (`job.dependencyRecheckAttempt`) and the terminal "must be done first" board
   message is the in-process one, unchanged. Both transport executors inherit it,
   since both frame their failures through `deferrableOrFailedResult`.
7. **#418** — **`respond-to-review`** joins them, on the same two seams (expanding
   the delivery API surface to ten routes; see ADR-004 §2):
   - **A PM read.** The phase resolves its board card before the best-effort
     In progress / In review report. Rather than proxy `listWorkItems` — a whole
     board across the wire to answer a one-card question, and an enumeration a
     worker has no business holding — `PMProvider` gains a narrow
     `findWorkItemByUrlSuffix` (ai/RULES.md §2 "widen the interface"), served by
     `POST /worker/delivery/pm/find-item` under the project's PM credential. The
     match moves inside the provider, so the phase no longer pattern-matches a
     URL shape at all. `listWorkItems` keeps refusing on the write-only provider.
   - **A queue write.** A `fixed` response owes its new commit exactly one
     follow-up Review (issue #241), enqueued *inside* the phase's deterministic
     delivery so a failure defers and the retry re-schedules. That enqueue writes
     a dispatch row and queues a job, so it rides
     `POST /worker/delivery/follow-up-review`, whose deterministic dispatch
     identity makes a re-sent request a no-op rather than a second Review.

   The fix commit, its push, and the response comment stay on the **operator
   token**: that reply is the *implementer* answering the review, and routing it
   through the reviewer-PAT composite would have the reviewer answering itself.
   The board report stays best-effort throughout — a card that can't be resolved
   or moved is logged and skipped, never failing the response.

8. **#535** — worktree provisioning now satisfies #394's DB-free constraint too.
   `GitWorktreeManager` receives a runtime: the same-host path keeps its existing
   Redis lease and Postgres liveness/preservation lookups, while
   `runAssignmentDbFree` injects a host-local filesystem runtime. Atomic lock
   directories + takeover guards serialize provisioners on that machine; local
   preservation pins and the existing dirty/unpushed checks retain resumable work.
   The remote checkout path is also host-owned: `project.repoRoot` no longer rides
   `TaskAssignment`, and the daemon supplies `SWARM_WORKER_REPO_ROOT` (default cwd).
   A real Respond-to-CI phase test runs through provision → agent handoff → delivery
   → cleanup with both `DATABASE_URL` and `REDIS_URL` absent. Each host-local
   artifact carries the expiry the Redis lease got from its TTL, so crash debris is
   reaped by the next provisioner instead of wedging the task (see ADR-004's
   amendment), and provisioning asserts the checkout is the assigned repository
   before it writes anything into it.

9. **#536** — **`planning`** joins them, completing the set: a DB-free remote worker
   now runs **all six** phases, so phase support no longer depends on which machine
   a worker happens to be. The delivery API grows five more PM routes
   (`POST /worker/delivery/pm/{find-comment,create-item,update-item,label,blocked-by}`,
   for sixteen in total, seventeen once #543 added the split's resume lookup and eighteen once #639 added the dependency gate's reverse-edge read; see
   ADR-004 §2), each authenticated and authorized exactly
   as the existing PM routes are, and `createWriteOnlyTransportPmProvider` refuses
   only `getWorkItem` and `listWorkItems` — neither of which any DB-free phase calls.
   The agent run, `proposed_plan.md`, the split contract and the deterministic scope
   gate all stay worker-side; only board metadata crosses.

   **This reverses the original deferral below, on the deferral's own terms.** Width
   was the stated objection, and width alone was never a boundary violation: no
   project PM credential reaches the worker (every board call still executes under
   the server-side credential), the board a worker may write to still comes from its
   authenticated routable enrollment rather than the request body, and each write is
   idempotent or best-effort at the provider. The split's two idempotency mechanisms
   travel unchanged: `findComment` on the plan-delivery marker short-circuits a
   replayed delivery *before* `applySplit` runs, and `PLANNED_LABEL` still marks only
   children whose preparation actually completed.

   **Unchanged is not the same as sufficient, and this move raises the stakes on one
   gap.** The marker that makes a replay a no-op is the *plan comment*, and
   `applySplit` runs **before** that comment is posted — so the guard only covers a
   delivery that got as far as posting. A split that dies partway (a `createWorkItem`
   throwing on child 2 of 3) leaves child 1 on the board with no marker anywhere, and
   the retry re-runs the whole split: child 1 is created a second time. That is
   pre-existing behaviour, identical on the in-process path and not introduced here —
   but `createWorkItem` is the one write outside the per-child `try`, and putting it
   on the wire adds transport failure modes (a 5xx, a socket reset, a control-plane
   restart) to precisely the call whose failure duplicates board structure. Closing it
   needs a change to the split's own idempotency — a marker written before the first
   child, or a resumable split — which is pipeline semantics shared with the same-host
   path, so it is tracked separately rather than smuggled into a transport change.

   **Closed by issue #543, as a resumable split.** Of the two candidates above, the
   marker-before-the-first-child one was rejected on inspection: it makes the retry
   *skip* a split that only got halfway, so the phase succeeds with phases the plan
   promises and the board does not have. Instead every child is created carrying
   `<!-- swarm-split-child:<runId>:<index> -->` in its own body, and each iteration
   resolves that marker before creating anything — a seventeenth route,
   `POST /worker/delivery/pm/find-item-by-marker`, backing the new
   `PMProvider.findWorkItemByDescriptionMarker`, narrow in exactly the sense the
   card-by-URL lookup is (one marker in, at most one card out), so `getWorkItem` and
   `listWorkItems` stay refused. The fix is in `applySplit`, shared by both paths, and
   the board *writes* keep their order; the only addition is the lookup ahead of each
   creation.
   Deliberately **not** taken: relocating `applySplit` behind one coarse
   "apply this split" route. That would carry agent-authored preplan contracts and
   per-child ordering up to the control plane and re-implement Planning's per-child
   failure handling there — moving pipeline logic off the phase that owns it, and
   changing the in-process path this issue had to leave untouched.

   What the deferral cost while it stood: with `planning` excluded, **no machine
   could plan** unless the instance admin's own host was permanently part of the
   deployment. It was the last thing pinning SWARM to a single-machine topology and
   the blocker on a hosted instance where the control plane holds the database and no
   worker does.

10. **#551** — **one worker program.** The control-plane host stopped running an
   executor of its own: its worker is `src/transport/connect-entry.ts` with
   `SWARM_CONTROL_PLANE_URL=http://localhost:<ROUTER_PORT>`, the same program and the
   same code path a remote worker runs, and `src/worker/transport-client.ts` is
   deleted rather than kept "just in case". At the time this landed the in-process
   entry point survived for the opposite mode and refused to start in `transport`,
   naming `npm run dev:worker`, so the queue kept exactly one consumer; item 11
   deleted it and the mode with it.
   Loopback is safe by inspection: only worker-side code reads
   `SWARM_CONTROL_PLANE_URL` — the router publishes its own address as
   `WEBHOOK_CALLBACK_BASE_URL`.

   **The deliberate behavioural delta is the agent's `GH_TOKEN`.** The deleted
   executor resolved a per-project *implementer persona* token from Postgres because
   it happened to be able to; the surviving one uses the operator's own
   `SWARM_OPERATOR_GH_TOKEN`. That is ADR-004 §2's already-taken decision — the
   implementer identity *is* the worker operator's own GitHub account — and issue
   #396 had already removed `implementer` from `ScmCredentialReferencesSchema`, so
   there is no per-project implementer token left to resolve on any host. The
   identities that must stay per-project are untouched: the **reviewer** PAT still
   backs `POST /worker/delivery/review`, so a submitted review's author is unchanged,
   and board writes still run under the project's PM credential control-plane side.

   One consequence outside the executor: the worktree retention sweep must read the
   lease store this host's worker *writes*. In `transport` mode that is the
   host-local filesystem runtime rather than the Redis lease, so
   `retentionWorktreeRuntime` (`src/worktree/retention.ts`) reads it — otherwise the
   sweep would find every checkout unleased and prune one out from under a live
   phase. (It selected the store *by dispatch mode* while both existed; since #553
   the host-local one is the only store any worker writes.)

11. **#544** — **the in-process path is gone**, which is what makes this record's
   §2 the whole story rather than one of two. Six phases: **#544** persisted a
   transport-dispatched run's live output control-plane side (the run page reads the
   same rows either way); **#549** delivered run cancellation to a transport worker
   over the transport as a pushed `task-cancel`, since a DB-free worker has no Redis
   to read the durable marker with; **#550** gave the host worker's three
   non-execution chores a stated owner — the orphaned-`running` reap, CLI
   capability/quota discovery, and the worktree retention sweep moved to the **API
   server** (`src/api/maintenance.ts`), the one process on the control-plane host
   holding `DATABASE_URL`, the operator's PATH, *and* the checkout; **#551** is item
   10 above; **#552** stopped `SWARM_SINGLE_USER_MODE` bypassing the dispatch gate,
   so a single-user install registers and enrolls its one local worker like any
   other; and **#553** deleted the alternative outright.

   #553's deletions: `src/worker/index.ts`; `runPhase`, `resolvePmDelivery` and
   `resolveScmDelivery` in `src/worker/consumer.ts`; the composite
   `createTransportPmDeliveryProvider` (`src/pm/transport-delivery.ts`), whose
   `localDelegate` was the DB-holding worker's in-process provider —
   `createWriteOnlyTransportPmProvider` is now the only PM shape; `DispatchMode` /
   `resolveDispatchMode` / `assertTransportDispatchMode` / `getControlPlaneUrl`
   (`src/lib/env.ts`) and every branch on them, so the router hosts the dispatch
   consumer and runs migrations unconditionally; the `dev:worker:legacy` /
   `dev:worker:legacy:watch` / `start:worker:legacy` scripts; and, once nothing
   imported them, `createLiveOutputRunner` (the in-process live-output DB batcher —
   the control plane persists a transport run's lines instead), `abortRun`,
   `resetProjectSlot`, and `acquireWorkerExecutionSession`.

   `processJob`, the ADR-001 eligibility gate and `runAssignedPhase` stayed: they are
   the shared machine, reached now only from `src/router/dispatcher.ts` (the first
   two) and `src/transport/assignment-execution.ts` (the third).
   `ProcessJobDeps.executePhase` became **required** — there is no in-process default
   to fall back to, and a caller that supplies none is a compile error rather than a
   silent second path. One behavioural consequence, deliberate: `handlePhaseFailure`
   no longer fires recovery CLI-quota discovery on a launch/authentication failure.
   That failure describes the *worker's* PATH and logins; probing the control plane's
   own host would record a bogus status. The refresh belongs to `startHostMaintenance`
   and the on-demand `quota.refreshQuotas`, both of which run where the CLIs are.

12. **#718** — **the back-channel sink spans sessions.** It was a closure over one
   WebSocket session and dropped every frame written after that session ended,
   including a phase's terminal `TaskExecutionResult` — and a phase runs
   independently of the heartbeat loop, so it routinely outlives the session it was
   pushed on. The contract justified the drop with "a reconnect re-pushes the
   assignment and the handler resumes rather than duplicating", **which does not
   cover a dispatch already `state='running'`** — i.e. every dispatch whose phase is
   executing: `handleWorkerStreamOpen` wakes only availability-blocked dispatches and
   `listWakeablePendingDispatches` selects only `retry-scheduled`/`pending` rows, so
   nothing re-pushes a running dispatch and nothing re-attaches a sink to the run
   still executing under it. Confirmed twice on 2026-08-12/13: a one-second socket
   blip discarded a *succeeded* Implementation phase (PR already opened), the row
   stayed `running` for 34 minutes and settled on the back-channel timer as "Worker
   'm5_pro' did not report a result within the lease window", then deferred and
   scheduled a duplicate retry.

   `createAssignmentSink` (`src/transport/worker-client.ts`) now lives for the
   *process*: each session attaches and detaches its own socket, a terminal frame that
   could not be written is held in a bounded, one-per-dispatch queue and flushed on
   the next `attach`, and a re-pushed assignment for a dispatch whose result is still
   held is answered with that result rather than re-running the phase (keyed on the
   *undelivered* set, because `dispatchId` is stable across a manual re-open). No
   control-plane change was needed: its waiter survives the disconnect untouched, and
   `deliverDispatchResult` already consumes the entry, so **exactly-once stays the
   consumer's property** and the worker only has to be at-least-once. Non-terminal
   frames (`stream-log`/`task-progress`/`task-assignment-ack`) are still dropped and
   never queued — output is unbounded, so buffering it would be a memory liability
   with no correctness payoff. What the queue does not close is stated in that
   module's contract comment: a write into a socket whose `close` has not yet fired is
   still lost (sub-second), and a result flushed after the control plane disposed its
   waiter is dropped router-side (bounded by `timeoutMs + RESULT_WAIT_MARGIN_MS`).
   Honest attribution of that second case, and operator-visible liveness, are issue
   #718's phase 2; Terminate settling a run whose phase is no longer executing is its
   phase 3.

Still out of scope: over-the-wire secret delivery, which remains unnecessary — the
split keeps every project credential server-side instead.

> **Superseded by issue #536 (above).** As originally written, this ADR also placed
> **`planning`** out of scope, "whose PM write/split surface
> (`createWorkItem`/`updateWorkItem`/`addLabel`/`addBlockedBy`/`findComment`) is
> wider than a delivery seam should carry and stays on the local host worker." Those
> five methods now have routes and Planning runs anywhere. The paragraph is kept here
> because the enforcement note below is about it, and because the reasoning it was
> reversed on is recorded in item 9 rather than lost.

> **"Stays on the local host worker" was enforced, not merely asserted (issue #467).**
> As originally written that sentence was a statement of fact that no code was
> responsible for. The handshake declared only CLI capabilities, so the control plane
> could not tell a DB-free daemon from a same-host one and would select either for
> `planning`; the DB-free worker then answered with a terminal `status: 'failed'`
> frame carrying no `failureKind`, which the dispatcher rethrows as a plain error —
> no deferral budget, no failover, so the dispatch died even with a capable worker
> connected. The daemon declares its phase repertoire at handshake
> (`HandshakeRequestSchema.supportedPhases`, persisted as `workers.supported_phases`),
> the eligibility gate refuses an incapable candidate (`missing-phase-capability`),
> and the dispatch takes the existing token-free "wait for an eligible worker"
> deferral instead. The worker-side gate stays as the backstop. That machinery is
> what made #536 a one-line widening on the dispatch side: growing
> `SUPPORTED_DB_FREE_PHASES` is all it took, and the declaration and the gate
> followed with no control-plane change. It is not dead code now that every phase is
> supported — an enrollment's `allowedPhases` still narrows what a machine is
> *permitted*, and a daemon predating #536 keeps declaring five.

> **Supersedes issue #300.** #300's gRPC bidirectional control plane is re-scoped:
> the MVP transport is WebSocket + HTTP on the router, not a gRPC stream. The gRPC
> `.proto` in PROJECT.md §3 remains the reference for message *shapes* and stays
> valid as a possible future engine, but is not what the MVP implements.

## Consequences

- A remote daemon establishes and keeps a live worker session using only its
  credential, with no new datastore or protocol stack — just the router's existing
  HTTP surface plus a WebSocket upgrade the Cloudflare tunnel passes through
  transparently.
- The eligibility gate's "stale/disconnected workers are not selectable" property
  holds over the network for free: liveness is the same lease, kept fresh by the
  heartbeat stream and expired by the TTL on disconnect.
- `@hono/node-ws` (plus `ws`) is added as a router dependency; the router entry
  point now injects the WebSocket handler onto the served HTTP server.
- The gRPC design in PROJECT.md §3 is retained as a reference for message shapes
  and a possible future transport, but is explicitly not the MVP's transport.
