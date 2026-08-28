/**
 * The policy layer over the worker operator's stored SCM credential (issue #765)
 * — the `require`-shaped seam a dispatch resolves the identity its phase will
 * commit, push and comment as, before anything is pushed to the worker.
 *
 * It lives here, beside the other worker-identity services, rather than in the
 * repository: the repository answers "is there a row" and this decides that a
 * missing row is fatal, and says so in the operator's terms. Shaped like
 * `MissingPmCredentialError` / `requirePmCredential` (`src/config/provider.ts`) for
 * the same reason — a caller has to be able to *recognize* this case and name what
 * is missing without re-resolving or matching on message text.
 *
 * Resolution deliberately happens per dispatch on the control plane rather than
 * once at worker startup: the control plane is the only side that knows both which
 * worker was selected and which SCM provider the project targets, so it is the only
 * side that can fail attributably — and a credential rotated in the store then takes
 * effect on the next phase, with no worker restart.
 */

import { findProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import { listEnrollmentsForWorker } from '../db/repositories/workerEnrollmentsRepository.js';
import { resolveWorkerScmCredential } from '../db/repositories/workerScmCredentialsRepository.js';
import { requireProjectSCMProviderId } from '../integrations/scm/registry.js';
import { logger } from '../lib/logger.js';
import type { ScmType } from '../scm/types.js';

/** Which worker, and which SCM provider, {@link requireWorkerScmCredential} is asked for. */
export interface WorkerScmCredentialRequest {
	workerId: string;
	/** The worker's human-facing label, so the failure names the machine an operator knows. */
	workerName: string;
	scmProviderId: ScmType;
}

/**
 * Thrown by {@link requireWorkerScmCredential} when a worker holds no operator
 * credential for the SCM provider a dispatch actually targets.
 *
 * A distinct type rather than a bare `Error` so the dispatcher can recognize it and
 * settle the phase as an attributable failure rather than a retry — no delay makes
 * an unset credential appear. It carries the worker and provider — never the
 * credential — so a caller can compose its own copy without re-resolving.
 */
export class MissingWorkerScmCredentialError extends Error {
	readonly name = 'MissingWorkerScmCredentialError';

	constructor(
		readonly workerId: string,
		readonly workerName: string,
		readonly scmProviderId: ScmType,
		message: string,
	) {
		super(message);
	}
}

/**
 * Resolve the operator credential a phase dispatched to `workerId` will run its
 * source-carrying operations under, throwing {@link MissingWorkerScmCredentialError}
 * when none is stored for that `(worker, provider)` pair.
 *
 * The message names the worker (by name *and* id), the provider, and the command
 * that fixes it — the failure this replaces was the provider's own generic "Could
 * not resolve GitHub identity for the operator token", which named neither the
 * machine nor the provider and arrived a few seconds into a run.
 */
export async function requireWorkerScmCredential({
	workerId,
	workerName,
	scmProviderId,
}: WorkerScmCredentialRequest): Promise<string> {
	const credential = await resolveWorkerScmCredential(workerId, scmProviderId);
	if (credential) return credential;

	throw new MissingWorkerScmCredentialError(
		workerId,
		workerName,
		scmProviderId,
		`No operator SCM credential stored for worker '${workerName}' (id ${workerId}) on provider ` +
			`'${scmProviderId}'. Every phase this worker runs against a ${scmProviderId} project ` +
			"commits, pushes and comments as the operator's own account, so it cannot start " +
			`without one — set it with \`swarm workers set-scm-credential ${workerId} ${scmProviderId}\`.`,
	);
}

/**
 * Which SCM providers this worker actually needs an operator credential for — the
 * providers of the projects it is enrolled in, de-duplicated and in enrollment
 * order. The read behind phase 2/3's dashboard form (issue #766), so the slots it
 * offers are the ones a dispatch would really ask a credential for rather than a
 * fixed "GitHub PAT" field.
 *
 * It lives beside {@link requireWorkerScmCredential} rather than in the router
 * because it is policy about *this* credential, and because it must resolve a
 * project's provider **exactly the way the dispatcher does** —
 * `requireProjectSCMProviderId`, never `project.scm ?? 'github'`, which would offer
 * a Bitbucket-only worker a GitHub slot.
 *
 * Every enrollment counts regardless of status: a `pending` one is the acceptance
 * criteria's "or is being enrolled in", and a suspended one still holds a
 * credential worth rotating.
 *
 * A project whose provider does not resolve — unregistered, not runtime-ready, or
 * naming none while two-plus are ready — is **skipped with a debug log** rather
 * than surfaced as a slot or thrown out of the read: the fix there is that
 * project's own `scm` config, not the worker owner's credential, and a dispatch for
 * it fails with the registry's own specific message either way.
 */
export async function listWorkerScmProviders(workerId: string): Promise<ScmType[]> {
	const enrollments = await listEnrollmentsForWorker(workerId);
	const providerIds: ScmType[] = [];

	for (const enrollment of enrollments) {
		const project = await findProjectByIdFromDb(enrollment.projectId);
		if (!project) continue;
		let providerId: ScmType;
		try {
			providerId = requireProjectSCMProviderId(project);
		} catch (error) {
			logger.debug('skipping a worker enrollment whose project resolves no SCM provider', {
				workerId,
				projectId: enrollment.projectId,
				reason: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		if (!providerIds.includes(providerId)) providerIds.push(providerId);
	}

	return providerIds;
}
