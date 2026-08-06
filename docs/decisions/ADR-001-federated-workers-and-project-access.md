# ADR-001: Federated workers and project access

- **Status:** Proposed
- **Date:** 2026-07-18
- **Decision owners:** SWARM maintainers

## Context

The current MVP is deliberately single-user: the router, queue, database, and
host-run worker belong to one developer. The target SWARM architecture is
different. A centrally hosted control plane should coordinate projects for a
team without receiving source code, while independently operated local daemons
execute agent CLIs on their operators' machines.

SWARM itself is expected to be an open-source project developed with help from
contributors who may choose to run a worker and offer the CLIs available on
their machines. Different users can have access to different CLIs, models,
credentials, capacity, and projects. Therefore a project cannot be the sole
owner of all execution configuration.

At the same time, duplicating every project setting for every user would make
shared project policy inconsistent and difficult to administer.

## Decision

SWARM will model a hosted installation as a federation of users and their
local workers. Project policy, user identity, and permission for a particular
worker to execute work for a project are separate concerns.

### Ownership and configuration scopes

| Scope | Owns | Examples |
| --- | --- | --- |
| Installation | Cross-project administration and platform policy | instance administrators, global limits, authentication policy |
| Project | Shared engineering and integration policy | repository, PM/SCM bindings, pipeline rules, branch policy, project-level concurrency |
| User / worker | A locally operated execution environment | declared CLI capabilities, local daemon identity, current availability, locally held CLI credentials |
| Worker-project enrollment | Permission and execution overrides for one worker in one project | allowed CLIs, concurrency allocation, eligibility for phases or queues, owner sharing consent, approval state |

Secrets used to authenticate local agent CLIs remain on the operator's machine.
The central control plane may store capability and health metadata, but must not
require contributors to upload CLI tokens merely to make their worker eligible
for routing.

### Access model

Authorization has three independent layers:

1. **Installation role** answers whether a user can administer the hosted
   SWARM installation. An `instanceAdmin` can access and administer every
   project and its memberships.
2. **Project membership** answers whether a user can see or administer a
   project. Initial roles are `projectAdmin`, `member`, and `contributor`.
3. **Worker-project enrollment** answers whether a specific worker operated by
   that user may receive work for that project, and under which constraints.

Project visibility, joining a project, registering a worker, and automatic
task routing are distinct permissions. An open project may allow any
authenticated user to join or request enrollment without automatically giving
every newly registered worker unrestricted access to every task.

The worker operator controls whether a project administrator may use that
worker for automatic project work. This project-scoped sharing consent is an
explicit, revocable enrollment setting and is a hard prerequisite for routing;
project administration or membership alone cannot override it. The dashboard
must offer a fast self-service control for this setting because contributors
will use it frequently.

### Worker capabilities and availability

A worker declares the agent CLIs it supports in its agent configuration (for
example `codex`, `claude`, or `antigravity`). For the first implementation this
self-declaration is trusted for authorization and routing eligibility.

The router must nevertheless distinguish declared capability from current
availability. A worker reports its active capabilities and health when it
connects and through heartbeats; a missing, disconnected, or unhealthy worker
is not selected for new work. Later versions may verify installed CLIs or add
maintainer approval and reputation/trust policies, but those are not required
for the initial model.

### Routing and delivery

Tasks belong to projects. The scheduler selects only an eligible, connected
worker with active owner sharing consent, project enrollment, required CLI
capability, and available capacity. Routing follows these rules:

1. When a work item has an assignee that maps to a SWARM user, it may run only
   on an eligible worker owned by that user. The scheduler must not fall back
   to another user's worker; it waits until an eligible worker of the assignee
   is free.
2. When a work item has no assignee, it may run on the first free eligible
   project worker according to the scheduler's deterministic queue ordering.

Assignment is therefore an execution-affinity rule, not a grant of access and
not a way for a project administrator to bypass the worker owner's consent.

