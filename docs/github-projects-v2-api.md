# Spike: GitHub Projects v2 GraphQL API — item/field shape, `projects_v2_item` webhook, auth scopes

Reference notes for building SWARM's PM provider (`src/integrations/pm/github-projects/`).
GitHub Projects (v2) is **GraphQL-only** — there is no REST endpoint for reading or
writing item field values, so every read/move the provider does goes through the GraphQL
API. This document captures the concrete shapes SWARM needs, verified against the **real**
board (project `3`, node id `PVT_kwHOAC3TF84BcNwD`, owner `jkwiecien`) with `gh api graphql`
on 2026-07-02 — not recited from memory.

> **Scope.** This is a spike: a reference doc, not runtime code. It unblocks the Phase-2
> build issues (the `PMProvider` adapter, the GraphQL client, and `projects_v2_item`
> webhook routing) but implements none of them. See `ai/ARCHITECTURE.md` → "PM: GitHub
> Projects" for how these pieces fit the pipeline, and `src/pm/ids.ts` /
> `src/integrations/pm/github-projects/config-schema.ts` for the ID/config scaffolding
> already in place.

---

## 1. The object model

Four opaque node IDs, all bare strings that look interchangeable but aren't — this is
exactly what `src/pm/ids.ts` brands (`ProjectV2Id`, `FieldId`, `SingleSelectOptionId`,
`WorkItemId`) to make a compile error:

| Concept | GraphQL type | Example node ID | SWARM brand |
| --- | --- | --- | --- |
| The board | `ProjectV2` | `PVT_kwHOAC3TF84BcNwD` | `ProjectV2Id` |
| A custom field (e.g. Status) | `ProjectV2SingleSelectField` | `PVTSSF_lAHOAC3TF84BcNwDzhW4MKo` | `FieldId` |
| One value of a single-select field | (option) | `47fc9ee4` | `SingleSelectOptionId` |
| A card on the board | `ProjectV2Item` | `PVTI_lAHOAC3TF84BcNwDzgxczms` | `WorkItemId` |

Note the option ID (`47fc9ee4`) is a short hex string, **not** the `PVT*`-prefixed
base64 node ID the others use — it's an ID local to its field, not a global node.
A work item's `content` is the backing `Issue` / `PullRequest` / `DraftIssue`; the item
itself is just the card that wraps it plus its field values.

---

## 2. Reading the board's fields (setup / config discovery)

The provider needs the Status field's node ID and its option IDs to build the
`statusOptions` map in `config-schema.ts`. One query enumerates every field; single-select
fields expand to their options:

```graphql
query($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      id
      number
      title
      fields(first: 20) {
        nodes {
          __typename
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}
```

`gh api graphql -f query='…' -F projectId=PVT_kwHOAC3TF84BcNwD` against the real board
returns (Status field trimmed to the interesting part):

```jsonc
{
  "__typename": "ProjectV2SingleSelectField",
  "id": "PVTSSF_lAHOAC3TF84BcNwDzhW4MKo",
  "name": "Status",
  "dataType": "SINGLE_SELECT",
  "options": [
    { "id": "f75ad846", "name": "Backlog" },
    { "id": "61e4505c", "name": "Planning" },
    { "id": "3121a97d", "name": "ToDo" },
    { "id": "47fc9ee4", "name": "In progress" },
    { "id": "df73e18b", "name": "In review" },
    { "id": "98236657", "name": "Done" }
  ]
}
```

These are the exact IDs `ai/RULES.md` §5 documents. Other fields on the board come back as
plain `ProjectV2Field`s with a `dataType` (`TITLE`, `ASSIGNEES`, `LABELS`,
`LINKED_PULL_REQUESTS`, `MILESTONE`, `REPOSITORY`, …) plus two more single-selects
(`Priority`, `Size`) SWARM doesn't use.

