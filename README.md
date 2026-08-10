<img width="1726" height="845" alt="Zrzut ekranu 2026-07-20 o 19 47 53" src="https://github.com/user-attachments/assets/9792915e-517a-423f-b059-e9eff99792b0" />

# SWARM

**Federated Multi-Agent Automation Framework** — a local-first system that
automates software work while keeping source code, compute, and local tooling
on the developer's machine.

The MVP runs a local router, Redis/Postgres stack, host worker, and an API server
that serves the dashboard SPA.
GitHub reaches the router through a public HTTPS webhook endpoint, usually via a
Cloudflare Tunnel. The router also exposes an authenticated worker-transport
endpoint (`POST /worker/session` + a `GET /worker/stream` WebSocket) so a remote
worker can establish and heartbeat its session over that same tunnel (ADR-003).
The architecture as built is documented in
[`ai/ARCHITECTURE.md`](./ai/ARCHITECTURE.md) and the ADRs under
[`docs/decisions/`](./docs/decisions/); this README is the shortest path to a
working checkout.

## How it works

```text
GitHub → HTTPS webhook → Router → durable Postgres dispatch → Redis wake-up
                                                        ↓
                                      host Worker → isolated worktree → agent CLI
                                                        ↓
                                      commit / PR / review / board update
```

