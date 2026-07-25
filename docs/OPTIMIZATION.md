# Agent quota optimization

This document describes ways to reduce the quota consumed by successful Planning,
Implementation, and Review runs. It deliberately does not repeat the interrupted-run
preservation and continuation design in [`CHECKPOINTS.md`](./CHECKPOINTS.md): checkpoints
reduce work lost when a run stops, while the measures below reduce the amount of work a
normal uninterrupted pipeline performs in the first place.

The governing principle is to spend model quota on decisions that require model judgment.
Repository discovery, phase hand-offs, delivery mechanics, and repeated context collection
should be made reusable or deterministic wherever practical.

## 1. Reuse Planning's analysis in Implementation

Today Planning explores the repository and writes a prose `proposed_plan.md`. Implementation
reads the issue and posted plan, but its prompt then tells it to explore the repository again.
That repeats a meaningful part of Planning's input and tool use in a fresh session.

Planning should instead produce a compact, structured implementation packet containing:

- relevant files, symbols, and existing patterns;
- the ordered changes to make;
- acceptance criteria and intentional exclusions;
- focused verification commands;
- important decisions, risks, and unresolved questions.

SWARM should carry this packet directly into the Implementation job rather than requiring
Implementation to recover it from an issue comment. The human-readable Markdown plan can
still be posted to the issue. Implementation should validate that the packet still matches
the checkout, investigate only gaps or stale assumptions, and avoid redesigning completed
Planning work without evidence that it is necessary.

This is expected to be one of the largest per-task savings because it removes duplicated
repository exploration while retaining a separate human-reviewable Planning phase.

## 2. Avoid standalone Planning for tasks that do not need it

Not every work item benefits enough from a separate architect session to justify a full
additional run. Add a project-level Planning policy:

- `required` — retain the current separate Planning phase;
- `auto` — require or skip standalone Planning using deterministic task signals;
- `disabled` — let Implementation begin with a short, bounded local plan.

The initial `auto` policy should not invoke a classifier model, since that would consume
quota merely to decide whether to consume quota. Deterministic signals can include labels,
task wording, named files, affected areas, and explicit acceptance criteria. Planning should
normally remain required for architecture changes, migrations, cross-package work,
configuration/lifecycle changes, security-sensitive work, and broad or ambiguous tasks. It
can normally be skipped for narrow bug fixes, documentation-only changes, and well-specified
tasks that identify both the target and acceptance criteria.

The policy and its reasons should be visible on the run/task so operators can audit routing
decisions and override them.

## 3. Plan every split child in the original Planning run

With automatic splitting enabled, the parent Planning run has already explored the
repository and decided how the work decomposes. It should create the remaining children in
Planning with a plan from that same repository exploration, instead of sending each child through
another complete Planning run.

Instead, the original run should produce a concise implementation plan for every child while
its repository context is still available. Each child should receive:

- a self-contained title and scope;
- acceptance criteria and exclusions;
- relevant files/symbols and dependencies on preceding children;
- an ordered implementation outline;
- focused verification guidance.

SWARM should post or persist the child-specific plan with the newly created item and mark it
as preplanned before moving the child to Planning. Its Planning trigger should recognize a valid
marker **and** `swarm:split-child` label and avoid launching another agent run. A human edit that
materially changes the child's scope, a missing or invalid plan, an explicit replan action, or
removal of the split-child label should run Planning normally.

Because those issue-body and label changes do not emit a Projects Status event, the repo webhook
also subscribes to **Issues**. The `preplan-invalidated` trigger handles only body edits, adding
`swarm:replan`, and removing `swarm:split-child`; it re-reads the authoritative Planning card and
dispatches fallback Planning only when the current marker/label state is invalid.

This converts one repository analysis into plans for the entire split rather than paying for
one parent analysis plus one full analysis per child.

### Implemented