**Match on the option ID, never the name.** Names (`In progress`) are display-only and
rename-prone; the option ID (`47fc9ee4`) is stable. This is why `config-schema.ts` stores
`statusOptions` as `status-key → optionId`, not `→ name`.

### 2b. Discovering boards for the dashboard picker (issue #201)

The dashboard's **Project Management** tab no longer asks an operator to type the `projectId`,
`statusFieldId`, and option IDs above. It discovers them read-only through the provider's
`discover()` method (surfaced by the `pm` tRPC router, run under the project's own board
credential — `credentials.pm['github-projects'].apiToken`, issues #537/#631) and the operator picks from real names;
the persisted representation is still the opaque IDs documented above.

**Token permissions.** That credential needs `repo` + `project` (read *and* write — SWARM
moves cards and writes on the backing Issues) and, for the org-board half of discovery
below, **`read:org`**: `viewer.organizations` is refused outright without it, which the
provider translates into an error naming the missing scope rather than surfacing GitHub's
raw "Resource not accessible" wording. A fine-grained token needs repository Issues +
Pull requests read/write and organization Projects read/write. See
[`docs/configuration.md`](./configuration.md#credentialspm).

Board discovery enumerates the authenticated user's boards and the boards of each
organization they belong to (every connection is paginated to the end and results are
deduplicated by node ID):

```graphql
query($cursor: String) {
  viewer { projectsV2(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id title url } } }
}
query($cursor: String) {
  viewer { organizations(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { login } } }
}
query($login: String!, $cursor: String) {
  organization(login: $login) { projectsV2(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id title url } } }
}
```

State discovery is the §2 fields query for the selected board, narrowed to the single-select
`Status` field: its options become the mappable states and its own node ID is returned as the
`statusFieldId` to persist. A board that doesn't resolve, has no single-select `Status`
field, or whose `Status` field has no options fails with an actionable error.

---

## 3. Reading a single item (`getWorkItem`)

Given an item node ID, resolve its backing issue/PR and its current Status option in one
round-trip. `fieldValueByName` is the clean way to pull one field without paging
`fieldValues`:

```graphql
query($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      id
      type                       # ISSUE | PULL_REQUEST | DRAFT_ISSUE
      content {
        __typename
        ... on Issue { number title state url repository { nameWithOwner } }
        ... on PullRequest { number title state url repository { nameWithOwner } }
      }
      fieldValueByName(name: "Status") {
        ... on ProjectV2ItemFieldSingleSelectValue {
          name
          optionId
          field { ... on ProjectV2SingleSelectField { id name } }
        }
      }
    }
  }
}
```

Real result for issue #10's card (`PVTI_lAHOAC3TF84BcNwDzgxczms`), captured while it sat in
Planning (a **point-in-time snapshot** — the card advances through the board as this issue
progresses, so its live Status will differ from the `Planning`/`61e4505c` shown here):

```json
{
  "id": "PVTI_lAHOAC3TF84BcNwDzgxczms",
  "type": "ISSUE",
  "content": {
    "__typename": "Issue",
    "number": 10,
    "title": "Spike: GitHub Projects v2 GraphQL API …",
    "state": "OPEN",
    "url": "https://github.com/SmartTechBrewery/swarm/issues/10",
    "repository": { "nameWithOwner": "SmartTechBrewery/swarm" }
  },
  "fieldValueByName": {
    "name": "Planning",
    "optionId": "61e4505c",
    "field": { "id": "PVTSSF_lAHOAC3TF84BcNwDzhW4MKo", "name": "Status" }
  }
}
```

`repository.nameWithOwner` is how the provider resolves which SWARM project an item belongs
to — the PM-side analogue of the SCM router adapter resolving the project from the repo.

---

## 4. Moving an item's status (`moveWorkItem`)

Status transitions (Backlog → Planning → In progress → In review → Done) are a single
mutation, `updateProjectV2ItemFieldValue`. Its input type (introspected live) is:

```
UpdateProjectV2ItemFieldValueInput {
  clientMutationId: String
  projectId: ID!        # the board  (ProjectV2Id)
  itemId:    ID!        # the card   (WorkItemId)
  fieldId:   ID!        # the Status field (FieldId)
  value:     ProjectV2FieldValue!
}
```

For a single-select field, `value` is `{ singleSelectOptionId: "<optionId>" }`:

```graphql
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId:    $itemId
    fieldId:   $fieldId
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item { id }
  }
}
```

All three IDs come straight out of the config's board mapping (`projectId`,
`statusFieldId`, and the target `statusOptions[status]`), plus the item ID from the
triggering event. `ProjectV2FieldValue` is a union over field types
(`text`, `number`, `date`, `singleSelectOptionId`, `iterationId`); SWARM only ever writes
`singleSelectOptionId`. This is exactly the shape the `gh project item-edit` CLI wraps —
the same call the `solve-issue` skill and `ai/RULES.md` §5 already use to move cards by hand.

### Comments

Projects v2 items have **no native comment thread**. Agent output (plans, review notes)
must be posted as a comment on the *linked Issue/PR* via the SCM integration
(`addComment(issue|pr)`), not the board — see `ai/ARCHITECTURE.md`, PM section. There is no
"comment on a card" GraphQL mutation to call.

---

## 5. The `projects_v2_item` webhook

This is SWARM's `pm:status-changed` trigger equivalent (Cascade's PM providers get the same
signal from Trello/Linear webhooks). Verified against GitHub's webhook-events docs
(2026-07-02); project webhooks are flagged **public preview, subject to change**, so treat
the payload shape as a moving target and pin behaviour to the stable bits below.

