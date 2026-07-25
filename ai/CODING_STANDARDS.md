# Coding standards

SWARM's stack and style are copied from **Cascade** (`cascade/`, see `ai/RULES.md` §1 for how to resolve that path) on purpose: Cascade's author is an experienced Node.js/TypeScript engineer, the person driving SWARM is not, and the fastest way to get an unfamiliar codebase to a good place is to keep using patterns that already proved out elsewhere rather than inventing new ones. When in doubt, go read the equivalent file in `cascade/` and match its shape.

## Language & tooling

- **TypeScript, strict, ESM-only.** `strict: true`, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. Node 22+. `"type": "module"` — `import`/`export` only, no `require`. Relative imports use explicit `.js` extensions (even though the source is `.ts`) because that's what Node's ESM resolver needs at runtime.
- **Path alias**: `@/*` → `./src/*`. Prefer it over long `../../../` chains.
- **Biome**, not ESLint/Prettier, for both lint and format. One tool, one config (`biome.json`), one command (`npm run lint:fix`) — don't add a second formatter/linter. House style: tabs (width 2), 100-char lines, single quotes, semicolons always, trailing commas in multiline structures, imports auto-sorted by Biome.
- **Vitest**, not Jest — see `ai/TESTING.md`.
- **Lefthook** for git hooks — see `ai/TESTING.md`.

## Zod is the source of truth for shapes that cross a boundary

Any config, webhook payload, or provider-manifest shape gets a Zod schema, and the TypeScript type is `z.infer<typeof schema>` — never a hand-written `interface` duplicating what the schema already says. Each provider (a PM integration, an SCM integration) owns its own schema file; a central schema composes them by importing, not by re-declaring fields. This is how Cascade avoids the config-drift bugs that show up when a hand-written type and a hand-written validator quietly diverge.

## Error handling

- **Throw for programmer/validation errors** (`throw new Error(...)`) — don't invent a `Result<T, E>` wrapper type. This codebase's convention is exceptions, not either-types; mixing both makes call sites unpredictable.
- **Return `null`/`undefined` for "not found" or "not applicable" lookups** — e.g. resolving a project from a webhook payload, resolving a label ID from a slot name. Reserve `throw` for cases that indicate a bug or bad input, not for "this webhook wasn't for us."
- **Async/await everywhere**, no raw `.then()` chains, no callbacks.
- **Scope credentials with `AsyncLocalStorage`, never pass tokens as plain function arguments through multiple call layers.** Cascade's `withGitHubToken(token, fn)` / `withTrelloCredentials(creds, fn)` pattern keeps secrets out of function signatures and stack traces. Mirror this for every credential SWARM handles (GitHub implementer/reviewer tokens, GitHub Projects access).

## Naming

- Files: kebab-case (`github-router-adapter.ts`, `config-schema.ts`).
- Classes: PascalCase (`GitHubSCMIntegration`, `GitHubProjectsPMProvider`).
- Functions/variables: camelCase.
- Constants: UPPER_CASE.
- Branded ID types for domain identifiers that are easy to confuse (e.g. a GitHub Projects field ID vs. an item ID vs. a status option ID) — define them the way Cascade defines `StateId`/`LabelId`/`ContainerId` in `src/pm/ids.ts`, so mixing them up is a compile error, not a runtime bug.

## Module shape for a provider/integration

Every integration (a PM provider, an SCM integration) follows the same three-file shape Cascade uses — don't improvise a different structure per provider:

```
src/integrations/<kind>/<provider>/
  config-schema.ts   # Zod schema + inferred type — the provider's own config shape
  adapter.ts          # the class implementing the shared provider interface
  index.ts            # side-effect-only: registers the manifest with the registry
```

New providers register themselves by being imported from one barrel file (mirroring Cascade's `src/integrations/entrypoint.ts`). Adding a provider should never require editing dispatch/orchestration code — only adding the provider's own folder plus one import line in the barrel. If you find yourself branching on `provider.type === 'github-projects'` somewhere in shared code, that's a sign the registry/manifest abstraction is being bypassed — fix that instead of adding the branch.

## Comments

Default to none. Write a comment only for a non-obvious invariant, a workaround, or a "why", the same way Cascade does — e.g. explaining *why* a lock is needed, not *what* the next line does. Comment density in this codebase should stay low (Cascade sits around 10–20%, concentrated on cross-cutting invariants like loop-prevention and credential scoping); a wall of comments restating the code is a sign something should be renamed instead.

## Loop prevention (drop SWARM's own output by its marker)

Any code that reacts to SCM events (PRs, reviews, comments, check suites) must refuse to act on SWARM's *own* output — the feedback loop Cascade guards with `isCascadeBot(login)` on every trigger handler. **Recognize that output by its content, not by its author.** SWARM's identities are no longer a reliable signal: under the federated model (ADR-004 §2) the implementer credential is the worker operator's own GitHub token, so SWARM's own PRs and comments come from an ordinary user account — which the same human also comments from by hand, and which the control plane can't even name for a *remote* operator.

So there are two distinct jobs, and they use different mechanisms:

- **Drop SWARM-generated content by its marker.** Every comment SWARM posts carries a hidden `<!-- swarm-… -->` marker or the visible `_Generated by SWARM…_` footer; one provider-neutral predicate (`isSwarmGeneratedBody`, `src/scm/swarm-origin.ts`) tests for them, and the router's comment drop gate (`GitHubRouterAdapter.isSelfAuthored`) is built on it. Every new SWARM comment body must append one of the two — the gate is only as good as that coverage. Same idea for "is this PR ours": the Review trigger decides it from the PR's work-item origin (`isSwarmManagedPullRequest`), not its author.
- **Route between personas by identity.** The dual-persona model — a separate "implementer" and "reviewer" GitHub identity/token — still holds and is still resolved by login (`getPersonaForLogin`, `src/integrations/scm/github/personas.ts`), so the reviewer's `changes_requested` reaches the implementer. Don't build a single-persona shortcut "since it's just one user" — the independent-reviewer invariant this preserves is orthogonal to tenancy.

Drop gates stay narrowly scoped: SWARM's comments are the runaway loop, so the comment gate drops them, while PR/review/check lifecycle events must flow through even when SWARM produced them (that is how one persona hands off to the other). The one remaining identity-based drop is the PM board's status-change gate (`GitHubProjectsRouterAdapter.isSelfAuthored`) — a status change carries no body to mark, so it has nothing to inspect.
