# Testing & git hooks

Same tooling as Cascade — copy its config rather than picking a different stack.

## Test runner

**Vitest**, not Jest. Split into unit and integration projects, same as Cascade:

- **Unit tests** (`tests/unit/**/*.test.ts`) — mock every external call (GitHub API, GitHub Projects GraphQL, filesystem/git worktree operations, LLM CLI subprocess calls). No real network, no real Postgres/Redis. Use `vi.mock()` at the top of the file, before imports, wrapping every method of the client being mocked — see Cascade's `tests/unit/pm/linear/adapter.test.ts` for the exact shape to copy.
- **Integration tests** (`tests/integration/**/*.test.ts`) — run against a real, ephemeral Postgres **and Redis** (`npm run test:db:up` starts both from `docker-compose.test.yml`, same pattern as Cascade). Run serially, not in parallel, to avoid state collisions. Suites gate on `describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)` — set by `tests/integration/setup.ts` — so a machine without the test database skips rather than fails; Redis/BullMQ-dependent suites (the dispatch layer, issue #284) additionally gate on `SWARM_TEST_REDIS_AVAILABLE` the same way.

## Test data

Use factory functions (`createMockProject()`, `createMockGitHubProjectsItem()`, etc.) that return sensible defaults and accept `Partial<T>` overrides, mirroring Cascade's `tests/helpers/factories.ts`. Don't hand-construct the same fixture object inline in every test file.

## Provider conformance

Once there's more than one PM or SCM provider *implementing its whole contract*, add a conformance test suite mirroring Cascade's `tests/unit/integrations/pm-conformance.test.ts`: assert every registered provider's manifest has the required shape (unique id, webhook route convention, required methods present) so a new provider can't silently skip part of the contract. There is still exactly one PM provider, and the second SCM provider (Bitbucket, `src/integrations/scm/bitbucket/`) is registered with `runtimeReady: false` while it deliberately throws for the methods its later phases own (issue #296) — a shared harness run against it today would only assert those throws exist. Each provider's own manifest test covers its shape until then; the conformance suite lands with #296's final phase. Don't build it speculatively before that.

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