The parent Planning run now writes a `plan` for every sibling in `proposed_split.json`
(`SplitSubTaskSchema`, `src/pipeline/planning.ts`) — the prompt asks it to reuse the analysis it
just did for the first task and cover, per child, self-contained scope + acceptance criteria,
exclusions, relevant files/symbols, dependencies on preceding siblings, an ordered outline, and
verification guidance. When it spawns each child, it embeds that plan as a **structured,
validated preplanned contract** (`PreplanContractSchema`, `src/pipeline/preplan.ts`) in a hidden
`<!-- swarm-preplan:v1 … -->` marker in the child's issue body — the only state that durably
travels with a child while it enters Planning.

Because GitHub does not render that hidden marker, SWARM also posts the same plan as a normal,
human-readable **Preplan** comment on the child (issue #431), so an operator can review the actual
plan in the issue before sequencing the child. That comment carries its own provenance marker
(`<!-- swarm-preplan-comment:… -->`) stamping it with the split run that produced it; no duplicate
check is needed at that point, because a retried or replayed delivery is short-circuited one level
up (the plan-delivery marker on the parent's own comment) before any child is re-prepared. It is
published *before* the hidden marker is written: if publishing fails, no marker exists, the child
stays in Backlog with a comment that claims no published preplan, and a later move to Planning runs
a normal Planning agent that posts its own plan. The hidden marker remains the single authoritative
source for preplan validation and for suppressing the redundant Planning run.

The Preplan comment carries the plan as ordinary prose, which the Implementation dependency gate
also reads when it scans an item for prerequisites named in text. That scan therefore skips every
comment SWARM itself wrote (`isSwarmGeneratedBody`): a plan phrased as "this phase requires #266 to
land first" is the agent describing its own work, not an operator declaring a blocker, and treating
it as one would defer — and eventually fail — the child's Implementation on an issue nobody gated it
on. Prose dependencies still count in the item's description and in comments written by people.

SWARM creates the card in Backlog only long enough to write that marker, then moves it to Planning.
That ordering means both the Planning-move webhook and a delayed creation webhook find the marker
before the trigger evaluates the card: a valid marker on a labelled split child suppresses the
redundant phase, so no worktree or agent CLI is launched. Validity is deterministic — no
classifier model. It falls back to a normal agent run
when the marker is missing, malformed, fails schema validation, binds a different item
(`itemUrl` ≠ the child's URL), was written against a since-edited scope (`descriptionHash`
mismatch), an operator applied `swarm:replan`, or the split-child label was removed. The marker is
intentionally *not* inferred from a label or free-form comment alone.

If either the marker write or the move to Planning fails, the child stays in Backlog and its split
comment says so. A human can move it to Planning later; a saved valid marker is reused, while a
missing or invalid one falls back to the normal Planning agent.

## 4. Move deterministic delivery mechanics out of Implementation

The Implementation agent currently implements and verifies the change, then commits, pushes,
constructs a PR body, opens the PR, and writes the PR URL to a hand-off file. The final steps
are mostly deterministic but consume turns and create late failure modes: a completed change
may need another run because `git push`, `gh pr create`, or the URL hand-off failed.

Let the agent finish after code and verification and write a structured change summary. SWARM
should then:

1. validate the working tree and required verification result;
2. create a conventional commit from a bounded template;
3. push the known task branch;
4. create the PR from the work item and change summary;
5. include the required closing reference and post the resulting URL.

The implementation persona's credentials and attribution rules must remain intact. Agent
fallback remains useful for genuinely judgment-dependent PR descriptions, but the normal path
should not require model participation in mechanical delivery.

## 5. Give Review a preassembled review packet

Review currently spends part of its run fetching and reconstructing context: the PR body and
discussion, linked issue and proposed plan, complete diff, and CI state. SWARM already knows
most identifiers and can assemble that material before invoking the reviewer.

A review packet should contain:

- PR title, body, head SHA, and relevant discussion;
- the work item's acceptance criteria and agreed plan;
- Implementation's structured change summary;
- changed-file list and diffstat;
- the full diff, or a stable local path/command that reads the pinned diff;
- CI checks and verification results;
- applicable repository guidance.

The reviewer must still review every changed file and inspect surrounding checkout code when
verifying candidate findings. The packet removes context collection, not independent
judgment. It should be bounded and avoid duplicating the same content in both the prompt and
files available in the worktree.

## 6. Route models by phase risk and complexity

SWARM supports static per-phase CLI/model overrides, but every run within a phase currently
receives the same configured tier. Add deterministic model routing so inexpensive models
handle routine work and stronger models are reserved for tasks likely to benefit from them.

Useful signals include:

- task labels and explicit risk classification;
- changed-file count, diff size, and number of packages/components;
- paths associated with migrations, authentication, concurrency, security, or core lifecycle;
- whether an earlier attempt failed for a reasoning/quality cause;
- ambiguity and breadth identified by Planning.

A sensible starting policy is an inexpensive model for routine Planning and small low-risk
reviews, the normal model for focused Implementation, and stronger models for architectural,
security-sensitive, migration, concurrency, or unusually large work. Escalation should
follow a concrete failure or risk signal rather than making the highest tier the default.

Routing decisions, effective model, and escalation reason must be recorded on the run for
measurement and debugging.


## 7. Add phase-specific effort and spending controls

Model choice alone does not bound how intensely a model reasons or how long it explores. The
installed Claude CLI exposes `--effort`, `--max-budget-usd`, tool allowlists, and skill
controls. The harness should represent provider-specific controls rather than assuming every
CLI has the same flags.

Initial Claude effort defaults could be:

- Planning: `medium`;
- Implementation: `high` for normal work, lower for trivial/documentation work;
- Review: `medium`, escalating for high-risk or large diffs.

`--max-budget-usd` is useful only for execution modes in which its accounting corresponds to
the quota being managed. Subscription/session limits may require other provider-specific
proxies or controls. Timeouts remain a safety net, but wall-clock time alone is a poor quota
budget because tool execution and model generation consume time differently.

Tool restrictions can also prevent phase expansion: read-only phases should not receive edit
capabilities, and pipeline runs should not load unrelated skills or workflows. Any restriction
must preserve the commands the phase genuinely needs.

## 8. Make verification bounded and project-defined

The instruction to run lint, type-check, and relevant tests makes each Implementation agent
rediscover commands and independently decide what “relevant” means. Define a project
verification profile with:

- fast checks required for every change;
- changed-path-to-test mappings;
- conditions that require the full suite;
- checks already guaranteed by CI;
- output-size limits and failure-summary behavior.

Planning should select commands from this profile, Implementation should run the selected
set, and Review should consume the recorded results rather than repeating broad verification
without a finding-specific reason. This keeps correctness gates explicit while preventing
unbounded or redundant test exploration.

## 9. Measure quota per successful task, not only per run

Per-run token usage is already recorded where a CLI reports it, but optimization requires an
aggregate view across all phases, retries, and continuations for one task. Add reporting for:

- input, output, cache-read, cache-creation, and reasoning tokens by phase and model;
- total reported usage per successfully completed or merged task;
- usage from failed, timed-out, deferred, and retried runs;
- Planning-to-Implementation discovery duplication;
- approval, comment, and requested-changes rates by review model and risk class;
- review usage per changed file and diff size;
- duration and outcome proxies for CLIs that do not expose token usage;
- cache-read ratio and the stability of reusable prompt prefixes.

Antigravity does not currently report structured usage, so comparisons involving it need to
be labelled as incomplete unless usage can be recovered reliably from another local session
record. Do not silently compare its duration to another CLI's tokens as if they were the same
measurement.

Every experiment should compare total quota per successful task and quality outcomes, not
merely show that one individual run became cheaper. For example, a cheap reviewer that causes
more response cycles may increase overall usage.

## Delivery order

Implement these changes incrementally and measure after each step:

1. Add task/phase/model usage aggregation and routing observability.
2. Produce structured Planning packets and consume them in Implementation.
3. Reuse the parent Planning run for all split-child plans.
4. Move commit, push, and PR creation into deterministic orchestration.
5. Preassemble Review packets.
6. Add Planning skip policies and risk-based model/effort routing using the measured baseline.
7. Add project verification profiles and refine them from observed runs.

The checkpoint/resume work can proceed independently. Together, the two efforts address both
sides of quota waste: this document reduces the cost of a successful pipeline, while
`CHECKPOINTS.md` reduces work lost when a run is involuntarily interrupted.
