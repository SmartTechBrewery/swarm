# Public hosting — exploration (deferred)

- **Status:** Explored, **deferred** — 2026-08-12.
- **Decision:** SWARM stays on **privately hosted instances**. A public,
  multi-tenant deployment with open registration is not being pursued for now.
- **Why this document exists:** the analysis below cost real digging through the
  code and through three providers' current API docs. It is recorded so that
  picking the idea back up does not mean re-deriving it. Nothing here is a
  commitment to build anything.

> **Superseded in part by issue #765 (2026-08-28).** §3 and §4 below describe the
> worker operator's SCM credential as an env var that never crosses the transport,
> and argue against storing it server-side. For SWARM's own **private** instances
> that has since changed: the credential is stored per `(worker, SCM provider)`,
> encrypted at rest, and delivered on the assignment frame (ai/ARCHITECTURE.md,
> "Per-worker operator SCM credential"). §4's objections were about a *public,
> multi-tenant* deploy holding *contributors'* personal PATs, which is still not on
> the table — but the "exactly zero secrets travel downward" fact it rests on is no
> longer true, so re-read it with that in mind rather than as a current statement of
> the code. The rest of the analysis is untouched.

> **Superseded in part by issues #799/#800 (2026-08-28).** §2's item 5 says a worker
> can only be registered from a shell on the control-plane host. `workers.register`
> now exists on the tRPC router and is served to an operator CLI over the network at
> `/operator/trpc/*`, authenticated by `swarm login`; `swarm workers` holds no
> `DATABASE_URL` at all. That is still not *dashboard* self-service and still not
> public registration — the missing piece item 5 names — but "a shell on the control
> plane" is no longer the barrier, and the one-time-credential contract it asks for
> is what that procedure already implements.

Each claim is marked by how it was established:
**[code]** verified against this repository, **[docs]** from the provider's own
current documentation, **[judgment]** reasoning that is not a verifiable fact.

---

## 1. What a public deploy would actually be

Only the control plane goes public. Workers stay on their operators' machines —
that is the whole local-first premise, and it does not change under hosting.

| Component | Where | Public? |
| --- | --- | --- |
| `router` — webhooks, `/worker/stream` WSS, dispatch consumer | VPS, Docker | yes: HTTPS + WSS |
| `api` — dashboard SPA + tRPC | VPS | yes, behind an access gate |
| Postgres 16 + Redis 7 | VPS, Docker | no |
| worker (`npm run dev:worker`) | operator's own machine | no — dials out to `SWARM_CONTROL_PLANE_URL` |

**[judgment]** The control plane does almost no work: verify an HMAC, enqueue a
job, keep WebSocket sessions alive, write to Postgres. Every expensive thing —
worktrees, agent CLIs — runs on the operator's machine. So CPU is close to
irrelevant and RAM sits around 600–800 MB idle (Postgres ~150, Redis ~20, two
Node processes at ~150–250 each).

### Hosting options priced in August 2026

| Option | Spec | Cost | Notes |
| --- | --- | --- | --- |
| Mikrus 3.0 | 2 GB / 25 GB | 130 zł/yr (~11 zł/mo) | Cheapest workable tier. LXC (shared kernel), 2 forwarded IPv4 ports. Mikrus 1.0 (384 MB) has no Docker; 2.1 (1 GB) leaves no margin. |
| Mikrus 3.5 | 4 GB / 40 GB | 197 zł/yr | Comfortable, still LXC. |
| Hetzner CAX11 | ARM, 2 vCPU / 4 GB / 40 GB NVMe | ~€3.79/mo | Real KVM, snapshots, backups. The whole stack is pure JS and every image has an arm64 build, so ARM costs nothing here. |

**[judgment]** On a 2 GB box, build images off-machine (CI → registry). `npm ci`
+ `tsc` + the dashboard's Vite build will not fit comfortably alongside a running
Postgres.

**[code]** The `cloudflared` service already in `docker-compose.yml` (profile
`tunnel`) removes the need for any public port or inbound IPv4: the tunnel dials
out, terminates HTTPS, and forwards the WebSocket upgrade transparently. That
neutralises the LXC/port limitations of the cheap tiers entirely.

---

## 2. Gaps in the current code

These are things a public deploy needs that do not exist today. **[code]** each.

1. **No `Dockerfile.api`, and no `api` service in Compose.** Only
   `Dockerfile.router` exists. The API server (`src/api/server.ts`) serves the
   built dashboard from `dashboard/dist` and would have to be containerised or
   run on the host.
