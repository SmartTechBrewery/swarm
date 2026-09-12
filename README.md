<img width="1726" height="845" alt="SWARM dashboard" src="https://github.com/user-attachments/assets/9792915e-517a-423f-b059-e9eff99792b0" />

# SWARM

**A local-first, federated multi-agent framework that turns a project board into shipped code.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict%20%2B%20ESM-3178c6.svg)](https://www.typescriptlang.org/)

Move a card to **Ready** and SWARM takes it from there. A coding agent plans the
task, implements it in an isolated Git worktree on a machine *you* own, opens a
pull request, reviews that pull request as a **separate identity**, answers its
own review, fixes red CI, resolves merge conflicts, and moves the card to
**Done** — commenting on the board at every step so a human can follow along or
step in.

Your source code never leaves your machine. The control plane only ever sees
issue metadata, comments, and logs.

---

## What it does, in one picture

```text
   ┌──────────────────────────────────────────────────────────────────────┐
   │  Board: GitHub Projects · Linear · Jira · Trello                     │
   │  Code:  GitHub · Bitbucket Cloud · GitLab                            │
   └───────────────┬──────────────────────────────────────────────────────┘
                   │  signed webhook (HTTPS, usually a Cloudflare Tunnel)
                   ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  Router (control plane)                                              │
   │  verify → normalize to a provider-neutral event → durable dispatch   │
   │  in Postgres → Redis wake-up → eligibility gate → pick a worker      │
   └───────────────┬──────────────────────────────────────────────────────┘
                   │  TaskAssignment over an authenticated WebSocket
                   │  (never a project secret)
                   ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  Worker — your machine, your PATH, your CLI logins                   │
   │  isolated worktree → claude / agy / codex → structured hand-off      │
   └───────────────┬──────────────────────────────────────────────────────┘
                   │  result streams back
                   ▼
      SWARM performs the delivery: commit · push · PR · review · board move
```

## Why it isn't just an agent in a for-loop

**It's a pipeline, not a prompt.** Six distinct phases, each with its own
trigger, worktree mode, prompt, hand-off schema, and delivery rules — so
"implement this" and "review this" are genuinely different jobs with different
credentials, not the same agent asked nicely.

**The agent writes code; SWARM does the delivery.** Every phase ends with a
structured hand-off validated against a Zod schema. Commits, pushes, pull
requests, review submissions, and board moves are then performed *by SWARM* from
that hand-off — never by the agent shelling out on its own. A hand-off that fails
validation gets exactly one repair pass, and then the run fails loudly instead of
half-delivering.

**Two identities, so the review means something.** Implementation runs under an
implementer persona; Review submits under a separate, project-scoped reviewer
credential, scoped per call via `AsyncLocalStorage`. Each provider establishes
its own identity for loop prevention, so SWARM never reacts to its own events.

**Your code stays put.** Cloning, worktrees, agent CLI runs, and pushes all
happen on a machine you own, under `.swarm-workspaces/task-<id>/`. The worker
daemon holds no `DATABASE_URL`, no `REDIS_URL`, and no project secret — anything
needing one (a reviewer verdict, a board move, the verdict ledger) goes back up
to the control plane's delivery API.

**Provider-neutral on every axis.** Three source-control providers, four project
boards, three agent CLIs — and *none* of them are named in pipeline, trigger, or
worker code. A new provider is an interface implementation, not a fork: fifteen
outbound methods plus five inbound ones, declared as data on a manifest, and a
conformance suite that refuses to let a provider register while any method is
still a stub.

**Durable by design.** Postgres holds the dispatch state machine; Redis only
carries wake-ups, never the source of truth. Webhook deliveries dedupe on the
provider's own delivery id and dispatches on deterministic per-(repo, PR, head)
keys — so a redelivered webhook, a queue retry, or a worker restart mid-delivery
still produces exactly one run and one comment.

**Bounded, so nothing runs away.** A durable ledger caps every pull request at
three submitted verdicts (an authorized operator can grant exactly one more).
CI-fix attempts are capped per PR. "The provider answered, but not finally" and
"the read never answered" spend *separate* recheck budgets, so a DNS outage
can't quietly drain the allowance a slow CI run needs — and every give-up leaves
a `failed` run row an operator can see and retry.

**A real dispatch gate.** Before any worktree or agent exists, SWARM confirms an
*eligible* worker may take the phase: active enrollment, the owner's sharing
consent, a live connection, free capacity, the phase, the configured CLI, and
that the host's checkout is actually the right repository. Assigned work runs on
its assignee's own machine and nobody else's. One rule for every deployment — a
single-user install enrolls its one local worker exactly like anyone else.

**Operated from a dashboard**, not a log file: run history and per-run detail
with failure diagnosis, a **Stalled** section naming the work items that have
stopped moving, project and board mapping, per-provider credential entry, worker
registration and approval, and each of your own workers' live CLI quota.

## The six phases

| Phase | Starts when | The agent does | SWARM then does |
| --- | --- | --- | --- |
| **Planning** | A card moves to *Planning* without already carrying `planned` | Reads the task in a read-only worktree and writes `proposed_plan.md` — and, when `verifyPlan` is on (off by default), a second independent agent fact-checks that plan against the repo first, correcting wrong paths, symbols and claims in place and noting on the plan that it was fact-checked | Posts the plan on the item; advances the card only if `autoAdvance` is on (off by default) |
| **Implementation** | A card moves to *Ready* | Implements and verifies on a task branch, writes a structured hand-off | Validates, commits, pushes, opens/reuses the PR, links it on the card, moves it to *In review* |
| **Review** | A SWARM-managed PR opens, its checks complete, or a periodic check finds it ready and unreviewed | Reviews at the PR's head SHA and returns structured findings | Renders the review body itself, submits it under the reviewer identity, spends a ledger slot |
| **Respond-to-review** | The reviewer requests changes | Addresses each point, writes a structured response | Commits/pushes the fix, posts the response, enqueues exactly one follow-up Review for the new head |
| **Respond-to-CI** | A check fails on a task branch, and the failure isn't attributed to the PR's base branch already being red on the same check ([docs/pipeline.md](docs/pipeline.md#base-branch-health)) | Fixes the failure, or reports that it can't | Commits/pushes and explains on the PR, under a per-PR attempt cap, which records a durable give-up when it is spent. Reporting that it can't fix the build hands the PR back to Review rather than ending the line |
| **Resolve conflicts** | A PR is confirmed conflicting with its base | Merges the current base and resolves | Commits and pushes; rechecks are coalesced, bounded, and deduplicated |

All six run on any worker, over the same transport — which machine a worker
happens to be is not a factor.

## What it plugs into

| Axis | Supported today |
| --- | --- |
| **Source control** | GitHub · Bitbucket Cloud · gitlab.com |
| **Project boards** | GitHub Projects v2 · Linear · Jira Cloud · Trello |
| **Agent CLIs** | `claude` (Claude Code) · `agy` (Antigravity) · `codex` |
| **Runtime** | Node 22+ · Postgres · Redis · Docker Compose |

Each project names its own source-control provider and its own board, so one
installation can run a GitHub/Jira project next to a GitLab/Linear one.

## Built with

TypeScript (strict, ESM) · Hono · tRPC · Drizzle + Postgres · BullMQ + Redis ·
Zod as the source of truth for every schema · React + TanStack Router + Vite
for the dashboard · Vitest · Biome · Lefthook.

Roughly 74k lines of application code and 34k of dashboard, against 88k lines of
tests — about 5,000 test cases across 258 files, all of which run in
`npm run verify` (lint + typecheck + tests) locally and on every pull request.

## Design decisions worth reading

The interesting parts are written down as ADRs rather than left in the code:

- [ADR-002](./docs/decisions/ADR-002-durable-dispatch-state-machine.md) — one durable dispatch state machine for orchestration *(accepted)*
- [ADR-003](./docs/decisions/ADR-003-worker-transport-and-split-delivery.md) / [ADR-004](./docs/decisions/ADR-004-worker-transport-and-split-delivery.md) — worker↔control-plane transport and split delivery: why the worker gets a WebSocket and an assignment instead of a database URL *(accepted)*
- [ADR-001](./docs/decisions/ADR-001-federated-workers-and-project-access.md) — federated workers and project access *(proposed)*
- [ADR-005](./docs/decisions/ADR-005-dashboard-chat-with-worker-agent-clis.md) — dashboard chat with a worker's agent CLIs *(under discussion)*

[`ai/ARCHITECTURE.md`](./ai/ARCHITECTURE.md) is the architecture as actually
built; [`docs/pipeline.md`](./docs/pipeline.md) covers phase lifecycle, the
security model, and the provider boundaries.

---

## Quick start

From the repository root:

```bash
npm install
cp .env.docker.example .env       # set passwords
cd dashboard && npm install && cd ..
docker compose up -d --build      # Postgres, Redis, and router
npm run db:migrate
npm run db:seed                   # loads swarm.config.json into Postgres
```

Register this machine as a worker. Every deployment does — a phase runs on an
enrolled worker or it waits:

```bash
npm run swarm -- login --identifier localhost-admin
npm run swarm -- workers register-and-enroll localhost-admin <project-id> \
  --name "this machine" --cli claude
```

Then start the processes and open <http://localhost:5173>:

```bash
npm run dev:api                   # API on 127.0.0.1:3101
npm run dev:dashboard             # dashboard on localhost:5173
npm run dev:worker                # the worker
```

The worker holds that terminal for as long as the machine is meant to accept
work. **On macOS** it can run from a launchd agent instead, started at login —
from the checkout it was registered for:

```bash
swarm-worker-agent install        # then: status · logs · uninstall
```

A local install is single-user by default: no account to create, no password, no
`/login`. The prerequisites, the multi-user alternative, and the full worker
runbook are in [`docs/MANUAL.md`](docs/MANUAL.md).

## Documentation

Everything else — prerequisites, how the worker works and what it deliberately
does not hold, the command reference, the configuration layers, and the map of
every other document — is in [`docs/MANUAL.md`](docs/MANUAL.md).

## Project status

Early but working — and dogfooded: all six phases run end to end against this
repository, so issues on the live board are planned, implemented, reviewed, and
merged by SWARM itself. Over 300 of the commits here were authored by its own
implementer persona and approved by its own reviewer persona.

[`docs/status.md`](./docs/status.md) is the honest, area-by-area snapshot —
including what is unit-verified but not yet driven against a live provider.

## Contributing

Read [`ai/RULES.md`](./ai/RULES.md) before making changes. Run
`npm run verify` before submitting a change. GitHub Actions runs the same
verification command for every pull request.

## License

SWARM is licensed under the [Apache License 2.0](./LICENSE).