### Delivery scope — NOT a repo event, and NOT a plain user webhook

A Projects v2 board is owned by the user or org, not a repo, so `projects_v2_item` is
**never** delivered on a repository webhook. But the naive "just add a user-level webhook"
path does **not exist** — and SWARM's board is user-owned, so this is our actual case.
GitHub's own docs pin down two facts that constrain us (verified 2026-07-02):

- **Types of webhooks:** *"You cannot create webhooks for individual user accounts, or
  for events that are specific to user resources."* A personal account's **Settings →
  Developer settings** has GitHub Apps, OAuth Apps and PATs — but **no "Webhooks" entry**.
  There is simply no account-level webhook UI for a user.
- **The `projects_v2_item` event page** lists its availability as **organization webhooks
  only**; to receive it any other way, *"a GitHub App must have at least read-level access
  for the Projects organization permission."*

So for SWARM's **user-owned board** (project `3`, owner `jkwiecien`) the realistic routes are:

- **(a) A GitHub App installed on the account, subscribed to `projects_v2_item`** — this is
  effectively the *only* way to receive the event for a user-owned board. The App delivers
  the event to its own webhook URL (no manual account-level webhook needed); see §6 → GitHub
  App for the required Projects permission.
- **(b) Recreate the board under an organization and use an org webhook** — **Org Settings →
  Webhooks** is the only place a plain (non-App) `projects_v2_item` webhook can live.

Either way this is a **second, non-repo** subscription: the five repo events (`pull_request`,
`pull_request_review`, `issue_comment`, `issues`, `check_suite`) stay on the repo webhook, while
`projects_v2_item` arrives via the App installation (a) or the org webhook (b) — both pointed
at the same router URL and sharing the same secret. `docs/cloudflare-tunnel.md` → "Projects v2
board event" covers the click-path.

### Actions

`archived`, `converted`, `created`, `deleted`, `edited`, `reordered`, `restored`.
The pipeline cares about **`edited`** (a field value — including Status — changed),
**`created`** (a card added to the board), and **`reordered`**.

