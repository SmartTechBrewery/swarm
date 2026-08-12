/**
 * The Security tab's submit rules (issue #662), as pure functions so they are
 * tested in the node environment and the panel itself stays presentational —
 * the habit `lib/pipeline-enabled.ts` and `lib/credentials.ts` establish.
 *
 * **No rule here is a substitute for the server's.** The API validates the same
 * things again on every mutation (`src/api/routers/auth.ts`), and the
 * current-password check is only ever made server-side against the stored hash.
 * These exist so an obviously-unsubmittable form says so without a round trip.
 *
 * **Nothing here echoes a password.** The messages describe the problem and
 * never include a submitted value.
 */

/** Mirrors `UserDisplayNameSchema` (`src/identity/schema.ts`) — the input's `maxLength`. */
export const DISPLAY_NAME_MAX_LENGTH = 80;

/**
 * Whether a display-name draft is worth submitting: non-empty once trimmed,
 * within the server's bound, and an actual change to the current name.
 */
export function canSaveDisplayName(draft: string, current: string): boolean {
	const trimmed = draft.trim();
	return trimmed.length > 0 && trimmed.length <= DISPLAY_NAME_MAX_LENGTH && trimmed !== current;
}

/** The three values a password change is composed of, as the form holds them. */
export interface PasswordFormFields {
	current: string;
	next: string;
	confirm: string;
}

/**
 * The reason a password form cannot be submitted, or `null` when it can. The
 * confirmation field is a client-side idea — the API takes only the current and
 * the new password — so this is where a typo in it is caught.
 */
export function describePasswordFormError(fields: PasswordFormFields): string | null {
	if (fields.current.length === 0) return 'Enter your current password.';
	if (fields.next.length === 0) return 'Enter a new password.';
	if (fields.next !== fields.confirm) return 'The new passwords do not match.';
	if (fields.next === fields.current) return 'The new password must differ from your current one.';
	return null;
}
