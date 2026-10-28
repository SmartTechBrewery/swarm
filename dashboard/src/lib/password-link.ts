/**
 * The `/set-password?token=…` link an installation admin hands a user (issue #1151).
 * The `users` router returns only the raw token — the server does not reliably know
 * the dashboard's public origin — so the dashboard builds the link from its own,
 * `window.location.origin` at the call site. Pure so it can be tested without one.
 */
export function passwordLinkUrl(origin: string, token: string): string {
	return `${origin}/set-password?token=${encodeURIComponent(token)}`;
}