**`reordered` matters more than its name suggests.** Dragging a card to a *different
column* in the Board view — the actual drag-and-drop a Kanban board is for — fires
`reordered`, not `edited`. Confirmed against a real delivery: its `changes` block is
`{ "previous_projects_v2_item_node_id": { "from": null, "to": null } }` — no
`field_value` at all, so there's no field to filter on the way `edited` allows. The
router (`src/router/adapters/github-projects.ts`) treats `reordered` like `created`
for that reason: accept it unconditionally and let the authoritative re-read (below)
decide. The cost is that `reordered` *also* fires on a pure within-column reorder with
no Status change — `src/triggers/pm-status-dedup.ts` is what stops that from
re-dispatching the same phase repeatedly.

### Payload — the parts SWARM relies on

Top-level: `action`, `sender`, `installation`/`organization`, plus:

```jsonc
{
  "action": "edited",
  "projects_v2_item": {
    "node_id": "PVTI_lAHOAC3TF84BcNwDzgxczms",  // -> WorkItemId (re-read via §3)
    "project_node_id": "PVT_kwHOAC3TF84BcNwD",  // -> ProjectV2Id (resolve SWARM project)
    "content_node_id": "…",                     // the backing Issue/PR node
    "content_type": "Issue",                     // Issue | PullRequest | DraftIssue
    "creator": { "login": "…" },
    "created_at": "…", "updated_at": "…", "archived_at": null
  },
  "changes": {
    "field_value": {
      "field_node_id": "PVTSSF_lAHOAC3TF84BcNwDzhW4MKo",  // -> compare to statusFieldId
      "field_type": "single_select"
    }
  }
}
```

### How the provider should use it — trigger, then authoritative re-read

**Do not trust the webhook to carry the new Status value.** For `edited`, the reliable
signal is `changes.field_value.field_node_id` + `field_type` — i.e. *which field changed*,
not necessarily its new value. GitHub's payload does not consistently include usable
from/to option values for single-select changes (and the whole project-webhook schema is in
preview). So the robust flow is:

1. Verify the HMAC signature at the router (same `X-Hub-Signature-256` path as the repo
   webhook — `src/webhook/signature-verification.ts`).
2. Drop unless `action === "edited"` **and**
   `changes.field_value.field_node_id === config.statusFieldId` (or `action === "created"`).
3. Resolve the SWARM project from `projects_v2_item.project_node_id`.
4. **Re-query the item** via the §3 query using `projects_v2_item.node_id` to get the
   *current, authoritative* Status `optionId` — then map that option back to a pipeline
   phase and dispatch. Never branch on a value lifted from the webhook body.

This "webhook is a doorbell, the API is the source of truth" pattern is the same one the
SCM side uses and keeps SWARM correct even as the preview payload shifts.

---

## 5b. Issue dependencies (blocked-by)

