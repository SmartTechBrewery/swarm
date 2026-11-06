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
status` warn when this host has no usable credential. Any other machine needs no
clone at all: in its project checkout, `curl -fsSL https://<installation>/install.sh
| sh` — on Windows, `irm https://<installation>/install.ps1 | iex` in PowerShell —
sets it up as a profile-based worker (below). The full runbook, including
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

**The packaged runtime: a worker without a SWARM clone** (issue #1279). The same
daemon can be built into one self-contained artifact that needs nothing on the
machine but Node ≥ 22 — no SWARM checkout, no `node_modules`, no `tsx`:

```bash
SWARM_BUILD_COMMIT=$(git rev-parse HEAD) npm run build:worker-runtime
# → worker-runtime/swarm-worker-runtime-<version>.tar.gz
```

It unpacks to `swarm-worker-runtime-<version>/` holding a minimal `package.json`, the
`build-info.json` stamp (written only when `SWARM_BUILD_COMMIT` is set — without it
the runtime declares no build), and `dist/transport/connect-entry.mjs`, the daemon
bundled by esbuild. Run it with the variables above exported, or from a directory
holding that `.env`:

```bash
tar -xzf swarm-worker-runtime-<version>.tar.gz
node --env-file-if-exists=.env swarm-worker-runtime-<version>/dist/transport/connect-entry.mjs
```

The env contract is unchanged, since it is the same entrypoint, and
`SWARM_WORKER_REPO_ROOT` still names the project checkouts the agents work in;
`logs/worker.log` is relative to the current directory as before. The tarball is
byte-identical for one tree and commit. Two limits for now: a packaged runtime has no
git checkout of its own, so an update request from the control plane is **refused**
there rather than applied (replace the artifact instead), and `swarm run:worker` and
`swarm-worker-agent` still start a clone — running from a clone is unchanged.

You need not build it yourself: every release publishes it, signed, as GitHub
Release assets, and the published image carries the same files under
`/app/worker-runtime/` (issue #1290) — see
[Verifying the worker runtime](#verifying-the-worker-runtime). The installation
also serves its own runtime to its workers, so a host can fetch it without GitHub
(issue #1280) — see
[Serving the runtime from the installation](#serving-the-runtime-from-the-installation).

**Profile-based workers (launcher)** (issue #1281). A worker can also be started
with no SWARM clone at all, from a *profile*: `~/.swarm/workers/<workerId>/profile.json`
records the control-plane URL of the installation it serves, its credential, and its
checkouts (primary first). The directory is `700` and the file `600`. Then:

```bash
swarm-launcher run <workerId>    # become that worker's daemon
swarm-launcher runtimes          # list the runtime versions installed on this host
```

`run` starts the worker's **selected** version (`selectedVersion` in `state.json`
beside the profile, issue #1302) while it is installed — `swarm workers update`
moves a runtime-based worker by installing a release and selecting it. With no
installed selection it asks the worker's control plane which runtime it serves
(`/worker/runtime/manifest`), installs and verifies that exact version under
`~/.swarm/runtimes/<version>/` when it is missing, and records it in `state.json` as
the selection and the version last started. It then replaces itself with `node <runtime>/dist/transport/connect-entry.mjs`
(spawning it as a child where `process.execve` is unavailable, like `swarm
run:worker`). The daemon gets exactly its usual variables, taken from the profile and
overriding any already in the environment — `SWARM_CONTROL_PLANE_URL`,
`SWARM_WORKER_CREDENTIAL`, `SWARM_WORKER_REPO_ROOT` and `SWARM_LOG_FILE`
(`<profileDir>/logs/worker.log`) — plus `SWARM_WORKER_ID` and, when the launcher
has a trusted key, `SWARM_RUNTIME_TRUSTED_KEY` (that key file's path, never its
contents), which is what lets the daemon install a release it is moved to — and runs in the profile directory; no `.env` is
read. The credential is never printed and never passed as an argument. So two
profiles pointing at two installations on two versions run as two daemons on one
machine, each on its own runtime. A runtime that fails its size, checksum or
signature check is never started: the launcher exits 1 naming the check. When the
control plane cannot be reached (or serves no runtime) and no selection is
installed, the version this worker last started on is used if it is still installed; otherwise the launcher exits 1 with the
reason. A version the worker was **moved to** is on trial until it connects, and
versions no worker uses are removed as workers start — both under **Updating a
runtime-based worker** below.
The signing key it trusts is `deploy/worker-runtime/minisign.pub` under the
launcher's own install; without that file it installs nothing new and still starts
versions already installed. Under launchd, `swarm-worker-agent install --profile <workerId>` runs
it at login as `<root>/bin/swarm-worker.js run <workerId>` (issue #1297, [`launchd-worker-autostart.md`](./launchd-worker-autostart.md),
"Profile-based workers"). On Windows, `swarm-worker agent install --profile <workerId>`
registers a per-user Task Scheduler task that runs it at log on through the
`swarm-worker service-run <workerId>` keep-alive loop, which starts it again whenever
it exits — including after an update (issue #1323,
[`swarm-worker agent`](./cli.md#swarm-worker-agent)).

The launcher runs either from a SWARM build (`npm run build`, then
`bin/swarm-worker.js` or the older `bin/swarm-launcher.js`) or, with **no clone and
no `node_modules`**, from the **launcher package** (issue #1283):

```bash
SWARM_BUILD_COMMIT=$(git rev-parse HEAD) npm run build:worker-launcher
# → worker-runtime/swarm-worker-launcher-<version>.tar.gz
tar -xzf swarm-worker-launcher-<version>.tar.gz
swarm-worker-launcher-<version>/bin/swarm-worker.js run <workerId>   # or: runtimes, --version
```

It unpacks to `swarm-worker-launcher-<version>/` holding a minimal `package.json`,
the `build-info.json` stamp (when `SWARM_BUILD_COMMIT` is set), `bin/swarm-worker.js`,
`bin/swarm-worker-agent`, the launcher bundled into `dist/launcher/swarm-worker.js`,
and the trusted key at `deploy/worker-runtime/minisign.pub` when the checkout it was
built from has one (the build warns when it does not). It needs only Node >= 22.
`swarm-worker run` and `runtimes` are exactly the launcher's commands above, and
`swarm-worker setup`, `login` and `status` set a worker up and check on it (below). The
package's own `bin/swarm-worker-agent install --profile <workerId>` writes an agent
that runs the package's `bin/swarm-worker.js`, so it never refers back to a clone.
Its tarball is byte-deterministic for one tree and commit, and every published image
carries it, with its `.sha256`, under `/app/worker-runtime/` (see "The published
image"), and the installation serves it to new hosts through `/install.sh` (issue
#1312, [Serving the launcher and `install.sh`](#serving-the-launcher-and-installsh)). `swarm run:worker` and `npm run dev:worker` are unchanged.

The operator CLI writes profiles (issue #1296): `swarm workers setup --profile` and
`swarm workers register-and-enroll … --profile` register, enroll and credential the
worker exactly as without the flag, but put its credential, checkouts and
control-plane URL (from `--control-plane-url`, else the environment, else `.env`) in
the profile instead of the per-checkout credential cache. They write no `.env` and
do not refuse one that names another installation, print no worker credential, and
end with the `swarm-launcher run <workerId>` that starts the worker — except that
`setup --profile` autostarts it, through `swarm-worker-agent install --profile
<workerId>` (issue #1297), unless `--no-autostart` is given. They refuse a checkout that already has a cached worker, or that a profile
already serves for the same installation. From then on every `swarm workers`
command that takes a `<worker-id>` (`drain`, `undrain`, `update <worker-id>`,
`set-cli`, `set-scm-credential`, `remove`, `sweep-worktrees`, `enroll`,
`update-enrollment`, `approve`, `consent`) talks to the installation that worker's
profile names, using the session `swarm login --control-plane-url <that URL>`
cached, and refuses an exported `SWARM_CONTROL_PLANE_URL` that names another one
(the checkout's own `.env`, which `npm run swarm --` loads into the environment, is
never held against it).
`add-checkout` / `remove-checkout` in its primary checkout edit the profile, and
`swarm run:worker` there exits 1 naming `swarm-launcher run <workerId>`. A worker
with no profile on the machine is handled exactly as before.

**Migrating a clone-based worker** (issue #1313). A worker set up the older way — a
SWARM clone's LaunchAgent running `swarm run:worker` in its checkout, credential in
the per-checkout cache — moves onto the launcher **as the same worker** with
`curl -fsSL https://<installation>/install.sh | sh -s -- migrate`, run in its
checkout (or `swarm-worker migrate [<checkout>]` once the launcher is installed).
It carries the worker id, credential and extra checkouts from the cache, and the
installation from the clone's LaunchAgent environment or `.env`, into
`~/.swarm/workers/<id>/profile.json`; registers and enrolls nothing, so the
enrollments and the stored operator SCM credentials are the ones the worker had;
installs and verifies the installation's runtime; replaces the clone's agent with a
profile agent running `~/.swarm/launcher`; and deletes the cache entry, so
`swarm run:worker` in the checkout cannot start a second copy. It refuses — with
nothing changed — a checkout with no cached worker, one a profile already serves,
a `--control-plane-url` that names another installation than the clone's, and a
credential the control plane does not accept. If the profile agent cannot be
installed it reinstalls the clone's agent and removes the profile. The restart
interrupts a run in flight (retried, as on any daemon restart), so drain first if
that matters; it then says whether anything else still runs the clone, which is
otherwise no longer needed. A worker run by hand rather than by a LaunchAgent is
given its profile and runtime, and migrate prints the `swarm-worker run <id>` to
start it with once the old daemon is stopped. See
[`swarm-worker migrate`](./cli.md#swarm-worker-migrate).

**With no clone at all, the launcher package writes the profile itself** (issue
#1311). Run in the project checkout the worker is to serve:

```bash
curl -fsSL https://swarm.example.com/install.sh | sh   # installs swarm-worker, then runs setup
# On Windows, in PowerShell: irm https://swarm.example.com/install.ps1 | iex
# …which is, once swarm-worker is installed:
swarm-worker setup --control-plane-url https://swarm.example.com
swarm-worker status            # each profile: login service, runtime, connected or not
swarm-worker agent logs --profile <workerId>   # follow its logs (also install|uninstall|status)
swarm-worker login             # renew the session (URL defaults to the profiles' one)
```

`setup` asks for your email and password (typed without echo; or `--email` and
`--password-file <path|->`) unless a live session for that URL is cached, then for
the project — a numbered list of the projects you can access, read through the
operator API's `workers.enrollableProjects`, and picked for you when there is only
one — the agent CLIs (those on `PATH`), the worker's name, and your source-control
token for the project's provider (typed without echo, or `--scm-token-file
<path|->`; only one of the two files may be `-`). It then registers, enrolls and
credentials the worker with `swarm workers setup --profile`'s own code, writes the
profile, installs and verifies the installation's runtime (a verification refusal
stops it before any login service is installed; an installation serving no runtime
yet is only a warning), installs its login service — a LaunchAgent on macOS, a
per-user "at log on" Task Scheduler task on Windows — and waits up to a minute for the control plane
to see the worker connected. Every question has a flag, so with every flag given it
runs unattended; with no terminal a missing answer fails naming its flag, and
`--yes` accepts the defaults. The password is never printed, logged or stored, and
no `.env` is read or written — only the session token is cached, under
`~/.swarm/operator-sessions/`. An enrollment into a project you do not administer
still needs a project administrator's approval: the worker is installed and started
anyway, connects, and takes work once approved, and `setup` names the step. `status`
exits 0 only when every worker it reports is connected; without a live session it
shows the local view and says to run `swarm-worker login`. See
[`docs/cli.md`](./cli.md#swarm-worker-setup).

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

**One machine can serve two installations** (issue #1215). With the launcher it
needs nothing extra: run the second installation's own `install.sh` (or `install.ps1`) in a project
checkout no other worker holds, and that worker's profile names its installation,
its LaunchAgent is labelled with that installation's host, and each worker's runtime
is updated by its own installation alone; the agent-CLI logins and quotas stay
shared. A clone-based worker instead needs one SWARM clone per installation, because
a clone's `.env` names the control plane it serves and that installation's updates
move the clone itself (ADR-006). Every command run
through a clone's `bin/swarm.js`, `run:worker` included, falls back to
`SWARM_CONTROL_PLANE_URL` in that clone's `.env` when the environment exports none
(issue #1214's precedence). So the second clone's commands and its LaunchAgent
reach the second installation with nothing exported and the first clone's `.env`
untouched, as long as the shell does not export the first installation's URL. A
profile-based worker (`workers setup --profile`, issue #1296) is the alternative
that needs no second clone: its profile, not a clone's `.env`, names the
installation it serves. See
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
on taking work on its *other* CLIs throughout. That instant is the reset the CLI
reported — Codex's `try again at 7:15 PM` or `try again at Nov 4th, 2026 7:35 AM` is
read in the machine's own timezone, since that is the clock Codex prints — even when it
is days away (up to eight), or 30 minutes on when the CLI named no reset it could be
read from. Read it in the two places it is
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

**Updating a runtime-based worker** (issues #1302–#1304,
[`ADR-007`](./decisions/ADR-007-runtime-worker-updates.md)). A profile-based worker
(the one `swarm-launcher run` starts, above) has no install root, so it is asked for
a **signed release version** instead — and the same drain, enrollment, supervision
and reporting apply:

```bash
swarm workers drain <worker-id>
swarm workers update <worker-id> v1.6.0  # or 1.6.0, or the installation's own commit
swarm workers list
swarm workers undrain <worker-id>
```

Its daemon asks its control plane where that release is (the installation's own
artifact, or the publisher's GitHub Release — see
[Serving the runtime from the installation](#serving-the-runtime-from-the-installation)),
downloads and verifies it into `~/.swarm/runtimes/<version>/` (one download per host
however many of its workers ask), records it as the worker's selected version in
`state.json`, reports `applied` and exits for the launcher to start it on that
version. A branch, another commit, or a version with no signed release is `refused`;
a failed download or signature check is `failed` and leaves the worker where it
was. So is a release whose runtime predates launcher-driven verification (its
`build-info.json` declares no `launcherProtocol`): its daemon could never prove
itself, so the launcher would abandon it after a few healthy starts. No other worker
on the host is waited for or disturbed. There is no ancestor check and no dirty-root
refusal: the publisher's signature, verified against the launcher's own trusted key,
replaces the first, and an installed runtime is never modified, so the second has
nothing to protect — an administrator can move a worker to any signed release, older
ones included, and to nothing unsigned. ADR-007 records that trust model; a clone
keeps ADR-006's.

*Rollback* (issue #1303). A version the worker was moved to is on trial until a
daemon running it connects: `state.json` holds a pending-verification record, `run`
counts each start of that version *before* handing its process over, and the
daemon's first session clears the record and makes the version the worker's
`lastKnownGoodVersion`. After three starts in a row without a session
(`MAX_FAILED_STARTS`) — or at once, when the control plane rejects the daemon's
handshake outright — `run` logs an error, selects the version the worker was moved
from and starts that instead. If that version is no longer installed it exits 1 and
keeps the record, so the worker stays down and says why rather than crash-looping on
the version that never connected. It reads like a clone's return to its last known
good build: the worker comes back reporting its previous build, which also halts a
staged rollout. The daemon logs the promotion or the rejection to
`<profileDir>/logs/worker.log`; the launcher's counted starts and the return
(`giving up on v<version>, which never connected …`) are in its own output, which
under launchd is `swarm-worker-agent logs --profile <worker-id>`.

*Cleanup* (issue #1304). Every `run`, once it has recorded its start, and every
daemon, right after its first session promotes a version, removes each installed
version that no worker's `state.json` under `~/.swarm/workers/` names — as its
selected, last-run or last known good version, or as either side of a pending
verification — and `run` logs each removal. So the version a worker runs and the one
it would go back to are always kept. A version installed within the last hour is
kept, so is one being installed right now, and nothing at all is removed while any
worker's state cannot be read. The removal runs under a store-wide lock
(`~/.swarm/runtimes/.locks/.store.lock`) that recording a selection also takes, so a
version cannot be selected while it is being removed. It is best effort: a failure
is logged and never stops a start. There is no prune command and no retention
setting; `swarm-launcher runtimes` lists what is left. See
[`docs/onboarding-worker.md`](./onboarding-worker.md#updating-a-runtime-based-worker)
for what each step looks like on the host.

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

**After an upgrade the control plane starts that rollout itself** (issue #1284). With
the global setting `workers.followInstallationVersion` on — the default, on the
Settings screen's **Fleet** tab — a control plane that has been up for two minutes on a
version its workers are not on starts exactly the staged installation-wide rollout
**Update all workers** would, to its own commit, recorded under the first instance
administrator. It does so at most once per version — counting a rollout you started
yourself as that version (`v1.6.0` or `1.6.0`) or its full or abbreviated commit; a
branch or another tag names no build it can check. A restart on the same version
starts nothing, a rollout in progress is not duplicated, and a **halted one is not
retried** — the readout above is where it, and every machine that could not take the
build, is reported. The two minutes are for the fleet to reconnect after the restart;
a rollout already moving blocks it until that one finishes. `swarm workers update
--all`, the button and the commands below keep working as before; turn the setting
off if you would rather move the fleet by hand, or to hold it on another build than
the installation's. See [`configuration.md`](./configuration.md#global-settings-app_settings).

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

- **Which commit is this?** The image has no `.git`, so CI stamps its release
  version and source commit into `/app/build-info.json` at build time (the
  `SWARM_BUILD_COMMIT` build arg). The running control plane reports that as its
  own build — the Workers screen compares every machine against it — and the image
  label carries the same commit:
  `docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' ghcr.io/smarttechbrewery/swarm:<tag>`.
  An image you build yourself without `--build-arg SWARM_BUILD_COMMIT=<sha>`
  declares no build, so the Workers screen shows no `OUTDATED` badges against it.
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
  `stable` and publishes the GitHub release, and checks that the release carries
  the signed worker runtime (below). A release is one image for every
  installation; deploying it is per installation, with
  `npm run deploy -- <target>` (`bin/swarm-deploy`), or by naming the targets on
  the release (`npm run release -- <target>...`). A target is a name the
  maintainer picks and defines as `SWARM_DEPLOY_<TARGET>_SSH`, `_URL` and
  `_COMMAND` in the environment or the checkout's gitignored `.env`, never in the
  repository; the deploy runs the command on the server over SSH, with
  `{version}` in it replaced by `X.Y.Z` for a server that pins its image tag, and
  checks that the new version is live. The release checks every target it names is defined
  before it pushes anything. It warns first when `deploy/vps` changed since the previous
  tag, because the server's files may then need updating. A tag pushed by hand (`git tag vX.Y.Z && git push origin vX.Y.Z`) builds
  and moves `stable` the same way, but deploys nothing. A `vX.Y.Z-rc.N`
  pre-release does not move `stable`.
  The package has to be made **public** once by an org admin (GitHub → the org's
  Packages → `swarm` → Package settings → Change visibility → Public); until then
  an anonymous pull fails.
- **The worker runtime** (issue #1290): the same workflow builds the
  [packaged runtime](#the-worker) once per run, writes its `.sha256` and signs it
  with minisign, then ships those three files in the image under
  `/app/worker-runtime/` and, on a `v*` tag, attaches them to the GitHub Release —
  one build feeds both, so they are byte-identical. The workflow creates that
  release itself (with `--generate-notes`; a `-` tag is marked a pre-release), so
  a tag pushed by hand gets one too, and `npm run release` only checks that it
  carries all three files. A `v*` tag **fails** when the signing secret or the
  committed public key is missing; a push to `main` then ships the runtime
  unsigned, with a warning. Beside them the same step builds the
  [launcher package](#the-worker) (issue #1283),
  `swarm-worker-launcher-<version>.tar.gz`, and its `.sha256`; those two go into
  the image only — never to the Release, and unsigned (the launcher package carries
  the trusted key itself). A plain `docker build .` ships an empty
  `/app/worker-runtime`.

#### Verifying the worker runtime

The Release assets for `vX.Y.Z` are `swarm-worker-runtime-X.Y.Z.tar.gz`, its
`.tar.gz.sha256` (`sha256sum` format) and its `.tar.gz.minisig`, downloadable
without signing in. The public key is committed at
`deploy/worker-runtime/minisign.pub`; take it from a checkout you trust rather than from the same download, since a key
fetched beside the artifact proves nothing about either.

```bash
base=https://github.com/SmartTechBrewery/swarm/releases/download/vX.Y.Z
f=swarm-worker-runtime-X.Y.Z.tar.gz
for x in "$f" "$f.sha256" "$f.minisig"; do curl -fLO "$base/$x"; done
sha256sum -c "$f.sha256"              # macOS: shasum -a 256 -c "$f.sha256"
minisign -Vm "$f" -p minisign.pub     # prints the trusted comment: swarm-worker-runtime X.Y.Z <commit>
```

The image holds the same three files for its own version (plus the launcher
package and its `.sha256`):
`docker create --name rt ghcr.io/smarttechbrewery/swarm:vX.Y.Z && docker cp rt:/app/worker-runtime . && docker rm rt`.
The signature covers the tarball alone; its trusted comment names the version and
the commit it was built from. The worker launcher's runtime store
(`src/launcher/runtime-store.ts`, issue #1281) checks both automatically before it
installs a runtime — the SHA-256, the signature against the key it trusts, and that
the trusted comment names the version and commit the installation asked for — and
refuses to install anything when it holds no trusted key. `swarm-launcher run`
calls it (see [The worker](#the-worker), "Profile-based workers"); the daemon and
the control plane do not check the signature.

#### Serving the runtime from the installation

A control plane serves the worker runtime for **its own build** — the files its
image carries under `/app/worker-runtime/` — so a worker host gets it from the
installation it is registered with: no GitHub account, no GitHub access, and the
same answer for a private fork or a self-built image (issue #1280). Two routes, on
the same URL as `SWARM_CONTROL_PLANE_URL`:

| Route | Auth | Answers |
| --- | --- | --- |
| `GET /worker/runtime/manifest` | none | The version the installation wants workers on, its commit, and the artifact's name, download `url`, size, SHA-256 and full `.minisig` text. |
| `GET /worker/runtime/manifest?version=<v>` | none for its own version or a release already located; otherwise `Authorization: Bearer`, as below (`401` without it) | The same shape for the signed release `v<v>` (`1.2.3` or `v1.2.3`). Its own version answers as above; any other is located on the publisher's GitHub Release, with an absolute `url` there. |
| `GET /worker/runtime/artifacts/<name>` | `Authorization: Bearer` — a worker credential, or an operator token from `swarm login` | The tarball itself. |

The manifest is open because a first install has no credential yet, and it holds
nothing secret: a version, a commit, a checksum and a public signature. The tarball
is the installation's code, so it needs a credential — an existing worker uses its
own, and a new host uses the operator token from `swarm login`, the step before
registering it. A missing or unknown bearer is a `401`, checked before anything
else. `SWARM_SINGLE_USER_MODE` does not open it. Both routes send
`Cache-Control: private, no-store`, so a proxy or Cloudflare never caches either.

```bash
curl -s https://swarm.example.com/worker/runtime/manifest
# {"available":true,"version":"X.Y.Z","commit":"…","artifact":{"name":"swarm-worker-runtime-X.Y.Z.tar.gz",
#  "url":"/worker/runtime/artifacts/swarm-worker-runtime-X.Y.Z.tar.gz","size":…,"sha256":"…"},
#  "signature":{"format":"minisign","minisig":"untrusted comment: …"}}
curl -fO -H "Authorization: Bearer $SWARM_WORKER_CREDENTIAL" \
  https://swarm.example.com/worker/runtime/artifacts/swarm-worker-runtime-X.Y.Z.tar.gz
```

`url` is resolved against the control-plane URL, so it is relative when the
installation serves the file itself and absolute for a release it only locates
(below). Verify the download against the manifest's `sha256` and, with the public
key you trust, its `minisig` ([above](#verifying-the-worker-runtime)).

**Another signed release is located, never served (issue #1282).** Asked for
`?version=<v>` other than its own, the control plane looks up the GitHub Release
`v<v>` of the publisher, `SmartTechBrewery/swarm` (a constant, not a setting: the
launcher trusts this publisher's key, so no other source could produce a runtime
that verifies), and answers that release's `swarm-worker-runtime-<v>.tar.gz`
download URL and size, the SHA-256 from its `.sha256`, the whole `.minisig`, and
the commit named in the signature's trusted comment. The control plane fetches only
those two small files; the worker downloads the tarball from GitHub directly, with
no credential. `"available": false` names the reason for a version that is not a
valid version, a release that does not exist, one that predates the published
runtime, one with no checksum or no signature, or a signature naming another
version. The artifact route still serves only the installation's own tarball. A
located release is remembered for the process's life (a published release is
immutable; up to 32 versions), and a failed lookup for 5 minutes, so a release
published after the first ask is found once that passes. Two limits: the lookup is
anonymous, so it shares GitHub's unauthenticated API rate limit (60 an hour per
control-plane IP, answered as `"available": false` saying so), and a private fork's
releases cannot be located at all. Because of that budget, only an authenticated
caller (a worker credential, or an operator token from `swarm login`) makes the
control plane reach GitHub: a `?version=` it has not already answered is `401`
without one, while a remembered answer, its own version and the plain manifest
stay open, so nobody who merely reaches the URL can spend the budget. Trust does not move:
whatever the manifest names, the worker installs only bytes its own trusted key
verifies.

```bash
curl -s -H "Authorization: Bearer $SWARM_WORKER_CREDENTIAL" \
  'https://swarm.example.com/worker/runtime/manifest?version=X.Y.Z'
# {"available":true,"version":"X.Y.Z","commit":"…","artifact":{"name":"swarm-worker-runtime-X.Y.Z.tar.gz",
#  "url":"https://github.com/SmartTechBrewery/swarm/releases/download/vX.Y.Z/swarm-worker-runtime-X.Y.Z.tar.gz",…},…}
```

**Only the installation's own, signed runtime is served.** With no `?version=`, the manifest says
`"available": false` with a `reason`, and the download answers `404` with the same
reason, unless all of these hold: the installation declares a version and a commit
(its `build-info.json` stamp or its checkout); the tarball for *that* version is
present; its `.sha256` matches its bytes; a `.minisig` is present; and that
signature's trusted comment names the same version and commit. So an image built
before #1290, a plain `docker build`, a `main` build made without the signing key (unsigned), or a
dev checkout's locally built `worker-runtime/` all say so plainly, and a tarball for
any other version is never served. The answer is read once, on the first request,
and logged (`Serving the worker runtime …`, or `Not serving a worker runtime` with
the reason); restart the control plane after changing the files. The control plane
checks the checksum and the trusted comment but not the signature itself — the worker
host does that, against the key it trusts. Nothing in the daemon fetches from these
routes. The launcher's runtime store (issue #1281) does: it reads the manifest,
downloads the artifact (sending the bearer only when the artifact URL is on the
control plane's own origin), verifies it, and installs it read-only and atomically
under `~/.swarm/runtimes/<version>/`, side by side with every other version, and
`swarm-launcher run` starts a profile-based worker from there.

#### Serving the launcher and `install.sh`

The installation also serves the **launcher package** for its own build — the
`swarm-worker-launcher-<version>.tar.gz` and `.sha256` its image carries beside the
runtime — and an installer for it, so a new host is set up with one command and no
GitHub access (issue #1312; `install.ps1` for Windows since issue #1324, below):

```bash
cd ~/code/my-project          # the checkout the worker is to serve
curl -fsSL https://swarm.example.com/install.sh | sh
curl -fsSL https://swarm.example.com/install.sh | sh -s -- --email me@example.com --yes   # flags go to setup
curl -fsSL https://swarm.example.com/install.sh | sh -s -- login                        # another subcommand
```

| Route | Auth | Answers |
| --- | --- | --- |
| `GET /install.sh` | none | A POSIX `sh` script (`text/x-shellscript`) with the installation's base URL baked in. |
| `GET /install.ps1` | none | The same installer in PowerShell (`text/plain`), for Windows; base URL baked in the same way. |
| `GET /worker/launcher/manifest` | none | `{"available":true,"version","file","size","sha256"}` for the installation's own package, or `{"available":false,"reason"}`. |
| `GET /worker/launcher/artifacts/<file>` | none | The package itself; only the exact file the manifest names. |

The script refuses, naming the prerequisite, when Node.js >= 22, git, curl or tar is
missing; downloads the manifest and the package from the same installation into a
temporary directory under `~/.swarm/` and checks the SHA-256 (`sha256sum` or
`shasum -a 256`), installing nothing on a mismatch; unpacks it to
`~/.swarm/launcher.new` and swaps it into `~/.swarm/launcher`, keeping the previous
launcher until the swap succeeds; links `~/.swarm/bin/swarm-worker` (and
`~/.local/bin/swarm-worker` when `~/.local/bin` is on `PATH`) to
`~/.swarm/launcher/bin/swarm-worker.js`, printing a `PATH` hint when neither is on
`PATH`; and then runs `swarm-worker setup --control-plane-url <installation>` with the
terminal as its stdin (under `curl | sh` stdin is the script). A first argument after
`sh -s --` that is not a flag names another subcommand to run instead of `setup`;
every other argument is passed through, so with all of setup's flags given it runs
unattended. The subcommand must accept `--control-plane-url` (`setup` and `login`
do). Re-running it upgrades the launcher in place, and a LaunchAgent `setup`
installed keeps working, since its plist names the stable
`~/.swarm/launcher/bin/swarm-worker.js`.

**On Windows** the installer is `install.ps1`, run in PowerShell (Windows PowerShell
5.1 or pwsh 7) in the project checkout:

```powershell
irm https://swarm.example.com/install.ps1 | iex
& ([scriptblock]::Create((irm https://swarm.example.com/install.ps1))) --email me@example.com --yes   # flags go to setup
& ([scriptblock]::Create((irm https://swarm.example.com/install.ps1))) login                        # another subcommand
```

`irm … | iex` takes no arguments, so the scriptblock form is PowerShell's
`sh -s --`. It takes the same steps with the same messages: it refuses when Node.js >= 22,
git or tar is missing (`tar.exe` ships with Windows 10 1803 and later and is
preferred over any other `tar` on `PATH`); downloads with `Invoke-WebRequest` (TLS
1.2 forced on Windows PowerShell 5.1) and checks the package with `Get-FileHash
-Algorithm SHA256`, installing nothing on a mismatch; swaps it into
`%USERPROFILE%\.swarm\launcher` the same way — `%USERPROFILE%`, the home Node's
`os.homedir()` and so the launcher's profiles use, not Windows PowerShell 5.1's
`$HOME`, which a redirected home folder moves to another drive; writes
`%USERPROFILE%\.swarm\bin\swarm-worker.cmd` (`@node
"%USERPROFILE%\.swarm\launcher\bin\swarm-worker.js" %*`) and adds
`%USERPROFILE%\.swarm\bin` to the **user** `PATH` when it is missing — terminals opened afterwards run
`swarm-worker` by name, and the current session's `$env:Path` is updated too; then
runs `swarm-worker setup --control-plane-url <installation>`. A refusal is a thrown
`swarm install: …` error rather than an `exit`, which under `irm | iex` would close
the window, and a subcommand that exits non-zero is reported the same way. A Task
Scheduler task `setup` installed names the same stable
`~\.swarm\launcher\bin\swarm-worker.js`, so a re-run upgrades it at its next start.

The base URL in the script is `WEBHOOK_CALLBACK_BASE_URL` when set, otherwise the
request's `Host` with `X-Forwarded-Proto`. Set it on an installation behind a proxy
that rewrites `Host`. Every route here is public, because the installer holds no
credential yet and the package holds nothing secret (the launcher and the public
key). The launcher is availability-checked like the runtime — the installation's own
version, present, matching its `.sha256`, read once on the first request — but **it
is not signed**: installing it trusts the installation over TLS, exactly as any
`curl | sh` does, while every runtime it installs is still minisign-verified against
the key the package carries
([ADR-007](./decisions/ADR-007-runtime-worker-updates.md)). The launcher routes send
`Cache-Control: private, no-store` and both installers send `no-store`. Behind Caddy
nothing needs configuring; a path-scoped Cloudflare Tunnel needs `^/install\.sh$` and
`^/install\.ps1$` routed to the router ([`cloudflare-tunnel.md`](./cloudflare-tunnel.md)).

#### Rotating the runtime signing key

The private key exists only as the `SWARM_RUNTIME_SIGNING_KEY` Actions secret,
unencrypted, because the secret store is its protection; the public half is
`deploy/worker-runtime/minisign.pub`. Setting them up the first time is the same
procedure:

1. Generate a new pair on a trusted machine, without a password:
   `minisign -G -W -p minisign.pub -s minisign.key`.
2. Replace `deploy/worker-runtime/minisign.pub` with the new `minisign.pub` in a
   pull request, and merge it.
3. Store the whole of `minisign.key` as the repository secret:
   `gh secret set SWARM_RUNTIME_SIGNING_KEY --repo SmartTechBrewery/swarm < minisign.key`.
   Then delete `minisign.key`; nothing else needs it.
4. Cut a release. The workflow verifies its signature against the committed public
   key, so a secret that does not match the key fails the build before anything
   is published.

Between steps 2 and 3, `main` builds fail at the signing step, since the old
secret no longer matches the new key — do step 3 as soon as step 2 merges. Older releases stay
verifiable only against the public key they were signed with, which stays in git
history (`git show vX.Y.Z:deploy/worker-runtime/minisign.pub`). If the private key
is **compromised**, delete the secret at once, so nothing more is signed with it,
then rotate and cut a new release; tell hosts to stop trusting the old key, since
anything signed with it — old releases included — can no longer be told apart from
a forgery.

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
provider APIs). A host without inbound `80`/`443` runs the bundle
[behind a Cloudflare Tunnel](#behind-a-cloudflare-tunnel-instead-of-caddy) instead,
and needs no DNS record of its own.

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
  on an operator's machine, in its checkout of the project, with its own agent CLIs.
  The commands [`onboarding-worker.md`](./onboarding-worker.md) Step 1 runs on "the
  admin machine" run inside the container here:

  ```bash
  docker compose exec app node dist/cli/index.js users add ada@example.com --name "Ada Lovelace"
  docker compose exec app node dist/cli/index.js users set-password ada@example.com
  docker compose exec app node dist/cli/index.js members add example-project ada@example.com --role member
  ```

  (or, with no shell, add the user under Settings → Users and send them the
  password link it shows; membership can also be granted on the project's Members
  tab). Then, on the worker's machine and in its project checkout, run
  `curl -fsSL https://<your domain>/install.sh | sh` — on Windows,
  `irm https://<your domain>/install.ps1 | iex` in PowerShell (onboarding Steps 2–3).

### Behind a Cloudflare Tunnel instead of Caddy

Caddy needs inbound `80` and `443` on a public address. A host that has neither —
a shared-IPv4 LXC VPS such as [Mikrus](https://mikr.us), which forwards only a few
high ports to each server, or a machine behind NAT — can run the same bundle with
`cloudflared` in Caddy's place. The tunnel dials out to Cloudflare, Cloudflare
terminates HTTPS for your domain, and every request (the `/worker/stream`
WebSocket upgrade included) reaches `app:3000` over the `edge` network. No service
publishes a port at all.

It is an opt-in override, `deploy/vps/docker-compose.tunnel.yml`: a plain
`docker compose up -d` never reads it, so a Caddy install is unaffected.

1. **Create the tunnel** in the Cloudflare Zero Trust dashboard (Networks →
   Tunnels → Create a tunnel → Cloudflared) for a domain on Cloudflare DNS, and
   copy its token. Give it **one** public hostname — your domain, no path — with
   service `http://app:3000`. The all-in-one app needs no path rules, so an
   existing tunnel that splits paths between a router and an API server is
   collapsed to that single entry.
2. **Fetch the override** beside the other three files (or `scp` it from a
   checkout):

   ```bash
   curl -fsSLO "$base/docker-compose.tunnel.yml"
   ```

3. **Add two lines to `.env`** (both are in `.env.example`, commented out):

   ```bash
   COMPOSE_FILE=docker-compose.yml:docker-compose.tunnel.yml
   CLOUDFLARE_TUNNEL_TOKEN=<the tunnel's token>
   ```

   `WEBHOOK_CALLBACK_BASE_URL` is still `https://<your domain>` — the tunnel's
   hostname — and no DNS record needs to point at the server: the tunnel's own
   `CNAME` does that.

Everything else in this section reads the same: `docker compose up -d`,
`docker compose ps` and `docker compose logs app` pick up the override from
`COMPOSE_FILE`. `cloudflared` starts only once the app is healthy, and Caddy is
kept out of the default set by a profile, so it neither starts nor binds a port.

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

**An Implementation that found nothing to change says so, and leaves In progress**
(issue #1335). When the implementer agent finishes without changing any repository
file — every change in its worktree is a SWARM hand-off artifact — the run fails at
once with an error starting `Implementation found nothing to deliver`, is not
retried, and SWARM moves the card to **Backlog**, where nothing starts it again by
itself. The board comment carries the **nothing to deliver** diagnosis: the work is
most likely already on the base branch (a re-queued card whose pull request was
merged, or whose change landed some other way), or the card's acceptance criteria
are already met. Update the card's scope if work remains, or close it; re-running it
as it stands finds nothing to change again. If the move to Backlog itself failed,
the error says so, and the card has to be moved out of In progress by hand. Its
repository's WIP slot is freed by the periodic slot sweep within about five minutes
of the card reaching Backlog.

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

**A GitHub (or other provider) outage defers a run instead of failing it** (issue
#1274). When the SCM or PM provider answers one of a phase's calls with a server error
— an HTTP 5xx, or GitHub's GraphQL "Something went wrong while executing your query" —
anywhere in the phase, not only while it delivers (the pickup move to "In progress",
Planning's card moves, a read before the agent starts), the run is deferred rather
than failed. It waits in the Queue as "retrying after the SCM/PM provider was
unavailable", with a reason starting `Provider unavailable:` and the provider's own
message, and is retried no sooner than six minutes later on the ordinary deferred-retry
budget (six attempts). On a federated worker the control plane answers such a delivery
call with a `502` that says so, and a worker also reads a bare `500`/`502`/`504` from
the control plane the same way. A refusal from the provider (`401`/`403`/`404`/`422`)
still fails the run at once, and a provider that stays down through every retry fails
it with an error ending `— the provider stayed unavailable through N deferred retries;
retry budget spent`. Deploy the control plane before (or with) the workers: an older
control plane does not recognise the new deferral and settles it as failed, as before.

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
Each machine's daemon declares the SWARM build it is actually running and the
per-worker detail view shows it, beside the build the control plane itself is on.

**What a build's identity is, and where it comes from.** A build is its release
version plus the source commit it was built from, and a `dirty` flag. Every SWARM
process — a worker daemon or the control plane — reads its own from one of two
places (`src/lib/build-identity.ts`):

- **A clone** (its SWARM install root is the top of its own git checkout) reads git:
  HEAD is the commit, `package.json` the version, and `dirty` is set for
  uncommitted changes or a `dist/` build older than HEAD. This always wins where it
  applies, so a developer checkout is still marked as not a clean release.
- **The published image, or a packaged install** with no checkout of its own reads
  `build-info.json` beside its `package.json` — the version and commit stamped at
  build time by `bin/write-build-info.js` (CI passes the commit); the packaged
  worker runtime ([The worker](#the-worker)) carries one the same way. A stamped
  build is never dirty. An install with neither declares no build. A machine whose build is not the control
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
own (an install root with neither a checkout of its own nor a `build-info.json`
stamp — an image built without the commit build arg). An unknown is never reported
as stale.

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

**"Respond-to-review could not read review … on pull request #… from SCM provider
'…'" is the same kind of cause** (issue #1240). Respond-to-review reads the pull
request and the one review it answers — its summary body and inline comments —
through SWARM before the agent starts, and hands both to the agent in
`swarm_pull_request.md`. When either read fails, the run fails with this message
and the provider's own error after the colon, and no agent ran. On Bitbucket Cloud
and gitlab.com it ends `not yet supported on …`; on Azure DevOps a message saying
the pull request has no SWARM request-changes findings thread means the verdict
thread the review id names was deleted or resolved away.

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
every commit SWARM makes for the card, review and CI fixes and Resolve conflicts'
merge commits included (issue #1332), and the pull request's title then start
with `VT-1538 `. A card **with** a
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

# A profile-based worker (no SWARM clone; see "Profile-based workers" above):
# register it into ~/.swarm/workers/<worker-id>/profile.json, then start it
npm run swarm -- workers setup --profile --control-plane-url <url>
swarm-launcher run <worker-id>
# …or, from the launcher package with no clone at all, in the project checkout:
curl -fsSL <url>/install.sh | sh          # install swarm-worker from the installation, then setup
irm <url>/install.ps1 | iex               # the same on Windows, in PowerShell
swarm-worker setup --control-plane-url <url>
swarm-worker status

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

The same session also connects an **MCP client** — Claude Code, for one — to the
control plane: the router serves an MCP server at `/operator/mcp` whose tools call
the dashboard's own procedures as you, so an assistant session can read runs,
their failure causes and their agent output, a project's whole pipeline state in
one call, and a task's dispatch history, with exactly your dashboard access.
How to connect one, and the tool catalogue: [`docs/mcp.md`](./mcp.md).

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
- [`docs/mcp.md`](./mcp.md) — the operator MCP server at `/operator/mcp`:
  connecting an MCP client to a hosted control plane, and its tools
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
  user + worker with the installation's `install.sh`, local or remote; migrating a
  clone-based worker; and the clone path for SWARM developers
- [`docs/launchd-worker-autostart.md`](./launchd-worker-autostart.md) — running a
  worker from a launchd agent on macOS instead of a terminal tab, and the
  `swarm-repo-renamed` runbook for a renamed project repository
- [`docs/launchd-api-autostart.md`](./launchd-api-autostart.md) — the same for the
  API server (which also serves the dashboard), its `reload`/`restart` update flow,
  and why the API is a host process rather than a Compose service
- [`docs/github-projects-v2-api.md`](./github-projects-v2-api.md) —
  Projects v2 API and webhook details
- [`docs/decisions/`](./decisions/) — architecture decision records, among them
  [`ADR-006`](./decisions/ADR-006-unconditional-worker-updates.md) (what bounds a
  clone-based worker's update) and
  [`ADR-007`](./decisions/ADR-007-runtime-worker-updates.md) (the signed-release
  trust model that replaces parts of it for runtime-based workers)
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
