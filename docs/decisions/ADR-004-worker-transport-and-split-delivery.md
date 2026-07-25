# ADR-004: Worker↔control-plane transport and split GitHub delivery

- **Status:** Accepted — §1, §2, §3, and §4 implemented
- **Date:** 2026-07-24 (renumbered 2026-07-25)
- **Decision owners:** SWARM maintainers
- **Builds on:** [ADR-001](./ADR-001-federated-workers-and-project-access.md)
- **Implementation record:** [ADR-003](./ADR-003-worker-transport-and-split-delivery.md)

> **Renumbering note.** This record was originally filed as `ADR-002`, colliding
> with [ADR-002: durable dispatch state machine](./ADR-002-durable-dispatch-state-machine.md)
> (issue #284) — two accepted ADRs shared one number, so a citation of "ADR-002 §2"
> was ambiguous. It takes the next free number, **ADR-004**; every code and doc
> citation that meant *this* document was rewritten accordingly, and bare
> `ADR-002` citations (all of which mean the durable-dispatch record) were left
> alone. **The numbering is chronological, not a dependency order:** ADR-003 is
> the phase-by-phase *implementation* record for §1–§2 of this decision, written
> while this file was still numbered ADR-002.

## Context

SWARM is moving from a single-machine MVP toward a hosted instance
(`swarm.smarttechbrewery.pl`) where trusted users — created by the instance
admin — run their own workers against shared projects, starting with SWARM
itself. ADR-001 already models the *policy* layer for this (users, workers,
enrollments, memberships, sharing consent, discoverable projects, assignee
identity links). What it does **not** cover is the two mechanics that actually
block a worker from running on a machine other than the one hosting the stack:

1. **Transport.** The worker connects to Postgres and Redis **directly**. It
   runs migrations (`src/worker/index.ts` imports `runMigrations`), opens a raw
   `pg.Pool` (`src/db/client.ts`), and pulls jobs as a BullMQ `Worker`
   (`src/worker/index.ts:245`) parsed from `REDIS_URL`. There is no HTTP/RPC
   boundary between the worker and the stack. A remote worker would therefore
   need `DATABASE_URL`/`REDIS_URL` reachable — i.e. the operator would have to
   hand contributors database-level access. That is a non-starter for anyone
   outside the host's own network, and a security hole even for trusted users.

2. **Persona credentials.** Both persona GitHub tokens are project-scoped
   references (`CredentialsSchema.implementer` / `.reviewer`,
   `src/config/schema.ts:71-80`) resolved from an encrypted Postgres store
   (`getPersonaToken` → `resolveProjectCredential`, `src/config/provider.ts:77`,
   `src/db/repositories/credentialsRepository.ts:34-49`) and injected into the
   agent's subprocess as `GH_TOKEN` (`src/pipeline/implementation.ts:434`,
   `src/pipeline/review.ts:334`). In a federation we must not ship a project's
   reviewer token to a contributor's machine, but we also do not want to force
   every user to create a second GitHub account.

PROJECT.md §2.2/§3 already sketch the long-term answer (a GCP-hosted
orchestrator bridged to daemons over a gRPC bidi stream). This ADR is the
**near-term, self-hostable realization of that boundary** — same message
shapes, but over WebSocket+HTTP against the existing Node stack, with no GCP,
no Pub/Sub, and no Firestore. It deliberately does not build the full cloud
engine.

## Decision

### 1. Introduce an authenticated worker↔control-plane transport

A remote worker no longer connects to Postgres/Redis. It opens a persistent,
authenticated connection to the control plane over the public HTTPS endpoint
(the same host the Cloudflare tunnel already fronts) and speaks a small
protocol modelled on PROJECT.md §3, carried over WebSocket for the bidi stream
plus HTTP for request/response calls:

- **Handshake** — worker presents `SWARM_WORKER_CREDENTIAL`; the control plane
  validates it against the worker roster (as `acquireWorkerExecutionSession`
  does today, `src/worker/index.ts:129-148`) and returns a session.
