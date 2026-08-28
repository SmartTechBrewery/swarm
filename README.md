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
that hand-off — never by the agent shelling out on its own. A hand-off that
fails validation gets exactly one repair pass, re-run against the validator's
own complaint, and then the run fails loudly instead of half-delivering.

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
consent, a live connection, free capacity, the phase (both the machine's
repertoire and what the enrollment permits), the configured CLI, and that the
host's checkout is actually the right repository. Assigned work runs on its
assignee's own machine and nobody else's; Planning is deliberately *not*
affinity-gated, so it takes any capable worker; and a run that preserved a
checkout is pinned to the machine holding it until an operator chooses "Reset &
restart". One rule for every deployment — a single-user install enrolls its one
local worker exactly like anyone else.

**Operated from a dashboard**, not a log file: run history and per-run detail
with failure diagnosis, project and board mapping, per-provider credential
entry, worker registration/enrollment/approval, and live CLI quota for each
agent CLI.

## The six phases

| Phase | Starts when | The agent does | SWARM then does |
| --- | --- | --- | --- |
| **Planning** | A card moves to *Planning* without already carrying `planned` | Reads the task in a read-only worktree and writes `proposed_plan.md` | Posts the plan on the item; advances the card only if `autoAdvance` is on (off by default) |
| **Implementation** | A card moves to *Ready* | Implements and verifies on a task branch, writes a structured hand-off | Validates, commits, pushes, opens/reuses the PR, links it on the card, moves it to *In review* |
| **Review** | A SWARM-managed PR opens, or its checks complete | Reviews at the PR's head SHA and returns structured findings | Renders the review body itself, submits it under the reviewer identity, spends a ledger slot |
| **Respond-to-review** | The reviewer requests changes | Addresses each point, writes a structured response | Commits/pushes the fix, posts the response, enqueues exactly one follow-up Review for the new head |
| **Respond-to-CI** | A check fails on a task branch | Fixes the failure, or reports that it can't | Commits/pushes and explains on the PR, under a per-PR attempt cap |
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
security model, and the provider boundaries. The rest of this README is the
shortest path to a working checkout.

---

## Prerequisites

- Node.js 22 or newer and npm
- Docker Compose
- Git
- Authenticated agent CLIs (`claude`, `agy`, and/or `codex`)
- A source-control repository on GitHub, Bitbucket Cloud, or gitlab.com — named by the
  project's `scm` field, which every project must set — and a project-management board with a
  webhook: a GitHub Projects v2 board, a Linear team, a Jira Cloud project, or a
  Trello board. The first three are configured in the provider's own UI; a Trello
  webhook is a resource SWARM creates for you, with
  `npm run swarm -- pm webhook create --project <id>` (see
  [`docs/cli.md`](docs/cli.md))
- Two distinct source-control identities for loop prevention: the worker operator's
  own credential (the implementer persona), stored per worker per SCM provider with
  `swarm workers set-scm-credential` or from that worker's own page in the dashboard,
  and a separate project-scoped reviewer credential
- A project credential for the **board**, separate from the two above, held per PM
  provider under `credentials.pm.<provider>.<role>` so a project can carry two
  providers' credentials at once while only the one `pm.type` names is ever
  resolved:

  | Provider | Required roles (conventional reference names) |
  | --- | --- |
  | GitHub Projects | `apiToken` (`PM_GITHUB_PROJECTS_TOKEN`), scoped `repo` + `project` + `read:org` |
  | Linear | `apiKey`, `webhookSecret` (`LINEAR_API_KEY`, `LINEAR_WEBHOOK_SECRET`) |
  | Jira | `email`, `apiToken`, `webhookSecret` (`JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_WEBHOOK_SECRET`) — Jira Cloud uses basic auth |
  | Trello | `apiKey`, `token`, `webhookSecret` (`TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_API_SECRET` — the last signs its deliveries) |

  Every board read, write, and dashboard discovery authenticates with the
  selected provider's credential, configurable from the dashboard's **Project
  Management** tab. See [`docs/configuration.md`](docs/configuration.md).

## Quick start

Run the following from the repository root:

