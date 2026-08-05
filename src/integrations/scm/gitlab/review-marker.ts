/**
 * Marker carried only by GitLab request-changes findings notes.
 *
 * GitLab's REST API cannot set a reviewer's `requested_changes` state, so the
 * note is the observable verdict. Ingress recognizes this provider-local marker
 * and maps the note back onto the neutral review event that wakes Respond-to-review.
 */

import { swarmMarker } from '../../../scm/swarm-origin.js';

const REQUEST_CHANGES_MARKER_KIND = 'gitlab-request-changes';
const REQUEST_CHANGES_MARKER_PREFIX = `<!-- swarm-${REQUEST_CHANGES_MARKER_KIND}:`;

export function gitLabRequestChangesMarker(deliveryId: string): string {
	return swarmMarker(REQUEST_CHANGES_MARKER_KIND, deliveryId);
}

export function isGitLabRequestChangesMarker(body: string | undefined): boolean {
	return body?.includes(REQUEST_CHANGES_MARKER_PREFIX) ?? false;
}
