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

## Usage

```bash
swarm-worker-agent install   [<checkout>]   # write the agent and start it
swarm-worker-agent uninstall [<checkout>]   # stop it and remove the agent
swarm-worker-agent status    [<checkout>]   # loaded? pid? last exit code?
swarm-worker-agent logs      [<checkout>]   # tail this checkout's stdout + stderr
```

`<checkout>` is the repository checkout the worker was registered for and defaults
to the current directory. It is **the project repository the worker runs against**
— the one [`swarm workers register-and-enroll`](./onboarding-worker.md) was run
from — not this repository, unless a worker happens to be enrolled on SWARM itself.
A machine running workers for several repositories installs one agent per checkout;
they are independent and carry no shared state.

The command ships in this package's `bin`, so a machine that has SWARM installed
(or `npm link`ed) already has it on `PATH` next to `swarm`.

| What | Where |
| --- | --- |
| Agent | `~/Library/LaunchAgents/pl.smarttechbrewery.swarm.worker.<basename>.<hash8>.plist` |
| Logs | `~/Library/Logs/pl.smarttechbrewery.swarm.worker.<basename>.<hash8>.log` (+ `.error.log`) |
| Credential | `~/.swarm/worker-credentials/<sha256 of the checkout realpath>/credential.json` |

`<hash8>` is the first eight characters of that same sha256, so two checkouts
sharing a basename (`~/work/api` and `~/oss/api`) still get distinct labels.

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
- **`SWARM_CONTROL_PLANE_URL` is deliberately absent.** The SWARM installation's
  `.env` stays its single source, exactly as for an interactive `run:worker`
  (`node --env-file-if-exists=.env` supplies it to the daemon).
- **`KeepAlive` with `ThrottleInterval 30`** restarts a daemon that dies, without
  turning a genuine failure into a hot loop.

## Gotchas

- **One worker per checkout.** The daemon takes the checkout lock itself, so a
  second one in the same checkout is refused — and under `KeepAlive` it would be
  refused every thirty seconds forever. `install` therefore refuses while a worker
  is already running for that checkout, naming the pid; stop it first. Starting and
  stopping the daemon otherwise stays the operator's own call.
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
- **`swarm` runs the built CLI.** The `swarm` binary resolves to `dist/`, so a stale
  build affects the agent exactly as it affects an interactive call: run
  `npm run build` after changing CLI source.
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
simply skipped, with `pm-status: work item has no backing SCM artifact reference`
in the router log, because the card's repository no longer matches the project's
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
