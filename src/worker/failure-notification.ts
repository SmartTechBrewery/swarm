/**
 * The operator notice for a run that failed terminally while other work items wait
 * on its own (issue #1257).
 *
 * A terminal failure is already reported on the run's own item or pull request
 * (`reportPhaseFailureToBoardOrPr`, `./consumer.ts`), but nobody reads that at night —
 * and when the item blocks others, the whole dependency chain behind it stands still
 * until someone happens to look. This sends one JSON `POST` to the project's
 * `pipeline.failureNotifications.webhookUrl` naming the run, the failure and the open
 * items waiting on it. A plain webhook rather than one chat integration, so any channel
 * with an incoming-webhook endpoint can take it; the body's `text` is a line a
 * Slack-style endpoint shows as it is.
 *
 * "Waiting" is read from the PM provider's native dependency graph
 * (`PMProvider.listDependents`), never from prose — the same authority the dependency
 * gate holding those items back uses. Best-effort throughout: a notice that cannot be
 * sent is logged and never fails the settle of a run that has already failed.
 */

import type { ProjectConfig } from '../config/schema.js';
import { findBoardItemIdForTask } from '../db/repositories/runsRepository.js';
import { requireProjectPMProvider } from '../integrations/pm/registry.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { phaseLabel } from '../pipeline/phase-label.js';
import type { WorkItemDependent } from '../pm/types.js';
import type { TriggerResult } from '../triggers/types.js';

/** How long the webhook may take before the notice is given up on. */
const NOTIFICATION_TIMEOUT_MS = 10_000;

/** The longest failure reason the one-line `text` quotes; `reason` carries it whole. */
const TEXT_REASON_LIMIT = 500;

/** The terminal failure a notice is about. */
export interface BlockingFailure {
	project: ProjectConfig;
	trigger: TriggerResult;
	runId: string | undefined;
	/** The run's terminal error, as it is recorded on the run. */
	error: string;
}

/** The JSON body a blocking-failure notice is sent with. */
export interface BlockingFailureNotification {
	/** One human-readable line, for an endpoint that shows `text` as it is. */
	text: string;
	run: { id: string | null; projectId: string; phase: string; taskId: string };
	reason: string;
	/** The open work items waiting on the failed one. */
	waiting: { reference: string; title: string; url: string }[];
}

type FetchImpl = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

/** Compose the notice for `failure`, given the open items waiting on it. */
export function blockingFailureNotification(
	failure: BlockingFailure,
	waiting: WorkItemDependent[],
): BlockingFailureNotification {
	const { project, trigger, runId, error } = failure;
	const items = waiting.map(({ reference, title }) => `${reference} ${title}`).join(', ');
	const reason =
		error.length > TEXT_REASON_LIMIT ? `${error.slice(0, TEXT_REASON_LIMIT - 1)}…` : error;
	return {
		text:
			`SWARM: ${phaseLabel(trigger.phase)} of task ${trigger.taskId} in ${project.name} failed` +
			`${runId ? ` (run ${runId})` : ''} and ${waiting.length} work item` +
			`${waiting.length === 1 ? ' waits' : 's wait'} on it: ${items}. Reason: ${reason}`,
		run: { id: runId ?? null, projectId: project.id, phase: trigger.phase, taskId: trigger.taskId },
		reason: error,
		waiting: waiting.map(({ reference, title, url }) => ({ reference, title, url })),
	};
}

/**
 * The open items natively blocked by the failed run's own work item. A board phase
 * carries its item; a pull-request phase recovers it from the durable task ↔ card link
 * the board phases recorded (`findBoardItemIdForTask`), and a task the board never
 * drove has nothing waiting on it that SWARM can name.
 */
async function openDependents(
	project: ProjectConfig,
	trigger: TriggerResult,
): Promise<WorkItemDependent[]> {
	const pm = requireProjectPMProvider(project);
	if (!pm.supportsDependencies) return [];
	const workItemId =
		'workItem' in trigger
			? trigger.workItem.id
			: await findBoardItemIdForTask(project.id, trigger.taskId);
	if (!workItemId) return [];
	return (await pm.listDependents(workItemId)).filter((dependent) => dependent.open);
}

/**
 * Tell the operator that `failure` blocks other work, when the project asks for it
 * (`pipeline.failureNotifications`) and anything is in fact waiting. Never throws.
 */
export async function notifyBlockingFailure(
	failure: BlockingFailure,
	fetchImpl: FetchImpl = globalThis.fetch as unknown as FetchImpl,
): Promise<void> {
	const config = failure.project.pipeline?.failureNotifications;
	if (!config?.webhookUrl || config.enabled === false) return;
	const logContext = {
		projectId: failure.project.id,
		phase: failure.trigger.phase,
		taskId: failure.trigger.taskId,
		runId: failure.runId,
	};
	try {
		const waiting = await openDependents(failure.project, failure.trigger);
		if (waiting.length === 0) return;
		const response = await fetchImpl(config.webhookUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(blockingFailureNotification(failure, waiting)),
			signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`the webhook answered with status ${response.status}`);
		logger.info('Sent the blocking-failure notification', {
			...logContext,
			waiting: waiting.map((dependent) => dependent.reference),
		});
	} catch (err) {
		// The URL is not logged: an incoming-webhook URL is often its own credential.
		logger.warn('Failed to send the blocking-failure notification', {
			...logContext,
			error: describeError(err),
		});
	}
}
