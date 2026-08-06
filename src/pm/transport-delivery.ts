/**
 * Worker-side transport-backed PM **write** delegate (ADR-004 §2, the Phase 2/2
 * counterpart of `../scm/transport-delivery.ts`). A federated worker (one that
 * does not hold the per-project PM credential) uses this provider so the two
 * metadata-only PM board writes — `moveWorkItem`, `addComment` — travel up the
 * transport to the control-plane delivery API (`../router/worker-delivery.ts`),
 * which performs the board write under the PM credential. Only metadata (a
 * canonical status key or a comment body) crosses the wire; the repository tree
 * never does (ai/RULES.md §1). The wire mechanics live in the shared client
 * (`../transport/delivery-client.ts`).
 *
 * Two shapes share those writes, for the two kinds of worker:
 *
 * - {@link createTransportPmDeliveryProvider} — the **composite**, for a worker
 *   that still holds `DATABASE_URL` and can build an in-process provider: every
 *   remaining `PMProvider` method (the reads `getWorkItem`/`listWorkItems`/
 *   `findComment`/`listBlockers`, the other writes `createWorkItem`/
 *   `updateWorkItem`/`addLabel`/`addBlockedBy`, and `discover`) delegates
 *   verbatim to a `localDelegate`, so the full interface the pipeline phases
 *   expect is preserved unchanged.
 * - {@link createWriteOnlyTransportPmProvider} — the **delegate-less** variant,
 *   for a DB-free remote worker (`../transport/assignment-execution.ts`) that has
 *   no in-process provider to fall back on: every board write rides the transport,
 *   as do the four narrow reads a DB-free phase needs — `listBlockers` (the
 *   dependency gate must keep gating), `findWorkItemByUrlSuffix`
 *   (Respond-to-review's board card), `findWorkItemForArtifact` (the
 *   repository-scoped automation gate), and `findComment` (Planning's own replay
 *   guard) — while the two *enumerating/whole-item* reads refuse with an actionable
 *   error, because the control plane already performed the reads the assignment was
 *   composed from.
 *
 * A non-2xx or unparseable response **throws**, so the phase's existing
 * best-effort / board-report handling behaves exactly as it does with the
 * in-process provider today.
 */

import { type DeliveryClientOptions, postDelivery } from '../transport/delivery-client.js';
import {
	AddBlockedByDeliveryResponseSchema,
	AddPmCommentDeliveryResponseSchema,
	AddPmLabelDeliveryResponseSchema,
	CreateWorkItemDeliveryResponseSchema,
	FindPmCommentDeliveryResponseSchema,
	FindWorkItemDeliveryResponseSchema,
	type FoundWorkItem,
	ListBlockersDeliveryResponseSchema,
	MoveWorkItemDeliveryResponseSchema,
	UpdateWorkItemDeliveryResponseSchema,
} from '../transport/protocol.js';
import type { PMProvider, PMType, WorkItem, WorkItemArtifact } from './types.js';

export type { FetchLike } from '../transport/delivery-client.js';

/** What both shapes need to reach the control plane's PM delivery routes. */
interface TransportPmWriteOptions extends DeliveryClientOptions {
	/** The project id, sent so the server resolves the right PM credential + enrollment. */
	projectId: string;
}

export interface TransportPmDeliveryOptions extends TransportPmWriteOptions {
	/** The worker's in-process provider, handling every read + non-metadata-write op. */
	localDelegate: PMProvider;
}

export interface WriteOnlyTransportPmDeliveryOptions extends TransportPmWriteOptions {
	/**
	 * The project's configured PM provider type (`project.pm.type`), reported as
	 * this provider's own `type`. Taken from the config rather than hard-coded so
	 * no concrete provider is named here (ai/RULES.md §2).
	 */
	providerType: PMType;
}

/**
 * The two metadata board writes, as they ride the transport. Shared by both
 * factories below so the request shapes can't drift apart.
 */
function transportPmWrites(
	options: TransportPmWriteOptions,
): Pick<PMProvider, 'moveWorkItem' | 'addComment'> {
	return {
		moveWorkItem: (id, status) =>
			postDelivery(
				options,
				'/worker/delivery/pm/move',
				{ projectId: options.projectId, itemId: id, status },
				(value) => {
					MoveWorkItemDeliveryResponseSchema.parse(value);
				},
			),
		addComment: (id, text) =>
			postDelivery(
				options,
				'/worker/delivery/pm/comment',
				{ projectId: options.projectId, itemId: id, body: text },
				(value) => AddPmCommentDeliveryResponseSchema.parse(value).commentId,
			),
	};
}

