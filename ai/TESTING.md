# Testing & git hooks

Same tooling as Cascade — copy its config rather than picking a different stack.

## Test runner

**Vitest**, not Jest. Split into unit and integration projects, same as Cascade:

- **Unit tests** (`tests/unit/**/*.test.ts`) — mock every external call (GitHub API, GitHub Projects GraphQL, filesystem/git worktree operations, LLM CLI subprocess calls). No real network, no real Postgres/Redis. Use `vi.mock()` at the top of the file, before imports, wrapping every method of the client being mocked — see Cascade's `tests/unit/pm/linear/adapter.test.ts` for the exact shape to copy.
- **Integration tests** (`tests/integration/**/*.test.ts`) — run against a real, ephemeral Postgres **and Redis** (`npm run test:db:up` starts both from `docker-compose.test.yml`, same pattern as Cascade). Run serially, not in parallel, to avoid state collisions. Suites gate on `describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)` — set by `tests/integration/setup.ts` — so a machine without the test database skips rather than fails; Redis/BullMQ-dependent suites (the dispatch layer, issue #284) additionally gate on `SWARM_TEST_REDIS_AVAILABLE` the same way.

## Test data

Use factory functions (`createMockProject()`, `createMockGitHubProjectsItem()`, etc.) that return sensible defaults and accept `Partial<T>` overrides, mirroring Cascade's `tests/helpers/factories.ts`. Don't hand-construct the same fixture object inline in every test file.

## Provider conformance

Once there's more than one PM or SCM provider *implementing its whole contract*, add a conformance test suite mirroring Cascade's `tests/unit/integrations/pm-conformance.test.ts`: assert every registered provider's manifest has the required shape (unique id, webhook route convention, required methods present) so a new provider can't silently skip part of the contract.

- **SCM: it exists** — `tests/unit/integrations/scm/scm-conformance.test.ts`, landed with issue #296's final phase now that Bitbucket implements the whole contract. It runs one suite per *registered* manifest (unique id, `category: 'scm'`, a `/<provider>/webhook` route that no sibling shares, a provider whose `type` matches its manifest id, every `SCMProvider` method present) plus two assertions the surface check alone can't make: exactly one provider is runtime-ready, since nothing selects between them yet; and **no method is a stub** — a registered-but-unbuilt provider reports `not implemented yet` (issue #296's pattern), which is a function of the right shape and passes every other assertion, so the harness reads each method's own source for that sentinel. Add a new provider's methods to `SCM_CONTRACT_METHODS` when you widen `SCMProvider`.
  - **The third provider has passed the gate.** That stub assertion is what shaped how GitLab (issue #295) landed: it built its contract phase by phase while registering **no** manifest, because a registered stub-bearing provider would have failed this suite and forced an exemption that disabled the gate for the two providers already passing it. Its phase-1–3 suites construct `new GitLabSCMIntegration()` directly; `gitlab/index.ts` and the registered-id expectation `['github', 'bitbucket', 'gitlab']` arrived in phase 4/4 with the last stub's removal, which is what passing the gate consisted of. Copy that sequencing for the fourth provider — it then adds nothing to this file but a manifest in that list, since the per-manifest loop and both extra assertions already cover it.
- **PM: still deferred** — there is exactly one PM provider, so a shared harness would only restate `tests/unit/integrations/pm/github-projects/`'s own manifest test. Don't build it speculatively before the second one.

## Type-checking (tests included)

`tsc` runs against **both `src/` and `tests/`** — `npm run typecheck` (and the pre-commit hook) point at `tsconfig.typecheck.json`, which extends the base `tsconfig.json` with `noEmit` and widens `include` to cover the test tree. The base `tsconfig.json` stays `src`-only because it doubles as the build config (`tsc` → `dist`), so the two configs are kept separate rather than merged. Type errors in tests fail the check the same as errors in `src/` — don't let them ship silently.

Because of this, type your `vi.fn()` mocks with their real call signature — `vi.fn<(opts: RunAgentCliOptions) => Promise<AgentCliResult>>(...)` — rather than a bare `vi.fn(async () => …)`. An untyped mock infers a zero-argument signature, so `mock.calls[0][0]` indexes an empty tuple and fails to typecheck. Same convention as Cascade (e.g. `cascade/tests/unit/backends/pmPoster.test.ts`).

## Git hooks (Lefthook)

`lefthook.yml`, installed via the npm `prepare` script:

- **pre-commit** (parallel): Biome lint+format on staged files (auto-fix + re-stage), `tsc --noEmit -p tsconfig.typecheck.json` typecheck (covers `src/` **and** `tests/` — see above).
- **pre-push**: run the unit test suite (changed-file-scoped if the project grows large enough to need it, like Cascade's `test:fast`; just run everything while the suite is small).
- **commit-msg**: conventional-commit format enforced via commitlint.

## What "done" means for a change

Same bar as `ai/RULES.md` §6 (Workflow expectations) already states: don't claim a change is finished without actually running lint, typecheck, and the relevant tests. If a hook or command couldn't be run in your environment, say so explicitly rather than asserting it passed.
