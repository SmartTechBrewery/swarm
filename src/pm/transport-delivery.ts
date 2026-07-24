/**
 * Worker-side transport-backed PM **write** delegate (ADR-002 §2, the Phase 2/2
 * counterpart of `../scm/transport-delivery.ts`). A federated worker (one that
 * does not hold the per-project PM credential) uses this provider so the two
 * metadata-only PM board writes — `moveWorkItem`, `addComment` — travel up the
 * transport to the control-plane delivery API (`../router/worker-delivery.ts`),
 * which performs the board write under the PM credential. Only metadata (a
 * canonical status key or a comment body) crosses the wire; the repository tree
 * never does (ai/RULES.md §1).
 *
 * Every remaining `PMProvider` method — the reads (`getWorkItem`,
 * `listWorkItems`, `findComment`, `listBlockers`), the other writes
 * (`createWorkItem`, `updateWorkItem`, `addLabel`, `addBlockedBy`), and
 * `discover` — delegates verbatim to a `localDelegate` (the worker's own
 * in-process provider), so the full interface the pipeline phases expect is
 * preserved unchanged. This task moves only the two metadata *writes*
 * server-side; the reads move server-side later with the broader dispatch-push
 * work (ADR-003 §2), not here.
 *
 * A non-2xx or unparseable response **throws**, so the phase's existing
 * best-effort / board-report handling behaves exactly as it does with the
 * in-process provider today.
 */

import {
	AddPmCommentDeliveryResponseSchema,
	MoveWorkItemDeliveryResponseSchema,
	TRANSPORT_PROTOCOL_VERSION,
} from '../transport/protocol.js';
import type { PMProvider } from './types.js';

/** The `fetch` surface this module uses — injectable so tests drive it without a network. */
export type FetchLike = (
	input: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
	},
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface TransportPmDeliveryOptions {
	/** Base URL of the control-plane delivery API, e.g. `https://swarm.example`. */
	controlPlaneUrl: string;
	/** Raw registered-worker credential (sent as `Authorization: Bearer`). */
	workerCredential: string;
	/** The project id, sent so the server resolves the right PM credential + enrollment. */
	projectId: string;
	/** The worker's in-process provider, handling every read + non-metadata-write op. */
	localDelegate: PMProvider;
	/** Override `fetch` in tests; defaults to the global. */
	fetchImpl?: FetchLike;
}

/** Join the control-plane base URL with a delivery path, tolerating a trailing slash. */
function deliveryUrl(base: string, path: string): string {
	return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * POST a delivery request to the control plane and return the parsed response
 * body. Throws on a non-2xx status or a body that does not match the parser, so
 * the caller behaves as the in-process provider would on a failed write.
 */
async function postDelivery<T>(
	options: TransportPmDeliveryOptions,
	path: string,
	body: Record<string, unknown>,
	parse: (value: unknown) => T,
): Promise<T> {
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
	const response = await fetchImpl(deliveryUrl(options.controlPlaneUrl, path), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${options.workerCredential}`,
		},
		body: JSON.stringify({ ...body, protocolVersion: TRANSPORT_PROTOCOL_VERSION }),
	});
	if (!response.ok)
		throw new Error(`Control-plane PM delivery ${path} failed with status ${response.status}`);
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(
			`Control-plane PM delivery ${path} returned an unparseable response: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return parse(payload);
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