Cross-issue **dependencies** are a GitHub **Issues** feature (not Projects v2), exposed over
plain REST — so, unlike the item/field reads above, they don't go through GraphQL. SWARM's
`PMProvider` dependency capability (`supportsDependencies` / `listBlockers` / `listDependents` /
`addBlockedBy`, issues #330 and #639) is implemented against these endpoints in the GitHub Projects
adapter, resolving a board item to its backing issue first (the adapter already does this for
comments/updates):

| Operation | Endpoint | Notes |
| --- | --- | --- |
| List "blocked by" | `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` | Returns an array of Issue objects (with `id`, `number`, `state`, `title`, `html_url`). A repo/plan without the feature answers 404/410 — SWARM treats that as "no native blockers". |
| List "blocking" | `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking` | The reverse edge — the issues this one blocks — in the same Issue-object shape, backing `PMProvider.listDependents` (issue #639). It answers with **issues, not board items**, so the mapped dependents carry no work-item `id` and the shared cycle check matches on `url`/`reference`; that is also why only the *direct* edge is checked. Same 404/410 handling: no reverse read leaves the blockers gating rather than ungating them. Verified live — `/issues/633/dependencies/blocking` lists #631. |
| Add "blocked by" | `POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` | Body `{ "issue_id": <numeric database id> }` — the blocking issue's **`id`**, *not* its number (resolve it with `issues.get` first). Idempotent: an already-recorded dependency comes back `422`, which SWARM swallows. |
| Remove "blocked by" | `DELETE /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by/{issue_id}` | Not used by SWARM yet. |

Prose-declared dependencies (an item that says "blocked by #319" in its body or a comment) are
resolved provider-neutrally: `src/pm/dependencies.ts` extracts the referenced issue numbers, and
the adapter resolves each to its live `state` via `issues.get`, so both native relationships and
mentioned prerequisites feed one `listBlockers` result — tagged `source: 'dependency'` and
`source: 'mention'` respectively. Only the native half **gates** a run (issue #643); a prose mention
is surfaced on the item for a human to record natively and never defers work. `listDependents` takes
no prose at all: it is what *excuses* a blocker, so a heuristic answer there could drop a real gate.

---

## 6. Auth scopes

What the token behind the GraphQL calls and the webhook needs. Confirmed the active
`jkwiecien` gh token already carries `project` (`gh auth status` → scopes include
`'project'`, `'repo'`, `'read:org'`).

### Classic PAT / OAuth token

| Need | Scope |
| --- | --- |
| Read **and** write project items/fields (`updateProjectV2ItemFieldValue`) | `project` |
| Read-only (queries in §2–§3, no mutations) | `read:project` |
| Read/write the backing issues & PRs, post comments (§4) | `repo` |
| Org-owned boards / resolve org membership | `read:org` |

`project` is read+write and supersedes `read:project`; SWARM's implementer/reviewer tokens
need `project` because the pipeline moves cards.

### Fine-grained PAT

- **Projects** permission → **Read and write** — but note GitHub documents Projects as an
  **organization** permission only (the "Permissions required for fine-grained PATs"
  reference lists it under *Organization permissions for "Projects"*, with org-scoped
  endpoints). A fine-grained PAT scoped to a **user** resource owner has **no** Projects
  permission to grant, so it **cannot** move cards on our user-owned board `3`. In practice
  fine-grained PATs are only a viable PM credential for an **org-owned** board; the classic
  `project` scope (above) or a GitHub App is what covers the user-owned case.
- Repository **Issues** and **Pull requests** → **Read and write** (comments, PR lifecycle).
- The board owner must fall inside the PAT's resource owner / selected repositories.

### GitHub App (the eventual dual-persona setup)

- Organization (or user) **Projects** permission → **Read and write**.
- Repository **Issues** + **Pull requests** → **Read and write**; **Contents** →
  Read/write for the worktree push.
- Subscribe the app to the **`projects_v2_item`** event (delivered on the app installation,
  which sidesteps the manual account-level webhook in §5).

Whichever credential type is used, it resolves through the per-persona
`credentials` block (`src/config/provider.ts` → `credentialsRepository`) and is scoped via
`withGitHubToken` (`ai/ARCHITECTURE.md`, SCM section) — the PM provider reuses the same
token machinery as the SCM side rather than holding its own.

---

## 7. Takeaways for the build issues

- **GraphQL-only, node-ID-driven.** No REST fallback; the provider is a thin GraphQL client
  over the three operations in §2–§4, with IDs branded via `src/pm/ids.ts`.
- **Status = option ID, not name.** Config already models this (`statusOptions`); resolution
  is a two-way map between pipeline phase keys and `SingleSelectOptionId`s.
- **The webhook is a second, non-repo subscription** — and for our user-owned board it can
  only arrive via a **GitHub App** subscribed to `projects_v2_item` (or by moving the board
  under an org); there is no plain user-account webhook. It is only a *trigger* — always
  re-read the item for the authoritative Status.
- **No card comments** — agent output lands on the linked Issue/PR via the SCM integration.
- **`project` scope** (classic) / Projects read-write (fine-grained/App) is the extra grant
  beyond what the SCM side already needs.
