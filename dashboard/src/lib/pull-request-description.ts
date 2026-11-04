/**
 * Pure helpers for the Implementation phase's **Pull request description** field
 * (issue #1277): validation and dirty-checking over the same normalizer the config
 * schema persists through, kept out of the route component so they can be
 * unit-tested — the twin of `./phase-prompt.ts`.
 */

import {
	DEFAULT_PULL_REQUEST_DESCRIPTION,
	normalizePullRequestDescription,
	PULL_REQUEST_DESCRIPTION_MAX_LENGTH,
} from '../../../src/config/pull-request-description.js';

export {
	DEFAULT_PULL_REQUEST_DESCRIPTION,
	normalizePullRequestDescription,
	PULL_REQUEST_DESCRIPTION_MAX_LENGTH,
};

/** The text the field shows: the stored structure, or SWARM's default while unset. */
export function pullRequestDescriptionDisplay(value: string | undefined): string {
	return value ?? DEFAULT_PULL_REQUEST_DESCRIPTION;
}

/**
 * A validation message for a raw field value, or `undefined` when it is acceptable.
 * Only the persisted (normalized) length is bounded, matching the schema.
 */
export function pullRequestDescriptionError(value: string | undefined): string | undefined {
	const normalized = normalizePullRequestDescription(value);
	if (normalized && normalized.length > PULL_REQUEST_DESCRIPTION_MAX_LENGTH) {
		return `Pull request description must be at most ${PULL_REQUEST_DESCRIPTION_MAX_LENGTH.toLocaleString()} characters (currently ${normalized.length.toLocaleString()}).`;
	}
	return undefined;
}

/**
 * Whether the edited structure differs from the stored one, comparing normalized
 * forms — so the untouched default and "unset" never read as dirty.
 */
export function isPullRequestDescriptionDirty(
	local: string | undefined,
	stored: string | undefined,
): boolean {
	return (
		(normalizePullRequestDescription(local) ?? '') !==
		(normalizePullRequestDescription(stored) ?? '')
	);
}

/**
 * Whether the field already shows SWARM's default, so Restore default has nothing to
 * do. A cleared field normalizes to "unset" too, but the box is then empty rather
 * than showing the default, so it is not one: Restore default must stay available.
 */
export function isDefaultPullRequestDescription(value: string | undefined): boolean {
	return normalizePullRequestDescription(value) === undefined && value?.trim() !== '';
}