/**
 * Build a transport-backed PM write delegate. The two metadata writes POST to
 * the control plane; every other `PMProvider` method delegates to `localDelegate`
 * (each wrapped in an arrow so the concrete provider's `this` binding is kept).
 */
export function createTransportPmDeliveryProvider(options: TransportPmDeliveryOptions): PMProvider {
	const { localDelegate } = options;
	return {
		type: localDelegate.type,
		supportsAssignees: localDelegate.supportsAssignees,
		supportsDependencies: localDelegate.supportsDependencies,
		// Reads and non-metadata writes stay on the worker's in-process provider.
		getWorkItem: (id) => localDelegate.getWorkItem(id),
		listWorkItems: (filter) => localDelegate.listWorkItems(filter),
		findWorkItemByUrlSuffix: (urlSuffix) => localDelegate.findWorkItemByUrlSuffix(urlSuffix),
		findWorkItemForArtifact: (artifact) => localDelegate.findWorkItemForArtifact(artifact),
		findComment: (id, marker) => localDelegate.findComment(id, marker),
		createWorkItem: (input) => localDelegate.createWorkItem(input),
		updateWorkItem: (id, patch) => localDelegate.updateWorkItem(id, patch),
		addLabel: (id, name) => localDelegate.addLabel(id, name),
		listBlockers: (id) => localDelegate.listBlockers(id),
		addBlockedBy: (id, blockerId) => localDelegate.addBlockedBy(id, blockerId),
		// `discover` (the optional board-mapping capability) is intentionally not
		// exposed: it is a server-side administration concern reached through the
		// PM registry, never called on a pipeline phase's `pm`, so this write-only
		// transport delegate leaves it absent (a valid `PMProvider` — `discover` is
		// optional) rather than routing discovery over the metadata-write transport.
		// The two metadata writes ride the transport under the server-side PM credential.
		...transportPmWrites(options),
	};
}

/**
 * A board read a DB-free worker cannot serve: it holds no PM credential and no
 * in-process provider, and the control plane already performed every read the
 * assignment needed before pushing it. Refusing loudly beats inventing an empty
 * result a phase would then act on.
 *
 * Rejects rather than throwing synchronously, so it fails exactly where a real
 * provider's failed call would — inside the caller's `await`.
 */
async function unavailableRead(operation: string): Promise<never> {
	throw new Error(
		`PM read '${operation}' is not available on a DB-free worker — board reads stay on the control plane (ADR-003 §2)`,
	);
}

/**
 * Hydrate the narrow card frame the three card-returning routes answer with
 * (`FoundWorkItemSchema`) into the `WorkItem` the interface returns. The three
 * omitted fields take the interface's own "nothing here" values rather than being
 * left undefined — `labels`/`assignees` are non-optional arrays, and `description`
 * is the field the server deliberately does not put on the wire. Callers on this
 * path address the card and name it; none reads a body or an assignee off one.
 */
function hydrateWorkItem(item: FoundWorkItem): WorkItem {
	return { ...item, description: '', labels: [], assignees: [] };
}

/**
 * Build the delegate-less variant for a DB-free remote worker: every board
 * **write** rides the transport, so do the four narrow **reads** a DB-free phase
 * needs, and the two remaining reads refuse via {@link unavailableRead}. The
 * phases a DB-free worker runs need exactly that surface — Implementation moves
 * the card, posts its comment and gates on dependencies; Respond-to-review
 * resolves its card and moves it; Planning posts its plan, re-scopes the parent,
 * creates and prepares each split child, chains the dependency edges and labels
 * what it finished — so a call to anything else is a wiring bug, and the thrown
 * message says so.
 *
 * `listBlockers` is transported rather than stubbed because the alternative is
 * unsafe: with `supportsDependencies: false`, Implementation's dependency gate
 * (`../pipeline/dependency-guard.ts`) short-circuits, and a work item whose
 * prerequisites are still open would be built out of order — the failure issue
 * #330 exists to prevent. Nothing else gates it: `findOpenBlockers` is called
 * only inside the phase, never by the dispatcher or the eligibility gate. So the
 * capability is declared **on** and the read runs server-side under the PM
 * credential.
 *
 * `findWorkItemByUrlSuffix` is transported for a milder reason: Respond-to-review's
 * board report is best-effort, so refusing would merely stop the card moving. It
 * is the *narrow* form of the board read — one suffix in, at most one card out —
 * which is why `listWorkItems` keeps refusing rather than being widened to serve
 * it: a worker has no business enumerating a board to answer a one-card question.
 *
 * `findComment` and the four remaining writes joined with Planning (issue #536).
 * The read is load-bearing rather than convenient: it is what makes a *replayed*
 * Planning delivery reuse its own plan comment and skip the split entirely, so
 * refusing it would have a retry create a second set of sibling cards. The writes
 * are the split itself, and each is idempotent or best-effort at the provider —
 * `addLabel` and `addBlockedBy` absorb a repeat by contract, and a failed
 * per-child write is already logged and swallowed by the phase — so the wider
 * surface adds no new failure mode beyond the ones the same-host path already
 * handles.
 *
 * What still refuses is what a worker has no business doing: `getWorkItem` (the
 * control plane already read the assigned item and put it on the assignment) and
 * `listWorkItems` (enumerating a whole board). No phase a DB-free worker runs
 * calls either. Assignees are unreadable here too — only the server-side
 * eligibility gate reads that flag, and it never runs on a worker.
 */
