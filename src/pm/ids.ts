/**
 * Branded ID types for the PM layer.
 *
 * Mirrors Cascade's `src/pm/ids.ts` (see ai/CODING_STANDARDS.md "Naming").
 * GitHub Projects v2 throws four distinct opaque IDs at us — a project node
 * ID, a field ID, a single-select option ID, and an item ID — all of them
 * bare strings that look interchangeable but aren't. Passing a status option
 * ID where a field ID is expected is exactly the class of confusion Cascade's
 * Linear integration shipped three production bugs from in one week. Branded
 * types make each of those a compile error.
 *
 * Usage:
 *
 *   // At the boundary (config load, webhook payload, DB row), parse once:
 *   const fieldId = parseFieldId(boardMapping.statusFieldId);
 *
 *   // Internally, everything accepts only the branded ID:
 *   setStatus(itemId, fieldId, optionId);   // compiles
 *   setStatus(itemId, 'Status', optionId);  // compile error
 *
 *   // At the outbound boundary (GraphQL variables, log line), unwrap:
 *   variables.fieldId = unwrap(fieldId);
 */

/**
 * A GitHub Projects v2 project node ID (e.g. `PVT_kwHOAC3TF84BcNwD`) — the
 * board itself, the top-level container all items and fields hang off.
 */
export type ProjectV2Id = string & { readonly __brand: 'ProjectV2Id' };

/**
 * A GitHub Projects v2 field ID (e.g. the single-select "Status" field,
 * `PVTSSF_lAHOAC3TF84BcNwDzhW4MKo`).
 */
export type FieldId = string & { readonly __brand: 'FieldId' };

/**
 * A GitHub Projects v2 single-select option ID — one value of a single-select
 * field, e.g. the `In progress` option (`47fc9ee4`) of the Status field.
 */
export type SingleSelectOptionId = string & { readonly __brand: 'SingleSelectOptionId' };

/**
 * A GitHub Projects v2 item ID (e.g. `PVTI_lAHOAC3TF84BcNwDzgxczdA`) — a single
 * card on the board, usually backed by an Issue or PR.
 */
export type WorkItemId = string & { readonly __brand: 'WorkItemId' };

/** Thrown by the `parse*` factories when the input is empty or whitespace. */
export class InvalidIdError extends Error {
	readonly kind: string;
	readonly attempted: string;

	constructor(kind: string, attempted: string) {
		super(`Invalid ${kind}: '${attempted}' — expected a non-empty, non-whitespace string`);
		this.name = 'InvalidIdError';
		this.kind = kind;
		this.attempted = attempted;
	}
}

function requireNonEmpty(raw: string, kind: string): string {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		throw new InvalidIdError(kind, raw);
	}
	return raw;
}

/** Parse and brand a project node ID. Throws `InvalidIdError` on empty/whitespace input. */
export function parseProjectV2Id(raw: string): ProjectV2Id {
	return requireNonEmpty(raw, 'ProjectV2Id') as ProjectV2Id;
}

/** Parse and brand a field ID. Throws `InvalidIdError` on empty/whitespace input. */
export function parseFieldId(raw: string): FieldId {
	return requireNonEmpty(raw, 'FieldId') as FieldId;
}

/** Parse and brand a single-select option ID. Throws `InvalidIdError` on empty/whitespace input. */
export function parseSingleSelectOptionId(raw: string): SingleSelectOptionId {
	return requireNonEmpty(raw, 'SingleSelectOptionId') as SingleSelectOptionId;
}

/** Parse and brand a work-item ID. Throws `InvalidIdError` on empty/whitespace input. */
export function parseWorkItemId(raw: string): WorkItemId {
	return requireNonEmpty(raw, 'WorkItemId') as WorkItemId;
}

/**
 * Strip the brand for boundary crossings (GraphQL variables, log lines).
 * Accepts any branded string type (or a plain string) and returns a plain string.
 *
 * This helper exists so the call site reads as a deliberate "I am leaving the
 * typed world" rather than an opaque cast.
 */
export function unwrap<T extends string>(id: T): string {
	return id;
}
