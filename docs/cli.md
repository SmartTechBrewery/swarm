# SWARM command reference

Every command SWARM ships, in one place: the **`swarm` operator CLI** (stack
lifecycle, config, users, workers, project membership) and the **`npm run`
scripts** that run the host processes (API, worker, dashboard) and the
database/queue/test tooling.

This document is the human-readable mirror of the CLI's own `--help` output and
the `package.json` scripts — it stays in lock-step with them (see
[`ai/RULES.md` §1/§7](../ai/RULES.md)). For config *options* (env vars,
`swarm.config.json` fields) see [`configuration.md`](./configuration.md); for
operator workflows see [`operations.md`](./operations.md).

---

## Invoking the CLI

The `swarm` CLI is a small operator dispatcher (`src/cli/index.ts`). Two ways to
call it:

```bash
npm run swarm -- <command> [options]   # from source (loads .env if present)
swarm <command> [options]              # global binary, after `npm run build`
```

`npm run swarm -- …` runs it straight from TypeScript via `tsx`, loading `.env`
when present. The `--` separates npm's own args from the ones passed to the CLI —
it is required.

**Environment.** Commands that touch the database (`config`, `users`, `members`,
`identities`, `workers`, `queue`, `run`, `worktrees`) need `DATABASE_URL` (and some
also `REDIS_URL`) in the environment. `npm run swarm -- …` and the dedicated npm
wrappers (`db:seed`, `queue:clear`, `worktrees:prune`) load `.env` for you;
invoking the global `swarm` binary directly requires those vars to be exported.

Run `swarm --help`, or `swarm <command> --help` on the multi-subcommand commands
(`config`, `queue`, `run`, `users`, `members`, `identities`, `workers`), to print
the authoritative usage.

---

## Operator CLI — `swarm`

