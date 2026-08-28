/**
 * The installation's default SCM credential per `(provider, role)` slot — the
 * `instance_scm_credentials` sibling of `./credentialsRepository.ts` and
 * `./workerScmCredentialsRepository.ts` (issue #769).
 *
 * The three tables answer different questions and must not be confused: the first
 * resolves a *project's* credential reference into a secret, the second a *worker's
 * own* identity for one SCM provider, and this one holds the value an instance
 * administrator recorded once as the installation's default for a role every project
 * would otherwise be handed the same secret for.
 *
 * **Nothing here is on a resolution path.** `resolveScmCredentialOrNull`
 * (`src/config/provider.ts`) keeps its no-fallback-chain rule, so a project with no
 * credential of its own still fails naming the project, provider and role rather than
 * quietly resolving this value. Phase 2/2 of issue #769 copies it into a *new*
 * project's own row at creation; setting or clearing it never affects an existing
 * project.
 *
 * Writes encrypt and reads decrypt with {@link instanceScmCredentialAad}, so callers
 * only ever handle plaintext and ciphertext never leaves this module.
 */

import { and, eq, ne } from 'drizzle-orm';

import type { ScmCredentialRole, ScmType } from '../../scm/types.js';
import { getDb } from '../client.js';
import { decryptCredential, encryptCredential } from '../crypto.js';
import { instanceScmCredentials } from '../schema/instanceScmCredentials.js';

/**
 * The Additional Authenticated Data a stored instance default is bound to
 * (`src/db/crypto.ts`) — the slot itself, not a bare `'instance'` constant. Exported so
 * the encrypt and decrypt sides cannot drift, and so the binding itself is assertable.
 *
 * This preserves the property `project_credentials` gets from using `projectId` as AAD:
 * a ciphertext copied into another `(provider, role)` row fails GCM authentication
 * instead of resolving as that provider's secret. Transposed to a tier that has no
 * project, the slot is the only identity there is.
 */
export function instanceScmCredentialAad(providerId: string, role: string): string {
	return `instance:scm:${providerId}:${role}`;
}

/**
 * Resolve the stored default for one `(provider, role)` slot, or `null` when none is
 * stored — a "not found" lookup rather than an error (ai/CODING_STANDARDS.md "Error
 * handling"), so deciding whether absence matters is the caller's job.
 */
export async function resolveInstanceScmCredential(
	providerId: ScmType,
	role: ScmCredentialRole,
): Promise<string | null> {
	const rows = await getDb()
		.select({ value: instanceScmCredentials.value })
		.from(instanceScmCredentials)
		.where(
			and(eq(instanceScmCredentials.providerId, providerId), eq(instanceScmCredentials.role, role)),
		)
		.limit(1);

	const row = rows[0];
	// An empty stored value is treated as absent, matching `isUsableSecret`
	// (`src/api/routers/credentials.ts`): a provider could not authenticate with it. The
	// write path's `z.string().min(1)` makes it unreachable today.
	if (!row || row.value === '') return null;

	return decryptCredential(row.value, instanceScmCredentialAad(providerId, role));
}

/**
 * Write (upsert) the default for one slot. The unique index on `(provider_id, role)`
 * makes a repeat write a rotation — one value per slot — so rotating is a plain re-set
 * rather than a delete-then-write.
 */
export async function writeInstanceScmCredential(
	providerId: ScmType,
	role: ScmCredentialRole,
	value: string,
): Promise<void> {
	const encryptedValue = encryptCredential(value, instanceScmCredentialAad(providerId, role));
	await getDb()
		.insert(instanceScmCredentials)
		.values({ providerId, role, value: encryptedValue })
		.onConflictDoUpdate({
			target: [instanceScmCredentials.providerId, instanceScmCredentials.role],
			set: { value: encryptedValue, updatedAt: new Date() },
		});
}

/**
 * Clear the default for one slot. Clearing a slot that was never set is a no-op, not an
 * error — the end state is the same either way.
 */
export async function deleteInstanceScmCredential(
	providerId: ScmType,
	role: ScmCredentialRole,
): Promise<void> {
	await getDb()
		.delete(instanceScmCredentials)
		.where(
			and(eq(instanceScmCredentials.providerId, providerId), eq(instanceScmCredentials.role, role)),
		);
}

/**
 * Which slots currently hold a value — the **key columns only**, so the admin read
 * never decrypts a secret merely to mask it. (`project_credentials`' own
 * `resolveAllProjectCredentials` + `maskCredential` pair does decrypt, because it has a
 * reference-key indirection to resolve first; this tier has none.)
 *
 * An empty stored value is excluded for the same reason
 * {@link resolveInstanceScmCredential} treats one as absent — reporting it as
 * configured would have the panel claim a default is set that nothing could
 * authenticate with.
 */
export async function listConfiguredInstanceScmCredentials(): Promise<
	Array<{ providerId: string; role: string }>
> {
	return await getDb()
		.select({ providerId: instanceScmCredentials.providerId, role: instanceScmCredentials.role })
		.from(instanceScmCredentials)
		.where(ne(instanceScmCredentials.value, ''));
}
