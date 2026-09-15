# SWARM manual

Everything that used to live below the introduction in
[`README.md`](../README.md): what a machine needs before it can run SWARM, how the
worker works and what it deliberately does not hold, the command reference, the
configuration layers, and the map of every other document.

The README is the short version — what SWARM is and how to get it running. This is
the long one. The focused references it points at (the CLI reference, the
configuration catalogue, the pipeline description) remain the source of truth for
their own subjects; this manual is the operator's path through them.

## Contents

- [Prerequisites](#prerequisites)
- [Quick start, beyond the README](#quick-start-beyond-the-readme)
- [The worker](#the-worker)
- [Failure diagnosis](#failure-diagnosis)
- [Common commands](#common-commands)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Temporary: pre-multi-repo restore point](#temporary-pre-multi-repo-restore-point)

---

## Prerequisites

- Node.js 22 or newer and npm
- Docker Compose
- Git
- Authenticated agent CLIs (`claude`, `agy`, and/or `codex`)
- A source-control repository on GitHub, Bitbucket Cloud, or gitlab.com — named by the
  project's `scm` field, which every project must set — and a project-management board with a
  webhook: a GitHub Projects v2 board, a Linear team, a Jira Cloud project, or a
  Trello board. The first three are configured in the provider's own UI; a Trello
  webhook is a resource SWARM creates for you, with
  `npm run swarm -- pm webhook create --project <id>` (see
  [`docs/cli.md`](./cli.md))
- Two distinct source-control identities for loop prevention: the worker operator's
  own credential (the implementer persona), stored per worker per SCM provider with
  `swarm workers set-scm-credential` or from that worker's own page in the dashboard,
  and a separate project-scoped reviewer credential
- A project credential for the **board**, separate from the two above, held per PM
  provider under `credentials.pm.<provider>.<role>` so a project can carry two
  providers' credentials at once while only the one `pm.type` names is ever
  resolved:

  | Provider | Required roles (conventional reference names) |
  | --- | --- |
  | GitHub Projects | `apiToken` (`PM_GITHUB_PROJECTS_TOKEN`), scoped `repo` + `project` + `read:org` |
  | Linear | `apiKey`, `webhookSecret` (`LINEAR_API_KEY`, `LINEAR_WEBHOOK_SECRET`) |
  | Jira | `email`, `apiToken`, `webhookSecret` (`JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_WEBHOOK_SECRET`) — Jira Cloud uses basic auth |
  | Trello | `apiKey`, `token`, `webhookSecret` (`TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_API_SECRET` — the last signs its deliveries) |

  Every board read, write, and dashboard discovery authenticates with the
  selected provider's credential, configurable from the dashboard's **Project
  Management** tab. See [`docs/configuration.md`](./configuration.md).

## Quick start, beyond the README

The README's quick start is the shortest path that works. This is what it leaves out.

**Local single-user mode is on by default.** The `.env.docker.example` template
sets `SWARM_SINGLE_USER_MODE=true`, so a local install needs **no dashboard user,
no password, no `/login`, and no session cookie**: the API bootstraps a
passwordless `localhost-admin` and signs you straight into the dashboard.

**It is an authentication policy, and nothing more.** It does *not* change how
work is dispatched: this install registers and enrolls its one local worker
exactly as a multi-user one does, because worker selection has a single rule for
every deployment. Without that worker, phases queue up with nothing to run them —
`swarm start` and `swarm status` say so.

**Multi-user alternative.** Set `SWARM_SINGLE_USER_MODE=false` in `.env` (or
remove the line) to require per-user session auth instead. Then create your
dashboard user and set its login password before signing in at `/login`:

```bash
npm run swarm -- users add you@example.com --admin    # create your dashboard user, then
npm run swarm -- users set-password you@example.com   # set its login password (prompts, no echo)
```

**Registering the worker, one step at a time.** `workers register-and-enroll`
collapses two commands; either half can be run on its own, which is what you want
when the two approvals are separate human decisions:

```bash
npm run swarm -- workers register localhost-admin --name "this machine" --cli claude
npm run swarm -- workers enroll <worker-id> <project-id> --cli claude --active --consent
```

In single-user mode the owner is the bootstrapped `localhost-admin` account, which
exists once the API has served a request (start `npm run dev:api` and open the
dashboard first, or use a user you created with `swarm users add`). It has no
password until you set one: `npm run swarm -- users set-password localhost-admin`.

`swarm workers` reaches the control plane over `SWARM_CONTROL_PLANE_URL` rather
than Postgres since issue #800, so it needs a [`swarm login`](./cli.md#swarm-login)
session and **no `DATABASE_URL`** — which is what lets a second machine onboard
itself.

`workers register` prints a credential **once** — put it in `.env` as
`SWARM_WORKER_CREDENTIAL` before starting the worker, or skip that by running
`swarm run:worker` from the checkout you registered in. `swarm start` and `swarm
status` warn when this host has no usable credential. The full runbook, including
someone else's machine, is [`docs/onboarding-worker.md`](./onboarding-worker.md);
on macOS, [`docs/launchd-worker-autostart.md`](./launchd-worker-autostart.md) runs
it from a launchd agent instead of a terminal tab.

For a compiled self-hosted dashboard, run `npm run start:api` and open
<http://localhost:3101> instead of the Vite dev server. That same process serves the
API, so on macOS one launchd agent replaces both terminal tabs — the API and the
panel — and starts them at login:
[`docs/launchd-api-autostart.md`](./launchd-api-autostart.md).

## The worker

**There is one worker program.** `npm run dev:worker` runs
`src/transport/connect-entry.ts` on every machine, remote or the control-plane host
itself. Point it at the router; on the control-plane host that URL is simply
loopback:

```bash
# .env on the machine running the worker
SWARM_CONTROL_PLANE_URL=http://localhost:3100      # remote worker: https://<your-tunnel>
SWARM_WORKER_CREDENTIAL=<from `swarm workers register`>
SWARM_WORKER_REPO_ROOT=/path/to/this-hosts/checkout  # optional; defaults to cwd
```

Only the first line has to be there before onboarding, and it need not be typed:
`swarm workers register-and-enroll --control-plane-url <url>` writes it into this
checkout's `.env` when it is absent, and leaves an existing assignment alone — so a
fresh clone is bootstrapped by the same command that registers the machine. (`swarm
init` is for the *stack*, not for a worker: it copies `.env.docker.example`,
`DATABASE_URL` and all, onto a machine that must hold neither that nor `REDIS_URL`.)

**On the machine that registered it, there is a shorter way to start it.** Both
registration commands also write the freshly issued credential to a per-checkout
cache in the operator's home directory (`~/.swarm/worker-credentials/<hash>/`,
owner-only, outside every checkout — no `.gitignore` entry needed anywhere), so
from inside that checkout:

```bash
swarm run:worker
```

starts the same daemon with `SWARM_WORKER_REPO_ROOT` set to the directory where the
command was invoked and the credential read from that file — never printed, never pasted, with only
`SWARM_CONTROL_PLANE_URL` left to `.env`. It is an *additional* launcher, not a
second worker: the block above is unchanged and stays the path for a remote
machine, a process supervisor, or any setup where the registering machine is not
the running one.

The global `swarm run:worker` form uses its current directory; `npm run swarm --
run:worker` uses npm's caller directory (`INIT_CWD`), so both forms select the
checkout you invoked them from.

The operator's own source-control credential is **not** among them: it is stored
server-side per `(worker, SCM provider)` — `swarm workers set-scm-credential
<worker-id> <github|bitbucket|gitlab>`, or from that worker's own page in the
dashboard (`/workers/<worker-id>`, which verifies the value against the provider
before storing it) — and travels with each assignment, so rotating it needs no worker
restart and a Bitbucket or GitLab project resolves its own credential rather than a
GitHub-named one.

It is intentionally host-run: it needs local Git worktrees, agent CLI
authentication, and the developer's PATH.

**What it holds — and what it deliberately doesn't.** Only the credential and the
control-plane URL; no `DATABASE_URL`/`REDIS_URL`, even on a host that has them, and
no stored source-control secret. Its agent therefore
authenticates as the *operator's own* account everywhere (ADR-004 §2), while the
project-scoped reviewer PAT and the PM credential never leave the server — so a
submitted review's identity is unchanged.

**How it connects.** It performs the `/worker/session` handshake — declaring the
CLIs it can run, the pipeline phases it can execute, and which repository its one
local checkout actually is (read from that checkout's `origin`) — keeps its
session live over the `/worker/stream` WebSocket, and reconnects with backoff
(ADR-003 §1). Because it declares its phase repertoire, the control plane never
routes a phase to a worker that cannot run it; the work waits for one that can.

**How it guards the checkout.** An assignment for a repository this checkout is
*not* is refused up front, naming both, rather than run. The daemon locks that
checkout for its whole life, so a second worker pointed at the same path refuses
to start instead of driving Git in the same repository (give a second worker on
the machine its own checkout). The control plane polices the same pairing:
enrolling a worker in a project that does not own its repository is refused, and
an existing enrollment a reconnecting daemon's declaration contradicts is
*suspended*, with the machine's checkout and every repository the project owns
shown on the Workers screen — approval and sharing consent stay human decisions,
so nothing is ever enrolled or re-activated from a declaration alone. A project
owning several repositories accepts a worker for **any** of them (issue #946),
which is how one project holds one worker per repository, and the Workers screen
reads the pairing the same way: no mismatch for a worker on any repository the
project declares, and a genuine mismatch names them all, so a typo is
distinguishable from a repository the project simply does not have.

**How work is split.** Source-carrying delivery (commit / push / create-PR) runs
on the worker under the operator credential the assignment carried. Everything needing something the worker
must not hold goes up to the control plane's delivery API: Implementation's board
moves, comments and dependency lookup; Respond-to-review's card lookup and board
moves; Review's submitted verdict under the reviewer PAT; and the two things
backed by the control plane's database — Review's verdict-ledger reads/writes and
the follow-up Review a pushed fix enqueues. Planning's board surface (its own
blocker/dependent lookup for the dependency gate it has run since issue #889 —
which rides the routes Implementation's already uses — plus creating a split's
sibling cards, chaining their dependency edges, carrying the split item's own
dependents forward onto every phase it produced (issue #890 — the same dependent
read, plus Respond-to-review's card lookup to resolve a dependent that carries no
board id), re-scoping the parent, labelling what finished, and finding its own
plan comment on a retry) rides five more
PM delivery routes, while its agent run, plan file, and scope gate stay
worker-side; a split interrupted partway resumes from a per-child marker rather
than creating that child twice. Results stream back over the transport (ADR-003
§2).

**How to restart one safely.** Stopping a worker mid-phase kills the agent CLI it
is running, and the restarted daemon's handshake settles that session's dispatch
and run terminally `failed` — there is no retry after that. So take the machine
out of the dispatch pool first and let it finish what it has:

```bash
swarm workers drain <worker-id>      # no new work; the current run is untouched
# …re-run it until it prints "draining and idle — safe to restart"
# restart the daemon (swarm run:worker / npm run dev:worker)
swarm workers undrain <worker-id>    # back in the pool
```

`drain` is machine-wide, reversible, and takes effect from the next dispatch;
everything the machine is already running is left alone. Work that would have gone
there is deferred rather than failed and runs on another eligible machine on the
next re-check — a project whose *only* machine is drained waits with a message
naming the drain. The state is **sticky across the restart it was taken for**: a
reconnecting daemon does not rejoin the pool (the router logs that it is draining
at each handshake), nothing expires it, and only `undrain` ends it. It is the
machine owner's own call, so sign in as them; `swarm workers list` marks every
machine currently out of the pool.

The same two steps are on the machine's own page in the dashboard
(`/workers/<id>`), under **Pool membership**: **Drain worker** / **Return to the
pool**, with the card saying whether the machine has gone idle and is therefore safe
to restart right now. It reads that from the machine's **active job** — the section
directly above it — so it says to wait for as long as a run is in flight, naming the
job when the run carries a resolved title and saying only "still running a job" when
it does not (a PR-driven phase has no board card to take a title from). The Workers
table marks every drained machine in its **Status** column, beside — never instead
of — Online/Offline, since a drained machine that is online is still online.

**Updating one from the control plane.** A machine that has opted in
(`SWARM_WORKER_SELF_UPDATE=true` — see
[`docs/configuration.md`](./configuration.md) and
[`docs/onboarding-worker.md`](./onboarding-worker.md)) can be asked to move its
SWARM **install root** to a build and restart into it, instead of pulling by hand on
every host (issue #933):

```bash
swarm workers drain <worker-id>          # required first, for the reason above
swarm workers update <worker-id> main    # a branch, a tag, or a commit id
swarm workers list                       # read what it reported
swarm workers undrain <worker-id>        # back in the pool
```

**Each request is a run, in the runs list** (issue #971). Asking a machine to move
creates one run per machine asked, scoped to that machine's project, which starts,
is visible in the project's Runs list while it is happening, and settles —
`completed` for `applied`/`already-current`, `failed` for `declined`/`refused`/
`failed` carrying the machine's own reason, or `failed` after six hours for a machine
that never answers (one that answers later corrects the row). So a failed update is
diagnosable where every other failure is, and the history survives: the runs list is
where you read when a machine was last updated and what happened, after the fact,
while `swarm workers list` shows only its latest outcome. The run names the machine
and the build it was moving to, and nothing else — it references no pull request and
no board item, produces none, and does not count against the project's concurrency.
It goes on naming that machine after the machine itself is gone: deleting a worker
removes it from the roster, and its update history stays readable, still saying which
machine each row was about.

**How it reads there** (issue #974). The row carries an amber `Maintenance` mark
beside the phase word, so it is never mistaken for pipeline work at a glance — the
mark says what *kind* of run it is, while the status badge beside it still says
whether it is running, completed or failed. Opening it shows the same mark, the
machine and the build it was asked to move to, and, when it failed, the machine's own
reason — which already names the install root, the step that failed, and whether the
checkout was returned to the build it was on — together with the command that asks
again. A failed update is **re-asked, never retried from the run page**: drain the
machine, fix the cause, then `swarm workers update <worker-id> <ref>`. The page
deliberately offers no **Terminate** and no **Recover**; both are refused for a
maintenance run server-side, and nothing in the dashboard can stop an update already
in flight — asking again with a different build supersedes the request instead.

**The machine must be enrolled in a project.** That run has to hang off one, so a
worker enrolled in **no** project is refused rather than silently asked: `swarm
workers update` says so and writes nothing, the fleet forms report the machine as
`no-project`, and a staged rollout skips it. Enroll it first with `swarm workers
enroll <worker-id> <project-id>`.

**Or the whole fleet, staged.** `swarm workers update --all <ref>` (issue #940) moves
every machine you own in one operator action — but a bounded wave at a time, so the
fleet's capacity is never down at once and the drain/undrain per machine stops being
yours to do:

```bash
swarm workers update --all main          # start it: drains and asks the first wave
swarm workers update --status            # read where it has got to
```

It drains at most `--wave` machines (one by default), waits for each to go idle, asks
it, waits for it to come back **on the new build**, puts it back in the dispatch pool,
and only then starts the next wave — and it does all of that **on its own** (issue
#941), off each machine's report, off its reconnect, and off a periodic check in the
control plane for the machine that applied and never came back. So the command above
is one operator action, not one to re-run until the fleet has moved. Re-running it is
still legal and is a nudge as well as a read; either form prints where each machine
stands: `queued`, `draining`, `signalled`, `verifying`, `done`, `skipped` or `failed`.
A machine enrolled in no project settles `skipped` — advancing the rollout would never
change that answer, so it is never waited on.

**A bad build stops it.** A machine that reports `failed`, `refused` or `declined`,
one that comes back still on the build it was asked to leave (what a machine
returning itself to its last known good build looks like — issue #934), or one that
applies and never comes back inside ten minutes, halts the rollout: nothing further is
drained or signalled, the reason is recorded and printed, and every machine it had not
reached stays in the pool. The machine that failed is deliberately left drained so you
can look at it. A halt is final — fix the build and start a new rollout; there is no
resume and no cancel. Only one rollout runs per operator at a time, so asking for a
different ref mid-move is refused rather than silently re-targeting the fleet.

`swarm workers update --all` exits 0 whatever the table says, because it is a report
rather than a pass/fail, and it is strictly owner-scoped: your own machines and
nothing wider. The unstaged one-shot fan-out issue #921 shipped is still there on the
API (`workers.requestUpdateForMine`), which asks every machine you have *already*
drained, all at once, and reports a disposition per machine.

**Or every machine on the installation — other people's included.** When the person
shipping a fix is not the person who owns the machines that have to run it, an
**installation administrator** asks them all in one command (issue #922):

```bash
swarm workers request-update main        # every machine on the installation
```

This is the one worker *write* that spans owners, and it is allowed to only because
it asks and nothing more. Both switches that decide whether a machine actually moves
stay with whoever owns it and need no cooperation from the administrator: the host
opt-in (`SWARM_WORKER_SELF_UPDATE`, read from the machine's own environment — unset it
and restart, and that machine declines every request), and the **drain**, which is
still strictly the owner's and which this command never performs. So a machine its
owner has not drained comes back `in-pool`, untouched, and one enrolled in no project
comes back `no-project` for the reason above. Each line names the machine,
its owner and its disposition, with `owner opted out` for one that last reported
`declined`; the counts under the table name the owners to go and ask. A caller who is
not an installation administrator is refused outright rather than shown their own
machines. Every request records **who made it** on the machine's own row, and the API
server logs the fleet action as one line — see
[`docs/onboarding-worker.md`](./onboarding-worker.md), which is also where the
authorization rule itself is written down.

Nothing about the restart differs from the one above — the daemon waits until it
holds no in-flight phase, applies the update, releases its session and exits 0, and
the host's process supervisor (launchd `KeepAlive` / systemd `Restart=always`) starts
it again on the new build. That supervisor is a prerequisite: without one the machine
simply stops. The request is refused while the machine is still in the pool, and with
the opt-in flag off the machine reports `declined` and carries on working. `list`
shows the outcome — `applied`, `already-current`, `declined`, `refused`, `failed` —
and anything but `applied` leaves the machine working on the build it had, with the
one exception `failed` carries: a step that failed *and* could not be rolled back
leaves the install root on neither build, which the reported message says outright.
Read that message before moving on — it names the step and, when the rollback failed
too, is the signal to repair that install root by hand on the host. **A host whose
SWARM install root is shared by several daemons may opt in (issue #935)**: the first
daemon to act takes a machine-local lock on that root and does the fetch and build,
the rest re-read the commit and report `already-current` once it has landed, and an
update is refused before anything is checked out while a peer daemon there is
mid-phase, naming the worker to drain. Drain every daemon on such a machine before
updating it, and restart the peers afterwards — `already-current` says the files
moved, not that the daemon reporting it is running them.

An `applied` update that then cannot connect is recovered **by the machine**, not
from here (issue #934): the build is only trusted once a daemon running it has
handshaked once, so a machine that has started three times without once connecting
— or that is rejected outright at the handshake — checks its last known good commit
back out, rebuilds, and restarts on it. The start is counted before a line of the
new build's own worker code is even loaded, so a build that dies on the way up —
not only one that starts and then cannot connect — is counted and recovered too. It comes back reporting its *previous* build, which the
Workers screen marks `OUTDATED` while `list` still reads `update <ref> applied`; that
pairing is what says the update was tried and did not hold. It has to work this way
because a build that cannot connect has taken away the only channel that could have
told it to go back.

**Clearing its abandoned checkouts.** A machine accumulates `task-<id>` worktrees
that nothing will adopt again — an interrupted agent leaves a stray file behind and
the ordinary retention sweep then keeps that checkout forever, because its reclaim
gate refuses anything dirty or carrying unpushed commits. The age-based sweep is the
second entry point, and an operator asks one machine for it (issue #955):

```bash
swarm workers sweep-worktrees <worker-id>
```

It prints what that machine's **last** sweep removed — each path with how long it had
gone untouched and whether it held uncommitted or unpushed work — and then asks for a
new one; the fresh answer lands on the row later and is printed by the next run of the
command. A machine keeps only its most recent sweep, and that one record is replaced
when the next answer arrives rather than when the question is asked — so a machine
asked and not yet heard from still reads as what it last swept.

The machine sweeps every project it has an **active** enrollment for, removing each
`task-<id>` checkout directly under that project's `worktreeRoot` that has gone
untouched for its `worktreeRetention.abandonedAfterDays` (10 by default —
[`docs/configuration.md`](./configuration.md)) — **including** the ones holding
uncommitted or unpushed work, which is exactly the case the retention sweep cannot
reach. That is why what each removal destroyed is recorded rather than only logged on
the machine. An enrollment still `pending`, or one `suspended`, is skipped: that
project never accepted this machine. Withdrawn *sharing consent* is not the same
thing and does not exempt a project — consent governs whether it may be given work
here, and a sweep gives it none; a machine whose owner has stopped offering it is
precisely where these checkouts are most worth removing. A checkout something is
still **using** is never removed at any age: a run leasing it, or a resumable
deferred/failed run pinning it, exempts it, the daemon's own in-flight set is what
answers that for the machine it is running on, and the sweep holds the task's own
lease across each removal so a dispatch arriving mid-sweep cannot land in the
checkout being deleted.

Unlike an update this needs **no drain and no host opt-in**: a sweep disturbs no
in-flight run, and it removes only `task-<id>` checkouts under a project's own
worktree root, so `abandonedAfterDays` is the whole of the opt-out. A machine that is
offline when you ask keeps the request on its row and is handed it on its next
connection. One project failing is counted and reported and the rest are still swept.
It is the machine owner's own call, so sign in as them.

**You do not have to ask.** The API server asks the **whole installation** once a
week on its own clock (issue #956), so every machine clears its own abandoned
checkouts with no operator action. The cadence is
`SWARM_WORKTREE_ABANDONED_SWEEP_INTERVAL_MS`
([`docs/configuration.md`](./configuration.md), default 7d) and it is the interval
after which a sweep falls **due**, not a timer period: an hourly tick compares it
against a durable marker, so restarting the API server does not re-trigger one, and a
machine that was offline when the signal went out is handed its request on the next
connection — or, failing that, asked again the following week. Read back what the
fleet deleted from any one machine:

```bash
swarm workers sweeps
```

One block per machine with its last recorded sweep and every path that sweep removed;
a machine that has never reported prints "never swept", and one that has been asked
but not yet heard from says so beneath the sweep it did report. Unlike
`sweep-worktrees` it asks for nothing, which is what makes it the right command once
nobody is doing the asking, and the weekly ask leaves every machine's stored answer
standing — so "never swept" is never an artefact of the schedule. It reads every
owner's machines, so it is an installation administrator's.

The **router** dequeues and dispatches; a project's **Maximum Concurrent Jobs**
setting and each enrolled worker's **concurrency allocation** are what bound how
many of its runs happen at once. Dispatch always runs on the control
plane (ADR-003 §2): there is no second arrangement — the in-process executor was
deleted so that one path carries every run. A project with no enrolled, connected
worker leaves its dispatch durably pending; a wait for a *machine* ends as soon
as one turns up (a worker connecting, or finishing a run and freeing its slot),
while a wait for a *human* (consent, an enrollment, a permitted phase, a drained
machine) keeps the timed cadence, since nothing a machine does can clear it.

The control-plane host's own worker runs this identical program over loopback, so
a remote worker and a local one are the same code path rather than two that have
to be kept in step. See
[`docs/cloudflare-tunnel.md`](./cloudflare-tunnel.md#remote-worker-transport-worker)
and [`docs/operations.md`](./operations.md) for health checks, ports,
webhook setup, and troubleshooting.

## Failure diagnosis

For a terminal recognised response stall, SWARM labels a task as **likely scope
exceeded** only when it also observed substantial progress and the most recent
successful Planning run recorded multiple independent concerns. A timeout alone
never proves task size: without all of that evidence, SWARM keeps a
provider-oriented diagnosis. Quota, model-capacity, launch/authentication,
worker-shutdown, and user-termination conditions take precedence and retain
their specific recovery guidance in both the board comment and run detail.

**Is this worker running the fix?** The dashboard's **Workers** screen answers it.
Each machine's daemon declares the SWARM build it is actually running — the commit
its SWARM install root is on — and the per-worker detail view shows it, beside the
build the control plane itself is on. A machine whose build is not the control
plane's carries an `OUTDATED` badge, on its detail view and beside its name in the
roster, so "which workers are behind?" is one glance rather than a question per
machine. The badge says the builds *differ*, not that the machine is behind: the
control plane compares the two commits for equality, and cannot prove a commit it
may never have fetched is an ancestor of its own.

A `+dirty` marker on a build means the running code is not exactly the commit it
names — the checkout has uncommitted changes, or its `dist/` build predates HEAD —
so that machine counts as a different build even on the same commit. No badge at
all means there is nothing to compare: the machine declared no build (it has never
connected, or its daemon predates the field), or this control plane cannot read its
own (an install root with no `.git`). An unknown is never reported as stale.

Nothing is gated on the badge — a machine on a different build is still dispatched
to. **A worker keeps running whatever its checkout held when its process last
started**, so the remedy is to update that machine's checkout and restart its
daemon; see [`docs/launchd-worker-autostart.md`](./launchd-worker-autostart.md).
On the machine itself, the daemon's `worker transport client starting` log line
reports the same build at startup.

**A task checkout vanished — where to look.** Two sweeps remove `task-<id>`
worktrees and they remove different things. The hourly retention sweep keeps the
project's most-recently-active `worktreeRetention.maxWorktrees` and *never* removes a
checkout holding uncommitted changes or unpushed commits. The age-based abandoned
sweep does remove those, by design, once nothing has touched the checkout for
`worktreeRetention.abandonedAfterDays` — and since issue #956 it runs unattended
across the whole installation once a week, so a checkout can disappear with nobody
having asked. Every such removal is recorded rather than only logged:

```bash
swarm workers sweeps          # every machine's last sweep, path by path
```

Each removed path comes with how long it had gone untouched and whether it held
uncommitted or unpushed work. On the machine itself the same removals are logged at
`warn`. A checkout something was still *using* — leased by a live run, or pinned by a
resumable deferred/failed one — is exempt at any age, so neither sweep is the
explanation for one that vanished mid-run. Raise `abandonedAfterDays` for a project
whose checkouts are meant to sit untouched for longer, or lengthen
`SWARM_WORKTREE_ABANDONED_SWEEP_INTERVAL_MS` to sweep the fleet less often.

**A renamed repository produces no failure at all.** Cards stop dispatching and
nothing is marked failed: the router logs `pm-status: work item has no backing SCM
artifact reference` and completes the job as a no-op, because the card's repository
no longer matches the project's. Fix the project's repository first, then re-point
each worker machine's checkout — see
[`docs/launchd-worker-autostart.md`](./launchd-worker-autostart.md#a-repository-was-renamed),
which carries the `swarm-repo-renamed` runbook and the ordering constraint that
keeps worker enrollments from being suspended.

**A run that was cancelled leaves its trail in the log, not in Redis.** The
cancellation marker and its recorded origin are deleted the moment the worker acts
on them, so grep the log rather than Redis:

- `run cancellation requested` — one line per request, naming the run, its project,
  task and phase, the `action` that asked (`terminate` for the dashboard/API
  Terminate button, `reset` for the agent stop "Reset & restart" performs first),
  and the recorded origin (`originSource`, `requestedAt`, and `originActor` only
  when an actor was genuinely recorded — it is never guessed). `marker=recorded` is
  the request that created the cancellation; `marker=already-pending` is a repeat
  landing on one that was already there. A request that could not be recorded at
  all logs the same fields as `run cancellation requested but not recorded`.
- `run cancellation cleared` — the cancellation *took effect*: a pending marker was
  actually consumed, by the run settling (`action=run-settled`), a manual retry, or
  a reset. A clear that found nothing pending logs nothing, so a `requested` line
  with no `cleared` line is a cancellation nothing ever acted on.
- `run reset did not complete` — a reset that threw part-way, reporting which of its
  steps had already run (`cancellationCleared`, `recoveryCleared`, the worktree
  outcome). `run reset complete` is only reached on the happy path.

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

# The same from the API's launchd agent (macOS), which restarts it afterwards
# and waits for /health — see docs/launchd-api-autostart.md
swarm-api-agent reload --all

# The same, then rebuild the Compose router and wait for it to report healthy
# (restart each worker yourself — see the script's own reminder)
npm run reload:all

# Operator identity — sign this CLI in to the control plane over the network
# (needs SWARM_CONTROL_PLANE_URL, not DATABASE_URL, so it works off the host)
npm run swarm -- login
npm run swarm -- login --status
npm run swarm -- login --logout

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
scripts, with descriptions, is in [`docs/cli.md`](./cli.md); detailed
operator guidance is in [`docs/operations.md`](./operations.md).

## Configuration

Configuration has three layers:

- `.env` — host and process settings such as database, Redis, ports, logging,
  dashboard authentication, and credential encryption.
- `swarm.config.json` — per-project repository, worktree, board mapping (`pm`, one
  member per PM provider — GitHub Projects, Linear, Jira, or Trello, all four
  selectable and switchable from the dashboard's **Project Management** tab),
  credential references (the SCM reviewer/webhook pair per SCM provider under
  `credentials.scm[<providerId>]`, plus each PM provider's own roles under
  `credentials.pm[<providerId>]`), agent, and pipeline settings.
  Apply changes with `npm run db:seed` or `swarm config apply` — which seeds every
  credential value from this host's environment *except* a `webhookSecret`, since
  that one must match the secret on the project's own webhook and so is entered per
  project in the dashboard instead.
- Dashboard global settings — app-wide settings stored in Postgres and edited
  through the dashboard API.

The complete option catalogue, defaults, and source-of-truth schemas are in
[`docs/configuration.md`](./configuration.md).

## Documentation

- [`docs/cli.md`](./cli.md) — complete command reference: every `swarm`
  operator CLI command and `npm run` script, with descriptions
- [`docs/operations.md`](./operations.md) — setup, run modes, ports,
  health checks, operator CLI, migrations, queues, worktrees, and webhooks
- [`docs/configuration.md`](./configuration.md) — complete environment,
  project, and global-settings reference
- [`docs/pipeline.md`](./pipeline.md) — phases, triggers, security, and
  provider boundaries
- [`docs/agent-containment.md`](./agent-containment.md) — how far outside
  its worktree an agent CLI run can reach, per CLI, and how to tighten it
- [`docs/status.md`](./status.md) — implemented MVP areas and current
  roadmap snapshot
- [`ai/ARCHITECTURE.md`](../ai/ARCHITECTURE.md) — engineering architecture and
  implementation conventions
- [`ai/TESTING.md`](../ai/TESTING.md) — test strategy and verification guidance
- [`docs/cloudflare-tunnel.md`](./cloudflare-tunnel.md) — exposing the
  local router to GitHub
- [`docs/onboarding-worker.md`](./onboarding-worker.md) — adding a new
  user + worker, local or remote
- [`docs/launchd-worker-autostart.md`](./launchd-worker-autostart.md) — running a
  worker from a launchd agent on macOS instead of a terminal tab, and the
  `swarm-repo-renamed` runbook for a renamed project repository
- [`docs/launchd-api-autostart.md`](./launchd-api-autostart.md) — the same for the
  API server (which also serves the dashboard), its `reload`/`restart` update flow,
  and why the API is a host process rather than a Compose service
- [`docs/github-projects-v2-api.md`](./github-projects-v2-api.md) —
  Projects v2 API and webhook details
- [`docs/decisions/`](./decisions/) — architecture decision records
- [`docs/public-hosting-exploration.md`](./public-hosting-exploration.md) —
  what a public, multi-tenant deployment would take (hosting, missing pieces,
  credential model, OAuth across the three SCM providers). **Deferred** — SWARM
  stays on privately hosted instances; kept so the analysis is not re-derived
- [`PROJECT.md`](../PROJECT.md) — the original design document, **frozen as a historical baseline**; read it for original intent, not current behavior

The live task backlog is the [SWARM GitHub Projects board](https://github.com/orgs/SmartTechBrewery/projects/6/views/1).

## Temporary: pre-multi-repo restore point

`single_repo_backup` marks the last commit before the multi-repo migration
(issues [#683](https://github.com/SmartTechBrewery/swarm/issues/683)–[#687](https://github.com/SmartTechBrewery/swarm/issues/687)) — one project owning several
repositories instead of exactly one. That migration reaches the config schema,
the run read model, every phase's dedup key, and worker routing, so the branch
exists to return to a known-good single-repository state if it goes wrong.

**Delete this branch and this section once the migration has stabilized.**
