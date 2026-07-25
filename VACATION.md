# Vacation runbook — autonomous operation from 2026-07-25

SWARM runs with less human supervision than it ever has from **2026-07-25**. This
file is the anchor for that period: what changed, what is live versus dormant,
how to stop it, and how to get back to known-good ground.

Written on 2026-07-25, at the start of the period. If you are reading this after
the fact, treat the **Facts** section as reliable and the **Risk** section as it
was understood on day one.

---

## 1. Rollback anchor

| | Commit | When | What it is |
| --- | --- | --- | --- |
| **Last pre-period state** | `5963482` | 2026-07-24 20:51 | Merge PR #432 (issue-428) — the last commit before the risky period. **This is what to go back to.** |
| **Start of the risky period** | `d4cae73` | 2026-07-25 07:57 | Merge PR #433 (issue-429) — the first merge commit of 2026-07-25, i.e. the marker asked for. |

Everything from `d4cae73` onward is in scope for "start over".

```bash
# Inspect the period without changing anything
git log --first-parent --oneline 5963482..main

# A branch at the last known-good state, to compare or build from
git switch -c pre-vacation 5963482
```

### Going back for real — read this before you do

**`git reset --hard` on `main` is the wrong tool.** `main` is pushed and other
work (and possibly SWARM's own runs) is built on it; rewriting it needs a
force-push and breaks every clone and open PR. Prefer reverting the merges, newest
first, which is honest history and safe for collaborators:

```bash
# Revert the period, newest merge first. -m 1 keeps main's first-parent line.
for c in 0974aef 0a60a7f 34a3cd5 65fc69a d4cae73; do git revert -m 1 --no-edit "$c"; done
```

Only if you genuinely want history rewritten and accept the consequences:

```bash
git switch main && git reset --hard 5963482 && git push --force-with-lease
```

**Reverting code does not undo the side effects.** This is the part that makes
"start all over" more than a git operation:

- **Postgres** keeps every `dispatches`, `runs`, `run_output_events`,
  `review_verdicts`, `worktree lease` and enrollment row created during the
  period. A code revert leaves that state in place, and some of it encodes
  decisions the reverted code made (e.g. a consumed review-verdict slot still
  counts against the two-verdict cap for that PR/head).
- **GitHub** keeps every branch, PR, review, comment, label and board move SWARM
  made. Nothing on the board or in the repo un-happens.
- **Worktrees** under `.swarm-workspaces/` may still exist, possibly leased. `swarm
  run reset <runId>` (#429, landed in this period) is the supported way to clear a
  wedged run; the dashboard's run-detail page has the same action.

So the practical order is: **stop SWARM → revert code → then decide what DB and
GitHub state to clean up**, rather than assuming the revert did it.

---

## 2. Facts — what landed on 2026-07-25

Five merges, newest last:

| PR | Issue | Change |
| --- | --- | --- |
| #433 | #429 | `swarm run reset <runId>` CLI for a wedged run |
| #434 | #427 | Worktree-lease take-over race: orphaned leases are reclaimed instead of wedging runs as `live-leased` |
| #435 | #426 | Split children get the `planned` label at creation |
| #437 | #417 | **Implementation and Review run DB-free on a remote worker**, via the control-plane delivery API |
| #439 | #366 | Dashboard collapses duplicate queued dispatches from one board move |

The one that changes behaviour meaningfully is **#437**. It added:

- a shared delivery client (`src/transport/delivery-client.ts`) and eight
  `POST /worker/delivery/*` routes (SCM metadata, PM metadata, one PM read, three
  review-verdict-ledger operations);
- a delegate-less PM provider for a worker with no database
  (`createWriteOnlyTransportPmProvider`);
- a review-verdict ledger seam (`src/pipeline/review-ledger.ts`) so a DB-free
  Review still honours the two-verdict cap (#235) and the re-review signal (#328);
- `implementation` and `review` added to `SUPPORTED_DB_FREE_PHASES`.

### What is live, and what is dormant

**The DB-free path is opt-in and, by default, dormant.** `runAssignmentDbFree` has
exactly one caller — `src/transport/connect-entry.ts`, i.e. `npm run
dev:worker:connect` — and assignments only get pushed to it when
`SWARM_DISPATCH_MODE=transport` on both the router and the worker (default
`in-process`). If you leave dispatch in-process and do not run the remote worker,
**none of #437's new behaviour executes**; the delivery routes sit unused.

What *is* live regardless: the shared-client refactor of the two existing transport
delegates (covered by their tests), and the docs/comment changes.

---

## 3. Risk — what to look at first if something looks wrong

Ranked by how likely each is to bite while unattended.

1. **Auto-review does not fire on a federated PR (#397).** If you enable the
   remote-worker path, Implementation opens PRs as *your own account*, and the
   review trigger still keys on persona authorship (`isSwarmAuthoredPr` →
   `isSwarmBot`). Those PRs will sit unreviewed. This is the single reason not to
   turn on transport dispatch and walk away. #397 is top of Backlog.
2. **A dependency-blocked Implementation fails terminally instead of re-checking
   (#438).** On any transport path, `classifyDeferrable` does not model
   `DependencyBlockedError`, so a work item whose prerequisites are still open
   settles `failed` with the "must be done first" message rather than entering the
   bounded recheck it gets in-process. Loud and safe — it will not build out of
   order — but it needs a manual re-dispatch.
3. **An unrecognised failure kind is silently treated as a rate-limit.**
   `src/router/dispatcher.ts` does `(result.failureKind ?? 'rate-limit')`, so any
   kind the worker reports that the router does not know becomes a slow retry
   instead of a clear failure. Relevant if anything new starts reporting failures.
4. **Worktree collisions still touch the database on every path.**
   `GitWorktreeManager` reaches `hasLiveWorktreeLeaseOwner` when a checkout for the
   task already exists. On a DB-free worker that call has no database. It is only
   reachable on a *collision*, and it predates this period, but it is the known
   sharp edge if remote runs start failing oddly on retry.
5. **`respond-to-review` and `planning` are refused on a DB-free worker** by the
   supported-phase gate, with a clear result. Expected, not a bug — #418 is the
   follow-up for respond-to-review.

---

## 4. Kill switches — fastest first

1. **Take one item off automation:** remove the `swarm` label from its issue.
   `pipeline.automationLabel` (default `swarm`) is checked before Planning or
   Implementation starts, so an unlabelled item is skipped at every dispatch. This
   is the supported way to stop SWARM touching a specific task.
2. **Stop the executor:** stop the worker process (`npm run dev:worker`, or
   `npm run dev:worker:connect` for the remote one). Pending work stays durable in
   Postgres and resumes when a worker comes back — nothing is lost, nothing
   proceeds.
3. **Turn off the new path specifically:** unset `SWARM_DISPATCH_MODE` (or set
   `in-process`) on the router and worker. Dispatch returns to the host worker and
   the DB-free executor stops receiving assignments.
4. **Stop ingestion entirely:** stop the router, or disable the GitHub webhook /
   Cloudflare tunnel. Deliveries stop arriving; GitHub retries for a while.
5. **A single wedged run:** `swarm run reset <runId>`, or the "Reset & restart"
   action on the run-detail page.

Remember that config lives in **Postgres**, not the file: after editing
`swarm.config.json` run `swarm config apply` (or `npm run db:seed`) for the running
services to see it.

---

## 5. When you are back

- `git log --first-parent --oneline 5963482..main` — everything that landed while
  you were away.
- The board: <https://github.com/orgs/SmartTechBrewery/projects/6/views/1>. Check
  **In review** and **In progress** for items SWARM started and did not finish, and
  the Runs page for `failed` / `deferred` runs.
- Open PRs SWARM authored: `gh pr list --repo jkwiecien/swarm --state open`.
- Known-gap issues opened in this period, in priority order: **#397** (federated
  auto-review), **#398** (attribution), **#438** (dependency deferral over the
  transport), **#418** (DB-free respond-to-review).
- ADR-004 §3/§4 are the accepted-but-unbuilt decisions behind #397/#398 —
  `docs/decisions/ADR-004-worker-transport-and-split-delivery.md`.

---

## 6. Keeping this file honest

This is a point-in-time runbook, not a living document. If the period extends or
another risky change lands, add a row to the table in §2 and a line to §3 rather
than rewriting the anchor — the anchor's value is that it does not move. Delete the
file when the period is over and its content has been folded into
`docs/status.md` or an ADR.
