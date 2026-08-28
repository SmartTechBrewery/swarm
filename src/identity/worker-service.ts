/**
 * Provider-neutral **worker** domain surface — the seam later phases program
 * against so they never touch the `workers` table directly. The worker-side
 * companion to the identity read model (`./service.ts`) and membership read model
 * (`./membership-service.ts`), the third slice of the multi-user foundation
 * (ADR-001).
 *
 * Unlike those read-only services this one also owns the worker's credential and
 * the register/refresh/rename writes — the same way `./auth.ts` bundles the
 * session token primitives with `createSession`, rather than splitting a
 * two-line secret into its own module. Reads (`getWorker`, `listWorkersForOwner`)
 * and the authentication seam (`resolveWorkerByCredential`) round out the
 * surface Phase 2's lease/heartbeat operations authenticate through.
 *
 * The worker credential is a high-entropy random token (not a low-entropy
 * password), so — exactly like a session token (`./auth.ts` `hashSessionToken`)
 * — it is stored as a plain SHA-256 with no salt/stretch and resolved by hash
 * lookup. It is distinct from any SCM PAT, returned in raw form **exactly once**
 * at registration (`RegisteredWorker.credential`), and never stored, logged, or
 * returned again (the same contract as `MintedSession`). Dependency-free
 * (`node:crypto`), per ai/RULES.md §2.
 */

import { createHash, randomBytes } from 'node:crypto';

import {
	createWorker,
	findWorkerByCredentialHash,
	getWorkerById,
	getWorkersByIds,
	listWorkersForOwner as listWorkersForOwnerRows,
	setWorkerDeclaredCapabilities,
	updateWorkerCapabilities,
	updateWorkerDisplayName,
	updateWorkerSupportedPhases,
} from '../db/repositories/workersRepository.js';
import type { AgentCli } from '../harness/agent-cli.js';
import { RepoSlugSchema } from '../scm/repo-slug.js';
import type { TriggerPhase } from '../triggers/types.js';
import type { Worker } from './worker.js';
import {
	WorkerCapabilitiesSchema,
	WorkerDisplayNameSchema,
	WorkerSupportedPhasesSchema,
} from './worker.js';

export type { Worker } from './worker.js';
export { WorkerCapabilityNotProbedError, WorkerCapabilityReductionError } from './worker.js';

/**
 * Worker credential: 32 random bytes (256 bits) is well beyond guessing range,
 * so the stored SHA-256 needs no salt/stretch (unlike a low-entropy password) —
 * the same reasoning as `SESSION_TOKEN_BYTES` in `./auth.ts`.
 */
const CREDENTIAL_BYTES = 32;

/** SHA-256 of a raw worker credential — the only form that touches the DB. */
export function hashWorkerCredential(raw: string): string {
	return createHash('sha256').update(raw).digest('hex');
}

/** A freshly issued worker credential: the raw token (shown once) and its hash. */
export interface IssuedCredential {
	token: string;
	hash: string;
}

/**
 * Issue a worker credential: an opaque high-entropy token and its SHA-256. The
 * raw token is the caller's to hand to the operator once; only the hash is ever
 * persisted (mirrors `createSession` minting a session token in `./auth.ts`).
 */
export function issueWorkerCredential(): IssuedCredential {
	const token = randomBytes(CREDENTIAL_BYTES).toString('base64url');
	return { token, hash: hashWorkerCredential(token) };
}

/** The fields a caller supplies to register a worker. */
export interface RegisterWorkerInput {
	ownerUserId: string;
	displayName: string;
	capabilities: AgentCli[];
}

/**
 * A newly registered worker: the domain `Worker` (no credential material) plus
 * the raw `credential`, returned **exactly once** — it is never stored, logged,
 * or returned again (the same contract as `MintedSession`).
 */
export interface RegisteredWorker {
	worker: Worker;
	credential: string;
}

/**
 * Register a worker for an owner: validate the display name and capabilities,
 * issue a credential, persist the worker with only the credential *hash*, and
 * return the worker plus the raw credential once. A duplicate `(owner,
 * displayName)` surfaces the repository's pg `23505` for the caller to translate.
 */
export async function registerWorker(input: RegisterWorkerInput): Promise<RegisteredWorker> {
	const displayName = WorkerDisplayNameSchema.parse(input.displayName);
	const capabilities = WorkerCapabilitiesSchema.parse(input.capabilities);
	const credential = issueWorkerCredential();
	const worker = await createWorker({
		ownerUserId: input.ownerUserId,
		displayName,
		capabilities,
		credentialHash: credential.hash,
	});
	return { worker, credential: credential.token };
}

/**
 * Record the CLI set a daemon just **probed** on its own PATH. Validates the set
 * (non-empty, de-duplicated `AgentCli` values) and updates it. Returns the updated
 * worker, or `undefined` if no worker has that id.
 *
 * This declares the *probe*, which an owner's stored declaration now outranks
 * (issue #783): the write is unchanged and still honest about what the machine
 * reported, but what the worker is routable on afterwards is
 * `effectiveCapabilities(probe, declaration)`. Stating a durable declaration is
 * {@link declareWorkerCapabilities}'s job, and no handshake reaches it.
 *
 * `supportedPhases` (issue #467) is the daemon's declared phase repertoire, written
 * in the same transaction when supplied. Omit it — as `swarm workers set-cli` does —
 * to leave the stored phases as they are; a caller that knows nothing about phases
 * must not reset them to the every-phase default.
 *
 * `repository` (issue #687) is which repository the daemon's one local checkout is,
 * written in that same transaction and validated here — so the service seam, not
 * only the wire, is a boundary that cannot store an unnormalised slug. Three-valued
 * exactly as the repository layer documents: omit it to leave the stored value alone
 * (again the `set-cli` path), pass `null` when the connecting daemon declared none,
 * which clears a previous daemon's statement.
 */
