/**
 * The worker operator's own SCM credential, at rest — the `worker_scm_credentials`
 * twin of `./credentialsRepository.ts` (issue #765).
 *
 * The two tables answer different questions and must not be confused: that one
 * resolves a *project's* credential *reference* into a secret, this one resolves a
 * *worker's own* identity for one SCM provider. Nothing here is project-scoped, so
 * nothing here reintroduces the retired `credentials.implementer` persona (#396).
 *
 * Writes encrypt and reads decrypt with {@link workerScmCredentialAad}, so callers
 * only ever handle plaintext and ciphertext never leaves this module.
 */

import { and, eq } from 'drizzle-orm';

import type { ScmType } from '../../scm/types.js';
import { getDb } from '../client.js';
import { decryptCredential, encryptCredential } from '../crypto.js';
import { workerScmCredentials } from '../schema/workerScmCredentials.js';

/**
 * The Additional Authenticated Data a stored operator credential is bound to
 * (`src/db/crypto.ts`). Exported so the encrypt and decrypt sides cannot drift, and
 * so the binding itself is assertable.
 *
 * Both parts are in it deliberately: with the worker alone, a ciphertext could be
 * moved between that worker's own provider rows and still authenticate — resolving
 * a GitHub token for a GitLab dispatch. With both, either move fails GCM
 * authentication instead.
 */
export function workerScmCredentialAad(workerId: string, scmProviderId: ScmType): string {
	return `${workerId}:${scmProviderId}`;
}

/**
 * Resolve a worker's stored operator credential for one SCM provider, or `null`
 * when none is stored — a "not found" lookup rather than an error
 * (ai/CODING_STANDARDS.md "Error handling"). Deciding whether absence is fatal
 * belongs to the caller, which for a dispatch is
 * `requireWorkerScmCredential` (`src/identity/worker-scm-credential.ts`).
 */
export async function resolveWorkerScmCredential(
	workerId: string,
	scmProviderId: ScmType,
): Promise<string | null> {
	const rows = await getDb()
		.select({ value: workerScmCredentials.value })
		.from(workerScmCredentials)
		.where(
			and(
				eq(workerScmCredentials.workerId, workerId),
				eq(workerScmCredentials.scmProviderId, scmProviderId),
			),
		)
		.limit(1);

	const row = rows[0];
	if (!row) return null;

	return decryptCredential(row.value, workerScmCredentialAad(workerId, scmProviderId));
}

/**
 * Write (upsert) a worker's operator credential for one SCM provider. The unique
 * index on `(worker_id, scm_provider_id)` makes a repeat write a rotation — one
 * value per provider per worker — which takes effect on the next dispatch, since
 * resolution happens per dispatch rather than at worker startup.
 */
export async function writeWorkerScmCredential(
	workerId: string,
	scmProviderId: ScmType,
	value: string,
): Promise<void> {
	const encryptedValue = encryptCredential(value, workerScmCredentialAad(workerId, scmProviderId));
	await getDb()
		.insert(workerScmCredentials)
		.values({ workerId, scmProviderId, value: encryptedValue })
		.onConflictDoUpdate({
			target: [workerScmCredentials.workerId, workerScmCredentials.scmProviderId],
			set: { value: encryptedValue, updatedAt: new Date() },
		});
}