- **Capability + heartbeat** — the worker reports its declared CLIs and health
  on connect and periodically; a disconnected/unhealthy worker is not selected
  for dispatch (ADR-001 "Worker capabilities and availability").
- **Dispatch push** — the BullMQ consumer moves **server-side**. When a job is
  dequeued and the ADR-001 eligibility gate selects a connected worker, the
  control plane pushes a `TaskAssignment` down the stream. The assignment
  carries everything the phase needs so the worker never queries the DB: the
  work-item payload, target branch, system prompt, and the **non-secret** slice
  of project config. Persona secrets are never included.
- **Result + logs** — the worker streams progress logs and the phase result
  back up the stream (the phases already produce a structured hand-off; see §3).

The current in-process, DB-direct path is retained for the **local host worker**
(single-user mode and a same-machine trusted worker); the transport is
**additive** for remote workers. Unifying both behind the transport is deferred
(see Open questions).

### 2. Split GitHub delivery by whether the operation carries source

The agent never talks to GitHub today — it writes a JSON hand-off and SWARM
performs deterministic delivery via `ScmDeliveryProvider`
(`src/scm/delivery.ts`, obtained from
`GitHubSCMIntegration.deliveryProvider`, `src/integrations/scm/github/scm-integration.ts:287-324`).
We keep that model and split *where* each delivery call runs by a single rule:
**source-carrying operations stay on the worker; metadata-only operations move
to the control plane.**

| Operation | Carries source? | Runs on | Identity |
| --- | --- | --- | --- |
| checkout / fetch PR diff | reads source | worker | operator's own repo access |
| commit (`commitPreparedTree`, `delivery.ts:212-238`) | yes | worker | operator's own (`user.name`/`email`) |
| push branch (`delivery.pushBranch`, `scm-integration.ts:300-319`) | yes | worker | **operator's own token** |
| create PR (`delivery.createPullRequest`, `implementation.ts:495`) | no (metadata) | **worker** | **operator's own (implementer)** — kept worker-side for attribution |
| submit review + review comments (`delivery.submitReview`, `review.ts:470`) | no | **control plane** | **per-project reviewer PAT** |
| move board card / comment on issue (PM provider) | no | **control plane** | per-project PM credential |

Consequences of the rule:

- **Implementer identity is the worker operator's own GitHub account.** They
  supply one token, held only on their machine — it never reaches the server.
  The PR is authored by them, so "whose worker opened this PR" is answered
  natively by GitHub. PR creation is metadata and could technically run
  server-side, but is deliberately kept worker-side so authorship (and thus
  attribution) is the user's.
- **The reviewer PAT is a per-project (per-repo) token stored server-side and
  never shipped to a worker.** The worker sends the review content (comments +
  approve/`changes_requested` decision) up the transport; a **small
  control-plane delivery API** performs `submitReview`/`postComment` against
  GitHub using that PAT. The review therefore still appears on the PR as a real
  GitHub review — which keeps the existing `pull_request_review`-driven
  respond-to-review trigger (PROJECT.md §5.4) working unchanged.