```bash
npm install
cp .env.docker.example .env       # set passwords
cd dashboard && npm install && cd ..
docker compose up -d --build      # Postgres, Redis, and router
npm run db:migrate
npm run db:seed                   # loads swarm.config.json into Postgres
```

> **Local single-user mode is on by default.** The `.env.docker.example` template
> sets `SWARM_SINGLE_USER_MODE=true`, so this local install needs **no dashboard
> user, no password, no `/login`, and no session cookie**: the API bootstraps a
> passwordless `localhost-admin` and signs you straight into the dashboard. Skip
> the account commands below.
>
> **It is an authentication policy, and nothing more.** It does *not* change how
> work is dispatched: this install registers and enrolls its one local worker
> exactly as a multi-user one does (the commands under **Register this machine
> as a worker** below), because worker selection has a single rule for every
> deployment. Without that worker, phases queue up with nothing to run them —
> `swarm start` and `swarm status` say so.
>
> **Multi-user alternative.** Set `SWARM_SINGLE_USER_MODE=false` in `.env` (or
> remove the line) to require per-user session auth instead. Then create your
> dashboard user and set its login password before signing in at `/login`:
>
> ```bash
> npm run swarm -- users add you@example.com --admin    # create your dashboard user, then
> npm run swarm -- users set-password you@example.com   # set its login password (prompts, no echo)
> ```

**Register this machine as a worker.** Every deployment does this — a
single-user install runs the same commands as a multi-user one, because a phase
runs on an enrolled worker or it waits. In single-user mode the owner is the
bootstrapped `localhost-admin` account, which exists once the API has served a
request (start `npm run dev:api` and open the dashboard first, or use a user you
created with `swarm users add`):

```bash
npm run swarm -- workers register localhost-admin --name "this machine" --cli claude
npm run swarm -- workers enroll <worker-id> <project-id> --cli claude --active --consent
```

`workers register` prints a credential **once** — put it in `.env` as
`SWARM_WORKER_CREDENTIAL` before starting the worker. `swarm start` and `swarm
status` warn when this host has no usable credential. The full runbook, including
someone else's machine, is [`docs/onboarding-worker.md`](./docs/onboarding-worker.md).

Start these processes in separate terminals:

```bash
npm run dev:api                   # API server on 127.0.0.1:3101
npm run dev:dashboard             # Vite dashboard on localhost:5173
npm run dev:worker                # the worker — see below
```

Open <http://localhost:5173>. For a compiled self-hosted dashboard, run
`npm run start:api` and open <http://localhost:3101> instead.

## The worker

**There is one worker program.** `npm run dev:worker` runs
`src/transport/connect-entry.ts` on every machine, remote or the control-plane host
itself. Point it at the router; on the control-plane host that URL is simply
loopback:

```bash
# .env on the machine running the worker
SWARM_CONTROL_PLANE_URL=http://localhost:3100      # remote worker: https://<your-tunnel>
SWARM_WORKER_CREDENTIAL=<from `swarm workers register`>
SWARM_WORKER_REPO_ROOT=/path/to/this-hosts/checkout  # optional; defaults to cwd
```

**On the machine that registered it, there is a shorter way to start it.** Both
registration commands also write the freshly issued credential to a per-checkout
cache in the operator's home directory (`~/.swarm/worker-credentials/<hash>/`,
owner-only, outside every checkout — no `.gitignore` entry needed anywhere), so
from inside that checkout:

```bash
swarm run:worker
```

starts the same daemon with `SWARM_WORKER_REPO_ROOT` set to the directory where the
command was invoked and the credential read from that file — never printed, never pasted, with only
`SWARM_CONTROL_PLANE_URL` left to `.env`. It is an *additional* launcher, not a
second worker: the block above is unchanged and stays the path for a remote
machine, a process supervisor, or any setup where the registering machine is not
the running one.

The global `swarm run:worker` form uses its current directory; `npm run swarm --
run:worker` uses npm's caller directory (`INIT_CWD`), so both forms select the
checkout you invoked them from.

The operator's own source-control credential is **not** among them: it is stored
server-side per `(worker, SCM provider)` — `swarm workers set-scm-credential
<worker-id> <github|bitbucket|gitlab>`, or from that worker's own page in the
dashboard (`/workers/<worker-id>`, which verifies the value against the provider
before storing it) — and travels with each assignment, so rotating it needs no worker
restart and a Bitbucket or GitLab project resolves its own credential rather than a
GitHub-named one.