2. **`SWARM_SINGLE_USER_MODE=true` in `.env.docker.example`** resolves a
   passwordless localhost admin. Publicly that is an open door; it must be
   `false`, with real users and session cookies.
3. **`CREDENTIAL_MASTER_KEY` becomes mandatory.** Unset, project credentials are
   stored as plaintext in Postgres — tolerable locally, not on a public host.
4. **No public registration.** `authRouter` exposes only `me`,
   `updateDisplayName`, `changePassword`. Users are created by `swarm users add`,
   a CLI needing `DATABASE_URL` — i.e. a shell on the control-plane host.
5. **No way to register a worker from the dashboard.** `workersRouter` has
   `list`, `getById`, `listMine`, `rename`, `enroll`, `setConsent`,
   `updateConstraints`, `roster`, `approveEnrollment`, `setStatus` — but no
   `register`. That is `swarm workers register` only
   (`src/cli/commands/workers.ts:163`), again a shell on the control plane. A
   self-service tRPC mutation showing the raw credential exactly once is the
   missing piece.
6. **Invitations do not exist; the flow runs the other way.**
   `src/identity/membership-request.ts` implements request/approve — a user asks
   to join a `discoverable` project and a `projectAdmin` approves. ADR-001 open
   question #1 settled this deliberately.

---

## 3. The credential model as built

This section is true regardless of the hosting decision, and it is the part most
often misremembered. **[code]** throughout.

| Credential | How many | Where it lives | Who sets it |
| --- | --- | --- | --- |
| **implementer** (`SWARM_OPERATOR_GH_TOKEN` and its Bitbucket/GitLab siblings) | one **per operator machine, per provider** | the worker host's environment — never in Postgres | the operator |
| **reviewer** (`credentials.scm.<provider>.reviewer`) | one **per project** | encrypted in Postgres | `projectAdmin` only (`src/api/routers/credentials.ts:502`) |
| **PM** (`credentials.pm.<provider>.<role>`) | one per project | encrypted in Postgres | `projectAdmin` only |

Three consequences that a multi-tenant design keeps colliding with:

- **The implementer token is not project-scoped and never was.**
  `src/config/operator-token.ts` states it plainly: never persisted, never in
  `ProjectConfig`, never sent over the transport. ADR-001 makes it a principle —
  the control plane "must not require contributors to upload CLI tokens merely to
  make their worker eligible for routing."
- **It is required before a worker can start, not when a project appears.**
  `src/transport/connect-entry.ts:95` resolves it inside `main()` and throws when
  absent, deliberately: *"Resolved up front so a missing token fails startup
  rather than mid-assignment."* The same startup also needs
  `SWARM_WORKER_REPO_ROOT` pointing at a real local checkout, whose `origin` is
  verified against the assigned project at provisioning time.
- **Reviewer must be a different account from every operator's implementer**, or
  dual-persona loop prevention collapses. It is normally a project bot account.

**[judgment]** This actually federates well: pull requests carry real
contributors' identities, while review comes from one project-owned account.

---

## 4. Why storing implementer PATs server-side is the wrong move

The tempting simplification for a hosted product — "drop `.env`, let users paste
a PAT into the app, we encrypt it" — was examined and rejected.

- **[code] It adds exposure rather than removing it.** `git push` happens on the
  worker's machine; that is what keeps source off the network. So a
  server-stored token must still be shipped down the transport and held in worker
  memory. Database plus transit plus worker, instead of worker alone.
- **[code] It would be the first secret ever to cross the transport.**
  `src/config/project-config-slice.ts` withholds not just secret values but the
  credential *reference keys*: *"Omitting the whole block means the worker never
  even learns those reference keys — a strictly tighter boundary than stripping
  secrets that were never present."* Today exactly zero secrets travel downward.
- **[judgment] It changes what a breach costs.** Currently a compromised control
  plane yields project-owned secrets (reviewer bots, PM credentials). With stored
  PATs it yields every contributor's personal, write-scoped SCM token — a
  different class of target, and a much larger ask of anyone volunteering a
  worker.
- **[judgment] It would need an ADR superseding parts of ADR-001 and ADR-004**,
  not a quiet commit.

One distinction is worth preserving: ADR-001's rule is aimed at **agent CLI**
credentials (`claude`, `codex`, `agy`), which genuinely cannot be centralised —
they are machine-bound sessions and the CLI runs locally. An SCM token is an
ordinary bearer and *could* move. The principle does not forbid both equally.

