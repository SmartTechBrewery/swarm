/**
 * Enqueue seam — the boundary between the webhook receiver and the dispatch
 * layer.
 *
 * The receiver's job (SWARM-9) ends once an event has been authenticated,
 * matched to a project, and cleared by loop prevention; at that point it hands
 * the normalized event here. Since issue #284 (ADR-002) this creates a durable
 * dispatch record and publishes its wake-up (`src/dispatch/dispatcher.ts`)
 * rather than writing business state into BullMQ: the delivery id becomes the
 * dispatch's permanent dedup identity, so a redelivered webhook can never mint
 * a second dispatch. The trigger decision is not embedded here — the worker
 * runs the trigger registry against the parsed event after claiming the
 * dispatch.
 *
 * The router does not run DB migrations; if the dispatch table is unavailable
 * (a mid-deploy window), the event falls back to a legacy dispatch-less queue
 * job, which the worker adopts into the durable model at dequeue — a webhook is
 * never dropped because the dispatch layer was mid-deploy.
 */

import type { ProjectConfig } from '../config/schema.js';
import { createAndPublishDispatch, deliveryDedupKey } from '../dispatch/dispatcher.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { SwarmJob } from '../queue/jobs.js';
import { enqueueJob, priorityFor } from '../queue/producer.js';
import type { GitHubProjectsParsedEvent } from '../router/adapters/github-projects.js';
import type { ScmEvent } from '../scm/events.js';
import type { ScmType } from '../scm/types.js';

async function dispatchWebhookJob(job: SwarmJob): Promise<void> {
	try {
		const { dispatch, created } = await createAndPublishDispatch({
			projectId: job.projectId,
			jobPayload: job,
			dedupKey: job.deliveryId ? deliveryDedupKey(job.deliveryId) : undefined,
			priority: priorityFor(job) ?? 0,
			source: 'webhook',
		});
		if (!created) {
			logger.debug('Webhook delivery already dispatched — deduplicated', {
				projectId: job.projectId,
				deliveryId: job.deliveryId,
				dispatchId: dispatch.id,
			});
		}
	} catch (err) {
		// Degraded fallback: enqueue a legacy job the worker adopts at dequeue.
		logger.warn('Dispatch record creation failed — enqueueing legacy job', {
			projectId: job.projectId,
			deliveryId: job.deliveryId,
			error: describeError(err),
		});
		await enqueueJob(job);
	}
}

/**
 * Hand a verified, project-matched, non-SWARM-generated SCM event off to the
 * dispatch layer. `providerId` records which registered provider owns the event so
 * the worker can resolve the same one back; `deliveryId` is the provider's
 * per-delivery id — the dispatch's dedup identity and the tracing handle.
 */
export async function enqueueScmEvent(
	providerId: ScmType,
	event: ScmEvent,
	project: ProjectConfig,
	deliveryId: string | undefined,
): Promise<void> {
	await dispatchWebhookJob({
		type: 'scm',
		providerId,
		projectId: project.id,
		deliveryId,
		event,
	});
	logger.debug('Webhook event dispatched', {
		providerId,
		projectId: project.id,
		repo: event.repoFullName,
		eventKind: event.kind,
		action: event.action,
		workItemId: event.workItemId,
		deliveryId,
	});
}

/**
 * Hand a verified, project-matched, non-self-authored `projects_v2_item` status
 * change off to the dispatch layer — the PM-side counterpart of
 * {@link enqueueScmEvent}. The worker re-reads the authoritative item state
 * itself (`src/worker/consumer.ts` re-reads config from Postgres and dispatches
 * against the parsed event), so this stays symmetric with the SCM path.
 */
export async function enqueueProjectsEvent(
	event: GitHubProjectsParsedEvent,
	project: ProjectConfig,
	deliveryId: string | undefined,
): Promise<void> {
	await dispatchWebhookJob({
		type: 'github-projects',
		projectId: project.id,
		deliveryId,
		event,
	});
	logger.debug('Projects webhook event dispatched', {
		projectId: project.id,
		projectNodeId: event.projectNodeId,
		eventType: event.eventType,
		action: event.action,
		itemNodeId: event.itemNodeId,
		changedFieldNodeId: event.changedFieldNodeId,
		deliveryId,
	});
}
