# The operator MCP server

A SWARM control plane serves an [MCP](https://modelcontextprotocol.io) server at
**`/operator/mcp`**. An assistant session such as Claude Code connects to it and
reads the pipeline the way you do in the dashboard: which runs failed, why, and
what the agent printed. It is the same data `swarm run list|show|logs` reads, as
tools a model can call.

Every tool is the dashboard's own tRPC procedure, called as you. The tools
therefore see exactly what you see in the dashboard: an instance administrator
sees the whole installation, anyone else sees the projects they are a member of,
and a run in any other project reads as *not found*, exactly as in the browser.

## Where it is served

On the **router** process, beside the operator API (`/operator/trpc`). This is the
process `SWARM_CONTROL_PLANE_URL` points at, so the MCP URL is that base URL plus
`/operator/mcp`:

| Deployment | MCP URL |
| --- | --- |
| All-in-one (`npm run serve`, the published image, the VPS behind Caddy) | `https://<your-installation>/operator/mcp` |
| Split router + API, behind a Cloudflare tunnel | `https://<tunnel-hostname>/operator/mcp` |
| The local Compose router | `http://localhost:<ROUTER_PORT>/operator/mcp` (`3100` by default) |

Nothing needs to be added to the proxy: `/operator/*` already routes to the
router. The loopback API server does not serve MCP.

The transport is MCP **Streamable HTTP** in stateless mode. Every request is a
`POST` and is answered with plain JSON. The server keeps no MCP session and opens
no server-sent stream, so `GET` and `DELETE` answer `405`, and a router restart
loses nothing.

## Authentication

The bearer token `swarm login` mints, sent as `Authorization: Bearer <token>`,
exactly as the operator API takes it. A request with no token, or with an unknown,
expired or revoked one, gets `401` before any tool runs.

`SWARM_SINGLE_USER_MODE` is **not** honoured here, for the same reason it is not
honoured by `swarm login`: the router is the internet-reachable process. On a
single-user installation, run `swarm users set-password localhost-admin` once and
sign in like anyone else.

## Connecting a client

1. Sign in to the installation from the machine the client runs on:

   ```bash
   npm run swarm -- login --control-plane-url https://swarm.example.com
   ```

   The token is cached in
   `~/.swarm/operator-sessions/<sha256(control-plane URL)>/session.json` (mode
   `600`). It is never printed.

2. Read the token from that file into the environment. Select the session by
   control-plane URL if you are signed in to more than one installation:

   ```bash
   export SWARM_OPERATOR_TOKEN="$(jq -r 'select(.controlPlaneUrl == "https://swarm.example.com") | .token' \
     ~/.swarm/operator-sessions/*/session.json)"
   ```

3. Register the server with your client. For Claude Code:

   ```bash
   claude mcp add --transport http swarm https://swarm.example.com/operator/mcp \
     --header "Authorization: Bearer $SWARM_OPERATOR_TOKEN"
   ```

   Or, to keep the token out of the stored configuration, in a project's
   `.mcp.json`, which expands the variable when the client starts:

   ```json
   {
     "mcpServers": {
       "swarm": {
         "type": "http",
         "url": "https://swarm.example.com/operator/mcp",
         "headers": { "Authorization": "Bearer ${SWARM_OPERATOR_TOKEN}" }
       }
     }
   }
   ```

   Any other client that speaks Streamable HTTP and can send a fixed header
   connects the same way.

**The token expires.** It is an ordinary session, valid for
`SWARM_SESSION_TTL_HOURS` (`docs/configuration.md`). When the tools start
answering `401`, run `swarm login` again, re-read the token, and restart the
client or update its header. `swarm login --logout` revokes the token for every
client using it.

Treat the token like a password: it reads everything your account can read in the
dashboard, including run logs and agent output.

## Tools

Every tool is read-only unless its description says otherwise, and declares that
with MCP's `readOnlyHint`. A refusal (`NOT_FOUND`, `FORBIDDEN`, an invalid
argument) comes back as a tool error naming the procedure's own reason, the same
wording the dashboard shows.

| Tool | What it reads | Arguments |
| --- | --- | --- |
| `runs_list` | Runs, newest first, as `{ data, total }` — the dashboard's run list (`runs.list`), with each run's worker name | `projectId?`, `status?` (`running`, `completed`, `failed`, `deferred`, `checkpointed`), `phase?`, `since?` (ISO 8601), `limit` (≤ 200, default 50), `offset` (default 0) |
| `run_get` | One run in full — the run detail page (`runs.getById`) — plus its captured agent output (`runs.getOutput`) and, on request, its stored stdout/stderr (`runs.getLogs`), as `{ run, output?, logs? }` | `runId`, `includeOutput` (default `true`), `outputAfter` (output cursor, default 0), `includeLogs` (default `false`) |
| `workers_state` | Each worker's dispatch state (`workers.state`), as `{ workers }`: `connection` (`online`/`offline`), `lastSeenAt`, `draining`/`drainingSince`, the run it is executing, and its enrolled projects, each with `status`, `isRoutable` and its capacity in use — `activeRuns` of `concurrencyAllocation`, the two numbers the dispatch gate compares | `projectId?` |
| `cli_rate_limits` | The workers cooling on an agent CLI's usage limit, as `{ workers }`, each with its active limits (from `workers.list`): `cli`, `expiresAt` (when SWARM routes that CLI to the machine again), `observedAt`, and `resetHint` — the reset text the CLI itself printed, or `null` when it printed none. A worker with no active limit is left out unless named by `workerId` | `projectId?`, `workerId?` |

Page through a long agent output by passing the `output.nextCursor` of one call as
`outputAfter` of the next while `output.hasMore` is `true`.

The two worker tools are scoped like the Workers screens. With a `projectId`, a
contributor of that project reads the workers enrolled in it, and each worker's
enrollments in any *other* project are left out. Without one, they read every
worker on the installation, which only an instance administrator may do; anyone
else gets `FORBIDDEN` and has to name a project. A `workerId` outside the scope
reads as *not found*, exactly as an unknown one.

## For developers

The mount is `src/router/operator-mcp.ts`. The server is built per request in
`src/mcp/server.ts`, and each tool family registers itself there from
`src/mcp/tools/`. `src/mcp/tool-helpers.ts` provides the tRPC caller (`callerFor`)
and the result mapping (`runTool`). A tool calls a dashboard procedure through
`callerFor(user)` and never reads a repository directly, so its authorization
cannot drift from the dashboard's. Adding a tool publishes that procedure on the
internet-exposed router. Treat it like widening `src/api/operator-router.ts`: give
it its own reasoning, and add it to the table above.