export function createWriteOnlyTransportPmProvider(
	options: WriteOnlyTransportPmDeliveryOptions,
): PMProvider {
	return {
		type: options.providerType,
		supportsAssignees: false,
		supportsDependencies: true,
		getWorkItem: () => unavailableRead('getWorkItem'),
		listWorkItems: () => unavailableRead('listWorkItems'),
		listBlockers: (id) =>
			postDelivery(
				options,
				'/worker/delivery/pm/blockers',
				{ projectId: options.projectId, itemId: id },
				(value) => ListBlockersDeliveryResponseSchema.parse(value).blockers,
			),
		findWorkItemByUrlSuffix: (urlSuffix) =>
			postDelivery(
				options,
				'/worker/delivery/pm/find-item',
				{ projectId: options.projectId, urlSuffix },
				// `null` (no card wraps that URL) maps back to the `undefined` the
				// interface returns, so the phase reads one shape on both paths.
				(value) => {
					const item = FindWorkItemDeliveryResponseSchema.parse(value).item;
					return item ? hydrateWorkItem(item) : undefined;
				},
			),
		findWorkItemForArtifact: (artifact: WorkItemArtifact) =>
			postDelivery(
				options,
				'/worker/delivery/pm/find-artifact',
				{
					projectId: options.projectId,
					repository: artifact.repository,
					kind: artifact.kind,
					number: artifact.number,
				},
				(value) => {
					const item = FindWorkItemDeliveryResponseSchema.parse(value).item;
					return item ? hydrateWorkItem(item) : undefined;
				},
			),
		findComment: (id, marker) =>
			postDelivery(
				options,
				'/worker/delivery/pm/find-comment',
				{ projectId: options.projectId, itemId: id, marker },
				// `null` (no comment carries the marker) maps back to `undefined`, the
				// "not posted yet" answer the caller acts on by posting.
				(value) => FindPmCommentDeliveryResponseSchema.parse(value).commentId ?? undefined,
			),
		createWorkItem: (input) =>
			postDelivery(
				options,
				'/worker/delivery/pm/create-item',
				{
					projectId: options.projectId,
					title: input.title,
					description: input.description,
					status: input.status,
					...(input.labels !== undefined && { labels: input.labels }),
				},
				(value) => hydrateWorkItem(CreateWorkItemDeliveryResponseSchema.parse(value).item),
			),
		updateWorkItem: (id, patch) =>
			postDelivery(
				options,
				'/worker/delivery/pm/update-item',
				// Spread conditionally rather than passing `patch.title` straight through:
				// the wire schema's optional fields mean "leave this field alone", so an
				// omitted patch field must not appear as a key. (`JSON.stringify` would
				// drop an explicit `undefined` anyway; stating it here keeps the frame's
				// shape independent of that.)
				{
					projectId: options.projectId,
					itemId: id,
					...(patch.title !== undefined && { title: patch.title }),
					...(patch.description !== undefined && { description: patch.description }),
				},
				(value) => {
					UpdateWorkItemDeliveryResponseSchema.parse(value);
				},
			),
		addLabel: (id, name) =>
			postDelivery(
				options,
				'/worker/delivery/pm/label',
				{ projectId: options.projectId, itemId: id, name },
				(value) => {
					AddPmLabelDeliveryResponseSchema.parse(value);
				},
			),
		addBlockedBy: (id, blockerId) =>
			postDelivery(
				options,
				'/worker/delivery/pm/blocked-by',
				{ projectId: options.projectId, itemId: id, blockerId },
				(value) => {
					AddBlockedByDeliveryResponseSchema.parse(value);
				},
			),
		...transportPmWrites(options),
	};
}
