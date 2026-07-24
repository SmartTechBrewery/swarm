# ADR-002: Worker↔control-plane transport and split GitHub delivery

- **Status:** Accepted
- **Date:** 2026-07-24
- **Decision owners:** SWARM maintainers
- **Builds on:** [ADR-001](./ADR-001-federated-workers-and-project-access.md)

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
  §1 anyway. Today they run inline on the worker
  (`createGitHubProjectsProvider(project)` passed into phases,
  `src/worker/consumer.ts:1113`).
- **Review comments (which may quote a few code lines) pass through the control
  plane.** This is consistent with the local-first boundary: RULES.md §1 admits
  the cloud may see "issue metadata, comments, and logs," and the comment is the
  exact artifact being published to the PR. The repository tree never crosses.

### 3. Re-base the review trigger on work-item linkage, not persona authorship

Today SWARM decides a PR should be auto-reviewed by checking that its **author
is a SWARM persona**: `isSwarmAuthoredPr` → `isSwarmBot(authorLogin, identities)`
(`src/triggers/handlers/review.ts:181-217`), with the author taken from
`pull_request.user.login` (`src/router/adapters/github.ts:127,209`) or a
`pulls.get` on `check_suite` (`review.ts:321-322`); non-persona authors are
skipped ("PR not authored by a SWARM persona — skipping", `review.ts:217`).

Under §2 the PR author becomes the worker operator's own account, so this gate
would skip every federated PR and auto-review would never fire. The trigger must
instead recognise a PR as SWARM-managed by its **linkage to a SWARM work item
opened by a registered worker**, not by author identity. The same re-basing
applies to the comment-loop-prevention drop (`isSelfAuthored`,
`github.ts:321-334`): loop prevention keys on work-item/worker origin rather
than on a persona login. The reviewer identity remains distinct from the author
(per-project reviewer PAT ≠ user account), so the independent-reviewer invariant
(PROJECT.md §5.3) still holds.

### 4. Record worker→PR attribution in the data model

Independent of the native GitHub authorship, the control plane records the
`(work item, phase, worker, user, PR url)` mapping when it dispatches and when
delivery reports back, so the dashboard can show which worker produced a given
PR/review even if the token model later changes.

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
  PM **reads** stay worker-side until the broader dispatch-push work (ADR-003 §2).
- Implementer credential provisioning changes: it is no longer a project
  `project_credentials` row but the worker operator's own token configured
  locally on their machine. `CredentialsSchema.implementer`
  (`src/config/schema.ts:71-80`) becomes reviewer-only at the project scope.
- The Cloudflare tunnel ingress must additionally route the worker transport
  endpoint (today it only fronts the router webhook, `docs/cloudflare-tunnel.md`).
- `docs/configuration.md`, `README.md`, and `ai/ARCHITECTURE.md` will need
  updating **when this is implemented** (per RULES.md §1/§2), not while it is
  Proposed.

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
