# Exposing the local router to GitHub webhooks (Cloudflare Tunnel)

GitHub delivers webhooks by making an HTTPS request to a **public** URL. SWARM's
router (`src/router`, port `3000` by default) runs on your own machine inside the
Docker Compose stack (see [`README.md`](../README.md) → "Running the stack"), so it
has no public address of its own. A **Cloudflare Tunnel** bridges that gap: it opens
an outbound-only connection from your machine to Cloudflare's edge and gives you a
public HTTPS URL that forwards straight to `http://localhost:3000`. No inbound ports,
no port-forwarding, no static IP.

```
GitHub ──webhook──▶ https://<your-tunnel>.trycloudflare.com  (Cloudflare edge)
                                     │  (outbound tunnel, initiated by your machine)
                                     ▼
                         cloudflared ──▶ http://localhost:${ROUTER_PORT:-3000}  (Router)
```

The router also serves an **authenticated worker-transport endpoint** under
`/worker/*` (ADR-003 §1), so the same tunnel doubles as the path a *remote* worker
reaches the control plane on — see [Remote worker transport
(`/worker/*`)](#remote-worker-transport-worker) below.

> **Scope.** The tunnel is **external infrastructure, not SWARM code** — SWARM never
> builds, ships, or manages it, and this document is the whole of SWARM's involvement
> (`ai/ARCHITECTURE.md` calls the tunnel "external, not our concern — just a public
> HTTPS URL pointed at the router"). Everything else — router, worker, Postgres, Redis
> — stays local; the tunnel forwards webhook payloads inbound, the worker-transport
> handshake + heartbeat frames (`/worker/*`), and the router's responses back. Source
> code never crosses it — the transport carries only a session handshake and liveness
> heartbeats, never a repo or a diff.

---

## Prerequisites

- The SWARM Docker Compose stack running locally, with the router healthy:
  `curl http://localhost:3000/health` → `{"status":"ok","service":"router"}`.
  (Adjust the port if you set `ROUTER_PORT` in `.env`.)
- A Cloudflare account (free tier is enough).
- **For Paths A/B** (running `cloudflared` yourself): the CLI installed locally:
  ```bash
  # macOS
  brew install cloudflared
  # Debian/Ubuntu
  # see https://pkg.cloudflare.com/ — or download the .deb from the cloudflared releases page
  ```
  **For Path C** (Compose runs it in a container): no local install needed — just the
  Tunnel Token from the Zero Trust dashboard.
- **For a named tunnel** (Path B or C): a domain managed by Cloudflare DNS (i.e. its
  nameservers point at Cloudflare). A quick tunnel (Path A) needs no domain.

---

## Path A — Quick tunnel (ephemeral, for local dev)

The fastest way to get a public URL. No account login, no domain, no config file.
The catch: the hostname is **random and changes every time you restart**
`cloudflared`, so you have to re-point the GitHub webhook each time. Fine for a
one-off test; annoying for day-to-day work (use Path B for that).

```bash
cloudflared tunnel --url http://localhost:3000
```

`cloudflared` prints a line like:

```
https://random-words-1234.trycloudflare.com
```

That is your public base URL. Leave the process running; it forwards to the router
for as long as it's up. Skip to [Configure the GitHub webhook](#configure-the-github-webhook).

---

## Path B — Named tunnel (stable URL, recommended for ongoing use)

A named tunnel is tied to your Cloudflare account and a DNS record you control, so the
hostname (e.g. `swarm.example.com`) stays the same across restarts — you configure the
GitHub webhook once and forget it.

1. **Authenticate** `cloudflared` with your Cloudflare account (opens a browser):
   ```bash
   cloudflared tunnel login
   ```
   Pick the zone (domain) you want to use; this writes a cert to `~/.cloudflared/`.

2. **Create the tunnel** (do this once; pick any name):
   ```bash
   cloudflared tunnel create swarm-router
   ```
   This prints a tunnel **UUID** and writes a credentials file to
   `~/.cloudflared/<UUID>.json`.

3. **Route a DNS hostname** to the tunnel:
   ```bash
   cloudflared tunnel route dns swarm-router swarm.example.com
   ```

4. **Write a config file** at `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: swarm-router
   credentials-file: /Users/<you>/.cloudflared/<UUID>.json

   ingress:
     - hostname: swarm.example.com
       service: http://localhost:3000   # match ROUTER_PORT if you changed it
     - service: http_status:404          # required catch-all
   ```

5. **Run the tunnel:**
   ```bash
   cloudflared tunnel run swarm-router
   ```
   To keep it running across reboots, install it as a service:
   `sudo cloudflared service install` (see the Cloudflare docs for your OS).

Your stable base URL is now `https://swarm.example.com`.

---

## Path C — Dashboard-created tunnel, run via Docker Compose (recommended if you want it to start with the stack)

Paths A/B use the `cloudflared` CLI directly (`tunnel login` / `tunnel create`, a local
credentials file). Cloudflare's Zero Trust dashboard offers a different flow that's
easier to run unattended: **Networks → Tunnels → Create a tunnel → Cloudflared
connector**. Instead of a credentials file, it gives you a **Tunnel Token** (a long
opaque string) and lets you configure the hostname→service mapping (the ingress) right
there in the dashboard rather than in a local `config.yml`.

SWARM's `docker-compose.yml` has an opt-in `cloudflared` service for exactly this case,
so the tunnel starts and stops with the rest of the stack instead of needing its own
terminal window:

1. **Create the tunnel** in the Zero Trust dashboard (Networks → Tunnels → Create a
   tunnel → choose **Cloudflared** as the connector). Copy the **Tunnel Token** shown on
   the "Install and run a connector" step — you won't run that install command; Compose
   runs the container for you instead.

2. **Add a Public Hostname** on the same tunnel (in the dashboard): hostname
   `swarm.example.com` (your domain, managed by Cloudflare DNS), service
   `http://router:3000`.

   > **This is the detail that trips people up.** The `cloudflared` container joins
   > SWARM's own Compose network, so it resolves other containers by **service name**,
   > not `localhost`. `router:3000` is the router's *container* port (always `3000`
   > inside the network) — not `${ROUTER_PORT}`, which is only the *host*-published
   > port Paths A/B use because they run `cloudflared` on the host itself.

3. **Set the token** in `.env` (copy from `.env.docker.example` if you haven't already)
   and activate the service's Compose profile:
   ```bash
   CLOUDFLARE_TUNNEL_TOKEN=<paste the token>
   COMPOSE_PROFILES=tunnel
   ```

4. **Bring the stack up** as usual — `swarm start` / `docker compose up -d`. Compose
   reads `COMPOSE_PROFILES` itself, so the `cloudflared` container starts alongside
   postgres/redis/router with no extra flag. Leaving `CLOUDFLARE_TUNNEL_TOKEN` and
   `COMPOSE_PROFILES` unset (the default) skips this service entirely — everyone who
   doesn't use a tunnel this way is unaffected.

Your stable base URL is `https://swarm.example.com`, same as Path B, but there's no
`cloudflared` process to keep alive yourself and no `~/.cloudflared/config.yml` to
maintain — restarting the stack restarts the tunnel with it.

---

## Configure the GitHub webhook

The router will expose its webhook endpoint at **`/github/webhook`** (matching the
reference project, Cascade). So the GitHub **Payload URL** is your tunnel base URL plus
that path, e.g. `https://swarm.example.com/github/webhook`.

> **Status note.** The router's webhook receiver, signature verification, and job
> enqueue land in **SWARM-9** (issue #9). Until then the router only answers `/health`,
> so a delivery to `/github/webhook` returns `404` — that still proves the tunnel works
> end-to-end (the request reached your machine). Wire up the webhook now if you want the
> plumbing ready; expect real processing once SWARM-9 merges.

### Repo-level events (`pull_request`, `pull_request_review`, `issue_comment`, `issues`, `check_suite`)

Repo Settings → **Webhooks** → **Add webhook**:

- **Payload URL**: `https://<your-tunnel>/github/webhook`
- **Content type**: `application/json`
- **Secret**: a strong random string. Keep it — the router verifies GitHub's
  HMAC-SHA256 signature (`X-Hub-Signature-256`) against it (SWARM-9; `PROJECT.md` §6.1,
  "Webhook verification: standard GitHub HMAC signature verification at the router").
  Store it wherever the router reads its config (e.g. an env var / Postgres project row),
  never commit it.
- **Which events**: "Let me select individual events" → tick **Pull requests**, **Pull
  request reviews**, **Issue comments**, **Issues**, and **Check suites**. These are the five
  repo events the router adapter parses (`ai/ARCHITECTURE.md`, SCM section).

### Projects v2 board event (`projects_v2_item`)

GitHub Projects (v2) boards are owned by the **user or org**, not the repo, so the
`projects_v2_item` event — the one that fires when a card's **Status** changes and drives
the pipeline — is **not** available on a repo webhook. It is **also not** available as a
plain user-account webhook: GitHub *"[cannot] create webhooks for individual user
accounts,"* and a personal account's **Settings → Developer settings** has no "Webhooks"
entry at all. The event's docs list it as an **organization** webhook event, or one
delivered to a **GitHub App** that holds the Projects org permission. So the second,
non-repo subscription depends on who owns the board:

- **User-owned board** (SWARM's default — project `3` is owned by user `jkwiecien`): there is
  no user-level webhook to add. Receive the event either via a **GitHub App** installed on
  the account and subscribed to `projects_v2_item` (the App has its own webhook URL — point
  it at the same tunnel path), or by recreating the board under an **org** (below).
- **Org-owned board:** **Org Settings → Webhooks → Add webhook** — same Payload URL, content
  type, and secret as the repo webhook; select the **Projects v2 item** event.

(This is the equivalent of Cascade's `pm:status-changed` trigger — see
`ai/ARCHITECTURE.md`, PM section. `docs/github-projects-v2-api.md` §5 is the authoritative
detail on this event's delivery scope.)

---

## Remote worker transport (`/worker/*`)

The same tunnel that delivers webhooks also fronts SWARM's **worker transport**
(ADR-003 §1) — the front door a worker running on a *different* machine uses to
join the control plane. A remote worker holds only its
`SWARM_WORKER_CREDENTIAL` and `SWARM_OPERATOR_GH_TOKEN`; it never gets
`DATABASE_URL`/`REDIS_URL`. Point it at the tunnel and run the worker:

```bash
SWARM_CONTROL_PLANE_URL=https://swarm.example.com \
SWARM_WORKER_CREDENTIAL=<the credential from `swarm workers register`> \
SWARM_OPERATOR_GH_TOKEN=<a GitHub token for the account that authors this host's commits> \
npm run dev:worker
```

The tunnel is what makes this *remote*, not what makes it a worker: the
control-plane host's own worker runs the same command with
`SWARM_CONTROL_PLANE_URL=http://localhost:<ROUTER_PORT>` (issue #551), so the two
differ only in network distance.

The client derives two endpoints from `SWARM_CONTROL_PLANE_URL`:

- **`POST https://swarm.example.com/worker/session`** — the HTTP handshake:
  declares the CLIs the host can run plus its hostname/version, and receives the
  fenced session (`fencingToken`, `heartbeatTtlMs`).
- **`wss://swarm.example.com/worker/stream`** — a WebSocket carrying periodic
  heartbeat frames that keep the worker's session lease live (so the eligibility
  gate sees it as connected), reconnecting with exponential backoff on transport
  loss. While the tunnel is answering `502`/`530` for a router that is restarting,
  that backoff runs on its own low ceiling (5s, jittered) rather than the 30s one a
  refusal earns — so a daemon re-establishes its session within a few seconds of the
  origin coming back, however long the restart took (issue #611).

> **`cloudflared` forwards WebSocket upgrades transparently.** No extra tunnel
> configuration is needed for `/worker/stream`: the `Upgrade: websocket` request
> rides the same ingress as the plain HTTP routes. The scheme just switches from
> `https`→`wss` (or `http`→`ws` for a plain-HTTP base) — the client does that
> derivation itself, so `SWARM_CONTROL_PLANE_URL` is always the ordinary
> `http(s)` base URL, the same value you'd `curl .../health`.

Because the worker points `SWARM_CONTROL_PLANE_URL` at the tunnel base URL, a
named tunnel (Path B/C) is the practical choice here — a Path A quick tunnel's
URL changes on every restart, so you'd have to re-point every remote worker each
time, just as with the webhook.

---

## Verify it works

1. **Tunnel reachable** — hit the router's health check *through* the tunnel:
   ```bash
   curl https://<your-tunnel>/health
   # → {"status":"ok","service":"router"}
   ```
   A `200` here means GitHub can reach your router.

2. **Webhook delivery** — in the webhook's settings page, open **Recent Deliveries**.
   GitHub sends a `ping` on creation; use **Redeliver** to replay it. A `2xx` (once
   SWARM-9 is in) or a `404` (before it) both confirm the request reached your machine;
   a timeout/`5xx` at the Cloudflare layer means the tunnel or the router is down.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `curl https://<tunnel>/health` times out | `cloudflared` not running, or pointed at the wrong port — confirm it forwards to the same port the router publishes (`ROUTER_PORT`). |
| Health check works locally but not via tunnel | Router is bound inside Docker but the host port isn't published, or `cloudflared` targets `localhost` on a machine where the port isn't mapped. Check `docker compose ps` and the `ROUTER_PORT` mapping. |
| GitHub delivery shows `couldn't connect` | Quick-tunnel URL changed after a restart (Path A) — grab the new URL and update the Payload URL, or switch to a named tunnel (Path B/C). |
| Deliveries arrive but signature checks fail (post-SWARM-9) | Webhook **Secret** in GitHub doesn't match the secret the router is configured with. |
| No `projects_v2_item` deliveries when moving cards | That event never rides the repo webhook — it comes via a **GitHub App** (user-owned board) or an **org** webhook, not a user-account webhook (which GitHub doesn't offer) — see above. |
| Path C: `cloudflared` container exits immediately / restarts in a loop | `CLOUDFLARE_TUNNEL_TOKEN` is unset or wrong — check `docker compose logs cloudflared`. Also confirm `COMPOSE_PROFILES=tunnel` is set in `.env`, otherwise the service never starts at all (`docker compose ps` won't list it). |
| Path C: tunnel is up but `/health` 502s through the hostname | The dashboard's Public Hostname service is set to `localhost:...` instead of `http://router:3000` — `cloudflared` runs in the compose network, not on the host, so it can't resolve `localhost` to the router container. |

---

## Teardown

- **Quick tunnel**: `Ctrl-C` the `cloudflared` process. The URL is gone immediately.
- **Named tunnel (Path B)**: stop `cloudflared tunnel run` (or `sudo cloudflared service
  uninstall`), then optionally `cloudflared tunnel delete swarm-router` and remove the
  DNS record.
- **Dashboard tunnel via Compose (Path C)**: `docker compose stop cloudflared`, or unset
  `COMPOSE_PROFILES`/`CLOUDFLARE_TUNNEL_TOKEN` in `.env` and re-run `docker compose up -d`
  so it isn't recreated on the next start. Delete the tunnel from the Zero Trust
  dashboard if you're done with it for good.
- Remove or disable the webhook(s) in GitHub if you no longer want deliveries queuing up
  failed attempts.