- **PM board/issue writes also move server-side**, for the same reason the
  reviewer PAT does: they are metadata operations needing a project-scoped
  credential the worker should not hold, and the worker has no DB config under
  §1 anyway. **Shipped** (issue #413): in
  control-plane delivery mode `resolvePmDelivery` (`src/worker/consumer.ts`) hands
  the phase a transport-backed `PMProvider`; only the local host worker still uses
  the in-process `createGitHubProjectsProvider(project)`.
- **Review comments (which may quote a few code lines) pass through the control
  plane.** This is consistent with the local-first boundary: RULES.md §1 admits
  the cloud may see "issue metadata, comments, and logs," and the comment is the
  exact artifact being published to the PR. The repository tree never crosses.

**Amendment (2026-07-25, issue #417).** The rule above splits operations by *what
they carry*. Making a worker DB-free surfaced a third category it does not
describe: an operation that carries no source and needs no project credential, but
reads or writes **server-side state** the worker has no connection to. The rule is
therefore: *source-carrying operations stay on the worker; an operation needing a
resource the worker must not or cannot hold — a project credential **or** the
database — runs on the control plane.*

The instance is the Review phase's **review-verdict ledger** (`review_verdicts`):
it carries the review-verdict safety cap (issue #235) and the prior-submitted-verdict
signal that makes a run a re-review (issue #328), so a Review run cannot skip it,
yet a DB-free worker cannot reach the table. Its three operations moved
server-side behind the same worker-credential + enrollment auth as the metadata
routes (`POST /worker/delivery/review-ledger/{prior,mark,abandon}`), fronted by the
`ReviewVerdictLedger` seam (`src/pipeline/review-ledger.ts`). The same reasoning
admitted the one PM **read** now served server-side,
`POST /worker/delivery/pm/blockers`: Implementation's dependency gate must keep
gating (issue #330), and stubbing it out on the worker would have let a blocked
item build out of order.

### 3. Re-base the review trigger on work-item linkage, not persona authorship

> **Status: implemented, in two phases.** Phase 1 (issue #397) — the **`pr-review`
> trigger's ownership gate**: the three author checks in
> `src/triggers/handlers/review.ts` collapsed into one work-item origin gate,
> `isSwarmManagedPullRequest` (`src/triggers/swarm-managed-pr.ts`), evaluated once
> per event inside the mergeability check, with `isSwarmAuthoredPr` and the GitHub
> client's `getPullRequestAuthorLogin` deleted. Phase 2 (issue #443) — **comment
> loop prevention**: `GitHubRouterAdapter.isSelfAuthored` no longer resolves or
> matches persona identities at all; it tests the comment's own SWARM-origin marker
> (`isSwarmGeneratedBody`, `src/scm/swarm-origin.ts`) against a new
> `commentBody` field on the parsed event. This mattered once §2 landed for
> Implementation (issue #417): a federated PR is authored by the operator's own
> account, so the persona-authorship gate skipped it and auto-review did not fire on
> the federated path at all, while the comment gate dropped that same operator's
> hand-written comments as SWARM's own. Two identity-based filters remain,
> deliberately: the PM board's `GitHubProjectsRouterAdapter.isSelfAuthored` (a
> status change carries no body to mark, and `selfEnqueueNextPhase` +
> `pm-status-dedup.ts` already compensate) and `resolve-conflicts`' candidate
> filter, tracked separately.

SWARM used to decide a PR should be auto-reviewed by checking that its **author
is a SWARM persona**: `isSwarmAuthoredPr` → `isSwarmBot(authorLogin, identities)`
in `src/triggers/handlers/review.ts`, with the author taken from
`pull_request.user.login` (`src/router/adapters/github.ts`) or a `pulls.get` on
`check_suite`; non-persona authors were skipped.

Under §2 the PR author becomes the worker operator's own account, so that gate
skips every federated PR and auto-review never fires — and on a true federation
the control plane cannot resolve the implementer identity at all, since that
token is worker-local. The trigger instead recognises a PR as SWARM-managed by
its **linkage to a SWARM work item SWARM itself ran**: the head branch decodes to
a work-item number under the project's `branchPrefix` *and* an `implementation`
run row exists for that work item in that project (`hasRunForTask`,
status-agnostic, and never requiring `runs.workerId` — that column is NULL on
every unfederated project).

The same re-basing applies to the comment-loop-prevention drop (`isSelfAuthored`,
`src/router/adapters/github.ts`), where the equivalent of "work-item origin" is the
comment's own **SWARM origin**: SWARM marks every comment it posts with a hidden
`<!-- swarm-… -->` marker or a `_Generated by SWARM…_` footer, so the drop tests for
those (`isSwarmGeneratedBody`, `src/scm/swarm-origin.ts`) instead of for a persona
login. That holds however SWARM delivered the comment — including through another
operator's account, whose login this process could not resolve — and it stops
claiming the operator's genuine human comments. The producers and the detector build
their strings from the same constants so they cannot drift; a new SWARM comment body
that carries neither marker is the one way to reopen the loop.

The reviewer identity remains distinct from the author (per-project reviewer PAT
≠ user account) and the aggregate check query and Review phase still run under it,
so the independent-reviewer invariant (PROJECT.md §5.3) still holds. Routing
*between* personas still resolves identities (`getPersonaForLogin`); only the drop
gates stopped.

### 4. Record worker→PR attribution in the data model

> **Status: built** — the record in phase 1/2 (issue #398) and its dashboard
> surfacing in phase 2/2 (issue #446). The mapping lives on the existing `runs` row:
> `work_item_id` / `phase` / `worker_id` / **`worker_user_id`** (new) /
> **`produced_pr_url`** (new). Both ends are captured by the control plane, as the
> §2 constraint requires — a DB-free worker cannot write the record itself: the
> worker + its owning user (`DispatchSelection.ownerUserId`) are written at
> dispatch through the row's normal lifecycle (`createRun` / `resetRunToRunning`),
> and the produced PR at settle (`completeRun`). To carry the settle half back from
> a remote worker, the `TaskExecutionResult` frame gained an optional `prUrl`
> (`src/transport/protocol.ts`, emitted by `succeededResult` and mapped back by
> `adaptResultToPhaseRun`) — optional and additive, so no protocol-version bump and
> mixed-version workers stay compatible. `worker_user_id` is denormalized rather
> than joined through `workers.owner_user_id` so the attribution survives the worker
> row being removed (`worker_id` is `ON DELETE SET NULL`); `produced_pr_url` is
> deliberately not cleared on a retry, since the PR outlives the attempt. Both
> columns are nullable: an unfederated / single-user run records no worker at all,
> and only a PR-producing phase (Implementation) reports a PR.
>
> Phase 2/2 reads the record back on the run detail view (`/runs/$runId`):
> `runs.getById` resolves the two ids into display labels through the existing
> `getWorker` + `getUserById` pair — after its project-access check, so no identity
> read happens for a caller who may not see the run — and returns them as an
> additive `attribution` object; the page shows them as **Worker** / **Worker
> owner** beside the engine/model, and links `produced_pr_url` as **PR opened by
> this run**, distinct from the `PR #n` a Review run acted on. Nullability carries
> straight through to the UI: no recorded worker renders the neutral `—`, never a
> raw id and never a fabricated owner, and a deleted worker/user degrades to its
> recorded id rather than erroring the page.

Independent of the native GitHub authorship, the control plane records the
`(work item, phase, worker, user, PR url)` mapping when it dispatches and when
delivery reports back, so the dashboard **shows** which worker produced a given
PR/review even if the token model later changes. A produced **review** needs no
column of its own: its identity is already durable in `review_verdicts`, and the
Review run row carries `pr_number` + `review_verdict` + `review_ordinal`, so the
worker/user columns complete that half of the mapping too.

## Consequences

- The BullMQ consumer and the ADR-001 dispatch gate move server-side; the
  worker becomes a thin executor that receives `TaskAssignment`s and streams
  results. `runPhase` (`src/worker/consumer.ts:1055-1211`) splits into a
  server-side dispatcher and a worker-side phase runner.
- Phases must receive their project config in the assignment rather than
  reading it from the DB; the config schema needs a clear split between the
  non-secret slice sent to workers and secrets that stay server-side.
- A new server-side **delivery API** exposes exactly the metadata GitHub
  operations backed by per-project credentials; the worker calls it instead of
  holding those tokens. **Shipped** as `src/router/worker-delivery.ts`: the SCM
  half (`submitReview`/`postComment` under the reviewer PAT →
  `POST /worker/delivery/review` + `/pr-comment`) and the PM half
  (`moveWorkItem`/`addComment` under the per-project PM credential →
  `POST /worker/delivery/pm/move` + `/pm/comment`), each authenticated by the
  worker credential and gated on an active enrollment. A worker opts in with
  `SWARM_CONTROL_PLANE_URL` + `SWARM_WORKER_CREDENTIAL` and receives
  transport-backed `ScmDeliveryProvider`/`PMProvider` delegates
  (`src/scm/transport-delivery.ts`, `src/pm/transport-delivery.ts`) that carry
  only metadata up the wire; the local host worker keeps the in-process path.
  Since issue #418 the same API also carries `POST /worker/delivery/pm/find-item`
  and `POST /worker/delivery/follow-up-review` alongside the earlier §2
  amendment routes (`POST /worker/delivery/pm/blockers` and
  `POST /worker/delivery/review-ledger/{prior,mark,abandon}`) — for ten routes in
  total, with the wire mechanics shared by one client
  (`src/transport/delivery-client.ts`). Resolving a board card from a PR URL now
  has a route (`POST /worker/delivery/pm/find-item`); the remaining PM **reads**
  (`getWorkItem`/`listWorkItems`/`findComment`/discovery) stay worker-side.
- Implementer credential provisioning changes: it is no longer a project
  `project_credentials` row but the worker operator's own token configured
  locally on their machine. `CredentialsSchema.implementer`
  (`src/config/schema.ts:71-80`) becomes reviewer-only at the project scope.
- The Cloudflare tunnel ingress must additionally route the worker transport
  endpoint (today it only fronts the router webhook, `docs/cloudflare-tunnel.md`).
- `docs/configuration.md`, `README.md`, and `ai/ARCHITECTURE.md` are kept current
  with each phase as it lands (per RULES.md §1/§2); they describe §1–§2 as built.

## Non-goals

- No GCP / Pub/Sub / Firestore / gRPC. This is the WebSocket+HTTP near-term
  boundary; the PROJECT.md §2.2 cloud engine stays future work.
- Does not make projects anonymously executable by arbitrary machines (ADR-001
  non-goal stands): workers are admin-created and enrolled/approved.
- Does not add passwordless (email-link) auth or dashboard self-signup — users
  are still created by the instance admin via `swarm users` (deferred, agreed
  as a later step).
- Does not add Bitbucket/GitLab or non-GitHub PM providers.

## Open questions

1. **Transport framing.** WebSocket for the bidi stream is assumed; is HTTP
   long-poll/SSE acceptable as a fallback, and what is the exact message
   framing/versioning (mirroring PROJECT.md §3's `AgentMessage`/`CloudMessage`)?
2. **Local worker unification.** Keep the in-process DB-direct path for the
   local host worker and make the transport additive (proposed), or route even
   the local worker through a `localhost` transport to have one code path?
3. **GitHub repo visibility.** `ProjectVisibilitySchema` (`private` |
   `discoverable`, `src/config/schema.ts:443,483`) is a SWARM *discovery* policy,
   **not** GitHub repo visibility. Do we add a separate repo-visibility field to
   gate reviewer-worker dispatch (a reviewer worker checking out a **private**
   repo needs its operator to have read access)?
4. **Private-repo reviewer dispatch.** For a private repo, both implementer and
   reviewer dispatch must be limited to operators who already hold repo access
   (checkout otherwise 403s). Enforce at enrollment, at dispatch, or both?
5. **External (non-collaborator) contributors.** Near-term trusted users are
   repo collaborators pushing in-repo branches. Fork-based PRs for true external
   contributors are a later flow — where does it slot in?
6. **What the assignment may carry.** Precisely which project-config fields are
   safe to send to a worker, and how PM board/field IDs reach the server-side
   delivery API without leaking into the worker payload.
