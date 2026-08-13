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
import type { PmEvent } from '../pm/events.js';
import type { PMType } from '../pm/types.js';
import type { SwarmJob } from '../queue/jobs.js';
import { enqueueJob, priorityFor } from '../queue/producer.js';
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
 * Hand a verified, project-matched, non-self-authored PM board state change off to
 * the dispatch layer — the PM-side counterpart of {@link enqueueScmEvent}.
 * `providerId` records which registered provider owns the event so the worker can
 * resolve the same one back. The worker re-reads the authoritative item state
 * itself (`src/worker/consumer.ts` re-reads config from Postgres and dispatches
 * against the normalized event), so this stays symmetric with the SCM path.
 *
 * `repository` is the one the card routed to (issue #686 phase 2), already decided
 * by the caller — an explicit argument rather than something re-derived from
 * `project`, which is the *default-scoped* config the delivery was authenticated
 * against and therefore cannot name it. `undefined` leaves the job scoping to the
 * project's default entry, as every pre-#686 row does.
 */
export async function enqueuePmEvent(
	providerId: PMType,
	event: PmEvent,
	project: ProjectConfig,
	deliveryId: string | undefined,
	repository: string | undefined,
): Promise<void> {
	await dispatchWebhookJob({
		type: 'pm',
		providerId,
		projectId: project.id,
		deliveryId,
		event,
		...(repository ? { repository } : {}),
	});
	logger.debug('PM board event dispatched', {
		providerId,
		projectId: project.id,
		containerId: event.containerId,
		action: event.action,
		itemId: event.itemId,
		changedField: event.changedField,
		repository,
		deliveryId,
	});
}
