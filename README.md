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
The long-term architecture and protocol are documented in
[`PROJECT.md`](./PROJECT.md); this README is the shortest path to a working
checkout.

## How it works

```text
GitHub → HTTPS webhook → Router → durable Postgres dispatch → Redis wake-up
                                                        ↓
                                      host Worker → isolated worktree → agent CLI
                                                        ↓
                                      commit / PR / review / board update
```

- Planning and Implementation start from GitHub Projects board status changes.
- Review starts when a SWARM-authored pull request opens or its checks complete.
- Respond-to-review and Respond-to-CI start from pull-request lifecycle events.
- The worker runs `claude`, `agy` (Antigravity), or `codex` in an isolated
  worktree and performs deterministic GitHub delivery after the agent exits.
- Before any worktree or agent, a dispatch gate confirms an *eligible* worker may
  take the phase — active enrollment, the owner's sharing consent, a live
  connection, free capacity, and the configured CLI. An assigned item runs only
  on a worker owned by its assignee (never someone else's); an unassigned one
  takes the first free eligible worker. (When single-user mode is enabled via
  `SWARM_SINGLE_USER_MODE=true`, this entire federated dispatch gate is bypassed
  and every phase executes locally on the host worker without a credential.)
  When single-user mode is disabled, each federated host must authenticate with
  the credential printed once by `swarm workers register`
  (`SWARM_WORKER_CREDENTIAL`); the selected host atomically reserves capacity
  before the phase can start. A project with no enrolled workers is
  unfederated and runs locally as before.
- Pending work is durable in Postgres; Redis carries wake-ups, not the source
  of truth. See [`docs/pipeline.md`](./docs/pipeline.md) for lifecycle details.

## Prerequisites

- Node.js 22 or newer and npm
- Docker Compose
- Git
- Authenticated agent CLIs (`claude`, `agy`, and/or `codex`)
- A GitHub repository, Projects v2 board, and webhook
- Two distinct GitHub identities for loop prevention: the worker operator's own
  token (`SWARM_OPERATOR_GH_TOKEN`, the implementer persona) set in `.env` on each
  host, and a separate project-scoped reviewer credential

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
> passwordless `localhost-admin` and signs you straight into the dashboard. It
> also routes **every pipeline phase through this host worker**, so dispatch needs
> **no worker credential, no worker-project enrollment, no admin approval, no
> assignee linking, and no sharing consent** — the federated roster is skipped
> even if worker/enrollment rows exist. Skip the account commands below.
>
> **Multi-user alternative.** Set `SWARM_SINGLE_USER_MODE=false` in `.env` (or
> remove the line) to restore the full federated policy — per-user session auth
> *and* the complete enrollment/consent/affinity/capacity dispatch gate. Then
> create your dashboard user and set its login password before signing in at
> `/login`:
>
> ```bash
> npm run swarm -- users add you@example.com --admin    # create your dashboard user, then
> npm run swarm -- users set-password you@example.com   # set its login password (prompts, no echo)
> ```

Start these processes in separate terminals:

```bash
npm run dev:api                   # API server on 127.0.0.1:3101
npm run dev:dashboard             # Vite dashboard on localhost:5173
npm run dev:worker                # host worker (1 job at a time by default)
npm run dev:worker -- --concurrency 2   # …or run up to N jobs at once
```

By default the worker runs one job at a time. Pass `--concurrency <n>` (or set
`SWARM_WORKER_CONCURRENCY`) to raise it — the flag wins over the env var. This is
the worker's own cap across every project it serves; a project's **Maximum
Concurrent Jobs** setting bounds it further per project. See
[`docs/configuration.md`](docs/configuration.md).

For a worker on a **different machine** from the router, run the remote transport
client instead of (or alongside) the in-process worker:

```bash
SWARM_CONTROL_PLANE_URL=https://<your-tunnel> \
SWARM_WORKER_CREDENTIAL=<from `swarm workers register`> \
npm run dev:worker:connect        # remote worker: connect over the tunnel, heartbeat
```

This client holds **only** the credential and the control-plane URL — no
`DATABASE_URL`/`REDIS_URL`. It performs the `/worker/session` handshake (declaring
the CLIs it can run), keeps its session live over the `/worker/stream` WebSocket,
and reconnects with backoff (ADR-003 §1). It is **additive**: the same-machine
`npm run dev:worker` path above is unchanged. See
[`docs/cloudflare-tunnel.md`](docs/cloudflare-tunnel.md#remote-worker-transport-worker).

Open <http://localhost:5173>. For a compiled self-hosted dashboard, run
`npm run start:api` and open <http://localhost:3101> instead.

The worker is intentionally host-run: it needs local Git worktrees, agent CLI
authentication, and the developer's PATH. With local single-user mode on (the
Docker template default) the dashboard opens straight in as `localhost-admin`
with no `/login` step, and every pipeline phase runs on this host worker without
consulting the federated roster — no enrollment, consent, or assignee affinity.
With it disabled the dashboard uses per-user session auth (sign in at `/login`
with a user created via `swarm users`, above) and dispatch enforces the full
federated eligibility/fencing/affinity/capacity gate; `/health` is
unauthenticated either way, while every API request in multi-user mode carries
an HTTP-only session cookie. See
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
- `swarm.config.json` — per-project repository, worktree, GitHub Projects,
  credential references, agent, and pipeline settings. Apply changes with
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
- [`docs/status.md`](./docs/status.md) — implemented MVP areas and current
  roadmap snapshot
- [`ai/ARCHITECTURE.md`](./ai/ARCHITECTURE.md) — engineering architecture and
  implementation conventions
- [`ai/TESTING.md`](./ai/TESTING.md) — test strategy and verification guidance
- [`docs/cloudflare-tunnel.md`](./docs/cloudflare-tunnel.md) — exposing the
  local router to GitHub
- [`docs/github-projects-v2-api.md`](./docs/github-projects-v2-api.md) —
  Projects v2 API and webhook details
- [`docs/decisions/`](./docs/decisions/) — architecture decision records
- [`PROJECT.md`](./PROJECT.md) — long-term architecture design and protocol

The live task backlog is the [SWARM GitHub Projects board](https://github.com/orgs/SmartTechBrewery/projects/6/views/1).

## Contributing

Read [`ai/RULES.md`](./ai/RULES.md) before making changes. Run
`npm run verify` before submitting a change. GitHub Actions runs the same
verification command for every pull request.

## License

SWARM is licensed under the [Apache License 2.0](./LICENSE).