It is intentionally host-run: it needs local Git worktrees, agent CLI
authentication, and the developer's PATH.

**What it holds — and what it deliberately doesn't.** Only the credential and the
control-plane URL; no `DATABASE_URL`/`REDIS_URL`, even on a host that has them, and
no stored source-control secret. Its agent therefore
authenticates as the *operator's own* account everywhere (ADR-004 §2), while the
project-scoped reviewer PAT and the PM credential never leave the server — so a
submitted review's identity is unchanged.

**How it connects.** It performs the `/worker/session` handshake — declaring the
CLIs it can run, the pipeline phases it can execute, and which repository its one
local checkout actually is (read from that checkout's `origin`) — keeps its
session live over the `/worker/stream` WebSocket, and reconnects with backoff
(ADR-003 §1). Because it declares its phase repertoire, the control plane never
routes a phase to a worker that cannot run it; the work waits for one that can.

**How it guards the checkout.** An assignment for a repository this checkout is
*not* is refused up front, naming both, rather than run. The daemon locks that
checkout for its whole life, so a second worker pointed at the same path refuses
to start instead of driving Git in the same repository (give a second worker on
the machine its own checkout). The control plane polices the same pairing:
enrolling a worker in a project for another repository is refused, and an
existing enrollment a reconnecting daemon's declaration contradicts is
*suspended*, with both repositories shown on the Workers screen — approval and
sharing consent stay human decisions, so nothing is ever enrolled or re-activated
from a declaration alone.

**How work is split.** Source-carrying delivery (commit / push / create-PR) runs
on the worker under the operator credential the assignment carried. Everything needing something the worker
must not hold goes up to the control plane's delivery API: Implementation's board
moves, comments and dependency lookup; Respond-to-review's card lookup and board
moves; Review's submitted verdict under the reviewer PAT; and the two things
backed by the control plane's database — Review's verdict-ledger reads/writes and
the follow-up Review a pushed fix enqueues. Planning's board surface (creating a
split's sibling cards, chaining their dependency edges, re-scoping the parent,
labelling what finished, finding its own plan comment on a retry) rides five more
PM delivery routes, while its agent run, plan file, and scope gate stay
worker-side; a split interrupted partway resumes from a per-child marker rather
than creating that child twice. Results stream back over the transport (ADR-003
§2).

The **router** dequeues and dispatches; `SWARM_WORKER_CONCURRENCY` bounds how many
dispatches it drives at once (default 1), and a project's **Maximum Concurrent
Jobs** setting bounds it further per project. Dispatch always runs on the control
plane (ADR-003 §2): there is no second arrangement — the in-process executor was
deleted so that one path carries every run. A project with no enrolled, connected
worker leaves its dispatch durably pending; a wait for a *machine* ends as soon
as one turns up (a worker connecting, or finishing a run and freeing its slot),
while a wait for a *human* (consent, an enrollment, a permitted phase) keeps the
timed cadence, since nothing a machine does can clear it.