export async function refreshWorkerCapabilities(
	id: string,
	capabilities: AgentCli[],
	supportedPhases?: TriggerPhase[],
	repository?: string | null,
): Promise<Worker | undefined> {
	const validated = WorkerCapabilitiesSchema.parse(capabilities);
	const validatedPhases =
		supportedPhases === undefined ? undefined : WorkerSupportedPhasesSchema.parse(supportedPhases);
	const validatedRepository =
		repository === undefined || repository === null ? repository : RepoSlugSchema.parse(repository);
	return updateWorkerCapabilities(id, validated, validatedPhases, validatedRepository);
}

/**
 * State (or clear) the **owner's declaration** of which agent CLIs a worker should
 * run (issue #783) — the durable half of the CLI axis, and the seam `swarm workers
 * set-cli` writes through so its statement survives the machine's next reconnect.
 *
 * A non-null set is validated exactly as a probe is ({@link WorkerCapabilitiesSchema}:
 * non-empty, de-duplicated) — an empty declaration would mean "routable for
 * nothing", which is what revoking an enrollment's consent expresses, not a CLI set.
 * `null` passes straight through and clears the declaration, returning the worker to
 * plain auto-discovery.
 *
 * Returns the updated worker, or `undefined` if no worker has that id. Rejects with
 * {@link WorkerCapabilityNotProbedError} when the declaration names a CLI the
 * machine's daemon has never reported, and with
 * {@link WorkerCapabilityReductionError} when it would drop a CLI an existing
 * enrollment still requires; both are checked under one lock in the repository.
 */
export async function declareWorkerCapabilities(
	id: string,
	capabilities: AgentCli[] | null,
): Promise<Worker | undefined> {
	const validated = capabilities === null ? null : WorkerCapabilitiesSchema.parse(capabilities);
	return setWorkerDeclaredCapabilities(id, validated);
}

/**
 * Declare the phase repertoire of the program currently operating a worker row,
 * without touching its CLI set (issue #467). Validates the set
 * ({@link WorkerSupportedPhasesSchema}: non-empty, de-duplicated) and returns the
 * updated worker, or `undefined` if no worker has that id.
 *
 * The transport handshake declares both axes at once
 * (`refreshWorkerCapabilities`); this is the seam for the **in-process** host
 * worker, which authenticates by acquiring an execution session instead of
 * handshaking and must not overwrite the operator-registered CLI set. Keeping both
 * programs declarative is what stops a stored set from outliving the program that
 * wrote it.
 */
export async function declareWorkerSupportedPhases(
	id: string,
	supportedPhases: TriggerPhase[],
): Promise<Worker | undefined> {
	const validated = WorkerSupportedPhasesSchema.parse(supportedPhases);
	return updateWorkerSupportedPhases(id, validated);
}

/**
 * Rename a worker — the owner's own label for their machine. Validates the name
 * ({@link WorkerDisplayNameSchema}) and returns the updated worker, or
 * `undefined` if no worker has that id. Rejects with the repository's pg
 * `23505` unique violation if the owner already has another worker by that
 * name; the caller decides how to surface that.
 */
export async function renameWorker(id: string, displayName: string): Promise<Worker | undefined> {
	const validated = WorkerDisplayNameSchema.parse(displayName);
	return updateWorkerDisplayName(id, validated);
}

/** Resolve a worker by id. Returns `undefined` if unknown. */
export async function getWorker(id: string): Promise<Worker | undefined> {
	return getWorkerById(id);
}

/**
 * Resolve several workers by id in one read (issue #523) — the batched form of
 * {@link getWorker}, for a caller labelling a whole page of rows with the
 * machines that produced them. Unknown ids are absent from the result rather
 * than reported as an error, exactly as `getWorker` returns `undefined`.
 */
export async function getWorkers(ids: string[]): Promise<Worker[]> {
	return getWorkersByIds(ids);
}

/** Every worker an owner operates (empty if they operate none). */
export async function listWorkersForOwner(ownerUserId: string): Promise<Worker[]> {
	return listWorkersForOwnerRows(ownerUserId);
}

/**
 * Resolve a raw worker credential to its `Worker` — the authentication seam
 * Phase 2's lease/heartbeat operations authenticate through. Returns `undefined`
 * for an empty or unknown credential (a not-found, not an error), mirroring
 * `resolveSession` in `./auth.ts`. The returned worker never carries the
 * credential hash.
 */
export async function resolveWorkerByCredential(
	rawCredential: string,
): Promise<Worker | undefined> {
	if (!rawCredential) return undefined;
	return findWorkerByCredentialHash(hashWorkerCredential(rawCredential));
}
