/**
 * PMRouterAdapter — the provider-neutral contract for the *inbound* half of a PM
 * provider: turn a raw board webhook into a {@link PmEvent}, resolve which SWARM
 * project owns the board, decide whether the change is worth waking the pipeline
 * for, and drop changes SWARM itself caused (issue #297).
 *
 * The PM twin of `SCMProvider`'s ingress methods (`src/scm/types.ts`), extracted
 * from the concrete `GitHubProjectsRouterAdapter` with unchanged semantics so the
 * receiver, the worker, and the PM-driven triggers program against the interface
 * and never name a provider (ai/RULES.md §2 "Project-management features must
 * stay provider-agnostic").
 *
 * Types only — no Zod — so this module adds no runtime import edge; the runtime
 * half of the PM contract is `src/pm/events.ts`.
 */

import type { ProjectConfig } from '../config/schema.js';
import type { PmEvent } from './events.js';
import type { PMType } from './types.js';

export interface PMRouterAdapter {
	/** Stable registry key / provider discriminator, matching the manifest's `id`. */
	readonly type: PMType;

	/**
	 * Normalize a raw board webhook into a {@link PmEvent}. `eventName` is whatever
	 * the provider's own transport names the event with (a header, a body field) —
	 * the receiver passes it through without interpreting it. Returns `null` for an
	 * event this provider doesn't act on, and for a payload missing the item or
	 * container id (nothing is actionable without both), so the caller can drop it
	 * without branching.
	 */
	parseWebhook(eventName: string, payload: unknown): PmEvent | null;

	/**
	 * Resolve the SWARM project that owns the event's board, or `null` when the
	 * board is untracked. A board event carries no repository (unlike SCM ingress,
	 * which resolves by `owner/repo`), so this resolves by
	 * {@link PmEvent.containerId}.
	 *
	 * Kept a separate call from {@link parseWebhook} so the receiver keeps its
	 * ordering: parse → resolve project → **authenticate** → filter → loop-prevent
	 * → enqueue. A payload is untrusted until it is authenticated against the
	 * resolved project's secret.
	 */
	resolveProject(event: PmEvent): Promise<ProjectConfig | null>;

	/**
	 * Whether this event is a state transition the pipeline reacts to — a card
	 * added to the board, a card moved between columns, or an edit to the field the
	 * project's board mapping designates as its *state* field. Every other field
	 * edit (priority, size, assignees, …) is dropped here.
	 *
	 * The provider compares {@link PmEvent.changedField} against its own board
	 * mapping; shared code never reads a provider's config (a GitHub Projects
	 * `statusFieldId` and friends stay inside the adapter, narrowed out of
	 * `project.pm` by the provider itself).
	 *
	 * It deliberately does **not** assert *which* state the item moved to: this
	 * gate answers "is this worth waking the pipeline for?", not "which phase?".
	 * That comes from the authoritative re-read downstream
	 * (`src/triggers/handlers/pm-status.ts`).
	 */
	isStatusChange(event: PmEvent, project: ProjectConfig): boolean;

	/**
	 * Loop prevention: answer "did SWARM itself cause this board change?" using an
	 * identity the *PM provider* can establish on its own — e.g. the worker moving
	 * a card to "In progress" as it starts implementation would otherwise re-fire
	 * the very trigger that started it (ai/CODING_STANDARDS.md "Loop prevention").
	 *
	 * This is a **per-provider** obligation, and the contract is explicit because
	 * the default is not inheritable: a provider MUST NOT borrow another category's
	 * identity model. GitHub Projects may keep reaching into
	 * `GitHubSCMIntegration`'s persona helpers only because the board and the repo
	 * are the same account (ai/RULES.md §2 names it as one of two deliberate
	 * reaches); a Jira board paired with a GitHub repo has no such shared identity
	 * and must key on its own bot account / API-token identity.
	 *
	 * Unlike the SCM comment gate, a state change carries no body to mark, so this
	 * gate is keyed on identity and inherits identity resolution's failure mode
	 * (issue #443). Fail **open** — return `false` and log — on any
	 * identity-resolution failure: a swallowed error must never silently drop a
	 * real human state change as "ours". If that proves too loose, the fix is a
	 * bounded retry on resolution, not flipping to fail-closed.
	 */
	isSelfAuthored(event: PmEvent, project: ProjectConfig): Promise<boolean>;

	/**
	 * Build a synthetic state-change event for one item on the project's board —
	 * the event a provider's own webhook *would* have delivered. The worker uses it
	 * to self-enqueue the next phase after a phase's `autoAdvance` moves a card
	 * (`selfEnqueueNextPhase`, `src/worker/consumer.ts`), because that move is
	 * authored by a SWARM persona and therefore dropped by
	 * {@link isSelfAuthored} — so the direct webhook never arrives.
	 *
	 * On the interface (rather than assembled at the call site) because assembling
	 * one needs the provider's own board mapping — exactly the knowledge
	 * {@link isStatusChange} owns. The returned event MUST satisfy this adapter's
	 * own `isStatusChange` for the project, so the synthetic job travels the same
	 * trigger-match → authoritative-re-read → dedup path a real webhook would.
	 */
	synthesizeStateChange(project: ProjectConfig, itemId: string): PmEvent;
}
