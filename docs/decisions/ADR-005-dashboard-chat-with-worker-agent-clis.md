# ADR-005: Dashboard chat with a worker's agent CLIs

- **Status:** Under discussion — feasibility established, access model undecided
- **Issue:** none yet for the chat feature itself; the Antigravity finding below was spun out as [#465](https://github.com/SmartTechBrewery/swarm/issues/465)
- **Date:** 2026-08-04
- **Decision owners:** SWARM maintainers

> **Why this record exists.** This is not (yet) an accepted decision. It captures a
> feasibility investigation and the measurements taken during it, so the pending
> conversation about **how chat access is granted** starts from established facts
> rather than re-deriving them. The turn model (§Decision 1) and the
> final-answer-only simplification (§Decision 2) are settled; everything under
> §Open questions is not.

## Context

A dashboard user wants to converse with one of the agent CLIs their **running
worker** can launch — the same interaction shape as talking to Claude Code
directly, but through the dashboard, against the models that worker actually has.

The question asked was narrow: is that buildable on top of the CLI harness SWARM
already drives? The answer is yes, and most of the plumbing exists. What follows is
what the investigation found, including two live probes that overturned an
assumption baked into the code.

### What already exists

| Capability chat needs | Where it already lives |
| --- | --- |
| Launch a CLI non-interactively, stream its lines | `src/harness/agent-cli.ts` — `runAgentCli`, `onStdout`, `-p`/`exec`, `src/harness/claude-stream.ts` |
| **Continue an existing conversation** | `resumeSessionId` → `claude --resume`, `codex exec resume <id>`, `agy --conversation <id>` (`buildSessionArgs`) |
| Model + reasoning catalog | `src/harness/models.ts` (`ModelCapability`, `REASONING_LEVELS`) |
| "Which CLIs does *this* worker have" | `src/transport/cli-discovery.ts` probes PATH → declared at handshake → already exposed to the dashboard by `workers.list` (`src/api/routers/workers.ts`) |
| Stream output to the browser | `src/worker/live-output.ts` → `run_output_events` → cursor poll `runs.getOutput({ runId, after })` |
| Push a command to a remote worker | `sendToWorker(workerId, ControlPlaneMessage)` (`src/router/worker-connections.ts`) plus the `StreamLog`/`TaskProgress`/`TaskExecutionResult` back-channel (`src/transport/protocol.ts`) |

So the feature is mostly composition of existing seams, not new infrastructure.

## Findings

### 1. There is no interactive session to hold open

The harness spawns every CLI with `stdio: ['ignore', 'pipe', 'pipe']` — stdin is
closed by design, because pipeline runs happen in a disposable worktree with no
terminal to answer a permission prompt. Writing to a live agent's stdin is not
available, and standing up a PTY for chat would be a new execution model rather
than a reuse of this one.

What *is* available is the session-resume mechanism the pipeline already uses to
continue a phase. That fixes the turn model (§Decision 1).

### 2. `agy` gained structured output; the code still says it hasn't

`OUTPUT_FORMAT_ARGS.antigravity` is `[]`, `parseAgentOutput` returns `{}` for
antigravity, and comments in `src/harness/agent-cli.ts`, `src/harness/usage.ts`
and `ai/RULES.md` §6 all state that `agy` has no structured-output or usage flag.
That was true of agy 1.1.3. **It is false as of agy 1.1.10**, which offers
`--output-format text|json|stream-json`.

Probed live on the dev host (`agy` 1.1.10), outside the harness:

```
$ agy --output-format json -p "Reply with exactly: PROBE_OK"
{"conversation_id":"67af954d-…","status":"SUCCESS","response":"PROBE_OK\n",
 "duration_seconds":1.553979,"num_turns":1,
 "usage":{"input_tokens":18272,"output_tokens":44,"thinking_tokens":36,
          "cache_read_tokens":0,"total_tokens":18316}}
```

`stream-json` is strictly more useful — the conversation id arrives in the *first*
event, progress arrives as `text_delta`, and the terminal `result` event carries
the same final payload:

```
{"event":"init","conversation_id":"d42f7419-…","init":{"cwd":"…","tools":[…],"permission_mode":"request-review"}}
{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"STREAM_OK"}}
{"event":"result","result":{"conversation_id":"d42f7419-…","status":"SUCCESS","response":"STREAM_OK\n","num_turns":1,"usage":{"input_tokens":18267,"output_tokens":28,"thinking_tokens":22,"cache_read_tokens":0,"total_tokens":18295}}}
```

Multi-turn resume was confirmed in the same probe: a second invocation with
`--conversation <id>` returned the same id with `num_turns: 2` and correctly
recalled the first turn.

Two consequences, both independent of whether chat is ever built — hence
[#465](https://github.com/SmartTechBrewery/swarm/issues/465):

- `runs.usage` is null for **every** agy run today, so those runs are invisible to
  cost accounting and usage surfaces. The data was available all along.
- `src/harness/antigravity-session.ts` diffs agy's on-disk conversation store to
  guess the session id. `conversation_id` is now printed, so that hack can go.

Note for whoever implements it: `json` buffers until process exit, which would take
an agy run's live log dark for its whole duration — the exact failure mode issue
#356 fixed for claude. `stream-json` is the format that avoids that regression.

### 3. Measured cost of the per-turn model

From the probes above: turn 1 cost 18.3k total tokens, turn 2 cost 36.8k, with
`cache_read_tokens: 0` both times. agy replays the transcript per turn with no
cache hit, so a long conversation grows superlinearly in cost. `claude --resume`
does benefit from prompt caching, so the same shape is materially cheaper there.

Latency: turn 1 took 1.6s, turn 2 took 16.8s — for a *trivial* prompt. A real
question over a repository should be assumed to take minutes (`agy`'s own
`--print-timeout` defaults to 5m).

### 4. Per-CLI final-answer extraction is not uniform

- **claude** — `parseClaudeOutput` already returns exactly the terminal `result`
  record's final text. Correct as-is.
- **codex** — `parseCodexOutput` joins **all** `item.completed`/`agent_message`
  items with newlines. Harmless for a run log, wrong for a chat reply: it would
  fold intermediate agent messages into the "final answer". Chat needs the last
  message, not the join.
- **antigravity** — `result.response` per §2.

## Decision

### 1. A chat turn is one CLI process, resuming the conversation

One user message = one `runAgentCli` invocation carrying `resumeSessionId`, with
the CLI's own conversation/session id persisted between turns. This is the
mechanism the pipeline already uses to continue a phase, and it is the only one
available without introducing a PTY execution model (§Findings 1).

Accepted cost: per-turn process spawn plus transcript replay, quantified in
§Findings 3.

### 2. The product surface is the final answer, not the reasoning trace

The live progress stream is not useful to a chat user — the reasoning/tool
transcript is noise in that context. Chat renders the model's final response only.

This is a significant simplification, not just a UI preference: it removes the
entire streaming layer from the chat path. No `run_output_events` writes, no
cursor polling, no per-line decode. A turn is a request that produces one answer,
and the UI needs a pending indicator rather than a log viewer.

It does **not** remove the need for asynchrony. Per §Findings 3 a turn can take
minutes, so a turn should be persisted as pending work whose completion the UI
observes — not a blocking HTTP call held open on a long timeout.

### 3. The Antigravity structured-output upgrade is severable and goes first

[#465](https://github.com/SmartTechBrewery/swarm/issues/465) is filed and boarded
independently. It pays for itself through usage reporting and hack removal
regardless of this ADR's outcome, and it is not a prerequisite the chat discussion
should wait on.

## Consequences

- Chat turns consume the same CLI quota as pipeline runs, on the same machine.
  Whether they pass through the project concurrency gate or get a separate budget
  is unresolved (§Open questions).
- A conversation is **pinned to one machine**. The CLI session store is local to
  the worker's disk, so turns must route sticky to the same `workerId`; if that
  worker disconnects, the conversation is frozen rather than portable. The UI has
  to state that honestly.
- Chat needs its own persistence. Reusing the `runs` table is rejected: `taskId`
  and `phase` are `NOT NULL` and the whole pipeline read model is built on those
  rows, so chat turns would pollute run history and dispatch semantics.
- `--dangerously-skip-permissions` is currently unconditional in `DEFAULT_ARGS`
  for every CLI. Chat inherits it unless the harness is parameterized, which is
  the security question below.

## Non-goals

- An interactive PTY session with a long-lived agent process.
- Streaming the reasoning/tool transcript to the chat user (§Decision 2).
- Modelling a chat turn as a pipeline run or a board-driven task.

## Open questions

1. **How is chat access granted?** Deliberately deferred — this is the next
   conversation, and nothing below should be settled ahead of it.
2. **What can a chat agent do, and where?** Pipeline runs get
   `--dangerously-skip-permissions` because they are sandboxed in a disposable
   worktree. Chat has no worktree, so an unconstrained chat is arbitrary code
   execution on the operator's machine, initiated from a web UI. Options
   identified but not evaluated: a scratch directory, the project checkout
   read-only, or a specific run's worktree (useful — "ask the agent what it
   actually did in this run"). This requires parameterizing the currently
   hard-coded per-CLI permission flags.
3. **Quota and concurrency accounting** — does a chat turn compete with pipeline
   dispatch, or draw on a separate allowance?
4. **History bounds** — given §Findings 3, does a conversation get a turn/token
   cap, a summarization step, or just an explicit "new conversation" affordance?
5. **Authorization** — presumably the existing `assertProjectAccess` tiers, but
   which tier, and is chat project-scoped at all or worker-scoped?
