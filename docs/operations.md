# Operations

This guide covers local setup, dashboard access, operator commands, ports,
database migrations, and webhook exposure. The short setup path remains in the
root [README](../README.md); this is the detailed operational reference.

## Running the stack (local)

Postgres, Redis, and the router run in Docker Compose; the **worker runs on the host**:

```bash
cp .env.docker.example .env   # adjust POSTGRES_PASSWORD / ports if needed
docker compose up -d --build  # postgres, redis, router (NOT the worker) — detached
npm run db:migrate            # apply the Postgres schema (uses DATABASE_URL from .env)
npm run db:seed               # load swarm.config.json into Postgres (projects + credentials)
npm run swarm -- users add you@example.com --admin   # create the first user, then:
npm run swarm -- users set-password you@example.com   # set their dashboard login password (prompts, no echo)
cd dashboard && npm install && cd .. # install dashboard (frontend) dependencies
npm run dev:api               # start the API server on the host (default port 3101)
npm run dev:dashboard         # start the Vite dev server (default port 5173)
npm run dev:worker            # start the worker on the host (or: npm run build && npm run start:worker); SWARM_WORKER_CONCURRENCY in .env sets how many jobs run at once (default 1)
```
`swarm start`, `npm run dev:api`, `npm run dev:worker`, and their production
start variants apply pending committed migrations before serving requests or processing
jobs. `dev:worker` is intentionally stable: source edits do not restart it and abort a
live agent. Use `npm run dev:worker:watch` only while developing the worker itself and
when no real pipeline run is active. The worker also applies migrations **in-process on
every start**, so either mode refuses to serve jobs against a stale schema. The explicit
`npm run db:migrate` step remains useful for setup and maintenance, and is safe to run
repeatedly.

The dashboard can be run in two modes:

- **Development Mode (with Hot-Reloading)**:
  Run the backend API and the Vite development server side-by-side:
  ```bash
  npm run dev:api               # Starts the API server on port 3101
  npm run dev:dashboard         # Starts the Vite dev server on port 5173
  ```
  Open `http://localhost:5173` in your browser. Code changes will hot-reload automatically.

- **Self-Hosted Mode (Production Build)**:
  Because the compiled assets under `dashboard/dist` are ignored in git, you must compile the frontend assets if you want the API server to serve the SPA statically. You can run both steps with a single command:
  ```bash
  npm run start:api             # Compiles the dashboard SPA and starts the API server on port 3101
  ```
  Open `http://localhost:3101` in your browser. The API server will serve the compiled files as a fallback for any non-API/non-health routes.

