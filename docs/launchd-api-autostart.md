# Autostarting the API server with launchd (macOS)

The API server is a foreground, operator-owned process: `npm run dev:api`
occupies a terminal tab for as long as the dashboard and the tRPC surface are
meant to answer, and a closed tab or a reboot takes the control plane's own
web surface down with it. `swarm-api-agent` installs a launchd **LaunchAgent**
per installation checkout so the same chain starts at login instead.

It adds no supervision model of its own: the agent runs `npm run dev:api` — the
same migrate → free `API_PORT` → serve chain described in
[`docs/cli.md`](./cli.md#services), reading the same `.env`. All it decides is
*where that command runs* and *what environment launchd hands it*.

**One agent covers both tabs.** The API serves the built dashboard SPA from
`dashboard/dist` when it exists, so the panel lives on `http://127.0.0.1:3101`
(same-origin, no CORS) and the Vite dev server (`npm run dev:dashboard`, `:5173`)
goes back to being what it is — a dashboard-development tool you start by hand
when you want HMR, not part of running the stack.

macOS only — launchd is. On Linux the equivalent is a `systemd --user` unit
running the same command with `WorkingDirectory=` set to the checkout; the script
says so rather than half-working.

## Usage

```bash
swarm-api-agent install   [<checkout>]        # write the agent and start it
swarm-api-agent uninstall [<checkout>]        # stop it and remove the agent
swarm-api-agent status    [<checkout>]        # loaded? pid? last exit code? healthy?
swarm-api-agent restart   [<checkout>]        # restart it, then wait for /health
swarm-api-agent reload [--all] [<checkout>]   # npm run reload[:all], then restart
swarm-api-agent logs      [<checkout>]        # tail this installation's stdout + stderr
```

`<checkout>` is the SWARM installation the API serves — the checkout holding
`swarm.config.json` and `.env` — and defaults to the current directory. Unlike a
worker checkout, this is always *this* repository: it is the control-plane host's
own installation.

The command ships in this package's `bin`, so a machine that has SWARM installed
(or `npm link`ed) already has it on `PATH` next to `swarm` and
`swarm-worker-agent`.

| What | Where |
| --- | --- |
| Agent | `~/Library/LaunchAgents/pl.smarttechbrewery.swarm.api.<basename>.<hash8>.plist` |
| Logs | `~/Library/Logs/pl.smarttechbrewery.swarm.api.<basename>.<hash8>.log` (+ `.error.log`) |
| URL | `http://127.0.0.1:<API_PORT>` (default `3101`, read from the checkout's `.env`) |

`<hash8>` is the first eight characters of the sha256 of the checkout's realpath,
so two installations sharing a basename still get distinct labels — the same
scheme [`swarm-worker-agent`](./launchd-worker-autostart.md) uses.

## After a `git pull` — the update flow

This is the reason the agent has more than `install`/`uninstall`. The update chain
stays a foreground command you watch, and only the restart is delegated:

```bash
git pull
swarm-api-agent reload --all     # npm run reload:all, then restart, then wait for /health
```

- **`reload` runs in the foreground on purpose.** A failed migration, a failed
  dashboard build, or a router that comes back unhealthy stops the chain *before*
  the restart, with its own output on screen — rather than disappearing into the
  agent's log while a half-updated server keeps answering. `--all` picks
  [`npm run reload:all`](./cli.md#services) (which also rebuilds the Compose
  router); without it you get `npm run reload`.
- **The restart is not always needed.** `dev:api` runs under `--watch`, so a pulled
  change to API source restarts the server on its own, and a rebuilt
  `dashboard/dist` is picked up live because it is served from disk. `restart` is
  what you want after an `.env` change, a migration, or a server that has wedged;
  running it anyway costs a few seconds.
- **Workers are never restarted for you.** They run phase code from their own
  checkouts, on their own machines — `reload:all` only reminds you, and so does
  this. Restart them yourself (`swarm-worker-agent`, or however that host starts
  its daemon).

## What the generated agent does, and why

- **No secret is written into the plist.** `dev:api` reads `.env` from its working
  directory (`node --env-file=.env`), so the agent only has to set
  `WorkingDirectory` — a plist is world-readable and belongs nowhere near
  `DATABASE_URL` or `CREDENTIAL_MASTER_KEY`.
- **`PATH` is derived from the machine, not hard-coded.** launchd starts a job with
  a minimal `PATH` and reads none of the login shell's rc files, while the API
  spawns `npm` (the migrate step) and **`git`** — the worktree retention sweep runs
  the same reclaim gate as `swarm worktrees prune` and shells out to git. The
  script resolves each on the installing machine and puts their real directories in
  the plist, so an Intel Homebrew (`/usr/local`), an Apple Silicon one
  (`/opt/homebrew`) and a node under nvm/asdf/fnm all work without editing
  anything.
- **`KeepAlive` with `ThrottleInterval 30`** restarts a server that dies without
  turning a genuine failure into a hot loop. It also covers the ordinary login
  race: Docker Desktop may not have Postgres up yet when the agent first starts, so
  the API fails, waits thirty seconds, and connects on a later attempt.
- **Every start and restart waits for `/health`.** `launchctl` reports what it
  accepted, which is indistinguishable between a healthy server and one being
  restarted every thirty seconds by `KeepAlive`. `install`, `restart` and `reload`
  poll `http://127.0.0.1:<API_PORT>/health` for up to 90 seconds and, on timeout,
  print the tail of both logs instead of claiming success.

## Gotchas

- **One agent per checkout, and one API per port.** `dev:api` frees `API_PORT`
  before binding it (`bin/kill-port.js`), which would take the port out from under
  a server you started in a tab. `install` therefore refuses while one is already
  running for that checkout, naming the pid — stop it first. That same step is what
  clears a stray child left by a previous generation of the agent.
- **Build the dashboard at least once.** The SPA is served from `dashboard/dist`;
  without it the API is perfectly healthy and the panel is a 404. `install` says so
  when the directory is missing; `npm run build:dashboard` (or any `reload`) fills
  it.
- **The rest of the stack still has to be running.** Postgres, Redis and the router
  are Compose services with `restart: unless-stopped`, so they come back with
  Docker Desktop — which means Docker Desktop itself has to be set to start at
  login, or the agent will sit in its restart loop until you open it.
- **Migrations run on every start.** `dev:api` begins with `npm run db:migrate`, so
  a restart after a pull applies pending migrations before serving. That is also
  why a broken migration shows up as a crash-looping agent rather than a running
  server with a stale schema.

## Why the API is not a Compose service instead

Worth stating, because "SWARM already needs Docker" makes containerising it look
like the obvious move. The API server is the **host** process by design: it owns
the startup orphaned-run reap and the worktree retention sweep
(`src/api/maintenance.ts`, issue #550), and the sweep reads every project's
checkout plus the host-local lease store this machine's worker writes under
`<repoRoot>/<worktreeRoot>/.swarm-state`. Those are the router's *stated* reason
for not owning the chores — it runs in Docker with no checkout — so moving the API
into Compose would mean bind-mounting every project's `repoRoot` at its identical
absolute path, and re-editing `docker-compose.yml` every time a project is added
from the dashboard, plus a second `node_modules` tree (the host's is darwin/arm64)
and an image rebuild in place of `--watch`. See "Process responsibilities" in
[`ai/ARCHITECTURE.md`](../ai/ARCHITECTURE.md). A containerised API is a sensible
target only *after* those two chores move off the control-plane host — which is
its own change, not a configuration choice.

## See also

- [`docs/launchd-worker-autostart.md`](./launchd-worker-autostart.md) — the same
  treatment for the worker, plus the `swarm-repo-renamed` runbook.
