# ADR-003: Worker↔control-plane transport (WebSocket + HTTP), and split delivery

- **Status:** Accepted
- **Issue:** [#391](https://github.com/jkwiecien/swarm/issues/391)
- **Date:** 2026-07-24
- **Decision owners:** SWARM maintainers

> **ADR numbering note.** Issue #391 references
> `ADR-002-worker-transport-and-split-delivery.md §1`, but `ADR-002` on disk is
> `durable-dispatch-state-machine` (issue #284). The transport design had no ADR
> of its own — it lived only in the issue and PROJECT.md §2.2/§3 — so this record
> takes the next free number, **ADR-003**, and documents the decision the stale
> link pointed at.

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
  `fencingToken`, `heartbeatTtlMs`).
- **`GET /worker/stream`** — a WebSocket (via `@hono/node-ws`) carrying periodic
  worker→cloud `heartbeat` frames that refresh the lease (`heartbeat`), and
  releasing the lease on disconnect (`releaseSession`). An ungraceful drop still
  expires via the heartbeat TTL — the existing mechanism.

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
eligibility gate already consumes that signal. The in-process host worker
(`src/worker/index.ts`) is untouched and keeps calling the session service
directly — the transport is a second front door to the same service, so the
single-user/same-machine path is unaffected.

### §2 — Split delivery (implemented — issues #392, #405, #406, #407, #394, #417, #418)

The rest of PROJECT.md §3 — the control plane assigning jobs and the daemon
running them without direct Redis access (`TaskAssignment` →
`TaskExecutionResult`/`StreamLog`) — is now built, gated behind
`SWARM_DISPATCH_MODE=transport` (default `in-process`, so nothing changes until an
operator opts in). It landed across four phases:

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
   `TaskExecutionResult`.
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
   - **Credentials** (ADR-002 §2): **Implementation**'s two board writes and its
     `listBlockers` dependency lookup run under the project's PM credential;
     **Review**'s `submitReview` runs under its reviewer PAT.
   - **The database**: Review's three review-verdict ledger calls
     (`/worker/delivery/review-ledger/prior|mark|abandon`) front the
     `review_verdicts` table, so the two-verdict cap (#235) and the re-review
     signal (#328) keep working on a worker with no `DATABASE_URL` — skipping them
     would silently disable both.

   Both phases join the supported set, so a DB-free worker runs four of the six.
   Then #418 below takes it to five.
   Not carried over: the bounded dependency-recheck deferral, which every transport
   path lacks (`classifyDeferrable` models no dependency failure), so a blocked
   Implementation run settles terminally with the "must be done first" message
   instead of re-checking — safe, but tracked as its own follow-up.
7. **#418** — **`respond-to-review`** joins them, on the same two seams:
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

Still out of scope: **`planning`**, whose PM write/split surface
(`createWorkItem`/`updateWorkItem`/`addLabel`/`addBlockedBy`/`findComment`)
is wider than a delivery seam should carry and stays on the local host worker, and
over-the-wire secret delivery, which remains unnecessary: the split keeps every
project credential server-side instead.

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
