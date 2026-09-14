# Agent-failure classifier fixtures

Captured CLI output used by `tests/unit/harness/agent-failure.test.ts` to pin
`classifyAgentFailure` (`src/harness/agent-failure.ts`) against the real shape of
each CLI's transient provider-capacity or account-quota banner. Each fixture is
scoped to one CLI (the classifier gates both by `result.cli`) and carries a
documented source, so a signature is only trusted after its shape is confirmed —
never inferred from another CLI or a bare status code.

| Fixture | CLI | Signature | Source |
| --- | --- | --- | --- |
| `codex-capacity-transcript.txt` | codex | `Selected model is at capacity` | Codex CLI provider error (observed); reported separately from account quota. |
| `claude-529-overloaded-transcript.txt` | claude | `API Error: 529 Overloaded` | Observed live on run `cdbba4f7-feee-4687-a226-1705ee862a89` (issue #229); Anthropic documents 529 as a temporary overload — <https://platform.claude.com/docs/en/api/errors>. |
| `claude-529-repeated-transcript.txt` | claude | repeated `529` + `overloaded_error` | Claude Code's retry path prints one 529 line per attempt before giving up — <https://code.claude.com/docs/en/errors>; the `overloaded_error` type is the JSON error body Anthropic returns with a 529. |
| `codex-usage-limit-transcript.txt` | codex | `You've hit your usage limit` in an `error` / `turn.failed` record | Captured live from run `e5c74d0d-de8b-4b74-8f15-dafe09a02882` (issue #963), copied verbatim from its retained stdout — account quota, distinct from the capacity signal above. |

Each Claude fixture opens with borrowed rate-limit / HTTP-`429` prose and code
mentions ahead of the terminal banner: the classifier must ignore those (they sit
outside the terminal-tail window, or are the wrong CLI's signal) and key only on
the final provider banner. That is the false-positive resistance the tests assert.

The Codex quota fixture is the one that is *not* a terminal-output tail. Codex's
`error` / `turn.failed` events never reach the run's stored log — `parseCodexOutput`
(`src/harness/usage.ts`) keeps only `agent_message` items — so the classifier reads
them from the structural `codexFailure` field instead, and the fixture is the raw
JSONL the harness decodes rather than text a tail scan would see. Its two leading
agent messages are the point: before issue #963 they were the whole classification
window, and the quota banner behind them was lost.

Antigravity/Gemini transient signals (`429 RESOURCE_EXHAUSTED`, `503 UNAVAILABLE`
— <https://ai.google.dev/gemini-api/docs/troubleshooting>) and additional
Codex/OpenAI retryable statuses (`408`/`409`/`5xx` in the OpenAI Node SDK) are
deliberately **not** added here: no `agy`/`codex` terminal-output fixture
demonstrating their emitted shape has been captured yet. Nor is a Codex reset hint
that names a timezone — the observed banner carries none, and inventing one would
assert against a CLI shape nobody has seen. Add a fixture + row above before
extending the classifier to them (issue #229 provider-signature audit).
