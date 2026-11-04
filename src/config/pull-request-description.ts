/**
 * The pull request description structure the Implementation phase asks its agent to
 * fill in (issue #1277): SWARM's English default, its length bound and its
 * normalizer. A dependency-free leaf for the same reason as `./custom-prompt.ts` —
 * the config schema (server) and the web dashboard both import it, and the
 * dashboard bundle must not reach it through `./schema.ts`.
 *
 * The structure is the *editable* part of the description only. The line naming the
 * work item (`Closes: #<n>` or `Work item: [<key>](<url>)`) is always appended by
 * SWARM itself (`src/pipeline/pull-request-description.ts`), outside it.
 */

/**
 * SWARM's default pull request description structure, verbatim from issue #1277.
 * Every section is mandatory; an empty one says "None" rather than being dropped.
 */
export const DEFAULT_PULL_REQUEST_DESCRIPTION = [
	"<1–2 sentences: what this pull request delivers, in the reader's terms, not a changelog>",
	'',
	'## Changes',
	'| File / area | What it is |',
	'| --- | --- |',
	'',
	'## Why this way',
	'<decisions not visible in the diff, rejected alternatives, deliberate deviations from the work item — or "None">',
	'',
	'## Verification',
	'**Checked:** <command → outcome, one per line>',
	'**Not checked:** <what and why — or "Nothing left unchecked">',
	'',
	'## Out of scope',
	'<what was deliberately left out although it suggested itself — or "None">',
].join('\n');

/**
 * Upper bound on a project's pull request description structure
 * (`agents.implementation.pullRequestDescription`), in characters — the same bound
 * as a custom prompt, since both are text appended to the phase's CLI prompt.
 * Checked against the normalized value.
 */
export const PULL_REQUEST_DESCRIPTION_MAX_LENGTH = 10_000;

function canonical(value: string): string {
	return value.replace(/\r\n?/g, '\n').trim();
}

/**
 * Normalize a stored pull request description structure: trim it, and treat a blank
 * value **or one equal to the default** as unset. Saving the untouched default
 * therefore stores nothing, so a project that never edited the field keeps
 * following SWARM's default — including a later revision of it.
 */
export function normalizePullRequestDescription(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = canonical(value);
	if (normalized.length === 0) return undefined;
	return normalized === DEFAULT_PULL_REQUEST_DESCRIPTION ? undefined : normalized;
}

/** The structure a project's descriptions follow: its own, or SWARM's default. */
export function resolvePullRequestDescription(value: string | undefined): string {
	return normalizePullRequestDescription(value) ?? DEFAULT_PULL_REQUEST_DESCRIPTION;
}
