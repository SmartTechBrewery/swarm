/**
 * Trigger types — how the worker decides *what* to do with a dequeued event,
 * mirroring Cascade's `src/triggers/types.ts` + `src/types` trigger interfaces.
 * One deliberate deviation: Cascade dispatches triggers router-side and ships
 * the result in the job; SWARM's worker owns the lookup (ai/ARCHITECTURE.md
 * "Components" — the worker "looks up the trigger handler for the event"), so
 * the job carries only the parsed event and the context is rebuilt here.
 *
 * A `TriggerResult` names one of the pipeline phases (ai/ARCHITECTURE.md
 * "Pipeline phases") plus the inputs that phase's orchestrator
 * (`src/pipeline/*.ts`) needs — the handler resolves those from the event (and,
 * for the PM phases, an authoritative board re-read), and the worker's
 * `processJob` dispatches on `phase` and calls the matching `runXPhase`. The
 * result is a discriminated union so each phase only carries the inputs it
 * actually uses, and the worker's `switch` is exhaustive at compile time. These
 * are in-process shapes (the queue boundary is `src/queue/jobs.ts`), so plain
 * types, not Zod — with one deliberate exception: the phase vocabulary itself
 * ({@link TriggerPhaseSchema}) does get a validator here, because it *is* parsed at
 * boundaries (a transport handshake frame, the persisted worker read model) and
 * those layers should share one rather than each rebuilding its own.
 */

import { z } from 'zod';

import type { ProjectConfig } from '../config/schema.js';
import type { PmEvent } from '../pm/events.js';
import type { PMProvider, PMType, WorkItem } from '../pm/types.js';
import type { ScmEvent } from '../scm/events.js';
import type { SCMProvider, ScmType } from '../scm/types.js';

/**
 * What a trigger handler sees: the resolved project plus the normalized event,
 * discriminated by which ingress produced it.
 *
 * Each variant also carries the provider that owns its event — the `SCMProvider`
 * resolved from `scmProviderRegistry`, the `PMProvider` from `pmProviderRegistry`
 * — resolved once at the composition root that builds this context
 * (`src/worker/consumer.ts`'s `buildTriggerContext`), the same way the worker
 * supplies the other ambient dependencies. Handlers therefore perform every
 * read/write through `ctx.scm` / `ctx.pm` and never name a provider, and a test
 * substitutes a typed fake by setting that one field (ai/RULES.md §2).
 */
export type TriggerContext = {
	project: ProjectConfig;
	/** The provider's per-delivery webhook id, when the job carried one. */
	deliveryId?: string;
	/**
	 * How many times this job has already been re-enqueued because a read the
	 * handler needed answered, but not finally — an incomplete check, an unknown
	 * mergeability (`SwarmJob.recheckAttempt`). 0/absent on a fresh webhook; the
	 * `pr-review` and `resolve-conflicts` handlers read it to cap that loop.
	 */
	recheckAttempt?: number;
	/**
	 * How many times this job has already been re-enqueued because a read *failed*
	 * rather than answered (`SwarmJob.readFailureRecheckAttempt`, issue #720) — its
	 * own budget, so a source-control outage cannot spend the CI-lag allowance
	 * above. 0/absent on a fresh webhook; read by the `pr-review` handler.
	 */
	readFailureRecheckAttempt?: number;
	/** A deferred PM phase that must resume even though its card is now In progress. */
	resumePmPhase?: Extract<TriggerPhase, 'planning' | 'implementation'>;
	/**
	 * How many times this job has already been re-enqueued as a deferred retry.
	 */
	rateLimitRetryAttempt?: number;
	/**
	 * The `runs` row this job re-runs (issue #136).
	 */
	runId?: string;
	/**
	 * Set on a concurrency-deferred continuation's prioritized retry (issue #214):
	 * the dispatch dedup slot is already held from the original dispatch attempt,
	 * so the handler reuses that claim instead of re-claiming (which, fired within
	 * the refreshed claim TTL, would drop the run as a duplicate).
	 */
	continuationDispatchClaimed?: boolean;
	/**
	 * Set on the synthetic review event an operator's "Force re-review" enqueues
	 * (issue #511): the `pr-review-submitted` handler treats this changes-requested
	 * verdict as an authorized continuation past the review-verdict safety cap
	 * rather than failing closed on it.
	 */
	forcedReReview?: boolean;
	/**
	 * Set on the synthetic `checks` event SWARM's own `no-fix` recovery enqueues
	 * (issue #841): the `pr-review` handler treats this head's still-red aggregate
	 * as already adjudicated by the Respond-to-CI agent and dispatches Review
	 * rather than routing back to Respond-to-CI.
	 */
	ciNoFixRecovery?: boolean;
} & (
	| { source: 'scm'; providerId: ScmType; event: ScmEvent; scm: SCMProvider }
	| { source: 'pm'; providerId: PMType; event: PmEvent; pm: PMProvider }
);

/** A trigger context narrowed to the SCM ingress — what every SCM-driven handler takes. */
export type ScmTriggerContext = Extract<TriggerContext, { source: 'scm' }>;

