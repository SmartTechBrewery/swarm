# ARCHITECTURE DESIGN DOCUMENT (ADD) & PROJECT SPECIFICATION
## System Name: SWARM (Federated Multi-Agent Automation Framework)
**Status:** **Frozen historical baseline — not maintained** (frozen 2026-08-04).
**Target Audience:** Engineering Team, Core Architects
**Version:** 1.2.0

---

> ## ⚠️ This document is a historical baseline, not a description of the system
>
> `PROJECT.md` is the original design document SWARM was founded on. It is kept for
> **original design intent** and because ~40 code comments cite its section numbers
> (`PROJECT.md §5.1`, `§6.1`, …) as a shared vocabulary. It is **no longer
> maintained and is not authoritative on current behavior.**
>
> **Where this document disagrees with any of the following, they win:**
>
> - **[`ai/ARCHITECTURE.md`](./ai/ARCHITECTURE.md)** — the architecture as actually built.
> - **[`docs/decisions/`](./docs/decisions/)** — the ADRs; every deliberate divergence from this document is recorded there.
> - **[`docs/`](./docs/)** — the maintained references: [`configuration.md`](./docs/configuration.md), [`pipeline.md`](./docs/pipeline.md), [`operations.md`](./docs/operations.md), [`cli.md`](./docs/cli.md), [`status.md`](./docs/status.md).
> - **The code and its Zod schemas** — the source of truth for every contract (`ai/CODING_STANDARDS.md`).
>
> Known divergences, as examples rather than an exhaustive list — do not trust an
> unlisted section merely because it is unlisted:
>
> | Section | This document says | Reality |
> | --- | --- | --- |
> | §2.2, §3, §6.2, §8 Phase 6 | GCP orchestrator, gRPC control plane, Secret Manager | Never built. The transport is WebSocket + HTTP on the router ([ADR-004](./docs/decisions/ADR-004-worker-transport-and-split-delivery.md) §1); §3's `.proto` is retained only as a message-*shape* reference ([ADR-003](./docs/decisions/ADR-003-worker-transport-and-split-delivery.md)). |
> | §4.1 | Human workspace is `~/swarm/{project-name}/` | It is the project's configured `repoRoot` (`swarm.config.json`), anywhere on disk. Only the `.swarm-workspaces/` agent root still holds. |
> | §5.1 | Planning runs Google Antigravity | Planning runs `claude`; the agent per phase is configurable (`src/harness/models.ts`, the dashboard's Agent Configuration). |
> | §5.x | "Ready for Dev" | The canonical status key is `todo`, surfaced on the board as `Ready` (`ai/RULES.md` §5). |
> | §7.1 | An inline `PMProvider`/`WorkItem` TypeScript listing | Superseded — see the note in that section. |
>
> The live task board is **not** linked from here; `ai/RULES.md` §5 owns that and is
> maintained. This document's original roadmap (§8) is likewise historical —
> [`docs/status.md`](./docs/status.md) tracks where the MVP actually stands.

---

## 1. Executive Summary & Core Philosophy

**SWARM** is a next-generation, Local-First, Federated Multi-Agent Framework designed to automate software engineering workflows for teams while eliminating the massive infrastructure costs, security risks, and contextual disconnects inherent in centralized, cloud-only agentic platforms.

### The Core Paradigm Shift

Traditional software engineering agents (like Devin or centralized enterprise platforms) attempt to replicate the developer's entire environment in ephemeral cloud containers. This introduces massive latency, high compute costs, and complex synchronization issues with local SDKs, emulators, and caches (especially critical in multi-platform development environments like Kotlin Multiplatform or mobile systems).

SWARM flips this model on its head:
* **Centralized Control (Cloud):** The cloud acts strictly as an asynchronous, stateless orchestrator and routing plane. It handles webhooks, maps issues to specific developers, manages enterprise authentication, and stores system-wide prompts. It *never* clones, sees, or processes the raw source code.
* **Federated Execution (Local Host):** The actual compute power, context reasoning, and file modifications occur directly on the developer's physical machine. A local daemon coordinates with advanced CLI harnesses (**Anthropic Claude Code** and **Google Antigravity**) using **Git Worktrees** to run tasks in absolute isolation without disrupting the engineer's live workspace.

### 1.1 MVP vs. Long-Term Vision

§2.2 below describes the full target design: a GCP-hosted stateless orchestrator bridged to a local daemon over gRPC, serving multiple tenants. **That is not what's being built first.** The MVP instead copies the architecture of **[Cascade](https://github.com/mongrel-intelligence/cascade)** — SWARM's reference project (resolve via `ai/RULES.md` §1) — closely: a local router + job queue + worker, all in Docker Compose on the developer's own machine, reachable from GitHub via a Cloudflare Tunnel instead of a cloud ingress service. §2.1 covers the MVP architecture; §2.2 covers the deferred cloud vision.

The two concrete product differences from Cascade — what makes SWARM its own project rather than a fork:

1. **PM provider = GitHub Projects** (v2), not Trello/JIRA/Linear — Cascade has no GitHub Projects adapter; this is net-new.
2. **SCM = GitHub**, same as Cascade — this piece is copied closely.

MVP scope is single-user (see `ai/ARCHITECTURE.md`); multi-tenancy is deferred to the long-term vision along with the cloud engine. *(Historical: multi-user authentication, project membership, and federated worker enrollment have since been built — see `ai/ARCHITECTURE.md` and ADR-001.)*

---

## 2. High-Level System Architecture

### 2.1 MVP Architecture (Local, Cascade-shaped) — what's being built now

```
GitHub (repo + Projects v2)
   │  webhooks
   ▼
Cloudflare Tunnel  (external, not SWARM's concern — just a public HTTPS URL)
   ▼
Router  (Hono HTTP server, Docker container)
   — verifies webhook signatures, resolves the SWARM project, enqueues a job
   ▼
BullMQ / Redis  (job queue, Docker container)
   ▼
Worker  (Docker container)
   — resolves trigger handler → provisions a Git worktree → spawns `claude` / `antigravity` CLI
   — commits, pushes, opens/updates a PR, updates the GitHub Projects item
```

- **Router**: Node.js/TypeScript, Hono — same web framework Cascade uses for its router.
- **Queue**: BullMQ on Redis — same as Cascade; gives retries, backoff, and concurrency limits for free.
- **Worker**: consumes one job at a time (or a small pool), drives the worktree + harness lifecycle (§4).
- **Postgres**: project config, credentials at rest, run history — same role it plays in Cascade.
- **Everything above runs on one machine** via Docker Compose. There is no separate cloud process for the MVP.

Full detail and the rationale for copying Cascade's shape: `ai/ARCHITECTURE.md`.

### 2.2 Long-Term Cloud Vision (Future — not started)

Once the MVP proves out for a single user, the following is the target design for a shared/hosted version. Built entirely on a serverless, zero-maintenance, cost-optimized GCP stack:

1. **Ingress API Layer (Google Cloud Functions / Cloud Run):** Exposes public endpoints to receive HTTPS webhooks from external tools (GitHub, Trello, Jira). It verifies webhook signatures and instantly publishes raw payloads to Google Cloud Pub/Sub.
2. **Asynchronous Message Queue (Google Cloud Pub/Sub):** Buffers incoming tasks. This guarantees zero message loss if a developer's laptop is closed, offline, or switching network interfaces.
3. **Orchestrator Core (Google Cloud Run - Node.js/TypeScript):** The state machine of the system. It consumes events from Pub/Sub, maps the external identities to internal SWARM user profiles, retrieves contextual system prompts, and routes tasks to the corresponding active gRPC stream.
4. **Persistence & Configurations (Google Cloud Firestore):** Stores multi-tenant configurations, user-to-device mapping keys, active session tokens, and stateful tracking of multi-step pipelines.

At that point the **SWARM Local Daemon** (`swarm-cli`) becomes a persistent background process again — the MVP's worker already does its job (worktree management + harness invocation), it would just start talking to a gRPC stream instead of pulling from BullMQ:

1. **gRPC Client Network Layer:** Establishes and maintains a persistent, long-lived, bidirectional streaming connection to the Cloud Run Orchestrator. Includes automatic exponential backoff reconnection logic.
2. **Isolation Engine (Git Worktree Manager):** Unchanged from the MVP — see §4.
3. **Harness Orchestrator:** Unchanged from the MVP — see §4.

---

## 3. Communication Protocol Specification (gRPC) — Future, not used by the MVP

The MVP has no cloud/local split to bridge: the router and worker communicate in-process via BullMQ (§2.1), not gRPC. This section defines the protocol for §2.2's future cloud engine so the design isn't lost — implement it only once that phase starts.

### `swarm_protocol.proto` Specification

```protobuf
syntax = "proto3";

package swarm.protocol.v1;

option go_package = "github.com/swarm/protocol/v1;swarmv1";
option java_package = "com.swarm.protocol.v1";

service SwarmOrchestratorService {
  // Establishes the persistent bidirectional control and execution pipe
  rpc ConnectAgent(stream AgentMessage) returns (stream CloudMessage);
}

message AgentMessage {
  string agent_id = 1;
  int64 timestamp = 2;

  oneof payload {
    HandshakeRequest handshake = 3;
    Heartbeat heartbeat = 4;
    TaskExecutionResult result = 5;
    StreamLog progress_log = 6;
  }
}

message CloudMessage {
  string message_id = 1;
  int64 timestamp = 2;

  oneof payload {
    HandshakeResponse handshake_ack = 3;
    TaskAssignment task_assignment = 4;
    SystemDisconnect disconnect_order = 5;
  }
}

message HandshakeRequest {
  string auth_token = 1;
  string daemon_version = 2;
  string hostname = 3;
}

message HandshakeResponse {
  bool authenticated = 1;
  string session_id = 2;
  string active_organization = 3;
}

message Heartbeat {
  uint32 current_cpu_load = 1;
  uint64 available_ram_bytes = 2;
}

enum TaskType {
  TASK_TYPE_UNSPECIFIED = 0;
  TASK_TYPE_PLANNING = 1;
  TASK_TYPE_IMPLEMENTATION = 2;
  TASK_TYPE_REVIEW = 3;
  TASK_TYPE_RESPOND_TO_REVIEW = 4;
}

message TaskAssignment {
  string task_id = 1;
  TaskType type = 2;
  string repository_name = 3;
  string target_branch = 4;
  string system_prompt = 5;
  string user_payload_json = 6; // Contextual data from boards/github
}

message TaskExecutionResult {
  string task_id = 1;
  bool success = 2;
  string output_summary = 3;
  string error_message = 4;
}

message StreamLog {
  string task_id = 1;
  string log_line = 2;
  string stream_source = 3; // stdout or stderr
}

message SystemDisconnect {
  string reason = 1;
}
```

---

## 4. Local Execution & Sandbox Isolation (Git Worktrees)

To allow simultaneous, unhindered collaboration between the human developer and the automated SWARM agents on the exact same repository, the worker implements a strict sandboxing model based on **Git Worktrees**. This applies identically to the MVP worker (§2.1) and the future daemon (§2.2) — it doesn't change when the cloud engine is built.

### 4.1. Workspace Directory Standards

SWARM operates under a standardized home-directory structure:

* Main Repository Location (Human Workspace): `~/swarm/{project-name}/`
* SWARM Hidden Agent Workspace Root: `~/swarm/{project-name}/.swarm-workspaces/`

### 4.2. Detailed Execution Lifecycle

When the worker receives a `TaskAssignment`-shaped job (from BullMQ in the MVP, from the gRPC stream once §2.2 exists):

1. **Sanity Check & Sync:** The worker verifies that the primary project folder `~/swarm/{project-name}/` exists and is a valid git repository. It runs a non-blocking background fetch (`git fetch origin`) to ensure all remote refs are local.
2. **Worktree Creation:** The worker generates a clean, unique workspace path for the task, nested under the workspace root defined in §4.1 (run from `~/swarm/{project-name}/`, the main repository location):
   ```bash
   git worktree add .swarm-workspaces/task-${task_id} ${target_branch}
   ```
   *Impact:* This takes mere milliseconds and shares the main `.git` compression history, avoiding expensive network operations.
3. **Environment Grafting (Symlink Layer):** Un-tracked files, configurations, and large caches are critical for builds to pass. The worker scans the main workspace and builds target symbolic links into the worktree:
   * `node_modules/` linked dynamically or cross-referenced to preserve native dependency states.
   * `.env` and secret environment files injected into the root.
   * Build tool cache matrices (`.gradle/`, `.ccache/`, etc.) cross-linked to avoid cold-compilation delays.
4. **Agent Executable Execution:** SWARM spawns the targeted CLI binary (`claude` or `antigravity`), overriding the current working directory (CWD) to the newly created worktree path.
5. **Cleanup & De-allocation:** Upon process completion, any local modifications are pushed directly to remote origin by the agent using the internal tools. The worker then cleans up the sandbox:
   ```bash
   git worktree remove --force .swarm-workspaces/task-${task_id}
   ```

---

## 5. Multi-Agent Pipeline Flows & Lifecycle Management

SWARM treats multi-agent execution as independent, sequential, and entirely stateless phases connected by **GitHub Projects**. All four phases below are in MVP scope. *(The live task board is owned by `ai/RULES.md` §5; `docs/pipeline.md` describes the phases as built, including the Respond-to-CI and resolve-conflicts phases this document predates.)*

### 5.1. Phase 1: Planning (Antigravity Pipeline)

* **Trigger:** An item's Status field on the GitHub Projects board moves to "Planning".
* **Orchestration Input:** The router receives the `projects_v2_item` webhook, resolves the SWARM project, and enqueues a `TASK_TYPE_PLANNING` job.
* **Local Action:** The worker provisions a worktree and spins up Google Antigravity. Antigravity reads the entire code graph and outputs a concrete, technical step-by-step markdown specification file (`proposed_plan.md`).
* **Orchestration Output:** The worker posts the plan as a comment on the linked GitHub Issue (GitHub Projects items have no long-form body of their own) and moves the item's Status to "Ready for Dev".

### 5.2. Phase 2: Implementation (Claude Code Pipeline — implementer persona)

* **Trigger:** An item's Status moves to "In Progress".
* **Orchestration Input:** The worker reads the linked Issue's plan comment and issues a `TASK_TYPE_IMPLEMENTATION` job.
* **Local Action:** The worker creates a dedicated worktree for the task branch and spawns Claude Code under the **implementer persona** token. Claude Code implements the plan, runs local unit/integration tests to ensure no regressions, refactors on failure, commits, and pushes.
* **Orchestration Output:** A Pull Request is opened and linked back to the GitHub Projects item.

### 5.3. Phase 3: Review (Claude Code Pipeline — reviewer persona)

* **Trigger:** The PR is opened, or its check suite completes successfully.
* **Orchestration Input:** The router receives the `pull_request` / `check_suite` webhook and issues a `TASK_TYPE_REVIEW` job.
* **Local Action:** The worker opens a worktree mapped to the PR branch and spawns Claude Code under the **reviewer persona** token — never the implementer's; this is the loop-prevention invariant borrowed from Cascade (see `ai/CODING_STANDARDS.md`). Claude reviews the diff and posts PR review comments.
* **Orchestration Output:** A GitHub PR review, submitted as either an approval or `changes_requested`.

### 5.4. Phase 4: Respond to Review (The Feedback Loop)

* **Trigger:** The **reviewer persona's** review is submitted with a `changes_requested` status. The router **ignores individual line comments** to prevent race conditions and listens exclusively for the final `pull_request_review` event with `action: "submitted"`, then fetches all batched comments for that review ID.
* **Orchestration Input:** A unified `TASK_TYPE_RESPOND_TO_REVIEW` job carrying the full batch of review comments.
* **Local Action:** The worker opens a worktree mapped to the PR branch and spawns Claude Code under the **implementer persona** token. Claude executes a holistic review of the feedback:
  * *Path A (Code Adjustment):* Modifies code blocks, verifies tests pass locally, commits, and pushes a single aggregated fix.
  * *Path B (Pushback):* Formulates an articulate, contextual explanation if a reviewer's comment is structurally invalid, and posts it as a reply rather than a code change.
* **Orchestration Output:** Replies posted directly into the PR review conversation thread.

---

## 6. Authentication, Security, & Secret Architecture

### 6.1. MVP: GitHub Credentials & Local Secrets

* **Dual-persona model** (borrowed from Cascade, see `ai/CODING_STANDARDS.md` "Loop prevention"): every project holds two separate GitHub credentials — an **implementer** token/identity and a **reviewer** token/identity — so a persona never reacts to its own output.
* **Storage:** credentials live in Postgres (a `project_credentials`-style table), the same role that table plays in Cascade. No GCP Secret Manager for the MVP.
* **Webhook verification:** standard GitHub HMAC signature verification at the router.
* **Zero-Knowledge Code Base still holds:** source code never leaves the developer's machine — the router/worker/Postgres/Redis stack is entirely local; the only things that ever leave the machine are webhook payloads and PR/comment metadata.

### 6.2. Future: gRPC Daemon Auth + GCP Secret Manager

Once §2.2's cloud engine exists:

* **Mechanism:** Static Bearer Tokens paired with Device Hardware IDs (`UUID`).
* **Storage:** Access token saved locally to `~/.swarmrclocal` with restrictive `0600` permissions.
* **Handshake Protocol:** Every initialization stream passes the token via HTTP/2 Metadata headers.
* **Third-Party Board Authentication:** Board API keys move from Postgres (§6.1) into Google Cloud Secret Manager. Only cloud-side `BoardProviders` access them.

---

## 7. Board & Issue Agnostic Extensibility Layer

To mimic the scalable architecture of Cascade, SWARM implements a provider-agnostic PM interface, following Cascade's manifest/registry pattern (`ai/CODING_STANDARDS.md` "Module shape for a provider/integration") rather than hardcoding a single board type.

### 7.1. Interface Contract (`PMProvider`)

> **Superseded — the contract lives in [`src/pm/types.ts`](./src/pm/types.ts).**
>
> This section originally carried an inline TypeScript listing of `PMProvider` /
> `WorkItem`. It has been removed rather than corrected: a hand-copied contract is a
> second source of truth, which `ai/CODING_STANDARDS.md` ("Zod is the source of
> truth") exists to prevent — and it had already drifted. The real interface has
> grown well past the four methods drafted here (`findWorkItemByUrlSuffix`,
> `findComment`, `createWorkItem`, `updateWorkItem`, `addLabel`, `listBlockers`,
> `addBlockedBy`, …), and `WorkItem` gained `assignees`/`createdAt`/`updatedAt`
> while `status`/`statusId` became optional.
>
> The *design intent* this section recorded still stands and is the part worth
> keeping: **project-management features are programmed against the provider
> interface, never against a concrete board.** That rule is stated normatively, with
> its current obligations, in `ai/RULES.md` §2 ("Project-management features must
> stay provider-agnostic"). Widening the interface for every provider is the
> supported move; special-casing one at a call site is not.

GitHub Projects (v2) is the MVP's only concrete implementation — see `ai/ARCHITECTURE.md` for how its GraphQL-only API, custom `Status` field, and `projects_v2_item` webhook event map onto this interface. Adding a second provider later (e.g. re-adding Trello/JIRA/Linear support, or Asana) should require zero changes to router/worker dispatch code — only a new provider folder plus one registry import, per Cascade's single-entrypoint invariant.

---

## 8. Implementation Roadmap

This is the *original* phase-level roadmap, kept as written. For where the MVP actually stands see [`docs/status.md`](./docs/status.md); for the live task board see `ai/RULES.md` §5.

### Phase 1: Local Foundation
* Scaffold the Node.js/TypeScript project with Cascade's tooling (strict TS, Biome, Vitest, Lefthook).
* Docker Compose stack: Postgres, Redis, router, worker.
* Project config schema (Zod) and credential storage.

### Phase 2: GitHub SCM Integration
* Dual-persona GitHub credentials.
* Webhook receiver + router adapter for `pull_request`, `pull_request_review`, `issue_comment`, `check_suite`.
* Loop prevention (`isSwarmBot`).

### Phase 3: GitHub Projects PM Provider
* GitHub Projects v2 GraphQL client.
* `PMProvider` implementation (§7) + `projects_v2_item` webhook adapter.
* Provider registration via the manifest/registry pattern.

### Phase 4: Worktree & Agent Execution Engine
* `GitWorktreeManager` (§4).
* Harness orchestrator for `claude` / `antigravity` CLIs.
* Worker job consumer wiring trigger → worktree → harness → cleanup.

### Phase 5: Full Pipeline, End to End
* Wire up all four phases from §5 (Planning → Implementation → Review → Respond-to-Review) against a real repo + GitHub Projects board.
* End-to-end smoke test.

### Phase 6 (Future): Cloud Engine & Multi-Tenancy
* Build §2.2/§3's GCP cloud engine and gRPC protocol once the local MVP is proven for a single user.
* Multi-tenant config, user-to-device mapping, GCP Secret Manager migration (§6.2).

---

## Appendix A: Reference Architecture — Cascade

Cascade is no longer just inspiration — for the MVP, SWARM copies its architecture directly (router → queue → worker, manifest/registry-based provider abstraction, Zod-owned config schemas, dual-persona GitHub loop prevention). See:

* `ai/ARCHITECTURE.md` — the MVP architecture, adapted from Cascade's.
* `ai/CODING_STANDARDS.md` — the coding conventions to match (TypeScript/ESM, Biome, error handling, naming, provider module shape).
* `ai/TESTING.md` — Vitest conventions and git hooks, copied from Cascade's setup.
* **Reference Repository URL:** <https://github.com/mongrel-intelligence/cascade> (resolve via the `cascade` symlink first — see `ai/RULES.md` §1).

### Target Areas for Code Inspection & Adaptation

1. **Provider abstraction:** Cascade's `PMProviderManifest` + registry (`src/integrations/pm/`) is the pattern the GitHub Projects provider should follow — see §7.
2. **Webhook ingress & router adapters:** `src/router/adapters/*.ts` — signature verification, event parsing, dispatch-with-credentials shape.
3. **CLI process orchestration:** Cascade's worker (`src/worker-entry.ts`) is the baseline for spawning `claude`/`antigravity`, streaming stdout/stderr, and tracking exit codes.
4. **GitHub SCM integration specifically:** `src/github/scm-integration.ts` + `src/router/adapters/github.ts` — dual-persona credential scoping and loop prevention, to be copied closely for §5–§6.
