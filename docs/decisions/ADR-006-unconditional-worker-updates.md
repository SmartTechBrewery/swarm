# ADR-006: A worker updates when the installation asks it to

- **Status**: accepted
- **Issue**: [#975](https://github.com/SmartTechBrewery/swarm/issues/975)
- **Date**: 2026-09-15

## Context

Issue #933 gave a machine a way to be moved to a build from the control plane, and put a
per-host opt-in in front of it: `SWARM_WORKER_SELF_UPDATE`, read from the daemon's own
environment and never from the wire. Issue #922 then let an installation administrator
ask machines they do not own (`swarm workers request-update`), and the flag was framed as
the host operator's veto over that.

The flag **defaults to off**, so a machine that never deliberately opted in declines every
update and keeps running whatever it started with. The fleet drifts by default, and the
drift is silent: the daemon reports `declined` and carries on.

That is not a theoretical cost. On this installation four daemons ran a build from hours
earlier while the checkout under them had moved on, and only a staleness mark on the
dashboard eventually surfaced it — after two separate misdiagnoses that both started from
"but these machines look fine".

Re-examined against `src/worker/self-update.ts`, the flag protects considerably less than
that framing suggests, because the mechanism's own guards are what bound an
administrator's reach.

## Decision

**Remove `SWARM_WORKER_SELF_UPDATE`.** Not default it to on: a setting that still exists
is a setting that gets set — and gets left set on the one machine nobody remembers. The
two installer flags that existed solely to write it into a launchd plist,
`swarm-worker-agent install --self-update` / `--no-self-update`, go with it.

## Why that is safe

Four things bound an update, and none of them is a per-host setting:

1. **The fetch takes no URL and no refspec.** It is `git fetch <remote>` — a remote
   *name* — so the only code that can ever arrive is what the install root's own
   already-configured remote already says it fetches. Nothing on the wire can redirect it.
2. **The target must be an ancestor of the branch the install tracks**
   (`git merge-base --is-ancestor`), so a machine can only be moved to code already on the
   branch it follows, never onto a side branch somebody pushed.
3. **A dirty install root is refused outright**, so uncommitted work is never overwritten.
4. **The drain precondition is unchanged**, and remains strictly the machine owner's: an
   update only ever reaches a machine already out of the dispatch pool (issue #919).

So an administrator cannot point a machine at another repository, or at a branch they
pushed. What remains is the ability to move a machine to an **older** commit of the branch
it already follows — a downgrade, which is visible in `swarm workers list`, bounded, and
reversible by asking for the newer ref. Issue #934's automatic rollback covers the other
direction: a build that starts repeatedly without connecting returns itself.

Weighed against a fleet that silently stops updating, that veto is not worth its cost.

## Consequences

- **`declined` becomes a legacy status.** Nothing reports it any more, but it stays in
  `WORKER_UPDATE_STATUSES`, on the wire, and in the halting set: a daemon on a build
  predating this change still reports it, and this very change reaches the fleet *through*
  the update mechanism. Narrowing the enum would make such a report fail to parse at the
  report route. A machine showing `update <ref> declined` is on an old build — update it
  by hand once (`git pull && npm ci && npm run build`, then restart) and it never declines
  again.
- **A stale value is inert, not an error.** A `SWARM_WORKER_SELF_UPDATE` left in a launchd
  plist, an `.env`, or a shell profile is an environment variable nothing reads. It breaks
  nothing, and the next `swarm-worker-agent install` rewrites the plist without it.
- **`--self-update` / `--no-self-update` now fail as unknown options**, which is the honest
  answer for flags that no longer exist.
- **The rollout order is unchanged** (`docs/onboarding-worker.md`): control plane first,
  workers after. Machines still on the old build report `declined` until they are moved —
  by hand for the ones whose hosts never opted in, which is exactly the set this decision
  exists to unstick.
- **If a veto is wanted again, it belongs at the role level** — who may *request* an
  update — rather than as a per-host environment variable that fails closed and silently.
