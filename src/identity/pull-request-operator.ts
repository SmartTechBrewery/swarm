/**
 * Whose credential a write made on behalf of a pull request's author runs as
 * (issue #1249): merge, branch update and check re-run.
 *
 * The control plane holds no implementer credential of its own any more. The pull
 * request's author is the operator whose worker produced it, which the run row
 * records (`runs.worker_id` + `produced_pr_url`, ADR-004 §4), and that worker's
 * stored SCM credential for the project's provider (issue #765) is the account the
 * pull request was opened as. {@link runAsPullRequestOperator} resolves it and binds
 * it as the implementer for the length of one write
 * (`withOperatorCredential`, `src/scm/operator-credential.ts`).
 *
 * **Never a fallback to another account.** When no worker is recorded, or the worker
 * holds no credential for the provider, the write does not happen and
 * {@link PullRequestOperatorUnavailableError} carries a reason the caller records on
 * the run or the pull request. Borrowing some other operator's credential would merge
 * under the wrong name — the exact problem the retired installation-wide token had.
 */

import type { ProjectConfig } from '../config/schema.js';
import { findPullRequestProducerWorkerId } from '../db/repositories/runsRepository.js';
import { getWorkerById } from '../db/repositories/workersRepository.js';
import { requireProjectSCMProviderId } from '../integrations/scm/registry.js';
import { withOperatorCredential } from '../scm/operator-credential.js';
import {
	MissingWorkerScmCredentialError,
	missingOperatorCredentialReason,
	requireWorkerScmCredential,
} from './worker-scm-credential.js';

/** The operator a write is made as — named so a refusal can say whose credential it was. */
export interface PullRequestOperator {
	workerId: string;
	workerName: string;
}

/**
 * Thrown by {@link runAsPullRequestOperator} — before the write is attempted — when no
 * operator credential can be resolved for the pull request. A distinct type so callers
 * settle it as a refusal needing a person rather than as a provider failure to retry;
 * its message is the operator-facing reason and carries no secret.
 */
export class PullRequestOperatorUnavailableError extends Error {
	readonly name = 'PullRequestOperatorUnavailableError';
}

/**
 * Run `fn` as the operator whose worker produced pull request `prNumber` of
 * `project.repo`, with that operator's stored credential bound as the implementer.
 * Throws {@link PullRequestOperatorUnavailableError} without running `fn` when there
 * is none to bind.
 */
export async function runAsPullRequestOperator<T>(
	project: ProjectConfig,
	prNumber: string,
	fn: (operator: PullRequestOperator) => Promise<T>,
): Promise<T> {
	const workerId = await findPullRequestProducerWorkerId(project.id, project.repo, prNumber);
	const worker = workerId ? await getWorkerById(workerId) : undefined;
	if (!worker) {
		throw new PullRequestOperatorUnavailableError(
			`no registered SWARM worker is recorded as having produced pull request #${prNumber} ` +
				`of ${project.repo}, so there is no operator to act as — merges, branch updates and ` +
				'check re-runs are made with the stored credential of the operator whose worker ' +
				'produced the pull request',
		);
	}

	let credential: string;
	try {
		credential = await requireWorkerScmCredential({
			workerId: worker.id,
			workerName: worker.displayName,
			scmProviderId: requireProjectSCMProviderId(project),
		});
	} catch (error) {
		if (error instanceof MissingWorkerScmCredentialError) {
			throw new PullRequestOperatorUnavailableError(missingOperatorCredentialReason(error));
		}
		throw error;
	}

	const operator = { workerId: worker.id, workerName: worker.displayName };
	return withOperatorCredential(credential, () => fn(operator));
}

/**
 * `message` naming the operator a refused write was made as, so a provider rejecting
 * that operator's credential (revoked, expired, missing a scope) is attributable to
 * the worker whose credential needs replacing.
 */
export function attributedToOperator(message: string, operator: PullRequestOperator): string {
	return `${message} (acting as the operator credential stored for worker '${operator.workerName}')`;
}