**[judgment]** The real complaint behind "there will be no `.env`" is a packaging
problem, not a storage problem. The worker must already hold
`SWARM_WORKER_CREDENTIAL` locally, so a pairing flow (`swarm login`, device code,
OS keychain) solves the UX without touching the trust model — and unlike a
paste-your-PAT form, it does not foreclose the OAuth path below.

---

## 5. OAuth as the destination — and how the three providers differ

**[judgment]** If the goal is that a user never handles a token by hand, the
answer is OAuth, not a nicer input field. The control plane would hold a
**refresh** token and mint a short-lived access token per assignment. What
crosses the transport is then a 1–2 hour job-scoped credential; a database breach
yields refresh tokens the user can revoke from the provider's own UI, and an
intercepted transport yields an hour.

All three providers support the same shape **[docs]**: authorization code grant,
short-lived access token plus refresh token, and access-token authentication for
git over HTTPS. So one contract fits — `beginAuthorization` / `exchangeCode` /
`refresh` / `gitCredentials`, with the differences declared as data on
`SCMProviderManifest`, exactly as `credentialRoles` already are.

The differences that matter **[docs]**:

| | GitHub | Bitbucket Cloud | GitLab.com |
| --- | --- | --- | --- |
| Access token life | 8 h (user-to-server) / 1 h (installation) | 1 h | 2 h (`expires_in: 7200`) |
| Refresh token | `ghr_`, 6 months | rotating; an **unused** one dies after 3 months | rotating |
| Refresh destroys predecessors? | no | yes — old expires shortly after use | yes — invalidates both previous tokens |
| Scope granularity | per-repository **and** per-permission, chosen at each mint | consumer-level scopes, account-wide | `api` is broad; `root_namespace_id` at authorize is the closest narrowing |
| PKCE | — | — | yes (`code_challenge_method=S256`) |
| Git-over-HTTPS user | `x-access-token` | `x-token-auth` | `oauth2` |

Four design consequences follow:

1. **Refresh must be centralised and serialised.** Because GitLab and Bitbucket
   destroy the predecessor on rotation, two concurrent refreshes for one user
   would leave one of them holding dead credentials. The control plane owns
   refresh, under a lock per `(user, provider)`, with an atomic write — and the
   worker asks for a token rather than refreshing one. **[judgment]** With more
   than one concurrent run this is not hypothetical.
2. **Bitbucket needs an inactivity story.** A refresh token unused for three
   months is dead and the user must repeat the whole flow. That is a normal
   state to model (worker reports it, dashboard offers re-authorisation), not a
   run failure.
3. **Least privilege is only fully available on GitHub**, whose installation
   tokens are minted against an explicit repository list and permission map.
   Bitbucket and GitLab grant at account level. **[judgment]** That asymmetry
   should be stated to users, because "authorise SWARM" means materially
   different things across the three.
4. **GitHub forces an identity choice the others do not offer.** Installation
   tokens act as the app; user-to-server tokens act as the user. The implementer
   must use **user-to-server**, or every commit is authored by the app and both
   contributor attribution and the persona split are lost.

**[judgment]** One wrinkle to plan for: `SWARM_AGENT_TIMEOUT_MS` defaults to 30
minutes but runs can be deferred and resumed, so a one-hour Bitbucket token can
expire mid-phase. The worker needs a "give me a fresh token" path over the
existing transport, alongside today's `/worker/delivery/*` routes.

**What OAuth would not solve:** it covers the implementer only. The reviewer is
still one project-owned bot account, and the PM credentials (Linear, Jira,
Trello) have their own separate authorisation stories.

---

## 6. What this exploration already changed

One correction landed rather than waiting on the decision (commit `a7ee485`):
`docker-compose.yml`, `.env.docker.example`, and `docs/configuration.md` all
claimed the router needs `SWARM_OPERATOR_GH_TOKEN` for `isSelfAuthored` loop
prevention and for `personaForEvent` routing. Both reasons were stale — board
identity moved to the PM provider's own credential (issue #537), comment gates
key on SWARM's marker (issue #443), and persona routing (`personaForActor`) runs
worker-side in the trigger handlers. The router's only use of it is
`POST /worker/delivery/pr-comment` with the implementer persona (issue #444), and
it is optional there.

**[judgment]** That same route is where a public deployment would have hurt
first: the router holds one operator token for every worker it serves, so every
contributor's Respond-to-review reply would be authored by the instance's
account. Worth remembering if this is ever revisited.
