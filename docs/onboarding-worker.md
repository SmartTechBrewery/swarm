# Onboarding a worker

A step-by-step runbook for making a machine — **this one or somebody else's** —
a worker. Every worker connects over the transport (ADR-003 §2 — see
[`docs/configuration.md`](./configuration.md) and
[`docs/cloudflare-tunnel.md`](./cloudflare-tunnel.md#remote-worker-transport-worker));
there is one worker program (issue #553), with two ways to launch it (Part 2). The
admin-side prerequisites — the Cloudflare Tunnel `/worker/*` route in particular —
are out of scope here; this doc assumes the router is healthy with its dispatch consumer
running, which it always is.

**Every deployment does this, including a single-user install** (issue #552).
`SWARM_SINGLE_USER_MODE` is the API's authentication policy; it does not bypass
the dispatch gate, so the control-plane host's own worker is registered and
enrolled by these same commands. A host with no registered worker has nothing to
run phases on and its dispatches wait durably — which is what `swarm start` /
`swarm status` warn about.

**Where each part runs.** The user and membership steps (Part 1, steps 1–2) still
need `DATABASE_URL` and so still run on the **admin machine**. Everything else —
every `swarm workers` subcommand — needs only `SWARM_CONTROL_PLANE_URL` and a
`swarm login` session since issue #800, so it runs on the **worker's own machine**,
which is also where Part 2 runs.

---

## The whole thing, end to end

One worked example, start to finish, for the common case: **a teammate's machine
joining an existing installation.** Everything below uses placeholder values —
substitute your own.

| Placeholder | Stands for |
| --- | --- |
| `ada@example.com` | the teammate, as a SWARM login handle |
| `example-project` | the project id (`swarm.config.json` → `projects[].id`) |
| `https://swarm.example.com` | this installation's control-plane base URL |
| `ada_example_project` | the worker's display name, unique installation-wide |
| `claude,codex` | the agent CLIs installed **and authenticated** on that machine |
| `~/code/swarm` | that machine's checkout of SWARM itself |
| `~/code/example-project` | that machine's checkout of the project's repository |

A worker is permanently paired with one repository checkout, so a teammate who
works on two repositories gets **two workers**, each registered from its own
project checkout. Naming them after the person and the project
(`ada_example_project`, `ada_example_mobile`) is a convention, not a rule — the
pairing SWARM enforces is the checkout's `origin`, never the name.

### Step 1 — on the admin machine (the one with `DATABASE_URL`)

Create the person, give them a dashboard password, and put them in the project.
Skip any part already done; `users add` refuses a handle that exists.

```bash
npm run swarm -- users add ada@example.com --name "Ada Lovelace"
npm run swarm -- users set-password ada@example.com   # prompts, no echo
npm run swarm -- members add example-project ada@example.com --role member
```

Membership is not optional: the next step asks the control plane which SCM
provider the project runs on, and that read is refused for a non-member — with
`You are not a member of project "example-project"`, distinct from
`Project with ID "example-project" not found`, so the two are told apart.

### Step 2 — on the teammate's machine, in the SWARM checkout

```bash
git clone <this installation's swarm repo> ~/code/swarm
cd ~/code/swarm
npm install
```

Nothing has to be put in `.env` by hand — the next command writes the one line a
worker needs.

### Step 3 — sign in, as the worker's owner

```bash
npm run swarm -- login --identifier ada@example.com \
  --control-plane-url https://swarm.example.com
```

`--control-plane-url` writes `SWARM_CONTROL_PLANE_URL` into `~/code/swarm/.env`,
which is where the daemon reads it from later. It is needed **once per machine**:
an assignment already in the file is reported and kept, so every later command
omits the flag. Sign in as the teammate themselves, not as an admin on their
behalf — storing a machine's operator credential in step 4 is strictly the owner's
own call.

Sessions last `SWARM_SESSION_TTL_HOURS` (7 days by default); re-running this
command is the renewal.

### Step 4 — register and enroll the worker

Run this **from the project's checkout**, or name it with `--repo-root`:

```bash
npm run swarm -- workers register-and-enroll ada@example.com example-project \
  --name ada_example_project --cli claude,codex \
  --repo-root ~/code/example-project
```

It asks once, without echo, for the **operator source-control credential** — the
account this machine's commits, pushes, pull requests and implementer comments
are authored as. For GitHub that is a personal access token needing `repo` (push,
pull requests, comments, and the CI reads `respond-to-ci` makes) plus `workflow`
if agents may touch `.github/workflows/**`, since GitHub rejects a push that
changes a workflow file without it. The value is verified against the provider
before anything is stored, and never printed back.

Its **last line** carries the worker credential, shown exactly once:

```
swarm: SWARM_WORKER_CREDENTIAL=<credential> SWARM_WORKER_REPO_ROOT=<checkout> npm run dev:worker
```

Copy it before the terminal scrolls — though on this machine you will not need to,
since step 6 reads it from the local cache this command just wrote.

### Step 5 — approve the enrollment (a project administrator)

Skipped when the owner administers the project themselves — the enrollment then
already arrives active, and step 4 says so. Otherwise, from any machine with a
session:

```bash
npm run swarm -- login --identifier <a project administrator>
npm run swarm -- workers approve <worker-id> example-project
```

The worker id is in step 4's output, and `swarm workers list ada@example.com`
prints it again. Sharing consent was already recorded in step 4 — it is the
machine owner's decision and is kept even while approval is pending — so approval
is genuinely the only thing left.

### Step 6 — start the daemon

```bash
cd ~/code/example-project
swarm run:worker
```

Foreground, and it holds the terminal for as long as the machine should accept
work. `swarm run:worker` needs the global binary (`npm run build && npm link` in
the SWARM checkout); without it, use the explicit form from step 4's last line,
run in `~/code/swarm`. On macOS,
[`launchd-worker-autostart.md`](./launchd-worker-autostart.md) runs it at login
instead of from a terminal tab.

### Adding a second worker later

Steps 2, 3 and 5 are already done for that machine and that person. Only step 4
repeats, against the other project and its own checkout, with a new name:

```bash
npm run swarm -- workers register-and-enroll ada@example.com example-mobile \
  --name ada_example_mobile --cli claude,codex \
  --repo-root ~/code/example-mobile
```

No `--control-plane-url`: the machine is already pointed at the installation, and
the flag would only be refused if it named a different one. The operator
credential is asked for again — it is stored per `(worker, provider)`, so the
second worker has its own, even when the value is the same.

---

## Part 1 — register the user + worker

For a **single-user install**, skip the user and membership steps and pass
`localhost-admin` as `<email>` (in either path below): that is the bootstrapped
account the API resolves every request to (created the first time it serves one),
and being an installation admin it needs no project membership of its own. It has
no password until you give it one, and `swarm login` needs one, so run
`swarm users set-password localhost-admin` once on the admin machine.

### The three-command path (recommended)

Run this **on the machine being onboarded, from inside its checkout of the
project's repository** — no `DATABASE_URL`, no Postgres reachability (issue #800),
and nothing to put in a file by hand. The user must already exist and belong to the
project (steps 1–2 below), which is the admin machine's part.

```bash
swarm login                                                                        # once per machine
swarm workers register-and-enroll <email> swarm --name "<Display Name>" --cli <clis> \
  --control-plane-url <the control-plane base URL, e.g. https://swarm.example.com>
swarm run:worker
```

`--control-plane-url` is what points the SWARM checkout's `.env` at this
installation, which is the one thing the daemon reads from it. It is needed only on
a machine whose `.env` does not carry `SWARM_CONTROL_PLANE_URL` yet: an existing
assignment is reported and **left untouched**, so a second worker on the same
machine omits the flag and changes nothing. On a TTY the command asks for the URL
rather than failing when it is missing and no flag was passed. `swarm init` is
deliberately *not* the command for this: it copies the whole stack `.env.docker.example`,
and a worker must hold no `DATABASE_URL`.

Sign in as **the worker's owner** — `<email>` — not as an installation admin on
somebody else's behalf: storing a machine's operator source-control credential is
strictly the owner's (see [`docs/cli.md`](./cli.md#swarm-workers)).

The middle command registers the worker, prompts **once** (no echo; pipe the secret
on stdin to script it) for the operator source-control credential of whichever
provider the target project runs on — verifying it against that provider before
storing it — enrolls the machine in that project `active` with sharing consent on,
and prints, as its **last** line, the exact command to start the daemon:

```
swarm: SWARM_WORKER_CREDENTIAL=<credential> SWARM_WORKER_REPO_ROOT=<checkout> npm run dev:worker
```

Approving the enrollment is a **project administration** act, so that last part
holds when the owner you signed in as administers the project (`projectAdmin`, or
an installation admin such as `localhost-admin`). A plain `member` gets the
enrollment created and the approval refused: the command says so, names the
remaining `swarm workers approve <worker-id> swarm` for a project administrator to
run, and hands the worker credential over anyway. That approval really is the only
thing left — the sharing consent this command was asked to grant is the machine
owner's own to give, so it is recorded even while the approval is pending (issue
#901), and the machine is routable the moment the administrator approves, with
nothing further from its owner. Do **not** re-run
`register-and-enroll` or `workers enroll`, which from there only reports the
machine is already enrolled. Give the owner `--role projectAdmin` in step 2 below
if you would rather they seed it themselves.

That is the whole hand-off: **it does not start the worker** — Part 2 is where
that line is run. Run from the worker's own checkout, though, you do not need it:
the credential was cached for that checkout, so `swarm run:worker` starts the
daemon there with nothing to paste, which is the third command above. The printed
`SWARM_WORKER_REPO_ROOT` is the checkout you ran the command *in* — not the project
record's stored `repoRoot`, which names whichever machine last ran
`swarm config apply` (issue #796) — exactly as `workers register` behaves. Pass
`--repo-root <path>` only when you are onboarding somebody else's machine from
elsewhere, whose checkout path this one cannot know; then hand the printed
credential over out-of-band and let them run Part 2's explicit form. The worker
credential appears in that one printed line and nowhere else, so copy it before the
terminal scrolls. Every refusal the
three commands it replaces produce still applies, unchanged — with the one
exception just named: `--active` is a project administrator's call made *after* the
enrollment is created, so on a project the owner does not administer it is refused
and the enrollment survives. See [`docs/cli.md`](./cli.md#swarm-workers).

### The composable path (scriptable alternative)

The same work, one command per step. Keep using these to script the steps
separately, to enroll an **already-registered** worker into another project, or to
rotate a credential — `register-and-enroll` covers the new-machine case only.

Steps 1–2 need `DATABASE_URL` and run on the **admin machine**; steps 3–5 are
`swarm workers` and run on the **worker's own machine**, after `swarm login` as
that worker's owner (issue #800). Step 4b is the one exception: approving an
enrollment is a project administrator's call, so it is run by whoever holds
`projectAdmin` on the project (from any machine with a session — it needs no
`DATABASE_URL` either). Give the owner `--role projectAdmin` in step 2 if you would
rather they collapse steps 4 and 4b back into a single
`workers enroll … --active --consent` of their own.

```bash
# --- admin machine (DATABASE_URL) ---
# 1. Create the user and set their dashboard login password
npm run swarm -- users add <email> --name "<Display Name>"
npm run swarm -- users set-password <email>

# 2. Add them to the project
npm run swarm -- members add swarm <email> --role member

# --- the worker's own machine (SWARM_CONTROL_PLANE_URL + swarm login) ---
# 3. Register their worker — prints a credential ONCE, copy it now
swarm login --identifier <email>
npm run swarm -- workers register <email> --name "<Display Name>" --cli <clis>

# 4. Enroll the worker in the project — the owner's own call, consent included
npm run swarm -- workers enroll <worker-id> swarm --cli <clis> --concurrency 1 --consent

# 4b. Approve it — a PROJECT ADMINISTRATOR's call, so run it as one (any machine
#     with a session; add --active to step 4 instead if the owner is one)
npm run swarm -- workers approve <worker-id> swarm

# 5. Store this worker's operator SCM credential — the account its commits,
#    pushes, PRs and implementer comments will be authored as. Prompts without
#    echo; pipe it on stdin to script this.
npm run swarm -- workers set-scm-credential <worker-id> github
```

Notes:

- `--cli` is a comma-separated subset of `claude,antigravity,codex` — **only
  list what's actually installed and authenticated on the target machine.**
  `workers register` seeds the worker's *probe* baseline, which the daemon then
  re-declares from the machine's own PATH on every reconnect; `workers enroll`'s
  own `--cli` is the (possibly narrower) set allowed for *this* project. Mismatch
  here just means the CLI it can't run never gets dispatched work — not a hard
  error — but there's no reason to overclaim.
- `swarm workers set-cli <worker-id> --cli <c1,c2,...>` states a **durable
  declaration** of which CLIs the machine should run (issue #783). Unlike the
  probe, it survives the machine's next reconnect, and it is what dispatch routes
  on. It may only *narrow* what the machine's daemon last reported — to widen
  that, install the CLI there (or set `SWARM_WORKER_TRANSPORT_CLIS` on the machine
  itself). `swarm workers set-cli <worker-id> --auto` clears the declaration and
  returns the worker to plain auto-discovery. **This has a dashboard equivalent**
  (issue #787): the worker's owner can do the same at `/workers/<worker-id>` →
  **Declared by the daemon** → *Agent CLIs*, which offers one checkbox per CLI the
  machine actually reported and a *Use auto-detected CLIs* button for `--auto`. It
  calls the same seam this command does, needs no CLI or DB access, and is the
  owner's alone — no installation admin override. It also names a declared CLI the
  machine has stopped reporting, which is otherwise only a server-side log line.
- Step 3's credential is shown exactly once (`swarm workers list` never prints
  it again). Copy it immediately; if you lose it, `workers remove` (or
  `/workers/<worker-id>` → **Delete worker**, its dashboard equivalent since issue
  #789 — both owner-only, and both refused while the machine is running a job)
  + `workers register` again is the only recovery. Step 3 **also
  caches it for the directory where the command was invoked**, on the machine it
  was run on (issue #788; `npm run swarm -- …` reads that directory from `INIT_CWD`):
  `~/.swarm/worker-credentials/<hash>/credential.json`, owner-only, outside every
  checkout. That is what lets `swarm run:worker` start this worker without the
  credential being pasted anywhere — but only where the registering machine *is*
  the running machine. Registering on an admin machine for somebody else's still
  hands the value over by copy.
- **Step 4 has a dashboard equivalent** (issue #764): the owner of a registered
  worker can do it themselves — but **only before its first enrollment** (issue
  #789), since the machine's checkout pairs it with one repository for its whole
  connected life and no second project would be accepted — at
  `/workers/<worker-id>` → **Enroll in a project**, picking any project they are at
  least a `contributor` on. It calls the same `workers.enroll` this command does,
  so no CLI or DB access is needed — and it creates the
  enrollment `pending` and **without** sharing consent, i.e. the CLI's behaviour
  with neither `--active` nor `--consent`. A project administrator then approves it
  and the owner flips sharing on, both on the same screen. **Unless you administer
  the project yourself** (issue #784): when the enroller is both the worker's owner
  and a `projectAdmin` on the target, both of those approvals are already theirs, so
  the enrollment is created `active` with sharing on and is routable immediately —
  no second step. Everyone else is unchanged. The one-shot
  `--active --consent` form below stays the CLI's own, and is what a `projectAdmin`
  bootstrapping **their own** machine wants. Note that `--consent` is strictly the
  machine owner's since issue #800 — an installation admin seeding *someone else's*
  machine gets it refused (the enrollment is still created and approved, and the
  command names the `workers consent … on` its owner has to run).
- `--active --consent` at enroll time (rather than the separate `approve` /
  `consent` commands, [`docs/cli.md`](./cli.md#swarm-workers)) is safe to do
  immediately, before the new machine has connected anything: a `transport`-mode
  dispatch only ever selects a worker that is both enrolled **and currently
  connected** (`isWorkerConnected`) — an enrolled-but-disconnected worker just
  can't be picked, so there's no window where work gets routed to a machine
  that isn't there yet. **`register-and-enroll` creates exactly this form** and
  offers no flag to opt out, so this note covers it too: a pending,
  non-consenting enrollment is not "ready to start", which is what that command
  exists to deliver. On a project the caller does not administer it creates the
  consenting half immediately and the pending approval is the only thing left
  (issue #901). Use the composable path above when you want the two approvals
  kept as separate human decisions.
- **Enroll the machine in a project that owns the repository its checkout actually
  is.** Step 4 is refused (naming the machine's checkout and every repository the
  project owns) when the worker has already declared a checkout of a repository the
  project declares nowhere — a worker holds a single checkout, so work for any other
  repository would only be refused when it got there (issue #690). A project owning
  several repositories accepts a worker for **any** of them (issue #946), so one
  project can hold one worker per repository. A worker that has not connected yet has
  declared nothing and is enrolled as before; if its first handshake then contradicts
  this enrollment, the control plane **suspends** it, and `/workers/<id>` says which
  repositories disagree — the machine's checkout on one side, every repository the
  project declares on the other, so a multi-repository project shows no banner for a
  worker correctly enrolled on any of them. Fixing the pairing is an operator action —
  point the machine at the right checkout, or enroll it in the right project — and
  re-activating a suspended enrollment stays the project administrator's call
  (`swarm workers approve`).
- **Step 5 is what the machine actually runs as** (issue #765). One credential per
  `(worker, SCM provider)`, stored encrypted server-side and resolved at dispatch —
  so a worker enrolled in projects on two providers needs one command per provider
  (`github` | `bitbucket` | `gitlab`), and a rotation takes effect on the next phase
  with no worker restart. Without it, every Planning/Implementation/Review dispatch
  to this worker fails immediately with a message naming the worker and the provider.
  It replaces the worker-local `SWARM_OPERATOR_GH_TOKEN`, which no worker reads any
  more; see the rollout order in Part 2.
- **Step 5 has a dashboard equivalent too** (issue #766): the worker's owner can set
  and rotate the same value at `/workers/<worker-id>` → **Operator source-control
  credential**, with no CLI or DB access — one field per provider that machine's
  enrollments actually resolve to. The dashboard **verifies the value against the
  provider before storing it**, so a wrong paste is refused there and then rather than
  failing at the next dispatch, and it confirms the account it resolved to. The stored
  value is never shown again — only that it is set, when it was last written, and a
  **Replace** control — and it applies to the next dispatch with no worker restart,
  exactly as this command's does. Since issue #800 the two are the same surface with
  the same rule: `workers set-scm-credential` calls that procedure, so it too is
  strictly the worker owner's with no instance-admin override — an administrator can
  no longer store a credential on somebody else's machine from the control-plane
  host. Whoever owns the machine signs in on it and sets it.
- Skip `swarm identities link` unless you already know which GitHub account
  should be the *assignee* that routes work to this specific machine — without
  it the worker still receives review / respond-to-review / respond-to-ci /
  resolve-conflicts / unassigned-implementation work normally.

Verify the roster looks right before handing off the credential. From the worker's
own machine, `workers list <email>` reports that owner's machines; the unfiltered
roster is an installation administrator's view (issue #647), as is anyone else's:

```bash
npm run swarm -- workers list <email>
```

```sql
-- via: docker compose exec -T postgres psql -U swarm -d swarm -c "..."
SELECT u.identifier, w.display_name, w.capabilities,
       e.project_id, e.status, e.sharing_consent, e.concurrency_allocation
FROM workers w
JOIN users u ON u.id = w.owner_user_id
LEFT JOIN worker_project_enrollments e ON e.worker_id = w.id
ORDER BY u.identifier, w.display_name;
```

(The SQL is the admin machine's cross-check, not the operator's — it needs
`DATABASE_URL`.)

When Part 1 ran on the worker's own machine there is nothing to hand over: the
credential is already cached for that checkout. Onboarding somebody else's machine
from elsewhere, hand the credential over out-of-band (not pasted into a shared
chat/ticket) along with the control-plane URL (the tunnel hostname from
[`docs/cloudflare-tunnel.md`](./cloudflare-tunnel.md)). The account that authors
their commits/PRs is the one whose credential step 5 stored — that value stays on
the control plane and is never handed to the operator of the machine.

---

## Part 2 — new machine: connect the worker

This machine is **DB-free** — no `DATABASE_URL`/`REDIS_URL`, no Postgres/Redis
access at all. It needs the repo checked out (it runs the agent CLI locally and
manages its own Git worktrees) and two environment variables in its `.env`. It
holds **no source-control credential of its own** since issue #765: the operator
identity it commits and pushes as is stored on the control plane (Part 1, step 5)
and arrives with each assignment.

> This is also how the **control-plane host's own** worker runs since issue #551 —
> same command, same two variables, with `SWARM_CONTROL_PLANE_URL` pointing at
> `http://localhost:<ROUTER_PORT>` instead of the tunnel. Everything in Part 2
> applies there too.

```bash
git clone <repo-url> && cd swarm
npm ci
```

Since issue #800 this same checkout is where Part 1 is run from — `swarm login` and
`swarm workers register-and-enroll` need only `SWARM_CONTROL_PLANE_URL`, and
`register-and-enroll --control-plane-url <url>` writes that line into the `.env`
below itself when it is absent, so a fresh clone needs no hand-edited file at all —
so on a machine onboarded that way
`SWARM_WORKER_CREDENTIAL` never has to be written here at all, and
[`swarm run:worker`](./cli.md#swarm-runworker) below is the whole of Part 2. The
explicit form stays for a machine somebody else onboarded, and for a process
supervisor:

```dotenv
# .env — the *only* file npm run dev:worker reads
# (node --env-file-if-exists=.env is hardcoded in package.json; a differently
# named file like .env.worker.local is never picked up automatically)
SWARM_WORKER_CREDENTIAL=<the credential from Part 1, step 3>
SWARM_CONTROL_PLANE_URL=<the control-plane base URL, e.g. https://swarm.example.com>
```

**Upgrading an installation that predates issue #765** — the order matters, because
a new router pushes a credential an old worker ignores, while an old router pushes
none and a new worker refuses to run:

1. store every worker's operator credential (Part 1, step 5) on the control plane;
2. deploy the router;
3. deploy the workers.

Only after step 3 may an operator delete `SWARM_OPERATOR_GH_TOKEN` from a worker's
`.env` — it is inert there from that point on. (The **router**'s own
`SWARM_OPERATOR_GH_TOKEN` stays: three control-plane call sites still read it, see
[`docs/configuration.md`](./configuration.md).)

Make sure every CLI declared in `--cli` back in Part 1 is actually installed
and authenticated on this machine (e.g. `claude` logged in), then:

```bash
npm run dev:worker
```

**If Part 1 was run on this machine, in this checkout**, there is a shorter form
(issue #788):

```bash
swarm run:worker            # from inside the checkout
```

It starts the same daemon, reading `SWARM_WORKER_CREDENTIAL` from the per-checkout
cache Part 1 wrote here and setting `SWARM_WORKER_REPO_ROOT` to the current
directory — so `.env` only needs `SWARM_CONTROL_PLANE_URL`, and the credential is
never typed, pasted, or printed. It is an *additional* start path: the `.env` +
`npm run dev:worker` form above is unchanged and stays the one to use on a remote
machine, under a process supervisor, or anywhere the machine that registered the
worker is not the machine running it. A checkout with no cache entry says so and
names both remedies rather than failing on a missing file.

Either form holds the terminal for as long as the machine is meant to accept work.
On macOS, [`swarm-worker-agent`](./launchd-worker-autostart.md) wraps the shorter
form in a per-checkout launchd agent so the daemon starts at login instead.

A successful connection logs two lines:

```
worker transport client starting controlPlaneUrl=... hostname=... capabilities=[...] supportedPhases=[...] repoRoot=... repository=...
worker transport session established workerId=... sessionId=... heartbeatTtlMs=60000
```

`repository` is the `owner/repo` this daemon read from its checkout's `origin`
remote and declared at handshake (issue #687) — the control plane learns which
repository the machine holds no other way, since `repoRoot` is host-local. It prints
`null` when the checkout has no identifiable `origin` (a local-only clone); that is
not an error, the daemon simply declares nothing. Once it *is* declared, the
handshake also **suspends any enrollment of this worker in a project that does not
own that repository** (issue #690, widened by #946 from the project's default
repository to every repository it declares) — the pairing was impossible, and the
Workers screen says so instead of leaving it to be inferred from refused
assignments — naming every repository the project declares, so an enrollment the
handshake deliberately left alone gets no banner. A daemon that declares nothing
suspends nothing.

**One worker per checkout** (issue #689). Before it handshakes, the daemon takes a
lock on the checkout it was pointed at, recorded under
`~/.swarm/checkout-locks/<hash>/owner.json` on this machine — not on the control
plane, which cannot see a checkout. (`<hash>` is `sha256` of the checkout's
realpath; `~/.swarm/worker-credentials/<the same hash>/credential.json` is the
sibling `swarm run:worker` reads, keyed the same way. Both live in the operator's
home directory, outside every checkout, so no project needs a `.gitignore` entry
for either.) A second daemon started against the same
`SWARM_WORKER_REPO_ROOT` refuses to start and names the worker holding it, because
both would drive git in the same repository and collide on its `index.lock`. Two
*separate* checkouts on one machine are fine, and are the supported way to run two
workers on it. The lock needs no cleanup after a crash: the next daemon reclaims it
once the holder's process is gone (or its refresh has lapsed), and a `Ctrl-C`
shutdown releases it immediately.

Leave it running in its own foreground terminal — same as the host worker, this
process is meant to be watched, not daemonized. `Ctrl-C` sends a graceful
`SIGINT`, which releases the session lease immediately rather than leaving it
to expire after `heartbeatTtlMs`.

---

## Updating a machine from the control plane (issues #933, #975)

A machine can be asked, from the control plane, to move its SWARM **install root**
to a build and restart into it, instead of an operator going to every host and
pulling by hand:

```bash
swarm workers drain <worker-id>            # required first — see below
swarm workers update <worker-id> main      # a branch, a tag, or a commit id
swarm workers list                         # read what it reported
swarm workers undrain <worker-id>          # put it back in the pool
```

- **This has a dashboard equivalent** (issue #998): the machine's owner can ask for
  the same thing at `/workers/<worker-id>` → **Connectivity** → *Update worker*,
  which calls the same `workers.requestUpdate` this command does — no CLI or DB
  access needed, and the owner's alone, with no installation-admin override. It always
  asks for **the build the control plane itself is running**, rather than taking a ref:
  that is the build a machine's *Outdated* mark is judged against, so the update clears
  the mark, and a control plane that cannot read its own build offers no button rather
  than guessing one. Both refusals below reach the screen in the server's own words —
  the drain-first one naming `swarm workers drain`, and the enrollment one naming
  `swarm workers enroll` — as does the unsupervised refusal, so nothing is hidden by a
  greyed-out button. Draining and undraining stay the **Pool membership** card on the
  same screen.

Once you operate more than one machine, `--all` moves all of them as a **staged
rollout** (issue #940) and prints where each one stands:

```bash
swarm workers update --all main            # start it — this is the whole action
swarm workers update --status              # read where it has got to
```

The rollout owns the drains: it takes at most `--wave` machines out of the pool at a
time (one by default), waits for each to go idle, asks it, waits for it to come back
on the new build, puts it back in the pool, and only then starts the next wave — so
the four steps above stop being yours to repeat per machine, and the fleet's capacity
is never down at once. It also **advances itself** (issue #941), off each machine's
report, off its reconnect, and off a periodic check for the machine that applied and
never came back — so start it and read it, rather than starting it and re-running it.
Re-running the same command is still allowed, and nudges it as well as printing it.

A machine that reports `failed`, `refused` or `declined`, that comes back still on the
build it was asked to leave, or that applies and never comes back inside ten minutes
**halts** the rollout: nothing further is drained or signalled, the reason is printed,
and the machines it had not reached stay in the pool. Your machine may be in neither
group — if it was already being moved when the halt landed, the rollout keeps settling
it on the advances that follow, and it goes back in the pool once it settles without
failing. The one that failed is left drained so you can look at it. A halt is final —
fix the build and start a new rollout.

**There is no per-host setting to turn this on or off, and since issue #975 there is
no setting that can refuse it.** What authorizes an update is the mechanism itself,
and it is worth reading once, because it is what the removed flag was standing in
front of:

- **The fetch takes no URL and no refspec.** The daemon runs `git fetch <remote>` —
  a remote *name* — so the only code that can ever arrive is what the install root's
  own already-configured remote already says it fetches. Nothing on the wire can
  redirect it at another repository.
- **The target must be an ancestor of the branch the install root tracks.** A machine
  can only be moved to code that is already on the branch it follows, never onto a
  side branch somebody pushed. What that leaves an administrator able to do is move a
  machine *backwards* along its own branch — visible in `swarm workers list`, bounded,
  and reversible by asking for the newer ref.
- **A dirty install root is refused outright**, so uncommitted work on the host is
  never overwritten.
- **The drain is the machine owner's own control, and is unchanged.** An update only
  ever reaches a machine already out of the dispatch pool — see "Why the drain is
  required" below.

The flag that used to sit in front of all of this,
`SWARM_WORKER_SELF_UPDATE`, defaulted to off, so a host that had simply never been
told about it declined every request and drifted, silently. It was removed rather
than defaulted on — a setting that still exists is a setting that gets set — and
[`ADR-006`](./decisions/ADR-006-unconditional-worker-updates.md) records the
reasoning. **A stale value left behind is inert**: a `SWARM_WORKER_SELF_UPDATE` still
in a launchd plist, an `.env`, or a shell profile is an environment variable nothing
reads, it breaks nothing, and the next `swarm-worker-agent install` drops it.

One thing still has to be true of the host:

- **A process supervisor must be restarting the daemon.** On a successful update the
  daemon releases its session and exits 0; launchd `KeepAlive`
  ([`swarm-worker-agent`](./launchd-worker-autostart.md)) or systemd
  `Restart=always` is what brings it back on the new build. Without one, the machine
  simply stops — **and since issue #997 it is refused rather than left to do that**.
  The daemon works out at startup whether launchd or systemd started it and declares
  that at handshake, so a machine that declared `unsupervised` is told no and nothing
  is written: `swarm workers update` refuses it naming the remedy, the fleet forms
  report it `unsupervised`, and a staged rollout skips it and returns it to the pool.
  Install it with `swarm-worker-agent install` and ask again, or update that machine
  by hand (`git pull && npm ci && npm run build`, then restart it). This is a
  precondition of the update *mechanism*, like the drain and the ancestor check above,
  not a per-host setting of the kind ADR-006 removed — nothing turns it off. A machine
  whose supervision is **unknown** — an older daemon, one that has never connected, a
  platform the reads cannot answer for — is never refused. Read the macOS caveat in
  [`docs/MANUAL.md`](./MANUAL.md) first: a LaunchAgent that starts the daemon through
  `swarm run:worker` currently declares `unsupervised`, so such a host is refused
  although launchd would restart it, and updates by hand until the detection reads
  that shape.

**Why the drain is required.** `swarm workers update` is refused unless the machine
is already out of the dispatch pool, and names the drain as the remedy. The daemon
waits for the phases it is already running to finish before it applies anything — no
run is cancelled, deferred, or failed by an update — and draining is what stops new
work arriving into that wait. Undraining is a separate step afterwards, on purpose:
the machine stays out of the pool until you have read what it reported. The staged
`--all` form does not relax that precondition, it *satisfies* it — it drains each
machine itself before asking it, and undrains the ones that came back cleanly.

**Why an enrollment is required (issue #971).** A request is also recorded as a
**run**, in the runs list of the project the machine is enrolled in — so an update
starts, is visible while it happens, settles, and stays readable afterwards, like any
other run. That run needs a project to hang off, so a machine enrolled in **no**
project cannot be updated this way: `swarm workers update` refuses it and writes
nothing, the installation-wide form reports it `no-project`, and a staged rollout
skips it. `swarm workers enroll <worker-id> <project-id>` first. A machine that
somehow holds several enrollments uses its oldest, deterministically — the run is a
record of what happened to the machine, not a routing decision, so a `pending` or
`suspended` enrollment names its project just as an `active` one does.

**A host that runs several daemons from one SWARM checkout is supported (issue
#935), and one ask brings all of them over (issue #973).** The install root is the
SWARM checkout a daemon's *own code* is loaded from, which is not
`SWARM_WORKER_REPO_ROOT` — that is the project checkout it works in — and on the
control-plane host one npm-linked install root serves several daemons at once. Drain
**every** worker on that machine, then update them, and read the reports:

- The first daemon to act takes a machine-local lock on the install root and does the
  fetch, the `npm ci` and the build. The others find it held and **wait for it**,
  because holding that lock afterwards is the only proof the build is finished rather
  than half-written. They then restart onto exactly what it landed — no fetch and no
  build of their own — and report `adopted`. So a machine fetches and builds **once**,
  however many daemons it runs, and every one of them ends up on the new build with
  nobody logging in.
- What a waiting daemon adopts is **what the machine's own record says was applied**,
  not simply the fact that somebody held the lock. If the daemon it queued behind
  landed nothing — it refused, its own fetch failed, or it was returning the machine to
  its last known good build — the waiting one does the ordinary fetch and build for
  itself. That is why a network blip on the first daemon costs you a slower update
  rather than a fleet of machines reporting success on code they are not running.
- `applied` and `adopted` are both successes, and they are distinguishable on purpose:
  `applied` is the daemon that paid for the fetch, `adopted` one that restarted onto a
  peer's. Both restart the daemon, so both need the process supervisor.
- A daemon comes over on **its own** update request — nothing here manufactures one for
  a daemon nobody asked. `swarm workers update <worker-id> <ref>` moves one daemon;
  `swarm workers update --all <ref>`, `swarm workers request-update <ref>` and the
  staged rollout ask every machine, and are what bring a shared install root's daemons
  all the way over.
- An update is **refused while any other daemon on that machine is mid-phase**, naming
  the worker to drain. The refusal stands just before the checkout — a fetch writes
  remote-tracking refs and replaces no code — so a run on a peer daemon never has its
  code swapped underneath it, while a daemon that only needs to restart is not refused
  by it. Draining the peers is what makes that check stable: it is a snapshot of the
  moment the update asked, and nothing stops an undrained peer taking work a second
  later.
- A machine that cannot bring a daemon over says so rather than reporting a success
  covering one process. A daemon that waits the holder out and still cannot get in,
  that finds a completed apply landed a *different* ref, or that finds the install root
  on a commit no daemon here finished putting it there, reports `refused` naming what
  it found. Read the other daemon's own outcome, fix what it reported, and re-issue.
- The lock is host-local and needs no cleanup: it is reclaimed once its holder's
  process is gone (or its refresh has lapsed for 15 minutes), and every exit path
  drops it.

**The rollout order is the same one the #765 note above states, for the same reason:
control plane first, workers after.** An older control plane does not serve the
report route, so a newer daemon's outcome reaches a 404 and is lost (the daemon
itself survives and keeps working); an older daemon does not recognise the pushed
frame and ignores it, so the request sits pending until that machine is upgraded by
hand. Deploy the router and API server, then the workers.

**What "it worked" looks like.** `swarm workers list` marks the machine
`update <ref> pending` while the request is outstanding and `update <ref> <outcome>`
once it has answered — `applied`, `adopted`, `already-current`, `refused` or `failed`
(the last two carrying the machine's own words about why), plus the legacy `declined`
from a machine still running a build that predates issue #975. Anything but
`applied` or `adopted` leaves the machine working on the build it already had. After
either of those restarts the machine re-declares its build at handshake, so the
`/workers` screen's build column is the independent confirmation that the new code is
what is running — and on a host running several daemons from one install root, that
every one of them is running it.

**A machine that cannot come back puts itself back (issue #934).** An applied update
is not trusted until a daemon running it has connected once, because the update
channel is the first thing a bad build takes away: with no socket there is nothing
left to push a correction down. So the machine judges the new build itself. It counts
every start on an unproved build before it loads a line of that build's own worker
code — so a build that dies while it is still starting up is counted exactly like one
that starts and then cannot connect — the first successful
handshake promotes that build to *last known good*, and a machine that has spent its
whole failed-start budget without once connecting — three starts, plus one for each
peer daemon that adopted the build, since those peers' own healthy restarts land on
the same counter and must not spend it — or that the control plane rejects outright at
the handshake, which is the "this build cannot talk to this control plane" case and
does not wait the count out — checks the last known good commit back out,
reinstalls, rebuilds, and exits 0 for the supervisor to start it there. Nothing has to be asked of
it and nothing can be: this is the one outcome in this feature that is recovered on
the machine rather than from the control plane.

What you see is a machine that went away and came back **on its previous build**:
`swarm workers list` still reads `update <ref> applied` (that report was true when it
was made), while the build column on `/workers` shows the older commit again, marked
`OUTDATED`. That pairing — `applied` beside the build it moved *off* — is the signal
to read the machine's own log, where the return is a single `returned to the last
known good SWARM build` line preceded by why it gave up. Re-requesting the same ref
will simply repeat the cycle; fix the build first.

### Who may ask, and for whose machines (issue #922)

**An installation administrator may ask a machine they do not own — and that is all
they may do.** The rule is stated here rather than left to be inferred from the code,
because the two rules already in this document point opposite ways: since issue #800
`workers set-scm-credential`, `workers remove`, `workers consent` and
`workers update-enrollment` are *strictly the machine owner's* (an installation admin
gets the same `NOT_FOUND` a stranger does), while the unfiltered roster read is an
*installation administrator's view* (issue #647). Requesting a build sits between
them, and this is which side it landed on and why.

```bash
swarm workers request-update main          # every machine on the installation
```

- **The dashboard does the staged thing instead** (issue #1009, repointed by #1025):
  an instance administrator reaches every machine on the installation at `/workers` →
  **Update all workers**, in the toolbar above the roster — but that button now starts
  the *staged rollout* (`workers.startFleetUpdateForInstallation`), not this command's
  one-shot fan-out. That is deliberate: what this command asks is bounded by a drain
  it will not perform, so on an installation where owners have not drained anything it
  reports `in-pool` and moves nothing, while the rollout drains the machines itself and
  gives every one of them back. Like the machine-scoped button it always asks for
  **the build the control plane itself is running** rather than taking a ref, and a
  control plane that cannot read its own build offers no button rather than guessing
  one. It never fires on a single click: a confirmation first names the build, the set
  ("every registered machine on this installation, including machines you do not own")
  and what a rollout does — a bounded wave at a time, never interrupting a running
  phase, verified on the way back, halting on a bad build, every drained machine
  returned. Because a rollout advances itself, what it leaves behind is a **readout on
  `/workers`** above the roster rather than a one-shot modal report: target, status,
  wave size, halt reason, and a line per machine with its owner, its state and its own
  message, live and still there after a reload. A caller without the installation role
  sees the refusal below in the control plane's own words. This command, and the
  per-machine report it prints, are unchanged.
- **A project's own administrator can ask for the project's machines** (issue #1010),
  without the installation role and without CLI access: the project detail page's
  **Workers** tab has **Update project workers** in the same toolbar, calling
  `workers.requestUpdateForProject`. The set is the machines enrolled in *that*
  project, in the project's own configured order — the order the tab lists them in,
  never the rows a search box happens to be showing. Everything else is the same
  action: the build the control plane itself is running, the same confirmation, the
  same per-machine report with owners, dispositions and remedy lines. It adds one
  sentence the installation-wide form does not need — **a machine enrolled in other
  projects as well is moved for all of them**, because an update moves that machine's
  SWARM install root and restarts its daemon rather than touching one enrollment. The
  drain stays the machine owner's here too, so a machine its owner has not drained
  comes back `in-pool`. There is no CLI counterpart for this set; `swarm workers
  request-update` is the installation.

What settles it is that each of #800's four **takes something of the owner's** and
keeps it — a credential the administrator would then hold, the machine's existence,
the owner's consent to share it, the constraints their machine runs under — whereas
this takes nothing and decides nothing. What it can ask for is bounded by the
mechanism, and the one switch that decides whether a machine is asked at all stays
with the person who owns it:

- **Draining is still strictly the owner's** (issue #919) and is *not* widened by
  this command. It asks only machines already out of the dispatch pool, so a machine
  its owner has not drained comes back `in-pool` and untouched, and one enrolled in no
  project comes back `no-project`. An administrator
  therefore cannot take the installation's capacity down with this, and cannot move a
  machine whose owner has not made it askable in the first place.
  - **The one exception is a rollout that returns its own members** (issue #1024).
    `workers.startFleetUpdateForInstallation` stages this same move across the whole
    installation and *does* drain machines the administrator does not own — one
    bounded wave at a time — but every machine it drained goes back in the dispatch
    pool once the rollout is finished with it, on a halt and including a machine that
    failed. That is what makes it acceptable: it is a borrowed drain with a deadline,
    not a standing right. `swarm workers drain` / `workers.setDraining` themselves are
    unchanged and are still refused to an administrator on somebody else's machine, so
    there is no way to take a machine out of the pool and leave it there.
- **The mechanism bounds the reach** — the two guards stated at the top of this
  section. The fetch takes no URL and no refspec, and the target must be an ancestor
  of the branch the install root already tracks, so an administrator cannot point a
  machine at another repository or at a branch they pushed. They can move it along the
  branch it already follows, and nowhere else.

So the administrator may put the request; the owner keeps the drain. Until issue #975
there was a second veto, a per-host opt-in the owner could unset — it is gone, and
[`ADR-006`](./decisions/ADR-006-unconditional-worker-updates.md) says why. The report
prints a line per machine with its owner and its disposition, so the machines the
administrator cannot do anything about themselves are named, with the person to ask. A
caller who is *not* an installation administrator is refused outright and shown
nothing: it never quietly narrows to their own machines, which would read as the whole
installation.

**Every request records who made it.** `workers.update_requested_by_user_id` sits
beside the build and the instant on the machine's own row, so an owner whose machine
restarted into a build they did not ask for can find out on whose word:

```sql
-- via: docker compose exec -T postgres psql -U swarm -d swarm -c "..."
SELECT w.display_name, w.update_target, w.update_requested_at,
       u.identifier AS requested_by, w.update_status, w.update_message
FROM workers w
LEFT JOIN users u ON u.id = w.update_requested_by_user_id
WHERE w.update_target IS NOT NULL
ORDER BY w.update_requested_at DESC;
```

The API server also logs one `installation-wide worker update requested` line per
call, carrying the requester, the build and every machine's disposition — the same
act seen as one fleet action rather than one machine's history.

Note what this command is *not*: it is the one-shot fan-out, not the staged rollout
`update --all` runs. It drains nothing, undrains nothing and stages nothing, because
every one of those acts on a machine rather than asking it. Moving a fleet in waves is
each owner's own `swarm workers update --all <ref>` — or, since issue #1024, an
administrator's `workers.startFleetUpdateForInstallation` over the whole installation,
which still has no CLI command of its own and is driven from the dashboard instead
(issue #1025): the `/workers` toolbar's **Update all workers** button starts it, and
the readout above the roster reads `workers.fleetUpdateStatusForInstallation` for
where every machine stands, live and across a page reload.

---

## Verify from the admin side

- **Dashboard** — the new worker appears under `/workers`, and its detail page
  (`/workers/<id>`) shows it connected. The global `/workers` screen is an
  instance administrator's view (issue #647); the machine's own owner sees it on
  the project's **Workers** tab and at `/workers/<id>`.
- **Database** — a fresh, ticking heartbeat confirms the transport session is
  live:
  ```sql
  SELECT worker_id, fencing_token, last_heartbeat_at, now() - last_heartbeat_at AS age
  FROM worker_sessions
  WHERE worker_id = '<worker-id>';
  ```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| A `swarm workers` command says "not signed in — run `swarm login`" or "your control-plane session has expired" | Since issue #800 the whole command group authenticates over the network instead of holding `DATABASE_URL`. Run `swarm login` on that machine (`swarm login --status` says who the cached session is); the session lasts `SWARM_SESSION_TTL_HOURS`. |
| `swarm login` says `the control plane refused the login (HTTP 404)` | `SWARM_CONTROL_PLANE_URL` is reachable but its tunnel has no rule for `/operator/*` yet — an admin-side prerequisite this doc doesn't cover; see [`docs/cloudflare-tunnel.md`](./cloudflare-tunnel.md#the-operator-cli-operator). |
| A `swarm workers` command says `SWARM_CONTROL_PLANE_URL is unset` | Same cause: the command group needs the router base URL, not a database. `workers register-and-enroll --control-plane-url <url>` writes it into this checkout's `.env` for you; any other subcommand wants it there (the same value the daemon uses) before you re-run. |
| `register-and-enroll` says `.env already points at <url>, not the requested <other>` | This machine is already onboarded against a different installation, and the command never rewrites a line it did not write. If the machine really is moving, edit `.env` by hand; otherwise drop the flag — an existing assignment is what a second worker on this machine should keep. |
| `register-and-enroll` says `.env assigns SWARM_CONTROL_PLANE_URL no value` | The key is there with an empty value, which is neither a URL to keep nor an absence to fill. Put the URL in, or delete the line and re-run with `--control-plane-url`. |
| `workers set-scm-credential`, `workers remove`, `workers consent` or `workers update-enrollment` says `Worker with ID "…" not found` / `Enrollment with ID "…" not found` for one that exists | All four are strictly the machine owner's since issue #800 — an installation admin gets the same `NOT_FOUND` a stranger does. Sign in as the worker's owner on that machine. |
| `register-and-enroll` says `You are not a member of project "…"` | The project id is **right** and the enrollment has nothing to do with it — the calling operator simply has no membership row for that project (issue #899; before it, this arrived as an indistinguishable `Project with ID "…" not found` and read as a typo). An instance administrator runs `swarm members add <project-id> <your login handle>` on the control-plane host — that command needs `DATABASE_URL` — then re-run. |
| `register-and-enroll` says `Project with ID "…" not found` | Since issue #899 this one means what it says: no project on this control plane carries that id. Check it against the dashboard's Projects list — a project id is not the repository name. |
| `workers enroll --active` (or `register-and-enroll`) says `You do not have permission to perform this action on project "…"` | Approving an enrollment is a `projectAdmin` call, and it is made *after* the enrollment is created — so the enrollment now exists, pending, **with sharing consent already recorded** (that half is the machine owner's own decision and is applied independently of the approval, issue #901). Do **not** enroll again (that reports `This worker is already enrolled in this project.`); the command prints exactly what is left, and a project administrator runs `swarm workers approve <worker-id> <project-id>` — the last step, after which the machine is routable. |
| `workers remove` says `This worker is running a job right now` | The machine is executing a run, and deleting it mid-run would detach that run from the machine still running it (issue #789). Wait for it, or stop the run from the dashboard, then retry. |
| `workers list` says `Open a project you are enrolled in to see its workers.` | The unfiltered roster is an installation administrator's view (issue #647). Pass your own login handle — `workers list <email>` — for your own machines. |
| `swarm run:worker` says `no worker registered for this checkout` | No credential was cached for *this* directory's realpath — the worker was registered on another machine, in another checkout, or before issue #788. Register here, or start the daemon with `SWARM_WORKER_CREDENTIAL` + `SWARM_WORKER_REPO_ROOT` set explicitly, as above. A git *worktree* of the checkout has its own realpath and gets this message too; run the daemon against the main checkout. |
| `Cannot find package 'ws'` (or any other module) on `dev:worker` | `npm ci` was never run on the new machine — its `node_modules` doesn't exist yet. |
| `Missing required environment variable: SWARM_CONTROL_PLANE_URL` even though it's set somewhere | It's set in the wrong file. `dev:worker` only reads `.env` (see the dotenv block above) — put the two variables there, or invoke node directly with `--env-file=<your file>` instead of the npm script. |
| Every dispatch to this worker fails at once with `No operator SCM credential stored for worker '<name>' … on provider '<id>'` | Part 1, step 5 was never run for that provider (issue #765). Run `swarm workers set-scm-credential <worker-id> <provider>`, or set it as the worker's owner at `/workers/<worker-id>` → **Operator source-control credential** (issue #766) — either takes effect on the next dispatch, with no worker restart. |
| A run fails with `this worker's stored operator credential for provider '<id>' did not authenticate` | The stored credential was revoked or expired. Rotate it with the same command; the provider's own message is appended as the cause. |
| A run fails with `this assignment carried no operator SCM credential` | The router predates issue #765 while the worker does not. Deploy the router (see the rollout order in Part 2). |
| `swarm workers update --all <ref>` leaves a machine `queued` | The rollout moves a bounded wave at a time (issue #940) and has not reached it yet — that is what stops a fleet update taking the whole fleet's capacity down. It advances itself from there (issue #941), so nothing is owed: run `swarm workers update --status` again in a minute or two. A machine stuck `draining` is one still finishing a phase, which a rollout never interrupts. |
| `swarm workers update --all <ref>` says the rollout is **HALTED** | A machine reported `failed`/`refused`/`declined`, came back on the build it was asked to leave, or applied and never came back — so nothing further is drained or signalled and the untouched machines stayed in the pool. A machine the rollout had already committed to is settled on the advances that follow and returns to the pool once it settles without failing (issue #1023), so give it a minute before assuming it is stuck. The line under the table is the reason, in the machine's own words. Fix the build, then start a new rollout: a halt is final, there is no resume, and the machine that failed is left drained on purpose so you can look at it (`swarm workers undrain <worker-id>` when you are done). |
| `swarm workers update --all <ref>` is refused because a fleet update is already in progress | Only one rollout runs per operator at a time, so a *different* ref mid-move is refused rather than silently re-targeting the fleet. Run `swarm workers update --status` to see where it stands and wait for it to finish; asking for the **same** ref is never refused, it just nudges and prints it. |
| `swarm workers request-update <ref>` says it is "available to instance administrators only" | It is (issue #922) — asking machines across the installation is an installation-admin act, while `swarm workers update --all <ref>` moves the machines *you* own and needs no such role. Ask an instance administrator to run it, or run `update --all` for your own fleet. |
| `swarm workers request-update <ref>` reports `in-pool` for most of the installation | Those machines are not draining, and draining stays strictly the machine owner's own call (issue #919) — this command asks, it never drains. The line under the table names the owners to ask for a `swarm workers drain <worker-id>`; run `request-update` again once they have. |
| A machine restarted into a build its owner never asked for | Since issue #922 an installation administrator can request one. The machine's own row records who asked — see the `update_requested_by_user_id` query in "Who may ask, and for whose machines"; the API server's `installation-wide worker update requested` log line carries the same act for the whole fleet. |
| `swarm workers update` is refused with "still in the dispatch pool" | The machine has to be drained first (issue #933) — it would otherwise be given new work while it waits to restart. Run `swarm workers drain <worker-id>`, then request the update again, and `swarm workers undrain <worker-id>` once it has reported. |
| `swarm workers list` shows `update <ref> declined` | That machine is running a build that predates issue #975, on a host that had never set the per-host opt-in that build still reads. Nothing reports `declined` any more, so update that machine **by hand once** — `swarm-worker-agent update` on a launchd host, otherwise `git pull && npm ci && npm run build` in its install root followed by a daemon restart — and it will never decline again. |
| `swarm workers list` shows `update <ref> refused` with "is already updating the SWARM install root" | A peer daemon holds the install-root lock and was still holding it after this one had waited the whole window out (issue #973) — an apply that ran past its own step timeouts, or one whose daemon is wedged. Read *that* daemon's outcome, sort out what it reports, then re-issue this one. Nothing was changed on this machine. |
| `swarm workers list` shows `update <ref> refused` with "is on … not on a finished build of the target" | The peer that was moving the install root finished a build of a *different* ref than this daemon was asked for — two requests crossed. Deliberate: re-running the same fetch and build behind it would fight it. Read that daemon's outcome, then re-issue this one for the ref you want. |
| `swarm workers list` shows `update <ref> refused` with "neither the build this machine last proved nor one a daemon here finished applying" | The install root is on a commit nothing here finished putting it there — a daemon that died between its `git checkout` and its `npm ci` leaves exactly that, and restarting onto it would restart onto a tree with no `node_modules` or `dist` (issue #973). Nothing was changed. Check the install root out by hand and run `npm ci && npm run build` there, then re-issue — or, on a launchd host, run [`swarm-worker-agent update`](./launchd-worker-autostart.md#after-a-git-pull--the-update-flow), which runs both steps and restarts the daemons whether or not the pull moved anything. |
| `swarm workers list` shows `update <ref> refused` with "is running a phase from the SWARM install root" | A peer daemon on that machine is mid-phase, and updating would swap the code under its run. The message names the worker: `swarm workers drain <that-worker-id>`, wait for it to go idle, then re-issue. Nothing was fetched or checked out. |
| Several daemons share one install root and only one of them came back on the new build | Not expected since issue #973 — the peers restart themselves and report `adopted`. Check that each daemon was actually *asked*: one comes over on its own update request, so `swarm workers update <worker-id>` moves that daemon alone, while `update --all` / `request-update` / the staged rollout ask every machine. Then check the ones that were asked: a peer that reported `refused` says in its message what it found, and one that reported `adopted` and did not come back has no process supervisor (launchd `KeepAlive` / systemd `Restart=always`). |
| `swarm workers list` shows `update <ref> failed` | The install root could not be moved. The message beside it names the step (`git checkout`, `npm ci`, `npm run build`) and whether the checkout was returned to the build it was on; a failure that could **not** be rolled back leaves the machine on neither build and needs an operator on that host. |
| A machine reports `update <ref> applied` (or `adopted`) but `/workers` shows its **old** build | It could not handshake on the new one and returned itself to its last known good build (issue #934) — the failed-start budget spent without once connecting, or a handshake the control plane rejected outright. Its log says which, on the line before `returned to the last known good SWARM build`; `failedStartBudget` on that line is three plus one per peer that adopted the build, so several healthy daemons restarting together never reach it. The build is what needs fixing; re-requesting the same ref repeats the cycle. |
| A machine is down and its log says `returning to the last known good SWARM build failed` | The return could not be completed, so the install root is on neither build and needs an operator on that host: check out the commit the line names, then run `npm ci && npm run build` there. The daemon stays down on purpose rather than crash-looping; later starts retry the return, so fix the checkout rather than restarting the daemon at it. |
| A requested update never reports anything | Nothing pushed it: the machine has no socket on the router. It is re-stated automatically the next time that daemon connects, so start it (or wait for the supervisor to), and re-read `swarm workers list`. |
| Worker never appears as connected / dispatches stay pending | Enrollment isn't both `active` and `sharing_consent=true` (Part 1, steps 4 and 4b), or the worker process on the new machine isn't actually running / crashed on startup — check its terminal for the two success lines above. |
| An enrollment went `suspended` on its own, right after the machine first connected | The machine declared a checkout of a repository the project does not own — none of its declared repositories, not just its default one (issues #690, #946) — so the control plane suspended the pairing. `/workers/<id>` names both sides on that enrollment block — the machine's checkout, and every repository the project declares. Point `SWARM_WORKER_REPO_ROOT` at a checkout of a repository the project owns (or enroll the machine in the project that matches it), then have a project administrator re-activate the enrollment — a matching declaration never re-activates it by itself. |
| `swarm workers enroll` exits 1 saying the worker's checkout is a different repository | Same mismatch, caught on the write path instead (issues #690, #946) — the message names the machine's checkout and every repository the project owns. Enroll a worker whose checkout is one of those repositories, or re-point this one. |
| `refusing to start — another worker already holds this checkout` | Another daemon on this machine is already running against the same `SWARM_WORKER_REPO_ROOT` (issue #689) — the line names its worker id, or its pid when it has not handshaked yet. Stop that process, or give this worker its own checkout and point `SWARM_WORKER_REPO_ROOT` at it. A lock left by a crashed daemon is reclaimed automatically, so this message always means a live holder — unless its `owner.json` is unreadable, which resolves itself once the lock ages out (15 minutes). |
| Handshake repeatedly logs `worker session already held` | Another daemon really is connected as this worker — two machines were given the same `SWARM_WORKER_CREDENTIAL`, or a stale process is still running on this one. A daemon *reconnecting* after a control-plane restart takes its own lease straight back (it presents the session it holds, and logs `reclaimed=true` on the next `worker transport session established`), so a repeating refusal means a second holder rather than a slow expiry. |
