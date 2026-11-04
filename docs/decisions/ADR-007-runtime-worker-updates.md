# ADR-007: A runtime-based worker is moved to any signed release

- **Status**: accepted — partly supersedes [ADR-006](./ADR-006-unconditional-worker-updates.md),
  for runtime-based workers only
- **Issue**: [#1305](https://github.com/SmartTechBrewery/swarm/issues/1305), recording
  [#1282](https://github.com/SmartTechBrewery/swarm/issues/1282),
  [#1302](https://github.com/SmartTechBrewery/swarm/issues/1302),
  [#1303](https://github.com/SmartTechBrewery/swarm/issues/1303) and
  [#1304](https://github.com/SmartTechBrewery/swarm/issues/1304)
- **Date**: 2026-11-04

## Context

ADR-006 removed the per-host veto on worker updates because four guards in the update
mechanism already bound what an administrator can ask a machine to do. Every one of
them is about a **SWARM clone**: an install root with a remote, a tracked branch, a
working tree that can be dirty, and a build made in place.

A **runtime-based** worker (issue #1281) has none of that. `swarm-launcher run
<workerId>` starts it from a profile, `~/.swarm/workers/<workerId>/profile.json`, on an
immutable, versioned runtime under `~/.swarm/runtimes/<version>/`, and nothing on the
host is a git checkout of SWARM. `swarm workers update <worker-id> vX.Y.Z` moves it by
installing a different runtime and selecting it (`src/transport/runtime-update.ts`), not
by fetching and building. So ADR-006's guards either cannot be applied or have nothing
left to guard, and the question it answered — what bounds an administrator's reach —
needs answering again for this kind of worker.

## Decision

**For a runtime-based worker, the publisher's signature is the trust boundary.** A
worker installs a runtime only when its minisign signature verifies against the
launcher's own trusted key, `deploy/worker-runtime/minisign.pub` under the launcher's
install root (`TRUSTED_KEY_PATH`, `src/launcher/main.ts`), and the signature's trusted
comment names the version and commit the worker asked for (`ensureRuntime`,
`src/launcher/runtime-store.ts`). The launcher hands the daemon that key's path as
`SWARM_RUNTIME_TRUSTED_KEY` and removes any ambient value, so neither the environment
nor a copy shipped inside a runtime can choose the key a worker trusts.

**The control plane only locates a release.** Asked for a version
(`/worker/runtime/manifest?version=<v>`, `src/router/worker-runtime.ts`), it answers
either its own signed artifact or the publisher's GitHub Release `v<v>`
(`PUBLISHER_RELEASES_REPOSITORY`): where to download it, its size, its SHA-256 and its
whole `.minisig`. It never verifies the signature for the worker and never vouches for
the bytes; the worker does that against its own key.

**An administrator may pick any signed release, older ones included, and nothing
unsigned.** A target is a version (`vX.Y.Z` or `X.Y.Z`) or the installation's own
commit, which names the installation's own release. A branch, any other commit, or a
version with no signed release is refused.

ADR-006's guards map onto that as follows:

1. **"The fetch takes no URL and no refspec" — replaced.** A runtime does arrive from a
   URL on the wire, possibly an absolute one on GitHub. What made a remote name safe
   was that nothing on the wire could redirect it; what makes a URL safe here is that
   nothing at that URL installs unless the trusted key verifies it.
2. **"The target must be an ancestor of the tracked branch" — replaced.** There is no
   branch. The equivalent bound is "a release this publisher signed", and the trusted
   comment binds version and commit, so a signature for one release cannot be passed
   off as another's.
3. **"A dirty install root is refused" — nothing left to protect.** Runtimes are
   read-only (`0444` files, `0555` directories) and an installed version is never
   modified: a second install of it returns the first, and one whose recorded commit
   disagrees is refused rather than replaced. There is no uncommitted work to
   overwrite.
4. **"The drain precondition is unchanged" — unchanged.** An update still reaches only
   a machine its owner has taken out of the dispatch pool, and the wait-until-idle, the
   report and the exit are the same `src/transport/worker-update.ts` code a clone runs.
   So is the supervision precondition (issue #997): the worker is moved by exiting for
   its launcher to be started again.

**Rollback is per worker, counted by the launcher.** Moving records the new selection
together with a pending-verification record in the worker's own `state.json`
(`src/launcher/worker-profile.ts`). `swarm-launcher run` counts each start of the
selected version and writes the count *before* the runtime runs, so a runtime that dies
before reaching any code of its own is still counted. After `MAX_FAILED_STARTS` starts
in a row without a session — the same budget as a clone's, and pinned equal to it by a
test — or at once when the control plane rejects the handshake outright
(`src/transport/runtime-verification.ts`), the launcher selects and starts the version
the worker was moved from. The daemon's first session clears the record and makes the
version the worker's `lastKnownGoodVersion`.

**No shared install-root lock.** A clone's daemons share one install root, so an update
needs a host-wide lock, peer adoption and a refusal while a peer is mid-phase. A
runtime-based worker selects its own version and the old one stays on disk, so no peer
is disturbed. The only thing worth sharing is the download, and the store's
per-version lock (`.locks/<version>.lock`) gives one download per version per host
however many workers ask for it.

**Cleanup keeps what a worker can still need.** An installed version is removed only
when no worker's `state.json` names it — as its selected, last-run or last known good
version, or as either side of a pending verification (`pruneRuntimes`,
`referencedRuntimeVersions`). So the version a worker runs and the one it would roll
back to are never removed from under it.

**Clone-based workers keep ADR-006 unchanged.** Everything above applies to a worker
the launcher started (it sets `SWARM_WORKER_ID`); a daemon started by
`swarm run:worker` or `npm run dev:worker` takes the git path and all four of ADR-006's
guards, exactly as before.

## Why that is safe

What bounded an administrator under ADR-006 was "code already on the branch this
machine follows, from the remote it already has". What bounds one here is "a runtime
this publisher signed", checked on the machine against a key the machine already has.
That is at least as narrow: the key decides, not the control plane, and a compromised
or misconfigured control plane can at worst name a signed release the worker would
have accepted anyway, or one it then refuses to install.

What remains is the same thing ADR-006 accepted: the ability to move a worker to an
**older** release. It is visible (the worker re-declares its build at the next
handshake), bounded (only signed releases exist to move to), and reversible by asking
for the newer version. A release that cannot run here undoes itself through the
launcher's rollback, and the host's other workers never notice either way.

Nothing new becomes a per-host setting. As in ADR-006, the drain stays the machine
owner's control, and a veto, if ever wanted, belongs at the role level.

## Consequences

- **A version other than the installation's own needs GitHub.** The control plane
  locates it anonymously, so it spends GitHub's unauthenticated API budget (60 an hour
  per control-plane IP), and only a caller holding a worker credential or an operator
  session token can make it ask. The worker then downloads the tarball from GitHub
  itself. A version no worker has asked about before is unavailable while that budget
  is spent.
- **Only public releases can be located.** A private fork's releases cannot, and the
  publisher is a constant (`SmartTechBrewery/swarm`), not a setting: the launcher
  trusts that publisher's key, so no other source could produce a runtime that
  verifies. Such an installation can still move its workers to its own version.
- **A runtime older than the `launcherProtocol` stamp cannot be an update target.**
  A runtime whose `build-info.json` does not declare `RUNTIME_LAUNCHER_PROTOCOL` has a
  daemon that never clears the pending-verification record, so the launcher would
  abandon it after a few healthy starts; a move to one is refused before anything is
  recorded. That makes the oldest reachable release the first one that stamps it.
- **Installing the launcher trusts the installation over TLS** (issue #1312).
  `curl -fsSL https://<installation>/install.sh | sh` downloads the launcher package
  from that installation and checks it against the SHA-256 the same installation
  serves, so the check catches a damaged download, not a malicious server: the
  launcher is not signed, exactly as `curl | sh` always trusts whoever answers. The
  trust this ADR decides is unchanged downstream of it — every runtime the launcher
  installs is still verified against the minisign key shipped in the package.
- **No trusted key means no new version.** A launcher without
  `deploy/worker-runtime/minisign.pub` installs nothing new — the store fails closed —
  and still starts versions already installed. A move to a version not yet on the
  host then fails and leaves the worker where it was.
- **A worker that cannot go back stays down.** When the version it was moved from is
  no longer installed, the launcher exits 1 and keeps the record rather than
  crash-looping on the version that never connected. Cleanup never removes that
  version while the record names it, so this needs something outside SWARM to have
  removed it.
- **The evidence is on the host, in two logs.** The daemon writes the promotion, an
  outright handshake rejection and each removed version to
  `<profileDir>/logs/worker.log`; the launcher writes each counted start and the
  return to its own output, which its supervisor captures. See
  [`docs/onboarding-worker.md`](../onboarding-worker.md#updating-a-runtime-based-worker)
  and [`docs/MANUAL.md`](../MANUAL.md), "Updating a runtime-based worker".
