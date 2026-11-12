# The operator MCP server

A SWARM control plane serves an [MCP](https://modelcontextprotocol.io) server at
**`/operator/mcp`**. An assistant session such as Claude Code connects to it and
reads the pipeline the way you do in the dashboard: which runs failed, why, and
what the agent printed. It is the same data `swarm run list|show|logs` reads, as
tools a model can call. A few [write tools](#write-tools) act on the pipeline too,
each with a mandatory reason, a dry run and an audit record. The [bug-report
tools](#bug-reports) keep SWARM's own record of problems seen in SWARM itself.

**Any signed-in user can connect.** Which tools you are shown, and may call,
depends on your highest role: see [Who may use each tool](#who-may-use-each-tool).

Every tool is the dashboard's own tRPC procedure, called as you. The tools
therefore see exactly what you see in the dashboard: an instance administrator
sees the whole installation, and anyone else sees only the projects they are a
member of. A run, dispatch or pull request in any other project reads as *not
found*. The one tool with no dashboard procedure behind it, `control_plane_logs`,
applies the same project rules itself.

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
before any tool runs. Any valid token is let in, whoever holds it; what it may do
from there is decided per tool and per project (below).

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

The list shows each token's scope (**All projects**, or **Scoped:** and the
project ids of a [scoped agent credential](#scoped-agent-credentials)), when it
was issued, when it expires (or that it has expired), and when it last opened the
MCP server. The last use is recorded at
most once a minute. Revoking a token takes effect on the next request. Expired
tokens are deleted lazily, so an expired one can stay on the list for a while,
marked **Expired**.

Only installation administrators can issue, list or revoke tokens. Nobody else
sees the MCP tab, so anyone else connects with their [`swarm login`
session](#using-the-swarm-login-session-instead).

An administrator can also issue a token limited to some projects and to a fixed
set of tools, for an autonomous agent: see [Scoped agent
credentials](#scoped-agent-credentials).

### Scoped agent credentials

A **scoped agent credential** is an agent access token issued for one or more
projects. It is meant for an autonomous agent that unblocks the pipeline in those
projects, such as the *Resolve problem* phase, without holding your full
access. A request made with it acts as you, limited in three ways:

- **It reaches only its projects.** Every other project reads as `NOT_FOUND`,
  exactly like a project that does not exist, even though you are an installation
  administrator. A cross-project read such as `runs_list` without a `projectId`
  covers its projects only. The installation-wide forms of `workers_state`,
  `cli_rate_limits` and `control_plane_logs` (no `projectId`) are `FORBIDDEN`.
- **It sees and calls only the read tools, five recovery tools and two
  bug-report tools.** `tools/list`
  shows nothing else, and a call to any other tool is refused with `FORBIDDEN:
  Tool "<name>" is not available to a scoped agent credential.` A refused write
  tool still writes its `operator_actions` row, with outcome `refused`.
- **Its calls are marked as its own.** Each write-tool row records
  `credential_kind = 'scoped-agent-token'` and the token's id in `agent_token_id`,
  so the agent's calls read apart from your own.

| Tools | Available to a scoped agent credential |
| --- | --- |
| Every read tool: `runs_list`, `run_get`, `pipeline_snapshot`, `dispatch_history`, `pr_status`, `pr_live_state`, `pipeline_stats`, `phase_agents_get`, `agent_models_list`, `consistency_check`, `project_get`, `workers_state`, `cli_rate_limits`, `control_plane_logs`, `pm_board_discover`, `project_readiness`, `bug_reports_list`, `bug_report_get` | Yes, for its projects only |
| `run_reset`, `dispatch_redispatch_now`, `pr_force_re_review`, `pr_recheck_mergeability`, `dependency_waits_wake` | Yes, for its projects only: each recovers a stuck run or pull request and changes no configuration |
| `bug_report_create`, `bug_report_add_occurrence` | Yes, for its projects only: an agent records every problem it diagnoses. Installation-wide reports stay out of its reach |
| `project_create`, `project_update`, `pm_board_set`, `project_credential_set`, `work_item_close`, `phase_agents_reorder`, `phase_agents_restore`, `phase_agents_set`, `cli_rate_limit_set`, `worker_remove`, `bug_report_set_status` | No |

Inside its projects, the credential has the role you hold there: an installation
administrator's credential acts as `projectAdmin` of each of them. A role you hold
on a project outside the credential's list lifts nothing.

**Issuing one.** In the dashboard, open your **Profile** and the **MCP** tab:

1. Enter a token name (for example `resolve-problem agent`).
2. Under **Limit to projects (optional)**, check each project the credential is
   for. The list shows the projects you can see; leave every box unchecked for an
   ordinary token with your full access.
3. Click **Issue token**. The dialog shows the token, the Claude Code command,
   and the **Scope**: the project ids it is limited to. Copy what you need before
   you click **Close**.

On the list, the token carries a **Scoped:** badge naming its project ids, so it
reads apart from your full-access tokens. A token's projects cannot be changed
after it is issued: to change them, issue a new token and revoke the old one.

Without the dashboard, call its `agentAccessTokens.issue` tRPC procedure, signed
in as yourself, with the projects the credential is for:

```json
{ "name": "resolve-problem agent", "projectIds": ["proj-a", "proj-b"] }
```

`projectIds` takes 1 to 50 project ids; repeated ids are collapsed and an empty
list is refused. Each project must exist and be one you may drive (`member` or
above, which an installation administrator always is). Otherwise the whole call
is refused as `NOT_FOUND`, without saying which project was the problem. Without
`projectIds` the call issues an ordinary token. The answer carries the token,
once, exactly as for an ordinary token, and `agentAccessTokens.list` shows each
token's `projectIds`.

**Revoking and expiry** are an ordinary token's: on the **MCP** tab, click
**Revoke** on the token's row (the one with its **Scoped:** badge) and confirm
with **Revoke token**, or call `agentAccessTokens.revoke`. Revoking it leaves your
other tokens working. It expires 30 days after it is issued. Neither its projects nor its tools are settings: the
recovery and bug-report write tools are the `SCOPED_AGENT_RECOVERY_TOOLS` constant
(`src/identity/agent-access-token.ts`).

#### Run-bound agent credentials

A **run-bound agent credential** is a scoped agent credential the control plane
mints for **one run**, not one you issue. It is limited to that run's project and
carries the same tool allowlist as any scoped credential, plus per-run guardrails
the server enforces on its write tools.

- **Lifetime.** It is minted by `mintRunBoundAgentToken`
  (`src/identity/agent-access-token-service.ts`) with a lifetime the caller
  chooses, not the 30 days of a token you issue. `revokeRunBoundAgentTokens`
  deletes every token of the run when the run settles, and deleting the run
  deletes them too. Like every agent access token, only its hash is stored.
- **Holder.** It acts as the account it is minted for, limited to the run's
  project, and is audited as `scoped-agent-token` with its own id. It is a system
  credential: it never appears on that account's **MCP** tab or in
  `agentAccessTokens.list`.
- **Where it travels.** The Resolve problem phase
  ([pipeline.md](pipeline.md#pipeline-phases)) mints one when the control plane
  builds the run's assignment: held by the selected worker's owner — always a
  project administrator of the run's project or an installation administrator,
  since the phase is routed only to such workers (issue #1419) — capped at
  `pipeline.resolveProblem.maxWriteActions`, valid for the phase timeout plus ten
  minutes. It is sent to the worker on the assignment with the `/operator/mcp`
  address, and revoked at every settle. It is the **one per-run credential that
  reaches a worker**. That is allowed because it is short-lived, bound to one run,
  write-capped, and limited to the recovery tools.
- **Guardrails.** A real call (`dryRun: false`) to a write tool is refused with
  `FORBIDDEN`, and the refusal is audited with outcome `refused`, before the tool
  does anything, when:
  1. the run has already made its cap of real calls: `FORBIDDEN: write-action
     cap of <N> reached for this run`. Every real call that was not refused
     counts, a failed one included;
  2. the run has no earlier **succeeded** dry run of the same tool on the same
     target: `FORBIDDEN: dry run <tool> on <target> first`;
  3. the run already applied the same tool to the same target, whether that
     call succeeded, failed or is still in progress: `FORBIDDEN: <tool> was already
     applied to <target> in this run`. A retry or parallel call sent while the
     first is still running is refused too; when two such calls race, both may be
     refused.

  All three count the calls of **every** token minted for the run, not only the
  current one (`operator_actions.run_id`): a deferred run is retried under a
  freshly minted token, and its cap, dry runs and applied actions carry over to
  the retry.

  Dry runs are never capped. The target is the one the tool records on its audit
  row, for example the run id for `run_reset`. Ordinary tokens and scoped
  credentials you issue have none of these guardrails.

## Connecting a client

1. In the dashboard, open your **Profile** and the **MCP** tab.
2. Enter a token name (for example `office laptop`). To limit the token to some
   projects, check them under **Limit to projects (optional)** (see [Scoped agent
   credentials](#scoped-agent-credentials)); leave them all unchecked for a token
   with your full access. Click **Issue token**.
3. The dialog shows the token, a ready command for Claude Code, already built
   with this installation's address, and the token's scope. Copy what you need
   before you click **Close**. The token is not shown again.
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

**To revoke a token**, click **Revoke** on its row in the **MCP** tab and confirm.
The client's next request is refused.

Treat the token like a password: it reads everything your account can read in the
dashboard, including run logs and agent output, and it can reset and re-dispatch
runs, force re-reviews, schedule conflict checks, wake dependency waits and close
the work item behind a merged pull request in every project where you hold
`member`, and reorder phase agents in every project you administer. It can also
file and triage bug reports, create projects, and change the configuration and
credentials of every project you administer. A [scoped agent
credential](#scoped-agent-credentials) can do less: it reads its own projects,
including their run logs, agent output and bug reports, and can reset and
re-dispatch runs, force re-reviews, schedule conflict checks, wake dependency
waits and file bug reports there, and nothing else. Treat it like a password too.

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

## Who may use each tool

Every tool has a required role. Your **highest role** decides which tools you get:

- **`instanceAdmin`** if you are an installation administrator;
- otherwise your highest project role across every project you are a member of
  (`projectAdmin` > `member` > `contributor`);
- otherwise, with no membership at all, **signed in**.

`tools/list` shows only the tools your highest role reaches. A tool that is not
shown can still be called by name, but the call is refused with `FORBIDDEN` before
it does anything (`Tool "run_reset" needs at least the member role on some
project, which you do not hold.`). A refused write tool still writes its
`operator_actions` row, with outcome `refused`.

Reaching a tool's role does not open every project to you. Each call is still
authorized per project, exactly as the dashboard authorizes it: you may hold
`projectAdmin` on one project and nothing on another, and then the other project
reads as *not found*. Scope means what a call can reach:

- **Your projects**: the results cover every project you are a member of, and
  every project for an instance administrator.
- **One project**: the call names a project, directly or through a run. A project
  you are not a member of reads as `NOT_FOUND`, and a role below the one the
  procedure needs there gets `FORBIDDEN`.
- **One project, or the installation**: as *one project* when you name one. With
  no `projectId`, the tool reads the whole installation, which only an instance
  administrator may do; anyone else gets `FORBIDDEN`.
- **The worker's owner**: the target is a worker machine. Only its owner or an
  instance administrator may act on it; anyone else gets `NOT_FOUND`.

| Tool | Required role | Scope |
| --- | --- | --- |
| `runs_list`, `bug_reports_list` | `contributor` | Your projects (plus installation-wide bug reports, for an instance administrator) |
| `bug_report_get` | `contributor` | One project, or an installation-wide report (instance administrators only) |
| `run_get`, `pipeline_snapshot`, `dispatch_history`, `pr_status`, `pr_live_state`, `pipeline_stats`, `phase_agents_get`, `consistency_check`, `project_get` | `contributor` | One project |
| `workers_state`, `cli_rate_limits`, `control_plane_logs` | `contributor` | One project, or the installation |
| `pm_board_discover`, `project_readiness` | `projectAdmin` | One project |
| `run_reset`, `dispatch_redispatch_now`, `pr_force_re_review`, `pr_recheck_mergeability`, `dependency_waits_wake`, `work_item_close` | `member` | One project |
| `bug_report_create`, `bug_report_add_occurrence`, `bug_report_set_status` | `member` | One project, or the installation |
| `phase_agents_reorder`, `phase_agents_restore`, `phase_agents_set`, `project_update`, `pm_board_set`, `project_credential_set` | `projectAdmin` | One project |
| `cli_rate_limit_set`, `worker_remove` | signed in | The worker's owner |
| `project_create` | signed in | None: like the New Project dialog, it is open to every signed-in user, and you become the new project's `projectAdmin` |
| `agent_models_list` | signed in | None: it reads SWARM's model catalog, not a project |

Each required role is the one the tool's dashboard procedure already enforces; this
table decides nothing new about the dashboard. **A tool missing from the table is
default-denied**: it is shown to, and callable by, installation administrators
only, and never by a scoped agent credential. A [scoped agent
credential](#scoped-agent-credentials) is narrowed further, to its own tools and
projects.

## Tools

Every tool in the table below is read-only and declares that with MCP's
`readOnlyHint`. The tools that change something are listed separately under
[Write tools](#write-tools). A refusal (`NOT_FOUND`, `FORBIDDEN`, an invalid
argument) comes back as a tool error naming the procedure's own reason, the same
wording the dashboard shows.

| Tool | What it reads | Arguments |
| --- | --- | --- |
| `runs_list` | Runs as `{ data, total }` — the dashboard's run list (`runs.list`), `total` counting every run the filters match. Each row carries its phase, status, task and pull request, worker id and name, CLI (`engine`) and model, `startedAt`/`completedAt`, `durationMs` (null until the run finishes), `retryCount` (automatic retries its current job has spent), `continuationCount` and `errorSummary` (the stored error's first line, at most 200 characters) | `projectId?`, `repository?`, `taskId?`, `prNumber?`, `status?` — one of `running`, `completed`, `failed`, `deferred`, `checkpointed`, or an array of them, `phase?`, `workerId?`, `cli?` (`claude`, `antigravity`, `codex`), `startedSince?`/`startedBefore?` and `completedSince?`/`completedBefore?` (ISO 8601; a lower bound is inclusive, an upper bound exclusive, and a completion bound leaves out unfinished runs), `since?` (alias of `startedSince`), `sort?` (`startedAt`, the default, or `completedAt`, which puts unfinished runs last), `order?` (`desc`, the default, or `asc`), `limit` (≤ 200, default 50), `offset` (default 0) |
| `run_get` | One run in full — the run detail page (`runs.getById`) — plus its attempt history (`runs.getAttempts`, issue #1400: every execution attempt in order with its worker, CLI/model, start/end, `outcome`, `error`, what started it — `trigger` `automatic`, `reset` or `retry` — and `outputEventCount`, `0` when it produced no output), its captured agent output (`runs.getOutput`, each event carrying the `attemptId` that produced it) and, on request, its stored stdout/stderr (`runs.getLogs`), as `{ run, attempts, output?, logs? }`. `run` describes only the latest attempt | `runId`, `includeOutput` (default `true`), `outputAfter` (output cursor, default 0), `outputAttemptId` (one attempt's output only), `includeLogs` (default `false`) |
| `pipeline_snapshot` | One project's pipeline state in one call (`runs.pipelineSnapshot`), as `{ runs, dispatches, completedCounts: { since, byStatus }, truncated, generatedAt }`: every run still in progress (`running`, `deferred`, `checkpointed`) plus every run that failed in the window, each with status, phase, task, repository, worker, age, continuation count, error and next retry; every open dispatch (waiting or executing) with state, phase, task/PR, wait reason, `availableAt`, attempts and last error; and how many runs settled in the window, by status. Each list is capped at 100 rows and `truncated` says when the cap was reached | `projectId`, `windowHours` (default 12, at most 168) |
| `dispatch_history` | Every dispatch of one task or pull request, oldest first (`runs.dispatchHistory`), as `{ dispatches, truncated }`: state, phase, attempts, outcome, wait reason, `availableAt`, last error and the `runId` it executed against. Capped at the newest 200 | `projectId`, `taskId` and/or `prNumber` (at least one), `repository?` |
| `workers_state` | Each worker's dispatch state (`workers.state`), as `{ workers }`: `connection` (`online`/`offline`), `lastSeenAt`, `draining`/`drainingSince`, the run it is executing, and its enrolled projects, each with `status`, `isRoutable` and its capacity in use — `activeRuns` of `concurrencyAllocation`, the two numbers the dispatch gate compares | `projectId?` |
| `cli_rate_limits` | The workers cooling on an agent CLI's usage limit, as `{ workers }`, each with its active limits (from `workers.list`): `cli`, `expiresAt` (when SWARM routes that CLI to the machine again), `observedAt`, and `resetHint` — the reset text the CLI itself printed, or `null` when it printed none. A worker with no active limit is left out unless named by `workerId` | `projectId?`, `workerId?` |
| `control_plane_logs` | The control plane's own recent log lines, newest first, as `{ entries, buffer }`. Each entry is `{ time, level, msg, context }` — the object the logger's `json` format emits, with `msg` cut at 4000 characters. `buffer` is the window they come from: `capacity` (20 000 lines), `size`, and `oldestTime`, the time of the oldest line it still holds | `projectId?`, `taskId?`, `prNumber?`, `dispatchId?` (each matching the line's context key of that name), `level?` (a minimum: `debug`, `info`, `warn`, `error`), `since?`/`until?` (ISO 8601; `since` inclusive, `until` exclusive), `limit` (≤ 1000, default 100) |
| `pr_status` | One pull request's automation state as SWARM recorded it (`runs.prStatus`): its latest completed Review run (`lastReviewRunId`, `lastReviewVerdict`), the head of its latest submitted verdict (`lastReviewedHeadSha`), the merge-automation outcome recorded on that run (`mergeOutcome` — `merged`, `not-ready`, `not-eligible`, `policy-blocked`, `unsupported`, `provider-error`, `retry-exhausted`, `provider-error-exhausted`, or `null` — with `mergeOutcomeMessage`), the review-verdict ledger (`verdictCount` of `verdictCap`, `supersededCount` of `supersededCap`), whether a bound is reached (`capReached`, and which in `capBound`: `verdict-cap`, `superseded-bound` or `null`), and whether an operator's Force re-review grant is still unspent (`overrideOutstanding`). It does not ask the source-control provider anything, so it is not a live mergeability read — `pr_live_state` is the live read | `projectId`, `repository` (as the project configures it), `prNumber` |
| `pr_live_state` | One pull request's current state as the project's own source-control provider reports it (`runs.prLiveState`, issue #1441), read through the provider-neutral `SCMProvider` contract: `state` — `open`, `merged`, or `closed` (closed without merging) — plus `headSha`, `headBranch` and `baseBranch`. It is how a Resolve problem agent sees a merge, close or push made outside SWARM, which SWARM's own records do not show. A provider read that fails is `INTERNAL_SERVER_ERROR` | `projectId`, `repository` (as the project configures it), `prNumber` |
| `pipeline_stats` | One project's counts for a period (`runs.stats`), as `{ runsByStatus, runsByPhase, mergedPrsByRepository, since, until }`: the pipeline runs **started** in the period by the status each is in now and by phase (maintenance runs are left out), and how many distinct pull requests SWARM's merge automation merged, per repository. A merge has no recorded instant of its own, so it is counted in the period its approving Review run completed in. A pull request merged by hand is not counted. A status, phase or repository with nothing to count is absent rather than zero, and `until` is echoed back so you see the period actually counted | `projectId`, `since` (ISO 8601, inclusive), `until?` (ISO 8601, exclusive; defaults to now, and must not be earlier than `since`) |
| `phase_agents_get` | One phase's agent configuration for a project (from `projects.getById`), as stored after normalisation: `targets` (CLI/model/reasoning in priority order), `timeoutMs`, the custom `prompt`, and `cli`/`model`/`reasoning` mirroring `targets[0]`, with `configured: false` for a phase running on its coded defaults. Nothing else of the project is returned — no repositories, board mapping or credential references | `projectId`, `phase` (`planning`, `implementation`, `implementationUnplanned`, `review`, `respondToReview`, `respondToCi`, `resolveConflicts`) |
| `agent_models_list` | The values a phase's agent `targets` may name, as `{ clis }` — the catalog the dashboard's Agents tab offers: each CLI (`claude`, `antigravity`, `codex`) with its `defaultModel` and its `models`, each `{ id, label, reasoningChoices, defaultReasoning }`. `id` is the value to give as a target's `model`; `reasoningChoices` are the levels that model accepts (empty: no level may be set) and `defaultReasoning` is the one it runs at when none is chosen (`null`: the CLI decides). Reads no project. Use it before `phase_agents_set` | None |
| `consistency_check` | Stuck states SWARM will not leave by itself (`runs.consistencyCheck`), as `{ windowHours, since, findings, unchecked, truncated }`. Each finding has a `kind`, `repository`, `prNumber` (merged pull requests), `taskId`, `dispatchId` (dependency waits), `workItemId`, `workItemUrl`, `detail` and `suggestedAction` — see the kinds below. A candidate whose board read failed is listed in `unchecked` with its `reason` instead of being guessed at, and `truncated` is `true` when a per-call cap (50 merged pull requests, 50 dependency waits) left some unread. Fixes nothing | `projectId`, `windowHours` (how far back to look for merged pull requests, default 24, at most 720) |
| `project_get` | One project's whole configuration (`projects.getById`) plus, under `credentials`, each SCM and PM credential role with whether it is configured (`projects.credentials.list` and `listPm`), as `{ project, credentials: { scm, pm } }`. The record holds credential *references* (store key names), never values, and the credential lists say only `isConfigured` and a fixed `****` / `not set` marker | `projectId` |
| `pm_board_discover` | The Project Management tab's board discovery (`pm.discoverContainers` / `pm.discoverStates`), run on the server with the project's own board credential. Without `containerId`: `{ providers, containers }`, the registered PM providers and the boards the credential can see. With one: `{ containerId, states, providerContext, statusKeys }`, that board's states (each `{ id, name }`), the provider's extra mapping scope (GitHub Projects returns `{ statusFieldId }`) and SWARM's six status keys to map them to | `projectId`, `providerId?` (defaults to the project's provider), `containerId?`, `discoveryDraft?` (Jira: `{ "baseUrl": "https://<site>.atlassian.net" }`) |
| `project_readiness` | Whether the project can run, and what is missing (`projects.readiness`), as `{ projectId, ready, checkedAt, items }` — see [What `project_readiness` checks](#what-project_readiness-checks) | `projectId` |
| `bug_reports_list` | [Bug reports](#bug-reports), most recently seen first (`bugReports.list`), as `{ data, total }`. Each row carries `id`, `title`, `description`, `status`, `projectId` (`null` for an installation-wide report), `duplicateOfId`, `githubIssueUrl`, `occurrenceCount`, `firstSeenAt`/`lastSeenAt`, `statusChangedAt`, and who filed it (`filedByUserId`, `filedByUserIdentifier`, `filedByRunId`). Covers every project you can read, plus installation-wide reports for an instance administrator | `projectId?`, `status?` — one status or an array, default the open ones (`new`, `confirmed`, `environmental`, `ticketed`), `query?` (case-insensitive text in the title or description), `limit` (≤ 200, default 50), `offset` (default 0) |
| `bug_report_get` | One bug report with its newest occurrences (`bugReports.get`), as `{ report, occurrences, duplicateOf }`. Each occurrence has `runId`, `dispatchId`, `prNumber`, `taskId`, `repository`, `note`, who recorded it and `observedAt`. `duplicateOf` is `{ id, title, status }` of the report a `duplicate` points at, or `null` when there is none or you cannot read it | `reportId`, `occurrenceLimit` (≤ 200, default 50) |

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

`pr_status`, `pr_live_state`, `pipeline_stats`, `phase_agents_get`, `consistency_check` and `project_get`
need you to be a contributor of the project you name; for anyone else the project reads
as *not found*. `pm_board_discover` and `project_readiness` need `projectAdmin`, like the
Project Management tab's discovery: both call the project's providers with its own
credentials. A contributor or member gets `FORBIDDEN`.

### What `consistency_check` reports

The check reads the board only through the project's PM provider, one card at a
time (never a whole-board read), and never asks the source-control provider.

| Finding `kind` | What it means | What to do |
| --- | --- | --- |
| `merged-pr-open-work-item` | Merge automation merged the pull request (its Review run completed inside the window), but the work item it implements is still open on the board — its card is in any status but Done. SWARM does not close a card on merge itself; the provider's own link (a `Closes #N`) does, so a missed close leaves the card, and every item waiting on it, where it is. The card is found from the task the pull request's branch names, then from the pull request itself; a pull request with no card behind it is not reported | Close the work item and move it to Done on the board (`work_item_close`). Its dependents wake when it is done |
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
  `user_identifier`), with which credential (`credential_kind`: `user` for a
  `swarm login` session or an ordinary agent access token, `scoped-agent-token`
  for a [scoped agent credential](#scoped-agent-credentials), whose token id is in
  `agent_token_id`), which `tool`, `project_id`, `target`, `reason`, `dry_run`,
  the `input` arguments (a secret argument, such as `project_credential_set`'s
  `value`, is recorded as `[redacted]`), `outcome` (`succeeded`, `refused`, `failed`, or
  `pending` while the call runs), `error`, `detail` (what a tool recorded about
  the change it previewed, such as the order `phase_agents_reorder` replaced;
  empty for most tools) and `started_at`/`completed_at`.
  `refused` means the wrapped procedure declined to act (`NOT_FOUND`,
  `FORBIDDEN`, `PRECONDITION_FAILED`, `CONFLICT`, `BAD_REQUEST`, …), so nothing
  changed. `failed` means an internal error, including one the procedure reported
  as `INTERNAL_SERVER_ERROR`; a real call that failed may have half-happened. The
  row is written before the tool does anything. If it cannot be written, the call
  does nothing and says so. The table has no foreign keys, so a row survives the
  deletion of the user or project it names. `project_id` is empty when the
  call ended before its target resolved to a project, for example an
  unknown run, a call its preview refused (including a `project_create` whose dry
  run reports it would be refused), or a tool whose target belongs to no project
  (`cli_rate_limit_set` and `worker_remove`, which act on a worker). The only tool that reads the
  audit table is `phase_agents_restore`, which reads back the latest reorder (and
  the latest `phase_agents_set`) of its own project's phase; otherwise query Postgres directly.

| Tool | What it does | Arguments |
| --- | --- | --- |
| `run_reset` | **Destructive.** Resets a wedged run and restarts its phase from scratch, as the dashboard's **Reset & restart** and `swarm run reset` do (`runs.reset`). It stops the run's live agent, cancels its active dispatch (even one a worker has claimed), clears its cancellation flag, tears down its checkout and discards uncommitted and unpushed work, and clears its recovery record. Then it re-dispatches the phase as a fresh first attempt. A run with no stored payload, or whose project is gone, is settled `failed` instead (`outcome: 'terminated'`). Refused only for an unknown run, a machine-maintenance run, or a reset already under way | `runId`, `reason`, `dryRun` (default `false`) |
| `dispatch_redispatch_now` | Re-dispatches a `deferred`, `checkpointed` or `failed` run immediately, as the dashboard's **Retry now** does (`runs.retryNow`). It re-opens the run's waiting dispatch for an immediate attempt, superseding a scheduled automatic retry. A dispatch whose worker lease has lapsed is taken back first. A run with no dispatch gets a fresh one built from its stored payload. Retry budgets start again from zero. Refused for any other status, for a run a worker is executing, and for a run with neither a dispatch nor a stored payload | `runId`, `reason`, `dryRun` (default `false`) |
| `pr_force_re_review` | Continues a pull request the review-verdict cap stopped, as the run page's **Force re-review** does (`runs.forceReReview`). For a Review run whose last permitted verdict requested changes, it grants the pull request one review past the cap and dispatches Respond-to-review for that review; the follow-up Review spends the grant. For a completed Review run that **approved** when the allowance was spent, and whose merge automation refused because a later push moved the head, it grants one review and dispatches a Review of the current head. A forced dispatch already live for the same head is reported, not duplicated. Refused with `PRECONDITION_FAILED` when the head has not moved since that approval (`head-unchanged`: the merge was refused for another reason, which the run's merge result names), for a closed pull request, for a run the cap did not stop, and when the phase it would dispatch is disabled for the project. The dry run (`runs.previewForceReReview`) reports the run's cap state as `run_get` shows it (`reviewCapStop`, `reviewCapSpent`, `reviewCapOverrideOutstanding`), the `continuation` it would start, `reviewedHeadSha` and the pull request's `currentHeadSha` and `pullRequestState` read from its provider, `headMoved`, and `wouldRefuse` | `runId`, `reason`, `dryRun` (default `false`) |
| `pr_recheck_mergeability` | Schedules the per-PR conflict check that the resolve-conflicts fan-out schedules for each open pull request when a sibling merges (`runs.recheckMergeability`). Use it when that fan-out skipped this pull request. The check is keyed on the pull request's own base, read from its provider, and is due now. A check already pending for the same pull request and base is superseded rather than duplicated. The check reads mergeability and dispatches Resolve-conflicts only when the pull request genuinely conflicts, with all of that phase's own gates. Refused for a closed pull request and for a repository the project does not configure. The dry run (`runs.previewMergeabilityRecheck`) reports the pull request's current `state`, `headSha`, `baseBranch` and `mergeable` (`null` while the provider is still computing it), the `coalesceKey` and the `job` it would schedule, and `wouldRefuse` | `projectId`, `repository` (as the project configures it), `prNumber`, `reason`, `dryRun` (default `false`) |
| `dependency_waits_wake` | Wakes every dispatch in the project waiting on the dependency gate now, instead of at its next re-check (`SWARM_DEPENDENCY_RECHECK_MS`) — the same wake a merge or a board card reaching Done triggers on its own (`runs.wakeDependencyWaits`, logged with cause `operator`). The gate re-reads the blockers, so a dependent still blocked simply waits again, and the wake spends no attempt its re-check would not have. Returns `{ projectId, woken, dispatches }`, each dispatch with `dispatchId`, `phase`, `repository`, `taskId`, `prNumber`, `runId`, `attempt` and `availableAt`. A dispatch it could not wake is logged, left on its re-check, and not listed. The dry run (`runs.previewDependencyWake`) returns `{ projectId, wouldWake, dispatches }`: the waits it would wake, in the same shape | `projectId`, `reason`, `dryRun` (default `false`) |
| `work_item_close` | Closes the work item a merged pull request implements and moves its card to Done on the project's board (`runs.closeMergedWorkItem`), then wakes the project's dependency-waiting dispatches with cause `operator`, as `dependency_waits_wake` does, so its dependents start now. This is the fix for a `merged-pr-open-work-item` finding: the pull request merged, but the provider missed its closing reference (a `Closes #N`), so the card stayed open and everything waiting on it stayed parked. The work item is found the way `consistency_check` finds it: the card SWARM recorded on the pull request's latest completed Review run, else the issue the pull request's task branch names, else the pull request itself, each a one-card board lookup. The write goes through the board provider's own close and its move to the canonical `done` status, so it works the same on every board provider. Refused with `PRECONDITION_FAILED` when the pull request is not merged (still open, or closed without merging, as its source-control provider reports it) and when the work item is already in Done, and with `NOT_FOUND` when no work item backs the pull request or the project does not configure the repository. Returns `{ projectId, repository, prNumber, workItem, closed, woken, wokenDispatchIds }`. The dry run (`runs.previewCloseMergedWorkItem`) reports the pull request's `state` and `merged`, the resolved `workItem` with its `id`, `title`, `url`, current `status` and `statusKey` and how it was found (`resolvedVia`: `run-link`, `task-issue` or `pull-request`), `wouldRefuse` and `intendedChanges` | `projectId`, `repository` (as the project configures it), `prNumber`, `reason`, `dryRun` (default `false`) |
| `phase_agents_reorder` | Changes the priority order of one phase's agent `targets` — which CLI/model a worker tries first — and nothing else: no target is added, removed or edited, and the phase's `timeoutMs` and `prompt` are kept. `order` lists every current target exactly once, each as `<cli>/<model>` (`claude/opus`; `default/<model>` for a target naming no CLI) or by its CLI alone (`claude`); anything that is not a permutation of the current targets (an unknown name, a repeat, a target left out) is refused as `BAD_REQUEST` naming the current targets, and a phase with no configured targets as `PRECONDITION_FAILED`. Saves through the project configuration (`projects.update`), which re-validates it as any save is and rewrites the `cli`/`model`/`reasoning` mirror from the new first target. Returns `{ projectId, phase, before, after }` (target names); the dry run (`projects.agentsForUpdate`) returns the same `before`/`after`. The order it replaced is recorded on its audit row (`detail: { previous, next }`) | `projectId`, `phase` (as for `phase_agents_get`), `order`, `reason`, `dryRun` (default `false`) |
| `phase_agents_restore` | Puts back the order the latest successful, real (not dry-run) `phase_agents_reorder` of this project's phase replaced, read from that call's audit row, and saves it the same way. Refused as `PRECONDITION_FAILED` when the phase was never reordered, or when its targets were edited since — a CLI, model or reasoning level changed, or a target added or removed — so the recorded order is no longer a permutation of them: re-applying it would undo that edit. Reorder by hand with `phase_agents_reorder` then. Refused the same way when a successful, real `phase_agents_set` of the phase was made after that reorder, even one that only moved the same targets: restore undoes a reorder, never a set. A dashboard reorder of the same targets made since is not an edit, and is overwritten. Returns `{ projectId, phase, before, after }`; the dry run adds `restoring: { auditId, reorderedAt }`, naming the reorder it would undo | `projectId`, `phase`, `reason`, `dryRun` (default `false`) |
| `phase_agents_set` | Sets one phase's whole agent `targets` list — which CLI, model and reasoning level a worker may run it on, in priority order (first = most preferred) — so targets can be added, removed, edited and reordered in one call. The list replaces the stored one outright: a target left out is removed. `targets: []` clears it and puts the phase back on its coded defaults. Every other phase, and the phase's own `timeoutMs` and `prompt`, are kept as stored; unlike `project_update`'s `agents`, nothing else has to be re-sent. Unlike `phase_agents_reorder` it also accepts a phase with no configured targets. Each target is validated as a dashboard save validates it: a `model` its CLI knows, a `reasoning` level that model supports, at most one target per CLI (read the valid values with `agent_models_list`). A target the schema refuses is refused as `BAD_REQUEST` naming it (`targets[1] (codex/opus): model must be one of the known models for its cli …`). Saves through the project configuration (`projects.update`), which re-validates it and rewrites the `cli`/`model`/`reasoning` mirror from the new first target. Returns `{ projectId, phase, before, after }`, each a list of full targets (`{ cli, model?, reasoning? }`), as stored after normalisation; the dry run (`projects.agentsForUpdate`) returns the same. The list it replaced is recorded on its audit row (`detail: { previous, next }`) | `projectId`, `phase` (as for `phase_agents_get`), `targets` — each `{ cli, model?, reasoning? }`; omit `model` for the CLI's default model and `reasoning` for the model's default — `reason`, `dryRun` (default `false`) |
| `cli_rate_limit_set` | Keeps one agent CLI off a worker until `until` or for `durationMinutes` (`workers.setCliRateLimit`): the same `worker_cli_rate_limits` cool-down SWARM records when a run reports a spent allowance, so routing, the Workers screen and `cli_rate_limits` treat it exactly like an observed one, and it lapses by itself at its expiry. `scope: 'owner'` applies it to every worker the named worker's owner operates: SWARM records no CLI-account identity, so one user's machines stand in for "the same CLI account" (a subscription is usually signed in on all of them). **Extend only**: a machine whose live cool-down on that CLI already lasts at least as long is left `unchanged`, so nothing a real run recorded is ever shortened, and nothing is cleared early. Refused with `BAD_REQUEST` unless exactly one of `until`/`durationMinutes` is given, in the future, and at most eight days ahead (`MAX_CLI_COOLDOWN_MS`, the ceiling an observed reset has). Returns `{ cli, scope, requestedExpiresAt, resetHint, workers }`, each worker with `workerId`, `displayName`, `currentExpiresAt`, `newExpiresAt` and `change` (`create`, `extend` or `unchanged`). The dry run (`workers.previewCliRateLimit`) returns the same shape without writing | `workerId`, `cli`, `until?`, `durationMinutes?`, `resetHint?`, `scope` (`worker` or `owner`, default `worker`), `reason`, `dryRun` (default `false`) |
| `worker_remove` | **Destructive.** Deregisters a worker machine, as `swarm workers remove` and the dashboard's **Delete worker** do (`workers.remove`) — the way to retire a machine that is gone, including one whose owner is not around to do it (issue #1413). Its enrollments, operator SCM credentials and session are deleted with it; its runs and dispatches stay in history with their attribution kept. Refused with `CONFLICT` while the worker is executing a run, for an instance administrator as for the owner. Returns `{ workerId }`. The dry run (`workers.previewRemove`) returns `{ workerId, displayName, ownerUserId, busy, currentRunId, change }`, where `change` is `remove` or `refused-busy` | `workerId`, `reason`, `dryRun` (default `false`) |
| `project_create` | Creates a project as the New Project dialog does (`projects.create`), with the same validation: each repository's coordinates are checked against the SCM provider (two segments, three on Azure DevOps), a reviewer credential is required — the `reviewerToken` given, or the installation's default from Settings → Credentials — and a duplicate project id or a repository another project owns is refused with `CONFLICT` (`A project with ID "<id>" already exists.` / `Repository '<repo>' already belongs to another project.`; the owning project is not named). You become the project's `projectAdmin`. The board starts on a placeholder mapping, so the project cannot run until `pm_board_set`. Returns the created record. The dry run (`projects.previewCreate`, which receives only whether a `reviewerToken` was given, never its value) returns `{ project, creator, seededCredentials, pmPlaceholder, wouldRefuse }`: the record it would write, you as `projectAdmin`, which credentials it would seed (`providerId`, `role`, and `source`: `request` or `instanceDefault`, never the value), and the refusal it would answer with | `id`, `name`, `repositories`, `repoRoot`, `scm?` (default `github`), `visibility?` (default `private`), `worktreeRoot?`, `agents?`, `pipeline?`, `worktreeRetention?`, `reviewerToken?` (**secret**), `reason`, `dryRun` (default `false`) |
| `project_update` | Changes a project's configuration as the Repositories, Agents and Pipeline tabs do (`projects.update`), through the same rules. Each field you give replaces the stored one — `repositories` and `agents` are whole lists, so read them with `project_get` first (to change one phase's agent targets, use `phase_agents_set`) — except `pipeline`, which is merged as a patch (`maxContinuations: null` clears the budget). Repository coordinates are checked against the SCM provider, and a repository another project owns is refused with `CONFLICT`. Returns the updated record. The dry run (`projects.previewUpdate`) returns `{ before, after, changedFields, wouldRefuse }` | `projectId`, `name?`, `repositories?`, `scm?`, `repoRoot?`, `worktreeRoot?`, `visibility?`, `agents?`, `pipeline?`, `worktreeRetention?`, `reason`, `dryRun` (default `false`) |
| `pm_board_set` | Saves the project's board and status mapping as the Project Management tab's Save does (`projects.update` with `pm`), replacing the placeholder. `pm` is one whole member: `github-projects` `{ projectId, statusFieldId, statusOptions }`, `linear` `{ teamId, statusOptions }`, `jira` `{ baseUrl, projectKey, statusOptions, repositoryField? }` or `trello` `{ boardId, statusOptions }`, with ids from `pm_board_discover`. `statusOptions` maps `backlog`, `planning`, `todo` (Ready), `inProgress`, `inReview` and `done` to state ids; the schema needs one, `project_readiness` wants all six. Moving to another PM provider is refused with `BAD_REQUEST` until that provider's required credentials are stored. The dry run is `projects.previewUpdate`, as above | `projectId`, `pm`, `reason`, `dryRun` (default `false`) |
| `bug_report_create` | Files a [bug report](#bug-reports) with its first occurrence (`bugReports.create`). Search with `bug_reports_list` first, and add an occurrence to an existing report rather than filing a duplicate. The report belongs to `projectId`; without it, to `runId`'s project; with neither, it is installation-wide, which only an instance administrator may file (`FORBIDDEN` otherwise). A `runId` from another project than `projectId` is refused as `BAD_REQUEST`. A `runId` or `filedByRunId` you cannot read is `NOT_FOUND`. You are recorded as the filer. Returns `{ report, occurrence }`. The dry run (`bugReports.previewCreate`) returns `{ projectId, report, occurrence }`: the rows it would write | `title`, `description`, `projectId?`, `status?` (`new`, the default, `confirmed` or `environmental`), `runId?`, `dispatchId?`, `prNumber?`, `taskId?`, `repository?`, `note?`, `filedByRunId?` (the agent run filing it), `reason`, `dryRun` (default `false`) |
| `bug_report_add_occurrence` | Records that a reported problem was seen again (`bugReports.addOccurrence`): one occurrence row, and the report's `occurrenceCount` and `lastSeenAt` move with it in the same transaction. A `runId` must be a run of the report's own project (`BAD_REQUEST` otherwise); an installation-wide report takes any run you can read. A closed or `duplicate` report still accepts it. Returns `{ report, occurrence }`. The dry run (`bugReports.previewAddOccurrence`) returns `{ projectId, report: { id, title, status }, occurrenceCount: { from, to }, occurrence }`, plus `warning: 'report is <status>'` for a closed report and, for a duplicate, its `duplicateOfId`, so you can add to the original instead. Nothing is rerouted for you | `reportId`, `runId?`, `dispatchId?`, `prNumber?`, `taskId?`, `repository?`, `note?`, `filedByRunId?`, `reason`, `dryRun` (default `false`) |
| `bug_report_set_status` | Triages a bug report (`bugReports.setStatus`): sets its status, the report it duplicates and its issue link, by the [status rules](#bug-reports). Returns the updated report. The dry run (`bugReports.previewSetStatus`) returns `{ projectId, change: { from, to }, githubIssueUrl: { from, to }, duplicateOfId: { from, to } }` | `reportId`, `status`, `duplicateOfId?`, `githubIssueUrl?` (https), `reason`, `dryRun` (default `false`) |
| `project_credential_set` | **Destructive** (it replaces a stored secret). Stores one credential as the Source Control and Project Management tabs do: `side: 'scm'` (`projects.credentials.set`) for `reviewer` or `webhookSecret`, `side: 'pm'` (`projects.credentials.setPm`) for a role the PM provider declares — `apiToken` for GitHub Projects, `apiKey`/`webhookSecret` for Linear, `email`/`apiToken`/`webhookSecret` for Jira, `apiKey`/`token`/`webhookSecret` for Trello. The value is stored encrypted, is never returned by any tool, and is audited as `[redacted]`. GitHub Projects' `webhookSecret` is the repository's webhook secret, so it is refused on side `pm`: set it on side `scm`. Returns `{ projectId, side, role, stored: true }`. The dry run (`projects.credentials.previewSet` / `previewSetPm`) returns `{ side, providerId, role, label, referenceKey, isConfigured, change }`, where `change` is `set` or `replace` | `projectId`, `side` (`scm` or `pm`), `providerId?` (defaults to the project's provider; name another to enter its credentials before switching to it), `role`, `value` (**secret**), `reason`, `dryRun` (default `false`) |

`run_reset`, `dispatch_redispatch_now`, `pr_force_re_review` and
`pr_recheck_mergeability` need `member` on the project, the role that drives runs in the
dashboard. A contributor can read the run but gets `FORBIDDEN`. Anyone else gets
`NOT_FOUND`. Each dry run is gated at `member` too: `runs.previewAction` for
`run_reset` and `dispatch_redispatch_now`, `runs.previewForceReReview` and
`runs.previewMergeabilityRecheck` for the two pull-request tools. Both
pull-request tools ask the source-control provider for the pull request, dry run
included; a provider read that fails is reported as `INTERNAL_SERVER_ERROR` and
audited `failed`. `pr_force_re_review`'s dry run reads the head even where the real
call would not need it, and leaves `currentHeadSha` and `headMoved` `null` when
that extra read fails.

`pr_force_re_review` and `pr_recheck_mergeability` replace the local
`force-re-review` and `recheck-conflicts` operator scripts, with a reason, a dry
run and an audit record.

`dispatch_redispatch_now` takes a run. A dispatch with no run yet, such as a
board dispatch waiting on its dependencies, is not something it can re-dispatch;
`dependency_waits_wake` wakes those. It needs `member` on the project it names,
and so does its dry run; a contributor gets `FORBIDDEN`, anyone else `NOT_FOUND`.

`work_item_close` needs `member` on the project too, and so does its dry run. It
asks both providers on every call, dry run included: the source-control provider
for the pull request and the board for the work item. A read that fails is reported
as `INTERNAL_SERVER_ERROR` and audited `failed`, never as "not merged" or "no work
item". It never closes a work item without a merged pull request behind it.

`phase_agents_reorder`, `phase_agents_restore` and `phase_agents_set` change the
project's configuration, so they need `projectAdmin`, exactly as the dashboard's Agents tab
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

To decide which models run a phase at all, rather than only their order, set the
whole list. For example, make Planning run on Claude Opus first, then Codex, and
drop Antigravity:

```text
agent_models_list {}
  → { clis: [{ cli: "claude", defaultModel: "sonnet", models: [{ id: "opus", … }, …] }, …] }
phase_agents_set { projectId: "acme", phase: "planning",
  targets: [{ cli: "claude", model: "opus", reasoning: "high" },
            { cli: "codex", model: "gpt-5.5" }],
  reason: "Plan on Opus first, Codex as fallback", dryRun: true }
  → preview: { before: [{ cli: "antigravity", model: "gemini-3.6-flash" }, …],
               after:  [{ cli: "claude", model: "opus", reasoning: "high" },
                        { cli: "codex", model: "gpt-5.5" }] }
phase_agents_set { …the same…, dryRun: false }
```

`phase_agents_set { …, targets: [] }` puts the phase back on its coded defaults.

`cli_rate_limit_set` and `worker_remove` act on a machine rather than a project, so
they are gated like the dashboard's machine-owner actions: the worker's owner or an
instance administrator may call them, and anyone else gets `NOT_FOUND`, dry run
included. Their audit rows name no project.

`project_create` is open to any signed-in user, as the New Project dialog is.
`project_update`, `pm_board_set` and `project_credential_set` need `projectAdmin`,
the role that edits configuration and credentials in the dashboard, and so do their
dry runs. A member or contributor gets `FORBIDDEN`, anyone else `NOT_FOUND`.

## Bug reports

SWARM keeps its own record of problems seen in SWARM, or in what it runs on: the
`bug_reports` and `bug_report_occurrences` tables, read and written through the
`bugReports` tRPC procedures and the five `bug_report*` tools. A **report** has a
title, a description, the project it was observed in (none for an
installation-wide report), a status, the report it duplicates, the link to the
issue it became, and who filed it: the user, and the agent run when an agent
filed it. Each **occurrence** is one time the problem was observed: the run,
dispatch, pull request, task and repository it was seen on, a note, who recorded
it and when. Filing a report records its first occurrence, so `occurrenceCount`
always equals the occurrence rows, and `firstSeenAt`/`lastSeenAt` are the first
and latest of them.

The dashboard shows the same reports, read-only, on the **Issues** tab of the
**General** page (sidebar **General → Settings**): `/settings?tab=issues`, or
`/settings?tab=issues&report=<id>` for one report (see
[`MANUAL.md`](./MANUAL.md)).

| Status | Meaning | Open |
| --- | --- | --- |
| `new` | Filed, not yet looked at | Yes |
| `confirmed` | Reproduced or otherwise confirmed as a defect in SWARM | Yes |
| `environmental` | The cause lies outside SWARM (network, CLI quota, Docker, a machine); potentially not actionable | Yes |
| `ticketed` | Turned into a GitHub issue, linked by `githubIssueUrl` | Yes |
| `duplicate` | The same problem as another report, named by `duplicateOfId` | No |
| `resolved` | Fixed | No |
| `dismissed` | Not a defect, or not worth acting on | No |

A report is filed as `new`, `confirmed` or `environmental`. The rest are reached
with `bug_report_set_status`, which applies these rules and refuses anything else
as `BAD_REQUEST`:

- `duplicate` needs `duplicateOfId`: another report, not this one, that you can
  read (`NOT_FOUND` otherwise). Any other status clears it, and naming one with
  any other status is refused.
- `ticketed` needs `githubIssueUrl`, an `https:` link, unless the report already
  has one. A link given with any other status is stored too, and a stored link is
  kept through `resolved`.
- Setting the status a report already has, with nothing else changed, is refused,
  so the audit trail never records a change that changed nothing.

**Search before you file.** Call `bug_reports_list` with a `query` first. When the
problem is already reported, call `bug_report_add_occurrence` on that report
instead of filing a second one. SWARM does not de-duplicate on its own.

**Ticketing happens outside SWARM.** SWARM does not open issues from reports.
File the issue yourself, or have an agent file it, then record it:

```text
bug_report_set_status { reportId: "…", status: "ticketed",
  githubIssueUrl: "https://github.com/acme/swarm/issues/1400", reason: "Filed upstream" }
```

**Who may do what.** A report with a project is that project's: a `contributor`
reads it, and a `member` files, adds occurrences and triages, as for the run
write tools. Anyone else reads it as `NOT_FOUND`. An installation-wide report is
an instance administrator's alone, and reads as `NOT_FOUND` to everyone else. A
[scoped agent credential](#scoped-agent-credentials) may list and read reports,
file them and add occurrences in its own projects, but not triage them, and never
reaches an installation-wide report. Every write is audited in `operator_actions`
like any other write tool. Reports and occurrences cannot be edited or deleted
through MCP.

## Setting up a project

The project tools take a project from nothing to a state where the pipeline can
run, in the order the dashboard's tabs walk it. `project_readiness` tells you at
any point what is still missing.

### What `project_readiness` checks

Each item has an `area`, the `item` checked, a `status` and a `detail` naming the
fix. `missing` blocks the pipeline; `unverified` means SWARM cannot read the thing
back, so check it yourself. `ready` is `true` when no item is `missing`.

| Area | Item | `ok` when |
| --- | --- | --- |
| `scm` | `provider` | The project names a runtime-ready SCM provider |
| `scm` | `repository <repo>` | The project's reviewer credential is stored and can read the repository (its default branch is read). The implementer side is each worker operator's own credential, so it is not checked here |
| `pm` | `provider` | The PM provider is registered |
| `pm` | `credential <role>` | Each required board credential is stored |
| `pm` | `board mapping` | A board is selected (not the creation-time placeholder), the mapping passes the provider's schema, and all six status keys are mapped |
| `pm` | `board reachable` | The board's states can be discovered with the board credential, and every mapped state id is still one of them |
| `webhooks` | `<provider> webhook` | Never `ok`: `missing` when the webhook secret the route verifies deliveries with is not stored, otherwise `unverified`, with the URL to register (`WEBHOOK_CALLBACK_BASE_URL` plus the route). Registration happens in the provider's own UI (`swarm pm webhook create` for Trello), which SWARM cannot read |
| `workers` | `enrollment` / `phase <phase>` | For each enabled phase and each repository, at least one enrolled worker that is connected and that the dispatch gate would accept for one of the phase's targets: approved, sharing consent given, not draining, holding the repository, declaring and allowed the phase and the CLI. Capacity and CLI cool-downs are ignored, since a busy worker can still serve the phase later. A `missing` item lists why each worker was refused |
| `members` | `roles` | The project has at least one `projectAdmin`, and lists every member with their role |

### Example: a GitHub repository with a GitHub Projects board

An agent sets up `acme/web` with the org board `acme` project 4. Every write takes
a `reason`; run each with `dryRun: true` first when you want to see the plan.

1. **Create the project.** You become its `projectAdmin`.

   ```json
   project_create {
     "id": "acme-web",
     "name": "Acme Web",
     "scm": "github",
     "repositories": [{ "repo": "acme/web", "baseBranch": "main" }],
     "repoRoot": "/Users/dev/acme-web",
     "agents": {
       "implementation": { "targets": [{ "cli": "claude" }, { "cli": "codex" }] }
     },
     "pipeline": { "planning": { "autoAdvance": false } },
     "reviewerToken": "<reviewer PAT>",
     "reason": "Onboard acme/web"
   }
   ```

2. **Store the credentials.** The webhook secret is the one the repository
   webhook signs with; the board token needs `repo`, `project` and `read:org`.

   ```json
   project_credential_set { "projectId": "acme-web", "side": "scm", "role": "webhookSecret", "value": "<secret>", "reason": "Repository webhook" }
   project_credential_set { "projectId": "acme-web", "side": "pm", "role": "apiToken", "value": "<board token>", "reason": "Board access" }
   ```

3. **Find the board and its statuses.**

   ```json
   pm_board_discover { "projectId": "acme-web" }
   → { "containers": [{ "id": "PVT_kwDOA…", "name": "Acme roadmap", "url": "https://github.com/orgs/acme/projects/4" }], … }

   pm_board_discover { "projectId": "acme-web", "containerId": "PVT_kwDOA…" }
   → { "states": [{ "id": "f75ad846", "name": "Backlog" }, …],
       "providerContext": { "statusFieldId": "PVTSSF_…" },
       "statusKeys": ["backlog", "planning", "todo", "inProgress", "inReview", "done"] }
   ```

4. **Save the mapping**, one state id per status key.

   ```json
   pm_board_set {
     "projectId": "acme-web",
     "pm": {
       "type": "github-projects",
       "projectId": "PVT_kwDOA…",
       "statusFieldId": "PVTSSF_…",
       "statusOptions": {
         "backlog": "f75ad846", "planning": "3fe662f4", "todo": "61e4505c",
         "inProgress": "47fc9ee4", "inReview": "df73e18b", "done": "98236657"
       }
     },
     "reason": "Map the Acme roadmap board"
   }
   ```

5. **Ask what is left.**

   ```json
   project_readiness { "projectId": "acme-web" }
   → { "ready": false, "items": [
         { "area": "webhooks", "item": "github webhook", "status": "unverified",
           "detail": "The webhook secret is stored. Register a GitHub webhook for each repository at https://swarm.example.com/github/webhook with that secret …" },
         { "area": "workers", "item": "enrollment", "status": "missing",
           "detail": "No worker is enrolled in this project. …" }, … ] }
   ```

   Register the webhook on the repository (and, for the board's events, on the
   organization — [`docs/github-projects-v2-api.md` §5](./github-projects-v2-api.md#5-the-projects_v2_item-webhook)), enroll and approve a
   worker, and call `project_readiness` again until `ready` is `true`. Workers are
   enrolled from the worker's machine (`swarm workers register-and-enroll`), not
   through MCP.

Change anything later with `project_update`, for example the phase targets:

```json
project_update { "projectId": "acme-web", "agents": { "review": { "targets": [{ "cli": "codex" }] } }, "reason": "Review on Codex" }
```

## For developers

The mount is `src/router/operator-mcp.ts`. It resolves the bearer as a session,
then as an agent access token (`src/identity/agent-access-token-service.ts`), checks
the holder's installation role against `MAY_USE_OPERATOR_MCP` (every role is
admitted today; the map stays total so a new role has to decide), and reads the
caller's highest role once per request (`mcpCeilingFor`). Who may use each tool is
the `TOOL_ACCESS` table in `src/mcp/tool-access.ts`, which the table in
[Who may use each tool](#who-may-use-each-tool) mirrors. `src/mcp/server.ts`
registers every tool for every caller, then narrows `tools/list` to the tools the
caller's role reaches. It does not use the SDK's per-tool `disable()`, because the
SDK refuses a disabled tool's call before the tool runs, and so before a write
tool's audit row. `runTool` and the write-tool framework refuse a call below the
tool's role with `FORBIDDEN`; the write-tool framework does it after the audit row
is written.
A scoped agent credential resolves to a `scoped-agent-token` principal
(`scopedAgentPrincipal`, `src/mcp/tool-access.ts`): its user is the holder with
`instanceAdmin` cleared and the project list attached (`scopeUserToProjects`,
`src/identity/schema.ts`), which the `src/api/authz.ts` helpers read to answer
`NOT_FOUND` outside the scope and `FORBIDDEN` for every installation-wide view.
`TOOL_ACCESS`'s `agentScoped` flag is its tool allowlist, and the write-tool
framework records the credential on the audit row.
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
it its own reasoning, add it to the table above, and give it a `TOOL_ACCESS` entry
with the role its procedure enforces. Without an entry it is served to installation
administrators only, and `tests/unit/mcp/tool-access.test.ts` fails until the table
and the registered tools match.

A tool that writes registers through `registerWriteTool` (`src/mcp/write-tool.ts`),
never `server.registerTool` directly. Give it a `preview`, a read-only procedure
gated exactly like the write, which runs first on every call and answers the dry
run, and an `apply`, which is the dashboard mutation. The framework adds `reason`
and `dryRun` and writes the `operator_actions` row
(`src/db/repositories/operatorActionsRepository.ts`). The run tools live in
`src/mcp/tools/run-actions.ts`, the pull-request tools in
`src/mcp/tools/pr-actions.ts`, `dependency_waits_wake` in
`src/mcp/tools/dependency-waits.ts`, `work_item_close` in
`src/mcp/tools/work-items.ts`, `cli_rate_limit_set` in
`src/mcp/tools/cli-rate-limit-set.ts`, `worker_remove` in
`src/mcp/tools/worker-remove.ts`, the phase-agent order tools in
`src/mcp/tools/phase-agents.ts` (their pure permutation rules in
`src/mcp/agent-order.ts`), the project set-up tools in
`src/mcp/tools/project-setup.ts`, and the bug-report tools in
`src/mcp/tools/bug-reports.ts` (the `bugReports` router in
`src/api/routers/bugReports.ts`, its statuses, input schemas and status rules in
`src/api/bug-reports.ts`, and the store in
`src/db/repositories/bugReportsRepository.ts`). A `preview` may return a `detail`, which the
framework records on the row when the call settles, and `apply` is handed the
preview it was authorized by, so it writes exactly what the row records. A write
tool that accepts a secret names that argument in `secretInputs`, and the
framework records it as `[redacted]`. The readiness check is
`src/api/project-readiness.ts`.