/** A trigger context narrowed to the PM ingress — what every board-driven handler takes. */
export type PmTriggerContext = Extract<TriggerContext, { source: 'pm' }>;

export type TriggerSource = TriggerContext['source'];

/** The pipeline phase a matched trigger runs. */
export type TriggerPhase =
	| 'planning'
	| 'implementation'
	| 'review'
	| 'respond-to-review'
	| 'respond-to-ci'
	| 'resolve-conflicts';

/**
 * Every `TriggerPhase`, keyed so the object literal must name *exactly* the union
 * members: a missing phase or an extra one both fail to type-check, so the runtime
 * enumeration below can never drift from the type above.
 *
 * This is the phase vocabulary's single runtime source. Two other layers need it
 * and used to each keep their own copy: the transport's Zod mirror
 * (`TaskPhaseSchema`, `../transport/protocol.ts`) and the `workers.supported_phases`
 * column's default (`../db/schema/workers.ts`, issue #467). Both now build on
 * {@link ALL_TRIGGER_PHASES}, so adding a phase to the union above is a one-place
 * change that the type-checker propagates.
 */
const TRIGGER_PHASE_KEYS: Record<TriggerPhase, true> = {
	planning: true,
	implementation: true,
	review: true,
	'respond-to-review': true,
	'respond-to-ci': true,
	'resolve-conflicts': true,
};

/** Every pipeline phase, as a runtime list (see {@link TRIGGER_PHASE_KEYS}). */
export const ALL_TRIGGER_PHASES: readonly TriggerPhase[] = Object.keys(
	TRIGGER_PHASE_KEYS,
) as TriggerPhase[];

/**
 * The phase vocabulary's validator, living with the vocabulary itself
 * (ai/CODING_STANDARDS.md "Zod is the source of truth") so every boundary that
 * parses a phase — the transport frame (`TaskPhaseSchema`,
 * `../transport/protocol.ts`) and the persisted worker read model (`WorkerSchema`,
 * `../identity/worker.ts`) — shares one, rather than each rebuilding its own.
 */
export const TriggerPhaseSchema = z.enum(ALL_TRIGGER_PHASES as [TriggerPhase, ...TriggerPhase[]]);

const PRIORITIZED_CONTINUATION_PHASES: ReadonlySet<TriggerPhase> = new Set([
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
]);

/** Whether a phase continues SCM-driven work already in flight. */
export function isPrioritizedContinuationPhase(phase: TriggerPhase): boolean {
	return PRIORITIZED_CONTINUATION_PHASES.has(phase);
}

/**
 * The `taskId` every result carries — the identifier the phase's worktree is
 * provisioned under (`task-<id>`), which is the linked issue/PR number.
 */
interface TriggerResultBase {
	taskId: string;
}

/**
 * Which pipeline phase to run, plus that phase's resolved inputs. The worker
 * supplies the ambient dependencies (project, PM provider, worktree manager);
 * the handler resolves everything here from the event.
 */
export type TriggerResult =
	| (TriggerResultBase & {
			phase: 'planning' | 'implementation';
			/** The board item that entered the triggering status — the work to do. */
			workItem: WorkItem;
	  })
	| (TriggerResultBase & {
			phase: 'review';
			/** The PR under review. */
			prNumber: string;
			/**
			 * The PR head branch. The Review phase itself checks out the head SHA
			 * detached and never uses it; it is carried because the automation-label
			 * gate resolves the PR back to its board work item through this branch
			 * (`<branchPrefix><itemNumber>`, issue #354), and the handler already holds
			 * the PR details a second SCM round-trip would have re-fetched.
			 */
			prBranch: string;
			/** The PR head commit the review is pinned to (`src/pipeline/review.ts`). */
			headSha: string;
	  })
	| (TriggerResultBase & {
			phase: 'respond-to-review';
			/** The PR the review was submitted on. */
			prNumber: string;
			/** The PR head branch the implementer checks out and pushes fixes to. */
			prBranch: string;
			/** The submitted review's numeric ID the implementer must answer. */
			reviewId: string;
			/**
			 * The PR head SHA the submitted review covered — carried so a `fixed`
			 * response can tell whether it actually advanced the head before
			 * scheduling a follow-up Review (issue #241).
			 */
			headSha: string;
	  })
	| (TriggerResultBase & {
			phase: 'respond-to-ci';
			/** The PR whose check suite failed. */
			prNumber: string;
			/** The PR head branch the implementer checks out and pushes the build fix to. */
			prBranch: string;
			/** The head commit whose checks failed — pins the fix to the commit CI ran against. */
			headSha: string;
	  })
	| (TriggerResultBase & {
			phase: 'resolve-conflicts';
			prNumber: string;
			prBranch: string;
			headSha: string;
			baseBranch: string;
			baseSha: string;
	  });

export interface TriggerHandler {
	name: string;
	description: string;
	matches(ctx: TriggerContext): boolean;
	handle(ctx: TriggerContext): Promise<TriggerResult | null>;
}
