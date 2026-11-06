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
| `runs_list` | Runs as `{ data, total }` — the dashboard's run list (`runs.list`), `total` counting every run the filters match. Each row carries its phase, status, task and pull request, worker id and name, CLI (`engine`) and model, `startedAt`/`completedAt`, `durationMs` (null until the run finishes), `retryCount` (automatic retries its current job has spent), `continuationCount` and `errorSummary` (the stored error's first line, at most 200 characters) | `projectId?`, `repository?`, `taskId?`, `prNumber?`, `status?` — one of `running`, `completed`, `failed`, `deferred`, `checkpointed`, or an array of them, `phase?`, `workerId?`, `cli?` (`claude`, `antigravity`, `codex`), `startedSince?`/`startedBefore?` and `completedSince?`/`completedBefore?` (ISO 8601; a lower bound is inclusive, an upper bound exclusive, and a completion bound leaves out unfinished runs), `since?` (alias of `startedSince`), `sort?` (`startedAt`, the default, or `completedAt`, which puts unfinished runs last), `order?` (`desc`, the default, or `asc`), `limit` (≤ 200, default 50), `offset` (default 0) |
| `run_get` | One run in full — the run detail page (`runs.getById`) — plus its captured agent output (`runs.getOutput`) and, on request, its stored stdout/stderr (`runs.getLogs`), as `{ run, output?, logs? }` | `runId`, `includeOutput` (default `true`), `outputAfter` (output cursor, default 0), `includeLogs` (default `false`) |
| `pipeline_snapshot` | One project's pipeline state in one call (`runs.pipelineSnapshot`), as `{ runs, dispatches, completedCounts: { since, byStatus }, truncated, generatedAt }`: every run still in progress (`running`, `deferred`, `checkpointed`) plus every run that failed in the window, each with status, phase, task, repository, worker, age, continuation count, error and next retry; every open dispatch (waiting or executing) with state, phase, task/PR, wait reason, `availableAt`, attempts and last error; and how many runs settled in the window, by status. Each list is capped at 100 rows and `truncated` says when the cap was reached | `projectId`, `windowHours` (default 12, at most 168) |
| `dispatch_history` | Every dispatch of one task or pull request, oldest first (`runs.dispatchHistory`), as `{ dispatches, truncated }`: state, phase, attempts, outcome, wait reason, `availableAt`, last error and the `runId` it executed against. Capped at the newest 200 | `projectId`, `taskId` and/or `prNumber` (at least one), `repository?` |
| `workers_state` | Each worker's dispatch state (`workers.state`), as `{ workers }`: `connection` (`online`/`offline`), `lastSeenAt`, `draining`/`drainingSince`, the run it is executing, and its enrolled projects, each with `status`, `isRoutable` and its capacity in use — `activeRuns` of `concurrencyAllocation`, the two numbers the dispatch gate compares | `projectId?` |
| `cli_rate_limits` | The workers cooling on an agent CLI's usage limit, as `{ workers }`, each with its active limits (from `workers.list`): `cli`, `expiresAt` (when SWARM routes that CLI to the machine again), `observedAt`, and `resetHint` — the reset text the CLI itself printed, or `null` when it printed none. A worker with no active limit is left out unless named by `workerId` | `projectId?`, `workerId?` |
| `pr_status` | One pull request's automation state as SWARM recorded it (`runs.prStatus`): its latest completed Review run (`lastReviewRunId`, `lastReviewVerdict`), the head of its latest submitted verdict (`lastReviewedHeadSha`), the merge-automation outcome recorded on that run (`mergeOutcome` — `merged`, `not-ready`, `not-eligible`, `policy-blocked`, `unsupported`, `provider-error`, `retry-exhausted`, `provider-error-exhausted`, or `null` — with `mergeOutcomeMessage`), the review-verdict ledger (`verdictCount` of `verdictCap`, `supersededCount` of `supersededCap`), whether a bound is reached (`capReached`, and which in `capBound`: `verdict-cap`, `superseded-bound` or `null`), and whether an operator's Force re-review grant is still unspent (`overrideOutstanding`). It does not ask the source-control provider anything, so it is not a live mergeability read | `projectId`, `repository` (as the project configures it), `prNumber` |
| `pipeline_stats` | One project's counts for a period (`runs.stats`), as `{ runsByStatus, runsByPhase, mergedPrsByRepository, since, until }`: the pipeline runs **started** in the period by the status each is in now and by phase (maintenance runs are left out), and how many distinct pull requests SWARM's merge automation merged, per repository. A merge has no recorded instant of its own, so it is counted in the period its approving Review run completed in. A pull request merged by hand is not counted. A status, phase or repository with nothing to count is absent rather than zero, and `until` is echoed back so you see the period actually counted | `projectId`, `since` (ISO 8601, inclusive), `until?` (ISO 8601, exclusive; defaults to now, and must not be earlier than `since`) |
| `phase_agents_get` | One phase's agent configuration for a project (from `projects.getById`), as stored after normalisation: `targets` (CLI/model/reasoning in priority order), `timeoutMs`, the custom `prompt`, and `cli`/`model`/`reasoning` mirroring `targets[0]`, with `configured: false` for a phase running on its coded defaults. Nothing else of the project is returned — no repositories, board mapping or credential references | `projectId`, `phase` (`planning`, `implementation`, `implementationUnplanned`, `review`, `respondToReview`, `respondToCi`, `resolveConflicts`) |
| `consistency_check` | Stuck states SWARM will not leave by itself (`runs.consistencyCheck`), as `{ windowHours, since, findings, unchecked, truncated }`. Each finding has a `kind`, `repository`, `prNumber` (merged pull requests), `taskId`, `dispatchId` (dependency waits), `workItemId`, `workItemUrl`, `detail` and `suggestedAction` — see the kinds below. A candidate whose board read failed is listed in `unchecked` with its `reason` instead of being guessed at, and `truncated` is `true` when a per-call cap (50 merged pull requests, 50 dependency waits) left some unread. Fixes nothing | `projectId`, `windowHours` (how far back to look for merged pull requests, default 24, at most 720) |

