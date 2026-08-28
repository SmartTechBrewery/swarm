/**
 * Pure builder for the `TaskAssignment` cloud→worker frame
 * (`./protocol.ts`). It assembles the frame from a resolved dispatch and is the
 * single place the **project secret boundary** is enforced: it accepts the *full*
 * `ProjectConfig` and derives the non-secret slice itself
 * (`toNonSecretProjectConfig`), so no caller can route credential references
 * around it onto the wire.
 *
 * That boundary is the *project's* credentials, and since issue #765 it is worth
 * stating as such: the frame also carries `operatorCredential`, the **worker's own**
 * operator SCM identity, resolved per `(worker, project.scm)` from the durable store
 * and required by the one machine that has to perform the commit and the push. It is
 * required on this builder's input precisely so the control plane cannot assemble a
 * frame without having resolved one.
 *
 * Everything is a pure function of its inputs — the target branch and system
 * prompt arrive already resolved/composed by the caller (the control plane —
 * phase 4) — and the assembled frame is validated against
 * `TaskAssignmentSchema` before it is returned, so a malformed assembly fails
 * loudly at this seam rather than silently on the wire.
 *
 * Purely additive: nothing imports this yet, so the running in-process pipeline
 * is untouched.
 */

import { toNonSecretProjectConfig } from '../config/project-config-slice.js';
import type { AgentTarget, ProjectConfig } from '../config/schema.js';
import type { WorkItem } from '../pm/types.js';
import type { RecoveryIntent } from '../queue/jobs.js';
import {
	type AssignedWorkItem,
	type TaskAssignment,
	TaskAssignmentSchema,
	type TaskPhase,
	TRANSPORT_PROTOCOL_VERSION,
} from './protocol.js';

/**
 * Session-threading / resume fields, grouped as the worker phase runner consumes
 * them — the run's {@link RecoveryIntent}, which is the *one* declaration of
 * these members (`../queue/jobs.ts`) rather than a fourth hand-maintained copy of
 * them (issue #591). Callers derive it from the job with `recoveryIntentFromJob`.
 */
export type TaskAssignmentSession = RecoveryIntent;

/** PR coordinates for the SCM-driven phases (review / respond-to-* / resolve-conflicts). */
export interface TaskAssignmentPr {
	prNumber: string;
	prBranch?: string;
	headSha?: string;
	/** Only respond-to-review carries a submitted review to answer. */
	reviewId?: string;
	/** Only resolve-conflicts carries the base branch/SHA it rebases onto. */
	baseBranch?: string;
	baseSha?: string;
}

/**
 * Everything `buildTaskAssignment` needs. `project` is the FULL config — the
 * builder strips secrets itself. `workItem` and `pr` are the per-phase inputs
 * (mirroring `TriggerResult`): planning/implementation pass `workItem`; the PR
 * phases pass `pr`.
 */
export interface BuildTaskAssignmentInput {
	dispatchId: string;
	runId?: string;
	/** FULL project config — the builder derives the non-secret slice from it. */
	project: ProjectConfig;
	phase: TaskPhase;
	taskId: string;
	/** Resolved by the caller (phase 4). */
	targetBranch: string;
	/** Composed by the caller (phase 4). */
	systemPrompt: string;
	customPrompt?: string;
	target: AgentTarget;
	timeoutMs?: number;
	session?: TaskAssignmentSession;
	workItem?: WorkItem;
	pr?: TaskAssignmentPr;
	/**
	 * respond-to-review only: the board card the PR's task was dispatched from,
	 * already resolved by the caller from the durable `runs.work_item_id` link
	 * (`../dispatch/board-card.ts`, issue #498). Resolved control-plane side
	 * because a federated worker must not need a database (ADR-003 §2 / ADR-004
	 * §3); omitted when nothing links the task to a card.
	 */
	boardItemId?: string;
	/**
	 * The repository this run acts on, resolved by the caller from the same source
	 * the run row's `repository` column is written from (issue #683). Carried on the
	 * frame because a federated worker has no database to read that row from
	 * (ADR-003 §2 / ADR-004 §3); omitted only by a router predating the field.
	 */
	repository?: string;
	/**
	 * The selected worker's own operator SCM credential for this project's provider,
	 * resolved by the caller from the per-`(worker, provider)` store
	 * (`requireWorkerScmCredential`, `../identity/worker-scm-credential.ts`).
	 *
	 * **Required**, unlike every other addition to this input: a frame built without
	 * one describes a run that cannot commit or push, and making that a compile error
	 * here is what keeps the resolution from being forgotten at a new call site.
	 */
	operatorCredential: string;
}

/** Map a PM `WorkItem` to the transport's serialization subset (`AssignedWorkItem`). */
function toAssignedWorkItem(workItem: WorkItem): AssignedWorkItem {
	return {
		id: workItem.id,
		title: workItem.title,
		description: workItem.description,
		url: workItem.url,
		taskRef: workItem.taskRef,
		taskRepository: workItem.taskRepository,
		status: workItem.status,
		statusId: workItem.statusId,
		statusKey: workItem.statusKey,
		labels: workItem.labels.map((label) => ({
			id: label.id,
			name: label.name,
			color: label.color,
		})),
		assignees: workItem.assignees.map((assignee) => ({
			handle: assignee.handle,
			displayName: assignee.displayName,
			providerId: assignee.providerId,
		})),
	};
}

/**
 * Build a validated `TaskAssignment` from a resolved dispatch. Its
 * `projectConfig` is the non-secret slice only — never a persona token or
 * credential reference — beside the receiving worker's own `operatorCredential`
 * (see the module header). Throws (via `TaskAssignmentSchema.parse`) if the
 * assembly is malformed, so a bad frame never reaches the wire.
 */
export function buildTaskAssignment(input: BuildTaskAssignmentInput): TaskAssignment {
	const assignment = {
		type: 'task-assignment' as const,
		protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		dispatchId: input.dispatchId,
		runId: input.runId,
		phase: input.phase,
		taskId: input.taskId,
		// The secret boundary: derive the non-secret slice from the full config here.
		projectConfig: toNonSecretProjectConfig(input.project),
		targetBranch: input.targetBranch,
		systemPrompt: input.systemPrompt,
		customPrompt: input.customPrompt,
		target: input.target,
		timeoutMs: input.timeoutMs,
		...input.session,
		workItem: input.workItem ? toAssignedWorkItem(input.workItem) : undefined,
		...input.pr,
		boardItemId: input.boardItemId,
		repository: input.repository,
		operatorCredential: input.operatorCredential,
	};
	// Validate before returning so a bad assembly fails at the seam, not on the wire.
	return TaskAssignmentSchema.parse(assignment);
}