> **Amended (issue #469): affinity applies per phase, and `planning` is exempt.**
> Rule 1's "must not fall back to another user's worker" is unconditional as
> written, which is right for a phase whose *point* is running on the owner's
> machine — `implementation`, which writes source in a worktree under the
> operator's own token. It is wrong for `planning`, which produces no branch, no
> worktree and no pull request: its whole output is board structure written under
> the project's own credential, so nothing about it belongs on one machine rather
> than another, and holding an item for its assignee's worker only leaves it
> waiting while a capable worker sits idle. `planning` is therefore dispatched to
> any eligible, capable worker regardless of assignment (`AFFINITY_GATED_PHASES`,
> `src/worker/eligibility-gate.ts`); every other phase is unchanged.
>
> The exemption was originally argued from a capability asymmetry instead — a
> DB-free remote worker refused Planning, so an item assigned to a user whose only
> machine was such a worker was never plannable at all. Issue #536 made every
> daemon run every phase and killed that premise; the exemption stands on the
> reason above, which does not depend on it.

> **Amended (issue #542): every worker has the same permissions.** `planning` was
> for a time the one phase an enrollment could be *permitted* only on a worker whose
> owner is an instance admin. That rule is gone. `instance_admin` is a role about
> administering the installation — the API, the dashboard, the router — not about
> workers, and using it as a per-phase switch conflated installation administration
> with pipeline authorization while granting far more access than intended (it also
> bypasses membership entirely in `listAccessibleProjectIds`). Board authorship is
> already authorized at a better scope by the enrollment itself: the worker owner
> chooses `allowedPhases` (issue #509) and a project administrator approves the
> enrollment, and since issue #537 the board writes execute control-plane side under
> the *project's* PM credential, which no worker ever holds. Whether a machine may
> run Planning for a project is now decided by the same three conditions as every
> other phase — the daemon declared it, the project has it enabled, and the
> enrollment permits it. Enrollments stripped of `planning` by migration
> `0043_backfill_planning_instance_admin.sql` stay stripped: opting back in is the
> owner's explicit choice, not a silent re-grant.

For community-contributed workers, execution results are untrusted until they
pass the project's normal delivery controls. Changes are isolated in a
worktree and delivered through the repository's branch/PR, review, and CI
process; worker participation does not grant merge or administrator rights.

## Consequences

- The future data model needs users, workers, project memberships, and
  worker-project enrollments rather than only project configuration.
- Existing per-project agent settings should be classified into shared policy
  versus worker-specific execution overrides before multi-user support is
  implemented.
- The dashboard needs project member management and worker enrollment views in
  addition to existing project settings.
- The future daemon/control-plane protocol needs authenticated worker identity,
  capability registration, and heartbeats.
- The scheduler needs assignee-to-SWARM-user resolution and deterministic idle
  worker selection, while respecting worker-owner sharing consent.
- The dashboard needs a frequent, self-service worker-sharing toggle for the
  worker owner, separate from project-admin enrollment controls.
- An installation administrator has global visibility, while ordinary users
  see only projects for which they have membership or an explicitly allowed
  public-discovery view.

## Non-goals

- This ADR does not change the current single-user MVP or introduce remote
  authentication yet.
- It does not prescribe the final database schema, OAuth provider, trust score,
  payment/reward system, or sandbox technology.
- It does not make an open-source project anonymously executable by arbitrary
  machines; the project retains control over worker enrollment and routing.

## Open questions

1. ~~Should joining an open project create an immediate `contributor` membership
   or a pending request approved by a `projectAdmin`?~~ **Resolved (#281 task 5):**
   a **pending request approved by a `projectAdmin`/`instanceAdmin`**, granting
   `contributor`. This keeps joining separate from execution — the project keeps
   control over who becomes a member rather than every authenticated user
   self-enrolling. A project opts in via `visibility: discoverable`; discovery
   (`projects.listDiscoverable`) and requesting (`projects.requestMembership`)
   grant no access on their own, and never grant worker registration or routing.
   The surfaces could support immediate `contributor` by skipping the pending
   state, but the request/approve default is the shipped behaviour.
2. Which task classes, if any, may be routed automatically to newly enrolled
   community workers versus trusted maintainers only?
3. Does a project owner approve workers individually, or do project-wide
   enrollment policies decide automatically?
4. Which project configuration fields may a worker override, and which are
   always enforced as shared project policy?
5. ~~How is a PM-provider assignee reliably mapped to a SWARM user when their
   provider identity is missing, ambiguous, or not linked yet?~~ **Resolved
   (#130 Phase 1):** through an explicit **identity link**, not inference. A
   work item's assignees are read provider-neutrally
   (`WorkItem.assignees`/`PMProvider.supportsAssignees`, `src/pm/types.ts`), and
   a `(provider, handle)` pair is linked to at most one SWARM user in
   `user_identities` — a unique index, with keys normalized (trimmed +
   lowercased), so **ambiguity is impossible by construction**. A missing or
   unlinked handle resolves to nothing (`src/identity/assignee-resolver.ts`
   returns `undefined`) rather than to a guess, which the routing gate treats as
   the unassigned path. Links are seeded by an operator (`swarm identities
   link`); automatic linking (OAuth / SCM account discovery) remains open, but
   the resolution seam does not change when it arrives.