| Command | Purpose |
| --- | --- |
| [`init`](#swarm-init) | Bootstrap local config (`.env` + `swarm.config.json`) |
| [`config apply`](#swarm-config) | Load `swarm.config.json` into Postgres (projects + credentials) |
| [`start`](#swarm-start) | Start the local stack (postgres, redis, router) |
| [`stop`](#swarm-stop) | Stop the stack (optionally drop its volumes) |
| [`status`](#swarm-status) | Show container states and probe the router's health |
| [`logs`](#swarm-logs) | Tail stack logs |
| [`queue clear`](#swarm-queue) | Cancel all pending queue work |
| [`run reset`](#swarm-run) | Reset a wedged run and restart its phase (last resort) |
| [`users`](#swarm-users) | Manage SWARM users and the installation admin |
| [`members`](#swarm-members) | Manage project membership |
| [`identities`](#swarm-identities) | Link a user to the handles they own on a provider |
| [`workers`](#swarm-workers) | Register and manage local workers |
| [`worktrees prune`](#swarm-worktrees) | Prune stale per-task worktrees |

> The worker is **not** managed by this CLI — it runs on the host, outside Docker
> Compose (it needs the developer's PATH/auth for git and the agent CLIs). Start
> it with `npm run dev:worker` (see [Process & dev scripts](#process--dev-scripts-npm-run)).

### `swarm init`

```bash
swarm init
```

Bootstrap the two pieces of local config a developer needs before starting the
stack: `.env` (copied from `.env.docker.example`) and `swarm.config.json` (the
project config). Both are created **only when absent** — `init` never clobbers an
edited config; if `swarm.config.json` already exists it is validated instead, so
a re-run is a cheap "is my config still well-formed?" check.

### `swarm config`

```bash
swarm config apply [--config <path>]
```

- **`apply`** — upsert the config's projects and referenced credentials into the
  DB. Credential *values* are read from the environment by the reference (env-var
  key) named in each project's `credentials` block; a reference whose env var is
  unset is skipped with a warning, not written.
- **`--config <path>`** — path to the config file (default:
  `<repo-root>/swarm.config.json`).

Wrapper: `npm run db:seed`.

### `swarm start`

```bash
swarm start [--build]
```

Bring up the local stack (postgres, redis, router) via Docker Compose. `--build`
rebuilds images first. The worker is intentionally not started (it runs on the
host).

### `swarm stop`

```bash
swarm stop [-v | --volumes]
```

Tear down the stack. By default the postgres/redis volumes are **preserved** (so
project config and run history survive a restart); `--volumes`/`-v` drops them
for a clean slate.

### `swarm status`

```bash
swarm status
```

A quick health snapshot: the stack's container states (`docker compose ps`) plus
a probe of the router's `/health` endpoint on the published host port
(`ROUTER_PORT`, default 3100). The worker isn't shown (it runs on the host).

### `swarm logs`

```bash
swarm logs [service] [-f | --follow]
```

Tail the stack's container logs. An optional service name (`postgres`, `redis`,
`router`) scopes it to one container; `--follow`/`-f` streams new lines until
interrupted.

### `swarm queue`

```bash
swarm queue clear
```

- **`clear`** — cancel every waiting dispatch (pending, capacity-blocked, and
  retry-scheduled — the canonical durable queue) and drain their queued wake-ups
  plus any legacy Redis jobs. Cancelled dispatches can never be resurrected by a
  retry, slot release, or reconciliation. **Active (running) work is not touched**
  — stop the worker first if nothing should start while clearing.

Requires `DATABASE_URL` and `REDIS_URL`. Wrapper: `npm run queue:clear`.

### `swarm run`

```bash
swarm run reset <runId> [--force]
```

- **`reset`** — the last-resort recovery for a single **wedged** run: one whose
  dispatch, Redis cancellation flag, worktree lease, and recovery record disagree
  badly enough that neither "Retry now" nor "Terminate" can move it. It performs
  one sequence and prints one line per step:
  1. **dispatch** — cancels the run's active dispatch (`none` when there wasn't
     one, `force-cancelled` when a worker had already claimed it);
  2. **cancellation flag** — clears the Redis user-termination flag, or the worker
     would kill the fresh attempt at its start-check;
  3. **checkout** — settles the checkout and worktree lease, releasing a *stale*
     lease no live run owns (the marker a wedged run leaves behind). Reports
     `removed`, `retained` with its reason (`uncommitted changes`,
     `unpushed commits`, a lease held by another live run), or `none on disk`. A
     reset never keeps a checkout for a saved agent session — restarting from
     scratch is the point of it;
  4. **recovery record** — clears it plus any captured session id;
  5. **restarted** — re-dispatches the phase from scratch and prints the new
     dispatch id.
- **`--force`** — also resets a run still marked `running`, cancels a dispatch a
  worker has already claimed, and **discards** uncommitted changes and unpushed
  commits instead of retaining the checkout. It prints a warning before acting and
  **cannot stop an already-spawned agent process** — only Terminate can, so a
  forced reset of a live run is a deliberate operator choice.

A refused reset (a healthy `running` run without `--force`, a dispatch a worker
just claimed, a run with no stored job payload, a concurrent reset) changes
nothing: the command prints the refusal and exits **1**. Every guard runs before
the first mutation, and a failure part-way through leaves the run
terminal-and-idle — exactly the state a second `swarm run reset` retries from.

Requires `DATABASE_URL` and `REDIS_URL`. Works with the worker **and** the API
stopped — it goes straight to Postgres and Redis, which is the point: the same
action exists in the dashboard (a run's "Reset & restart" button), and this is how
you reach it when the services that serve it are down.

Run it **on the host that owns the run's worktree**: step 3 inspects and removes
that checkout on local disk, so from any other machine the checkout looks absent,
the report says so, and the lease is released for a checkout that still exists
elsewhere.

### `swarm users`

```bash
swarm users add <identifier> [--name <displayName>] [--admin]
swarm users list
swarm users grant-admin <identifier>
swarm users revoke-admin <identifier>
swarm users set-password <identifier>
```

- **`add`** — create a user with the given login handle (username/email).
  `--name` sets the display name (defaults to the identifier); `--admin`
  designates the user an installation admin.
- **`list`** — list all users, one per line.
- **`grant-admin` / `revoke-admin`** — add/remove a user's installation-admin role.
- **`set-password`** — set a user's dashboard login password. Prompts (no echo)
  on a TTY, otherwise reads the password from stdin. Never logs it.

Requires `DATABASE_URL`. Creating the first admin + password is how you get a
dashboard login (there is no self-signup in the UI).

### `swarm members`

```bash
swarm members add <project-id> <user-identifier> [--role <role>]
swarm members list <project-id>
swarm members set-role <project-id> <user-identifier> --role <role>
swarm members remove <project-id> <user-identifier>
```

Manage who belongs to a project and in what role. `--role` is one of
`projectAdmin | member | contributor` (default: `member`). Roles, most to least
privileged: **projectAdmin** (administer) > **member** (write) > **contributor**
(read). Requires `DATABASE_URL`. Membership is the read model authorization will
build on — it is not yet enforced by any router.

### `swarm identities`

```bash
swarm identities link --user <identifier> --provider <provider> --handle <handle>
swarm identities unlink --provider <provider> --handle <handle>
swarm identities list [--user <identifier>]
```

Link a SWARM user to the handles they own on a provider (e.g. a GitHub login), so
assignee resolution can map an inbound event's actor to a SWARM user. `<provider>`
is a provider-neutral source key — `github-projects` for the GitHub Projects
board. Provider and handle are matched case-insensitively. Re-linking the same
pair is a no-op; a handle already linked to a different user is rejected. Requires
`DATABASE_URL`.

### `swarm workers`

```bash
swarm workers register <owner-identifier> --name <displayName> --cli <c1,c2,...>
swarm workers list [<owner-identifier>]
swarm workers set-cli <worker-id> --cli <c1,c2,...>
swarm workers remove <worker-id>
swarm workers enroll <worker-id> <project-id> --cli <c1,c2,...> [--concurrency <n>] [--active] [--consent]
swarm workers approve <worker-id> <project-id>
swarm workers consent <worker-id> <project-id> <on|off>
```

- **`register`** — register a worker for an owner (by login handle) with a display
  name and declared CLIs (`--cli`, comma-separated, one or more of
  `claude | antigravity | codex`). **Prints a worker credential ONCE** — store it
  then (it is never shown again) and put it in `.env` as `SWARM_WORKER_CREDENTIAL`;
  the host worker authenticates its session with it at startup.
- **`list`** — list workers (`<id>\t<displayName>\t<clis>` per line). With an owner
  identifier, only that owner's; without, all owners'. Never prints a credential.
- **`set-cli`** — replace a worker's declared CLIs by worker id.
- **`remove`** — deregister a worker by worker id.
- **`enroll`** — enroll a worker into a project with allowed CLIs (`--cli`, a
  subset of the worker's capabilities) and an optional `--concurrency` per-project
  sub-limit. Omit `--concurrency` for no sub-limit (the default): the worker's
  concurrency for this project is then governed by its launch `--concurrency` flag
  (`SWARM_WORKER_CONCURRENCY`) and the project's Maximum Concurrent Jobs.
  Starts pending with sharing consent off; `--active` approves it and `--consent`
  grants sharing consent at once (operator seeding).
- **`approve`** — approve a pending enrollment (worker + project) → active.
- **`consent`** — turn an enrollment's owner-controlled sharing consent on or off.
  Revoking it blocks future dispatch without stopping a running agent.

Requires `DATABASE_URL`. A worker is a local execution environment owned by a
SWARM user; an enrollment offers it to a project, and it is routable **only while
active AND sharing consent is on**. A project with no enrolled workers is
unfederated and runs locally.

> **Known gap:** there is no CLI command to change an *existing* enrollment's
> allowed CLIs — `enroll` refuses when the worker is already enrolled. Until one
> is added, widen it with a direct `UPDATE` on `worker_project_enrollments.allowed_clis`.

### `swarm worktrees`

```bash
swarm worktrees prune [--project <id>] [--dry-run]
```

- **`prune`** — sweep and remove stale per-task worktrees under
  `.swarm-workspaces/`. A worktree is only removed when it is safe to discard: not
  leased (in-flight), not pinned by a resumable deferred/failed run, with no
  uncommitted changes **and** no unpushed local commits — anything else is
  reported as skipped and left in place. `--project <id>` limits the sweep to one
  project (default: all configured projects); `--dry-run` reports what would be
  pruned without removing anything.

Requires `DATABASE_URL` (project config) and `REDIS_URL` (in-flight check).
Wrapper: `npm run worktrees:prune`.

---

## Process & dev scripts (`npm run`)

The host processes and tooling that live outside the `swarm` CLI. Run from the
repo root.

### Services

| Script | Description |
| --- | --- |
| `npm run dev:api` | Migrate the DB, free `API_PORT`, then start the API server (`:3101`) with `--watch`. In dev it serves the API only; it also serves the built dashboard SPA from `dashboard/dist` when that exists. |
| `npm run start:api` | Build the dashboard, then run `dev:api` — the recommended **same-origin** mode where one process serves the SPA + API on `:3101` (used for public/tunnel access). |
| `npm run reload` | After `git pull`: sync both dependency trees, rebuild the dashboard (`dist`, picked up live by a running `dev:api`/`start:api` since it serves `dist` from disk), and apply migrations. Does **not** restart the worker or rebuild the router — do those manually if their code changed (it prints the reminder). |
| `npm run dev:worker` | Migrate the DB, then start the host worker (BullMQ consumer). This is how the worker runs — it is not in Docker Compose. Runs one job at a time by default; append `-- --concurrency <n>` to run up to N at once (overrides `SWARM_WORKER_CONCURRENCY`). |
| `npm run dev:worker:watch` | Same as `dev:worker`, with `--watch` auto-restart. |
| `npm run dev:worker:seed` | Apply `swarm.config.json` (`db:seed`) then start the worker. |
| `npm run dev:dashboard` | Start the dashboard Vite dev server (`:5173`) — local development only; not what you expose publicly. |
| `npm run dev:router` | Free `ROUTER_PORT`, then run the router (webhook receiver) on the host with `--watch` — for router development (in normal operation the router runs in Compose). |
| `npm run dev` | Run `src/index.ts` (combined entry) with `--watch`. |

### Build & production start

| Script | Description |
| --- | --- |
| `npm run build` | Compile TypeScript (`tsc`) and rewrite path aliases (`tsc-alias`) into `dist/`. |
| `npm run build:dashboard` | Build the dashboard SPA into `dashboard/dist`. |
| `npm run start` | Run the compiled combined entry (`dist/index.js`). |
| `npm run start:worker` | Migrate the DB, then run the compiled worker (`dist/worker/index.js`). |
| `npm run worker` | `build` then `start:worker`. |

### Database

| Script | Description |
| --- | --- |
| `npm run db:migrate` | Apply pending Drizzle migrations (`drizzle-kit migrate`). |
| `npm run db:seed` | `swarm config apply` — load `swarm.config.json` into Postgres. |
| `npm run db:generate` | Generate a new migration from schema changes (`drizzle-kit generate`). |
| `npm run db:push` | Push the schema directly to the DB without a migration file (`drizzle-kit push`) — dev only. |
| `npm run db:studio` | Open Drizzle Studio against the DB. |

### Queue & worktrees

| Script | Description |
| --- | --- |
| `npm run queue:clear` | `swarm queue clear` with `.env` loaded — cancel all pending queue work. |
| `npm run worktrees:prune` | `swarm worktrees prune` with `.env` loaded — prune stale worktrees. |

### Verification

| Script | Description |
| --- | --- |
| `npm run verify` | `lint` + `typecheck` + `test` — the full pre-merge gate. |
| `npm test` | Unit tests (Vitest) + dashboard tests. |
| `npm run test:unit` | Unit-project tests only. |
| `npm run test:integration` | Integration-project tests (need the test DB — see below). |
| `npm run test:all` | Every Vitest project. |
| `npm run test:watch` | Unit tests in watch mode. |
| `npm run test:coverage` | Unit tests with coverage. |
| `npm run test:dashboard` | Dashboard tests. |
| `npm run test:db:up` / `test:db:down` | Start / tear down the integration-test Postgres (`docker-compose.test.yml`). |
| `npm run lint` / `lint:fix` | Biome check (write mode fixes in place). |
| `npm run typecheck` | Type-check the backend (`tsconfig.typecheck.json`). |
| `npm run typecheck:dashboard` | Type-check the dashboard. |
