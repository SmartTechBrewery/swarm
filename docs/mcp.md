# The operator MCP server

A SWARM control plane serves an [MCP](https://modelcontextprotocol.io) server at
**`/operator/mcp`**. An assistant session such as Claude Code connects to it and
reads the pipeline the way you do in the dashboard: which runs failed, why, and
what the agent printed. It is the same data `swarm run list|show|logs` reads, as
tools a model can call. A few [write tools](#write-tools) act on the pipeline too,
each with a mandatory reason, a dry run and an audit record.

**The server is open to installation administrators only, for now.** Any other
user is refused with `403`, whichever credential they present. Opening it to other
users is a separate, later decision that needs an authorization review of every
tool.

Every tool is the dashboard's own tRPC procedure, called as you. The tools
therefore see exactly what you see in the dashboard: an instance administrator
sees the whole installation. The tools still apply the dashboard's project rules
for every caller (a non-admin would see only the projects they are a member of,
and a run in any other project would read as *not found*), so they are ready for
that later decision. The one tool with no dashboard procedure behind it,
`control_plane_logs`, applies the same project rules itself.

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

Send a bearer token as `Authorization: Bearer <token>`. Two credentials are
accepted:

- an **agent access token**, issued from your profile's **MCP** tab (below). This
  is the credential meant for an agent. It is accepted here and nowhere else;
- the `swarm login` session token, exactly as the operator API takes it.

A request with no token, or with an unknown, expired or revoked one, gets `401`
before any tool runs. A valid token whose holder is not an installation
administrator gets `403`.

`SWARM_SINGLE_USER_MODE` is **not** honoured here, for the same reason it is not
honoured by `swarm login`: the router is the internet-reachable process. On a
single-user installation, run `swarm users set-password localhost-admin` once and
sign in like anyone else.

### Agent access tokens

An agent access token belongs to the administrator who issued it and acts as
them, with exactly their access. It differs from a login session in three ways:

- **It has a name**, so you can tell your tokens apart, and you can list and
  revoke each one on its own.
- **It expires 30 days after it is issued.** Using it does not extend it. The
  30 days are fixed in the code and are not a setting.
- **The installation keeps only its SHA-256.** The token itself is shown once,
  when you issue it, and cannot be shown again. If you lose it, issue a new one
  and revoke the old one.

The list shows when each token was issued, when it expires (or that it has
expired), and when it last opened the MCP server. The last use is recorded at
most once a minute. Revoking a token takes effect on the next request. Expired
tokens are deleted lazily, so an expired one can stay on the list for a while,
marked **Expired**.

Only installation administrators can issue, list or revoke tokens. Nobody else
sees the MCP tab.

## Connecting a client

1. In the dashboard, open your **Profile** and the **MCP** tab.
2. Enter a token name (for example `office laptop`) and click **Issue token**.
3. The dialog shows the token and a ready command for Claude Code, already built
   with this installation's address. Copy what you need before you click
   **Close**. The token is not shown again.
4. Run the command on the machine the client runs on. It has this shape:

```bash
claude mcp add --transport http swarm https://swarm.example.com/operator/mcp \
  --header "Authorization: Bearer <token>"
```

The address in the command is the dashboard's own origin plus `/operator/mcp`. On
an all-in-one installation, and on the VPS behind Caddy, that is the router. If
you serve the dashboard from a different origin than the router, for example
`npm run dev:dashboard` on `localhost:5173`, replace the address with the router's
(see [Where it is served](#where-it-is-served)).

To keep the token out of the client's stored configuration, put it in an
environment variable and use a project's `.mcp.json`, which expands the variable
when the client starts:

```json
{
  "mcpServers": {
    "swarm": {
      "type": "http",
      "url": "https://swarm.example.com/operator/mcp",
      "headers": { "Authorization": "Bearer ${SWARM_MCP_TOKEN}" }
    }
  }
}
```

Any other client that speaks Streamable HTTP and can send a fixed header connects
the same way.

**When the token expires**, the tools start answering `401`. Issue a new token and
update the client's header.

Treat the token like a password: it reads everything your account can read in the
dashboard, including run logs and agent output, and it can reset and re-dispatch
runs, and wake dependency waits, in every project where you hold `member`, and
reorder phase agents in every project you administer.

### Using the `swarm login` session instead

The session that `swarm login` caches also works as the bearer. It is valid for
`SWARM_SESSION_TTL_HOURS` (`docs/configuration.md`) and `swarm login --logout`
revokes it. To use it, read it from the CLI's cache, which is
`~/.swarm/operator-sessions/<sha256(control-plane URL)>/session.json` (mode
`600`):

```bash
export SWARM_MCP_TOKEN="$(jq -r 'select(.controlPlaneUrl == "https://swarm.example.com") | .token' \
  ~/.swarm/operator-sessions/*/session.json)"
```

An agent access token is the better choice for an agent: it is not tied to your
CLI sign-in, and you can revoke it on its own.

## Tools

Every tool in the table below is read-only and declares that with MCP's
`readOnlyHint`. The tools that change something are listed separately under
[Write tools](#write-tools). A refusal (`NOT_FOUND`, `FORBIDDEN`, an invalid
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
| `control_plane_logs` | The control plane's own recent log lines, newest first, as `{ entries, buffer }`. Each entry is `{ time, level, msg, context }` — the object the logger's `json` format emits, with `msg` cut at 4000 characters. `buffer` is the window they come from: `capacity` (20 000 lines), `size`, and `oldestTime`, the time of the oldest line it still holds | `projectId?`, `taskId?`, `prNumber?`, `dispatchId?` (each matching the line's context key of that name), `level?` (a minimum: `debug`, `info`, `warn`, `error`), `since?`/`until?` (ISO 8601; `since` inclusive, `until` exclusive), `limit` (≤ 1000, default 100) |
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

`control_plane_logs` reads an **in-memory buffer** of the lines the process serving
`/operator/mcp` — the router, or the all-in-one control plane — logged **since it last
started**, up to its last 20 000 lines. It is not a log store: a restart empties it,
older lines are evicted as new ones arrive (`buffer.oldestTime` says how far back it
reaches), and lines below `SWARM_LOG_LEVEL` were never recorded. The API server's
and the workers' logs are not in it; read a worker's own `logs/worker.log`, and the
API server's output where its process runs. With a `projectId`, a contributor of that
project reads the lines carrying it. Without one, it reads every line — including
those naming no project — which only an instance administrator may do; anyone else
gets `FORBIDDEN`.

`pr_status`, `pipeline_stats`, `phase_agents_get` and `consistency_check` need you to be
a contributor of the project you name; for anyone else the project reads as *not found*.

### What `consistency_check` reports

The check reads the board only through the project's PM provider, one card at a
time (never a whole-board read), and never asks the source-control provider.

| Finding `kind` | What it means | What to do |
| --- | --- | --- |
| `merged-pr-open-work-item` | Merge automation merged the pull request (its Review run completed inside the window), but the work item it implements is still open on the board — its card is in any status but Done. SWARM does not close a card on merge itself; the provider's own link (a `Closes #N`) does, so a missed close leaves the card, and every item waiting on it, where it is. The card is found from the task the pull request's branch names, then from the pull request itself; a pull request with no card behind it is not reported | Close the work item and move it to Done on the board (`work_item_close`, once the server offers it). Its dependents wake when it is done |
| `dependency-wait-blockers-done` | A Planning or Implementation dispatch is waiting on the dependency gate, but the gate, asked now, would no longer hold it: no recorded blocker is still open. It would otherwise sit until its next re-check (`SWARM_DEPENDENCY_RECHECK_MS`). "Finished" is the gate's own rule — an open prose-only prerequisite does not count, and neither does a blocker the item itself blocks. Not checked for a provider without dependencies (Trello), which never gates | Wake the project's dependency waits (`dependency_waits_wake`), or **Retry now** on the Queue screen |

## Write tools

A write tool changes the pipeline. It declares `readOnlyHint: false`, and a tool
that discards state also declares `destructiveHint: true`. Every write tool works
the same way:

- **`reason` is mandatory.** Say in a sentence why you are doing this. A call
  without a reason is rejected as an invalid argument, and a blank one is refused
  as `BAD_REQUEST`.
- **`dryRun: true` changes nothing.** It returns
  `{ dryRun: true, auditId, preview }`, where `preview` says what the call would
  do. For the run tools that is the target's current state, `wouldRefuse` (the
  refusal the real call would answer with, in its own code and wording, or
  `null`), `expectedOutcome` and `intendedChanges`; each tool's row below says
  what its own preview holds. `wouldRefuse: null` is not a promise. The real call checks
  everything again, and something can change in between. A real call returns
  `{ dryRun: false, auditId, result }`, where `result` is the dashboard
  procedure's own answer.
- **Authorization is the dashboard's, and it comes first.** A dry run needs the
  same role as the real call. Someone who may not make the change gets the same
  `FORBIDDEN` or `NOT_FOUND` from a dry run, and learns nothing more about the
  target.
- **Every call is audited.** Dry or real, succeeded, refused or failed, each call
  writes one row to the `operator_actions` table: who (`user_id`,
  `user_identifier`), which `tool`, `project_id`, `target`, `reason`, `dry_run`,
  the `input` arguments, `outcome` (`succeeded`, `refused`, `failed`, or
  `pending` while the call runs), `error`, `detail` (what a tool recorded about
  the change it previewed, such as the order `phase_agents_reorder` replaced;
  empty for most tools) and `started_at`/`completed_at`.
  `refused` means the wrapped procedure declined to act (`NOT_FOUND`,
  `FORBIDDEN`, `PRECONDITION_FAILED`, `CONFLICT`, `BAD_REQUEST`, …), so nothing
  changed. `failed` means an internal error, including one the procedure reported
  as `INTERNAL_SERVER_ERROR`; a real call that failed may have half-happened. The
  row is written before the tool does anything. If it cannot be written, the call
  does nothing and says so. The table has no foreign keys, so a row survives the
  deletion of the user or project it names. `project_id` is empty only when the
  call ended before its target resolved to a project, for example an
  unknown run, or a call its preview refused. The only tool that reads the audit
  table is `phase_agents_restore`, which reads back the latest reorder of its own
  project's phase; otherwise query Postgres directly.

| Tool | What it does | Arguments |
| --- | --- | --- |
| `run_reset` | **Destructive.** Resets a wedged run and restarts its phase from scratch, as the dashboard's **Reset & restart** and `swarm run reset` do (`runs.reset`). It stops the run's live agent, cancels its active dispatch (even one a worker has claimed), clears its cancellation flag, tears down its checkout and discards uncommitted and unpushed work, and clears its recovery record. Then it re-dispatches the phase as a fresh first attempt. A run with no stored payload, or whose project is gone, is settled `failed` instead (`outcome: 'terminated'`). Refused only for an unknown run, a machine-maintenance run, or a reset already under way | `runId`, `reason`, `dryRun` (default `false`) |
| `dispatch_redispatch_now` | Re-dispatches a `deferred`, `checkpointed` or `failed` run immediately, as the dashboard's **Retry now** does (`runs.retryNow`). It re-opens the run's waiting dispatch for an immediate attempt, superseding a scheduled automatic retry. A dispatch whose worker lease has lapsed is taken back first. A run with no dispatch gets a fresh one built from its stored payload. Retry budgets start again from zero. Refused for any other status, for a run a worker is executing, and for a run with neither a dispatch nor a stored payload | `runId`, `reason`, `dryRun` (default `false`) |
| `dependency_waits_wake` | Wakes every dispatch in the project waiting on the dependency gate now, instead of at its next re-check (`SWARM_DEPENDENCY_RECHECK_MS`) — the same wake a merge or a board card reaching Done triggers on its own (`runs.wakeDependencyWaits`, logged with cause `operator`). The gate re-reads the blockers, so a dependent still blocked simply waits again, and the wake spends no attempt its re-check would not have. Returns `{ projectId, woken, dispatches }`, each dispatch with `dispatchId`, `phase`, `repository`, `taskId`, `prNumber`, `runId`, `attempt` and `availableAt`. A dispatch it could not wake is logged, left on its re-check, and not listed. The dry run (`runs.previewDependencyWake`) returns `{ projectId, wouldWake, dispatches }`: the waits it would wake, in the same shape | `projectId`, `reason`, `dryRun` (default `false`) |
| `phase_agents_reorder` | Changes the priority order of one phase's agent `targets` — which CLI/model a worker tries first — and nothing else: no target is added, removed or edited, and the phase's `timeoutMs` and `prompt` are kept. `order` lists every current target exactly once, each as `<cli>/<model>` (`claude/opus`; `default/<model>` for a target naming no CLI) or by its CLI alone (`claude`); anything that is not a permutation of the current targets (an unknown name, a repeat, a target left out) is refused as `BAD_REQUEST` naming the current targets, and a phase with no configured targets as `PRECONDITION_FAILED`. Saves through the project configuration (`projects.update`), which re-validates it as any save is and rewrites the `cli`/`model`/`reasoning` mirror from the new first target. Returns `{ projectId, phase, before, after }` (target names); the dry run (`projects.agentsForUpdate`) returns the same `before`/`after`. The order it replaced is recorded on its audit row (`detail: { previous, next }`) | `projectId`, `phase` (as for `phase_agents_get`), `order`, `reason`, `dryRun` (default `false`) |
| `phase_agents_restore` | Puts back the order the latest successful, real (not dry-run) `phase_agents_reorder` of this project's phase replaced, read from that call's audit row, and saves it the same way. Refused as `PRECONDITION_FAILED` when the phase was never reordered, or when its targets were edited since — a CLI, model or reasoning level changed, or a target added or removed — so the recorded order is no longer a permutation of them: re-applying it would undo that edit. Reorder by hand with `phase_agents_reorder` then. A dashboard reorder of the same targets made since is not an edit, and is overwritten. Returns `{ projectId, phase, before, after }`; the dry run adds `restoring: { auditId, reorderedAt }`, naming the reorder it would undo | `projectId`, `phase`, `reason`, `dryRun` (default `false`) |

`run_reset` and `dispatch_redispatch_now` need `member` on the run's project, the role that drives runs in the
dashboard. A contributor can read the run but gets `FORBIDDEN`. Anyone else gets
`NOT_FOUND`. Their dry run is the `runs.previewAction` procedure, which is gated at
`member` too.

`dispatch_redispatch_now` takes a run. A dispatch with no run yet, such as a
board dispatch waiting on its dependencies, is not something it can re-dispatch;
`dependency_waits_wake` wakes those. It needs `member` on the project it names,
and so does its dry run; a contributor gets `FORBIDDEN`, anyone else `NOT_FOUND`.

`phase_agents_reorder` and `phase_agents_restore` change the project's
configuration, so they need `projectAdmin`, exactly as the dashboard's Agents tab
does; a `member` or contributor gets `FORBIDDEN`, anyone else `NOT_FOUND`. Their dry
run, `projects.agentsForUpdate`, is gated at `projectAdmin` too, and
`phase_agents_restore` reads the audit table only after it has passed.

For example, while Codex is rate-limited, put Claude first for resolving
conflicts, then put the order back once the limit resets:

```text
phase_agents_reorder { projectId: "acme", phase: "resolveConflicts",
  order: ["claude", "codex"], reason: "Codex rate-limited until 18:00", dryRun: true }
  → preview: { before: ["codex/gpt-5.6-sol", "claude/opus"],
               after:  ["claude/opus", "codex/gpt-5.6-sol"] }
phase_agents_reorder { …the same…, dryRun: false }
…later…
phase_agents_restore { projectId: "acme", phase: "resolveConflicts",
  reason: "Codex limit has reset" }
```

Nothing restores the order on its own when the limit resets; that is your call.

## For developers

The mount is `src/router/operator-mcp.ts`. It resolves the bearer as a session,
then as an agent access token (`src/identity/agent-access-token-service.ts`), and
refuses a non-admin through `MAY_USE_OPERATOR_MCP` before any MCP message is read.
The tokens themselves are managed through the dashboard's `agentAccessTokens` tRPC
router (`src/api/routers/agentAccessTokens.ts`), which is not mounted on the
operator API. The tab's command is built by `dashboard/src/lib/agent-access.ts`, and
a test keeps it identical to the command in this document. The server is built per request in
`src/mcp/server.ts`, and each tool family registers itself there from
`src/mcp/tools/`. `src/mcp/tool-helpers.ts` provides the tRPC caller (`callerFor`)
and the result mapping (`runTool`). A tool calls a dashboard procedure through
`callerFor(user)` and never reads a repository directly, so its authorization
cannot drift from the dashboard's. The one exception is `control_plane_logs`
(`src/mcp/tools/logs.ts`): the dashboard's procedures run in the API server, whose
memory does not hold the router's buffer, so there is no procedure to call, and the
tool calls the same `src/api/authz.ts` helpers a procedure would. Adding a tool publishes that procedure on the
internet-exposed router. Treat it like widening `src/api/operator-router.ts`: give
it its own reasoning, and add it to the table above.

A tool that writes registers through `registerWriteTool` (`src/mcp/write-tool.ts`),
never `server.registerTool` directly. Give it a `preview`, a read-only procedure
gated exactly like the write, which runs first on every call and answers the dry
run, and an `apply`, which is the dashboard mutation. The framework adds `reason`
and `dryRun` and writes the `operator_actions` row
(`src/db/repositories/operatorActionsRepository.ts`). The run tools live in
`src/mcp/tools/run-actions.ts`, `dependency_waits_wake` in
`src/mcp/tools/dependency-waits.ts`, and the phase-agent order tools in
`src/mcp/tools/phase-agents.ts` (their pure permutation rules in
`src/mcp/agent-order.ts`). A `preview` may return a `detail`, which the framework
records on the row when the call settles, and `apply` is handed the preview it
was authorized by, so it writes exactly what the row records.
