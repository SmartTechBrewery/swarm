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
- [One process, one port (all-in-one control plane)](#one-process-one-port-all-in-one-control-plane)
- [Running on a VPS behind Caddy](#running-on-a-vps-behind-caddy)
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
- A source-control repository on GitHub, Bitbucket Cloud, gitlab.com, or Azure DevOps
  Services (`dev.azure.com`; its `repo` is the three-segment
  `organization/project/repository`, in Azure's own casing) — named by the project's
  `scm` field, which every project must set — and a project-management board with a
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
dashboard user and set its login password before signing in at `/login` — either
from the first-run setup link below, or from a shell with `DATABASE_URL`:

```bash
npm run swarm -- users add you@example.com --admin    # create your dashboard user, then
npm run swarm -- users set-password you@example.com   # set its login password (prompts, no echo)
```

**First-run setup, without a shell** (issue #1150). When the API process
(`dev:api` / `start:api`) — or the all-in-one control plane (`npm run serve`, and
so the published image) — starts against a database with **no users**, it writes
one warning line to its log:

```text
No users exist yet. Open /setup?token=… to create the first installation admin (single use, expires 2026-10-28T11:00:00.000Z).
```

Open that path on the dashboard's address (e.g.
`http://localhost:3101/setup?token=…`) — with `WEBHOOK_CALLBACK_BASE_URL` set, the
logged link already starts with that public base URL — enter an e-mail address and a password,
and SWARM creates that user as the installation admin and signs you in. The link
then stops working. It is the only place the token is ever written — only its
hash is held, in the memory of the process that logged it — and it:

- is **single use**, and **expires after an hour**;
- is **replaced on every restart** while no user exists: restarting before setup
  is completed logs a fresh link and invalidates the old one;
- is **never issued once any user exists** — however that user was created
  (`swarm users add`, an earlier setup link, or the single-user bootstrap) — and
  `/auth/setup` then refuses every token, so an installation that already has users
  sees no change at all;
- is **never issued in single-user mode**, which has its own bootstrapped admin.

Two submissions racing for the link cannot create two admins: the token is
claimed before anything is written, and the insert itself only succeeds while the
`users` table is still empty. `swarm users` stays the shell alternative for this
and for every later user.

**Adding colleagues and resetting passwords, without a shell** (issue #1151). Once
you are signed in as an installation admin, **Settings → Users** lists everyone who
can sign in and manages their accounts — the same operations as `swarm users`,
with no `DATABASE_URL` needed. Non-admins never see the tab, and every operation
behind it is refused server-side for them anyway.

- **Add user** takes the colleague's identifier (their login handle, usually an
  e-mail address), an optional display name (it defaults to the identifier) and
  an installation-admin switch. SWARM creates the account with no password and
  shows a `/set-password?token=…` link built on the dashboard's own address —
  copy it and send it to them. They open it, choose their password, and are signed
  in. Nobody else ever chooses or sees it.
- **The link is single use and expires after 72 hours.** It is shown exactly once:
  SWARM stores only its hash, so a lost link cannot be shown again — issue a new
  one. It survives a server restart for its whole lifetime.
- **Password link** on a user's row resets a forgotten password the same way,
  after a confirmation. Issuing a link changes nothing by itself: it replaces any
  earlier link for that user, their current password keeps working until the
  link is used, and using it sets the new password and **signs them out of every
  session** they have. An invalid, expired or already-used link says so on the
  page and asks for a new one.
- **The Installation admin switch** on each row grants or revokes the role. The
  dashboard refuses to revoke the **last** installation admin, so this path can
  never leave an installation nobody can administer; the refusal is shown as the
  server words it and the switch stays on. (`swarm users revoke-admin` has no such
  guard: whoever holds the shell can always `grant-admin` again.)
- **Linked identities** (issue #1167) are the board accounts each user owns — the
  same links as `swarm identities`. An item assigned to a linked account runs only
  on that user's own workers (assignee affinity). **Link identity** on a user's row
  asks for the board provider and that provider's handle: the GitHub login for
  GitHub Projects, the Atlassian **accountId** for Jira (not the e-mail or display
  name), the display name for Linear, and the member username for Trello. Re-linking
  the same pair is a no-op; a handle already linked to someone else is refused with
  that user named — unlink it from them first. The unlink button beside each link
  asks for confirmation. Changes apply from the next dispatch, with no restart.

Giving a new user access to a project is separate: a project admin adds them on
that project's **Members** tab.

**Registering this checkout's worker, the short way.** Run from the checkout the
worker is to serve:

```bash
npm run swarm -- workers setup
```

It is `register-and-enroll` with its inputs defaulted: the owner is the signed-in
operator (`swarm login`), the CLIs are the ones on this machine's `PATH`, and the
name is `<owner>_<host>_<repo>`. It asks only for the project id (offering the
checkout's repository name) and the operator source-control credential (no echo,
verified before it is stored). On macOS it then installs the launchd autostart
through `swarm-worker-agent install`; elsewhere it tells you to run `swarm
run:worker`, and `--no-autostart` skips starting it at all. It refuses a checkout
that already has a worker cached, since registering again would strand the first
worker's enrollments. `--project`, `--cli`, `--name` and `--control-plane-url`
override the defaults — see [`docs/cli.md`](./cli.md#swarm-workers).

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
SWARM_WORKER_REPO_ROOT=/path/to/this-hosts/checkout  # optional; defaults to cwd.
                                                     # Takes several, `:`-separated like PATH —
                                                     # one checkout per repository, first is primary.
```

Only the first line has to be there before onboarding, and it need not be typed:
`swarm workers register-and-enroll --control-plane-url <url>` writes it into this
checkout's `.env` when it is absent, and leaves an existing assignment alone — so a
fresh clone is bootstrapped by the same command that registers the machine. (`swarm
init` is for the *stack*, not for a worker: it copies `.env.docker.example`,
`DATABASE_URL` and all, onto a machine that must hold neither that nor `REDIS_URL`.)

**On the machine that registered it, there is a shorter way to start it.** The
registration commands (`register`, `register-and-enroll`, `setup`) also write the freshly issued credential to a per-checkout
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

**One worker can serve several repositories on one machine** (issue #1059) — one
checkout per repository, one daemon. Give it the extra checkouts at registration
with `--extra-checkout <path>` (repeatable, on `workers register` and
`register-and-enroll`), or later, from the worker's primary checkout, with:

```bash
swarm workers add-checkout ~/code/example-mobile     # host-local; no control-plane call
swarm workers remove-checkout ~/code/example-mobile
```

then restart it. `swarm run:worker` appends every recorded extra checkout to
`SWARM_WORKER_REPO_ROOT`, and the daemon declares their repositories at its next
handshake. Re-registering instead would issue a new worker and lose its enrollments
and operator credentials. See
[`docs/onboarding-worker.md`](./onboarding-worker.md#serving-a-second-repository).

**One machine can serve two installations** (issue #1215) — with one SWARM clone
per installation, because a clone's `.env` names the control plane it serves and
that installation's updates move the clone itself (ADR-006). Every command run
through a clone's `bin/swarm.js`, `run:worker` included, falls back to
`SWARM_CONTROL_PLANE_URL` in that clone's `.env` when the environment exports none
(issue #1214's precedence). So the second clone's commands and its LaunchAgent
reach the second installation with nothing exported and the first clone's `.env`
untouched, as long as the shell does not export the first installation's URL. See
[`docs/onboarding-worker.md`](./onboarding-worker.md#serving-a-second-installation-from-the-same-machine).

The operator's own source-control credential is **not** among them: it is stored
server-side per `(worker, SCM provider)` — `swarm workers set-scm-credential
<worker-id> <github|bitbucket|gitlab|azure-devops>`, or from that worker's own page in
the dashboard (`/workers/<worker-id>`, which verifies the value against the provider
before storing it) — and travels with each assignment, so rotating it needs no worker
restart and a Bitbucket, GitLab, or Azure DevOps project resolves its own credential
rather than a GitHub-named one. An Azure DevOps PAT is verified in the organization of
an Azure DevOps project the worker is enrolled in, so enroll the worker before setting
it.

It is intentionally host-run: it needs local Git worktrees, agent CLI
authentication, and the developer's PATH.

**What it holds — and what it deliberately doesn't.** Only the credential and the
control-plane URL; no `DATABASE_URL`/`REDIS_URL`, even on a host that has them, and
no stored source-control secret. Its agent therefore
authenticates as the *operator's own* account everywhere (ADR-004 §2), while the
project-scoped reviewer PAT and the PM credential never leave the server — so a
submitted review's identity is unchanged.

**How it connects.** It performs the `/worker/session` handshake — declaring the
CLIs it can run, the pipeline phases it can execute, and which repositories its
local checkouts actually are (read from each checkout's `origin`, primary first) — keeps its
session live over the `/worker/stream` WebSocket, and reconnects with backoff
(ADR-003 §1). Because it declares its phase repertoire, the control plane never
routes a phase to a worker that cannot run it; the work waits for one that can.

**How it guards its checkouts.** An assignment runs in the checkout of its
repository; one for a repository the worker holds no checkout of is refused up
front, naming both, rather than run. The daemon locks every checkout it holds for
its whole life, so a second worker pointed at any of the same paths refuses to
start instead of driving Git in the same repository (give a second worker on the
machine its own checkouts). The control plane polices the same pairing:
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
the follow-up Review a pushed fix enqueues. Those run-scoped calls name the run's
repository, so on a project owning several repositories they act on the one the
run is for; a worker older than that (issue #1055) is refused on them with an
"upgrade the worker" reason rather than acting on the project's first repository.
Planning's board surface (its own
blocker/dependent lookup for the dependency gate it has run since issue #889 —
which rides the routes Implementation's already uses — plus creating a split's
sibling cards, recording the dependency edges between them, carrying the split item's own
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

**When a machine is idle and you did not drain it.** The other reason SWARM stops
giving a machine work is that one of its agent CLIs reported its usage allowance
spent on a real run (issue #981). That is recorded per `(machine, CLI)` with the
instant the allowance is expected back, and it is **not** a drain: nobody set it,
nothing clears it by hand, it lapses by itself at that instant, and the machine goes
on taking work on its *other* CLIs throughout. Read it in the two places it is
surfaced (issue #988): `swarm workers list` marks such a machine `rate-limited:
<cli>` beside the `draining` suffix — naming the CLIs, because the machine as a whole
is not idle — and the machine's dashboard page has a **Usage limits** section, above
Pool membership, giving each cooling CLI, when it is expected back, and the CLI's own
reset wording. A machine cooling on nothing shows neither. On the **Queue**, work held
back because *every* candidate machine is cooling reads "waiting for a usage limit to
reset" rather than "waiting for an available worker", so it is distinguishable from a
fleet that is genuinely busy or unauthorized; nothing needs doing to either, and the
work starts by itself once the first allowance returns.

**Updating one from the control plane.** A machine can be asked to move its SWARM
**install root** to a build and restart into it, instead of pulling by hand on every
host (issue #933) — and since issue #975 there is no per-host setting that can refuse.
What bounds the request is the mechanism: the fetch takes no URL and no refspec, the
target must be an ancestor of the branch the install root already tracks, a dirty
install root is refused, a machine that declared it runs under no process supervisor
is refused (below), and the drain below stays the machine owner's own control.
See [`docs/onboarding-worker.md`](./onboarding-worker.md) and
[`ADR-006`](./decisions/ADR-006-unconditional-worker-updates.md):

```bash
swarm workers drain <worker-id>          # required first, for the reason above
swarm workers update <worker-id> main    # a branch, a tag, or a commit id
swarm workers list                       # read what it reported
swarm workers undrain <worker-id>        # back in the pool
```

**Each request is a run, in the runs list** (issue #971). Asking a machine to move
creates one run per machine asked, scoped to that machine's project, which starts,
is visible in the project's Runs list while it is happening, and settles —
`completed` for `applied`/`adopted`/`already-current`, `failed` for `declined`/`refused`/
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
machine, address whatever the machine's reason names, then `swarm workers update
<worker-id> <ref>`. Read that reason first, because not every `failed` update is a
machine-side failure — re-targeting a machine settles the previous request's run as
*superseded*, and re-asking for the build **that** run names would move the machine
back off the build you just chose and supersede the newer request still in flight,
which is why the page states the command on a condition rather than as an
instruction. The page deliberately offers no **Terminate** and no **Recover**; both
are refused for a maintenance run server-side, and nothing in the dashboard can stop
an update already in flight — asking again with a different build supersedes the
request instead.

**And on the machine's own page** (issue #977). `/workers/<worker-id>` carries an
**Update history** card, right under the build the daemon declares, listing that
machine's most recent requests: the build each was asked to move to, when it was
asked, how it ended, and — for a failure — the machine's own reason, with each entry
linking to its run. So "when did this machine last update, and did it work?" is
answered on the machine's page rather than by filtering the global runs list for it.
It is bounded to the ten most recent (the runs list stays where the whole history is
read and filtered), it is read from `runs` rather than from the machine's latest
outcome, so a request is still there after the next one is made, and it shows nothing
for a machine nobody has asked. It offers no action: a failed request is re-asked with
`swarm workers update`, exactly as below.

**And while the request is outstanding, the roster says so** (issue #978). From the
moment a machine is asked until it reports, it carries an amber `UPDATING` mark
beside its name on the Workers table and on its own page — so a machine mid-update
is not mistaken for one nobody has looked at. The build mark next to it is unchanged
and still answers which build the machine is *actually* on: an update is only in
effect once the daemon has restarted and re-declared. See **Is this worker running
the fix?** below for how the two marks read together.

**The machine must be enrolled in a project.** That run has to hang off one, so a
worker enrolled in **no** project is refused rather than silently asked: `swarm
workers update` says so and writes nothing, the fleet forms report the machine as
`no-project`, and a staged rollout skips it. Enroll it first with `swarm workers
enroll <worker-id> <project-id>`.

**What the machine says about coming back** (issue #997). A daemon works out at
startup whether a process supervisor will start it again after it exits — launchd or
systemd — and declares that at handshake as one of three values, beside the phases,
the checkout repository and the SWARM build it already declares. `swarm workers list`
marks a machine that declared `unsupervised`: it was started by hand, so an update
applied there exits and the machine is gone until somebody starts it again.
`/workers/<worker-id>` states all three under **Declared by the daemon** — *Supervised*,
*Not supervised*, or *Unknown* for a daemon that predates the field or runs somewhere
SWARM cannot read it, which is stated as unknown rather than assumed either way. It
also logs the answer at startup, so an operator running `npm run dev:worker` in a
terminal is told there and then.

What that reading **cannot** prove, and deliberately does not claim: that the
supervisor is configured to restart the job. `KeepAlive` and `Restart=always` are not
readable from inside the process, so *Supervised* means "launchd or systemd started
this daemon", not "it will definitely come back".

**On macOS it is narrower than it sounds, and errs on the safe side.** The launchd
reading asks whether launchd started *this process*. Accepting anything looser was
worse: `XPC_SERVICE_NAME` is inherited by every descendant of every launchd job, a
Terminal window included, so taking it on its own would read a genuinely hand-run
daemon as supervised. The error therefore only ever under-claims — nothing is marked
as coming back unless it demonstrably will.

That strictness used to catch SWARM's own agents. A LaunchAgent starts
`swarm run:worker`, which until recently spawned `npm run dev:worker`, which spawned
the daemon — two processes between launchd and the worker, so every machine
`swarm-worker-agent` installed read *Not supervised* although launchd would restart
it, and every fleet update skipped all of them. `swarm run:worker` now **replaces its
own process** with the daemon, so the job launchd started is the worker and the
reading is right without being loosened. Two things follow for an operator. A machine
has to be on a build carrying that change and have been restarted once before it
declares *Supervised* — until then it is refused exactly as before, and the way out
of that first refusal is to update it by hand (`git pull && npm ci && npm run build`,
then restart the agent). And a daemon started some other way — `npm run dev:worker`
in a terminal, or a LaunchAgent of your own that runs something other than
`swarm run:worker` — still reads *Not supervised*, correctly.

**The machine must be under a process supervisor** (issue #997, phase 2/2). The
daemon applies an update by *exiting*, so a machine that declared `unsupervised` would
be gone until somebody started it by hand rather than restarted onto the new build —
and it is refused instead of silently asked: `swarm workers update` says so and writes
nothing, the fleet forms report it as `unsupervised`, and a staged rollout skips it and
puts it back in the dispatch pool rather than halting for it. Install the daemon under
launchd with `swarm-worker-agent install`
([`docs/launchd-worker-autostart.md`](./launchd-worker-autostart.md)) and request the
update again, or update that machine by hand (`git pull && npm ci && npm run build`,
then restart it). A machine whose supervision is **unknown** is never refused — an
older daemon, a machine that has never connected, a platform the reads cannot answer
for — so a fact SWARM could not establish never blocks an operator who knows better.
This is a precondition of the update *mechanism*, like the drain and the ancestor
check, not a per-host setting: nothing on the machine turns it off, which is what
keeps it consistent with
[`ADR-006`](./decisions/ADR-006-unconditional-worker-updates.md).

Read the macOS caveat above before relying on this: a LaunchAgent that starts the
daemon through `swarm run:worker` leaves the daemon's parent as `npm`, so it declares
`unsupervised` and is refused although launchd would in fact restart it. Until the
detection reads that shape, such a host updates by hand.

Nothing else is gated on the declaration — dispatch is unaffected, and a machine that
declared `supervised` behaves exactly as it always has.

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
stands: `queued`, `draining`, `signalled`, `verifying`, `done`, `current`, `skipped` or
`failed`. **A machine already on the target is left alone** (issue #1146): when `<ref>` is
a commit id and a machine's declared build already is that commit (and is not dirty), it
settles `current` with "already on the rollout's target build" on its own line — never
drained, never asked, and in the dispatch pool throughout. It is still listed, so the
readout shows the whole fleet was considered. When *every* machine is already on it,
nothing is started at all and the command says so. A branch or tag cannot be compared
without a fetch, and a machine that declared no build cannot be compared either, so
those machines go through the normal drain-and-ask path — the daemon's own
`already-current` report then settles them `done`. A machine enrolled in no project settles `skipped` — advancing the rollout would never
change that answer, so it is never waited on. A machine that is **offline when its turn
comes** is passed over the same way (issue #1071): it settles `skipped` with "offline
when its turn came" on its own line, is never drained or asked, and the wave is filled
from the next connected machine instead. Passed-over machines do not count toward the
three-hosts-in-a-row halt. To pick them up, start the fleet update again once they are back:
with a commit id as the target, only the machines still behind are drained and asked, and
the rest settle `current` untouched. A machine counts as **back on the new
build** only through a daemon that took its lease *after* the machine reported
`applied`; a reconnect of the old daemon before that report proves nothing either way.

**A bad build stops it.** A machine that reports `failed` — the build broke on it — or
one that comes back still on the build it was asked to leave (what a machine returning
itself to its last known good build looks like — issue #934), halts the rollout:
nothing further is drained or signalled, the reason is recorded and printed, and every
machine it had not reached stays in the pool. A machine that was *already* being moved
when the halt landed still finishes settling on the advances that follow, and goes back
in the pool once it does; only the machine that **answered badly** — reported a
failure, or came back on the old build — is deliberately left drained, so you can look
at it, and the halt footer names the `swarm workers undrain` that ends that. A halt is final — fix the build and start a new
rollout; there is no resume and no cancel. Only one rollout runs per operator at a
time, so asking for a different ref mid-move is refused rather than silently
re-targeting the fleet.

**A machine that refuses does not stop it.** `refused` (and the legacy `declined`) is
almost always about that machine rather than the build — its `git fetch` failed, its
install root has uncommitted changes, a peer on the same install root is mid-phase —
so the member settles `failed` with the machine's own reason and the rollout moves on
to the next machine. The refusing machine follows the same scope rule as any machine
that answered badly: left drained in an owner-scoped rollout, returned to the pool in
an installation-wide one.

**A machine that stops answering does not stop it** (issue #1064). Silence says
nothing about the build — the machine may be asleep, off the network or unplugged — so
after **two minutes** of it, measured from the machine's last word, the rollout gives
up on that one machine: the member settles `failed` with the reason in its own line,
any outstanding request is withdrawn, the machine goes back in the dispatch pool, and
the next wave is drained and signalled in the same pass. Two minutes is the same
silence the control plane already calls a machine *probably gone* at, and the decision
lands on the next periodic advance, so you see it within about three minutes rather
than losing the rest of the fleet to one dead laptop. Because the member settles
`failed` without halting, a **`completed` rollout can carry failures** — the member
table and the tally are where they are read, and the line under them then names every
machine that is not on the target instead of saying they all are.

**Failures on three different hosts in a row do stop it** (issue #1064). A build that
cannot start anywhere is silent on *every* machine, and a target no machine can
resolve is refused by every one, so on those alone the rollout would march the whole
fleet through it. Once machines on **three different hosts in a row** have been given
up on or have refused, it halts, with a reason naming the count and saying to treat
the build as unable to start — the same halt as above, so the machines it had not
reached are stood down into the pool on that same pass. The count is per **host**
(the daemon's reported hostname), not per worker: several daemons on one host share
its network, credentials and install root, so one host's trouble counts once however
many of its workers fail. "In a row" is read in the order the rollout reaches
machines: one that comes back on the new build resets the count (the build
demonstrably starts, so the earlier failures were about those machines), and one
settled `skipped` neither adds to it nor resets it. It is a flat count rather than a
share of the fleet, and it is coded rather than configurable. A machine that
*reports* `failed` still halts the rollout on the first one.

`swarm workers update --all` exits 0 whatever the table says, because it is a report
rather than a pass/fail, and it is strictly owner-scoped: your own machines and
nothing wider. The unstaged one-shot fan-out issue #921 shipped is still there on the
API (`workers.requestUpdateForMine`), which asks every machine you have *already*
drained, all at once, and reports a disposition per machine.

**Or the whole installation, staged.** An **installation administrator** can run the
very same rollout over *every* registered machine, whoever owns it (issue #1024) —
`workers.startFleetUpdateForInstallation` to start or advance it,
`workers.fleetUpdateStatusForInstallation` to read it, each line naming the machine's
owner. **The dashboard is where an administrator drives it** (issue #1025): the
`/workers` toolbar's **Update all workers** button starts it, and the readout above
the roster says where every machine stands while it runs — see below. There is still
no CLI command for it (`swarm workers request-update` stays the unstaged
installation-wide fan-out, and `swarm workers update --all` stays your own fleet).

It behaves exactly like the rollout above — one bounded wave at a time, never
interrupting a machine mid-phase, advancing itself off reports and reconnects, halting
on a machine that reports `failed`/`refused`/`declined` or comes back on the build it
was asked to leave, giving up after two minutes on one that stops answering, and
halting once three have been given up on in a row.
**One thing differs, and it is the point: every machine it drained goes back in the
dispatch pool when the rollout is finished with it — on a halt, and including the
machine that answered badly.** An
administrator drained machines belonging to people who never asked for the update, so
none of them is left out of the pool for somebody else to notice; the machine that
failed is reported in the table rather than held out of service. Draining itself is
still not an administrator's to do (`swarm workers drain` is the owner's alone), which
is why this is the only way an administrator's action can take a machine out of the
pool at all — inside a rollout that puts it back.

Only one rollout runs on the installation at a time, and the two scopes exclude each
other: an installation-wide rollout names your machines too, so starting one while
*any* owner's rollout is under way is refused, and so is starting your own while the
installation-wide one is. The refusal names the status procedure to read; it has to
finish or halt first.

**Or every machine on the installation — other people's included.** When the person
shipping a fix is not the person who owns the machines that have to run it, an
**installation administrator** asks them all in one command (issue #922):

```bash
swarm workers request-update main        # every machine on the installation
```

**The dashboard does the staged thing instead** (issue #1025). The `/workers` toolbar
above the roster has **Update all workers**, and since that issue it starts the
*staged installation-wide rollout* described earlier —
`workers.startFleetUpdateForInstallation` — rather than this command's one-shot ask.
It arrived (issue #1009) calling the fan-out, which on an installation where draining
stays each owner's own call reported nearly every machine `in-pool` and moved nothing;
the rollout drains the machines itself, so the button now does what its label says. It
asks for the build the control plane itself is running rather than taking a ref, and
confirms first — and its confirmation says what a rollout actually does: it drains a
bounded number of machines at a time, never interrupts a phase already running, waits
for each machine to come back on the new build, halts the whole thing on one that
*reports* it cannot take the build while giving up within two minutes on one that stops
answering, and gives every machine it drained back to the dispatch pool, a halt
included.

**Where it is read from is the page, not the modal.** A rollout advances itself, so
`/workers` carries a readout above the roster whenever one has run: the target, the
status, the wave size, the halt reason when it halted, and one line per machine with
its owner, its state (`queued`, `draining`, `signalled`, `verifying`, `done`,
`current`, `skipped`, `failed`) and whatever that machine itself reported. The button
always asks for the control plane's own commit, so a machine already on it reads
**Already current** and was never taken out of the pool, and when every machine is
already on it the modal says so and no rollout is started. It polls on the
roster's own cadence and survives a page reload, so closing the tab mid-rollout loses
nothing. A machine that settled `skipped` — enrolled in no project, or running under
no process supervisor — reads as skipped with its reason and never as done: it is
still on the build it had. Once the rollout is `completed` the readout folds to a
`Last fleet update report` heading you can open again — and fold back; a halted one
stays open, since it is the one that is waiting on you.

A project's own administrator has the narrower, **unstaged** form in the same place on
the project detail page's **Workers** tab (issue #1010): **Update project workers**
asks the machines enrolled in that project, in the project's configured order, through
`workers.requestUpdateForProject` — this command's fan-out, scoped to one project, and
unchanged by the button above. It has no CLI counterpart — the command above is the
installation — and its confirmation adds the one thing that set has to say: a machine
enrolled in other projects as well is moved for all of them, since an update moves its
SWARM install root rather than one enrollment. It also keeps the fan-out's own
precondition, which is true of it and not of the rollout: only machines their owners
have already drained are asked, so it cannot take capacity down.

This command spans owners, and is allowed to only because
it asks and nothing more, and asks for something bounded. (The staged
installation-wide rollout above spans owners too and goes further — it drains — which
is why it is bounded differently: by having to give every machine back.) The switch that decides
whether a machine is asked at all stays with whoever owns it and needs no cooperation
from the administrator: the **drain**, still strictly the owner's and never performed
by this command. So a machine its owner has not drained comes back `in-pool`,
untouched, and one enrolled in no project comes back `no-project` for the reason
above. What it can ask *for* is bounded by the mechanism stated above — an
administrator can move a machine along the branch its install root already tracks and
nowhere else. Each line names the machine, its owner and its disposition; the counts
under the table name the owners to go and ask. A caller who is
not an installation administrator is refused outright rather than shown their own
machines. Every request records **who made it** on the machine's own row, and the API
server logs the fleet action as one line — see
[`docs/onboarding-worker.md`](./onboarding-worker.md), which is also where the
authorization rule itself is written down.

Nothing about the restart differs from the one above — the daemon waits until it
holds no in-flight phase, applies the update, releases its session and exits 0, and
the host's process supervisor (launchd `KeepAlive` / systemd `Restart=always`) starts
it again on the new build. That supervisor is a prerequisite: without one the machine
simply stops. The request is refused while the machine is still in the pool. `list`
shows the outcome — `applied`, `adopted`, `already-current`, `refused`, `failed`, plus
the legacy `declined` from a machine still on a build predating issue #975 — and
anything but `applied` or `adopted` leaves the machine working on the
build it had, with the one exception `failed` carries: a step that failed *and* could
not be rolled back leaves the install root on neither build, which the reported message
says outright. Read that message before moving on — it names the step and, when the
rollback failed too, is the signal to repair that install root by hand on the host.
**A host whose SWARM install root is shared by several daemons may opt in (issue
#935)**, and since issue #973 asking it moves *every* daemon on it: the first to act
takes a machine-local lock on that root and does the fetch and build, the rest wait for
it to finish, then restart onto exactly what it landed and report `adopted` — so one
machine fetches and builds once and nobody logs in afterwards. A waiting daemon adopts
what the install root's own record says was *applied*, never merely that somebody held
the lock: if the daemon it queued behind landed nothing — it refused, or its own fetch
failed — the waiting one fetches and builds for itself rather than reporting a success
the machine did not earn. An update is still
refused, just before anything is checked out, while a peer daemon there is mid-phase,
naming the worker to drain, so drain every daemon on such a machine before updating it.
A daemon comes over on **its own** request: `swarm workers update <worker-id> <ref>`
moves one, while `update --all`, `request-update` and the staged rollout ask every
machine and are what bring a shared install root's daemons all the way over.

An `applied` update that then cannot connect is recovered **by the machine**, not
from here (issue #934): the build is only trusted once a daemon running it has
handshaked once, so a machine that has spent its whole failed-start budget without
once connecting — three starts, plus one for each peer daemon that adopted the build,
since those peers restart into it too — or that is rejected outright at the handshake,
checks its last known good commit back out, rebuilds, and restarts on it. The start is counted before a line of the
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

Unlike an update this needs **no drain**: a sweep disturbs no
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

The **router** dequeues and dispatches; each enrolled worker's **concurrency
allocation** is what bounds how many of a project's runs happen at once on that
machine — the project-wide **Maximum Concurrent Jobs** setting was retired by issue
#1190, so a project's runs are bounded only by the allocations of the workers
enrolled in it, and new tickets by each repository's WIP limit below. Dispatch always runs on the control
plane (ADR-003 §2): there is no second arrangement — the in-process executor was
deleted so that one path carries every run. A project with no enrolled, connected
worker leaves its dispatch durably pending; a wait for a *machine* ends as soon
as one turns up (a worker connecting, or finishing a run and freeing its slot),
while a wait for a *human* (consent, an enrollment, a permitted phase, a drained
machine) keeps the timed cadence, since nothing a machine does can clear it.
When several dispatches wait for the same worker capacity, **work for tickets already
in flight goes first**, and **Resolve-conflicts first of all** (issue #1191): a worker
self-update, then Resolve-conflicts, then every other phase of a ticket already in
flight — Review, Respond-to-review, Respond-to-CI, and the Planning or Implementation
of a ticket already holding a WIP slot — and only then a new ticket's start. Equally
ranked work goes oldest first, and nothing already running is interrupted.

Each repository also has a **WIP limit** (`repositories[].wipLimit`, default 1 —
[`docs/configuration.md`](./configuration.md#repositories), editable per repository on
the Source Control tab), which bounds how many **tickets** are in flight there rather
than how many runs happen at once (issue #1185). Only a ticket's **start** is held
back: its Planning, or its Implementation when it never ran Planning. Every later
phase of a ticket already in flight, and every pull-request-driven phase — Review,
Respond-to-review, Respond-to-CI, Resolve-conflicts, merge automation — runs
regardless, so a ticket can always get the job that finishes it. A held start shows
in the Queue as *waiting for a free WIP slot in its repository*, with a deferred run
whose reason names the tickets holding the slots, and starts by itself once one
frees. A ticket stops counting when its **pull request is merged or closed**, its
**card reaches Done or Backlog**, or it is **Put back** from the Queue; a start that
turns out to be blocked on an unfinished prerequisite gives its slot back while it
waits. A ticket taken off automation frees its slot too: one the automation-label or
assignee check skips frees it at once, and a periodic sweep (every 5 minutes) re-reads
each slot holder's card and frees the slot when the card has lost the automation label,
reached Done or Backlog without SWARM seeing the move, or its repository was removed
from the project — so removing the label frees the slot within one sweep. A card the
sweep cannot read keeps its slot until a later pass can. A failed run keeps its slot — the ticket is waiting on you — so to free one by
hand, close the pull request or move the card to Backlog or Done. Tickets already in
flight when the limit shipped hold no slot. It is the only project-side bound: an
admitted ticket never waits for a project slot, only for a worker with a free
allocation.

The **Tickets in progress** section of the Runs screen, between Stalled and the
Queue, shows how full each repository is (issue #1192; called "WIP" until #1204). Its
heading counts the tickets holding a slot, `Tickets in progress (n)`, and adds
`(n waiting on you)` when any need you. A repository row reads `x / y in flight`
and, when new tickets are held back, `n waiting`; under it is every ticket holding a
slot — its card, its pull request once it has one, how long it has been in flight, and
what it is doing. A ticket the pipeline cannot move on its own carries a **Waiting on you** badge
with the reason: its plan is waiting for your greenlight (move the card to Ready), its
pull request is approved and waiting for you to merge, it reached the review cap, it
stalled, or its latest run failed and nothing will retry it. A Review abandoned while
the head's CI was still running is not one of these (issue #1203): the completed-checks
event starts Review by itself, so the ticket shows as waiting on the pipeline —
"Waiting for CI — Review starts when the checks finish" — and reads as stalled only if
nothing moves for two hours. That verdict comes from the same liveness rules as the Stalled section, so a dismissed stall still shows here
while its ticket holds a slot. A Queue row waiting for a WIP slot also names its
repository's `x / y`. To free a slot, finish or abandon the ticket: merge or close its
pull request, move its card to Done or Backlog, or Put it back from the Queue. The
section is hidden when no repository has a ticket in flight or waiting, and, like the
Queue, needs a chosen project unless you are an instance administrator.

The control-plane host's own worker runs this identical program over loopback, so
a remote worker and a local one are the same code path rather than two that have
to be kept in step. See
[`docs/cloudflare-tunnel.md`](./cloudflare-tunnel.md#remote-worker-transport-worker)
and [`docs/operations.md`](./operations.md) for health checks, ports,
webhook setup, and troubleshooting.

## One process, one port (all-in-one control plane)

By default a SWARM control plane is **two processes**: the router (Compose,
`Dockerfile.router` — webhooks, `/worker/*`, `/operator/*`, migrations, dispatch) and
the API server (`npm run dev:api` / `swarm-api-agent` on `127.0.0.1:3101` —
`/auth/*`, `/trpc/*`, the dashboard, host maintenance), routed by path in front.
That layout is unchanged, and stays the default.

For a server behind a reverse proxy, the same control plane can run as **one
process on one port** (issue #1148):

```bash
npm run build:dashboard
npm run serve                          # from source
npm run build && npm run start:serve   # or from compiled output
```

Run either from the repo root. It serves everything both processes serve — the
webhook routes, `/worker/*` including the WebSocket upgrade, `/operator/*`,
`/auth/*`, `/trpc/*`, the dashboard and a single `/health` — and runs what both
run: the dispatch consumer, the rollout ticker, the worktree-sweep bridge, the
orphaned-run reap and the weekly fleet abandoned-worktree sweep — and, on a
database with no users, logs the [first-run setup](#quick-start-beyond-the-readme)
link. A proxy in front
needs no path rules (`reverse_proxy app:3000`), and every URL — the workers'
`SWARM_CONTROL_PLANE_URL`, the provider webhook URLs, `WEBHOOK_CALLBACK_BASE_URL` —
is the one public base URL.

- **Listen address:** `PORT` (default `3000`) and `SWARM_SERVE_HOST` (default:
  every interface).
- **Migrations run at startup, before the port is bound**, so no request or
  dispatch is served against an older schema. A failed migration exits non-zero.
- **Unsafe configurations are refused.** The process is treated as
  network-facing whatever it binds, and will not start with
  `SWARM_SINGLE_USER_MODE=true` or without a valid `CREDENTIAL_MASTER_KEY`; the
  error names each problem and its fix. `SWARM_SERVE_ALLOW_INSECURE=true` starts it
  anyway, with a warning.
- **The worktree retention sweep is off**, because it prunes checkouts on *this*
  host, which such a server usually has none of. `SWARM_SERVE_WORKTREE_SWEEP=true`
  turns it back on.
- **SIGTERM** stops dispatch, the timers and the listener, then exits.

This is also what the published image runs (below). The variables are in
[`docs/configuration.md`](./configuration.md) ("All-in-one control plane").

### The published image

`ghcr.io/smarttechbrewery/swarm` is built from the repo-root `Dockerfile` by
`.github/workflows/publish-image.yml` (issue #1149). It holds the backend and the
built dashboard, runs the all-in-one control plane on port `3000` by default, and
applies migrations at start. The package is public, so `docker pull` needs no
`docker login`. It needs the same environment as above — `DATABASE_URL`,
`REDIS_URL`, `CREDENTIAL_MASTER_KEY`, `DATABASE_SSL` as your Postgres requires,
`WEBHOOK_CALLBACK_BASE_URL` for Trello; see
[`docs/configuration.md`](./configuration.md). `docker build -t swarm .` builds the
same image locally.

| Tag | Published when | Moves? |
| --- | --- | --- |
| `vX.Y.Z` | a `v*` git tag is pushed | no, by convention |
| `stable` | a `v*` git tag without a `-` (not a pre-release) is pushed | yes, once per release |
| `sha-<7>` | a commit on `main` is published | no |
| `main` | every merge to `main` | yes, many times a day |

**Never run `main` on a server.** It moves continuously — the pipeline merges many
times a day — so any pull can pick up a different build. Pin a version or a `sha-`
tag, or use `stable` when the people deploying cannot edit the server's `.env`
(say, a VPS where you are only allowed to pull and restart): it moves only when a
maintainer cuts a release, so the upgrade is still deliberate, and it is applied
only by an explicit pull — a restart, or `docker compose up -d` alone, keeps the
image already on the host. Migrations only go forward: once a newer image has
migrated the database, an older tag is not guaranteed to run against it, so roll
back by restoring a pre-upgrade database backup, not by re-pinning. Upgrade
deliberately.

A compose service pointing at a tag updates with a plain pull and recreate:

```yaml
services:
  swarm:
    image: ghcr.io/smarttechbrewery/swarm:v1.2.3   # or sha-<7>
    restart: unless-stopped
    env_file: .env
    ports: ["127.0.0.1:3000:3000"]
```

Edit the tag, then `docker compose pull && docker compose up -d` — Compose
recreates the container only when the image changed.

For a whole server — Postgres, Redis and TLS included — use the ready-made bundle
in [Running on a VPS behind Caddy](#running-on-a-vps-behind-caddy) instead.

- **Which commit is this?** The image has no `.git`, so the control plane reports
  no build commit of its own; the image label does:
  `docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' ghcr.io/smarttechbrewery/swarm:<tag>`.
- **The first admin** needs no shell: on a database with no users the container
  logs a one-time `/setup?token=…` link (see
  [First-run setup](#quick-start-beyond-the-readme)).
- **Admin commands** run inside the container, since this mode refuses
  single-user mode: `docker compose exec swarm node dist/cli/index.js users add
  you@example.com --admin`, then `… users set-password you@example.com`. Every
  later user needs neither: an installation admin adds them, and resets their
  passwords, under **Settings → Users** (see
  [Adding colleagues](#quick-start-beyond-the-readme)).
- **Unchanged:** `Dockerfile.router`, the Compose `router` service and
  `npm run reload:all` still build the router locally, as before.
- **Maintainers:** cut a version with `npm run release` (`bin/swarm-release`), from
  a clean `main`. It shows the current version and asks for the new one (`X.Y.Z`).
  Then it bumps `package.json`, commits `chore(release): vX.Y.Z` to `main` and
  tags it, and pushes both. It waits for the image build, which also moves
  `stable`, and publishes the GitHub release. Finally it runs
  `sudo dockerctl deploy app` on the server and checks that the new version is
  live. It warns first when `deploy/vps` changed since the previous tag, because
  the server's files may then need the admin. The server is
  `$SWARM_DEPLOY_SSH` / `$SWARM_DEPLOY_URL`, defaulting to the SmartTechBrewery
  VPS. A tag pushed by hand (`git tag vX.Y.Z && git push origin vX.Y.Z`) builds
  and moves `stable` the same way, but deploys nothing. A `vX.Y.Z-rc.N`
  pre-release does not move `stable`.
  The package has to be made **public** once by an org admin (GitHub → the org's
  Packages → `swarm` → Package settings → Change visibility → Public); until then
  an anonymous pull fails.

## Running on a VPS behind Caddy

`deploy/vps/` is a ready-made bundle for running a SWARM control plane on a plain
Linux server (issue #1153): the [published image](#the-published-image), Postgres
and Redis, and [Caddy](https://caddyserver.com) in front with automatic HTTPS. It
needs **no SWARM checkout on the server** and no shell into the app — just its
three files:

| File | What it is |
| --- | --- |
| `docker-compose.yml` | the four services below, their networks, healthchecks and named volumes |
| `Caddyfile` | one site — your domain — doing `reverse_proxy app:3000` |
| `.env.example` | every variable the bundle needs, with how to generate each secret |

It is additive: the repo-root `docker-compose.yml`, `.env.docker.example` and the
[Cloudflare-tunnel](./cloudflare-tunnel.md) layout are unchanged.

| Service | Image | Networks | Published ports |
| --- | --- | --- | --- |
| `caddy` | `caddy:2-alpine` | `edge` | `80`, `443` (TCP + UDP) |
| `app` | `ghcr.io/smarttechbrewery/swarm:<SWARM_IMAGE_TAG>` | `internal`, `edge` | none |
| `postgres` | `postgres:16-alpine` | `internal` | none |
| `redis` | `redis:7-alpine` (password-protected) | `internal` | none |

`internal` is a Docker `internal: true` network with no gateway, so Postgres and
Redis cannot be reached from outside Docker and have no route out either. Caddy is
the only service that publishes a port — which matters, because Docker-published
ports bypass host firewalls such as `ufw`. The app's `DATABASE_URL` and `REDIS_URL`
are assembled by the compose file from `POSTGRES_PASSWORD` and `REDIS_PASSWORD`.

**Prerequisites:** a Linux host with Docker Engine and the Compose v2 plugin; a
DNS `A`/`AAAA` record for your domain pointing at it; inbound `80` and `443` open
(Caddy needs `80` for the ACME challenge), and outbound HTTPS allowed (image pulls,
provider APIs).

### Get the bundle and configure it

Fetch the three files at a ref — ideally the commit of the image tag you are about
to run (`docker inspect` shows it, see [The published image](#the-published-image)):

```bash
mkdir swarm && cd swarm
ref=main   # or the tag / commit you deploy
base=https://raw.githubusercontent.com/SmartTechBrewery/swarm/$ref/deploy/vps
for f in docker-compose.yml Caddyfile .env.example; do curl -fsSLO "$base/$f"; done
cp .env.example .env && chmod 600 .env
```

(`scp -r deploy/vps` from any checkout works just as well.) Then fill in `.env`:

| Variable | Value |
| --- | --- |
| `SWARM_IMAGE_TAG` | a `vX.Y.Z` or `sha-<7>` tag, or `stable` if whoever upgrades cannot edit `.env` — never `main` on a server |
| `WEBHOOK_CALLBACK_BASE_URL` | `https://<your domain>` — scheme and host only, no trailing slash; also Caddy's site address |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | `openssl rand -hex 32` each — hex because they are embedded in URLs |
| `CREDENTIAL_MASTER_KEY` | `openssl rand -hex 32` — encrypts every stored credential |
| `SWARM_SINGLE_USER_MODE` | leave `false`; the app refuses to start with `true` |

**Back up `CREDENTIAL_MASTER_KEY` somewhere other than the server now.** Every
credential the dashboard stores is encrypted with it; losing or changing it makes
them all undecryptable, and no database backup brings them back. Any other
variable from [`docs/configuration.md`](./configuration.md) can be added to the
same `.env`, which is passed to the app whole.

### First start and the first admin

```bash
docker compose up -d
docker compose ps                              # wait until app reports (healthy)
docker compose logs app | grep 'setup?token='  # the first-run setup link
```

On a fresh database the app logs a one-time link that already starts with
`https://<your domain>` (see [First-run setup](#quick-start-beyond-the-readme)).
Open it, enter an e-mail address and a password, and you are signed in as the
installation admin. The link is single use and expires after an hour; if it has
lapsed, `docker compose restart app` logs a fresh one.

### Projects, webhooks and workers

- **Create projects in the dashboard** (`https://<your domain>` → New project),
  then enter each project's credentials on its Source Control and Project
  Management tabs. A project needs a reviewer credential to be created: type
  it into the dialog's reviewer field, or record one installation-wide default
  for every new project in General Settings → Credentials. The roles each provider needs are in
  [`docs/configuration.md`](./configuration.md).
- **Point webhooks at the domain.** GitHub delivers to
  `https://<your domain>/github/webhook`; the other providers to
  `/bitbucket/webhook`, `/gitlab/webhook`, `/azure-devops/webhook`,
  `/linear/webhook` and `/jira/webhook`, and Trello's is registered with
  `docker compose exec app node dist/cli/index.js pm webhook create --project <id>`.
  For GitHub's events and content type follow
  [Configure the GitHub webhook](./cloudflare-tunnel.md#configure-the-github-webhook)
  with your domain in place of the tunnel URL; every route is listed in
  [`docs/operations.md`](./operations.md).
- **Enroll workers against the domain.** Workers never run on the VPS — each runs
  on an operator's machine with its own SWARM checkout and agent CLIs. The commands
  [`onboarding-worker.md`](./onboarding-worker.md) Step 1 runs on "the admin
  machine" run inside the container here:

  ```bash
  docker compose exec app node dist/cli/index.js users add ada@example.com --name "Ada Lovelace"
  docker compose exec app node dist/cli/index.js users set-password ada@example.com
  docker compose exec app node dist/cli/index.js members add example-project ada@example.com --role member
  ```

  (or, with no shell, add the user under Settings → Users and send them the
  password link it shows; membership can also be granted on the project's Members
  tab). Then follow Steps 2–6 on the
  worker's machine with `--control-plane-url https://<your domain>`.

### Restarts, updates, backup and restore

- **Restarts keep everything.** All state is in named volumes (`postgres-data`,
  `redis-data`, `caddy-data`, `caddy-config`), and every service is
  `restart: unless-stopped`, so `docker compose down` / `up -d`, `restart` and host
  reboots lose nothing. **Never run `docker compose down -v`** — `-v` deletes the
  volumes, the database included.
- **Updating.** Back up first: migrations only go forward (see
  [The published image](#the-published-image)). Then set the new
  `SWARM_IMAGE_TAG` in `.env` and run `docker compose pull && docker compose up -d`.
  On `SWARM_IMAGE_TAG=stable` there is nothing to edit: once a release is cut,
  `docker compose pull app && docker compose up -d app` picks it up.
  The app applies pending migrations at start, before it serves anything, so there
  is no separate migrate step. If the bundle files themselves changed at the new
  ref, fetch them again first.
- **Backup.** The Postgres volume holds everything durable — users, projects,
  runs, and every stored credential:

  ```bash
  docker compose exec -T postgres pg_dump -U swarm -Fc swarm > swarm-$(date +%F).dump
  ```

  Those credentials are encrypted with `CREDENTIAL_MASTER_KEY`, so a dump is only
  usable together with that key: back the key up too, **separately** from the
  dumps. Redis needs no backup — durable dispatch state lives in Postgres and its
  wake-ups are re-published at startup (ADR-002); at most, deliveries still waiting
  in the queue are lost. Caddy's volume holds only certificates, which are
  re-issued if lost.
- **Restore** into a running stack (same `CREDENTIAL_MASTER_KEY` in `.env`):

  ```bash
  docker compose stop app
  docker compose exec -T postgres pg_restore -U swarm -d swarm --clean --if-exists < swarm-<date>.dump
  docker compose start app
  ```

## Failure diagnosis

For a terminal recognised response stall, SWARM labels a task as **likely scope
exceeded** only when it also observed substantial progress and the most recent
successful Planning run recorded multiple independent concerns. A timeout alone
never proves task size: without all of that evidence, SWARM keeps a
provider-oriented diagnosis. Quota, model-capacity, launch/authentication,
worker-shutdown, and user-termination conditions take precedence and retain
their specific recovery guidance in both the board comment and run detail.

**A run whose worker's connection was lost retries itself** (issue #1075). When a
worker drops off the network mid-phase and does not come back within the grace, the
run is not failed for you any more: it shows as **Deferred — automatic retry
scheduled**, with the lost connection as its reason and the time it is due, and the
Queue lists it as "retrying after the worker's connection was lost". It is retried 30
minutes later, at most twice per run, preferring a worker other than the one that
dropped (the dropped one is still used when nothing else can take the phase). **Retry
now** fires that same retry immediately rather than adding a second run, and gives the
run a fresh automatic budget. Only once both automatic retries are spent does the run
settle `failed` with the board comment, as it always did. If one machine keeps
appearing in these, the fleet — not the task — is what needs looking at.

**A run that fails holding preserved work gets one more try on its own** (issue
#1257). When a run stops for good while its work is still preserved — a checkpoint
whose continuation budget is spent, a delivery or session past its retry cap, an
Implementation branch it already provisioned — and the cause is a transient one (a
timeout, stall, usage limit or delivery failure that ran out of retries, or a control
plane that answered a worker with a server error), it is not failed for you yet: it
waits in the Queue as "retrying once automatically after a failure" for 45 minutes
(`pipeline.preservedWorkRetry.delayMinutes`), then continues that work on the machine
holding it, exactly as **Retry now** would. If that attempt also fails, the run
settles `failed` with an error ending `— already retried automatically once, still
failing`. Failures you have to fix yourself (a logged-out CLI, a refused recovery, a
dispatch-gate refusal, any other error) and runs with nothing preserved go to you
straight away, as before. **Retry now** or **Reset** during the cool-down replaces the
pending retry rather than running beside it. `pipeline.preservedWorkRetry.enabled:
false` turns this off for a project.

**You can be told when a failure blocks other work** (issue #1257). Set
`pipeline.failureNotifications.webhookUrl` and SWARM `POST`s a JSON notice whenever a
run fails terminally while other open work items depend on its own — naming the run,
the reason and the waiting items, with a one-line `text` a Slack-style incoming webhook
shows as is. See [`docs/configuration.md`](configuration.md) for the body's fields.

If the dropped worker comes back **before** that retry is due and its phase finishes
successfully (issue #1076), SWARM keeps its result rather than running the phase again:
the run settles `completed` and the next phase starts as if the result had arrived on
time. The Queue briefly shows the dispatch as "settling with the late result of the lost
worker", and the run detail and the run's output say the late result was accepted. While
the retry is still waiting the returning worker is allowed to finish, so its board
writes land and its output appears in the run's output again — the run stays
**Deferred**, but its output shows the phase is still alive (issue #1171). Once the
retry is picked up (or Retry now was pressed) — even if it then has to wait again, say
for an eligible worker — the old attempt is told to stop, anything it still tries to
write is refused, and its output is no longer shown. If the SWARM router restarts while
the retry is waiting it forgets the returning worker: neither its output nor its late
result is kept, and the retry runs when due.

**Is this worker running the fix?** The dashboard's **Workers** screen answers it.
Each machine's daemon declares the SWARM build it is actually running — the commit
its SWARM install root is on — and the per-worker detail view shows it, beside the
build the control plane itself is on. A machine whose build is not the control
plane's carries an `OUTDATED` badge, on its detail view and beside its name in the
roster, so "which workers are behind?" is one glance rather than a question per
machine. The badge says the builds *differ*, not that the machine is behind: the
control plane compares the two commits for equality, and cannot prove a commit it
may never have fetched is an ancestor of its own.

**The version beside it is a label, not the comparison.** A machine also declares the
`version` its SWARM install root's `package.json` carries, and the detail view and
`swarm workers list` show it — `1.2.0 (abc1234)` on the detail view, the bare version
in the list — because that is the name an operator uses for a release. It is *not*
what `OUTDATED` is decided on, and deliberately so: a version only moves when somebody
runs a bump, so between two releases every machine in the fleet reports the same
string whatever code it is running, and an equality check on it would read a drifting
fleet as a current one. The commit answers "is this worker running the fix?"; the
version answers "which release is this?". A machine that has declared no version shows
the commit alone.

A `+dirty` marker on a build means the running code is not exactly the commit it
names — the checkout has uncommitted changes, or its `dist/` build predates HEAD —
so that machine counts as a different build even on the same commit. No badge at
all means there is nothing to compare: the machine declared no build (it has never
connected, or its daemon predates the field), or this control plane cannot read its
own (an install root with no `.git`). An unknown is never reported as stale.

**Is somebody already fixing it?** That is the second badge (issue #978). A machine
with an update request still outstanding — asked, and not yet reported — carries
`UPDATING` beside its name on the roster and on its own page, naming on hover the
build it was asked to move to and when it was asked. It is shown **beside**
`OUTDATED`, never instead of it: the two are different facts, and a machine waiting
on a request is usually both. `OUTDATED` says the machine's build differs and
nobody has acted; `UPDATING` says somebody has, and that until the daemon restarts
and re-declares, the machine is still running the build shown next to it. So the
pair reads as "behind, and already being fixed" rather than as the bare "behind"
both states used to look like. The mark clears itself when the machine reports —
there is nothing to dismiss — and re-targeting a machine replaces the request it
marks. It is read only from the pending request: what a machine last *reported* is
`swarm workers list`'s answer and the **Update history** card's, not this badge's.

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

**A newly opened pull request waits for its checks before Review starts** (issue
#1123). Opening a pull request no longer starts its Review straight away. SWARM
reads the head's checks first, exactly as it does when they complete. A green head
goes to Review. A red one goes to Respond-to-CI, and that head is never reviewed.
A head whose checks are still running, or (under `reviewChecks: 'required'`) have
not registered yet, waits. The Queue shows that wait as a re-check waiting on CI,
for up to the repository's `reviewChecksWaitMinutes`. A repository with no CI on
pull requests sets `reviewChecks: 'if-present'` and is reviewed as soon as the pull
request opens. A Review that was queued, waiting for a worker for example, reads
the checks again when it is picked up, so it never starts on a head that went red
in the meantime. If this repository's CI routinely outlasts the wait, an abandoned
Review run appears that says Review didn't start yet because CI was still running,
naming the repository's Check Wait and its value. The completed-checks event
still reviews the head, and raising the setting removes the noise. A Review abandoned
because the provider never answered says so too, and does not start by itself: use
Retry now once the provider is reachable.

**"Review could not read pull request #… from SCM provider '…'" is the real cause**
(issue #1239). Review reads the pull request — its description, branches and every
comment and review so far — through SWARM before the agent starts, and hands it to
the agent as `swarm_pull_request.md` in the checkout; the agent reads the diff
locally. When that read fails, the run fails with this message and the provider's
own error after the colon, and no agent ever ran — so the cause is the provider's
answer (a credential that cannot read the pull request, an unreachable API), not
the agent. On Bitbucket Cloud and gitlab.com the read is not yet supported, so
Review fails there with this message, ending `not yet supported on …`, until their
readers land.

**A renamed repository produces no failure at all.** Cards stop dispatching and
nothing is marked failed: the router logs `pm-status: work item has no backing SCM
artifact reference` and completes the job as a no-op, because the card's repository
no longer matches the project's. The card itself also carries a one-off SWARM notice
("SWARM could not start …") naming the phase, both repositories and the fix — the
same notice a card with no linked task at all gets, except a GitHub Projects draft
card, which has no backing issue to comment on and stays log-only. Fix the project's
repository first, then re-point each worker machine's checkout — see
[`docs/launchd-worker-autostart.md`](./launchd-worker-autostart.md#a-repository-was-renamed),
which carries the `swarm-repo-renamed` runbook and the ordering constraint that
keeps worker enrollments from being suspended.

**On a project with several repositories, a card that names none of them is not
dispatched.** The router acknowledges the delivery with the reason and logs `Board
card is not routed to exactly one repository`; no run appears. A Jira board routing
by a repository text field (`pm.repositoryField`, issue #1237) also puts a one-off
SWARM notice on the card ("SWARM could not start …") quoting the field's value and
listing the repositories it may name — set the field to one of them exactly and move
the card out of its column and back in. Component- and label-routed boards stay
log-only: check the card carries exactly one repository's `pmRoutingToken`. See
[`docs/configuration.md`](./configuration.md#project-config-swarmconfigjson).

**A Jira-assigned item stopped running on its assignee's worker.** Since issue
#1166 SWARM identifies a Jira assignee by their Atlassian **accountId**, not by
email or display name — Jira Cloud hides the email under profile visibility, and a
display name collides between namesakes and changes on a rename. `jira` links
created earlier with `swarm identities link --handle <email or name>` no longer
match. This is a **deliberate breaking change with no automatic migration**: a
link names no Jira site to resolve it against, and a display name cannot be
resolved to one account without guessing. Until the link is redone, the item takes
the unassigned path and may run on any eligible worker. To fix it, find the `jira`
rows with `swarm identities list`, look up each person's accountId — from their
profile URL `https://<site>/jira/people/<accountId>`, or with
`GET /rest/api/3/user/search?query=<email>` using the project's Jira credentials —
then run `swarm identities link --user <identifier> --provider jira --handle
<accountId>` and remove the stale row with `swarm identities unlink --provider jira
--handle <old handle>` — or do both under **Settings → Users** in the dashboard.
No restart is needed: the next dispatch reads the link.

**A Jira card with no GitHub link runs under its own key.** Since issue #1230 a
`swarm`-labelled Jira card whose remote links name no GitHub *issue* — none at all,
or only a pull request — names its task by its issue key, so moving it to the
status mapped to `planning` / `todo` starts Planning / Implementation on any
source-control provider, Azure DevOps included: the worktree is `task-VT-1538` and
the branch is the repository's branch name pattern filled for `VT-1538` — e.g.
`VT-1538/pierwsza-strona-testowa` under `{issue_key}/{friendly_name}`, or
`issue-VT-1538` on a repository still on the legacy `issue-` prefix (see
[`docs/configuration.md`](./configuration.md#repositories)). For Jira's
Development panel to link the commits and the pull request too, set the
project's commit subject pattern to `{issue_key} {Subject}` (issue #1242; set once
for every repository on the dashboard's Source control tab, issue #1246):
every commit SWARM makes for the card, review and CI fixes included, and the
pull request's title then start with `VT-1538 `. A card **with** a
GitHub issue link keeps that issue's number exactly as before, and a card linked
into a repository the run is not for is still skipped with
`pm-status: work item has no backing SCM artifact reference` rather than falling
back to the key — so to run such a card under its key, remove the stray link.
Linear and Trello cards still need a GitHub issue link.

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

# The worker half of that pull, on a launchd host (macOS): pull and rebuild this
# SWARM installation, then restart every worker agent running it
# — see docs/launchd-worker-autostart.md
swarm-worker-agent update

# Operator identity — sign this CLI in to the control plane over the network
# (needs SWARM_CONTROL_PLANE_URL, not DATABASE_URL, so it works off the host)
npm run swarm -- login
npm run swarm -- login --status
npm run swarm -- login --logout

# Read runs over the same session — no DATABASE_URL, no browser
npm run swarm -- run list --status failed --since 24h
npm run swarm -- run show <run-id>      # headline + failure cause
npm run swarm -- run logs <run-id>      # agent output + captured stdout/stderr
npm run swarm -- run list --project <id> --json   # machine-readable

# Queue and worktrees
npm run queue:clear
npm run worktrees:prune

# The all-in-one control plane: router + API on one port (see above)
npm run serve

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

`swarm run list|show|logs` read runs over the control plane with the cached
`swarm login` session — the dashboard's own run list, run detail, logs and agent
output, with the dashboard's authorization — so they need no `DATABASE_URL` and no
browser. They are the run-diagnosis path on a host with no shell (see
[Running on a VPS behind Caddy](#running-on-a-vps-behind-caddy)); `--json` makes
any of them scriptable. Details: [`docs/cli.md`](./cli.md#swarm-run).

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
