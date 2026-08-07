# Onboarding a worker

A step-by-step runbook for making a machine — **this one or somebody else's** —
a worker on an instance already running in **federated (`transport`) dispatch
mode** (`SWARM_DISPATCH_MODE=transport`, ADR-003 §2 — see
[`docs/configuration.md`](./configuration.md) and
[`docs/cloudflare-tunnel.md`](./cloudflare-tunnel.md#remote-worker-transport-worker)).
Turning the instance into federated mode in the first place — the control-plane
`.env` flip, the router recreate, the Cloudflare Tunnel `/worker/*` route — is a
one-time admin-side change and out of scope here; this doc assumes that part is
already done and the router is healthy with its dispatch consumer running.

**Every deployment does this, including a single-user install** (issue #552).
`SWARM_SINGLE_USER_MODE` is the API's authentication policy; it does not bypass
the dispatch gate, so the control-plane host's own worker is registered and
enrolled by these same commands. A host with no registered worker has nothing to
run phases on and its dispatches wait durably — which is what `swarm start` /
`swarm status` warn about.

Everything in **Part 1** runs on the **admin machine** (it has `DATABASE_URL`).
Everything in **Part 2** runs on the **worker's own machine** — which may be the
admin machine itself — and needs nothing but the credential Part 1 prints.

---

## Part 1 — admin machine: register the user + worker

For a **single-user install**, skip steps 1 and 2 and run steps 3 and 4 with
`localhost-admin` as `<email>`: that is the bootstrapped account the API resolves
every request to (created the first time it serves one), and being an
installation admin it needs no project membership of its own.

```bash
# 1. Create the user and set their dashboard login password
npm run swarm -- users add <email> --name "<Display Name>"
npm run swarm -- users set-password <email>

# 2. Add them to the project
npm run swarm -- members add swarm <email> --role member

# 3. Register their worker — prints a credential ONCE, copy it now
npm run swarm -- workers register <email> --name "<Display Name>" --cli <clis>

# 4. Enroll the worker in the project
npm run swarm -- workers enroll <worker-id> swarm --cli <clis> --concurrency 1 --active --consent
```

Notes:

- `--cli` is a comma-separated subset of `claude,antigravity,codex` — **only
  list what's actually installed and authenticated on the target machine.**
  `workers register` records the worker's *capabilities*; `workers enroll`'s own
  `--cli` is the (possibly narrower) set allowed for *this* project. Mismatch
  here just means the CLI it can't run never gets dispatched work — not a hard
  error — but there's no reason to overclaim.
- Step 3's credential is shown exactly once (`swarm workers list` never prints
  it again). Copy it immediately; if you lose it, `workers remove` +
  `workers register` again is the only recovery.
- `--active --consent` at enroll time (rather than the separate `approve` /
  `consent` commands, [`docs/cli.md`](./cli.md#swarm-workers)) is safe to do
  immediately, before the new machine has connected anything: a `transport`-mode
  dispatch only ever selects a worker that is both enrolled **and currently
  connected** (`isWorkerConnected`) — an enrolled-but-disconnected worker just
  can't be picked, so there's no window where work gets routed to a machine
  that isn't there yet.
- Skip `swarm identities link` unless you already know which GitHub account
  should be the *assignee* that routes work to this specific machine — without
  it the worker still receives review / respond-to-review / respond-to-ci /
  resolve-conflicts / unassigned-implementation work normally.

Verify the roster looks right before handing off the credential:

```bash
npm run swarm -- workers list
```

```sql
-- via: docker compose exec -T postgres psql -U swarm -d swarm -c "..."
SELECT u.identifier, w.display_name, w.capabilities,
       e.project_id, e.status, e.sharing_consent, e.concurrency_allocation
FROM workers w
JOIN users u ON u.id = w.owner_user_id
LEFT JOIN worker_project_enrollments e ON e.worker_id = w.id
ORDER BY u.identifier, w.display_name;
```

Hand the credential to the new person out-of-band (not pasted into a shared
chat/ticket) along with the control-plane URL (the tunnel hostname from
[`docs/cloudflare-tunnel.md`](./cloudflare-tunnel.md)) and a GitHub PAT for
whichever account should author their commits/PRs.

---

## Part 2 — new machine: connect the worker

This machine is **DB-free** — no `DATABASE_URL`/`REDIS_URL`, no Postgres/Redis
access at all. It needs the repo checked out (it runs the agent CLI locally and
manages its own Git worktrees) and three environment variables in its `.env`.

> This is also how the **control-plane host's own** worker runs since issue #551 —
> same command, same three variables, with `SWARM_CONTROL_PLANE_URL` pointing at
> `http://localhost:<ROUTER_PORT>` instead of the tunnel. Everything in Part 2
> applies there too.

```bash
git clone <repo-url> && cd swarm
npm ci
```

```dotenv
# .env — the *only* file npm run dev:worker reads
# (node --env-file-if-exists=.env is hardcoded in package.json; a differently
# named file like .env.worker.local is never picked up automatically)
SWARM_WORKER_CREDENTIAL=<the credential from Part 1, step 3>
SWARM_CONTROL_PLANE_URL=<the control-plane base URL, e.g. https://swarm.example.com>
SWARM_OPERATOR_GH_TOKEN=<a GitHub PAT for the account that should author commits/PRs from here>
```

Make sure every CLI declared in `--cli` back in Part 1 is actually installed
and authenticated on this machine (e.g. `claude` logged in), then:

```bash
npm run dev:worker
```

A successful connection logs two lines:

```
worker transport client starting controlPlaneUrl=... hostname=... capabilities=[...] supportedPhases=[...] repoRoot=...
worker transport session established workerId=... sessionId=... heartbeatTtlMs=60000
```

Leave it running in its own foreground terminal — same as the host worker, this
process is meant to be watched, not daemonized. `Ctrl-C` sends a graceful
`SIGINT`, which releases the session lease immediately rather than leaving it
to expire after `heartbeatTtlMs`.

---

## Verify from the admin side

- **Dashboard** — the new worker appears under `/workers`, and its detail page
  (`/workers/<id>`) shows it connected.
- **Database** — a fresh, ticking heartbeat confirms the transport session is
  live (this table also heartbeats in `in-process` mode, so a fresh row alone
  doesn't prove transport connected — the two log lines above are the
  authoritative signal on the worker's own side):
  ```sql
  SELECT worker_id, fencing_token, last_heartbeat_at, now() - last_heartbeat_at AS age
  FROM worker_sessions
  WHERE worker_id = '<worker-id>';
  ```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Cannot find package 'ws'` (or any other module) on `dev:worker` | `npm ci` was never run on the new machine — its `node_modules` doesn't exist yet. |
| `Missing required environment variable: SWARM_CONTROL_PLANE_URL` even though it's set somewhere | It's set in the wrong file. `dev:worker` only reads `.env` (see the dotenv block above) — put the three variables there, or invoke node directly with `--env-file=<your file>` instead of the npm script. |
| Worker never appears as connected / dispatches stay pending | Enrollment isn't both `active` and `sharing_consent=true` (Part 1, step 4), or the worker process on the new machine isn't actually running / crashed on startup — check its terminal for the two success lines above. |