The dashboard uses **per-user session auth** (issue #281 task 2). It binds to `127.0.0.1` and every dashboard API request except `/health` and the `ping` liveness probe is authorized by a session cookie, not a shared secret. A user signs in at `/login` (username/email + password); the server verifies the password, mints an opaque session, and returns it as an HTTP-only, `SameSite=Strict` cookie (`Secure` off localhost). Log out to revoke it. Set a user up first with `swarm users add` + `swarm users set-password` (below). There is no `DASHBOARD_TOKEN` anymore.

You can verify the dashboard API is running using `curl`:
```bash
# /health check requires no authentication
curl http://localhost:3101/health

# Log in — the session cookie lands in cookies.txt; the raw token is never in the body
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"identifier":"you@example.com","password":"…"}' \
  http://localhost:3101/auth/login

# Authenticated tRPC request, reusing the session cookie
curl -b cookies.txt http://localhost:3101/trpc/auth.me
```

The `swarm` operator CLI (`src/cli/`, SWARM-22) wraps the config + stack steps above:

- `swarm init` — scaffolds `.env` (from `.env.docker.example`) and a `swarm.config.json` project-config template, validating it if one already exists.
- `swarm config apply` (a.k.a. `npm run db:seed`, SWARM-56) — loads that file's projects and their referenced credentials into Postgres, which is where the router and worker actually resolve config from (`swarm.config.json` is otherwise scaffold/documentation only). `npm run db:seed` runs with `--env-file=.env`, so it sees `DATABASE_URL` and credential secrets automatically; standalone `swarm config apply` reads only the ambient environment — export those vars first, or just use `npm run db:seed` (a reference whose env var is unset is silently skipped).
- `swarm start [--build]` / `swarm stop [-v]` — bring the Compose stack up/down.
- `swarm status` — shows the container states and probes the router's `/health`.
- `swarm logs [service] [-f]` — tails the logs.
- `swarm queue clear` (a.k.a. `npm run queue:clear`) — cancels every waiting dispatch (pending, capacity-blocked, and retry-scheduled — the canonical durable queue, issue #284) and drains their queued wake-ups plus any legacy jobs from Redis. Cancelled dispatches can never be resurrected by a retry, slot release, or reconciliation. It deliberately does not cancel an active run; stop the worker first when clearing work before restarting it. Requires both `DATABASE_URL` and `REDIS_URL`.
- `swarm worktrees prune [--project <id>] [--dry-run]` (a.k.a. `npm run worktrees:prune`) — reclaims stale `task-<id>` worktrees under `.swarm-workspaces/` that are safe to discard: no longer leased (in-flight), not pinned by a resumable deferred/failed run, with no uncommitted changes **and** no unpushed local commits. Anything protected is skipped and left in place.
- `swarm run reset <runId> [--force]` (issue #429) — the per-run **last-resort recovery** for a *wedged* run: one whose dispatch, cancellation flag, worktree lease, and recovery record disagree badly enough that neither "Retry now" nor "Terminate" can move it. In one sequence it cancels the run's active dispatch, clears its Redis cancellation flag, settles its checkout and worktree lease, clears its recovery record, and re-dispatches the phase from scratch — printing one line per step (including the new dispatch id) so you can tell a reset that actually freed the checkout from one that restarted the run but left protected work behind. It is the **only** path that can release a stale `live-leased` lease — a lease marker no live run owns, which `swarm worktrees prune` honours and therefore skips forever. Without `--force` a checkout holding uncommitted changes or unpushed commits is retained (reported with its reason) and a run still marked `running` is refused; `--force` resets it anyway, cancels a dispatch a worker already claimed, and discards that work permanently — it cannot stop an already-spawned agent process, so terminate a genuinely live run first. A refused reset changes nothing and exits non-zero. Requires both `DATABASE_URL` and `REDIS_URL`, and works with the worker and the API stopped — it is the terminal equivalent of the dashboard's "Reset & restart" button on the run-detail page.
- `swarm users <add|list|grant-admin|revoke-admin|set-password>` — manages SWARM users and their dashboard credentials (the multi-user foundation, issue #281): `add <identifier> [--name <displayName>] [--admin]` creates a user by login handle (username/email) and optionally makes them the installation admin; `list` lists them; `grant-admin`/`revoke-admin <identifier>` toggle the installation-admin role; `set-password <identifier>` sets the user's dashboard login password (prompts without echo on a TTY, or reads it from stdin for scripting — never logged). Requires `DATABASE_URL`. A user needs a password set before they can sign in to the dashboard.
- `swarm members <add|list|set-role|remove>` — manages project membership (the multi-user foundation, issue #281): `add <project-id> <user-identifier> [--role <role>]` adds a user (by login handle) to a project with a per-project role (`projectAdmin | member | contributor`, default `member`); `list <project-id>` lists a project's members; `set-role <project-id> <user-identifier> --role <role>` changes an existing member's role; `remove <project-id> <user-identifier>` removes them. Roles rank `projectAdmin` (administer) > `member` (write) > `contributor` (read). Requires `DATABASE_URL`. Membership is not yet enforced by any router — it is the read model authorization will build on.
- `swarm identities <link|unlink|list>` — links a SWARM user to the handles they own on a provider (assignee resolution, issue #130): `link --user <identifier> --provider <provider> --handle <handle>` links a provider handle (e.g. a GitHub login) to a user looked up by login handle; `unlink --provider <p> --handle <h>` removes the link; `list [--user <identifier>]` lists every link, or one user's. `<provider>` is a provider-neutral source key (`github-projects` for the GitHub Projects board); provider and handle are matched case-insensitively, and a handle maps to at most one user — re-linking the same pair is a no-op, pointing it at a second user is refused. Requires `DATABASE_URL`. Links are read by assignee resolution (`src/identity/assignee-resolver.ts`); nothing routes on them yet.

It manages only the containerized stack — the worker still runs on the host (`npm run dev:worker`). Run it from source with `npm run swarm -- <command>`, or `npm run build` and invoke the `swarm` bin directly. The `npm run swarm` wrapper loads `.env` automatically (via `--env-file-if-exists=.env`, so `swarm init` still works before `.env` exists), so DB-backed subcommands like `users` and `members` see `DATABASE_URL`/`DATABASE_SSL` without exporting them first. The bare `swarm` bin reads only the ambient environment — export those vars (or use the `npm run swarm --` wrapper) when running it directly.

The worker isn't containerized because it provisions Git worktrees and spawns the `claude` / `antigravity` CLIs — those need the developer's own PATH, authentication, and config, which a container wouldn't have. Running it on the host is the local-first fit. It connects to the Compose Redis/Postgres over their published host ports (`REDIS_URL` / `DATABASE_URL` in `.env`), so **`git` and the `claude` / `antigravity` CLIs must be installed and authenticated on your machine** for the worker to get past provision/spawn.

The Postgres schema (project config + credentials at rest) is defined with **Drizzle** in `src/db/` — `npm run db:generate` regenerates migrations from the schema, `npm run db:migrate` applies them. Credentials are encrypted with AES-256-GCM before storage when `CREDENTIAL_MASTER_KEY` is set (plaintext otherwise, for local dev).

SWARM's host ports are offset from Cascade's defaults (router `3100` vs `3000`, API server `3101` vs Cascade's dashboard `3001`, Postgres `5433` vs `5432`, Redis `6380` vs `6379`) so both stacks can run in parallel without a host-port clash — the compose project name is fixed to `swarm`, giving it its own network and volumes. Override any of them via `ROUTER_PORT` / `API_PORT` / `POSTGRES_PORT` / `REDIS_PORT` in `.env`.

The router exposes a health check at `http://localhost:${ROUTER_PORT:-3100}/health`; the API server exposes one at `http://localhost:${API_PORT:-3101}/health` plus a tRPC endpoint at `/trpc`. The router's webhook receiver (`POST /github/webhook`) verifies HMAC signatures, resolves the project, and applies a loop-prevention drop gate (SWARM-9) for both repo-scoped SCM events and the GitHub Projects board event, then hands off to the job queue. From there, a trigger registry dispatches each event to the pipeline phase it names — see the [pipeline guide](./pipeline.md) and [status snapshot](./status.md) for implementation details.

To let GitHub reach this local router with webhooks, expose it over a public HTTPS URL with a Cloudflare Tunnel — see **[`cloudflare-tunnel.md`](./cloudflare-tunnel.md)** for the setup (a quick ephemeral tunnel for dev, a CLI-managed named tunnel for a stable URL, or a dashboard-created tunnel run as an opt-in `cloudflared` service in `docker-compose.yml` so it starts with the rest of the stack) and the GitHub webhook configuration.