The control-plane host's own worker runs this identical program over loopback, so
a remote worker and a local one are the same code path rather than two that have
to be kept in step. See
[`docs/cloudflare-tunnel.md`](docs/cloudflare-tunnel.md#remote-worker-transport-worker)
and [`docs/operations.md`](./docs/operations.md) for health checks, ports,
webhook setup, and troubleshooting.

## Failure diagnosis

For a terminal recognised response stall, SWARM labels a task as **likely scope
exceeded** only when it also observed substantial progress and the most recent
successful Planning run recorded multiple independent concerns. A timeout alone
never proves task size: without all of that evidence, SWARM keeps a
provider-oriented diagnosis. Quota, model-capacity, launch/authentication,
worker-shutdown, and user-termination conditions take precedence and retain
their specific recovery guidance in both the board comment and run detail.

## Common commands

```bash
# Stack lifecycle
npm run swarm -- start
npm run swarm -- start --build
npm run swarm -- stop
npm run swarm -- status
npm run swarm -- logs
npm run swarm -- logs router -f

# Configuration and database
npm run db:migrate
npm run db:seed
npm run swarm -- config apply

# After `git pull` — sync deps, rebuild the dashboard, apply migrations
npm run reload

# Queue and worktrees
npm run queue:clear
npm run worktrees:prune

# Verification
npm run verify
npm test
```

`npm run swarm -- <command>` runs the CLI from source. After `npm run build`,
the `swarm` binary can be invoked directly. `queue:clear` cancels waiting
dispatches but does not terminate an active agent; stop the worker first when
clearing work before a restart. The full list of `swarm` commands and `npm run`
scripts, with descriptions, is in [`docs/cli.md`](./docs/cli.md); detailed
operator guidance is in [`docs/operations.md`](./docs/operations.md).

## Configuration

Configuration has three layers:

- `.env` — host and process settings such as database, Redis, ports, logging,
  dashboard authentication, and credential encryption.
- `swarm.config.json` — per-project repository, worktree, board mapping (`pm`, one
  member per PM provider — GitHub Projects, Linear, Jira, or Trello, all four
  selectable and switchable from the dashboard's **Project Management** tab),
  credential references (the SCM reviewer/webhook pair per SCM provider under
  `credentials.scm[<providerId>]`, plus each PM provider's own roles under
  `credentials.pm[<providerId>]`), agent, and pipeline settings.
  Apply changes with `npm run db:seed` or `swarm config apply`.
- Dashboard global settings — app-wide settings stored in Postgres and edited
  through the dashboard API.

The complete option catalogue, defaults, and source-of-truth schemas are in
[`docs/configuration.md`](./docs/configuration.md).

## Documentation

- [`docs/cli.md`](./docs/cli.md) — complete command reference: every `swarm`
  operator CLI command and `npm run` script, with descriptions
- [`docs/operations.md`](./docs/operations.md) — setup, run modes, ports,
  health checks, operator CLI, migrations, queues, worktrees, and webhooks
- [`docs/configuration.md`](./docs/configuration.md) — complete environment,
  project, and global-settings reference
- [`docs/pipeline.md`](./docs/pipeline.md) — phases, triggers, security, and
  provider boundaries
- [`docs/agent-containment.md`](./docs/agent-containment.md) — how far outside
  its worktree an agent CLI run can reach, per CLI, and how to tighten it
- [`docs/status.md`](./docs/status.md) — implemented MVP areas and current
  roadmap snapshot
- [`ai/ARCHITECTURE.md`](./ai/ARCHITECTURE.md) — engineering architecture and
  implementation conventions
- [`ai/TESTING.md`](./ai/TESTING.md) — test strategy and verification guidance
- [`docs/cloudflare-tunnel.md`](./docs/cloudflare-tunnel.md) — exposing the
  local router to GitHub
- [`docs/onboarding-worker.md`](./docs/onboarding-worker.md) — adding a new
  user + worker, local or remote
- [`docs/github-projects-v2-api.md`](./docs/github-projects-v2-api.md) —
  Projects v2 API and webhook details
- [`docs/decisions/`](./docs/decisions/) — architecture decision records
- [`docs/public-hosting-exploration.md`](./docs/public-hosting-exploration.md) —
  what a public, multi-tenant deployment would take (hosting, missing pieces,
  credential model, OAuth across the three SCM providers). **Deferred** — SWARM
  stays on privately hosted instances; kept so the analysis is not re-derived
- [`PROJECT.md`](./PROJECT.md) — the original design document, **frozen as a historical baseline**; read it for original intent, not current behavior

The live task backlog is the [SWARM GitHub Projects board](https://github.com/orgs/SmartTechBrewery/projects/6/views/1).

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

### Temporary: pre-multi-repo restore point

`single_repo_backup` marks the last commit before the multi-repo migration
(issues [#683](https://github.com/SmartTechBrewery/swarm/issues/683)–[#687](https://github.com/SmartTechBrewery/swarm/issues/687)) — one project owning several
repositories instead of exactly one. That migration reaches the config schema,
the run read model, every phase's dedup key, and worker routing, so the branch
exists to return to a known-good single-repository state if it goes wrong.

**Delete this branch and this section once the migration has stabilized.**

## License

SWARM is licensed under the [Apache License 2.0](./LICENSE).
