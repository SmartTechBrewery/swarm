# SWARM manual

Everything that used to live below the introduction in
[`README.md`](../README.md): what a machine needs before it can run SWARM, how the
worker works and what it deliberately does not hold, the command reference, the
configuration layers, and the map of every other document.

The README is the short version — what SWARM is and how to get it running. This is
the long one. The focused references it points at (the CLI reference, the
configuration catalogue, the pipeline description) remain the source of truth for
their own subjects; this manual is the operator's path through them.

## Contents

- [Prerequisites](#prerequisites)
- [Quick start, beyond the README](#quick-start-beyond-the-readme)
- [The worker](#the-worker)
- [Failure diagnosis](#failure-diagnosis)
- [Common commands](#common-commands)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Temporary: pre-multi-repo restore point](#temporary-pre-multi-repo-restore-point)

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
  [`docs/cli.md`](./cli.md))
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
  Management** tab. See [`docs/configuration.md`](./configuration.md).

## Quick start, beyond the README

The README's quick start is the shortest path that works. This is what it leaves out.

**Local single-user mode is on by default.** The `.env.docker.example` template
sets `SWARM_SINGLE_USER_MODE=true`, so a local install needs **no dashboard user,
no password, no `/login`, and no session cookie**: the API bootstraps a
passwordless `localhost-admin` and signs you straight into the dashboard.

**It is an authentication policy, and nothing more.** It does *not* change how
work is dispatched: this install registers and enrolls its one local worker
exactly as a multi-user one does, because worker selection has a single rule for
every deployment. Without that worker, phases queue up with nothing to run them —
`swarm start` and `swarm status` say so.

**Multi-user alternative.** Set `SWARM_SINGLE_USER_MODE=false` in `.env` (or
remove the line) to require per-user session auth instead. Then create your
dashboard user and set its login password before signing in at `/login`:

```bash
npm run swarm -- users add you@example.com --admin    # create your dashboard user, then
npm run swarm -- users set-password you@example.com   # set its login password (prompts, no echo)
```

**Registering the worker, one step at a time.** `workers register-and-enroll`
collapses two commands; either half can be run on its own, which is what you want
when the two approvals are separate human decisions:

```bash
npm run swarm -- workers register localhost-admin --name "this machine" --cli claude
npm run swarm -- workers enroll <worker-id> <project-id> --cli claude --active --consent
```

In single-user mode the owner is the bootstrapped `localhost-admin` account, which
exists once the API has served a request (start `npm run dev:api` and open the
dashboard first, or use a user you created with `swarm users add`). It has no
password until you set one: `npm run swarm -- users set-password localhost-admin`.

`swarm workers` reaches the control plane over `SWARM_CONTROL_PLANE_URL` rather
than Postgres since issue #800, so it needs a [`swarm login`](./cli.md#swarm-login)
session and **no `DATABASE_URL`** — which is what lets a second machine onboard
itself.

`workers register` prints a credential **once** — put it in `.env` as
`SWARM_WORKER_CREDENTIAL` before starting the worker, or skip that by running
`swarm run:worker` from the checkout you registered in. `swarm start` and `swarm
status` warn when this host has no usable credential. The full runbook, including
someone else's machine, is [`docs/onboarding-worker.md`](./onboarding-worker.md);
on macOS, [`docs/launchd-worker-autostart.md`](./launchd-worker-autostart.md) runs
it from a launchd agent instead of a terminal tab.

For a compiled self-hosted dashboard, run `npm run start:api` and open
<http://localhost:3101> instead of the Vite dev server.

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
the follow-up Review a pushed fix enqueues. Planning's board surface (its own
blocker/dependent lookup for the dependency gate it has run since issue #889 —
which rides the routes Implementation's already uses — plus creating a split's
sibling cards, chaining their dependency edges, carrying the split item's own
dependents forward onto every phase it produced (issue #890 — the same dependent
read, plus Respond-to-review's card lookup to resolve a dependent that carries no
board id), re-scoping the parent, labelling what finished, and finding its own
plan comment on a retry) rides five more
PM delivery routes, while its agent run, plan file, and scope gate stay
worker-side; a split interrupted partway resumes from a per-child marker rather
than creating that child twice. Results stream back over the transport (ADR-003
§2).

The **router** dequeues and dispatches; a project's **Maximum Concurrent Jobs**
setting and each enrolled worker's **concurrency allocation** are what bound how
many of its runs happen at once. Dispatch always runs on the control
plane (ADR-003 §2): there is no second arrangement — the in-process executor was
deleted so that one path carries every run. A project with no enrolled, connected
worker leaves its dispatch durably pending; a wait for a *machine* ends as soon
as one turns up (a worker connecting, or finishing a run and freeing its slot),
while a wait for a *human* (consent, an enrollment, a permitted phase) keeps the
timed cadence, since nothing a machine does can clear it.

The control-plane host's own worker runs this identical program over loopback, so
a remote worker and a local one are the same code path rather than two that have
to be kept in step. See
[`docs/cloudflare-tunnel.md`](./cloudflare-tunnel.md#remote-worker-transport-worker)
and [`docs/operations.md`](./operations.md) for health checks, ports,
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

# The same, then rebuild the Compose router and wait for it to report healthy
# (restart each worker yourself — see the script's own reminder)
npm run reload:all

# Operator identity — sign this CLI in to the control plane over the network
# (needs SWARM_CONTROL_PLANE_URL, not DATABASE_URL, so it works off the host)
npm run swarm -- login
npm run swarm -- login --status
npm run swarm -- login --logout

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
scripts, with descriptions, is in [`docs/cli.md`](./cli.md); detailed
operator guidance is in [`docs/operations.md`](./operations.md).

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
  Apply changes with `npm run db:seed` or `swarm config apply` — which seeds every
  credential value from this host's environment *except* a `webhookSecret`, since
  that one must match the secret on the project's own webhook and so is entered per
  project in the dashboard instead.
- Dashboard global settings — app-wide settings stored in Postgres and edited
  through the dashboard API.

The complete option catalogue, defaults, and source-of-truth schemas are in
[`docs/configuration.md`](./configuration.md).

## Documentation

- [`docs/cli.md`](./cli.md) — complete command reference: every `swarm`
  operator CLI command and `npm run` script, with descriptions
- [`docs/operations.md`](./operations.md) — setup, run modes, ports,
  health checks, operator CLI, migrations, queues, worktrees, and webhooks
- [`docs/configuration.md`](./configuration.md) — complete environment,
  project, and global-settings reference
- [`docs/pipeline.md`](./pipeline.md) — phases, triggers, security, and
  provider boundaries
- [`docs/agent-containment.md`](./agent-containment.md) — how far outside
  its worktree an agent CLI run can reach, per CLI, and how to tighten it
- [`docs/status.md`](./status.md) — implemented MVP areas and current
  roadmap snapshot
- [`ai/ARCHITECTURE.md`](../ai/ARCHITECTURE.md) — engineering architecture and
  implementation conventions
- [`ai/TESTING.md`](../ai/TESTING.md) — test strategy and verification guidance
- [`docs/cloudflare-tunnel.md`](./cloudflare-tunnel.md) — exposing the
  local router to GitHub
- [`docs/onboarding-worker.md`](./onboarding-worker.md) — adding a new
  user + worker, local or remote
- [`docs/launchd-worker-autostart.md`](./launchd-worker-autostart.md) — running a
  worker from a launchd agent on macOS instead of a terminal tab
- [`docs/github-projects-v2-api.md`](./github-projects-v2-api.md) —
  Projects v2 API and webhook details
- [`docs/decisions/`](./decisions/) — architecture decision records
- [`docs/public-hosting-exploration.md`](./public-hosting-exploration.md) —
  what a public, multi-tenant deployment would take (hosting, missing pieces,
  credential model, OAuth across the three SCM providers). **Deferred** — SWARM
  stays on privately hosted instances; kept so the analysis is not re-derived
- [`PROJECT.md`](../PROJECT.md) — the original design document, **frozen as a historical baseline**; read it for original intent, not current behavior

The live task backlog is the [SWARM GitHub Projects board](https://github.com/orgs/SmartTechBrewery/projects/6/views/1).

## Temporary: pre-multi-repo restore point

`single_repo_backup` marks the last commit before the multi-repo migration
(issues [#683](https://github.com/SmartTechBrewery/swarm/issues/683)–[#687](https://github.com/SmartTechBrewery/swarm/issues/687)) — one project owning several
repositories instead of exactly one. That migration reaches the config schema,
the run read model, every phase's dedup key, and worker routing, so the branch
exists to return to a known-good single-repository state if it goes wrong.

**Delete this branch and this section once the migration has stabilized.**
