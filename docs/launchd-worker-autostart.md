# Autostarting a worker with launchd (macOS)

The worker is a foreground, operator-owned process: `npm run dev:worker` — or
[`swarm run:worker`](./cli.md#swarm-runworker) — occupies a terminal tab for as
long as the machine is meant to accept work, and a closed tab or a reboot silently
takes the machine out of the pool. `swarm-worker-agent` installs a launchd
**LaunchAgent** per checkout so the same daemon starts at login instead.

It adds no supervision model of its own: the agent runs `swarm run:worker`, which
is still the launcher described in [`docs/cli.md`](./cli.md#swarm-runworker), with
the same env contract, handshake and checkout lock. All it decides is *where that
command runs* and *what environment launchd hands it*.

macOS only — launchd is. On Linux the equivalent is a `systemd --user` unit running
the same command with `WorkingDirectory=` set to the checkout; the script says so
rather than half-working.

A worker that does not exist yet does not need this command run by hand:
[`swarm workers setup`](./cli.md#swarm-workers) registers and enrolls it from its
checkout and ends by running `swarm-worker-agent install` there (`setup --profile`:
`swarm-worker-agent install --profile <worker-id>`, see
[Profile-based workers](#profile-based-workers)).

## Usage

```bash
swarm-worker-agent install   [<checkout>]   # write the agent and start it
swarm-worker-agent uninstall [<checkout>]   # stop it and remove the agent
swarm-worker-agent status    [<checkout>]   # loaded? pid? last exit code?
swarm-worker-agent logs      [<checkout>]   # tail this checkout's stdout + stderr
swarm-worker-agent update    [<checkout>]   # pull + rebuild this install, restart its agents

swarm-worker-agent install   --profile <worker-id>   # the same for a profile-based worker
swarm-worker-agent uninstall --profile <worker-id>
swarm-worker-agent status    --profile <worker-id>
swarm-worker-agent logs      --profile <worker-id>
```

`<checkout>` is the repository checkout the worker was registered for and defaults
to the current directory. It is **the project repository the worker runs against**
— the one [`swarm workers register-and-enroll`](./onboarding-worker.md) was run
from — not this repository, unless a worker happens to be enrolled on SWARM itself.
A machine running workers for several repositories installs one agent per checkout;
they are independent and carry no shared state.

**A worker holding several checkouts still gets one agent** (issue #1059), installed
in its **primary** checkout — the one it was registered in. The agent runs
`swarm run:worker` there, which starts the daemon with every extra checkout the
worker's cache entry records (`swarm workers register --extra-checkout` /
`swarm workers add-checkout`), so that one agent serves all of them. **Never install
an agent in an extra checkout**: it has no cache entry of its own, so the agent
would fail with "no worker registered for this checkout" on every `KeepAlive`
restart. After `add-checkout` or `remove-checkout`, restart the primary checkout's
agent (`swarm-worker-agent install` again, or `update <checkout>`) so the daemon
declares its new set of repositories.

The command ships in this package's `bin`, so a machine that has SWARM installed
(or `npm link`ed) already has it on `PATH` next to `swarm`.

The agent runs the `swarm` CLI **of the installation the installer belongs to**
(`<installation>/bin/swarm.js`), never whichever `swarm` comes first on `PATH`
(issue #1213) — and that installation's `.env` is where its
`SWARM_CONTROL_PLANE_URL` comes from. On a Mac with two SWARM clones, run the
intended clone's own installer: `<clone>/bin/swarm-worker-agent install <checkout>`,
or `swarm workers setup` through `node <clone>/bin/swarm.js`. A bare
`swarm-worker-agent` on `PATH` is the linked clone's. Re-running `install` from the
same clone keeps the agent on it.

Serving a second installation from one machine is laid out end to end in
[`onboarding-worker.md`](./onboarding-worker.md#serving-a-second-installation-from-the-same-machine).

| What | Where |
| --- | --- |
| Agent | `~/Library/LaunchAgents/pl.smarttechbrewery.swarm.worker.<basename>.<hash8>.plist` |
| Logs | `~/Library/Logs/pl.smarttechbrewery.swarm.worker.<basename>.<hash8>.log` (+ `.error.log`) |
| Credential | `~/.swarm/worker-credentials/<sha256 of the checkout realpath>/credential.json` |
| Checkout lock | `~/.swarm/checkout-locks/<that same sha256>/owner.json` — the running daemon's own record of which checkout it serves |

`<hash8>` is the first eight characters of that same sha256, so two checkouts
sharing a basename (`~/work/api` and `~/oss/api`) still get distinct labels.

## Profile-based workers

A **profile-based** worker (`swarm workers setup --profile`, issue #1296) is started
by `swarm-launcher run <worker-id>` from its profile, `~/.swarm/workers/<worker-id>/
profile.json`, rather than by `swarm run:worker` in a checkout
([`MANUAL.md`](./MANUAL.md), "Profile-based workers"). `--profile <worker-id>`
installs that under launchd instead (issue #1297), and `setup --profile` ends by
running it.

| What | Where |
| --- | --- |
| Agent | `~/Library/LaunchAgents/pl.smarttechbrewery.swarm.worker.<host>.<worker-id>.<hash8>.plist` |
| Logs | `~/Library/Logs/<that label>.log` (+ `.error.log`) — launchd's capture of the launcher's own output; the daemon's log is `~/.swarm/workers/<worker-id>/logs/worker.log` |
| `ProgramArguments` | `<node> <installation>/bin/swarm-worker.js run <worker-id>` (an agent installed before issue #1283 names `bin/swarm-launcher.js`, which still works) |
| `WorkingDirectory` | `~/.swarm/workers/<worker-id>` |

- **The label names the installation.** `<host>` is the host (and any port) of the
  profile's `controlPlaneUrl`, with every character outside `[A-Za-z0-9_-]` turned
  into `-` (`swarm-example-com`), and `<hash8>` is the first eight characters of the
  sha256 of the URL and the worker id together. So `launchctl list | grep swarm.worker`
  shows which installation each agent serves, and two installations' workers never
  share a label — not even two installations on one host on two ports.
- **No secret is written into the plist, nor printed.** The script reads only
  `controlPlaneUrl` and `repoRoots` out of the profile (with `node`); the credential
  stays in the profile, where the launcher reads it. `PATH`, `LANG`, `KeepAlive` and
  `ThrottleInterval` are exactly a clone agent's.
- **It refuses a missing or unreadable profile**, or one naming another worker, and
  a worker id that is not path-safe — before writing anything.
- **It refuses while any of the profile's checkouts is already served.** A daemon
  holds one checkout lock per checkout it serves, so the duplicate-worker guard
  (below, "One worker per checkout") runs once for each of the profile's
  `repoRoots`. A launcher-started daemon is the runtime's
  `dist/transport/connect-entry.mjs`, which the guard recognises as a worker just as
  it recognises a clone's.
- **`uninstall` / `status` / `logs --profile <worker-id>`** find the agent through the
  profile, or — once the profile is gone or unreadable — through the installed plist
  whose `WorkingDirectory` is that worker's profile directory, so an agent can always
  be removed.
- **`update` never restarts a profile agent.** It restarts only agents running
  `run:worker`: a profile agent's daemon runs the runtime its control plane names,
  not this installation's build, so restarting it onto a pull would change nothing.
  `update --profile` is refused. Updating profile workers is #1282's.
- **It runs this installation's launcher**, for the same reason a clone agent runs
  this installation's `swarm`. `<installation>` is whatever the script ships in: a
  SWARM clone, which needs to be built (`npm run build`), since `bin/swarm-worker.js`
  loads `dist/`; or the clone-free **launcher package** (issue #1283,
  [`MANUAL.md`](./MANUAL.md), "Profile-based workers"), whose own
  `bin/swarm-worker-agent install --profile` writes a plist pointing into the
  package. A clone-mode agent and its plist are unchanged.

## After a `git pull` — the update flow

A worker normally updates because the installation asked it to
([`ADR-006`](./decisions/ADR-006-unconditional-worker-updates.md)). `update` is that
same chain run by hand, on the machine itself, for when that route is unavailable or
is not trusted to have worked:

```bash
swarm-worker-agent update             # every worker agent running this installation
swarm-worker-agent update ~/work/api  # only that checkout's agent
```

- **It updates the *installation*, not the checkout you are standing in.** A daemon
  runs SWARM's build, and the worker checkout the plist names is a project repository
  holding none of it — so the command resolves the installation it was itself shipped
  from (through the `swarm-worker-agent` → `bin/` symlink chain that put it on
  `PATH`), runs `git pull --ff-only`, `npm ci` and `npm run build` there, and restarts
  the agents afterwards. `<checkout>` narrows *which agents restart*, never which
  installation is pulled: there is one build behind all of them.
- **Which agents count is read off each plist, not assumed.** Every worker agent that
  runs `run:worker` and whose launcher resolves into this installation is restarted
  (a [profile-based](#profile-based-workers) agent never is) — a plist names
  `<installation>/bin/swarm.js` directly, and one written before issue #1213 names the
  `PATH` symlink, which is followed; a second SWARM clone's agents
  on the same Mac are left alone, because nothing pulled *their* build. A `<checkout>`
  whose agent belongs to another installation is refused rather than restarted onto a
  build this run never touched.
- **All three steps run in the foreground, before any restart.** A failed pull,
  install or build stops the chain with its own output on screen and leaves every
  daemon running the build it already has — restarting onto a half-written tree is the
  state ADR-006 has the asked-for route refuse outright, and this must not create it
  by hand.
- **Both `npm` steps run even when the pull moved nothing.** That is the recovery
  case: an installation whose `node_modules` or `dist` never finished being written is
  on the right commit and still unrunnable.
- **A phase in flight is lost.** The restart is `launchctl kickstart -k`, which kills
  the daemon outright; the command names each agent as it takes it down. Check
  `swarm workers list` first if the machine may be mid-run.
- **The API server is not restarted for you** — it has its own chain (migrations, the
  dashboard build) that this one deliberately omits, so an installation that also
  serves the API is told to run
  [`swarm-api-agent reload`](./launchd-api-autostart.md) as well.

## What the generated agent does, and why

- **No secret is written into the plist.** `swarm run:worker` derives
  `SWARM_WORKER_REPO_ROOT` from its working directory and reads
  `SWARM_WORKER_CREDENTIAL` from the per-checkout cache keyed on that path (issue
  #788), so the agent only has to set `WorkingDirectory` — a plist is world-readable
  and belongs nowhere near a credential. The **realpath** is load-bearing: a
  symlinked path, or a `git worktree` of the checkout, hashes to a different key,
  has no cache entry, and is refused with the same message `run:worker` gives.
- **`PATH` is derived from the machine, not hard-coded.** launchd starts a job with
  a minimal `PATH` and reads none of the login shell's rc files, while the worker
  spawns `npm`, `git`, `gh` and the agent CLIs by name. The script resolves each of
  those on the installing machine and puts their real directories in the plist, so
  an Intel Homebrew (`/usr/local`), an Apple Silicon one (`/opt/homebrew`) and a
  node under nvm/asdf/fnm all work without editing anything. Anything *else* a phase
  needs from a login shell — a proxy, `JAVA_HOME`, an extra API key — is still not
  inherited, and has to be added to the plist's `EnvironmentVariables`.
- **`SWARM_CONTROL_PLANE_URL` is deliberately absent.** The `.env` of the SWARM
  installation whose installer wrote the plist stays its single source, exactly as for an interactive `run:worker`
  (`node --env-file-if-exists=.env` supplies it to the daemon).
- **`KeepAlive` with `ThrottleInterval 30`** restarts a daemon that dies, without
  turning a genuine failure into a hot loop.

## Gotchas

- **A plist written before issue #975 may still carry `SWARM_WORKER_SELF_UPDATE`.**
  That was the per-host self-update opt-in, and the `install --self-update` /
  `--no-self-update` flags that wrote it here went with it. Nothing reads the key, it
  breaks nothing, and the next `install` rewrites the plist without it. A machine is
  now asked for an update on the installation's terms — see
  [`docs/onboarding-worker.md`](./onboarding-worker.md) for what bounds such a
  request, and [`ADR-006`](./decisions/ADR-006-unconditional-worker-updates.md) for
  why the flag went.
- **One worker per checkout.** The daemon takes the checkout lock itself, so a
  second one in the same checkout is refused — and under `KeepAlive` it would be
  refused every thirty seconds forever. `install` therefore refuses while a worker
  is already running **by hand** for that checkout, naming that worker and its pid;
  stop it first. It reads the holder from the lock
  (`~/.swarm/checkout-locks/<hash>/owner.json`), never from the process's working
  directory: `swarm run:worker` runs the daemon out of the npm-linked SWARM
  checkout, so every worker on the machine reports *that* directory as its `cwd`
  whichever repository it serves (issue #969). Two consequences worth knowing. A
  lock left behind by a crashed daemon refuses nothing, because `install` applies
  the same reclaim rule the daemon does: at once when the recorded pid is gone, and
  — for the pid the OS has since recycled to some *other* checkout's worker, which
  is the one case liveness alone gets wrong — once the record's `refreshedAt` is
  more than fifteen minutes old (`CHECKOUT_LOCK_TTL_MS`, the TTL the next daemon
  reclaims on). And reinstalling over this checkout's *own*
  running agent is not refused either, since `install` boots that job out before
  bootstrapping the new one, which is what makes reinstalling over a live agent the
  routine way a plist is changed. A fleet-wide restart therefore needs no particular order between
  checkouts. Starting and stopping the daemon otherwise stays the operator's own
  call.
- **A running daemon keeps the credential it started with.** It is read once, at
  startup. Re-registering a worker in a checkout whose daemon is already running
  therefore leaves the *new* worker permanently disconnected — the old process is
  still connected as the old one — until that process is stopped and the agent
  installed. This is the usual explanation for "the worker I just registered never
  connects".
- **A running daemon also keeps the *repository* it declared at startup.** Same
  mechanism, different field: `origin` is read once
  (`resolveDeclarableOriginRepoSlug`, `src/scm/repo-slug.ts`), so re-pointing the
  checkout's remote under a live daemon changes nothing the control plane sees, and
  neither does a reconnect — it re-sends the value it still holds in memory. See
  "A repository was renamed" below.
- **The agent runs the built CLI.** Its `<installation>/bin/swarm.js` loads that
  installation's `dist/`, so a stale build affects the agent exactly as it affects an
  interactive call: run `npm run build` after changing CLI source.
- **A plist written before issue #1213 may run another clone.** It still names
  whatever `swarm` was on `PATH` at install time, which on a Mac with two SWARM
  clones may be the one whose `.env` points at a different control plane. Check it
  with `plutil -extract ProgramArguments.1 raw <plist>`, and re-run the intended
  clone's `install` to repoint it.
- **Enrollment is not connection.** A connected daemon still needs an `active`
  enrollment with sharing consent before anything is dispatched to it, and an
  approved enrollment still needs the daemon running. The dashboard's
  `/workers/<worker-id>` shows both; see
  [`docs/onboarding-worker.md`](./onboarding-worker.md), which this does not replace.

## A repository was renamed

Renaming a project's repository on the SCM host breaks dispatch **silently**, and
the two halves have to be fixed in a fixed order.

What goes stale: the project's own `repo` on the control plane, and — on every
worker machine — the checkout's `origin` URL plus the declaration the running
daemon read from it at startup. Nothing here heals on its own. The board card is
skipped, with `pm-status: work item has no backing SCM artifact reference`
in the router log and a one-off "SWARM could not start …" notice on the card naming
both repositories, because the card's repository no longer matches the project's
(`repoSlugsMatch`, `src/triggers/handlers/pm-status.ts`); once the project *is*
fixed, dispatch moves on to waiting with `worker-authorization` instead, because
every machine still declares the old name.

1. **Control plane first.** Update the project's repository — the dashboard's
   project settings, or `swarm.config.json` + `swarm config apply`.
2. **Then each worker machine**, with the package's `swarm-repo-renamed`:

   ```bash
   swarm-repo-renamed <old-owner/repo> <new-owner/repo> [--dry-run]
   ```

   It walks every worker agent installed on the machine, and for each checkout
   whose `origin` is the old repository it rewrites the remote, proves the new URL
   answers (restoring the old one and skipping the restart if it does not), and
   restarts that agent so the daemon re-declares. Checkouts for other repositories
   are untouched — a machine running several workers needs one invocation, not one
   per checkout. Only the trailing `owner/repo` of the URL is rewritten, so an SSH
   host alias from `~/.ssh/config`, an `https://` remote, a port, and a nested
   namespace all survive.

**The order is not cosmetic.** A daemon that handshakes declaring a repository its
project does not name has its enrollments *suspended*
(`suspendEnrollmentsForMismatchedRepository`, `src/router/worker-transport.ts`), and
re-activation is a project administrator's act — a machine may not restore its own
routability. Restarting workers before the control plane knows the new name turns a
five-minute fix into an admin round trip.

Afterwards every worker should declare the new repository and keep an `active`
enrollment; a card that was queued meanwhile resumes on its own at the next
eligibility re-check (five minutes by default) with no need to move it again.