Page through a long agent output by passing the `output.nextCursor` of one call as
`outputAfter` of the next while `output.hasMore` is `true`.

`pipeline_snapshot` is the cheap call to make periodically, for example from a
guard that watches a project. It reads Postgres only and makes no board or
source-control request, and every list in it is capped, so one call costs about the
same however large the backlog is. Completed runs are only counted. To read one,
use `runs_list`. To see why a task keeps waiting, pass its id to
`dispatch_history` and its runs to `run_get`.

`pipeline_snapshot` and `dispatch_history` need contributor access to the project
they name, exactly like the dashboard's Runs page scoped to that project. Neither
has an installation-wide form. `dispatch_history` finds only dispatches a worker has already resolved to
the task or pull request. A dispatch still waiting for its first claim shows up in
the snapshot, but not in the history.

The two worker tools are scoped like the Workers screens. With a `projectId`, a
contributor of that project reads the workers enrolled in it, and each worker's
enrollments in any *other* project are left out. Without one, they read every
worker on the installation, which only an instance administrator may do; anyone
else gets `FORBIDDEN` and has to name a project. A `workerId` outside the scope
reads as *not found*, exactly as an unknown one.

`pr_status`, `pipeline_stats`, `phase_agents_get` and `consistency_check` need you to be
a contributor of the project you name; for anyone else the project reads as *not found*.

### What `consistency_check` reports

The check reads the board only through the project's PM provider, one card at a
time (never a whole-board read), and never asks the source-control provider.

| Finding `kind` | What it means | What to do |
| --- | --- | --- |
| `merged-pr-open-work-item` | Merge automation merged the pull request (its Review run completed inside the window), but the work item it implements is still open on the board — its card is in any status but Done. SWARM does not close a card on merge itself; the provider's own link (a `Closes #N`) does, so a missed close leaves the card, and every item waiting on it, where it is. The card is found from the task the pull request's branch names, then from the pull request itself; a pull request with no card behind it is not reported | Close the work item and move it to Done on the board (`work_item_close`, once the server offers it). Its dependents wake when it is done |
| `dependency-wait-blockers-done` | A Planning or Implementation dispatch is waiting on the dependency gate, but the gate, asked now, would no longer hold it: no recorded blocker is still open. It would otherwise sit until its next re-check (`SWARM_DEPENDENCY_RECHECK_MS`). "Finished" is the gate's own rule — an open prose-only prerequisite does not count, and neither does a blocker the item itself blocks. Not checked for a provider without dependencies (Trello), which never gates | Wake the project's dependency waits (`dependency_waits_wake`, once the server offers it), or **Retry now** on the Queue screen |

## For developers

The mount is `src/router/operator-mcp.ts`. The server is built per request in
`src/mcp/server.ts`, and each tool family registers itself there from
`src/mcp/tools/`. `src/mcp/tool-helpers.ts` provides the tRPC caller (`callerFor`)
and the result mapping (`runTool`). A tool calls a dashboard procedure through
`callerFor(user)` and never reads a repository directly, so its authorization
cannot drift from the dashboard's. Adding a tool publishes that procedure on the
internet-exposed router. Treat it like widening `src/api/operator-router.ts`: give
it its own reasoning, and add it to the table above.