- Planning and Implementation start from project-board status changes — on GitHub
  Projects, a Linear board (issue #530), or a Jira project (issue #580).
- Review starts when a SWARM-managed pull request opens or its checks complete.
- Respond-to-review and Respond-to-CI start from pull-request lifecycle events.
- The worker runs `claude`, `agy` (Antigravity), or `codex` in an isolated
  worktree and performs deterministic GitHub delivery after the agent exits.
- Before any worktree or agent, a dispatch gate confirms an *eligible* worker may
  take the phase — active enrollment, the owner's sharing consent, a live
  connection, free capacity, the phase (both the machine's declared repertoire and
  the phases the enrollment permits in this project) and the configured CLI. For
  Implementation, an
  assigned item runs only on a worker owned by its assignee (never someone
  else's); an unassigned one takes a free eligible worker — chosen across the
  whole pool, so a phase several machines can run does not consume the one machine
  another waiting phase needs (issue #533). **Planning is
  central** — it is never routed by assignment, so it takes any capable worker
  rather than waiting on the assignee's (issue #469). **A continuation runs where
  its work is** — a run that preserved a checkout (a checkpoint, a resumable
  session, a delivery sidecar) is pinned to the machine holding it and waits for
  that machine rather than starting over elsewhere, until an operator chooses
  "Reset & restart" (issue #567). **The gate has one rule for every
  deployment** — a single-user install registers and enrolls its one local worker
  exactly as anyone else does (issue #552); `SWARM_SINGLE_USER_MODE` is the API's
  authentication policy and no longer bypasses dispatch. Each host authenticates
  with the credential printed once by `swarm workers register`
  (`SWARM_WORKER_CREDENTIAL`); the selected host atomically reserves capacity
  before the phase can start. A project with no enrolled, connected worker has
  nowhere to run: its dispatch waits durably until one enrolls. **A wait for a
  machine ends as soon as one turns up** — a worker connecting, or finishing a run
  and freeing its slot, starts the dispatches that were only waiting for that
  rather than leaving them to the next re-check (issue #610); a wait for a *human*
  (consent, an enrollment, a permitted phase) keeps the timed cadence, since
  nothing a machine does can clear it.
- Pending work is durable in Postgres; Redis carries wake-ups, not the source
  of truth. See [`docs/pipeline.md`](./docs/pipeline.md) for lifecycle details.
- **Dispatch always runs on the control plane (ADR-003 §2).** The **router**
  hosts the queue consumer and the dispatch gate: it selects a connected, eligible
  worker, composes the system prompt + target branch, and pushes a
  `TaskAssignment` to it (never a persona secret); the worker runs the phase and
  reports the result back over the same transport for the router to settle. There
  is no second arrangement — the in-process executor was deleted in issue #544 so
  that one path carries every run. A project with no enrolled, connected worker
  leaves its dispatch durably pending. See
  [`docs/configuration.md`](./docs/configuration.md).

## Prerequisites

- Node.js 22 or newer and npm
- Docker Compose
- Git
- Authenticated agent CLIs (`claude`, `agy`, and/or `codex`)
- A GitHub repository and a project-management board with a webhook: a GitHub Projects v2 board, a Linear team, or a Jira Cloud project
- Two distinct GitHub identities for loop prevention: the worker operator's own
  token (`SWARM_OPERATOR_GH_TOKEN`, the implementer persona) set in `.env` on each
  host, and a separate project-scoped reviewer credential
- A project credential for the **board**, separate from the two above. GitHub
  Projects uses `credentials.pm.apiToken` (conventionally
  `PM_GITHUB_PROJECTS_TOKEN`) with `repo`, `project`, and `read:org`; Linear uses
  the required `credentials.pm.apiKey` and `credentials.pm.webhookSecret` roles
  (conventionally `LINEAR_API_KEY` and `LINEAR_WEBHOOK_SECRET`); Jira uses the
  required `credentials.pm.email`, `credentials.pm.apiToken`, and
  `credentials.pm.webhookSecret` roles (conventionally `JIRA_EMAIL`,
  `JIRA_API_TOKEN`, and `JIRA_WEBHOOK_SECRET`), since Jira Cloud authenticates
  with basic auth. Every board read,
  write, and dashboard discovery authenticates with the selected provider's
  credential, configurable from the dashboard's **Project Management** tab. See
  [`docs/configuration.md`](docs/configuration.md)

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
> **It is an authentication policy, and nothing more** (issue #552). It does *not*
> change how work is dispatched: this install registers and enrolls its one local
> worker exactly as a multi-user one does (the three commands under **Register
> this machine as a worker** below), because worker selection has a single rule
> for every deployment. Without that worker, phases queue up with nothing to run
> them — `swarm start` and `swarm status` say so.
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
runs on an enrolled worker or it waits (issue #552). In single-user mode the
owner is the bootstrapped `localhost-admin` account, which exists once the API
has served a request (start `npm run dev:api` and open the dashboard first, or
use a user you created with `swarm users add`):

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

**There is one worker program and one command for it.** `npm run dev:worker` runs
`src/transport/connect-entry.ts` on every machine, remote or the control-plane host
itself (issues #551/#553). Point it at the router and give it the operator's own
GitHub token; on the control-plane host that URL is simply loopback:

```bash
# .env on the machine running the worker
SWARM_CONTROL_PLANE_URL=http://localhost:3100      # remote worker: https://<your-tunnel>
SWARM_WORKER_CREDENTIAL=<from `swarm workers register`>
SWARM_OPERATOR_GH_TOKEN=<your own GitHub token>
SWARM_WORKER_REPO_ROOT=/path/to/this-hosts/checkout  # optional; defaults to cwd
```

The **router** dequeues and dispatches; `SWARM_WORKER_CONCURRENCY` bounds how many
dispatches it drives at once (default 1), and a project's **Maximum Concurrent
Jobs** setting bounds it further per project. See
[`docs/configuration.md`](docs/configuration.md).

The worker holds **only** the credential, the control-plane URL, and the
operator's own GitHub token — no `DATABASE_URL`/`REDIS_URL`, even on a host that has
them. Its agent therefore authenticates as the *operator's own* GitHub account
everywhere, which is ADR-004 §2's decision; the project-scoped reviewer PAT and PM
credential never leave the server, so a submitted review's identity is unchanged. It performs the
`/worker/session` handshake (declaring the CLIs it can run and the pipeline phases
it can execute), keeps its session
live over the `/worker/stream` WebSocket, reconnects with backoff (ADR-003 §1),
and executes a pushed `TaskAssignment` **DB-free**: project config comes from the
assignment while `repoRoot` is resolved from this host (`SWARM_WORKER_REPO_ROOT`,
defaulting to the launch directory), source-carrying delivery (commit / push /
create-PR) runs under the operator token, and everything needing something this
worker must not hold goes up to the control plane's delivery API — Implementation's board moves/comments and
dependency lookup and Respond-to-review's card lookup + board moves under the
project's PM credential, Review's submitted verdict under its reviewer PAT, and
the two things backed by a database the control plane owns: Review's
verdict-ledger reads/writes and the follow-up Review a pushed fix enqueues.
Results stream back over the transport (ADR-003 §2). **All six phases** run this
way (`respond-to-ci`, `resolve-conflicts`, `implementation`, `review`,
`respond-to-review`, `planning`): Planning was the last holdout and joined in issue
#536, so which phases an instance can run no longer depends on which machine a
worker happens to be. Its board surface — create a split's sibling cards, chain
their dependency edges, re-scope the parent, label what finished, and find its own
plan comment on a retry — rides five more PM delivery routes under the project's PM
credential, while its agent run, plan file and scope gate stay worker-side. A sixth
followed with issue #543: a split interrupted partway now resumes from a per-child
marker in each child's body instead of creating that child a second time. Because
the daemon declares its phase repertoire at handshake, the control plane never
routes a phase to a worker that cannot run it and the work waits for one that can
(issue #467) — which still matters for a daemon built before #536, since it declares
only five; the worker-side gate fails such an assignment cleanly as a backstop.
Every worker has the same permissions: which phases a project may give a machine is
the enrollment's own choice, made by the worker's owner and approved by a project
administrator, with no reference to who owns the machine (issue #542). The
control-plane host's own worker runs this identical program over loopback, so a
remote worker and a local one are the same code path rather than two that have to be
kept in step. See
[`docs/cloudflare-tunnel.md`](docs/cloudflare-tunnel.md#remote-worker-transport-worker).

Open <http://localhost:5173>. For a compiled self-hosted dashboard, run
`npm run start:api` and open <http://localhost:3101> instead.

The worker is intentionally host-run: it needs local Git worktrees, agent CLI
authentication, and the developer's PATH. With local single-user mode on (the
Docker template default) the dashboard opens straight in as `localhost-admin`
with no `/login` step; with it disabled the dashboard uses per-user session auth
(sign in at `/login` with a user created via `swarm users`, above). `/health` is
unauthenticated either way, while every API request in multi-user mode carries
an HTTP-only session cookie. Dispatch is unaffected by that choice: both modes
enforce the same federated eligibility/fencing/affinity/capacity gate against
this host's registered worker. See
[`docs/operations.md`](./docs/operations.md) for health
checks, ports, webhook setup, and troubleshooting.

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
  member per PM provider — GitHub Projects, Linear, or Jira, plus Trello's, which
  parses ahead of that provider being registered), credential references (the
  SCM reviewer/webhook pair plus the PM provider's own roles under
  `credentials.pm`), agent, and pipeline settings. Apply changes with
  `npm run db:seed` or `swarm config apply`.
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
- [`PROJECT.md`](./PROJECT.md) — the original design document, **frozen as a historical baseline**; read it for original intent, not current behavior

The live task backlog is the [SWARM GitHub Projects board](https://github.com/orgs/SmartTechBrewery/projects/6/views/1).

## Contributing

Read [`ai/RULES.md`](./ai/RULES.md) before making changes. Run
`npm run verify` before submitting a change. GitHub Actions runs the same
verification command for every pull request.

## License

SWARM is licensed under the [Apache License 2.0](./LICENSE).
