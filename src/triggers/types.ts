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
 * types, not Zod.
 */

import type { ProjectConfig } from '../config/schema.js';
import type { WorkItem } from '../pm/types.js';
import type { GitHubProjectsParsedEvent } from '../router/adapters/github-projects.js';
import type { ScmEvent } from '../scm/events.js';
import type { SCMProvider, ScmType } from '../scm/types.js';

/**
 * What a trigger handler sees: the resolved project plus the normalized event,
 * discriminated by which ingress produced it.
 *
 * The SCM variant also carries the `SCMProvider` that owns the event, resolved
 * once from `scmProviderRegistry` at the composition root that builds this
 * context (`src/worker/consumer.ts`'s `buildTriggerContext`) — the same way the
 * worker supplies the other ambient dependencies. Handlers therefore perform
 * every SCM read/write through `ctx.scm` and never name a provider, and a test
 * substitutes a typed fake by setting this one field (ai/RULES.md §2).
 */
export type TriggerContext = {
	project: ProjectConfig;
	/** The provider's per-delivery webhook id, when the job carried one. */
	deliveryId?: string;
	/**
	 * How many times this job has already been re-enqueued as a deferred
	 * incomplete-check recheck (`SwarmJob.recheckAttempt`). 0/absent on a fresh
	 * webhook; the `pr-review` handler reads it to cap the recheck loop.
	 */
	recheckAttempt?: number;
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
} & (
	| { source: 'scm'; providerId: ScmType; event: ScmEvent; scm: SCMProvider }
	| { source: 'github-projects'; event: GitHubProjectsParsedEvent }
);

/** A trigger context narrowed to the SCM ingress — what every SCM-driven handler takes. */
export type ScmTriggerContext = Extract<TriggerContext, { source: 'scm' }>;

export type TriggerSource = TriggerContext['source'];

/** The pipeline phase a matched trigger runs. */
export type TriggerPhase =
	| 'planning'
	| 'implementation'
	| 'review'
	| 'respond-to-review'
	| 'respond-to-ci'
	| 'resolve-conflicts';

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
